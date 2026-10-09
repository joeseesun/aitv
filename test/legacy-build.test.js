import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 兼容版给 Chrome 61 的系统 WebView 用：这些写法老内核直接 SyntaxError，整页白屏
test("legacy build: 产物里没有 Chrome 61 不认的语法", () => {
  execFileSync(process.execPath, ["scripts/build-legacy.mjs"], { stdio: "pipe" });
  const js = readFileSync("public/legacy/app.js", "utf8");
  for (const [name, re] of [
    ["optional chaining", /\?\.[A-Za-z_$(\[]/],
    ["nullish coalescing", /\?\?/],
    ["logical assignment", /(\|\||&&|\?\?)=/],
    ["dynamic import", /\bimport\(/],
    ["ES module syntax", /^\s*(import|export)\s/m],
    ["cqw 单位", /\dcqw/],
  ]) assert.ok(!re.test(js), `public/legacy/app.js 里有 ${name}`);
  assert.match(js, /AbortSignal/, "polyfill 没打进去");
  assert.match(js, /--cqw/, "shim 没打进去");
});

test("legacy build: /legacy/ 自包含（样式和脚本都在目录里）", () => {
  const html = readFileSync("public/legacy/index.html", "utf8");
  for (const ref of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
    if (ref[1] === "/icon.svg") continue;
    assert.ok(ref[1].startsWith("/legacy/"), `index.html 引用了 /legacy/ 以外的文件：${ref[1]}`);
    readFileSync("public" + ref[1]);
  }
});

// shim.js 的 rAF 兜底：老 WebView 停发 rAF 时，渲染循环靠 setTimeout 续上，不能断
test("legacy shim: rAF 停发时 250ms 后用 setTimeout 补调，正常时不重复调用", async () => {
  const { runInNewContext } = await import("node:vm");
  const src = readFileSync("legacy/shim.js", "utf8");
  const stalled = [], ok = [];
  const queue = new Map(); let qid = 0;
  const win = {
    addEventListener() {},
    requestAnimationFrame(cb) { const id = ++qid; queue.set(id, cb); return id; },
    cancelAnimationFrame(id) { queue.delete(id); },
  };
  const ctx = {
    window: win, setTimeout, clearTimeout, Date, performance,
    document: { hidden: false, documentElement: { clientWidth: 800, clientHeight: 480, style: { setProperty() {} } }, addEventListener() {} },
  };
  runInNewContext(src, ctx);
  // 1) rAF 不出帧：回调由兜底补调，并计数
  win.requestAnimationFrame((ts) => stalled.push(ts));
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(stalled.length, 1);
  assert.equal(win.__aitvRafStalls.count, 1);
  // 2) rAF 正常：原生回调先到，兜底不再补
  win.requestAnimationFrame((ts) => ok.push(ts));
  for (const [id, cb] of queue) { queue.delete(id); cb(16); }
  await new Promise((r) => setTimeout(r, 320));
  assert.deepEqual(ok, [16]);
  assert.equal(win.__aitvRafStalls.count, 1);
  // 3) cancelAnimationFrame 同时取消兜底
  const cancelled = [];
  const id = win.requestAnimationFrame(() => cancelled.push(1));
  win.cancelAnimationFrame(id);
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(cancelled.length, 0);
});
