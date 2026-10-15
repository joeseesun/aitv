import { parseRanked, annotate } from "./freshness.js";
import { serveAudio } from "./audio.js";
import { serveImage } from "./images.js";
import { buildSchedule } from "./schedule.js";
import { applyTakedown } from "./release.js";
import { effective } from "./timeline.js";
import { runCron } from "./pipeline.js";
import { makeDeepSeek } from "./llm.js";
import { synthesize } from "./doubao.js";

// 部署的是哪个提交：scripts/deploy.mjs 用 `wrangler deploy --define BUILD_COMMIT:"<sha>"` 在构建时注入；本地 / 测试里是 "dev"。
/* global BUILD_COMMIT */
const COMMIT = typeof BUILD_COMMIT !== "undefined" ? BUILD_COMMIT : "dev";

// 节目单来源：KV（namespace SCHEDULE）
//   "pointer"         → { version, previous, commit, switchedAt }   线上指针，切换 / 回滚只改这一个 key
//   "takedown"        → { hashes, audio, refs }  下架名单（按稿子 hash，不按 id）：每次读节目单都过滤掉，并重新连续排时间
//   "timeline"        → { current, next, switchAt }  全局时间线（src/timeline.js）；有它就以它为准，没有才按 pointer+seed 现排
//   "seed:<version>"  → 该版本的 seed.json（音频在 R2：<hash>.mp3，对外 /audio/<hash>.mp3；配图在 R2 img/<key>，对外 /img/<key>）
// KV 边缘缓存最短 30 秒：下架 / 切换最晚约半分钟到一分钟内全球生效；/api/schedule 本身 no-store。
const KV_TTL = { cacheTtl: 30, type: "json" };
export async function loadSeed(env) {
  const ptr = await env.SCHEDULE.get("pointer", KV_TTL);
  if (!ptr?.version) throw new Error("KV 里没有线上指针");
  const [seed, takedown] = await Promise.all([env.SCHEDULE.get(`seed:${ptr.version}`, "json"), env.SCHEDULE.get("takedown", KV_TTL)]);
  if (!seed) throw new Error(`KV 里没有 seed:${ptr.version}`);
  return { ...seed, version: ptr.version, releaseCommit: ptr.commit || null, takedown };
}

// /api/schedule 的内容：{ version, commit, releaseCommit, current, next, switchAt, ...current }
// 顶层的 anchor/total/items 就是 current（兼容还没刷新的旧客户端）。
// 下架名单在读的时候再过滤一遍：条目带 effectiveAt 的，到点才生效（普通下架 = switchAt，紧急下架 = 立刻）。
export async function scheduleBody(env, nowMs) {
  const [ptr, tl, takedown] = await Promise.all([
    env.SCHEDULE.get("pointer", KV_TTL), env.SCHEDULE.get("timeline", KV_TTL), env.SCHEDULE.get("takedown", KV_TTL),
  ]);
  const filt = (s) => {
    if (!s) return null;
    const kept = applyTakedown(s.items, takedown, nowMs);
    return kept.length === s.items.length ? s : { version: s.version, ...buildSchedule(kept, s.anchor) };
  };
  let view = effective(tl, nowMs);
  if (!view) {
    if (!ptr?.version) throw new Error("KV 里没有线上指针");
    const seed = await env.SCHEDULE.get(`seed:${ptr.version}`, "json");
    if (!seed) throw new Error(`KV 里没有 seed:${ptr.version}`);
    view = { current: { version: ptr.version, ...buildSchedule(seed.items, seed.anchorMs ?? seed.anchor ?? 0) }, next: null, switchAt: null };
  }
  const ranked = parseRanked(env.RANKED_SOURCES);
  const ann = (s) => s && { ...s, items: s.items.map((it) => annotate(it, ranked)) }; // 每条带 publishedAt / dateKind（榜单类带 rankedAt）
  const current = ann(filt(view.current)), next = ann(filt(view.next));
  return {
    version: current.version ?? ptr?.version ?? null, commit: COMMIT, releaseCommit: ptr?.commit || null,
    current, next, switchAt: next ? view.switchAt : null,
    anchor: current.anchor, total: current.total, items: current.items,
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/time") {
      return Response.json({ now: Date.now() }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/schedule") {
      try {
        let body = await scheduleBody(env, Date.now());
        if (url.searchParams.get("compact") === "1") {
          const compact = schedule => schedule && { ...schedule, items: schedule.items.map(item => {
            const { brief, script, spoken, ...playback } = item;
            return playback;
          }) };
          body = { version: body.version, commit: body.commit, releaseCommit: body.releaseCommit,
            current: compact(body.current), next: compact(body.next), switchAt: body.switchAt };
        }
        return Response.json(body, { headers: { "cache-control": "no-store" } });
      } catch (e) {
        return Response.json({ error: String(e.message || e) }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    }
    if (url.pathname.startsWith("/audio/")) return serveAudio(req, env);
    if (url.pathname.startsWith("/img/")) return serveImage(req, env);
    return env.ASSETS.fetch(req);
  },
  // 定时流水线（src/pipeline.js）：每轮推进在途条目，额度 / 名额 / 自动上线都由 vars 控制（wrangler.toml）
  async scheduled(event, env) {
    const d = makeDeps(env, event.scheduledTime || Date.now());
    try {
      await runCron(d, {
        maxNewPerDay: Number(env.PIPELINE_MAX_NEW_PER_DAY ?? 1),
        autoPublish: env.AUTO_PUBLISH === "1",
      });
    } catch (e) {
      await d.kv.put("pipe:error", { at: Date.now(), msg: String(e?.stack || e).slice(0, 1000) });
    }
  },
};

// KV 存 JSON 的薄封装 + 各种外部依赖（测试里全换成假的）
export function makeDeps(env, now = Date.now()) {
  const kv = {
    get: (k) => env.SCHEDULE.get(k, "json"),
    put: (k, v, o) => env.SCHEDULE.put(k, JSON.stringify(v), o),
    delete: (k) => env.SCHEDULE.delete(k),
  };
  const key = env.DEEPSEEK_API_KEY;
  return {
    now, kv, r2: env.AUDIO, fetch: (...a) => fetch(...a),
    ttsCap: Number(env.TTS_DAILY_CAP ?? 40),
    ranked: parseRanked(env.RANKED_SOURCES),
    briefLLM: makeDeepSeek({ apiKey: key, model: env.BRIEF_MODEL || "deepseek-flash" }),
    scriptLLM: makeDeepSeek({ apiKey: key, model: env.SCRIPT_MODEL || "deepseek-flash", timeoutMs: 300_000 }),
    tts: (payload) => synthesize(env.DOUBAO_TTS_ACCESS_TOKEN, payload),
  };
}
