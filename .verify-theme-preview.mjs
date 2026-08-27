// 設定画面のテーマ「プレビュー」機能の検証。ポートは8170(未使用ポートから採番)。
//
// 背景(仕様): 設定画面(独立ウィンドウ、settings-window.html/src/settings-entry.js)で
// テーマ(system/light/dark・ライト用/ダーク用プリセット・「ダークモードでは別のテーマを
// 使う」)を選ぶと、保存(save-settings送信)を待たずにその場でプレビューされ、
// 「キャンセル」またはEscapeで閉じると開いた時の値に戻る(設定ファイルには一切書き込まない)。
// 実装は src/settings.js の previewTheme()/revertThemePreview()/snapshotThemeBaseline() と
// Pane/SettingsWindow.cs の "preview-theme" 受け口(ネイティブタイトルバーの塗り直し)。
//
// 反映範囲についての設計判断(詳細はsrc/settings.js側のコメント参照):
//   プレビューは「設定画面自身」(このWebView2の document + ネイティブタイトルバー)に
//   閉じる。本文ウィンドウ(Pane/MainForm.cs・src/main.js)は今回のタスクでは編集禁止
//   (他エージェントが並行編集中)であり、かつ本文ウィンドウは従来どおり保存後にしか
//   テーマが変わらない(=保存前に変化するものが無いので、キャンセルしても戻すべき状態が
//   そもそも存在しない)。複数の本文ウィンドウが開いていても、保存時はPaneApplicationContext.
//   BroadcastSettingsChangedが全ウィンドウへ一律配信する既存の仕組みがそのまま効くため、
//   一部のウィンドウだけプレビューが残るような不整合は起きない。
//
// 構成:
//   (a) テーマ(light/dark)を選ぶと、保存前でも設定画面自身の背景色・data-theme属性が
//       即座に変わる。同時に"preview-theme"がブリッジへ送られ、"save-settings"は
//       一切送られない(設定ファイルは書き換わらない)。
//   (b) ライト用プリセット(lightTheme)を選ぶと同様に即座に変わる。
//   (c) ダーク用プリセット(darkTheme)・「ダークモードでは別のテーマを使う」チェックの
//       組み合わせでも即座に変わる(useSeparateThemeInDarkMode=falseならlightThemeを使う、
//       という既存ロジックとも整合する)。
//   (d) 「キャンセル」を押すと、開いた時のテーマ(データ属性・背景色)へ戻る。
//       このときsave-settingsは一度も送られていないこと(設定ファイル相当が書き換わっていない
//       ことの代替確認)。
//   (e) Escapeキーで閉じても同じくキャンセル扱いで元へ戻る(仕様書 要望4)。
//       ネイティブウィンドウの×(OSタイトルバー)はWinForms側で直接Formを閉じるだけで
//       JSを一切経由しない(Pane/SettingsWindow.csにFormClosingの横取りが無いことをコードで
//       確認済み)。保存はsave-settings送信時にしか起きないため、×で閉じても設定ファイルは
//       書き換わらない=結果としてキャンセルと同じ「戻る」が保証される。ヘッドレスブラウザには
//       ネイティブタイトルバーが無くこの経路を直接クリックできないため、このスイートでは
//       (e)としてEscapeを、(d)としてキャンセルボタンを検証することで実質的に同じ経路
//       (src/settings.jsのrequestClose、内部でrevertThemePreview→destroyの順に呼ぶ)を
//       カバーする。
//   (f) 「保存」した場合は、変更後のテーマがそのまま維持される(戻らない)。
//   (g) ページエラー・コンソールエラーが0件。
import pw from "playwright";
const { chromium } = pw;

const PORT = 8170;
const BASE = `http://localhost:${PORT}/settings-window.html`;

const browser = await chromium.launch();
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c, extra = "") => { console.log(`${c ? "OK  " : "NG  "} ${l}${extra ? " " + extra : ""}`); if (c) okCount++; else ngCount++; };

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

const BASE_SETTINGS = {
  type: "settings",
  theme: "light", lightTheme: "default", darkTheme: "default", useSeparateThemeInDarkMode: true,
  customCssPath: "", editorFontFamily: "", editorMonospaceFontFamily: "",
  editorFontSize: 15, editorLineHeight: 1.7, editorMaxWidthPx: 0, showWordCount: false,
  associatedExtensions: ["md"], keyBindings: {}, fileModeOverrides: {}, perFileModes: {},
  installedFonts: [], monospaceFonts: [], pandocAvailable: false,
  settingsFilePath: "C:/Users/test/AppData/Pane/settings.json",
};

async function newSettingsPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(installMockBridge);
  await page.goto(BASE);
  await page.waitForTimeout(400);
  await page.evaluate((s) => window.__reply(s), BASE_SETTINGS);
  await page.waitForTimeout(300);
  // 「外観」カテゴリへ移動(テーマ項目はここにある)
  const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
  const idx = cats.indexOf("外観");
  await page.click(`.settings-nav-item >> nth=${idx}`);
  await page.waitForTimeout(150);
  return page;
}

const bodyBg = (page) => page.$eval("body", (e) => getComputedStyle(e).backgroundColor);
const themeAttrs = (page) => page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  lightTheme: document.documentElement.dataset.lightTheme,
  darkTheme: document.documentElement.dataset.darkTheme,
}));
const sentTypes = (page) => page.evaluate(() => window.__sent.map((m) => m.type));
const lastPreviewIsDark = (page) => page.evaluate(() => {
  const previews = window.__sent.filter((m) => m.type === "preview-theme");
  return previews.length ? previews[previews.length - 1].isDark : undefined;
});

// ============================================================
// (a) テーマ(light→dark)を選ぶと即座に反映される。save-settingsは送られない
// ============================================================
{
  const page = await newSettingsPage();
  const bgBefore = await bodyBg(page);
  const attrsBefore = await themeAttrs(page);
  ok(`(前提) 開いた直後はtheme=light`, attrsBefore.theme === "light", JSON.stringify(attrsBefore));

  await page.selectOption('[data-field="theme"]', "dark");
  await page.waitForTimeout(200);

  const attrsAfter = await themeAttrs(page);
  const bgAfter = await bodyBg(page);
  ok(`(a) 選んだ瞬間にdata-theme=darkへ変わる`, attrsAfter.theme === "dark", JSON.stringify(attrsAfter));
  ok(`(a) 選んだ瞬間に背景色が変わる (${bgBefore} -> ${bgAfter})`, bgBefore !== bgAfter);
  ok(`(a) "preview-theme"がisDark:trueで送られる`, (await lastPreviewIsDark(page)) === true);
  ok(`(a) この時点でsave-settingsは一度も送られていない(設定ファイル未変更)`, !(await sentTypes(page)).includes("save-settings"));

  await page.close();
}

// ============================================================
// (b) ライト用プリセット(lightTheme: sepia)を選ぶと即座に反映される
// ============================================================
{
  const page = await newSettingsPage();
  const bgBefore = await bodyBg(page);
  await page.selectOption('[data-field="lightTheme"]', "sepia");
  await page.waitForTimeout(200);
  const attrs = await themeAttrs(page);
  const bgAfter = await bodyBg(page);
  ok(`(b) data-light-theme=sepiaへ変わる`, attrs.lightTheme === "sepia", JSON.stringify(attrs));
  ok(`(b) 背景色が変わる (${bgBefore} -> ${bgAfter})`, bgBefore !== bgAfter);
  ok(`(b) save-settingsは送られない`, !(await sentTypes(page)).includes("save-settings"));
  await page.close();
}

// ============================================================
// (c) ダーク用プリセット + useSeparateThemeInDarkMode の組み合わせ
// ============================================================
{
  const page = await newSettingsPage();
  await page.selectOption('[data-field="theme"]', "dark");
  await page.waitForTimeout(150);
  await page.selectOption('[data-field="darkTheme"]', "nord");
  await page.waitForTimeout(150);
  let attrs = await themeAttrs(page);
  ok(`(c) useSeparateThemeInDarkMode=true(既定)ではdarkThemeがそのまま使われる`, attrs.darkTheme === "nord", JSON.stringify(attrs));

  // 「ダークモードでは別のテーマを使う」を外すと、lightThemeの選択(default)が使われる
  // (main.jsのapply-settings受信と同じロジック。src/settings.js applyThemeValues参照)。
  await page.click('[data-field="useSeparateThemeInDarkMode"]');
  await page.waitForTimeout(150);
  attrs = await themeAttrs(page);
  ok(`(c) useSeparateThemeInDarkMode=falseにするとdarkThemeにlightThemeの値が使われる`, attrs.darkTheme === "default", JSON.stringify(attrs));
  ok(`(c) ここでもsave-settingsは送られない`, !(await sentTypes(page)).includes("save-settings"));
  await page.close();
}

// ============================================================
// (d) キャンセルすると開いた時のテーマへ戻る。save-settingsは一度も送られない
// ============================================================
{
  const page = await newSettingsPage();
  const bgBefore = await bodyBg(page);
  const attrsBefore = await themeAttrs(page);

  await page.selectOption('[data-field="theme"]', "dark");
  await page.selectOption('[data-field="darkTheme"]', "dracula");
  await page.waitForTimeout(200);
  const bgChanged = await bodyBg(page);
  ok(`(前提) キャンセル前は背景色が変わっている`, bgChanged !== bgBefore);

  // 未保存の変更があるため「閉じますか?」の確認(paneConfirm、danger:trueの「閉じる」ボタン)
  // が挟まる。それを確定してから戻る。
  await page.click('[data-act="cancel"]');
  await page.waitForTimeout(150);
  await page.click(".pane-dialog-btn-danger");
  await page.waitForTimeout(250);

  const attrsAfter = await themeAttrs(page);
  const bgAfter = await bodyBg(page);
  ok(`(d) キャンセルでdata-theme等が開いた時の値へ戻る`, JSON.stringify(attrsAfter) === JSON.stringify(attrsBefore), `before=${JSON.stringify(attrsBefore)} after=${JSON.stringify(attrsAfter)}`);
  ok(`(d) キャンセルで背景色が開いた時の色へ戻る (${bgChanged} -> ${bgAfter}, 開いた時=${bgBefore})`, bgAfter === bgBefore);
  ok(`(d) キャンセルでも最後のpreview-themeはisDark:falseへ戻る`, (await lastPreviewIsDark(page)) === false);
  ok(`(d) save-settingsは一度も送られていない(=設定ファイルは書き換わらない)`, !(await sentTypes(page)).includes("save-settings"));
  ok(`(d-付随) ウィンドウを閉じるよう依頼している`, (await sentTypes(page)).includes("close-settings-window"));
  await page.close();
}

// ============================================================
// (e) Escapeキーで閉じても同じく元へ戻る
// ============================================================
{
  const page = await newSettingsPage();
  const bgBefore = await bodyBg(page);
  const attrsBefore = await themeAttrs(page);

  await page.selectOption('[data-field="theme"]', "dark");
  await page.selectOption('[data-field="lightTheme"]', "github");
  await page.waitForTimeout(200);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  // Escapeでも同じrequestClose()を通るため、未保存の変更があれば同じ確認ダイアログが挟まる。
  await page.click(".pane-dialog-btn-danger");
  await page.waitForTimeout(250);

  const attrsAfter = await themeAttrs(page);
  const bgAfter = await bodyBg(page);
  ok(`(e) Escapeでdata-theme等が開いた時の値へ戻る`, JSON.stringify(attrsAfter) === JSON.stringify(attrsBefore), `before=${JSON.stringify(attrsBefore)} after=${JSON.stringify(attrsAfter)}`);
  ok(`(e) Escapeで背景色も開いた時の色へ戻る`, bgAfter === bgBefore);
  ok(`(e) save-settingsは一度も送られていない`, !(await sentTypes(page)).includes("save-settings"));
  await page.close();
}

// ============================================================
// (f) 保存した場合は変更後のテーマが維持される(戻らない)
// ============================================================
{
  const page = await newSettingsPage();
  const attrsBefore = await themeAttrs(page);
  await page.selectOption('[data-field="theme"]', "dark");
  await page.selectOption('[data-field="darkTheme"]', "night");
  await page.waitForTimeout(200);
  const attrsPreview = await themeAttrs(page);
  ok(`(前提) 保存前のプレビューでdark/nightになっている`, attrsPreview.theme === "dark" && attrsPreview.darkTheme === "night", JSON.stringify(attrsPreview));

  await page.click('[data-act="save"]');
  await page.waitForTimeout(150);
  const sentSave = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings").pop());
  ok(`(f) save-settingsが選んだ通りの値で送られる`, sentSave?.settings?.theme === "dark" && sentSave?.settings?.darkTheme === "night", JSON.stringify(sentSave?.settings ?? null));

  await page.evaluate(() => window.__reply({ type: "save-settings-result", ok: true }));
  await page.waitForTimeout(200);

  const attrsAfterSave = await themeAttrs(page);
  ok(`(f) 保存成功後もテーマは変更後の値のまま(開いた時の値へは戻らない)`, attrsAfterSave.theme === "dark" && attrsAfterSave.darkTheme === "night", JSON.stringify(attrsAfterSave));
  ok(`(f) 保存前の値(${JSON.stringify(attrsBefore)})とは異なる`, JSON.stringify(attrsAfterSave) !== JSON.stringify(attrsBefore));
  await page.close();
}

// ============================================================
// (g) ページエラー・コンソールエラーが0件
// ============================================================
console.log("--- エラー:", JSON.stringify(errors));
ok("(g) ページエラー・コンソールエラーが0件", errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
