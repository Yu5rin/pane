// Phase 1追加3件の検証スクリプト。ポートは8179。
// 1. カラーピッカーのドラッグ移動(src/color-picker.js・src/style.css)
// 2. サイドバー幅のドラッグリサイズ(src/sidebar.js・src/style.css・src/index.html・
//    Pane/AppSettings.cs・Pane/SettingsBridge.cs・Pane/MainForm.cs)
// 3. 「フォルダを開く」の新規ウィンドウ判定・サイドバー自動表示(src/main.js・Pane/MainForm.cs)
//
// カラーピッカー部分は「触ってよいファイル」がsrc/color-picker.js・src/style.cssのみのため、
// .verify-picker.mjsと同じ作法(bridge無し・window.__paneDebugEditorを直接叩く)で検証する。
// サイドバー幅・フォルダを開くの部分はC#へのpostMessageを確認する必要があるため、
// .verify-bridge.mjs/.verify-dialog.mjsと同じ作法(window.chrome.webviewをモック)で検証する。
import pw from "playwright";
const { chromium } = pw;

const PORT = 8179;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

// ============================================================
// カラーピッカー用ヘルパー(bridge無し。.verify-picker.mjsと同じ)
// ============================================================
async function newPage(viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}
async function setCode(page, text, filename = "sample.css") {
  await page.evaluate(({ text, filename }) => {
    window.__paneDebugEditor.setFileMode(filename, "code");
  }, { text, filename });
  await page.waitForTimeout(150);
  await page.evaluate((t) => window.__paneDebugEditor.setValue(t), text);
  await page.waitForTimeout(250);
}
async function openPickerAt(page, needle, cursorOffset = 1) {
  return page.evaluate(({ needle, cursorOffset }) => {
    const text = window.__paneDebugEditor.getValue();
    const idx = text.indexOf(needle);
    if (idx < 0) return null;
    const lit = window.__paneDebugEditor.getColorLiteralAt(idx + cursorOffset);
    if (!lit) return null;
    return { lit, opened: window.__paneDebugEditor.openColorPicker(lit.from, lit.to, lit.text) };
  }, { needle, cursorOffset });
}
async function panelRect(page) {
  return page.$eval(".color-picker-panel", (e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}
async function closeWithEscape(page) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }

// ============================================================
// bridgeモック用ヘルパー(サイドバー幅・フォルダを開く。.verify-bridge.mjsと同じ作法)
// ============================================================
async function newBridgedPage(viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
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
  await page.waitForTimeout(300);
  return page;
}

// ============================================================
// (1) プレビュー行をドラッグするとパネルが移動する
// ============================================================
{
  const page = await newPage({ width: 900, height: 700 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  const before = await panelRect(page);
  const preview = await page.$(".cp-preview");
  const pbox = await preview.boundingBox();
  await page.mouse.move(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(pbox.x + pbox.width / 2 + 120, pbox.y + pbox.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const after = await panelRect(page);
  ok(`(1) プレビュー行のドラッグでパネルが移動する (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`,
    Math.abs(after.left - before.left) > 50 || Math.abs(after.top - before.top) > 50);

  await closeWithEscape(page);
  await page.close();
}

// ============================================================
// (2) 画面外へドラッグしてもクランプされる
// ============================================================
{
  const page = await newPage({ width: 900, height: 700 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  // 右下方向へ大きくドラッグ
  let preview = await page.$(".cp-preview");
  let pbox = await preview.boundingBox();
  await page.mouse.move(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(5000, 5000, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const afterFar = await panelRect(page);
  ok(`(2) 右下方向へ大きくドラッグしても画面内にクランプされる (${JSON.stringify(afterFar)})`,
    afterFar.right <= 901 && afterFar.bottom <= 701);

  // 左上方向へ大きくドラッグ
  preview = await page.$(".cp-preview");
  pbox = await preview.boundingBox();
  await page.mouse.move(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(-5000, -5000, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const afterNear = await panelRect(page);
  ok(`(2) 左上方向へ大きくドラッグしても画面内にクランプされる (${JSON.stringify(afterNear)})`,
    afterNear.left >= -1 && afterNear.top >= -1);

  // クランプされた後もハンドルを掴んで動かせること(画面外に出て操作不能にならない)
  preview = await page.$(".cp-preview");
  pbox = await preview.boundingBox();
  await page.mouse.move(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(pbox.x + 60, pbox.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const afterRecover = await panelRect(page);
  ok(`(2) クランプ後も再度ドラッグで動かせる (${JSON.stringify(afterRecover)})`,
    Math.abs(afterRecover.left - afterNear.left) > 10 || Math.abs(afterRecover.top - afterNear.top) > 10);

  await closeWithEscape(page);
  await page.close();
}

// ============================================================
// (3) スライダー・四角形・入力欄の上でドラッグしてもパネルは動かず色は変わる
// ============================================================
{
  const page = await newPage({ width: 900, height: 700 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  // 色相スライダー
  let before = await panelRect(page);
  let colorBefore = await page.$eval(".cp-primary", (e) => e.textContent);
  const hue = await page.$(".cp-hue-slider");
  let hbox = await hue.boundingBox();
  await page.mouse.move(hbox.x + 4, hbox.y + hbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hbox.x + hbox.width - 4, hbox.y + hbox.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  let after = await panelRect(page);
  let colorAfter = await page.$eval(".cp-primary", (e) => e.textContent);
  ok(`(3) 色相スライダー上のドラッグではパネルが動かない (${before.left},${before.top} -> ${after.left},${after.top})`,
    before.left === after.left && before.top === after.top);
  ok(`(3) 色相スライダー上のドラッグで色が変わる (${colorBefore} -> ${colorAfter})`, colorBefore !== colorAfter);

  // 彩度×明度の四角形
  before = await panelRect(page);
  colorBefore = await page.$eval(".cp-primary", (e) => e.textContent);
  const sl = await page.$(".cp-sl-box");
  const sbox = await sl.boundingBox();
  await page.mouse.move(sbox.x + 4, sbox.y + 4);
  await page.mouse.down();
  await page.mouse.move(sbox.x + sbox.width - 4, sbox.y + sbox.height - 4, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  after = await panelRect(page);
  colorAfter = await page.$eval(".cp-primary", (e) => e.textContent);
  ok(`(3) 彩度明度の四角形上のドラッグではパネルが動かない (${before.left},${before.top} -> ${after.left},${after.top})`,
    before.left === after.left && before.top === after.top);
  ok(`(3) 彩度明度の四角形上のドラッグで色が変わる (${colorBefore} -> ${colorAfter})`, colorBefore !== colorAfter);

  // 数値入力欄(R欄)
  before = await panelRect(page);
  const rInput = await page.$('.color-picker-panel input[data-ch="r"]');
  const ribox = await rInput.boundingBox();
  await page.mouse.move(ribox.x + ribox.width / 2, ribox.y + ribox.height / 2);
  await page.mouse.down();
  await page.mouse.move(ribox.x + 200, ribox.y + 100, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  after = await panelRect(page);
  ok(`(3) 数値入力欄上のドラッグではパネルが動かない (${before.left},${before.top} -> ${after.left},${after.top})`,
    before.left === after.left && before.top === after.top);

  // 不透明度スライダーは元がhexで非表示のため、代わりにアルファ付きリテラルで確認する
  // (前のパネルを閉じてから切り替える)
  await closeWithEscape(page);
  await setCode(page, "a { color: rgba(20, 89, 159, 0.6); }\n");
  await openPickerAt(page, "rgba(20, 89, 159, 0.6)");
  await page.waitForTimeout(150);
  before = await panelRect(page);
  colorBefore = await page.$eval(".cp-primary", (e) => e.textContent);
  const alpha = await page.$(".cp-alpha-slider");
  const abox = await alpha.boundingBox();
  await page.mouse.move(abox.x + 4, abox.y + abox.height / 2);
  await page.mouse.down();
  await page.mouse.move(abox.x + abox.width - 4, abox.y + abox.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  after = await panelRect(page);
  colorAfter = await page.$eval(".cp-primary", (e) => e.textContent);
  ok(`(3) 不透明度スライダー上のドラッグではパネルが動かない (${before.left},${before.top} -> ${after.left},${after.top})`,
    before.left === after.left && before.top === after.top);
  ok(`(3) 不透明度スライダー上のドラッグで色が変わる (${colorBefore} -> ${colorAfter})`, colorBefore !== colorAfter);

  await closeWithEscape(page);
  await page.close();
}

// ============================================================
// (4) 閉じて開き直すと自動配置に戻る
// ============================================================
{
  const page = await newPage({ width: 900, height: 700 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);
  const autoPos1 = await panelRect(page);

  const preview = await page.$(".cp-preview");
  const pbox = await preview.boundingBox();
  await page.mouse.move(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(pbox.x + pbox.width / 2 + 150, pbox.y + pbox.height / 2 + 100, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const dragged = await panelRect(page);
  ok(`(4-前提) ドラッグでパネルが動く (${JSON.stringify(autoPos1)} -> ${JSON.stringify(dragged)})`,
    dragged.left !== autoPos1.left || dragged.top !== autoPos1.top);

  await closeWithEscape(page);

  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);
  const autoPos2 = await panelRect(page);
  ok(`(4) 閉じて開き直すと自動配置に戻る (1回目=${JSON.stringify(autoPos1)}, 2回目=${JSON.stringify(autoPos2)})`,
    Math.abs(autoPos2.left - autoPos1.left) < 1 && Math.abs(autoPos2.top - autoPos1.top) < 1);

  await closeWithEscape(page);
  await page.close();
}

// ============================================================
// (5)〜(8) サイドバー幅のドラッグリサイズ
// ============================================================
{
  const page = await newBridgedPage({ width: 1200, height: 800 });
  await page.click("#status-sidebar");
  await page.waitForTimeout(200);

  const widthOf = () => page.$eval("#sidebar", (e) => e.getBoundingClientRect().width);
  const handleOf = () => page.$("#sidebar-resize-handle");

  const initialWidth = await widthOf();
  ok(`(5-前提) サイドバーを開いた直後の幅は既定240px (${initialWidth})`, Math.abs(initialWidth - 240) < 1);

  // ドラッグで広げる
  let handle = await handleOf();
  let hbox = await handle.boundingBox();
  await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hbox.x + 150, hbox.y + hbox.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const widened = await widthOf();
  ok(`(5) ドラッグで幅が変わる (240 -> ${widened})`, Math.abs(widened - 240) > 50);

  // 180px未満にならない(ハンドルを画面左端近くまで動かす)
  handle = await handleOf();
  hbox = await handle.boundingBox();
  await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, hbox.y + hbox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const shrunk = await widthOf();
  ok(`(5) 180px未満にならない (${shrunk})`, shrunk >= 179);

  // 600px超にならない(ハンドルを画面右端近くまで動かす。viewport幅1200なので
  // 幅50%の上限も600pxで一致し、両方の制約を同時に確認できる)
  handle = await handleOf();
  hbox = await handle.boundingBox();
  await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(1195, hbox.y + hbox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const widenedMax = await widthOf();
  ok(`(5) 600px超にならない (${widenedMax})`, widenedMax <= 601);

  // (6) ウィンドウを狭めると幅50%の制約で自動的に縮む
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(300);
  const afterNarrow = await widthOf();
  ok(`(6) ウィンドウを700pxへ狭めると幅50%(350px)以内に縮む (${afterNarrow})`, afterNarrow <= 351);

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(300);

  // (7) ハンドルのダブルクリックで既定幅(240px)に戻る
  //
  // 注意: #sidebarにはtransition: width 160ms ease(src/style.css)が掛かっている。
  // ドラッグ中はsidebar.jsが.sidebar-resizingクラスでこのtransitionを切るが、
  // ダブルクリックでの既定幅リセット(resizeHandleEl.addEventListener("dblclick", ...))は
  // 意図的にtransitionを切っていない(パッと切り替わるより160msでなめらかに戻る方が
  // 自然なUXであるため)。つまりダブルクリック直後は「幅がアニメーション中」の状態を
  // 経由するのが実装として正しい挙動であり、これ自体はバグではない。
  //
  // 以前はここをwaitForTimeout(150)で固定待ちしていたが、150ms < 160msなので
  // 理屈のうえで必ず「トランジションが終わる前」を捕まえうる書き方だった。ローカルでは
  // 描画が速くwaitForTimeout(150)の実測時間がtransitionの完了後にずれ込むことが多かったため
  // 気づかれなかったが、CI(ubuntu-latest)では描画が遅れて150ms時点でトランジションが
  // 終わっておらず、easeカーブの残り(例: 240 + 110px*残り約1.6% = 241.8125px)を
  // そのまま読んでしまいNGになっていた。
  //
  // 固定待ち時間をただ延ばすのではなく、「幅が既定値へ収束するまで」を明示的に待つ
  // (transitionの長さが将来変わっても追従できるようにするため)。
  handle = await handleOf();
  hbox = await handle.boundingBox();
  await page.mouse.dblclick(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
  await page.waitForFunction(
    () => Math.abs(document.getElementById("sidebar").getBoundingClientRect().width - 240) < 0.5,
    { timeout: 2000 }
  ).catch(() => {}); // タイムアウトしても握りつぶし、後続のok()に実測値を渡してNGとして可視化する
  const afterDbl = await widthOf();
  ok(`(7) ダブルクリックで既定幅240pxに戻る (${afterDbl})`, Math.abs(afterDbl - 240) < 1);

  // (8) 幅の変更がC#へ送られること
  const sentWidths = await page.evaluate(() => window.__sent.filter((m) => m.type === "set-sidebar-width"));
  ok(`(8) set-sidebar-widthメッセージが送信される (${sentWidths.length}件)`, sentWidths.length >= 3);
  ok(`(8) 直近のset-sidebar-widthがダブルクリック後の既定幅240 (${JSON.stringify(sentWidths[sentWidths.length - 1])})`,
    sentWidths[sentWidths.length - 1]?.width === 240);
  ok(`(8) 送信された幅はすべて180〜600の範囲内 (${JSON.stringify(sentWidths.map((m) => m.width))})`,
    sentWidths.every((m) => m.width >= 180 && m.width <= 600));

  await page.close();
}

// ============================================================
// (9)〜(11) 「フォルダを開く」の新規ウィンドウ判定・サイドバー自動表示
// ============================================================
{
  const page = await newBridgedPage({ width: 1200, height: 800 });

  // (9) 空の新規文書からフォルダを開くと newWindow:false が送られる
  await page.click(".cm-content");
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(200);
  await page.fill("#palette-input", "フォルダを開く");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  let sentFolder = await page.evaluate(() => window.__sent.filter((m) => m.type === "open-folder"));
  ok(`(9) 空の新規文書から「フォルダを開く」でnewWindow:falseが送られる (${JSON.stringify(sentFolder)})`,
    sentFolder.length === 1 && sentFolder[0].newWindow === false);

  // (10) 本文に何か書いてある状態で実行すると newWindow:true が送られる
  await page.click(".cm-content");
  await page.keyboard.type("何か書いた");
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(200);
  await page.fill("#palette-input", "フォルダを開く");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  sentFolder = await page.evaluate(() => window.__sent.filter((m) => m.type === "open-folder"));
  ok(`(10) 本文に何か書いてあるとnewWindow:trueが送られる (${JSON.stringify(sentFolder)})`,
    sentFolder.length === 2 && sentFolder[1].newWindow === true);

  // (11) フォルダの読み込み成功でサイドバーが開き、ファイルツリーのタブが選ばれる
  const collapsedBefore = await page.$eval("#sidebar", (e) => e.classList.contains("collapsed"));
  ok(`(11-前提) フォルダ読込前はサイドバーが閉じている (${collapsedBefore})`, collapsedBefore === true);

  await page.evaluate(() => window.__reply({
    type: "folder-loaded",
    rootPath: "C:\\proj", rootName: "proj", truncated: false,
    entries: [
      { path: "C:\\proj\\a.md", name: "a.md", relativePath: "a.md", isDirectory: false },
    ],
  }));
  await page.waitForTimeout(300);
  const collapsedAfter = await page.$eval("#sidebar", (e) => e.classList.contains("collapsed"));
  const activePanel = await page.$eval(".sidebar-tab.active", (e) => e.dataset.panel);
  ok(`(11) フォルダ読込成功でサイドバーが開く (collapsed=${collapsedAfter})`, collapsedAfter === false);
  ok(`(11) ファイルツリーのタブが選ばれる (active=${activePanel})`, activePanel === "tree");

  // ファイルを開いた際の自動フォルダ読み込み(autoLoaded:true)ではサイドバーを
  // 強制的に開いたりタブを切り替えたりしないこと(既存のsidebar.close()挙動を確認)
  await page.evaluate(() => {
    document.querySelector("#status-sidebar").click();
  });
  await page.waitForTimeout(150);
  const collapsedManualClose = await page.$eval("#sidebar", (e) => e.classList.contains("collapsed"));
  ok(`(11-補) 手動で閉じられる(前提の健全性確認) (collapsed=${collapsedManualClose})`, collapsedManualClose === true);
  await page.evaluate(() => window.__reply({
    type: "folder-loaded",
    rootPath: "C:\\proj", rootName: "proj", truncated: false, autoLoaded: true,
    entries: [
      { path: "C:\\proj\\a.md", name: "a.md", relativePath: "a.md", isDirectory: false },
    ],
  }));
  await page.waitForTimeout(300);
  const collapsedAfterAuto = await page.$eval("#sidebar", (e) => e.classList.contains("collapsed"));
  ok(`(11-補) autoLoaded:trueの再読み込みでは閉じたサイドバーを勝手に開かない (collapsed=${collapsedAfterAuto})`,
    collapsedAfterAuto === true);

  await page.close();
}

// ============================================================
// (12) 読み込み済みフォルダの配下(孫階層)にあるファイルを開いたとき、
//      ツリー上でそこまでの祖先フォルダが自動的に展開され、開いたファイルが
//      ハイライト(current)されること(不具合: 「フォルダを開いて、その中の
//      さらに中のフォルダのテキストを開くと、ルートが変わってしまう」の修正に対応。
//      C#側(Pane/MainForm.cs AutoLoadParentFolder)の「ルートを変えない」判定自体は
//      scratchpad配下の抽出コンソール検証で別途確認済みのため、ここではJS側
//      (src/sidebar.js setCurrentPath/expandAncestorsOf)の見た目の挙動だけを確認する)
// ============================================================
{
  const page = await newBridgedPage({ width: 1200, height: 800 });

  // ルート直下のディレクトリ(assets)は初回読み込みで既定展開されるが、その1階層下の
  // ディレクトリ(assets/icons)は既定では展開されない(setFolderの初期展開ロジック参照)。
  // ここをあえて2階層のネストにして、「祖先を辿って展開する」ロジックが本当に効いているかを
  // 確かめる(1階層だけだと既定展開に紛れて確認にならないため)。
  await page.evaluate(() => window.__reply({
    type: "folder-loaded",
    rootPath: "C:\\proj\\public", rootName: "public", truncated: false,
    entries: [
      { path: "C:\\proj\\public\\index.html", name: "index.html", relativePath: "index.html", isDirectory: false },
      { path: "C:\\proj\\public\\assets", name: "assets", relativePath: "assets", isDirectory: true },
      { path: "C:\\proj\\public\\assets\\icons", name: "icons", relativePath: "assets/icons", isDirectory: true },
      { path: "C:\\proj\\public\\assets\\icons\\app.js", name: "app.js", relativePath: "assets/icons/app.js", isDirectory: false },
    ],
  }));
  await page.waitForTimeout(300);

  // 前提: この時点ではassets/icons配下は展開されていないので、app.jsの行はまだDOMに無い
  const appRowBefore = await page.$('.tree-item-file[title="assets/icons/app.js"]');
  ok(`(12-前提) 未展開時はassets/icons配下のapp.jsはツリーDOMに無い (${appRowBefore})`, appRowBefore === null);

  // 孫階層のファイルを開く。今回の修正(Pane/MainForm.cs AutoLoadParentFolder)により
  // 親フォルダは既に読み込み済みのフォルダの配下なのでC#側からfolder-loadedは再度届かず、
  // file-openedだけが届く想定(=ルートが変わらない)。
  await page.evaluate(() => window.__reply({
    type: "file-opened",
    text: "console.log('hi')",
    fileName: "app.js",
    path: "C:\\proj\\public\\assets\\icons\\app.js",
    encoding: "UTF-8",
    lineEnding: "LF",
    readOnly: false,
  }));
  await page.waitForTimeout(300);

  const rootLabel = await page.$eval(".tree-root-label", (e) => e.textContent);
  ok(`(12) ルートフォルダ表示は変わらずpublicのまま (rootLabel=${rootLabel})`, rootLabel === "public");

  const iconsExpanded = await page.$eval('.tree-item-folder[title="assets/icons"]', (e) => e.classList.contains("expanded"));
  ok(`(12) 孫階層のファイルを開くとその祖先フォルダ(assets/icons)が自動的に展開される (expanded=${iconsExpanded})`,
    iconsExpanded === true);

  const appRowAfter = await page.$('.tree-item-file[title="assets/icons/app.js"]');
  ok(`(12) 展開後はapp.jsの行がツリーDOMに現れる (${appRowAfter !== null})`, appRowAfter !== null);

  const appIsCurrent = await page.$eval('.tree-item-file[title="assets/icons/app.js"]', (e) => e.classList.contains("current"));
  ok(`(12) app.jsの行がハイライト(current)される (current=${appIsCurrent})`, appIsCurrent === true);

  await page.close();
}

// ============================================================
// (13) 折り返し表示(view.wordWrap)の切替がC#へ永続化されること + 起動時にapply-settingsの
//      wordWrapが反映されること(総点検 指摘M2: 以前はメモリ上の変数だけで、ウィンドウを
//      開き直すたびに既定のONへ戻っていた)
// ============================================================
{
  const page = await newBridgedPage({ width: 1200, height: 800 });

  // (13-a) 初期状態(既定ON)から view.wordWrap を1回実行するとOFFへ切り替わり、
  //        C#へ { type: "set-word-wrap", value: false } が送られる。
  // menu-command実行前に一度メニューを開く必要がある(id→実行関数の対応表が
  // 開くたびに作り直されるため。.verify-nativemenu.mjs (e)と同じ作法)。
  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(200);
  const wrapTextBefore = await page.textContent("#status-wrap");
  await page.evaluate(() => window.__reply({ type: "menu-command", id: "view.wordWrap" }));
  await page.waitForTimeout(150);
  const wrapTextAfterFirst = await page.textContent("#status-wrap");
  ok(`(13-a) 1回目のトグルで折り返し表示が切り替わる "${wrapTextBefore}" -> "${wrapTextAfterFirst}"`,
    wrapTextBefore !== wrapTextAfterFirst);
  let sentWrap = await page.evaluate(() => window.__sent.filter((m) => m.type === "set-word-wrap"));
  ok(`(13-a) 1回目のトグルでset-word-wrapが1件送られる (${JSON.stringify(sentWrap)})`, sentWrap.length === 1);

  // (13-a) もう1回トグルすると元に戻り、逆のvalueで送られる。
  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__reply({ type: "menu-command", id: "view.wordWrap" }));
  await page.waitForTimeout(150);
  sentWrap = await page.evaluate(() => window.__sent.filter((m) => m.type === "set-word-wrap"));
  ok(`(13-a) 2回目のトグルでset-word-wrapが2件送られ、値が反転する (${JSON.stringify(sentWrap)})`,
    sentWrap.length === 2 && sentWrap[0].value === !sentWrap[1].value);

  // (13-b) 新しいウィンドウ(開き直し相当)でapply-settingsのwordWrap:falseを受け取ると、
  //        起動時からOFFで反映される(修正前はmsg.wordWrap自体が存在せず、常に既定のONのままだった)。
  const page2 = await newBridgedPage({ width: 1200, height: 800 });
  await page2.evaluate(() => window.__reply({ type: "apply-settings", wordWrap: false }));
  await page2.waitForTimeout(200);
  const wrapTextAfterApply = await page2.textContent("#status-wrap");
  ok(`(13-b) apply-settingsのwordWrap:falseがステータスバー表示に反映される (実際="${wrapTextAfterApply}")`,
    wrapTextAfterApply.includes("なし"));
  const wrapClassAfterApply = await page2.$eval(".cm-content", (e) => e.classList.contains("cm-lineWrapping"));
  ok(`(13-b) 本文側もCodeMirrorの折り返しが実際にOFFになる (cm-lineWrapping=${wrapClassAfterApply})`,
    wrapClassAfterApply === false);

  await page.close();
  await page2.close();
}

// ============================================================
// ページエラー・コンソールエラー0件
// ============================================================
ok(`ページエラー・コンソールエラー0件 (${allErrors.length + allConsoleErrors.length}件) ${JSON.stringify([...allErrors, ...allConsoleErrors]).slice(0, 3000)}`,
  allErrors.length === 0 && allConsoleErrors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
