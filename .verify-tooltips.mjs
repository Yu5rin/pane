// ツールチップの詳しさ(依頼2、設定tooltipDetail)の実ブラウザ検証。
// .verify-mainsettings.mjs等と同じ流儀(WebView2ブリッジをモックし、apply-settings等を
// window.__reply()で流し込む)。ポートは8170。
//
// 検証項目(タスク指示より):
//   (1) tooltipDetailを4段階に切り替えると、実際にtitle属性の内容が変わること(主要な要素で実測)
//   (2) noneでツールチップが一切出ないこと
//   (3) 既定がstandardであること
//   (4) 設定を変えた後、設定画面を閉じずに、本文側のツールチップが変わること(即時反映)
//   (5) 文言テーブルに無い要素が、決めたフォールバック規則どおりに振る舞うこと
//   (6) ページエラー・コンソールエラーが0件であること
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const PORT = 8170;
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

// ---- (A) ブリッジあり: apply-settingsでtooltipDetailを流し込み、本文側の各要素を実測する ----
async function newBridgedPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
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
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(700);
  return page;
}
async function applySettings(page, partial) {
  await page.evaluate((partial) => window.__reply({ type: "apply-settings", ...partial }), partial);
  await page.waitForTimeout(200);
}
async function titleOf(page, sel) {
  return page.$eval(sel, (el) => el.title);
}

{
  const page = await newBridgedPage();

  // ---- (3) 既定はstandard(apply-settingsを一度も送らない状態) ----
  const initialSettingsTitle = await titleOf(page, "#btn-menu-settings");
  ok(`(3) 既定(apply-settings未受信)でstandardの文言 "${initialSettingsTitle}"`,
    initialSettingsTitle === "設定画面を開きます (Ctrl+,)");

  // apply-settingsに他の必須項目も一緒に送る(showStatusBar等がfalse化しないよう既定値を明示)。
  const BASE_SETTINGS = { showStatusBar: true, displayMode: "window" };

  // ---- (5) テーブルに無い要素のフォールバック(=既存title属性のまま。noneだけ空にする) ----
  await page.evaluate(() => {
    const el = document.createElement("button");
    el.id = "test-fallback-el";
    el.title = "もともとの説明文です";
    document.body.appendChild(el);
  });

  // ---- standard(既定値のまま明示指定) ----
  await applySettings(page, { ...BASE_SETTINGS, tooltipDetail: "standard" });
  const stdTheme = await titleOf(page, "#btn-theme");
  const stdHelp = await titleOf(page, "#btn-menu-help");
  const stdOutline = await titleOf(page, '[data-tip="sidebar-tab-outline"]');
  const stdFiles = await titleOf(page, '[data-tip="sidebar-tab-files"]');
  const stdFallback = await titleOf(page, "#test-fallback-el");
  ok(`(1) standard: テーマ切替 "${stdTheme}"`, stdTheme === "ライトテーマとダークテーマを切り替えます");
  ok(`(1) standard: ヘルプ "${stdHelp}"`, stdHelp === "ヘルプメニューを開きます");
  ok(`(1) standard: サイドバー(アウトライン)にショートカット付記 "${stdOutline}"`,
    stdOutline === "見出しの一覧(アウトライン)を表示します (Ctrl+Shift+1)");
  // 指摘2: サイドバー「ファイル」タブは、実装上は読み込んだフォルダ内のファイルの平坦な一覧であり
  // (sidebar.js renderFiles、仕様書 S-02)、ファイルメニューの「最近使ったファイル」とは別物。
  // 「最近使ったファイル」を指すかのような文言に戻っていないかをここで固定する。
  ok(`(2) サイドバー「ファイルリスト」タブが「最近使ったファイル」と説明されていない "${stdFiles}"`,
    !stdFiles.includes("最近使った") && !stdFiles.includes("最近開いた"));
  ok(`(5) standard: テーブルに無い要素は元のtitleのまま "${stdFallback}"`, stdFallback === "もともとの説明文です");

  // ---- detailed ----
  await applySettings(page, { ...BASE_SETTINGS, tooltipDetail: "detailed" });
  const detTheme = await titleOf(page, "#btn-theme");
  const detHelp = await titleOf(page, "#btn-menu-help");
  const detFallback = await titleOf(page, "#test-fallback-el");
  ok(`(1) detailedでstandardと異なる文言になる ("${detTheme}")`, detTheme.length > stdTheme.length && detTheme !== stdTheme);
  ok(`(1) detailed: ヘルプの説明が詳しくなる "${detHelp}"`, detHelp.includes("バージョン情報"));
  ok(`(5) detailed: テーブルに無い要素も元のtitleのまま "${detFallback}"`, detFallback === "もともとの説明文です");

  // ---- minimal(状態を示す情報が中心。アイコンのみボタンは名前のみ) ----
  await applySettings(page, { ...BASE_SETTINGS, tooltipDetail: "minimal" });
  const minTheme = await titleOf(page, "#btn-theme");
  const minSettings = await titleOf(page, "#btn-menu-settings");
  ok(`(1) minimal: アイコンのみボタンは名前のみ "${minTheme}"`, minTheme === "テーマ切替");
  ok(`(1) minimal: ショートカットは付記されたまま "${minSettings}"`, minSettings === "設定 (Ctrl+,)");

  // ---- minimalでの「状態」表示(文字コード・改行コード・拡大率等) ----
  await page.evaluate(() => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md", text: "hello",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }));
  await page.waitForTimeout(300);
  const minEncoding = await titleOf(page, "#status-encoding");
  const minLineEnding = await titleOf(page, "#status-line-ending");
  const minZoom = await titleOf(page, "#status-zoom");
  ok(`(1) minimal: 文字コードは現在値のみ "${minEncoding}"`, minEncoding === "UTF-8");
  ok(`(1) minimal: 改行コードは現在値のみ "${minLineEnding}"`, minLineEnding === "CRLF");
  ok(`(1) minimal: 拡大率は現在値のみ "${minZoom}"`, minZoom === "100%");
  // standardに戻すと状態+説明文になる(説明側で現在値そのものは繰り返さない)。
  await applySettings(page, { ...BASE_SETTINGS, tooltipDetail: "standard" });
  const stdEncodingAfterOpen = await titleOf(page, "#status-encoding");
  ok(`(1) standardに戻すと文字コードの説明文になる "${stdEncodingAfterOpen}"`,
    stdEncodingAfterOpen.includes("文字コード") && stdEncodingAfterOpen !== "UTF-8");

  // ---- (2) none: 一切出ない(テーブルの有無に関わらず) ----
  await applySettings(page, { ...BASE_SETTINGS, tooltipDetail: "none" });
  const noneTheme = await titleOf(page, "#btn-theme");
  const noneHelp = await titleOf(page, "#btn-menu-help");
  const noneEncoding = await titleOf(page, "#status-encoding");
  const noneFallback = await titleOf(page, "#test-fallback-el");
  const noneOutline = await titleOf(page, '[data-tip="sidebar-tab-outline"]');
  ok(`(2) none: テーマ切替が空 "${noneTheme}"`, noneTheme === "");
  ok(`(2) none: ヘルプが空 "${noneHelp}"`, noneHelp === "");
  ok(`(2) none: 文字コードが空 "${noneEncoding}"`, noneEncoding === "");
  ok(`(2) none: テーブルに無い要素も空になる(フォールバック規則どおり) "${noneFallback}"`, noneFallback === "");
  ok(`(2) none: data-tip要素(サイドバータブ)も空 "${noneOutline}"`, noneOutline === "");

  ok("(6-a) ページエラー・コンソールエラーが0件(ブリッジ経由の一連の検証)", errors.length === 0);
  await page.close();
}

// ---- (B) ブリッジ無し: 設定画面(HTML製モーダル)を開いての即時反映・設定項目自体のツールチップ検証 ----
{
  const page = await browser.newPage();
  const localErrors = [];
  page.on("pageerror", (e) => localErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") localErrors.push("console: " + m.text()); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(700);

  // ブリッジ無し(ブラウザ単体動作)では、設定ボタンを押すとHTML製モーダルが本文と
  // 同じ文書に開く(src/main.js openSettings参照)。既定はstandardのはず。
  await page.click("#btn-menu-settings");
  await page.waitForTimeout(400);
  ok("(B前提) 設定画面(モーダル)が開く", (await page.$(".settings-modal")) !== null);

  const settingsTitleBeforeChange = await titleOf(page, "#btn-menu-settings");
  ok(`(3) モーダルを開いた直後も既定standardの文言のまま "${settingsTitleBeforeChange}"`,
    settingsTitleBeforeChange === "設定画面を開きます (Ctrl+,)");

  // ---- 設定画面自身の項目(チェックボックス)のツールチップ ----
  // 「一般」カテゴリの「ステータスバーを表示」チェックボックス(data-tip="showStatusBar")。
  const showStatusBarTitleStd = await page.$eval('[data-tip="showStatusBar"]', (el) => el.title);
  ok(`(設定画面) standardで項目自体にもツールチップが付く "${showStatusBarTitleStd}"`, showStatusBarTitleStd.length > 0);

  // ---- 指摘1: 自動保存はスナップショット方式であり、元ファイルを上書きしない(Pane/AutoSaveService.cs参照)。
  // 「自動的に上書き保存します」のような、元ファイルが書き変わる誤解を招く表現になっていないか確認する。
  // tooltipDetailセレクト自体は「一般」カテゴリにしか無いため、カテゴリを切り替える前に変更する。
  await page.selectOption('[data-field="tooltipDetail"]', "detailed");
  await page.waitForTimeout(200);
  await page.click('[data-cat="file"]');
  await page.waitForTimeout(100);
  const autoSaveTitleDetailed = await page.$eval('[data-tip="autoSaveEnabled"]', (el) => el.title);
  ok(`(自動保存) 「上書き保存」という表現が無い "${autoSaveTitleDetailed}"`,
    !autoSaveTitleDetailed.includes("上書き保存"));
  ok("(自動保存) バックアップ(スナップショット)であることに触れている",
    autoSaveTitleDetailed.includes("バックアップ") || autoSaveTitleDetailed.includes("スナップショット"));
  ok("(自動保存) 元のファイルを書き換えない旨に触れている",
    autoSaveTitleDetailed.includes("元のファイル"));
  // 後続の検証は「一般」カテゴリの項目を見るため、カテゴリを元に戻しておく。
  await page.click('[data-cat="general"]');
  await page.waitForTimeout(100);

  // ---- (4) 設定画面を閉じずに、tooltipDetailセレクトを変更 → 本文側に即時反映 ----
  await page.selectOption('[data-field="tooltipDetail"]', "detailed");
  await page.waitForTimeout(200);
  // 設定画面はまだ開いたまま(閉じていない)ことを確認したうえで、本文側(メニューバー)を見る。
  const stillOpen = (await page.$(".settings-modal")) !== null;
  ok("(4前提) 変更後も設定画面は閉じていない", stillOpen);
  const themeTitleAfterPreview = await titleOf(page, "#btn-theme");
  ok(`(4) 保存せず選択しただけで本文側のツールチップが変わる "${themeTitleAfterPreview}"`,
    themeTitleAfterPreview.includes("次回Pane") || themeTitleAfterPreview.includes("保存され"));

  // ---- minimal/noneでは設定画面自身の項目のツールチップは出さない(ラベルで分かるため) ----
  await page.selectOption('[data-field="tooltipDetail"]', "minimal");
  await page.waitForTimeout(200);
  const showStatusBarTitleMinimal = await page.$eval('[data-tip="showStatusBar"]', (el) => el.title);
  ok(`(minimal) 設定画面の項目はツールチップを出さない "${showStatusBarTitleMinimal}"`, showStatusBarTitleMinimal === "");

  await page.selectOption('[data-field="tooltipDetail"]', "none");
  await page.waitForTimeout(200);
  const showStatusBarTitleNone = await page.$eval('[data-tip="showStatusBar"]', (el) => el.title);
  const themeTitleNone = await titleOf(page, "#btn-theme");
  ok(`(2) none: 設定画面の項目も空 "${showStatusBarTitleNone}"`, showStatusBarTitleNone === "");
  ok("(2) none: 本文側(未保存プレビュー)も空", themeTitleNone === "");

  // ---- キャンセルで閉じると、開いた時点(standard)へ戻る ----
  await page.selectOption('[data-field="tooltipDetail"]', "detailed");
  await page.waitForTimeout(200);
  await page.click('[data-act="cancel"]');
  await page.waitForTimeout(200);
  // 未保存の変更があるため「閉じますか?」の確認ダイアログが出る。danger付きの「閉じる」を押す。
  await page.click(".pane-dialog-btn-danger");
  await page.waitForTimeout(300);
  const themeTitleAfterCancel = await titleOf(page, "#btn-theme");
  ok(`(取り消し) キャンセルで閉じると本文側も開いた時点(standard)へ戻る "${themeTitleAfterCancel}"`,
    themeTitleAfterCancel === "ライトテーマとダークテーマを切り替えます");

  ok("(6-b) ページエラー・コンソールエラーが0件(ブリッジ無し・設定画面の検証)", localErrors.length === 0);
  await page.close();
}

console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
