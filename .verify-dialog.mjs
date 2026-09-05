// 独自ダイアログ(src/dialog.js: paneConfirm / paneAlert / paneInput)の検証スクリプト。
// window.confirm / window.prompt / window.alert を全廃した置き換えの検証。ポートは8164。
// .verify-contextmenu.mjs / .verify-mainsettings.mjs と同じ流儀(WebView2ブリッジをモックし、
// window.__reply() でホストメッセージを流し込む/window.__sent でpostMessageを検証する)。
//
// 構成:
//   (A) 確認ダイアログ(paneConfirm): OK/キャンセルで後続処理が走る/走らないこと(新規作成)
//   (B) 入力ダイアログ(paneInput): Enter確定・Escapeキャンセルが効くこと(指定行へジャンプ)
//   (C) オーバーレイクリックでキャンセルになること
//   (D) validateがエラーを返す間はOKが無効になること
//   (E) フォーカストラップ(Tabでダイアログの外へ出ない)
//   (F) 「保存せずに閉じる」でキャンセルしたときに閉じないこと(閉じるときの確認)
//   (G) ライト/ダーク両方でコントラストが確保されていること
//   (H) 名前の変更・削除・新規ファイル名(サイドバー、ブリッジ経由のネイティブメニュー)
//   (I) ページエラー・コンソールエラーが0件であること
import pw from "playwright";
const { chromium } = pw;

const PORT = 8164;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

async function newPlainPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(() => {
    window.__closeCalled = false;
    window.close = () => { window.__closeCalled = true; }; // 実際にタブが閉じるのを防ぐモック
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
}

async function newBridgedPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.chrome = {
      webview: {
        postMessage: (m) => { window.__sent.push(m); },
        addEventListener: (_t, fn) => listeners.push(fn),
      },
    };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
}

function docText(page) {
  return page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
}
function clearSent(page) { return page.evaluate(() => { window.__sent = []; }); }
async function lastMsg(page, type) {
  const arr = await page.evaluate((ty) => window.__sent.filter((m) => m.type === ty), type);
  return arr[arr.length - 1] ?? null;
}
function curLine(page) {
  return page.evaluate(() => {
    const view = window.__paneDebugEditor.view;
    return view.state.doc.lineAt(view.state.selection.main.head).number;
  });
}
function dialogVisible(page) { return page.$(".pane-dialog-overlay"); }

// ============================================================
// (A) 確認ダイアログ(paneConfirm): 新規作成(main.js: newDocument)
// ============================================================
{
  const page = await newPlainPage();
  await page.locator(".cm-content").click();
  await page.keyboard.type("編集された内容です");
  await page.waitForTimeout(150);
  ok("(A) 事前: 入力後に本文へ反映されている", (await docText(page)).includes("編集された内容です"));

  // ---- キャンセル: 内容は失われない ----
  await page.evaluate(() => { window.__paneDebugCtx.actions.newDocument(); });
  await page.waitForTimeout(200);
  const box1 = await dialogVisible(page);
  ok("(A) 新規作成: 確認ダイアログが表示される", box1 !== null);
  ok("(A) 確認ダイアログのタイトルが表示される", (await page.textContent(".pane-dialog-title")) === "新規文書を開きますか?");
  await page.locator(".pane-dialog-btn").filter({ hasText: "キャンセル" }).click();
  await page.waitForTimeout(150);
  ok("(A) キャンセルでダイアログが閉じる", (await dialogVisible(page)) === null);
  ok("(A) キャンセルすると本文が失われない", (await docText(page)).includes("編集された内容です"));

  // ---- OK: 新規文書になる(内容が失われる) ----
  await page.evaluate(() => { window.__paneDebugCtx.actions.newDocument(); });
  await page.waitForTimeout(200);
  ok("(A) 再度ダイアログが表示される", (await dialogVisible(page)) !== null);
  await page.locator(".pane-dialog-btn").filter({ hasText: "開く" }).click();
  await page.waitForTimeout(200);
  ok("(A) OKで本文が新規(空)になる", (await docText(page)).trim() === "");
  await page.close();
}

// ============================================================
// (B) 入力ダイアログ(paneInput): 指定行へジャンプ(main.js: gotoLineFlow)
//     Enterで確定・Escapeでキャンセルが効くことを確認する
// ============================================================
{
  const page = await newPlainPage();
  await page.evaluate(() => { window.__paneDebugEditor.setValue("1行目\n2行目\n3行目\n4行目\n5行目"); });
  await page.waitForTimeout(150);

  // ---- Escapeでキャンセル: カーソル位置は変わらない ----
  const before = await curLine(page);
  await page.evaluate(() => { window.__paneDebugCtx.actions.gotoLineFlow(); });
  await page.waitForTimeout(200);
  ok("(B) 指定行へジャンプ: 入力ダイアログが表示される", (await dialogVisible(page)) !== null);
  ok("(B) 入力欄に既定でフォーカスが当たる", await page.evaluate(() => document.activeElement.classList.contains("pane-dialog-input")));
  await page.keyboard.type("3");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  ok("(B) Escapeでダイアログが閉じる", (await dialogVisible(page)) === null);
  ok("(B) Escapeキャンセルではジャンプしない", (await curLine(page)) === before);

  // ---- Enterで確定: 指定行へジャンプする ----
  await page.evaluate(() => { window.__paneDebugCtx.actions.gotoLineFlow(); });
  await page.waitForTimeout(200);
  await page.keyboard.type("4");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  ok("(B) Enterでダイアログが閉じる", (await dialogVisible(page)) === null);
  ok("(B) Enter確定で指定行(4行目)へジャンプする", (await curLine(page)) === 4);
  await page.close();
}

// ============================================================
// (C) オーバーレイクリックでキャンセルになること
// ============================================================
{
  const page = await newPlainPage();
  await page.evaluate(() => { window.__paneDebugEditor.setValue("1行目\n2行目\n3行目"); });
  await page.waitForTimeout(150);
  const before = await curLine(page);
  await page.evaluate(() => { window.__paneDebugCtx.actions.gotoLineFlow(); });
  await page.waitForTimeout(200);
  ok("(C) ダイアログが表示される", (await dialogVisible(page)) !== null);
  // オーバーレイの隅(ボックスの外)をクリックする。
  await page.mouse.click(5, 5);
  await page.waitForTimeout(150);
  ok("(C) オーバーレイクリックでダイアログが閉じる", (await dialogVisible(page)) === null);
  ok("(C) オーバーレイクリックはキャンセル扱い(ジャンプしない)", (await curLine(page)) === before);
  await page.close();
}

// ============================================================
// (D) validateがエラーを返す間はOKが無効になること
// ============================================================
{
  const page = await newPlainPage();
  await page.evaluate(() => { window.__paneDebugEditor.setValue("1行目\n2行目\n3行目"); }); // 3行
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__paneDebugCtx.actions.gotoLineFlow(); });
  await page.waitForTimeout(200);
  const okBtn = () => page.locator(".pane-dialog-btn").filter({ hasText: "移動" });

  await page.keyboard.type("999"); // 範囲外
  await page.waitForTimeout(100);
  ok("(D) 範囲外の入力ではエラーメッセージが表示される", (await page.textContent(".pane-dialog-error")) !== "");
  ok("(D) 範囲外の入力ではOKボタンが無効になる", await okBtn().isDisabled());
  await page.keyboard.press("Enter"); // OK無効中はEnterでも確定しない
  await page.waitForTimeout(150);
  ok("(D) OK無効中はEnterでも確定しない(ダイアログが残る)", (await dialogVisible(page)) !== null);

  await page.keyboard.press("Control+a");
  await page.keyboard.type("2"); // 範囲内
  await page.waitForTimeout(100);
  ok("(D) 正しい入力に直すとエラーが消える", await page.locator(".pane-dialog-error").isHidden());
  ok("(D) 正しい入力に直すとOKボタンが有効になる", !(await okBtn().isDisabled()));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  ok("(D) 有効化後はEnterで確定できる", (await dialogVisible(page)) === null);
  ok("(D) 実際に2行目へジャンプしている", (await curLine(page)) === 2);
  await page.close();
}

// ============================================================
// (E) フォーカストラップ(Tabでダイアログの外へ出ない)
// ============================================================
{
  const page = await newPlainPage();
  await page.evaluate(() => { window.__paneDebugEditor.setValue("1行目\n2行目\n3行目"); });
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__paneDebugCtx.actions.gotoLineFlow(); });
  await page.waitForTimeout(200);

  const activeClass = () => page.evaluate(() => document.activeElement.className);
  ok("(E) 初期フォーカスは入力欄", (await activeClass()).includes("pane-dialog-input"));
  await page.keyboard.press("Tab");
  ok("(E) Tabでキャンセルボタンへ", (await activeClass()).includes("pane-dialog-btn") && !(await activeClass()).includes("primary"));
  await page.keyboard.press("Tab");
  ok("(E) TabでOKボタンへ", (await activeClass()).includes("pane-dialog-btn-primary"));
  await page.keyboard.press("Tab");
  ok("(E) Tabでループして入力欄に戻る(外へ出ない)", (await activeClass()).includes("pane-dialog-input"));
  await page.keyboard.press("Shift+Tab");
  ok("(E) Shift+TabでOKボタンへ(逆向きにもループする)", (await activeClass()).includes("pane-dialog-btn-primary"));
  // ダイアログの外にあるはずの要素(サイドバーのボタン等)へフォーカスが漏れていないか最終確認。
  const outside = await page.evaluate(() => !document.querySelector(".pane-dialog-box").contains(document.activeElement));
  ok("(E) フォーカスはダイアログ内に留まっている", !outside);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.close();
}

// ============================================================
// (F) 「保存せずに閉じる」でキャンセルしたときに閉じないこと(main.js: closeWindow)
// ============================================================
{
  const page = await newPlainPage();
  await page.locator(".cm-content").click();
  await page.keyboard.type("保存していない変更");
  await page.waitForTimeout(150);

  // ---- キャンセル: window.close()が呼ばれない ----
  await page.evaluate(() => { window.__paneDebugCtx.actions.closeWindow(); });
  await page.waitForTimeout(200);
  ok("(F) 閉じる確認ダイアログが表示される", (await dialogVisible(page)) !== null);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  ok("(F) キャンセルではwindow.closeが呼ばれない", (await page.evaluate(() => window.__closeCalled)) === false);
  ok("(F) キャンセル後も本文が残っている(閉じていない)", (await docText(page)).includes("保存していない変更"));

  // ---- OK: window.close()が呼ばれる ----
  await page.evaluate(() => { window.__paneDebugCtx.actions.closeWindow(); });
  await page.waitForTimeout(200);
  await page.locator(".pane-dialog-btn").filter({ hasText: "閉じる" }).click();
  await page.waitForTimeout(150);
  ok("(F) OKではwindow.closeが呼ばれる", (await page.evaluate(() => window.__closeCalled)) === true);
  await page.close();
}

// ============================================================
// (G) ライト/ダーク両方でコントラストが確保されていること
// ============================================================
{
  const page = await newPlainPage();
  await page.evaluate(() => { window.__paneDebugCtx.actions.gotoLineFlow(); });
  await page.waitForTimeout(200);

  async function contrastInfo() {
    return page.evaluate(() => {
      const box = document.querySelector(".pane-dialog-box");
      const title = document.querySelector(".pane-dialog-title");
      const okBtn = document.querySelector(".pane-dialog-btn-primary");
      return {
        boxBg: getComputedStyle(box).backgroundColor,
        titleColor: getComputedStyle(title).color,
        okBg: getComputedStyle(okBtn).backgroundColor,
        okColor: getComputedStyle(okBtn).color,
      };
    });
  }
  const light = await contrastInfo();
  ok(`(G) ライト: ボックス背景と文字色が異なる ${JSON.stringify(light)}`, light.boxBg !== light.titleColor);
  ok(`(G) ライト: OKボタンの背景と文字色が異なる`, light.okBg !== light.okColor);

  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.waitForTimeout(150);
  const dark = await contrastInfo();
  ok(`(G) ダーク: ボックス背景と文字色が異なる ${JSON.stringify(dark)}`, dark.boxBg !== dark.titleColor);
  ok(`(G) ダーク: OKボタンの背景と文字色が異なる`, dark.okBg !== dark.okColor);
  ok("(G) ダークとライトでボックス背景が切り替わっている(テーマトークンを使っている)", dark.boxBg !== light.boxBg);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.close();
}

// ============================================================
// (H) サイドバー(sidebar.js): 名前の変更・削除・新規ファイル名
//     ブリッジ経由のネイティブメニュー(open-context-menu → menu-command)を通す。
// ============================================================
{
  const page = await newBridgedPage();
  await page.evaluate(() => {
    window.__reply({
      type: "folder-loaded",
      root: "C:\\work",
      entries: [
        { path: "C:\\work\\note.md", relativePath: "note.md", name: "note.md", isDirectory: false },
        { path: "C:\\work\\sub", relativePath: "sub", name: "sub", isDirectory: true },
      ],
      truncated: false,
    });
  });
  await page.waitForTimeout(300);
  // フォルダ読み込み成功時、サイドバーは自動で開いてファイルツリータブへ切り替わる
  // (ユーザー要望3、src/main.jsのfolder-loadedハンドラ参照)ため、既に開いている。
  // #status-sidebarをクリックすると逆に閉じてしまうため呼ばない。
  await page.locator('.sidebar-tab[data-panel="files"]').click();
  await page.waitForTimeout(200);

  function findItem(items, label) {
    for (const it of items ?? []) {
      if (it.label === label) return it;
      if (it.submenu) { const f = findItem(it.submenu, label); if (f) return f; }
    }
    return null;
  }

  // ---- 名前の変更…: 入力ダイアログ ----
  await clearSent(page);
  await page.locator(".file-item", { hasText: "note.md" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  let menu = await lastMsg(page, "open-context-menu");
  const renameItem = findItem(menu?.items, "名前の変更…");
  ok("(H) ファイル行: 「名前の変更…」がある", !!renameItem);
  await clearSent(page);
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), renameItem.id);
  await page.waitForTimeout(200);
  ok("(H) 名前の変更: 入力ダイアログが表示される", (await dialogVisible(page)) !== null);
  ok("(H) 入力欄に既存の名前が入っている", (await page.inputValue(".pane-dialog-input")) === "note.md");
  await page.fill(".pane-dialog-input", "renamed.md");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const renameMsg = await lastMsg(page, "rename-path");
  ok(`(H) OKでrename-pathが送信される ${JSON.stringify(renameMsg)}`, renameMsg?.newName === "renamed.md" && renameMsg?.path === "C:\\work\\note.md");

  // 名前の変更…キャンセルでは送信されない
  await clearSent(page);
  await page.locator(".file-item", { hasText: "note.md" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  menu = await lastMsg(page, "open-context-menu");
  const renameItem2 = findItem(menu?.items, "名前の変更…");
  await clearSent(page);
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), renameItem2.id);
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  ok("(H) 名前の変更をキャンセルするとrename-pathは送信されない", (await lastMsg(page, "rename-path")) === null);

  // ---- ごみ箱へ移動: 確認ダイアログ(danger) ----
  await clearSent(page);
  await page.locator(".file-item", { hasText: "note.md" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  menu = await lastMsg(page, "open-context-menu");
  const deleteItem = findItem(menu?.items, "ごみ箱へ移動");
  ok("(H) ファイル行: 「ごみ箱へ移動」がある", !!deleteItem);
  await clearSent(page);
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), deleteItem.id);
  await page.waitForTimeout(200);
  ok("(H) 削除: 確認ダイアログが表示される", (await dialogVisible(page)) !== null);
  ok("(H) 削除ボタンが警告色(danger)クラスを持つ", await page.locator(".pane-dialog-btn-danger").isVisible());
  // キャンセル: delete-pathは送られない
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  ok("(H) 削除キャンセルではdelete-pathが送信されない", (await lastMsg(page, "delete-path")) === null);
  // 再度開いてOK: delete-pathが送られる
  await page.locator(".file-item", { hasText: "note.md" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  menu = await lastMsg(page, "open-context-menu");
  const deleteItem2 = findItem(menu?.items, "ごみ箱へ移動");
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), deleteItem2.id);
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const deleteMsg = await lastMsg(page, "delete-path");
  ok(`(H) OKでdelete-pathが送信される ${JSON.stringify(deleteMsg)}`, deleteMsg?.path === "C:\\work\\note.md");

  // ---- ここに新しいファイルを作成…: 入力ダイアログ(フォルダ行) ----
  await page.locator('.sidebar-tab[data-panel="tree"]').click();
  await page.waitForTimeout(200);
  await clearSent(page);
  await page.locator(".tree-item-folder", { hasText: "sub" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  menu = await lastMsg(page, "open-context-menu");
  const createItem = findItem(menu?.items, "ここに新しいファイルを作成…");
  ok("(H) フォルダ行: 「ここに新しいファイルを作成…」がある", !!createItem);
  await clearSent(page);
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), createItem.id);
  await page.waitForTimeout(200);
  ok("(H) 新規ファイル作成: 入力ダイアログが表示される", (await dialogVisible(page)) !== null);
  await page.keyboard.type("memo.md");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const createMsg = await lastMsg(page, "create-file-in-folder");
  ok(`(H) OKでcreate-file-in-folderが送信される ${JSON.stringify(createMsg)}`, createMsg?.name === "memo.md" && createMsg?.dirPath === "C:\\work\\sub");

  await page.close();
}

// ============================================================
// (I) ページエラー・コンソールエラー0件
// ============================================================
const unexpectedConsoleErrors = allConsoleErrors.filter((m) => !/Failed to load resource/.test(m));
ok(`(I) ページエラー0件 ${JSON.stringify(allErrors)}`, allErrors.length === 0);
ok(`(I) コンソールエラー0件 ${JSON.stringify(unexpectedConsoleErrors)}`, unexpectedConsoleErrors.length === 0);

console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
