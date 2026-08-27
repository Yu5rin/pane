// 「関連付けを今のPaneに更新」ボタンの検証スクリプト(ローカル検証用・コミット対象外)。
// ポート8202で配信中の dist/ (node scripts/build.js 済み)に対して実行する。
//
// 背景: Paneはインストーラ無しのポータブル配布のため、exeを新しい場所へ置き換えても
// 関連付けは登録時のフルパス(=古いexe)を指したままになる。実際にv1.0.0を掴んだまま
// v1.0.1を使っているつもりになる事故が起きたため、設定画面の「ファイルの関連付け」
// カテゴリに「現在の関連付け先」の表示と、今のPaneへ登録し直すボタンを足した。
//
// C#側(レジストリ読み書き)はこの環境では動かせないのでモックにし、ここでは
// JS側の「6状態の表示の出し分け」と「メッセージの送受信」を確認する。
import pw from "playwright";
const { chromium } = pw;

const browser = await chromium.launch();
const errors = [];
const results = [];
const record = (label, cond) => {
  results.push([label, !!cond]);
  console.log(`${cond ? "OK  " : "NG  "} ${label}`);
};

function attachErrors(p) {
  p.on("pageerror", (e) => errors.push(String(e.stack || e)));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
}

// C#側ブリッジのモック。postMessageされた内容をwindow.__sentへ溜め、
// window.__reply(data)でC#からの受信を模す(他の.verify-*.mjsと同じ作り)。
function installBridge() {
  const listeners = [];
  window.__sent = [];
  // ブラウザ標準のalertは使用禁止(docs/コンテキストメニュー仕様.md)。呼ばれたら記録して検出する。
  window.__alertCalled = false;
  window.alert = () => { window.__alertCalled = true; };
  window.chrome = {
    webview: {
      postMessage: (m) => { window.__sent.push(m); },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
}

const CURRENT_PATH = "C:\\work\\publish\\Pane.exe";
const OLD_PATH = "C:\\work\\release\\Pane-v1.0.0-win-x64\\Pane.exe";

// get-settings応答の雛形。fileAssociationTargetだけを差し替えて使う。
function settingsMessage(target) {
  return {
    type: "settings",
    theme: "light", editorFontSize: 15, editorFontFamily: "", startupBehavior: "blank",
    calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
    inlineMathEnabled: true, mathAutoNumberEnabled: false, strictMode: false,
    codeBlockLineNumbers: true, autoPairing: true, showWordCount: true,
    defaultCopyFormat: "markdown", preloadOnStartup: false,
    associatedExtensions: ["md", "txt"], keyBindings: {},
    defaultEncoding: "utf-8", defaultLineEnding: "crlf", displayMode: "window",
    lightTheme: "default", darkTheme: "default", customCssPath: "",
    tooltipDetail: "standard",
    fileAssociationTarget: target,
  };
}

const page = await browser.newPage();
attachErrors(page);
await page.addInitScript(installBridge);
await page.goto("http://localhost:8202/settings-window.html");
await page.waitForTimeout(700);

// 「ファイルの関連付け」カテゴリを開く。
async function showFileTypes(target) {
  await page.evaluate((msg) => window.__reply(msg), settingsMessage(target));
  await page.waitForTimeout(300);
  const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
  const idx = cats.findIndex((c) => c.includes("関連付け"));
  if (idx < 0) throw new Error("「関連付け」カテゴリが見つからない");
  await page.click(`.settings-nav-item >> nth=${idx}`);
  await page.waitForTimeout(250);
}

// 現在表示されている「現在の関連付け先」ブロックの情報を取り出す。
async function readAssocBlock() {
  return page.evaluate(() => {
    const el = document.querySelector("[data-assoc-status]");
    if (!el) return null;
    const btn = document.querySelector('[data-action="refresh-file-association"]');
    return {
      status: el.dataset.assocStatus,
      warn: el.classList.contains("ft-blocked-warn"),
      infoRow: el.classList.contains("settings-info-row"),
      text: el.textContent.replace(/\s+/g, " ").trim(),
      hasButton: !!btn,
      buttonLabel: btn ? btn.textContent.trim() : "",
      buttonTitle: btn ? btn.getAttribute("title") || "" : "",
      insideGroup: !!el.closest("[data-assoc-target]"),
    };
  });
}

// ==================================================================
// (a) 現在の関連付け先が6状態それぞれで表示される
// ==================================================================
{
  // --- older: 今回の主目的。古いバージョンを指している ---
  await showFileTypes({
    status: "older", path: OLD_PATH, currentPath: CURRENT_PATH,
    extensionCount: 2, registeredVersion: "1.0.0", currentVersion: "1.0.1",
  });
  let b = await readAssocBlock();
  record("(a1) older: 現在の関連付け先ブロックが表示される", b !== null && b.status === "older");
  record("(a1) older: 「現在の関連付け先」グループの中にある", b?.insideGroup === true);
  record("(a1) older: 注意を促す見た目(ft-blocked-warn)になる", b?.warn === true);
  record("(a1) older: 登録先のバージョン(v1.0.0)が出る", b?.text.includes("v1.0.0"));
  record("(a1) older: 今のバージョン(v1.0.1)も出る", b?.text.includes("v1.0.1"));
  record("(a1) older: 登録先のパスが出る", b?.text.includes(OLD_PATH));
  record("(a1) older: 今のexeのパスが出る", b?.text.includes(CURRENT_PATH));
  record("(a1) older: 「古い」と分かる文言になっている", b?.text.includes("古い"));
  record("(a1) older: 更新ボタンがある", b?.hasButton === true);
  record("(a1) older: ボタンの文言が「更新」", b?.buttonLabel.includes("更新"));
  record("(a1) older: ボタンに説明(ツールチップ)が付く", (b?.buttonTitle || "").length > 10);

  // --- same: 同じバージョン(パスが違っても騒がない) ---
  await showFileTypes({
    status: "same", path: CURRENT_PATH, currentPath: CURRENT_PATH,
    extensionCount: 2, registeredVersion: "1.0.1", currentVersion: "1.0.1",
  });
  b = await readAssocBlock();
  record("(a2) same: 状態がsameになる", b?.status === "same");
  record("(a2) same: 警告の見た目にはならない(1行表示)", b?.warn === false && b?.infoRow === true);
  record("(a2) same: 「この Pane が関連付けられています」と分かる", b?.text.includes("関連付けられています"));
  record("(a2) same: ボタンは押せる状態で存在する", b?.hasButton === true);

  // --- newer: 新しい版を指している(上書きすると使えなくなる) ---
  await showFileTypes({
    status: "newer", path: "C:\\work\\v2\\Pane.exe", currentPath: CURRENT_PATH,
    extensionCount: 2, registeredVersion: "1.1.0", currentVersion: "1.0.1",
  });
  b = await readAssocBlock();
  record("(a3) newer: 状態がnewerになる", b?.status === "newer");
  record("(a3) newer: 注意を促す見た目になる", b?.warn === true);
  record("(a3) newer: 「新しい」と分かる文言になっている", b?.text.includes("新しい"));
  record("(a3) newer: 上書きすると使われなくなる旨が書いてある", b?.text.includes("使われなくなります"));
  record("(a3) newer: 「更新」とは表現しない", !b?.text.includes("更新") && !b?.buttonLabel.includes("更新"));
  record("(a3) newer: ボタンの文言が「切り替える」", b?.buttonLabel.includes("切り替える"));

  // --- unknown: バージョンが読めない ---
  await showFileTypes({
    status: "unknown", path: OLD_PATH, currentPath: CURRENT_PATH,
    extensionCount: 1, registeredVersion: "", currentVersion: "1.0.1",
  });
  b = await readAssocBlock();
  record("(a4) unknown: 状態がunknownになる", b?.status === "unknown");
  record("(a4) unknown: 取得できなかった旨が出る", b?.text.includes("読み取れませんでした"));
  record("(a4) unknown: パスは表示される", b?.text.includes(OLD_PATH));
  record("(a4) unknown: ボタンは出る", b?.hasButton === true);

  // --- missing: 指す先のexeが無い ---
  await showFileTypes({
    status: "missing", path: OLD_PATH, currentPath: CURRENT_PATH,
    extensionCount: 2, registeredVersion: "", currentVersion: "1.0.1",
  });
  b = await readAssocBlock();
  record("(a5) missing: 状態がmissingになる", b?.status === "missing");
  record("(a5) missing: 壊れていることが分かる文言になる", b?.text.includes("見つかりません"));
  record("(a5) missing: 注意を促す見た目になる", b?.warn === true);
  record("(a5) missing: ボタンで直せることが示されている", b?.text.includes("登録し直します") && b?.hasButton === true);

  // --- none: 未登録 ---
  await showFileTypes({
    status: "none", path: "", currentPath: CURRENT_PATH,
    extensionCount: 0, registeredVersion: "", currentVersion: "1.0.1",
  });
  b = await readAssocBlock();
  record("(a6) none: 状態がnoneになる", b?.status === "none");
  record("(a6) none: 未登録である旨が出る", b?.text.includes("まだ登録されていません"));
  record("(a6) none: 警告の見た目にはならない", b?.warn === false);

  // 不正な値・欠落は「未登録」に倒す(C#側が古い形式で応答した場合の保険)。
  await showFileTypes(undefined);
  b = await readAssocBlock();
  record("(a7) fileAssociationTargetが無い応答でも壊れず未登録として表示する", b?.status === "none");
}

// ==================================================================
// (b) 設定画面を開いただけでは関連付けを書き換えない
// ==================================================================
{
  const sent = await page.evaluate(() => window.__sent.map((m) => m.type));
  record("(b) 表示しただけではsave-settingsを送らない", !sent.includes("save-settings"));
}

// ==================================================================
// (c) ボタンを押すとC#へメッセージが送られる
// ==================================================================
{
  await showFileTypes({
    status: "older", path: OLD_PATH, currentPath: CURRENT_PATH,
    extensionCount: 2, registeredVersion: "1.0.0", currentVersion: "1.0.1",
  });
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.click('[data-action="refresh-file-association"]');
  await page.waitForTimeout(200);

  const sent = await page.evaluate(() => window.__sent.slice());
  const msg = sent[sent.length - 1];
  record("(c) ボタンを押すとメッセージが1件送られる", sent.length === 1);
  record("(c) 既存のsave-settings経路を使う", msg?.type === "save-settings");
  record("(c) 通常の保存と区別するための目印が付く", msg?.reason === "refresh-file-association");
  record("(c) 現在チェックが入っている拡張子をまとめて送る",
    Array.isArray(msg?.settings?.associatedExtensions) &&
    msg.settings.associatedExtensions.slice().sort().join(",") === "md,txt");
  record("(c) 関連付け以外の設定は巻き込まない(部分更新)",
    msg && Object.keys(msg.settings).length === 1);

  const disabled = await page.$eval('[data-action="refresh-file-association"]', (b) => b.disabled);
  record("(c) 応答待ちの間はボタンが押せない(二重送信の防止)", disabled === true);

  // 連打しても2件目は送らない。
  await page.evaluate(() => {
    const b = document.querySelector('[data-action="refresh-file-association"]');
    b.disabled = false; // 見た目のdisabledを外しても送られないこと
    b.click();
  });
  await page.waitForTimeout(150);
  const sent2 = await page.evaluate(() => window.__sent.length);
  record("(c) 連打しても二重に送らない", sent2 === 1);
}

// ==================================================================
// (d) 成功の応答で表示が更新され、独自ダイアログで知らされる
// ==================================================================
{
  await page.evaluate((currentPath) => window.__reply({
    type: "save-settings-result",
    ok: true,
    error: null,
    blockedExtensions: [],
    reason: "refresh-file-association",
    fileAssociationTarget: {
      status: "same", path: currentPath, currentPath,
      extensionCount: 2, registeredVersion: "1.0.1", currentVersion: "1.0.1",
    },
  }), CURRENT_PATH);
  await page.waitForTimeout(300);

  const b = await readAssocBlock();
  record("(d) 更新後は「現在の関連付け先」の表示が更新される", b?.status === "same");
  record("(d) 更新後の表示に今のパスが出る", b?.text.includes(CURRENT_PATH));

  const dlg = await page.evaluate(() => {
    const overlay = document.querySelector(".pane-dialog-overlay");
    if (!overlay) return null;
    return {
      title: overlay.querySelector(".pane-dialog-title")?.textContent || "",
      message: overlay.querySelector(".pane-dialog-message")?.textContent || "",
      buttons: Array.from(overlay.querySelectorAll(".pane-dialog-btn")).map((x) => x.textContent.trim()),
    };
  });
  record("(d) 独自ダイアログ(paneAlert)で結果が知らされる", dlg !== null);
  record("(d) ブラウザ標準のalertは使っていない", await page.evaluate(() => window.__alertCalled !== true));
  record("(d) 更新した件数が伝わる", (dlg?.message || "").includes("2件"));
  record("(d) 登録し直した先(今のexe)が伝わる", (dlg?.message || "").includes(CURRENT_PATH));
  record("(d) 設定画面は閉じずに残る", await page.$(".settings-modal") !== null);

  // ダイアログを閉じる。
  await page.click(".pane-dialog-btn");
  await page.waitForTimeout(200);
  record("(d) OKでダイアログが閉じる", await page.$(".pane-dialog-overlay") === null);

  const btnEnabled = await page.$eval('[data-action="refresh-file-association"]', (x) => !x.disabled);
  record("(d) 応答後はボタンを再び押せる", btnEnabled === true);
}

// ==================================================================
// (e) 失敗の応答でもその旨が知らされる(握りつぶさない)
// ==================================================================
{
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.click('[data-action="refresh-file-association"]');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__reply({
    type: "save-settings-result",
    ok: false,
    error: "ファイルの関連付け設定を変更できませんでした。レジストリへの書き込みが拒否されました。",
    blockedExtensions: [],
    reason: "refresh-file-association",
    fileAssociationTarget: {
      status: "older", path: "C:\\work\\release\\Pane-v1.0.0-win-x64\\Pane.exe", currentPath: "C:\\work\\publish\\Pane.exe",
      extensionCount: 2, registeredVersion: "1.0.0", currentVersion: "1.0.1",
    },
  }));
  await page.waitForTimeout(300);

  const dlg = await page.evaluate(() => {
    const overlay = document.querySelector(".pane-dialog-overlay");
    if (!overlay) return null;
    return {
      title: overlay.querySelector(".pane-dialog-title")?.textContent || "",
      message: overlay.querySelector(".pane-dialog-message")?.textContent || "",
    };
  });
  record("(e) 失敗時も独自ダイアログで知らされる", dlg !== null);
  record("(e) 失敗であることが分かるタイトル", (dlg?.title || "").includes("できませんでした"));
  record("(e) C#側のエラー内容がそのまま伝わる", (dlg?.message || "").includes("レジストリへの書き込みが拒否されました"));
  const b = await readAssocBlock();
  record("(e) 失敗時は状態表示が更新されない(警告のまま残る)", b?.status === "older");
  await page.click(".pane-dialog-btn");
  await page.waitForTimeout(200);
}

// ==================================================================
// (f) 通常の「保存」ボタンの結果と混ざらない
// ==================================================================
{
  await showFileTypes({
    status: "older", path: OLD_PATH, currentPath: CURRENT_PATH,
    extensionCount: 2, registeredVersion: "1.0.0", currentVersion: "1.0.1",
  });
  // reasonの無いsave-settings-result(=通常の「保存」ボタンの結果)は従来どおりの経路を通り、
  // 関連付け更新用のダイアログも表示の差し替えも行わない。
  await page.evaluate((currentPath) => window.__reply({
    type: "save-settings-result", ok: true, error: null, blockedExtensions: [],
    fileAssociationTarget: {
      status: "same", path: currentPath, currentPath,
      extensionCount: 2, registeredVersion: "1.0.1", currentVersion: "1.0.1",
    },
  }), CURRENT_PATH);
  await page.waitForTimeout(300);
  record("(f) reason無しの応答では関連付けのダイアログを出さない", await page.$(".pane-dialog-overlay") === null);
  const b = await readAssocBlock();
  record("(f) reason無しの応答では「現在の関連付け先」を差し替えない", b?.status === "older");
}

record("JSのエラーが発生していない", errors.length === 0);
if (errors.length) console.log(errors.join("\n"));

await browser.close();

const ng = results.filter(([, c]) => !c);
console.log(`\n=== ${results.length}件中 OK=${results.length - ng.length} NG=${ng.length} ===`);
process.exit(ng.length ? 1 : 0);
