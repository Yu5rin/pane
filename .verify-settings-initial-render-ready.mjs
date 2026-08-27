// 設定ウィンドウ(Pane/SettingsWindow.cs)側の、起動時の白フラッシュ対策(新方式)の検証。
// src/settings-entry.jsが"initial-render-ready"を送るタイミングと条件を確認する。
// .verify-settingswindow.mjsと同じ流儀(window.chrome.webviewのモック)を使う。
//
// C#側(Pane/SettingsWindow.cs RevealWebView)のフォールバックタイマーはJS側からは検証できない。
// これはメインウィンドウ側(.verify-initial-render-ready.mjs)と同じ制約であり、
// 実機での確認が必要(報告に明記する)。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

function installMockBridge() {
  const listeners = [];
  window.__sent = [];
  window.__snapshots = [];
  window.chrome = {
    webview: {
      postMessage: (m) => {
        window.__sent.push(m);
        window.__snapshots.push({
          type: m.type,
          theme: document.documentElement.dataset.theme || null,
          // 設定画面の本体(カテゴリナビ・設定項目)が実際に描画されているか
          navPresent: !!document.querySelector(".settings-nav, .settings-modal"),
          categoryCount: document.querySelectorAll(".settings-nav-item, .settings-category").length,
        });
      },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
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

const MINIMAL_SETTINGS = { type: "settings", theme: "dark", lightTheme: "default", darkTheme: "default" };

const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.addInitScript(installMockBridge);
await page.goto("http://localhost:8153/settings-window.html");
await page.waitForTimeout(500);

// settingsUI.open()が読み込み直後にget-settingsを自動送信する(src/settings-entry.js末尾)。
ok("(a) 起動直後にget-settingsを送信", (await countType(page, "get-settings")) === 1);
ok("(b) settings応答が届く前はinitial-render-readyを送っていない",
  (await countType(page, "initial-render-ready")) === 0);

// C#役として"settings"応答を返す(get-settingsへの応答、実際の設定値)。
await page.evaluate((msg) => window.__reply(msg), MINIMAL_SETTINGS);
await page.waitForTimeout(200);

ok("(c) settings応答後にinitial-render-readyが1回送られる",
  (await countType(page, "initial-render-ready")) === 1);

const snap = await snapshotFor(page, "initial-render-ready");
ok(`(d) 送信の瞬間、テーマが確定済み(theme=${snap?.theme})`, snap?.theme === "dark");
ok(`(e) 送信の瞬間、設定画面の本体が描画済み(navPresent=${snap?.navPresent}, categoryCount=${snap?.categoryCount})`,
  snap?.navPresent === true && snap?.categoryCount > 0);

// 何らかの理由でsettingsが再送されても(例: 設定リセット後の再読み込み)、二重送信しない。
await page.evaluate((msg) => window.__reply(msg), MINIMAL_SETTINGS);
await page.waitForTimeout(200);
ok("(f) settings再送では再送されない(1回のまま)",
  (await countType(page, "initial-render-ready")) === 1);

ok(`(g) ページエラー・コンソールエラーが0件 (${errors.length}件)`, errors.length === 0);
if (errors.length) console.log(errors.join("\n"));

console.log("NOTE: C#側フォールバックタイマーの動作確認はこの環境では不可能(実機で確認が必要)");

await browser.close();
