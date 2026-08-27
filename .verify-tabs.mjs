// タブ形式(仕様書 第2.10節 C-14・第3章「表示形式」、隠し設定)の検証スクリプト。
// ポートは8165。.verify-contextmenu.mjs / .verify-settingswindow.mjs と同じ流儀
// (WebView2ブリッジをモックし、window.__reply()でC#側からのメッセージを流し込む)。
//
// 構成:
//   (A) 既定(displayMode:"window")ではタブバーが存在しない
//   (B) apply-settingsでdisplayMode:"tab"にするとタブバーが出る
//   (C) 複数タブを開いて切り替えると、内容・カーソル位置・アンドゥ履歴がタブごとに保たれる
//   (D) 未保存のタブを閉じようとすると確認ダイアログが出る。キャンセルすると閉じない
//   (E) ドラッグで並べ替えできる
//   (F) 中クリックで閉じる
//   (G) タブの右クリックでopen-context-menuが送られ、期待する項目が入っている
//   (H) 設定画面(settings-window.html)にdisplayModeの切替UIが存在しない
//   (I) ページエラー・コンソールエラーが0件
import pw from "playwright";
const { chromium } = pw;

const PORT = 8165;
const BASE = `http://localhost:${PORT}/index.html`;
const SETTINGS_BASE = `http://localhost:${PORT}/settings-window.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

function installMockBridge() {
  const listeners = [];
  window.__sent = [];
  window.chrome = {
    webview: {
      postMessage: (m) => { window.__sent.push(m); },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
}

async function newBridgedPage(url = BASE) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(installMockBridge);
  await page.goto(url, { waitUntil: "load" });
  if (url === BASE) await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}

// apply-settingsは実際のC#側では常に「全項目を含む完全なオブジェクト」として送られるが、
// main.js側のハンドラは大半のフィールドを ?? デフォルト で扱うため、検証では最小限の
// キーだけを渡す(他の検証スクリプト .verify-colormenu.mjs と同じ流儀)。
async function applySettings(page, partial) {
  await page.evaluate((partial) => window.__reply({ type: "apply-settings", ...partial }), partial);
  await page.waitForTimeout(200);
}
function clearSent(page) { return page.evaluate(() => { window.__sent = []; }); }
async function lastMsg(page, type) {
  const arr = await page.evaluate((ty) => window.__sent.filter((m) => m.type === ty), type);
  return arr[arr.length - 1] ?? null;
}
async function docText(page) {
  return page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
}
function findItem(items, label) {
  for (const it of items ?? []) {
    if (it.label === label) return it;
    if (it.submenu) { const found = findItem(it.submenu, label); if (found) return found; }
  }
  return null;
}
async function tabTitles(page) {
  return page.$$eval(".tab-item .tab-item-name", (els) => els.map((e) => e.textContent));
}
async function tabCount(page) {
  return page.$$eval(".tab-item", (els) => els.length);
}

// ============================================================
// (A) 既定(displayMode:"window")ではタブバーが存在しない
// ============================================================
{
  const page = await newBridgedPage();
  const tabbar = await page.$("#tabbar");
  ok("(A) タブバー要素自体はDOMに存在する(hiddenで隠すだけの設計)", !!tabbar);
  const hidden = await page.$eval("#tabbar", (el) => el.hidden);
  ok("(A) 既定(apply-settings未受信)ではタブバーが非表示", hidden);

  // 既定のまま(displayMode未指定=window)でapply-settingsが届いても非表示のまま。
  await applySettings(page, { showStatusBar: true });
  const stillHidden = await page.$eval("#tabbar", (el) => el.hidden);
  ok("(A) apply-settings(displayMode省略)でもタブバーは非表示のまま", stillHidden);

  // ウィンドウ形式のときはFile>新しいタブが無効(grayed)であることも併せて確認する
  // (commands.js側の実装確認)。ブリッジがある環境ではメニューはHTMLではなくネイティブ
  // ポップアップ経由(open-menu送信)になるため、送られたitemsのenabledを見る。
  await clearSent(page);
  await page.click("text=ファイル");
  await page.waitForTimeout(150);
  const openMenuMsg = await lastMsg(page, "open-menu");
  const newTabItem = findItem(openMenuMsg?.items, "新しいタブ");
  ok("(A) ウィンドウ形式では「新しいタブ」メニュー項目が無効(enabled:false)", newTabItem?.enabled === false);
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "File" }));
  await page.close();
}

// ============================================================
// (B)〜(G) displayMode:"tab" を有効にしてタブ機能全般を検証
// ============================================================
const page = await newBridgedPage();
await applySettings(page, { displayMode: "tab" });

// (B) タブバーが表示される
{
  const hidden = await page.$eval("#tabbar", (el) => el.hidden);
  ok("(B) displayMode:tab でタブバーが表示される", !hidden);
  const count = await tabCount(page);
  ok(`(B) 有効化した時点で現在の文書(無題)が最初のタブになる(タブ数=${count})`, count === 1);
  const titles = await tabTitles(page);
  ok(`(B) 最初のタブの名前が「無題」 (${JSON.stringify(titles)})`, titles[0] === "無題");
  const active = await page.$eval(".tab-item", (el) => el.classList.contains("active"));
  ok("(B) 最初のタブがアクティブ表示", active);
}

// (B') File > 新しいタブが有効になっている
{
  await clearSent(page);
  await page.click("text=ファイル");
  await page.waitForTimeout(150);
  const openMenuMsg = await lastMsg(page, "open-menu");
  const newTabItem = findItem(openMenuMsg?.items, "新しいタブ");
  ok("(B') タブ形式では「新しいタブ」メニュー項目が有効", newTabItem?.enabled === true);
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "File" }));
}

// ============================================================
// (C) 複数タブを開いて切り替えると、内容・カーソル位置・アンドゥ履歴がタブごとに保たれる
// ============================================================
{
  // タブ1へ入力する
  await page.click(".cm-content");
  await page.keyboard.type("Hello");
  await page.waitForTimeout(150);
  ok("(C-前提) タブ1に入力した内容が反映される", (await docText(page)) === "Hello");

  // カーソルを"He|llo"(2文字目の後ろ)に置く
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");

  // 新しいタブを追加する("+"ボタン)
  await page.click("#tabbar-new");
  await page.waitForTimeout(200);
  ok(`(C) 「+」で新しいタブが増える(タブ数=${await tabCount(page)})`, (await tabCount(page)) === 2);
  ok("(C) 新しいタブは空文書から始まる", (await docText(page)) === "");

  // タブ2へ入力する
  await page.click(".cm-content");
  await page.keyboard.type("World");
  await page.waitForTimeout(150);
  ok("(C) タブ2への入力がタブ2の内容になる", (await docText(page)) === "World");

  // タブ1へ戻る
  const tab1 = page.locator(".tab-item").nth(0);
  await tab1.click();
  await page.waitForTimeout(200);
  ok("(C) タブ1へ切り替えると内容が保たれている(Hello)", (await docText(page)) === "Hello");

  // カーソル位置が保持されている(2文字目の後ろに入力すると"HeXllo"になるはず)
  await page.keyboard.type("X");
  await page.waitForTimeout(150);
  ok(`(C) タブ1のカーソル位置が保たれている(内容=${JSON.stringify(await docText(page))})`, (await docText(page)) === "HeXllo");

  // アンドゥ履歴がタブごとに分離されている: タブ1でCtrl+Zすると直前の"X"入力だけが
  // 取り消され、"Hello"に戻る(タブ2の編集の影響を受けない)。
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  ok(`(C) タブ1でCtrl+Zすると"Hello"に戻る(アンドゥ履歴がタブ固有、内容=${JSON.stringify(await docText(page))})`, (await docText(page)) === "Hello");

  // タブ2に切り替え、アンドゥ履歴・内容がタブ1の操作の影響を受けていないことを確認。
  const tab2 = page.locator(".tab-item").nth(1);
  await tab2.click();
  await page.waitForTimeout(200);
  ok("(C) タブ2の内容もタブ1の操作の影響を受けない(World)", (await docText(page)) === "World");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  ok(`(C) タブ2独自のアンドゥ履歴で"World"入力が取り消される(内容=${JSON.stringify(await docText(page))})`, (await docText(page)) === "");

  // 以降のセクションでも使うため、redoでタブ2の内容を"World"に戻しておく。
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(150);
  ok(`(C-後始末) redoでタブ2の内容が"World"に戻る(内容=${JSON.stringify(await docText(page))})`, (await docText(page)) === "World");

  // タブ1へ戻り、続きの検証(D以降)のため未保存内容を"Hello"のまま保つ。
  await tab1.click();
  await page.waitForTimeout(150);
}

// ============================================================
// (D) 未保存のタブを閉じようとすると確認ダイアログが出る。キャンセルすると閉じない
// ============================================================
{
  const beforeCount = await tabCount(page);
  // タブ1(Hello、未保存)の×ボタンをクリック
  const closeBtn = page.locator(".tab-item").nth(0).locator(".tab-item-close");
  await closeBtn.click();
  await page.waitForTimeout(200);
  const dialog = await page.$(".pane-dialog-overlay");
  ok("(D) 未保存タブを閉じようとすると確認ダイアログが出る(paneConfirm、ブラウザ標準は不使用)", !!dialog);
  const msg = await page.$eval(".pane-dialog-message", (el) => el.textContent).catch(() => "");
  ok(`(D) ダイアログにファイル名が含まれる (${JSON.stringify(msg)})`, msg.includes("無題"));

  // キャンセル
  await page.click(".pane-dialog-btn:not(.pane-dialog-btn-danger):not(.pane-dialog-btn-primary)");
  await page.waitForTimeout(200);
  ok("(D) キャンセルするとタブは閉じない", (await tabCount(page)) === beforeCount);
  ok("(D) キャンセル後も内容は保たれている", (await docText(page)) === "Hello");

  // 再度閉じて、今度は「閉じる」を選ぶ
  await closeBtn.click();
  await page.waitForTimeout(200);
  await page.click(".pane-dialog-btn-danger");
  await page.waitForTimeout(200);
  ok(`(D) 「閉じる」を選ぶとタブが閉じる(タブ数=${await tabCount(page)})`, (await tabCount(page)) === beforeCount - 1);
}

// ============================================================
// (E) ドラッグで並べ替えできる
// ============================================================
{
  // 現状1タブ("World")のみのため、まず2枚追加して3枚(World, Second, Third)にする。
  await page.click("#tabbar-new");
  await page.waitForTimeout(150);
  await page.click(".cm-content");
  await page.keyboard.type("Second");
  await page.waitForTimeout(100);

  await page.click("#tabbar-new");
  await page.waitForTimeout(150);
  await page.click(".cm-content");
  await page.keyboard.type("Third");
  await page.waitForTimeout(100);

  const before = await tabTitles(page); // ["無題", "無題", "無題"](名前は全部「無題」のため、内容で判別する)
  ok(`(E-前提) 3枚のタブがある(${JSON.stringify(before)})`, before.length === 3);

  // 先頭(World)を末尾(Third)へドラッグする。
  const first = page.locator(".tab-item").nth(0);
  const last = page.locator(".tab-item").nth(2);
  await first.dragTo(last);
  await page.waitForTimeout(250);

  // 並べ替え後、先頭タブをクリックして内容を確認する(先頭が"Second"になっているはず)。
  await page.locator(".tab-item").nth(0).click();
  await page.waitForTimeout(150);
  const firstNowText = await docText(page);
  ok(`(E) ドラッグで並べ替えると先頭タブの内容が変わる(先頭=${JSON.stringify(firstNowText)})`, firstNowText === "Second");

  await page.locator(".tab-item").nth(2).click();
  await page.waitForTimeout(150);
  const lastNowText = await docText(page);
  ok(`(E) ドラッグしたタブ("World")が末尾に移動している(末尾=${JSON.stringify(lastNowText)})`, lastNowText === "World");
}

// ============================================================
// (F) 中クリックで閉じる
// ============================================================
{
  const beforeCount = await tabCount(page);
  // 末尾タブ("World")は未保存内容が無い(保存確認が発生しないよう、空の新規タブで試す)。
  await page.click("#tabbar-new");
  await page.waitForTimeout(150);
  const afterNewCount = await tabCount(page);
  ok(`(F-前提) 新しいタブを追加(タブ数=${afterNewCount})`, afterNewCount === beforeCount + 1);

  const newTab = page.locator(".tab-item").last();
  await newTab.click({ button: "middle" });
  await page.waitForTimeout(200);
  ok(`(F) 中クリックでタブが閉じる(タブ数=${await tabCount(page)})`, (await tabCount(page)) === beforeCount);
}

// ============================================================
// (G) タブの右クリックでopen-context-menuが送られ、期待する項目が入っている
// ============================================================
{
  await clearSent(page);
  const tab = page.locator(".tab-item").nth(0);
  await tab.click({ button: "right" });
  await page.waitForTimeout(200);
  const msg = await lastMsg(page, "open-context-menu");
  ok("(G) タブの右クリックでopen-context-menuが送られる", !!msg);
  ok("(G) 「閉じる」項目がある", !!findItem(msg?.items, "閉じる"));
  ok("(G) 「他のタブを閉じる」項目がある", !!findItem(msg?.items, "他のタブを閉じる"));
  ok("(G) 「右側のタブを閉じる」項目がある", !!findItem(msg?.items, "右側のタブを閉じる"));
  ok("(G) 「フルパスをコピー」項目がある", !!findItem(msg?.items, "フルパスをコピー"));
  ok("(G) 「エクスプローラーで表示」項目がある", !!findItem(msg?.items, "エクスプローラーで表示"));
  // 無題タブ(パス無し)なので、フルパスをコピー・エクスプローラーで表示は無効のはず。
  ok("(G) 無題タブでは「フルパスをコピー」が無効", findItem(msg?.items, "フルパスをコピー")?.enabled === false);
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));
}

await page.close();

// ============================================================
// (H) 設定画面(settings-window.html)にdisplayModeの切替UIが存在しない
// ============================================================
{
  const spage = await newBridgedPage(SETTINGS_BASE);
  await spage.evaluate(() => window.__reply({
    type: "settings",
    startupBehavior: "blank", displayMode: "window",
    installedFonts: [], monospaceFonts: [], pandocAvailable: false,
    settingsFilePath: "C:\\Users\\test\\AppData\\Local\\Pane\\settings.json",
  }));
  await spage.waitForTimeout(300);
  // 「一般」カテゴリ(既定で開いている)にdisplayModeのラジオボタンが存在しないことを確認。
  const hasDisplayModeRadio = await spage.evaluate(() => !!document.querySelector('input[name="displayMode"]'));
  ok("(H) 設定画面にdisplayModeの切替UI(ラジオボタン)が存在しない", !hasDisplayModeRadio);
  const hasTabWord = await spage.evaluate(() => document.body.textContent.includes("タブ形式"));
  ok('(H) 設定画面の文言に「タブ形式」という語も出てこない', !hasTabWord);
  await spage.close();
}

// ============================================================
// (I) ページエラー・コンソールエラーが0件
// ============================================================
ok(`(I) ページエラー0件 (${allErrors.length}件)`, allErrors.length === 0);
if (allErrors.length) console.log(allErrors.slice(0, 5).join("\n---\n"));
ok(`(I) コンソールエラー0件 (${allConsoleErrors.length}件)`, allConsoleErrors.length === 0);
if (allConsoleErrors.length) console.log(allConsoleErrors.slice(0, 10).join("\n---\n"));

await browser.close();
console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
process.exit(ngCount === 0 ? 0 : 1);
