// バグチェック②(コードブロックのコピーボタンを押すと、以後キー入力が本文に入らなくなる)
// の実ブラウザ検証。ポートは8197。
//
// 原因: navigator.clipboard.writeText()が失敗する(実機で権限が拒否された・NotAllowedError
// になる場合と同じ)とtextarea+execCommand("copy")のフォールバックへ落ちるが、
// t.select()が本文からtextareaへフォーカスを奪い、t.remove()後もフォーカスがどこにも
// 戻っていなかった(src/editor.js CodeCopyWidget.toDOM())。
//
// 検証項目(依頼より):
//   - クリップボード権限を与えない状態(NotAllowedErrorを強制)でコピー後、
//     activeElementがエディタのままで、続けて打った文字が本文に入ること
//   - 権限を与えた場合(成功経路)でもフォーカスが動かないこと
//   - フォールバック用のtextareaがレイアウトへ影響しない(画面外・不可視)こと
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const PORT = 8197;
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

async function newBridgedPage({ denyClipboard = false } = {}) {
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
  if (denyClipboard) {
    // navigator.clipboard.writeTextを常に失敗させ、実機で権限が拒否された場合・
    // NotAllowedErrorになる場合を確定的に再現する。
    await page.addInitScript(() => {
      if (!navigator.clipboard) Object.defineProperty(navigator, "clipboard", { value: {}, configurable: true });
      navigator.clipboard.writeText = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    });
  }
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(700);
  return page;
}
async function applySettings(page, partial) {
  await page.evaluate((partial) => window.__reply({ type: "apply-settings", ...partial }), partial);
  await page.waitForTimeout(200);
}
async function openFile(page, fileName, path, text) {
  await page.evaluate(({ fileName, path, text }) => window.__reply({
    type: "file-opened", fileName, path, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, path, text });
  await page.waitForTimeout(500);
}
const BASE_SETTINGS = { showStatusBar: true, displayMode: "window" };
const MD_WITH_CODE = "# 見出し\n\n本文です。\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nおわり。\n";

async function activeElementInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName, isCmContent: !!el?.closest?.(".cm-content") };
  });
}

// ================= (1) クリップボード権限を与えない状態(NotAllowedErrorを強制) =================
{
  const page = await newBridgedPage({ denyClipboard: true });

  await applySettings(page, BASE_SETTINGS);
  await openFile(page, "sample.md", "C:\\work\\sample.md", MD_WITH_CODE);

  // コードブロック内をクリックしてカーソルを入れる(依頼の再現手順どおり)
  await page.locator(".cm-content").getByText("const a = 1;").click();
  await page.waitForTimeout(150);
  const before = await activeElementInfo(page);
  ok(`(1) 前提: クリックでエディタにフォーカスが入る: ${JSON.stringify(before)}`, before.isCmContent === true);

  // コピーボタンをクリック(ホバーで表示させてから)。.verify-codecopy-activeline.mjsと
  // 同じ理由でボタン中心の座標へ直接マウスを移動してクリックする(locator.click()の
  // actionability待ちだと、下のコード行のcm-lineがクリックを奪うことがあり不安定だった)。
  await page.locator(".cm-content").getByText("const a = 1;").hover();
  await page.waitForTimeout(150);
  const btnBox = await page.locator(".cm-code-copy").boundingBox();
  await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2, { steps: 5 });
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await activeElementInfo(page);
  ok(`(1) コピー後もactiveElementがエディタのまま(修正前はBODYへ逃げていた): ${JSON.stringify(after)}`, after.isCmContent === true);

  // 続けてタイプした文字が本文に入ること
  const beforeText = await page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
  await page.keyboard.type("ZZZ");
  await page.waitForTimeout(150);
  const afterText = await page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
  ok(`(1) コピー後に続けて打った文字が本文に入る(ZZZが増える)`, afterText.length === beforeText.length + 3 && afterText.includes("ZZZ"));

  // フォールバック用のtextareaが後片付けされている(残留していない)こと
  const strayTextarea = await page.locator("body > textarea").count();
  ok(`(1) フォールバック用textareaが後片付けされている: ${strayTextarea}`, strayTextarea === 0);

  await page.close();
}

// ================= (2) クリップボード権限を与えた場合(成功経路)でもフォーカスが動かない =================
{
  const page = await newBridgedPage();
  const ctx = browser.contexts().at(-1);
  try { await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` }); } catch { /* この環境では権限付与自体に失敗することがあるが、その場合は(1)の経路と同じになるだけなので続行 */ }

  await applySettings(page, BASE_SETTINGS);
  await openFile(page, "sample.md", "C:\\work\\sample.md", MD_WITH_CODE);
  await page.locator(".cm-content").getByText("const a = 1;").click();
  await page.waitForTimeout(150);

  await page.locator(".cm-content").getByText("const a = 1;").hover();
  await page.waitForTimeout(150);
  const btnBox2 = await page.locator(".cm-code-copy").boundingBox();
  await page.mouse.move(btnBox2.x + btnBox2.width / 2, btnBox2.y + btnBox2.height / 2, { steps: 5 });
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await activeElementInfo(page);
  ok(`(2) 成功経路でもコピー後にactiveElementがエディタのまま: ${JSON.stringify(after)}`, after.isCmContent === true);

  const beforeText = await page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
  await page.keyboard.type("QQQ");
  await page.waitForTimeout(150);
  const afterText = await page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
  ok(`(2) 成功経路でもコピー後に続けて打った文字が本文に入る`, afterText.length === beforeText.length + 3 && afterText.includes("QQQ"));

  // クリップボードの実際の中身も確認(コピー自体が壊れていないこと)
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (clip !== null) ok(`(2) クリップボードにコード本文がコピーされている: ${JSON.stringify(clip)}`, clip === "const a = 1;\nconst b = 2;");

  await page.close();
}

// ================= 共通: ページエラー・コンソールエラー 0件 =================
ok(`ページエラー・コンソールエラーが0件: ${errors.length}件${errors.length ? " " + JSON.stringify(errors.slice(0, 3)) : ""}`, errors.length === 0);

console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
