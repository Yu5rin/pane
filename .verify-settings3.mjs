// 編集モードの自動判定(autoDetectMode)・フォント選択(installedFonts/monospaceFonts)の検証。
// .verify-settings.mjs / .verify-settings2.mjs / .verify-settingswindow.mjs と同じ流儀。
// 設定画面は独立ウィンドウ(settings-window.html / Pane/SettingsWindow.cs)になったため、
// 本文側のCtrl+,ではなく設定ウィンドウのページを直接開いて検証する。ポートのみ8146を使う。
// pageモード(専用ウィンドウ)は「閉じる」= ウィンドウそのものを閉じる想定のため、
// 送信内容を変える場合は都度「新しいページで開き直して→settingsを返す」手順を踏む。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

async function newSettingsPage() {
  const p = await browser.newPage();
  p.on("pageerror", (e) => errors.push(String(e.stack || e)));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  p.on("dialog", (d) => d.accept()); // 未保存確認ダイアログは常にOK
  await p.addInitScript(() => {
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
  await p.goto("http://localhost:8146/settings-window.html");
  await p.waitForTimeout(700);
  return p;
}

let page = await newSettingsPage();

const BASE_SETTINGS = {
  type: "settings",
  theme: "light", editorFontSize: 15, editorFontFamily: "", startupBehavior: "blank",
  calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
  inlineMathEnabled: true, mathAutoNumberEnabled: false, strictMode: false,
  codeBlockLineNumbers: true, autoPairing: true, showWordCount: true,
  defaultCopyFormat: "markdown", preloadOnStartup: false,
  associatedExtensions: ["md", "py"], keyBindings: {},
  defaultEncoding: "utf-8", defaultLineEnding: "crlf", displayMode: "window",
  lightTheme: "default", darkTheme: "default", customCssPath: "",
};

async function catIndex(label) {
  const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
  return cats.findIndex((c) => c.includes(label));
}
async function gotoCategory(label) {
  const idx = await catIndex(label);
  await page.click(`.settings-nav-item >> nth=${idx}`);
  await page.waitForTimeout(300);
  return idx;
}

// ==== セッション1: autoDetectMode未指定 → (a)(b) ====
// settings-window.htmlは読み込み直後に自動でopen()され、get-settingsを送信する
// (index.htmlのCtrl+,のような明示操作は不要)。
ok("設定画面が開く", (await page.$(".settings-modal")) !== null);
ok("(前提) 読み込み直後にget-settingsを送信", await page.evaluate(() => window.__sent.some((m) => m.type === "get-settings")));
await page.evaluate((s) => window.__reply(s), BASE_SETTINGS);
await page.waitForTimeout(400);

const editIdx = await gotoCategory("編集");
ok(`「編集」カテゴリがある (idx=${editIdx})`, editIdx >= 0);

const values = await page.$$eval('input[type="radio"][name="autoDetectMode"]', (e) => e.map((x) => x.value));
ok(`(a) autoDetectModeのラジオが4つ ${JSON.stringify(values)}`,
  values.length === 4 && ["off", "suggest", "standard", "aggressive"].every((v) => values.includes(v)));

const checkedNone = await page.$eval('input[type="radio"][name="autoDetectMode"]:checked', (e) => e.value).catch(() => null);
ok(`(b) autoDetectMode未指定でstandardが選択 (${checkedNone})`, checkedNone === "standard");

await page.close();

// ==== セッション2: autoDetectMode:"suggest" + installedFonts/monospaceFonts + editorFontFamily:"Old Font" ====
// pageモード(専用ウィンドウ)は開くたびに新しいウィンドウ = 新しいページとして開き直す。
page = await newSettingsPage();
await page.evaluate((s) => window.__reply(s), {
  ...BASE_SETTINGS,
  autoDetectMode: "suggest",
  editorFontFamily: "Old Font",
  installedFonts: ["Meiryo", "Yu Gothic UI", "Consolas"],
  monospaceFonts: ["Consolas"],
});
await page.waitForTimeout(400);

await gotoCategory("編集");
const checkedSuggest = await page.$eval('input[type="radio"][name="autoDetectMode"]:checked', (e) => e.value).catch(() => null);
ok(`(c) autoDetectMode:"suggest"がラジオへ反映 (${checkedSuggest})`, checkedSuggest === "suggest");
await page.check('input[type="radio"][name="autoDetectMode"][value="aggressive"]');
await page.waitForTimeout(100);

const appearanceIdx = await gotoCategory("外観");
ok(`「外観」カテゴリがある (idx=${appearanceIdx})`, appearanceIdx >= 0);

const bodyOptions = await page.$$eval('select[data-field="editorFontFamily"] option', (e) => e.map((o) => ({ v: o.value, t: o.textContent.trim() })));
const monoOptions = await page.$$eval('select[data-field="editorMonospaceFontFamily"] option', (e) => e.map((o) => ({ v: o.value, t: o.textContent.trim() })));
ok(`(e) 本文フォントに(既定)+installedFonts3件+保存済み値(Old Font) ${JSON.stringify(bodyOptions)}`,
  bodyOptions.length === 5 && bodyOptions[0].v === "" &&
  ["Meiryo", "Yu Gothic UI", "Consolas", "Old Font"].every((n) => bodyOptions.some((o) => o.v === n)));
ok(`(i) 保存済みのeditorFontFamily("Old Font")が選択肢にあり選択状態を保つ ${JSON.stringify(bodyOptions)}`,
  bodyOptions.some((o) => o.v === "Old Font"));
const bodySelected = await page.$eval('select[data-field="editorFontFamily"]', (e) => e.value);
ok(`(i) 本文フォントの初期選択がOld Font (${bodySelected})`, bodySelected === "Old Font");
ok(`(e) 等幅フォントに(既定)+monospaceFonts1件 ${JSON.stringify(monoOptions)}`,
  monoOptions.length === 2 && monoOptions[0].v === "" && monoOptions.some((o) => o.v === "Consolas"));

const previewBefore = await page.$eval('[data-font-preview-target="editorFontFamily"]', (e) => e.style.fontFamily);
ok(`(j) 初期プレビューがOld Fontを反映 ("${previewBefore}")`, previewBefore.includes("Old Font"));
await page.selectOption('select[data-field="editorFontFamily"]', "Meiryo");
await page.waitForTimeout(100);
const previewAfter = await page.$eval('[data-font-preview-target="editorFontFamily"]', (e) => e.style.fontFamily);
ok(`(j) 選択変更で即座にプレビューが反映 ("${previewAfter}")`, previewAfter.includes("Meiryo"));

await page.selectOption('select[data-field="editorMonospaceFontFamily"]', "Consolas");
await page.waitForTimeout(100);

await page.click('[data-act="save"]');
await page.waitForTimeout(300);
const saved1 = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings").pop());
const savedSettings1 = saved1?.settings ?? saved1;
ok("save-settingsを送信", !!saved1);
ok(`(d) autoDetectMode:"aggressive"が保存内容に含まれる (${savedSettings1?.autoDetectMode})`, savedSettings1?.autoDetectMode === "aggressive");
ok(`(f) editorFontFamily:"Meiryo"が保存内容に含まれる (${savedSettings1?.editorFontFamily})`, savedSettings1?.editorFontFamily === "Meiryo");
ok(`(g) editorMonospaceFontFamily:"Consolas"が保存内容に含まれる (${savedSettings1?.editorMonospaceFontFamily})`, savedSettings1?.editorMonospaceFontFamily === "Consolas");
ok(`(k) installedFontsが保存内容に含まれない`, !("installedFonts" in (savedSettings1 ?? {})));
ok(`(k) monospaceFontsが保存内容に含まれない`, !("monospaceFonts" in (savedSettings1 ?? {})));
// C#役として保存成功を返す→handleSaveResultがウィンドウを閉じようとする(close-settings-window送信)。
await page.evaluate(() => window.__reply({ type: "save-settings-result", ok: true }));
await page.waitForTimeout(200);
await page.close();

// ==== セッション3: installedFonts未送信 → (h)テキスト入力にフォールバック ====
page = await newSettingsPage();
await page.evaluate((s) => window.__reply(s), BASE_SETTINGS); // installedFonts/monospaceFontsなし
await page.waitForTimeout(400);
await gotoCategory("外観");

const hasSelect = (await page.$('select[data-field="editorFontFamily"]')) !== null;
const hasInput = (await page.$('input[type="text"][data-field="editorFontFamily"]')) !== null;
ok(`(h) installedFonts未送信でテキスト入力にフォールバック (select=${hasSelect}, input=${hasInput})`, !hasSelect && hasInput);
await page.fill('input[type="text"][data-field="editorFontFamily"]', "MyCustomFont");
await page.waitForTimeout(100);
const previewFallback = await page.$eval('[data-font-preview-target="editorFontFamily"]', (e) => e.style.fontFamily);
ok(`(j) フォールバック時もプレビューが反映 ("${previewFallback}")`, previewFallback.includes("MyCustomFont"));

await page.click('[data-act="save"]');
await page.waitForTimeout(300);
const saved2 = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings").pop());
const savedSettings2 = saved2?.settings ?? saved2;
ok(`(h) フォールバック入力値がeditorFontFamilyに反映される (${savedSettings2?.editorFontFamily})`, savedSettings2?.editorFontFamily === "MyCustomFont");
ok(`(k) このケースでもinstalledFonts/monospaceFontsが含まれない`,
  !("installedFonts" in (savedSettings2 ?? {})) && !("monospaceFonts" in (savedSettings2 ?? {})));

ok("(m) ページエラー・コンソールエラーが0件", errors.length === 0);
if (errors.length) console.log("--- エラー:", JSON.stringify(errors));

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
