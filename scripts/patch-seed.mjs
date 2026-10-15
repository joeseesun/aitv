// 给已有 seed.json 补画面要的字段，不重新合成语音（幂等）：
//   item.take（第三段，AI 点评）、rounds[i].part（what / who / take）、HN 英文标题的 fields.title_zh。
// 用法：DEEPSEEK_API_KEY=… node scripts/patch-seed.mjs public/seeds/<version>/seed.json   （没有 key 就跳过翻译）
import { readFileSync, writeFileSync } from "node:fs";
import { needsTitleZh, translateTitle, PART_KEYS } from "../src/writer.js";
import { makeDeepSeek } from "../src/llm.js";

const path = process.argv[2] || new URL("../public/seed.json", import.meta.url);
const seed = JSON.parse(readFileSync(path, "utf8"));
const llm = process.env.DEEPSEEK_API_KEY ? makeDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.AITV_BRIEF_MODEL || "deepseek-flash" }) : null;

for (const it of seed.items) {
  const lines = (it.script || []).map((s) => s.text);
  (it.script || []).forEach((s, i) => { s.part ||= PART_KEYS[i]; });
  if (!it.take && lines[2]) it.take = lines[2];
  const rounds = it.rounds || [];
  if (rounds.length === lines.length) rounds.forEach((r, i) => { r.part ||= PART_KEYS[i]; });
  else {
    const bounds = []; let acc = 0; for (const l of lines) bounds.push((acc += l.length));
    let pos = 0;
    for (const r of rounds) { const mid = pos + r.text.length / 2; const i = bounds.findIndex((b) => mid <= b); r.part ||= PART_KEYS[Math.min(i < 0 ? 2 : i, 2)]; pos += r.text.length; }
  }
  if (llm && needsTitleZh(it) && !it.fields.title_zh) {
    const zh = await translateTitle(it, { llm: (p) => llm(p, { temperature: 0.2 }) });
    if (zh) it.fields.title_zh = zh;
    console.log(zh ? `✓ ${it.fields.title} → ${zh}` : `✗ 没翻成：${it.fields.title}`);
  }
}
writeFileSync(path, JSON.stringify(seed, null, 1));
console.log("seed.json 已补字段：", seed.items.length, "条");
