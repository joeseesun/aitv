// 定时流水线（Worker cron）：每条一个状态机，每一步的结果都存进 KV，挂了下一轮从断点接着跑。
//   fetch/去重 → read（读原文）→ brief（deepseek-flash）→ script（deepseek-flash）→ validate → tts（豆包 → R2）→ ready
// KV：
//   "pipe:item:<id>" → { id, item, step, status, results: { read, brief, script, validate, tts }, tries, errors, ... }
//   "pipe:index"     → { pending: [id], ready: [id], dropped: [{id, step, why, at}], seen: [id], daily: { date, started }, last }
//   "pipe:lock"      → { until }  同一时刻只跑一个
//   "ttscap:<日期>"  → 每日合成额度（src/ttscap.js）：一天 40 次，同一条一天最多 2 次（= 一次重试）
// 上线（插进时间线）默认关闭：AUTO_PUBLISH 不是 "1" 时只记一份「如果上线会怎么插」的计划。
// 下架按稿子 hash：同一个 id 写出不一样的稿子照常能过；只有稿子 hash 在名单里才丢。
import { fetchAll, dedupe, interleave } from "./sources.js";
import { fetchMaterial, enrich } from "./enrich.js";
import { writeScript, toSeedItem, needsTitleZh, translateTitle, PART_KEYS, checkScript, scriptFields, opening } from "./writer.js";
import { renderScript } from "./validate.js";
import { checkSafety } from "./safety.js";
import { scriptHash, SPEAKERS, AUDIO_CONFIG } from "./scripthash.js";
import { takedownMatches, checkSeed, MIN_PLAYABLE } from "./release.js";
import { reserveTTS } from "./ttscap.js";
import { storeScreenedImage } from "./imagepick.js";
import { mp3Duration } from "./mp3.js";
import { planTimeline, effective, locate } from "./timeline.js";
import { timeOf, newestFirst, ageOf as ageBy, parseRanked, SOURCE_KEY, phListEnd, windowOf, isFresh, FRESH_WINDOW_MS } from "./freshness.js";

export const STEPS = ["read", "brief", "script", "validate", "tts"];
export const MAX_STEP_TRIES = 3; // 网络 / 模型这类临时错误：同一步最多跑 3 次（跨轮）
const SEEN_MAX = 2000;
const day = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");

class Drop extends Error {}   // 内容不合格：直接丢，不重试
class Wait extends Error {}   // 今天额度用完 / 这条今天试够了：明天再来
class Stale extends Error {   // 过了新鲜期：跳过（skipped:stale），不做摘要、不合成
  constructor(msg, patch) { super(msg); this.patch = patch; } // patch：读原文那步补出来的日期，记到条目上（日志里看得到）
}

// 新鲜度（乔布斯 2026-10-09）：按「来源给的真实发布时间」publishedAt 算，不按抓取时间。
// HN = 帖子发到 HN 的时间；PH 日榜 = featuredAt（上 PH 首页的时间）；AIHOT = 原文 / 官方 RSS / 官方 X 帖的时间。
// PH / GitHub 是榜单：按上榜时间（rankedAt，见 freshness.js，RANKED_SOURCES 开关），24 小时有效。
export const STALE_MS = FRESH_WINDOW_MS;
export const pubAge = (it, now, ranked) => { const { t } = timeOf(it || {}, ranked); return t == null ? null : now - t; };
// 时间已知且过了有效期（所有来源 72 小时，FRESH_WINDOW_MS）。时间未知的不在这里判（候选那步单独记 no-pubdate）
export const isStale = (it, now, ranked) => { const a = pubAge(it, now, ranked); return a != null && a > windowOf(it || {}, ranked).fresh; };
const staleWhy = (it, now, ranked) => { const { t, kind } = timeOf(it, ranked); return `stale：${kind === "ranked" ? "上榜" : "发布"}于 ${new Date(t).toISOString()}，已经 ${((now - t) / 3600e3).toFixed(1)} 小时（超过 ${windowOf(it, ranked).fresh / 3600e3} 小时）`; };

// 每轮新条目：最多 2 条；在播的有效条目（非 stale、在新鲜期内）够 12 条就退回每轮 1 条。每天 40 条的上限另算（PIPELINE_MAX_NEW_PER_DAY）
export const MAX_NEW_PER_RUN = 2, SLOW_NEW_PER_RUN = 1, STEP_BACK_AT = 12;
export const newPerRun = (freshOnAir) => (freshOnAir >= STEP_BACK_AT ? SLOW_NEW_PER_RUN : MAX_NEW_PER_RUN);
// 墙钟（Cloudflare：cron 每次最多 15 分钟）。一轮的截止 = 开始 + 14 分钟；每一步开跑前确认「最坏情况也能在截止前跑完」，
// 不够就留到下一轮（状态在 KV 里，断点续跑）。每一步的最坏耗时按代码里的超时算：
//   read：原文 12s + 首页配图 8s + 官方 RSS 12s → 60s
//   brief：DeepSeek 120s 超时 × 2 次（不合格重写一次）→ 250s
//   script：DeepSeek 300s 超时 × 2 次 + 中文标题 120s → 730s
//   tts：豆包 240s 超时 + R2 → 260s
// 抓榜（PR #7 重试）：每个源最坏 3 × 15s + 2s + 5s = 52s（各源并行），加 AIHOT 链接修正 15s → 约 70s，在开第一步之前。
export const CRON_BUDGET_MS = 14 * 60_000;
export const STEP_MAX_MS = { read: 60_000, brief: 250_000, script: 730_000, validate: 10_000, tts: 260_000 };

// ---------- 每一步 ----------
const step = {
  async read(st, d) {
    const m = await fetchMaterial(st.item, { fetchImpl: d.fetch });
    if (!m) throw new Error("原文读不到");
    // 发布时间读不到（AIHOT 原文没日期、或原文是旧链接退回了 links.aihot）：不播，不拿抓取时间顶替
    if (m.patch?.dateUnknown || (st.item.dateUnknown && m.patch?.publishedAt == null)) throw new Drop("发布时间读不到，不播");
    const it = { ...st.item, ...(m.patch || {}) };
    if (isStale(it, d.now, d.ranked)) throw new Stale(staleWhy(it, d.now, d.ranked), m.patch); // AIHOT：读到原文日期后马上判，摘要之前
    return m; // { url, text, image }（原文只存在流水线自己的 KV 里，不进 seed / 节目单）
  },
  async brief(st, d) {
    const e = await enrich(st.item, { llm: (p) => d.briefLLM(p, { temperature: 0.3 }), retries: 1, material: st.results.read });
    if (e.brief) return { kind: e.kind, brief: e.brief, fields: e.fields, image: e.image ?? null, imageHint: e.imageHint ?? null };
    if (e.unsafe || !/模型出错/.test(e.briefError || "")) throw new Drop(e.briefError || "brief 不合格");
    throw new Error(e.briefError);
  },
  async script(st, d) {
    const it = { ...st.item, ...st.results.brief };
    const s = await writeScript(it, { llm: d.scriptLLM, prevTake: d.prevTake || "" });
    if (s.error) { if (/模型出错/.test(s.error)) throw new Error(s.error); throw new Drop(s.error); }
    const fields = { ...it.fields };
    if (needsTitleZh(it)) { const zh = await translateTitle(it, { llm: (p) => d.briefLLM(p, { temperature: 0.2 }) }); if (zh) fields.title_zh = zh; }
    return { kind: s.kind, parts: s.parts, lines: s.lines, fields };
  },
  async validate(st, d) {
    const b = st.results.brief, s = st.results.script;
    const it = { ...st.item, ...b, fields: s.fields };
    const chk = checkScript(s.parts, scriptFields(it), { kind: b.kind, source: it.source });
    if (!chk.ok) throw new Drop(`复核不过：${chk.errors.join("；")}`);
    const safe = checkSafety(it, b.brief);
    if (!safe.ok) throw new Drop(`内容安全：${safe.reasons.join("；")}`);
    const hash = await scriptHash(s.lines);
    if (takedownMatches(d.takedown, { audio: `/audio/${hash}.mp3` })) throw new Drop(`稿子 ${hash} 在下架名单里`);
    return { hash, ok: true };
  },
  async tts(st, d) {
    const { hash } = st.results.validate, lines = st.results.script.lines;
    const mp3Key = `${hash}.mp3`, metaKey = `${hash}.json`;
    let bytes, rounds, cached = false;
    const [hm, hj] = await Promise.all([d.r2.head(mp3Key), d.r2.head(metaKey)]);
    if (hm && hj) { // 内容寻址：同一份稿子已经合成过，不再调豆包、不占额度
      bytes = new Uint8Array(await (await d.r2.get(mp3Key)).arrayBuffer());
      rounds = await (await d.r2.get(metaKey)).json();
      cached = true;
    } else {
      const r = await reserveTTS(d.kv, st.id, { now: d.now, cap: d.ttsCap });
      if (!r.ok) throw new Wait(r.reason);
      const payload = { action: 3, use_head_music: false, audio_config: AUDIO_CONFIG,
        nlp_texts: lines.map((text, j) => ({ speaker: SPEAKERS[j % 2], text })) };
      const out = await d.tts(payload); // 失败抛错：这一次也算额度（防故障时无限烧钱）
      bytes = out.audio; rounds = out.rounds.map((x) => ({ text: x.text, start_time: x.start_time, end_time: x.end_time }));
      if (!(mp3Duration(bytes) > 0)) throw new Error("合成结果没有音频");
      await d.r2.put(mp3Key, bytes, { httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" } });
      await d.r2.put(metaKey, JSON.stringify(rounds), { httpMetadata: { contentType: "application/json" } });
    }
    const dur = mp3Duration(bytes);
    if (!(dur > 0)) throw new Error("音频时长为 0");
    // 配图：补料时已按地址筛过，这里经 storeImage 下载并按真实字节再筛一次（尺寸、画面太素），不合格就没图
    const img = st.results.brief.image
      ? await storeScreenedImage(d.r2img || d.r2, st.results.brief.image, itemOf(st).url, { fetch: d.fetch, hint: st.results.brief.imageHint || {} })
      : { image: null, reason: "" };
    return { audio: `/audio/${mp3Key}`, duration: Math.round((dur + 0.6) * 1000) / 1000, rounds: tagParts(rounds, lines), image: img.image, imageNote: img.reason, cached, bytes: bytes.length };
  },
};

// 每句 round 标上属于哪段（what / who / take），跟 scripts/tts_seed.py 的 tag_parts 一样
export function tagParts(rounds, lines) {
  if (rounds.length === lines.length) return rounds.map((r, i) => ({ ...r, part: PART_KEYS[i] }));
  const bounds = []; let acc = 0;
  for (const l of lines) { acc += l.length; bounds.push(acc); }
  let pos = 0;
  return rounds.map((r) => {
    const mid = pos + r.text.length / 2;
    let i = bounds.findIndex((b) => mid <= b); if (i < 0) i = bounds.length - 1;
    pos += r.text.length;
    return { ...r, part: PART_KEYS[Math.min(i, 2)] };
  });
}

// 全部步骤跑完 → 节目单条目（字段白名单）；再用发布时同一套 checkSeed 单条校验
// 读原文那步可能改了 item（AIHOT：原文发布时间、旧链接退回 links.aihot）
const itemOf = (st) => ({ ...st.item, ...(st.results?.read?.patch || {}) });
export function seedItemOf(st) {
  const b = st.results.brief, s = st.results.script, t = st.results.tts;
  const it = toSeedItem({ ...itemOf(st), kind: s.kind, brief: b.brief, fields: s.fields, image: t.image, take: s.lines[2],
    script: s.parts.map((tpl, i) => ({ part: PART_KEYS[i], tpl, text: s.lines[i] })), lines: s.lines });
  delete it.lines; // 跟 scripts/tts_seed.py 出的 seed 一样，不带 lines
  return { ...it, audio: t.audio, duration: t.duration, spoken: s.lines.join(""), rounds: t.rounds };
}
export function validateItem(it, bytes = 2000) {
  return checkSeed({ version: "x", items: [it] }, "x", { audioBytes: () => bytes, minPlayable: 0 });
}

// 推进一条：从 st.step 往后跑，每步存一次。返回新的 st（status: pending | ready | dropped | waiting）
export async function advance(st, d, { save, deadline = Infinity } = {}) {
  st = { ...st, results: { ...st.results }, tries: { ...st.tries }, errors: [...(st.errors || [])] };
  while (st.status === "pending" || st.status === "waiting") {
    const name = st.step;
    if (name === "done") break;
    if (Date.now() + (STEP_MAX_MS[name] ?? 60_000) > deadline) break; // 这一步跑不完了：下一轮接着跑
    // 每一步（摘要 / 稿子 / 合成）之前都先看发布时间：在途时变旧了（比如等额度等到第二天）也不再花钱
    const cur = itemOf(st);
    if (name !== "read" && isStale(cur, d.now, d.ranked)) { st.status = "skipped"; st.why = staleWhy(cur, d.now, d.ranked); st.updatedAt = d.now; if (save) await save(st); break; }
    st.tries[name] = (st.tries[name] || 0) + 1;
    let later = false;
    try {
      st.results[name] = await step[name](st, d);
      st.step = STEPS[STEPS.indexOf(name) + 1] || "done";
      st.status = "pending"; delete st.why;
      if (st.step === "done") {
        const item = seedItemOf(st);
        const v = validateItem(item, st.results.tts.bytes);
        if (!v.ok) { st.status = "dropped"; st.why = `单条校验不过：${v.errors.join("；")}`; }
        else { st.status = "ready"; st.seedItem = item; }
      }
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      st.errors.push({ step: name, at: d.now, msg });
      if (e instanceof Stale) { st.status = "skipped"; st.why = msg; if (e.patch) st.item = { ...st.item, ...e.patch }; }
      else if (e instanceof Drop) { st.status = "dropped"; st.why = msg; }
      else if (e instanceof Wait) { st.status = "waiting"; st.why = msg; st.tries[name]--; }
      // 合成失败：每日额度管重试（同一条一天最多两次）；累计失败 4 次（两天）就丢
      else if (name === "tts") { const n = st.errors.filter((x) => x.step === "tts" && !/额度|试过/.test(x.msg)).length; st.status = n >= 4 ? "dropped" : "waiting"; st.why = `合成失败：${msg}`; }
      else if (st.tries[name] >= MAX_STEP_TRIES) { st.status = "dropped"; st.why = `${name} 连续 ${st.tries[name]} 次出错：${msg}`; }
      else { st.why = msg; later = true; } // 临时错误：等下一轮再跑这一步
    }
    st.updatedAt = d.now;
    if (save) await save(st);
    if (st.status !== "pending" || later) break;
  }
  return st;
}

// ---------- 上线（插进时间线），AUTO_PUBLISH 才真写 ----------
// 规则（乔布斯 2026-10-09 签）：
// - 每轮最多上一条新的；点评开头跟前后撞了就改写点评第一句（一条一天一次，改了要重新校验、重新合成、占额度）。
// - 超过 72 小时的下线（乔木 2026-10-09 14:48 改：所有来源一个 72 小时窗口，没有补位和 15 条门槛）。
//   15 条的门槛和兜底永远不挡新条目上线。全都不合格时保留最新的那一批在播条目，不出空节目单。
// - use / rollback 之后（时间线里少了我们上过的条目），下一轮把 72 小时内、没下架的已完成条目全部插回来，
//   音频按 hash 已在 R2，不再合成。全部经 switchAt。
export const FRESH_MS = FRESH_WINDOW_MS;
// 年龄按 publishedAt（来源的真实发布时间，产品 2026-10-09 定）；没有真实发布时间 = 未知 → 当作超龄下线，不拿抓取时间顶替。
let RANKED; // dropOld / planPublish 这一轮用的榜单开关（runCron 设；默认两类都开）
const ageOf = (it, now) => ageBy(it, now, RANKED);
const keyOf = (x) => `${x.id}|${x.audio}`;
export const STALE_KEEP = 5;
// others：这一轮同时要插进来的条目数（新条目 / 插回）。有它们就不需要「保留旧的」兜底。
export function dropOld(items, now, { others = 0, ranked = parseRanked() } = {}) {
  RANKED = ranked;
  // 72 小时内的全留（不再有 15 条门槛和补位）
  let out = items.filter((x) => isFresh(x, now, RANKED)).map(({ stale, ...x }) => x);
  let keptStale = false;
  if (!out.length && !others && items.length) {
    // 边界：72 小时内一条都没有 → 留时间最新的 5 条，标 stale: true（屏幕显示「N 小时前」）；
    // 一条带时间的都没有 → 保留原来前 5 条（不出空节目单），同样标 stale
    const dated = items.filter((x) => ageOf(x, now) !== Infinity).sort((x, y) => ageOf(x, now) - ageOf(y, now));
    const pick = new Set((dated.length ? dated : items).slice(0, STALE_KEEP).map(keyOf));
    out = items.filter((x) => pick.has(keyOf(x))).map((x) => ({ ...x, stale: true }));
    keptStale = true;
  }
  return Object.assign(out, { keptStale });
}

// 点评第一句改写：只改 part3 模板的第一句，开头避开给定的几个开头
export const firstSentence = (s) => { const m = String(s).match(/^[^。！？；]*[。！？；]?/); return m ? m[0] : String(s); };
export async function rewriteTakeOpening(st, d, avoid) {
  const s = st.results.script, b = st.results.brief;
  const tpl = s.parts[2], first = firstSentence(tpl), rest = tpl.slice(first.length);
  const prompt = `下面是一段中文口播点评的第一句（模板，{{…}} 是占位符，原样保留）。把它改写成意思不变、同样口吻的一句，只改说法和开头。
要求：开头的头几个字不能是这些：${avoid.map((x) => `「${x}」`).join("、")}；不要以「如果你」开头；不要出现「今天」；不要新增任何数字（阿拉伯数字或中文数字都不行）；不要加新的事实。
原句：${first}
后文（不用改，只供参考）：${rest}
只输出 JSON：{"first":"…"}`;
  let out;
  try { out = JSON.parse((await d.scriptLLM(prompt, { temperature: 0.8 })).match(/\{[\s\S]*\}/)?.[0] || "null"); } catch { out = null; }
  const nf = typeof out?.first === "string" ? out.first.trim() : "";
  if (!nf) return { ok: false, reason: "改写没给结果" };
  const parts = [s.parts[0], s.parts[1], nf + rest];
  const it = { ...st.item, ...b, fields: s.fields };
  const fields = scriptFields(it);
  const chk = checkScript(parts, fields, { kind: b.kind, source: it.source });
  if (!chk.ok) return { ok: false, reason: `改写后不过：${chk.errors.join("；")}` };
  const lines = parts.map((p) => renderScript(p, s.fields));
  if (avoid.includes(opening(lines[2]))) return { ok: false, reason: "改写后开头还是撞" };
  return { ok: true, script: { ...s, parts, lines } };
}

// 这一轮的上线计划。返回 { ok, timeline, inserted: [id], reinserted: [id], dropped, keptStale } 或 { ok: false, reason }
export function planPublish(tl, now, { newItem = null, newItems = null, reinsert = [], takedown, ranked = parseRanked() } = {}) {
  RANKED = ranked;
  const eff = effective(tl, now);
  if (!eff) return { ok: false, reason: "KV 里没有时间线" };
  const target = eff.next || eff.current;
  // 上线这一刻再把关一次：过了新鲜期 / 没有真实时间的不插
  const news = (newItems || [newItem]).filter(Boolean).filter((x) => !isStale(x, now, RANKED) && timeOf(x, RANKED).t != null && !takedownMatches(takedown, x));
  // 插进来的这一批按时间从新到旧排（乔木 2026-10-09），整批排在切换那一刻正在播的那条后面
  const tKey = (x) => timeOf(x, RANKED).t ?? -Infinity;
  const insert = [...news, ...reinsert].filter(Boolean).filter((x) => !takedownMatches(takedown, x) && !isStale(x, now, RANKED))
    .sort((x, y) => tKey(y) - tKey(x));
  const insIds = new Set(insert.map((x) => x.id));
  const base = target.items.filter((x) => !insIds.has(x.id));
  const kept = dropOld(base, now, { others: insert.length, ranked });
  const same = kept.length === base.length && kept.every((x, i) => !!x.stale === !!base[i].stale);
  if (!insert.length && same) return { ok: false, reason: "没有要变的", noop: true };
  // 新条目 + 留下的，多少条都照排
  const p = planTimeline(tl, now, { version: target.version, items: kept, insert });
  if (!p.ok) return p;
  const n = p.timeline.next || p.timeline.current, at = p.timeline.switchAt ?? now;
  const before = eff.current.items[locate(eff.current, at - 1).i];
  // 新条目排在下一版最前面（第 i 条）；前一条是切换那一刻正在播的（或前一条新条目），后一条是 n.items[i + 1]
  let clash = null;
  news.forEach((it) => {
    if (clash) return;
    const i = n.items.findIndex((x) => x.id === it.id);
    if (i < 0) return;
    const prev = i === 0 ? before : n.items[i - 1], next = n.items[i + 1];
    for (const nb of [prev, next]) if (!clash && nb?.take && nb.id !== it.id && opening(nb.take) === opening(it.take)) clash = { id: it.id, with: nb.id, avoid: [prev?.take, next?.take].filter(Boolean).map(opening) };
  });
  return { ...p, clash, inserted: news.map((x) => x.id), reinserted: reinsert.map((x) => x.id), dropped: base.length - kept.length, keptStale: kept.keptStale, count: n.items.length };
}
// 兼容旧名字（测试 / 脚本用）
export const planInsert = (tl, now, item, o = {}) => {
  const v = validateItem(item);
  if (!v.ok) return { ok: false, reason: `条目没通过校验：${v.errors.join("；")}` };
  const p = planPublish(tl, now, { newItem: item, takedown: o.takedown });
  return p.ok && p.clash ? { ok: false, reason: `点评开头跟相邻的 ${p.clash.with} 撞了` } : p;
};

// ---------- 一轮 cron ----------
// d：依赖（Worker 里由 makeDeps(env) 组装；测试里全是假的）
export async function runCron(d, { maxNewPerDay = 1, autoPublish = false, budgetMs = CRON_BUDGET_MS } = {}) {
  const now = d.now, kv = d.kv, deadline = Date.now() + budgetMs;
  const lock = await kv.get("pipe:lock");
  if (lock?.until > now) return { skipped: "上一轮还在跑" };
  await kv.put("pipe:lock", { until: now + budgetMs + 60_000 }, { expirationTtl: Math.ceil(budgetMs / 1000) + 120 });
  const log = [];
  try {
    const idx = { pending: [], ready: [], dropped: [], seen: [], ...(await kv.get("pipe:index")) };
    if (idx.daily?.date !== day(now)) idx.daily = { date: day(now), started: 0 };
    const tl = await kv.get("timeline");
    const eff = effective(tl, now);
    d.takedown = await kv.get("takedown");
    d.ranked = d.ranked || parseRanked();
    RANKED = d.ranked;
    d.prevTake = eff ? eff.current.items[locate(eff.current, now).i]?.take : "";
    // 这一轮最多上几条新的：在播有效条目够 STEP_BACK_AT 条就退回 1 条
    const target0 = eff ? eff.next || eff.current : null;
    const freshOnAir = (target0?.items || []).filter((x) => !x.stale && !takedownMatches(d.takedown, x) && isFresh(x, now, d.ranked)).length;
    const perRun = newPerRun(freshOnAir);
    log.push(`在播有效 ${freshOnAir} 条，这一轮最多新上 ${perRun} 条`);

    // 1. 抓 + 去重：在途的不到 perRun 条、今天还有名额才开新条
    const slots = Math.min(perRun - idx.pending.length, maxNewPerDay - idx.daily.started);
    if (slots > 0) {
      const r = await (d.fetchAll || fetchAll)({ fetchImpl: d.fetch, now });
      // 榜单类的上榜时间：GitHub = 第一次在 trending 上看到（KV 记着）；PH = 那份日榜结束的时间
      const firstSeen = (await kv.get("rank:firstSeen")) || {};
      for (const it of r.items) {
        const s = SOURCE_KEY[it.source];
        if (s === "github") { const e = firstSeen[it.id] || { first: now }; e.last = now; firstSeen[it.id] = e; it.rankedAt = e.first; }
        if (s === "producthunt") it.rankedAt = phListEnd(it.fetchedAt ?? now);
      }
      for (const [k, e] of Object.entries(firstSeen)) if (now - e.last > FRESH_WINDOW_MS + 86400_000) delete firstSeen[k]; // 超过有效期再多一天没再出现就忘掉
      await kv.put("rank:firstSeen", firstSeen);
      const onAir = new Set([...(eff?.current.items || []), ...(eff?.next?.items || [])].map((x) => x.id));
      const cands = interleave(dedupe(r.items, new Set([...idx.seen, ...onAir])));
      // 先按发布时间筛：超过 72 小时的直接跳过（skipped:stale），不读原文、不做摘要、不合成
      // 没有真实发布时间的（GitHub Trending）也跳过：上了也会在下一轮被下线（AIHOT 例外：读原文那步才拿日期）
      const noDate = (c) => timeOf(c, d.ranked).t == null && !c.dateUnknown;
      const stale = cands.filter((c) => isStale(c, now, d.ranked) || noDate(c));
      // 挑哪几条：按时间从新到旧（文章 publishedAt、榜单 rankedAt），免得 TechCrunch 这类量大的源把 PH / 厂商官方的挤掉
      const picks = newestFirst(cands.filter((c) => !stale.includes(c) && checkSafety(c).ok), d.ranked).slice(0, slots);
      log.push(`抓到 ${r.items.length} 条，新候选 ${cands.length}，其中超过 72 小时 / 没有发布时间跳过 ${stale.length}${Object.keys(r.errors).length ? `，失败源 ${JSON.stringify(r.errors)}` : ""}`);
      idx.skipped = [...(idx.skipped || []), ...stale.map((c) => ({ id: c.id, why: noDate(c) ? "no-pubdate" : "stale", publishedAt: c.publishedAt, at: now }))].slice(-300);
      for (const pick of picks) {
        const st = { id: pick.id, item: pick, step: "read", status: "pending", results: {}, tries: {}, errors: [], createdAt: now, updatedAt: now };
        await kv.put(`pipe:item:${pick.id}`, st);
        idx.pending.push(pick.id); idx.daily.started++;
        log.push(`新条目 ${pick.id}`);
      }
      // 标记看过（只用来不重复处理同一条新闻；下架不按 id，按稿子 hash）
      idx.seen = [...new Set([...idx.seen, ...stale.map((c) => c.id), ...picks.map((x) => x.id)])].slice(-SEEN_MAX);
    }
    // 2. 推进在途的
    for (const id of [...idx.pending]) {
      let st = await kv.get(`pipe:item:${id}`);
      if (!st) { idx.pending = idx.pending.filter((x) => x !== id); continue; }
      if (st.status === "waiting") st.status = "pending"; // 新的一轮（可能是新的一天）再试
      st = await advance(st, { ...d }, { save: (s) => kv.put(`pipe:item:${id}`, s), deadline });
      log.push(`${id}：${st.status} @${st.step}${st.why ? `（${st.why}）` : ""}`);
      if (st.status === "ready") { idx.pending = idx.pending.filter((x) => x !== id); idx.ready.push(id); }
      if (st.status === "skipped") { idx.pending = idx.pending.filter((x) => x !== id); if (st.createdAt != null && day(st.createdAt) === idx.daily.date) idx.daily.started = Math.max(0, idx.daily.started - 1); /* 没花钱的不占每天的名额 */ idx.skipped = [...(idx.skipped || []), { id, why: "stale", step: st.step, publishedAt: itemOf(st).publishedAt ?? null, at: now }].slice(-300); }
      if (st.status === "dropped") { idx.pending = idx.pending.filter((x) => x !== id); idx.dropped = [...idx.dropped, { id, step: st.step, why: st.why, at: now }].slice(-200); }
    }
    // 3. 上线：最多 perRun 条新的 + 插回被 use / rollback 拿掉的已上线条目 + 下线过期的
    let plan = null;
    const onAirTl = await kv.get("timeline");
    const effNow = effective(onAirTl, now);
    const onAirKeys = new Set([...(effNow?.next || effNow?.current)?.items || []].map(keyOf));
    // 已上线过、还在新鲜期、没下架、R2 里有音频、现在不在时间线里的 → 插回（不合成）
    idx.published = (idx.published || []).filter((p) => now - p.at <= FRESH_WINDOW_MS + 86400_000);
    const reinsert = [];
    for (const p of idx.published) {
      const st = await kv.get(`pipe:item:${p.id}`);
      const it = st?.seedItem;
      if (!it || onAirKeys.has(keyOf(it)) || !isFresh(it, now, d.ranked) || takedownMatches(d.takedown, it)) continue;
      if (!(await d.r2.head(it.audio.replace(/^\/audio\//, "")))) continue;
      reinsert.push(it);
    }
    // 线上 seed 版本里做完了（音频在 R2）、72 小时内、没下架、内容安全、单条校验能过、现在不在时间线里的 → 也插回（不合成）
    // （乔木 2026-10-09：最近几天的都可以播；之前按 6 / 12 小时下掉的这样回来）
    const ptr = await kv.get("pointer");
    const seed = ptr?.version ? await kv.get(`seed:${ptr.version}`) : null;
    const onAirIds = new Set([...(effNow?.next || effNow?.current)?.items || []].map((x) => x.id));
    const have = new Set([...onAirIds, ...reinsert.map((x) => x.id)]);
    for (const it of seed?.items || []) {
      if (have.has(it.id) || onAirKeys.has(keyOf(it)) || !it.audio || !isFresh(it, now, d.ranked) || takedownMatches(d.takedown, it)) continue;
      if (!checkSafety(it, it.brief).ok) { log.push(`${it.id}：内容安全没过，不插回`); continue; }
      const h = await d.r2.head(it.audio.replace(/^\/audio\//, ""));
      if (!h) continue;
      const v = validateItem(it, h.size ?? 2000);
      if (!v.ok) { log.push(`${it.id}：单条校验不过，不插回（${v.errors.join("；")}）`); continue; }
      reinsert.push(it); have.add(it.id);
    }
    // 待上线的：下架了的扔掉；过了新鲜期的标 skipped；取前 perRun 条
    const cand = []; // [{ id, st }]
    for (const id of [...idx.ready]) {
      if (cand.length >= perRun) break;
      const st = await kv.get(`pipe:item:${id}`);
      if (!st?.seedItem || takedownMatches(d.takedown, st.seedItem)) { idx.ready = idx.ready.filter((x) => x !== id); continue; }
      if (isStale(st.seedItem, now, d.ranked)) {
        log.push(`${id}：做好了但${staleWhy(st.seedItem, now, d.ranked)}，不上`);
        idx.ready = idx.ready.filter((x) => x !== id);
        idx.skipped = [...(idx.skipped || []), { id, why: "stale", step: "insert", publishedAt: st.seedItem.publishedAt ?? null, rankedAt: st.seedItem.rankedAt ?? null, at: now }].slice(-300);
        await kv.put(`pipe:item:${id}`, { ...st, status: "skipped", why: staleWhy(st.seedItem, now, d.ranked) });
        continue;
      }
      cand.push({ id, st });
    }
    const planWith = () => planPublish(onAirTl, now, { newItems: cand.map((c) => c.st.seedItem), reinsert, takedown: d.takedown, ranked: d.ranked });
    let p = planWith();
    // 点评开头撞车：改写那一条的第一句（一条一天一次）→ 重新校验 → 重新合成 → 再排；改不了 / 改了还撞 → 这条这一轮先不上
    for (let guard = 0; p.ok && p.clash && guard < 2 * perRun + 2; guard++) {
      const c = cand.find((x) => x.id === p.clash.id);
      let fixed = false;
      const timeLeft = Date.now() + 300_000 + STEP_MAX_MS.validate + STEP_MAX_MS.tts <= deadline; // 改写 = 一次 DeepSeek（300s）+ 校验 + 合成
      if (autoPublish && c && c.st.takeRewriteDay !== day(now) && timeLeft) {
        c.st.takeRewriteDay = day(now);
        const r = await rewriteTakeOpening(c.st, d, p.clash.avoid);
        log.push(`${c.id}：点评开头跟 ${p.clash.with} 撞了，改写第一句：${r.ok ? "成功" : r.reason}`);
        if (r.ok) {
          let st2 = { ...c.st, results: { ...c.st.results, script: r.script }, step: "validate", status: "pending", seedItem: undefined };
          st2 = await advance(st2, d, { save: (x) => kv.put(`pipe:item:${c.id}`, x), deadline });
          if (st2.status === "ready") { c.st = st2; fixed = true; }
          else { log.push(`改写后：${st2.status}（${st2.why || ""}）`); if (st2.status === "dropped") idx.ready = idx.ready.filter((x) => x !== c.id); }
        } else await kv.put(`pipe:item:${c.id}`, c.st);
      }
      if (!fixed) { log.push(`${p.clash.id}：点评开头撞车，这一轮先不上`); cand.splice(cand.findIndex((x) => x.id === p.clash.id), 1); }
      p = planWith();
    }
    if (p.ok) {
      plan = { switchAt: p.timeline.switchAt, count: p.count, inserted: p.inserted, reinserted: p.reinserted, droppedOld: p.dropped, keptStale: p.keptStale };
      if (autoPublish) {
        await kv.put("timeline", { ...p.timeline, updatedAt: new Date(now).toISOString(), why: `cron +${p.inserted.join(",") || "-"} reinsert ${p.reinserted.length} drop ${p.dropped}` });
        for (const id of p.inserted) {
          idx.ready = idx.ready.filter((x) => x !== id);
          idx.published.push({ id, at: now });
          const st = await kv.get(`pipe:item:${id}`); st.status = "published"; st.airedAt = now; await kv.put(`pipe:item:${id}`, st);
        }
        log.push(`时间线已更新：新上 ${p.inserted.join(",") || "无"}，插回 ${p.reinserted.length} 条，下线 ${p.dropped} 条，${new Date(p.timeline.switchAt ?? now).toISOString()} 生效，共 ${p.count} 条${p.keptStale ? "（全部超过 72 小时，保留了最新 5 条）" : ""}`);
      } else log.push(`自动上线关闭；如果打开：${new Date(p.timeline.switchAt ?? now).toISOString()} 生效，共 ${p.count} 条（新上 ${p.inserted.length}、插回 ${p.reinserted.length}、下线 ${p.dropped}）`);
    } else if (!p.noop) { plan = { refused: p.reason }; log.push(`时间线不动：${p.reason}`); }
    idx.last = { at: now, log, plan, autoPublish };
    await kv.put("pipe:index", idx);
    return idx.last;
  } finally {
    await kv.delete?.("pipe:lock");
  }
}
