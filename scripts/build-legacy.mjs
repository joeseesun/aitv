// 兼容版：给系统 WebView 停在 Chrome 61 的老安卓设备用。
// 产物在 public/legacy/（不进仓库），由 Worker 当静态资源发出去：/legacy/
//   - public/app.js（含 /screen/tv.js）打成一个普通 <script>，语法降到 chrome61
//   - 顶层 await 老内核不认：把 app.js 的主体包进 async 函数
//   - 1cqw 由 legacy/shim.js 换成 CSS 变量 --cqw
import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public/legacy");
const TARGET = "chrome61";

const legacyPlugin = {
  name: "aitv-legacy",
  setup(b) {
    // 站点用绝对路径 import（/client.js、/screen/tv.js），指回仓库里的源文件
    b.onResolve({ filter: /^\/(client|timeline)\.js$/ }, (a) => ({ path: join(root, "public", a.path) }));
    b.onResolve({ filter: /^\/screen\// }, (a) => ({ path: join(root, a.path) }));
    b.onLoad({ filter: /public\/app\.js$/ }, async (a) => {
      const src = await readFile(a.path, "utf8");
      const lines = src.split("\n");
      const imports = lines.filter((l) => /^import\s/.test(l));
      const body = lines.filter((l) => !/^import\s/.test(l)).join("\n");
      return { contents: `${imports.join("\n")}\n(async () => {\n${body}\n})();\n`, loader: "js" };
    });
    // 画面里内联的 translateY(${x}cqw) 换成 calc(x * var(--cqw))
    b.onLoad({ filter: /screen\/(v4\/)?tv\.js$/ }, async (a) => {
      const src = await readFile(a.path, "utf8");
      return { contents: src.replace(/\$\{([^}]+)\}cqw\)/g, "calc(${$1} * var(--cqw)))"), loader: "js" };
    });
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, "public/app.js")],
  inject: [join(root, "legacy/polyfills.js"), join(root, "legacy/shim.js")],
  bundle: true,
  format: "iife",
  target: TARGET,
  minify: true,
  legalComments: "none",
  outfile: join(out, "app.js"),
  plugins: [legacyPlugin],
  logLevel: "warning",
});
await cp(join(root, "legacy/index.html"), join(out, "index.html"));
await cp(join(root, "legacy/legacy.css"), join(out, "legacy.css"));
// /legacy/ 自包含：样式和脚本都在这个目录里，单独部署或打包都不缺文件
await cp(join(root, "screen/tv.css"), join(out, "tv.css"));
await cp(join(root, "public/site.css"), join(out, "site.css"));
console.log(`legacy build → ${out} (${TARGET})`);
