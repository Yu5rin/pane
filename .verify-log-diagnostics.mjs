// ログからバグを炙り出すための仕組み(JS側)の検証。
//
// 対象は src/main.js に入れた2つ:
//   (1) 同じ未処理エラーを何度も記録しない打ち切り(logErrorLimited)
//   (2) メインスレッドが長時間ふさがったことの検知(startStallWatch)
//
// C#側(Logger の非同期化・前回ログの読み返し・保存サイズの検証)は Windows でしか
// 動かせないため、このスイートの対象外。実機での確認が必要。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

const PORT = 8213;

async function newPage() {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.chrome = {
      webview: {
        postMessage: (m) => window.__sent.push(m),
        addEventListener: (_t, fn) => listeners.push(fn),
      },
    };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);
  return page;
}

// 起動を完了させる(initial-render-ready の条件をそろえる)。
async function finishStartup(page) {
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark" }));
  await page.evaluate(() => window.__reply({ type: "new-document", encoding: "UTF-8", lineEnding: "CRLF" }));
  await page.waitForTimeout(200);
}

function logsOf(page, level) {
  return page.evaluate((lv) =>
    window.__sent.filter((m) => m.type === "log" && m.level === lv).map((m) => String(m.message)), level);
}

// ---- (1) 同じエラーの繰り返しは5回で打ち切られる ----
{
  const page = await newPage();
  await finishStartup(page);

  // 同一の未処理エラーを8回起こす。window.onerror 経由にするため setTimeout から投げる。
  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => {
        setTimeout(() => { resolve(); throw new Error("繰り返しテスト用のエラー"); }, 0);
      });
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  await page.waitForTimeout(300);

  const errors = (await logsOf(page, "error")).filter((m) => m.includes("繰り返しテスト用のエラー"));
  ok(`(1-a) 同じエラーの記録は5回で止まる (${errors.length}回)`, errors.length === 5);

  const warns = (await logsOf(page, "warn")).filter((m) => m.includes("以後は記録しない"));
  ok(`(1-b) 打ち切りを1回だけ知らせる (${warns.length}回)`, warns.length === 1);
  if (warns.length) console.log(`     ${warns[0]}`);

  // 別の内容のエラーは打ち切りの影響を受けない。
  await page.evaluate(() => {
    setTimeout(() => { throw new Error("別のエラー"); }, 0);
  });
  await page.waitForTimeout(200);
  const others = (await logsOf(page, "error")).filter((m) => m.includes("別のエラー"));
  ok(`(1-c) 内容が違うエラーは別枠で記録される (${others.length}回)`, others.length === 1);

  await page.close();
}

// ---- (2) メインスレッドが長時間ふさがると警告が出る ----
{
  const page = await newPage();
  await finishStartup(page);

  // 監視は起動完了後に始まる。ここまでで警告が出ていないことを確認しておく。
  const before = (await logsOf(page, "warn")).filter((m) => m.includes("応答が"));
  ok(`(2-a) 通常の起動では応答停止の警告が出ない (${before.length}件)`, before.length === 0);

  // 1.5秒間、同期ループでメインスレッドを占有する。
  await page.evaluate(() => {
    const until = Date.now() + 1500;
    while (Date.now() < until) { /* 意図的な占有 */ }
  });
  await page.waitForTimeout(1500);

  const after = (await logsOf(page, "warn")).filter((m) => m.includes("応答が"));
  ok(`(2-b) 1.5秒の占有で警告が記録される (${after.length}件)`, after.length >= 1);
  if (after.length) console.log(`     ${after[0]}`);

  // 記録された時間が実際の占有時間とかけ離れていないこと(500ms以上・3秒以下)。
  const ms = after.length ? Number(/応答が(\d+)ms/.exec(after[0])?.[1] ?? 0) : 0;
  ok(`(2-c) 記録された停止時間が妥当な範囲 (${ms}ms)`, ms >= 500 && ms <= 3000);

  await page.close();
}

// ---- (3) 非表示のときは誤検知しない ----
{
  const page = await newPage();
  await finishStartup(page);

  // document.hidden を真に見せかけてから占有する。ブラウザがタイマーを間引く状況の代役。
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    const until = Date.now() + 1500;
    while (Date.now() < until) { /* 意図的な占有 */ }
  });
  await page.waitForTimeout(1500);

  const warns = (await logsOf(page, "warn")).filter((m) => m.includes("応答が"));
  ok(`(3-a) 画面が見えていないときは警告しない (${warns.length}件)`, warns.length === 0);

  await page.close();
}

await browser.close();
