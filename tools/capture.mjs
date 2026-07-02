/**
 * tools/capture.mjs — visual review harness
 *
 * SYNESTA を headless Chromium で起動し、指定したアプリウィンドウを開いて
 * canvas をスクリーンショット PNG として保存する。
 *
 * 用途:
 *   - コーディングエージェントが UI 実装後に画面確認する閉ループ
 *   - レイアウト崩れ・はみ出し・重なりを最終 commit 前に検知
 *
 * 使い方:
 *   node tools/capture.mjs <WINDOW_NAME>          # 指定アプリのウィンドウを撮影
 *   node tools/capture.mjs desktop                # デスクトップ全体 (ウィンドウ無し)
 *
 * 出力:
 *   screenshots/<WINDOW_NAME>.png  (常に上書き)
 *
 * 必要環境:
 *   - playwright (`npm install --save-dev playwright`)
 *   - chromium バイナリ (`npx playwright install chromium`)
 *
 * 限界:
 *   - 1 フレーム静止画のみ (アニメーションの良し悪しは別途)
 *   - 音は無し (BAND の AnalyserNode は無入力)
 *   - キーボード/マウス操作は無し (初期状態のレイアウトのみ)
 */

import http from "http";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PORT = 8765;
const BOOT_TIMEOUT_MS = 15000;
const SETTLE_MS = 2000; // ウィンドウ open 後にレイアウト + アニメーションが落ち着くまで待つ
// (TELEX のタイプライタや AQUARIUM の魚の動きが初期遷移を終えるのに十分な時間)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Args
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const windowName = process.argv[2];
if (!windowName) {
  console.error("Usage: node tools/capture.mjs <WINDOW_NAME>");
  console.error("       node tools/capture.mjs desktop");
  process.exit(1);
}

const outDir = path.join(REPO_ROOT, "screenshots");
const outPath = path.join(outDir, `${windowName}.png`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  静的ファイルサーバー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let url = (req.url || "/").split("?")[0];
      if (url === "/") url = "/index.html";
      const filePath = path.normalize(path.join(REPO_ROOT, url));
      // path traversal 防止
      if (!filePath.startsWith(REPO_ROOT)) {
        res.writeHead(403).end();
        return;
      }
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch (_) {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(PORT, () => resolve(server));
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  メイン
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  console.log(`[capture] starting server on http://localhost:${PORT}`);
  const server = await startServer();

  let browser;
  try {
    console.log(`[capture] launching chromium (headless)`);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      // 音声 autoplay を許可しておく (BAND 用、将来必要なら)
    });
    const page = await context.newPage();

    // console 出力を転送 (デバッグ用)
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        console.log(`  [browser ${t}] ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.error(`  [browser PAGE ERROR] ${err.message}`);
    });

    console.log(`[capture] loading SYNESTA`);
    await page.goto(`http://localhost:${PORT}/`);

    console.log(`[capture] waiting for boot (window.__synesta.booted)`);
    await page.waitForFunction(
      () => window.__synesta && window.__synesta.booted === true,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // レビューの判別精度を上げるための調整。production への影響無し
    // (capture 専用の一時設定で、page を閉じれば消える):
    //   - Diagonal scanline / Vignette を OFF
    //   - カーソルを非表示 (UI に重なって判読を妨げるため)
    //   - 背景を単色 Solid (level 0) にしてディザ模様のノイズを除去
    console.log(`[capture] applying review-clarity settings`);
    await page.evaluate(async () => {
      window.__synesta.setEffect("diagEnabled", false);
      window.__synesta.setEffect("vignetteEnabled", false);
      window.__synesta.setCursorHidden(true);
      const Wallpaper = await import("/js/wallpaper.js");
      Wallpaper.setBackgroundMode("solid");
      Wallpaper.setSolidLevel(0);
    });

    // 環境変数 SYNESTA_FONT で起動時のシステムフォントを切替えられる
    // (デバッグ用。例: SYNESTA_FONT=<フォントID> npm run capture SETTINGS)
    const fontOverride = process.env.SYNESTA_FONT;
    if (fontOverride) {
      console.log(`[capture] switching font to: ${fontOverride}`);
      await page.evaluate(async (id) => {
        // Config.setSystemFont は kernel.js の boot で公開していないため
        // import() で動的に取得する
        const Config = await import("/js/config.js");
        await Config.setSystemFont(id);
      }, fontOverride);
      await page.waitForTimeout(300);
    }

    // ウィンドウを開く (desktop モードはスキップ)
    if (windowName.toLowerCase() !== "desktop") {
      console.log(`[capture] opening window: ${windowName}`);
      const opened = await page.evaluate((name) => {
        try {
          window.__synesta.wmOpenByName(name);
          return true;
        } catch (e) {
          return String(e);
        }
      }, windowName);
      if (opened !== true) {
        throw new Error(`wmOpenByName failed: ${opened}`);
      }
      // レイアウトが落ち着くのを待つ
      await page.waitForTimeout(SETTLE_MS);
    } else {
      console.log(`[capture] desktop mode (no window opened)`);
      await page.waitForTimeout(SETTLE_MS);
    }

    // canvas#screen をスクリーンショット
    console.log(`[capture] screenshotting canvas#screen`);
    await fs.mkdir(outDir, { recursive: true });
    const canvas = page.locator("canvas#screen");
    await canvas.screenshot({ path: outPath });

    console.log(`[capture] saved: ${path.relative(REPO_ROOT, outPath)}`);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(`[capture] ERROR: ${err.message}`);
  process.exit(1);
});
