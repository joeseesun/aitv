// 兼容版本地预览：public/ 当静态站点，/api、/audio、/img 转发到线上实例（有真节目单和声音）。
//   node scripts/build-legacy.mjs && node scripts/legacy-serve.mjs
//   设备上：adb reverse tcp:8788 tcp:8788，然后打开 http://localhost:8788/legacy/
// 环境变量：AITV_UPSTREAM（默认 https://aitv.qiaomu.ai）、PORT（默认 8788）
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../public");
const upstream = process.env.AITV_UPSTREAM || "https://aitv.qiaomu.ai";
const port = Number(process.env.PORT || 8788);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".webmanifest": "application/manifest+json" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (/^\/(api|audio|img)\//.test(url.pathname)) {
      const headers = {};
      for (const h of ["range", "accept", "if-none-match", "if-modified-since"]) if (req.headers[h]) headers[h] = req.headers[h];
      const r = await fetch(upstream + url.pathname + url.search, { headers });
      const out = {};
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]) {
        const v = r.headers.get(h); if (v) out[h] = v;
      }
      res.writeHead(r.status, out);
      if (r.body) for await (const chunk of r.body) res.write(chunk);
      return res.end();
    }
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) { res.writeHead(403); return res.end(); }
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, "index.html");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e.code === "ENOENT" ? 404 : 502);
    res.end();
  }
}).listen(port, () => console.log(`legacy preview http://localhost:${port}/legacy/ → ${upstream}`));
