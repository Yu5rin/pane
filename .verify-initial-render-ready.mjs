// 起動時の白フラッシュ対策(新方式)の検証。
// JS側(src/main.js)が"initial-render-ready"を送るタイミングと条件を、
// window.chrome.webviewブリッジのモック(他の.verify-*.mjsと同じ作法)で確認する。
//
// C#側(Pane/MainForm.cs RevealWebView)のフォールバックタイマーはJS側からは検証できない
// (JSを一切実行しなくても3秒後にC#が自力でWebView2を表示する、という設計そのものが
// タイマーの動作をこの環境で再現できないことを前提にしているため)。このスイートで
// 確認できるのはあくまで「JS側が正しい条件・タイミングで通知を送るか」までで、
// C#側のフォールバックが実際に機能するかは実機での確認が必要。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

const SAMPLE = "# 見出し\n\n本文です。\n";

// 各テストで新しいページを使う(状態を持ち越さないため)。ブリッジは共通のモックを
// addInitScriptで注入し、postMessageのたびに「その瞬間のDOM状態」もスナップショットとして
// 記録しておく(=initial-render-readyが実際にいつ送られたかを、送信後のwaitForTimeoutでの
// 事後確認ではなく、送信そのものの瞬間の状態で厳密に検証するため)。
async function newPage() {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.__snapshots = [];
    window.chrome = {
      webview: {
        postMessage: (m) => {
          window.__sent.push(m);
          window.__snapshots.push({
            type: m.type,
            // テーマが確定しているか(未設定ならnull)
            theme: document.documentElement.dataset.theme || null,
            // メニューバー・ステータスバーが実際にDOMへ描画されているか
            menubarPresent: !!document.getElementById("menubar"),
            statusbarPresent: !!document.getElementById("statusbar"),
            // ステータスバーのモード表示に文字が入っているか(空文字はまだ内容未反映とみなす)
            statusModeText: document.getElementById("status-mode")?.textContent ?? null,
            // 本文エリア(CodeMirror)が実際にマウントされているか
            cmEditorPresent: !!document.querySelector("#cm-host .cm-editor"),
          });
        },
        addEventListener: (_t, fn) => listeners.push(fn),
      },
    };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto("http://localhost:8190/index.html");
  await page.waitForTimeout(500);
  return { page, errors };
}

function sentTypes(page) {
  return page.evaluate(() => window.__sent.map((m) => m.type));
}
function countType(page, type) {
  return page.evaluate((t) => window.__sent.filter((m) => m.type === t).length, type);
}
function snapshotFor(page, type) {
  return page.evaluate((t) => {
    const i = window.__sent.findIndex((m) => m.type === t);
    return i === -1 ? null : window.__snapshots[i];
  }, type);
}

// ---- (1) 通常の起動順(apply-settings → file-opened)で1回だけ送られる ----
{
  const { page, errors } = await newPage();

  ok("(1-a) 起動直後はまだinitial-render-readyを送っていない",
    (await countType(page, "initial-render-ready")) === 0);

  // apply-settingsだけ届いた段階ではまだ送らない(本文エリアの内容がまだ反映されていないため)
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark" }));
  await page.waitForTimeout(150);
  ok("(1-b) apply-settingsのみではまだ送らない(本文未反映)",
    (await countType(page, "initial-render-ready")) === 0);

  // file-openedが届いて初めて両条件がそろい、送られる
  await page.evaluate(({ text }) => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md", text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { text: SAMPLE });
  await page.waitForTimeout(200);
  ok("(1-c) file-opened後にinitial-render-readyが1回送られる",
    (await countType(page, "initial-render-ready")) === 1);

  const snap = await snapshotFor(page, "initial-render-ready");
  ok(`(1-d) 送信の瞬間、テーマが確定済み(theme=${snap?.theme})`, snap?.theme === "dark");
  ok(`(1-e) 送信の瞬間、メニューバー・ステータスバーが描画済み(menubar=${snap?.menubarPresent}, statusbar=${snap?.statusbarPresent})`,
    snap?.menubarPresent === true && snap?.statusbarPresent === true);
  ok(`(1-f) 送信の瞬間、ステータスバーのモード表示に内容がある("${snap?.statusModeText}")`,
    !!snap?.statusModeText && snap.statusModeText.trim().length > 0);
  ok(`(1-g) 送信の瞬間、本文エリア(CodeMirror)がマウント済み(${snap?.cmEditorPresent})`,
    snap?.cmEditorPresent === true);

  // 以後のapply-settings再送(設定変更等)では再送しない
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light" }));
  await page.waitForTimeout(200);
  ok("(1-h) 以後のapply-settings再送では再送されない(1回のまま)",
    (await countType(page, "initial-render-ready")) === 1);

  ok(`(1-i) ページエラー・コンソールエラーが0件 (${errors.length}件)`, errors.length === 0);
  if (errors.length) console.log(errors.join("\n"));
  await page.close();
}

// ---- (2) 逆順(file-opened → apply-settings)でも正しく1回送られる ----
{
  const { page, errors } = await newPage();

  await page.evaluate(({ text }) => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md", text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { text: SAMPLE });
  await page.waitForTimeout(150);
  ok("(2-a) file-openedのみではまだ送らない(テーマ未確定)",
    (await countType(page, "initial-render-ready")) === 0);

  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light" }));
  await page.waitForTimeout(200);
  ok("(2-b) 逆順でもapply-settings到着後に1回送られる",
    (await countType(page, "initial-render-ready")) === 1);

  ok(`(2-c) ページエラー・コンソールエラーが0件 (${errors.length}件)`, errors.length === 0);
  if (errors.length) console.log(errors.join("\n"));
  await page.close();
}

// ---- (3) 新規文書(new-document)の経路でも送られる ----
{
  const { page, errors } = await newPage();

  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark" }));
  await page.evaluate(() => window.__reply({ type: "new-document", encoding: "UTF-8", lineEnding: "CRLF" }));
  await page.waitForTimeout(200);
  ok("(3-a) new-document経路でも1回送られる",
    (await countType(page, "initial-render-ready")) === 1);
  const snap = await snapshotFor(page, "initial-render-ready");
  ok(`(3-b) 送信の瞬間、本文エリアがマウント済み(${snap?.cmEditorPresent})`, snap?.cmEditorPresent === true);

  ok(`(3-c) ページエラー・コンソールエラーが0件 (${errors.length}件)`, errors.length === 0);
  if (errors.length) console.log(errors.join("\n"));
  await page.close();
}

// ---- (4) JS側フォールバックとの役割分担についての明示的な注記(実行はしない) ----
// C#側(Pane/MainForm.cs)のフォールバックタイマー(WebViewRevealFallbackMs=3000ms)は、
// WebView2自体が無いこの検証環境では動かせない。JS側が例外で停止した場合に
// 本当にC#側だけで表示へ復帰できるかは実機でのみ確認可能(報告に明記する)。
console.log("NOTE: C#側フォールバックタイマーの動作確認はこの環境では不可能(実機で確認が必要)");

await browser.close();
