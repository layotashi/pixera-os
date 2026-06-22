/**
 * tools/serve.mjs — 依存ゼロの静的ファイルサーバー（開発用）。
 *   node tools/serve.mjs            → http://localhost:8777/
 * lang/playground を ES モジュールで開くために使う（file:// では import 不可）。
 */
import http from "http";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 8777;
const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
};

const server = http.createServer(async (req, res) => {
  try {
    let url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url.endsWith("/")) url += "index.html";
    const fp = path.normalize(path.join(REPO, url));
    if (!fp.startsWith(REPO)) return res.writeHead(403).end();
    const data = await fs.readFile(fp);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("404");
  }
});

server.listen(PORT, () => {
  console.log(`[serve] http://localhost:${PORT}/`);
  console.log(`[serve] playground: http://localhost:${PORT}/lang/playground/`);
});
