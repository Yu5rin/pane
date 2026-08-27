// ネイティブメニュー(Pane/NativeMenu.cs)への切替に伴う、JS側の送受信の検証。
// C#側の実際の描画(WinFormsのToolStripDropDownMenu)はLinux上のこのコンテナでは確認できないため、
// ここでは src/commands.js / src/main.js が「ブリッジがあるときだけopen-menuを送り、HTMLの
// ドロップダウンを作らない」「menu-command/menu-closedを正しく処理する」ことだけを検証する。
// ポートは8154。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const errors = [];
const consoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

async function newBridgedPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  // .verify-bridge.mjsと同じモック手順(ブリッジのpostMessageを記録し、C#役として応答する)。
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
  await page.goto("http://localhost:8154/index.html");
  await page.waitForTimeout(800);
  return page;
}

function lastOpenMenu(sent, menuName) {
  const matches = sent.filter((m) => m.type === "open-menu" && m.menu === menuName);
  return matches[matches.length - 1] ?? null;
}

// ============================================================
// (a)(b)(c)(d) ブリッジあり: ネイティブ経路
// ============================================================
{
  const page = await newBridgedPage();

  // (c)の準備: 全画面表示中の状態をC#役から通知しておく。
  await page.evaluate(() => window.__reply({ type: "window-state", fullscreen: true, alwaysOnTop: false }));
  await page.waitForTimeout(200);

  // (a) 「表示」をクリック → open-menuが送られ、HTMLのドロップダウンは作られない。
  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(300);
  const sentAfterView = await page.evaluate(() => window.__sent);
  const viewMsg = lastOpenMenu(sentAfterView, "View");
  ok("(a) 「表示」クリックでopen-menuを送信", !!viewMsg);
  ok("(a) open-menuにx/yが数値で入っている", typeof viewMsg?.x === "number" && typeof viewMsg?.y === "number");
  const htmlDropdownAfterView = await page.$(".menu-dropdown");
  ok("(a) HTMLのドロップダウン(.menu-dropdown)は作られない", htmlDropdownAfterView === null);
  ok("(a) 見出しに.openクラスが付く(ハイライト)", await page.evaluate(() =>
    [...document.querySelectorAll("#menubar .menu-top")].some((b) => b.textContent === "表示" && b.classList.contains("open"))));

  // (b) items32項目(既存20 + 折りたたみ関連コマンド12件: カーソル位置を折りたたむ/展開・
  // すべて折りたたむ/展開・再帰的な折りたたみ/展開・レベル1〜5・すべてのコメントブロック)、
  // 各項目にlabel/shortcut/enabled/checked/separatorAfterが入っている。
  const items = viewMsg.items;
  ok(`(b) 表示メニューの項目数が32 (既存20+折りたたみ関連12。実際=${items.length})`, items.length === 32);
  const hasAllFields = items.every((it) =>
    typeof it.label === "string" &&
    typeof it.shortcut === "string" &&
    typeof it.enabled === "boolean" &&
    typeof it.checked === "boolean" &&
    typeof it.separatorAfter === "boolean");
  ok("(b) 各項目にlabel/shortcut/enabled/checked/separatorAfterが入っている", hasAllFields);

  // (c) 「全画面表示」のチェック状態がwindow-stateの内容(fullscreen:true)を反映している。
  const fullscreenItem = items.find((it) => it.id === "view.fullscreen");
  ok(`(c) 「全画面表示」のchecked=true (実際のlabel=${fullscreenItem?.label}, checked=${fullscreenItem?.checked})`,
    !!fullscreenItem && fullscreenItem.checked === true);
  // 対比: 常に手前に表示はalwaysOnTop:falseなのでchecked=falseのはず。
  const alwaysOnTopItem = items.find((it) => it.id === "view.alwaysOnTop");
  ok("(c) 「常に手前に表示」のchecked=false", !!alwaysOnTopItem && alwaysOnTopItem.checked === false);

  // 一旦閉じる(選択なし)。
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "View" }));
  await page.waitForTimeout(200);
  ok("(f)-準備: menu-closedで見出しのハイライトが解除される", await page.evaluate(() =>
    ![...document.querySelectorAll("#menubar .menu-top")].some((b) => b.classList.contains("open"))));

  // (d) 「ファイル」を開いたとき、最近使ったファイルがsubmenuとして入っており、各項目に一意なidがある。
  await page.evaluate(() => window.__reply({
    type: "apply-settings",
    recentFiles: ["C:\\work\\a.md", "C:\\work\\b.md", "C:\\work\\c.md"],
  }));
  await page.waitForTimeout(300);
  await page.click("#menubar .menu-top:text('ファイル')");
  await page.waitForTimeout(300);
  const sentAfterFile = await page.evaluate(() => window.__sent);
  const fileMsg = lastOpenMenu(sentAfterFile, "File");
  const recentEntry = fileMsg?.items.find((it) => it.id === "file.recentFiles");
  ok("(d) 「最近使ったファイル」がsubmenuとして入っている", Array.isArray(recentEntry?.submenu) && recentEntry.submenu.length === 3);
  const subIds = recentEntry?.submenu.map((s) => s.id) ?? [];
  ok(`(d) submenu各項目に一意なidがある ${JSON.stringify(subIds)}`,
    subIds.length === 3 && new Set(subIds).size === 3 && subIds.every((id) => typeof id === "string" && id.startsWith("file.recentFiles/")));
  const recentLabels = recentEntry?.submenu.map((s) => s.label) ?? [];
  ok(`(d) submenuのlabelが実際のファイルパス ${JSON.stringify(recentLabels)}`,
    JSON.stringify(recentLabels) === JSON.stringify(["C:\\work\\a.md", "C:\\work\\b.md", "C:\\work\\c.md"]));

  // (e) menu-commandを返すと対応するコマンドが実行される(例: view.wordWrap→折り返し表示切替)。
  // id→実行関数の対応表は開くたびに作り直される(直前に「ファイル」を開いたため)ので、
  // 「表示」を開き直してから送る。
  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(300);
  const wrapBefore = await page.textContent("#status-wrap");
  await page.evaluate(() => window.__reply({ type: "menu-command", id: "view.wordWrap" }));
  await page.waitForTimeout(300);
  const wrapAfter = await page.textContent("#status-wrap");
  ok(`(e) menu-command(view.wordWrap)で折り返し表示が切り替わる "${wrapBefore}" -> "${wrapAfter}"`, wrapBefore !== wrapAfter);
  ok("(e) menu-command処理後も見出しのハイライトが残らない", await page.evaluate(() =>
    ![...document.querySelectorAll("#menubar .menu-top")].some((b) => b.classList.contains("open"))));

  // (e)-2 「最近使ったファイル」submenuのidでもコマンド(openRecentFile)が実行されることを確認する。
  await page.click("#menubar .menu-top:text('ファイル')");
  await page.waitForTimeout(300);
  const sentBeforeRecentClick = (await page.evaluate(() => window.__sent)).length;
  await page.evaluate(() => window.__reply({ type: "menu-command", id: "file.recentFiles/1" }));
  await page.waitForTimeout(300);
  const sentAfterRecentClick = await page.evaluate(() => window.__sent);
  const openedPath = sentAfterRecentClick.slice(sentBeforeRecentClick).find((m) => m.type === "open-path");
  ok(`(e) submenu項目のmenu-commandでopenRecentFile相当が実行される (open-path path=${openedPath?.path})`,
    openedPath?.path === "C:\\work\\b.md");

  // (f) menu-closedを返すと見出しのハイライトが解除される。
  await page.click("#menubar .menu-top:text('編集')");
  await page.waitForTimeout(200);
  const highlightedBeforeClose = await page.evaluate(() =>
    [...document.querySelectorAll("#menubar .menu-top")].some((b) => b.textContent === "編集" && b.classList.contains("open")));
  ok("(f)-準備: クリック直後は見出しがハイライトされる", highlightedBeforeClose);
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "Edit" }));
  await page.waitForTimeout(200);
  const highlightedAfterClose = await page.evaluate(() =>
    [...document.querySelectorAll("#menubar .menu-top")].some((b) => b.classList.contains("open")));
  ok("(f) menu-closedで見出しのハイライトが解除される", !highlightedAfterClose);

  await page.close();
}

// ============================================================
// (i) ホバーでのメニュー切り替え(クリックしなくても隣の見出しへ切り替わる)
// 【ラウンド2で方式変更】以前はC#側がネイティブポップアップのMouseMoveを監視して
// "menu-hover-switch"メッセージで知らせる方式だったが、実機で一度もそのメッセージが
// 送られておらず機能していないことが確認された。ユーザー自身が「メニュー表示中に別の
// 見出しへカーソルを乗せると:hover色が実際に変わる」ことを確認しており、これはHTML側が
// マウス位置の変化を検知できている証拠だったため、見出しボタン自体のmouseenterで
// ホバーを検知する方式に変更した。ここではpage.hover()(実際のマウス移動イベントを
// 発火させる)で検証し、C#からのメッセージ配線(menu-hover-switch)には一切頼らない。
// ============================================================
{
  const page = await newBridgedPage();

  function highlighted(labels) {
    return page.evaluate((ls) => ls.map((l) =>
      [...document.querySelectorAll("#menubar .menu-top")].some((b) => b.textContent === l && b.classList.contains("open"))
    ), labels);
  }
  function openMenuCount(sent) { return sent.filter((m) => m.type === "open-menu").length; }
  // mouseenterが実際に発火したかどうかは、main.jsのlogToHostと同じプロトコル
  // ({type:"log", message:"メニュー見出しへmouseenter: ..."})でホストへ送られる
  // (commands.jsのhoverLog、実機切り分け用ログ)。
  function hoverLogCount(sent, needle) {
    return sent.filter((m) => m.type === "log" && typeof m.message === "string" && m.message.includes(needle)).length;
  }

  // (i-1) メニューが開いていない状態で見出しへマウスを乗せても、mouseenter自体は発火する
  // (ログが記録される)が、メニューは開かない(標準の挙動: ホバーだけでは開かない。クリックが必要)。
  await page.hover("#menubar .menu-top:text('編集')");
  await page.waitForTimeout(150);
  const sentAfterIdleHover = await page.evaluate(() => window.__sent);
  ok("(i-1) メニューが閉じている間もmouseenter自体は発火する(切り分け用ログが記録される)",
    hoverLogCount(sentAfterIdleHover, "menu=Edit") > 0);
  ok("(i-1) メニューが閉じている間はホバーだけでは開かない(open-menuを送らない)",
    openMenuCount(sentAfterIdleHover) === 0);
  ok("(i-1) メニューが閉じている間はどの見出しもハイライトされない",
    (await highlighted(["ファイル", "編集"])).every((v) => v === false));

  // (i-2) 「ファイル」をクリックで開いた状態で「編集」の見出しへマウスを乗せると、
  // クリックしたときと同じ経路(openNativeMenu)でopen-menuを送り直し、
  // ハイライトが「編集」へ移る。
  await page.click("#menubar .menu-top:text('ファイル')");
  await page.waitForTimeout(300);
  const sentBeforeHover = (await page.evaluate(() => window.__sent)).length;
  await page.hover("#menubar .menu-top:text('編集')");
  await page.waitForTimeout(200);
  const sentAfterHover = await page.evaluate(() => window.__sent);
  const editOpenMsg = lastOpenMenu(sentAfterHover, "Edit");
  ok("(i-2) 見出しへのホバーでopen-menu(Edit)が送り直される",
    sentAfterHover.length > sentBeforeHover && !!editOpenMsg);
  const [fileHi, editHi] = await highlighted(["ファイル", "編集"]);
  ok("(i-2) ハイライトが「ファイル」から「編集」へ移る", fileHi === false && editHi === true);

  // (i-3) 既存の連打対策との非競合: 切り替え直後に届く「前のメニュー(File)が閉じた」という
  // 遅れたmenu-closedで、いま開いている「編集」のハイライトまで消えないこと
  // (.verify-menufix.mjsが検証している「nativeOpenMenuNameとの突き合わせ」と同じ仕組み)。
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "File" }));
  await page.waitForTimeout(150);
  const [, editHiAfterStaleClose] = await highlighted(["ファイル", "編集"]);
  ok("(i-3) ホバー切り替え直後の遅れたmenu-closed(File)で「編集」のハイライトが消えない", editHiAfterStaleClose === true);

  // (i-4) いま開いているメニュー自身へのホバーは無視する(無駄なopen-menuを送らない)。
  const openMenuCountBeforeSelfHover = openMenuCount(await page.evaluate(() => window.__sent));
  await page.hover("#menubar .menu-top:text('編集')");
  await page.waitForTimeout(150);
  const openMenuCountAfterSelfHover = openMenuCount(await page.evaluate(() => window.__sent));
  ok("(i-4) いま開いているメニュー自身へのホバーは無視する",
    openMenuCountAfterSelfHover === openMenuCountBeforeSelfHover);

  // (i-5) 【ラウンド2のmouseenter対応で新たに見つかった回帰の直接確認】実際のマウス操作では、
  // 別の見出しをクリックする際に必ず先にその見出しへのmouseenterが発火する(ポインタが移動
  // してからでないとクリックできないため)。ホバー切り替えで開いたばかりの見出しへ、続けて
  // クリックしても、その開いたばかりのメニューが即座に閉じてしまわないこと
  // (「同じ見出しの再クリックで閉じる」トグル判定に誤って引っかかっていた不具合の確認)。
  await page.click("#menubar .menu-top:text('編集')"); // page.click()はhover→クリックの順で発火する
  await page.waitForTimeout(200);
  const [, editHiAfterHoverThenClick] = await highlighted(["ファイル", "編集"]);
  ok("(i-5) ホバーで開いた見出しへの直後のクリックで閉じてしまわない", editHiAfterHoverThenClick === true);
  // さらにもう一度同じ見出しをクリックすれば、今度こそ通常どおり閉じる
  // (ホバー猶予は1回のクリックで消費されるため、これは正真正銘の再クリック)。
  await page.click("#menubar .menu-top:text('編集')");
  await page.waitForTimeout(200);
  const [, editHiAfterSecondClick] = await highlighted(["ファイル", "編集"]);
  ok("(i-5) さらに同じ見出しを再クリックすれば通常どおり閉じる", editHiAfterSecondClick === false);

  // 後始末: 開いたままにしない。
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "Edit" }));
  await page.waitForTimeout(150);

  await page.close();
}

// ============================================================
// (j) メニューのキーボード操作(ユーザー報告: ↑↓/Enter/Esc/←→が効かない)のうち、
// JS側で検証できる範囲(←→の"menu-arrow-switch"メッセージ受信→openNativeMenu呼び直し)。
// 【重要・実機頼みの部分の明記】↑↓(項目移動)・Enter(実行)・Esc(閉じる)は
// ToolStripDropDownMenu自身の標準機能であり、Pane/NativeMenu.csでのFocus()呼び出しと
// 最初の項目の選択(footingづくり)が実機で実際に効くかどうかは、この
// ヘッドレスLinux環境ではWinForms自体を動かせないため一切検証できない
// (C#のビルドが通ることまでは確認済み)。ここで検証できるのは、C#から
// "menu-arrow-switch"メッセージが届いた後のJS側の処理(メニューバーの並び順に基づく
// 次/前のメニューの決定・折り返し・openNativeMenuの呼び直し)だけである。
// ============================================================
{
  const page = await newBridgedPage();
  function highlighted(labels) {
    return page.evaluate((ls) => ls.map((l) =>
      [...document.querySelectorAll("#menubar .menu-top")].some((b) => b.textContent === l && b.classList.contains("open"))
    ), labels);
  }

  // (j-1) 「編集」を開いた状態でmenu-arrow-switch(direction:"next")を受けると、
  // メニューバーの並び順(ファイル・編集・表示・段落・書式)の次である「表示」へ切り替わる。
  await page.click("#menubar .menu-top:text('編集')");
  await page.waitForTimeout(300);
  const sentBeforeNext = (await page.evaluate(() => window.__sent)).length;
  await page.evaluate(() => window.__reply({ type: "menu-arrow-switch", menu: "Edit", direction: "next" }));
  await page.waitForTimeout(200);
  const sentAfterNext = await page.evaluate(() => window.__sent);
  ok("(j-1) menu-arrow-switch(next)でopen-menu(View)が送り直される", !!lastOpenMenu(sentAfterNext, "View") && sentAfterNext.length > sentBeforeNext);
  const [editHi1, viewHi1] = await highlighted(["編集", "表示"]);
  ok("(j-1) ハイライトが「編集」から「表示」へ移る", editHi1 === false && viewHi1 === true);

  // (j-2) direction:"prev"では逆順(表示→編集)へ戻る。
  await page.evaluate(() => window.__reply({ type: "menu-arrow-switch", menu: "View", direction: "prev" }));
  await page.waitForTimeout(200);
  const [editHi2, viewHi2] = await highlighted(["編集", "表示"]);
  ok("(j-2) menu-arrow-switch(prev)で「表示」から「編集」へ戻る", editHi2 === true && viewHi2 === false);

  // (j-3) 末尾(書式)でnextを受けると先頭(ファイル)へ折り返す(Windows標準のメニューバーに合わせる)。
  await page.click("#menubar .menu-top:text('編集')"); // いったん閉じてから
  await page.waitForTimeout(200);
  await page.click("#menubar .menu-top:text('書式')");
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__reply({ type: "menu-arrow-switch", menu: "Format", direction: "next" }));
  await page.waitForTimeout(200);
  const [fileHi3, formatHi3] = await highlighted(["ファイル", "書式"]);
  ok("(j-3) 末尾(書式)でnextを受けると先頭(ファイル)へ折り返す", fileHi3 === true && formatHi3 === false);

  // (j-4) 先頭(ファイル)でprevを受けると末尾(書式)へ折り返す。
  await page.evaluate(() => window.__reply({ type: "menu-arrow-switch", menu: "File", direction: "prev" }));
  await page.waitForTimeout(200);
  const [fileHi4, formatHi4] = await highlighted(["ファイル", "書式"]);
  ok("(j-4) 先頭(ファイル)でprevを受けると末尾(書式)へ折り返す", fileHi4 === false && formatHi4 === true);

  // (j-5) メニューが閉じている間にmenu-arrow-switchが届いても何も起きない(標準の防御)。
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "Format" }));
  await page.waitForTimeout(150);
  const openMenuCountBeforeIdle = (await page.evaluate(() => window.__sent)).filter((m) => m.type === "open-menu").length;
  await page.evaluate(() => window.__reply({ type: "menu-arrow-switch", menu: "Format", direction: "next" }));
  await page.waitForTimeout(150);
  const openMenuCountAfterIdle = (await page.evaluate(() => window.__sent)).filter((m) => m.type === "open-menu").length;
  ok("(j-5) メニューが閉じている間はmenu-arrow-switchを無視する", openMenuCountAfterIdle === openMenuCountBeforeIdle);

  // (j-6) 届いたmenu(現在開いているはずのメニュー名)が、JS側が実際に把握している
  // いま開いているメニューと食い違っていれば(タイミングのずれ等)、何もしない防御。
  await page.click("#menubar .menu-top:text('ファイル')");
  await page.waitForTimeout(300);
  const openMenuCountBeforeMismatch = (await page.evaluate(() => window.__sent)).filter((m) => m.type === "open-menu").length;
  await page.evaluate(() => window.__reply({ type: "menu-arrow-switch", menu: "Edit", direction: "next" })); // 実際は"File"が開いている
  await page.waitForTimeout(150);
  const openMenuCountAfterMismatch = (await page.evaluate(() => window.__sent)).filter((m) => m.type === "open-menu").length;
  ok("(j-6) 届いたmenuが実際に開いているメニューと食い違っていれば何もしない",
    openMenuCountAfterMismatch === openMenuCountBeforeMismatch);

  // 後始末。
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "File" }));
  await page.waitForTimeout(150);

  await page.close();
}

// ============================================================
// (g) ブリッジ無し: 従来どおりHTMLのドロップダウンが出る
// ============================================================
{
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await page.goto("http://localhost:8154/index.html");
  await page.waitForTimeout(800);

  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(300);
  const dropdown = await page.$(".menu-dropdown");
  ok("(g) ブリッジ無しでは従来どおりHTMLのドロップダウンが出る", dropdown !== null);
  const itemCount = await page.$$eval(".menu-dropdown .menu-item", (e) => e.length);
  ok(`(g) HTMLドロップダウンの項目数が32 (既存20+折りたたみ関連12。実際=${itemCount})`, itemCount === 32);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.close();
}

// ============================================================
// (h) ページエラー・コンソールエラーが0件
// ============================================================
ok(`(h) ページエラー0件 ${JSON.stringify(errors)}`, errors.length === 0);
ok(`(h) コンソールエラー0件 ${JSON.stringify(consoleErrors)}`, consoleErrors.length === 0);

console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
