// v3：真抓一轮 → 读原文提炼 brief（含 kind / name）→ 排好顺序 → DeepSeek 按顺序写三段稿
// （模板 + 校验；相邻两条点评开头不能一样，所以写稿按播出顺序逐条来）→ stdout（JSON）。
// 用法：node scripts/build-items.mjs 20 > /tmp/items.json   （需要 DEEPSEEK_API_KEY）
// 统计（每源条数、丢弃原因）写到 stderr 和 /tmp/aitv-build-stats.json。
import { cacheItemImages } from "./r2-images.mjs";
import { writeFileSync } from "node:fs";
import { fetchAll, dedupe, interleave } from "../src/sources.js";
import { enrich } from "../src/enrich.js";
import { writeScript, toSeedItem, needsTitleZh, translateTitle, PART_KEYS, opening } from "../src/writer.js";
import { makeDeepSeek } from "../src/llm.js";

const N = Number(process.argv[2] || 20);
const apiKey = process.env.DEEPSEEK_API_KEY;
const briefLLM = makeDeepSeek({ apiKey, model: process.env.AITV_BRIEF_MODEL || "deepseek-flash" });
const scriptLLM = makeDeepSeek({ apiKey, model: process.env.AITV_SCRIPT_MODEL || "deepseek-flash" });
const log = (s) => process.stderr.write(s + "\n");

const { items, errors } = await fetchAll();
const cands = interleave(dedupe(items));
const sources = [...new Set(cands.map((x) => x.source))];
const quota = Math.ceil(N / Math.max(1, sources.length));
const BUFFER = 2; // 每源多备几条 brief，写稿丢了能补
log(`抓到 ${items.length} 条，候选 ${cands.length}，源 ${sources.join(" / ")}，每源 ${quota} 条（备 ${BUFFER}）；失败源：${JSON.stringify(errors)}`);

const dropped = [];
const drop = (it, stage, why) => { dropped.push({ id: it.id, source: it.source, title: it.fields.title, stage, why }); log(`✗ ${stage.padEnd(6)} [${it.source}] ${it.fields.title.slice(0, 40)} — ${why}`); };

// ---- 第一步：并发补料，每源凑够 quota + BUFFER 条 brief ----
const queues = {}, briefs = {};
for (const c of cands) (queues[c.source] ||= []).push(c);
const busy = {};
const load = (s) => (busy[s] || 0) + (briefs[s]?.length || 0);
function next() {
  const ok = sources.filter((s) => queues[s]?.length && load(s) < quota + BUFFER).sort((a, b) => load(a) - load(b));
  return ok.length ? queues[ok[0]].shift() : null;
}
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let it; (it = next()); ) {
    busy[it.source] = (busy[it.source] || 0) + 1;
    try {
      const e = await enrich(it, { llm: (p) => briefLLM(p, { temperature: 0.3 }), retries: 1 });
      if (e.dateUnknown || (it.source === "AIHOT" && e.publishedAt == null)) drop(it, "date", "发布时间读不到，不播（不拿抓取时间顶替）");
      else if (!e.brief) drop(it, "brief", e.briefError);
      else { (briefs[it.source] ||= []).push(e); log(`· brief  [${it.source}] ${e.kind} ${e.brief.name ? `«${e.brief.name}» ` : ""}${it.fields.title.slice(0, 40)}`); }
    } finally { busy[it.source]--; }
  }
}));
// 保持各源内原来的顺序
for (const s of sources) briefs[s] = (briefs[s] || []).sort((a, b) => cands.indexOf(a) - cands.indexOf(b));

// ---- 第二步：先按播出顺序（各源轮流）并发写一遍稿；再按顺序逐条过，
// 点评开头跟上一条撞了的，把上一条点评传进提示词重写（重写内含一次重试），还不行就丢。
// （纯串行写稿每条要一两分钟，二十条太慢，所以先并发、只对撞车的串行重写。）
const order = [];
for (let r = 0; r < quota + BUFFER; r++) for (const s of sources) if (briefs[s]?.[r]) order.push(briefs[s][r]);
const first = new Map();
let qi = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let e; (e = order[qi++]); ) first.set(e.id, await writeScript(e, { llm: scriptLLM }));
}));
const out = [], count = {};
let prevTake = "", rewrites = 0;
for (const e of order) {
  if (out.length >= N) break;
  if ((count[e.source] || 0) >= quota) continue;
  let s = first.get(e.id);
  if (s.error) { drop(e, "script", s.error); continue; }
  if (prevTake && opening(s.lines[2]) === opening(prevTake)) {
    rewrites++;
    log(`↻ 点评开头「${opening(s.lines[2])}」跟上一条撞了，带上一条点评重写：${e.fields.title.slice(0, 40)}`);
    s = await writeScript(e, { llm: scriptLLM, prevTake });
    if (s.error) { drop(e, "script", `开头撞车重写后仍不过：${s.error}`); continue; }
  }
  const fields = { ...e.fields };
  if (needsTitleZh(e)) { const zh = await translateTitle(e, { llm: (p) => briefLLM(p, { temperature: 0.2 }) }); if (zh) fields.title_zh = zh; }
  out.push(toSeedItem({ ...e, kind: s.kind, fields, take: s.lines[2],
    script: s.parts.map((tpl, i) => ({ part: PART_KEYS[i], tpl, text: s.lines[i] })), lines: s.lines }));
  count[e.source] = (count[e.source] || 0) + 1;
  prevTake = s.lines[2];
  log(`✓ script [${e.source}] ${e.kind} ${e.fields.title.slice(0, 40)}（第 ${s.attempts} 次通过，${s.lines.join("").length} 字）`);
}

// 封面图转存到自家 R2（/img/<key>），第三方地址不进节目单
const hints = Object.fromEntries(order.filter((e) => e.imageHint).map((e) => [e.id, e.imageHint]));
const withImage = await cacheItemImages(out, { log, hints });

const perSource = {}, perKind = {};
for (const p of out) { perSource[p.source] = (perSource[p.source] || 0) + 1; perKind[p.kind] = (perKind[p.kind] || 0) + 1; }
const unused = order.filter((e) => !out.some((o) => o.id === e.id) && !dropped.some((d) => d.id === e.id)).length;
const stats = { picked: out.length, perSource, perKind, withImage, dropped, takeOpeningRewrites: rewrites, unusedBuffer: unused, sourceErrors: errors };
writeFileSync("/tmp/aitv-build-stats.json", JSON.stringify(stats, null, 1));
log(`取 ${out.length} 条 ${JSON.stringify(perSource)} ${JSON.stringify(perKind)}；丢 ${dropped.length} 条；备用没用上 ${unused} 条`);
process.stdout.write(JSON.stringify(out, null, 1));
