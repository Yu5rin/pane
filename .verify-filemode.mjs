import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

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
await page.goto("http://localhost:8142/index.html");
await page.waitForTimeout(800);

const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

const SAMPLE = "# 見出し\n\n本文です。\n";

async function open(fileName, path, extra = {}) {
  await page.evaluate(({ fileName, path, text, extra }) => window.__reply({
    type: "file-opened", fileName, path, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
    ...extra,
  }), { fileName, path, text: SAMPLE, extra });
  await page.waitForTimeout(500);
}

function mode() {
  return page.textContent("#status-mode");
}

// (a) 無題の新規文書がMarkdown
await page.evaluate(() => window.__reply({ type: "new-document" }));
await page.waitForTimeout(400);
ok(`(a) 無題の新規文書が Markdown: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");

// (b) 拡張子による既定判定
await open("sample.js", "C:\\work\\sample.js");
ok(`(b) sample.js が コード: ${JSON.stringify(await mode())}`, (await mode()).startsWith("コード"));
await open("sample.md", "C:\\work\\sample.md");
ok(`(b) sample.md が Markdown: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");
await open("sample.txt", "C:\\work\\sample.txt");
ok(`(b) sample.txt が プレーンテキスト: ${JSON.stringify(await mode())}`, (await mode()) === "プレーンテキスト");

// (c) 無題の新規文書を script.js として保存 → モード再判定(不具合1の修正確認)
await page.evaluate(() => window.__reply({ type: "new-document" }));
await page.waitForTimeout(400);
const beforeSaveMode = await mode();
await page.evaluate(() => window.__reply({
  type: "save-result", ok: true, fileName: "script.js", path: "C:\\work\\script.js",
  encoding: "UTF-8", lineEnding: "CRLF",
}));
await page.waitForTimeout(500);
ok(`(c) 無題(${beforeSaveMode})をscript.jsとして保存後 コード: ${JSON.stringify(await mode())}`, (await mode()).startsWith("コード"));

// (d) sample.js を開いた状態で 表示メニュー→Markdownモード → remember-file-mode送信を確認
await open("sample.js", "C:\\work\\sample.js");
await page.evaluate(() => { window.__sent.length = 0; });
await page.click(".cm-content");
// ブリッジがある状態ではメニューはネイティブポップアップ経路になる(HTMLの
// .menu-dropdownは作られない)。見出しをクリックしてopen-menuを送らせ、
// C#役として menu-command を返してコマンドを実行させる。
await page.click("#menubar .menu-top:text('表示')");
await page.waitForTimeout(250);
await page.evaluate(() => window.__reply({ type: "menu-command", id: "view.modeMarkdown" }));
await page.waitForTimeout(400);
const sentD = await page.evaluate(() => window.__sent.filter((m) => m.type === "remember-file-mode"));
ok(`(d) remember-file-mode送信: ${JSON.stringify(sentD)}`,
  sentD.length === 1 && sentD[0].path === "C:\\work\\sample.js" && sentD[0].mode === "markdown");
ok(`(d) モード表示もMarkdownに変わる: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");

// (e) apply-settings で perFileModes を流してから sample.js を開き直す → Markdown
// まず(d)でのローカルキャッシュ副作用を打ち消すため、空のperFileModesを一度流して
// 拡張子既定(コード)に戻ることを確認してから、本題のperFileModesを流す
// (そうしないと、ローカルキャッシュが既にmarkdownを覚えている可能性があり、
//  apply-settings受信処理自体が効いているかの検証にならないため)。
await page.evaluate(() => window.__reply({ type: "apply-settings", perFileModes: {} }));
await page.waitForTimeout(300);
await open("sample.js", "C:\\work\\sample.js");
ok(`(e-前提) 空のperFileModes適用直後は拡張子既定でコード: ${JSON.stringify(await mode())}`, (await mode()).startsWith("コード"));
await page.evaluate(() => window.__reply({
  type: "apply-settings",
  perFileModes: { "C:\\work\\sample.js": "markdown" },
}));
await page.waitForTimeout(300);
await open("sample.js", "C:\\work\\sample.js"); // 開き直し(モードは拡張子判定なら本来コードのはず)
ok(`(e) perFileModes記憶により Markdown: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");

// (f) apply-settings で fileModeOverrides を流してから sample.js を開く → Markdown
await page.evaluate(() => window.__reply({
  type: "apply-settings",
  perFileModes: {}, // (e)の記憶をリセットして、今度はfileModeOverridesの効果だけを見る
  fileModeOverrides: { js: "markdown" },
}));
await page.waitForTimeout(300);
await open("sample.js", "C:\\work\\sample.js");
ok(`(f) fileModeOverrides(js→markdown)により Markdown: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");

// 後片付け: overridesをリセットし、(g)のためsample.jsを素の状態(コード)に戻しておく
await page.evaluate(() => window.__reply({
  type: "apply-settings", perFileModes: {}, fileModeOverrides: {},
}));
await page.waitForTimeout(300);

// (g) 手動で選んだモードが自動判定と一致する場合、remember-file-modeのmodeがnullで送られる
await open("sample.js", "C:\\work\\sample.js"); // 自動判定=コード
await page.evaluate(() => { window.__sent.length = 0; });
await page.click(".cm-content");
await page.click("#menubar .menu-top:text('表示')");
await page.waitForTimeout(250);
await page.evaluate(() => window.__reply({ type: "menu-command", id: "view.modeCode" })); // 自動判定と同じ選択
await page.waitForTimeout(400);
const sentG = await page.evaluate(() => window.__sent.filter((m) => m.type === "remember-file-mode"));
ok(`(g) 自動判定と同じ選択でmode:nullが送られる: ${JSON.stringify(sentG)}`,
  sentG.length === 1 && sentG[0].path === "C:\\work\\sample.js" && sentG[0].mode === null);

// ============================================================
// (i) 仕様書 第8.3節(不具合修正): C#側がforcePlainMode:trueを付けた大容量ファイルは、
//     拡張子・per-file記憶(perFileModes)に関わらずプレーンテキストで開く
// ============================================================
{
  // 前段(f)の後片付けで perFileModes/fileModeOverrides は空になっている前提。
  // まず素の状態(forcePlainMode無し)でsample.mdがMarkdownになることを確認してから、
  // 同じファイルにforcePlainMode:trueを付けて開き直す。
  await open("sample.md", "C:\\work\\sample.md");
  ok(`(i-前提) forcePlainMode無しのsample.mdはMarkdown: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");

  await open("huge.md", "C:\\work\\huge.md", { forcePlainMode: true });
  ok(
    `(i) forcePlainMode:trueの.mdファイルは拡張子に関わらずプレーンテキストになる: ${JSON.stringify(await mode())}`,
    (await mode()) === "プレーンテキスト(大容量のため自動)",
  );

  // per-file記憶(このパスは以前手動でmarkdownに固定されている、仕様書 第1章)があっても、
  // forcePlainModeが優先される。
  await page.evaluate(() => window.__reply({
    type: "apply-settings", perFileModes: { "C:\\work\\huge.md": "markdown" },
  }));
  await page.waitForTimeout(300);
  await open("huge.md", "C:\\work\\huge.md", { forcePlainMode: true });
  ok(
    `(i) per-file記憶(markdown)よりforcePlainModeが優先されプレーンテキストのまま: ${JSON.stringify(await mode())}`,
    (await mode()) === "プレーンテキスト(大容量のため自動)",
  );
  await page.evaluate(() => window.__reply({ type: "apply-settings", perFileModes: {} }));
  await page.waitForTimeout(300);

  // forcePlainModeが付いていない普通のファイルに戻すと、ステータスバーの注記も消える。
  await open("sample.md", "C:\\work\\sample.md");
  ok(`(i) forcePlainMode無しの文書に戻ると注記も消える: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");
}

// (h) ページエラー・コンソールエラーが0件
ok(`(h) ページエラー・コンソールエラー0件: ${JSON.stringify(errors)}`, errors.length === 0);

await browser.close();
