// コード中のカラープレビュー・カラーピッカー(docs/カラープレビュー仕様.md)の検証スクリプト。
// 第6節に挙げられた項目を確認する。ポートは8161。
//
// 注記: 「色リテラルの右クリックメニューの先頭に『色を変更…』が出ること」の実際のメニュー組み立ては
// main.js側のbuildEditorContextMenuTree(触ってはいけないファイル)が担う。本スクリプトでは、
// main.js がその項目を組み立てるために必要な入口 ―
//   editor.resolveContextMenu(x, y, el).color  (文脈判定に使う色情報)
//   editor.getColorLiteralAt(pos)              (色リテラルの検出)
//   editor.openColorPicker(from, to, colorText) (パネルを開く)
// が正しく機能することを確認する(報告の「main.jsに必要な変更」も参照)。
import pw from "playwright";
const { chromium } = pw;

const PORT = 8161;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

async function newPage(viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(() => {
    window.__clipboard = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t) => { window.__clipboard.push(t); return Promise.resolve(); },
        readText: () => Promise.resolve(""),
        read: () => Promise.resolve([]),
      },
    });
  });
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
async function setMarkdown(page, text) {
  await page.evaluate(() => window.__paneDebugEditor.setFileMode("sample.md", "markdown"));
  await page.waitForTimeout(150);
  await page.evaluate((t) => window.__paneDebugEditor.setValue(t), text);
  await page.waitForTimeout(250);
}
async function swatchCount(page) { return page.$$eval(".cm-color-swatch", (e) => e.length); }
function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
async function openPickerAt(page, needle, cursorOffset = 1) {
  return page.evaluate(({ needle, cursorOffset }) => {
    const text = window.__paneDebugEditor.getValue();
    const idx = text.indexOf(needle);
    if (idx < 0) return null;
    const lit = window.__paneDebugEditor.getColorLiteralAt(idx + cursorOffset);
    if (!lit) return null;
    const rFrom = window.__paneDebugEditor.view.coordsAtPos(lit.from);
    const rTo = window.__paneDebugEditor.view.coordsAtPos(Math.max(lit.from, lit.to - 1));
    const opened = window.__paneDebugEditor.openColorPicker(lit.from, lit.to, lit.text);
    return {
      lit, opened,
      anchorRect: {
        left: Math.min(rFrom.left, rTo.left), right: Math.max(rFrom.right, rTo.right),
        top: Math.min(rFrom.top, rTo.top), bottom: Math.max(rFrom.bottom, rTo.bottom),
      },
    };
  }, { needle, cursorOffset });
}
async function panelRect(page) {
  return page.$eval(".color-picker-panel", (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
}
async function closePanel(page) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }

// ============================================================
// 1. コードモード: 各記法(3/4/6/8桁16進、rgb/rgba両記法、hsl/hsla、CSS色名)
// ============================================================
{
  const page = await newPage();
  await setCode(page, [
    "a { color: #f60; }",
    "b { color: #f60c; }",
    "c { color: #ff6600; }",
    "d { color: #ff6600cc; }",
    "e { color: rgb(255, 102, 0); }",
    "f { color: rgba(255,102,0,.8); }",
    "g { color: rgb(255 102 0 / 80%); }",
    "h { color: hsl(24, 100%, 50%); }",
    "i { color: hsl(24 100% 50% / .8); }",
    "j { color: red; }",
  ].join("\n"));
  const count = await swatchCount(page);
  ok(`(1) 各記法(10個)すべてにスウォッチが付く (${count})`, count === 10);
  const coloredMarks = await page.$$eval(".cm-content [style*='color:']", (e) => e.length);
  ok(`(1) 各記法すべてに文字色が付く (${coloredMarks})`, coloredMarks === 10);
  await page.close();
}

// ============================================================
// 2. CSS色名はCSS系言語だけ(それ以外では識別子と紛れるため無効)
// ============================================================
{
  const page = await newPage();
  await setCode(page, "const red = 1;\nconsole.log(red, blue);\n", "sample.js");
  const jsCount = await swatchCount(page);
  ok(`(2) JS言語ではCSS色名を色として扱わない (${jsCount})`, jsCount === 0);

  await setCode(page, "a { color: red; }\nb { background: rebeccapurple; }\n", "sample.css");
  const cssCount = await swatchCount(page);
  ok(`(2) CSS言語ではCSS色名を色として扱う (${cssCount})`, cssCount === 2);

  await setCode(page, "$c: red;\n", "sample.scss");
  const scssCount = await swatchCount(page);
  ok(`(2) scssでもCSS色名を色として扱う (${scssCount})`, scssCount === 1);
  await page.close();
}

// ============================================================
// 3. Markdownのコードフェンス内では効き、本文では効かない
// ============================================================
{
  const page = await newPage();
  await setMarkdown(page, [
    "本文中の #ff6600 という文字列はプレビューされない。",
    "",
    "```css",
    "a { color: #ff6600; }",
    "```",
    "",
    "```js",
    "const a = red; // js言語では色名は無効",
    "const b = '#ff6600';",
    "```",
    "",
  ].join("\n"));
  const count = await swatchCount(page);
  ok(`(3) Markdown本文は対象外、コードフェンス内(css1件+js1件)だけ対象 (${count})`, count === 2);
  await page.close();
}

// ============================================================
// 4. コントラスト補正: #ffffffがライトテーマで、#000000がダークテーマで
//    背景とのコントラスト比3.0以上になる
// ============================================================
{
  const page = await newPage();
  function contrastOf(rgbStr, bgHex) {
    const m = rgbStr.match(/rgba?\(([^)]+)\)/);
    const [r, g, b] = m[1].split(",").map((x) => parseFloat(x));
    const h = bgHex.replace("#", "");
    const bg = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    const lin = (v) => { const cs = v / 255; return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4); };
    const lum = (o) => 0.2126 * lin(o.r) + 0.7152 * lin(o.g) + 0.0722 * lin(o.b);
    const l1 = lum({ r, g, b }), l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  await setCode(page, "a { color: #ffffff; }\nb { color: #000000; }\n");
  const light = await page.evaluate(() => {
    const marks = [...document.querySelectorAll(".cm-content [style*='color:']")];
    const target = marks.find((e) => e.textContent.includes("#ffffff"));
    return { color: target ? getComputedStyle(target).color : null, paper: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() };
  });
  ok(`(4) ライトテーマの#ffffffがコントラスト比3.0以上 (${light.color} vs ${light.paper} = ${light.color ? contrastOf(light.color, light.paper).toFixed(2) : "N/A"})`,
    !!light.color && contrastOf(light.color, light.paper) >= 3.0 - 1e-6);

  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; window.__paneDebugEditor.refreshTheme(); });
  await page.waitForTimeout(300);
  const dark = await page.evaluate(() => {
    const marks = [...document.querySelectorAll(".cm-content [style*='color:']")];
    const target = marks.find((e) => e.textContent.includes("#000000"));
    return { color: target ? getComputedStyle(target).color : null, paper: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() };
  });
  ok(`(4) ダークテーマの#000000がコントラスト比3.0以上 (${dark.color} vs ${dark.paper} = ${dark.color ? contrastOf(dark.color, dark.paper).toFixed(2) : "N/A"})`,
    !!dark.color && contrastOf(dark.color, dark.paper) >= 3.0 - 1e-6);

  // スウォッチ自体は補正せず元の色そのまま(仕様書 3.2の5): 文字色は補正されても
  // スウォッチの--cm-color-swatchは常に元の#000000(0,0,0)のまま。
  const swatchBg = await page.evaluate(() => {
    const marks = [...document.querySelectorAll(".cm-content [style*='color:']")];
    const target = marks.find((e) => e.textContent.includes("#000000"));
    // targetの直前はCodeMirrorが挿入するcm-widgetBuffer(アクセシビリティ用の空img)なので、
    // それを飛ばしてさらに前のスウォッチ要素を見る。
    let swatch = target ? target.previousElementSibling : null;
    if (swatch && swatch.classList.contains("cm-widgetBuffer")) swatch = swatch.previousElementSibling;
    return swatch && swatch.classList.contains("cm-color-swatch") ? getComputedStyle(swatch).getPropertyValue("--cm-color-swatch").replace(/\s/g, "") : null;
  });
  ok(`(4) スウォッチは元の色そのまま(補正しない、文字色だけ読める色に補正) (${swatchBg})`, swatchBg === "rgba(0,0,0,1)");
  await page.close();
}

// ============================================================
// 5. 半透明の色で市松模様の背景が出る
// ============================================================
{
  const page = await newPage();
  await setCode(page, "a { color: rgba(255, 102, 0, .4); }\nb { color: #ff6600; }\n");
  const alphaSwatches = await page.$$eval(".cm-color-swatch-alpha", (e) => e.length);
  ok(`(5) 半透明の色にだけ市松模様クラスが付く (${alphaSwatches})`, alphaSwatches === 1);
  const bgImage = await page.$eval(".cm-color-swatch-alpha", (e) => getComputedStyle(e).backgroundImage);
  ok(`(5) 市松模様が実際にCSSで描画されている(複数のgradient層)`, (bgImage.match(/gradient/g) || []).length >= 4);
  await page.close();
}

// ============================================================
// 6. colorPreviewInCode:false で一切表示されない
// ============================================================
{
  const page = await newPage();
  await setCode(page, "a { color: #ff0000; }\n");
  const before = await swatchCount(page);
  await page.evaluate(() => window.__paneDebugEditor.setColorPreviewInCode(false));
  await page.waitForTimeout(200);
  const disabled = await swatchCount(page);
  ok(`(6) colorPreviewInCode:false で表示されなくなる (${before} -> ${disabled})`, before > 0 && disabled === 0);
  await page.evaluate(() => window.__paneDebugEditor.setColorPreviewInCode(true));
  await page.waitForTimeout(200);
  const reenabled = await swatchCount(page);
  ok(`(6) colorPreviewInCode:true に戻すと再表示される (${reenabled})`, reenabled === before);
  await page.close();
}

// ============================================================
// 7. 直前が英数字の場合(abc#ff0000)に反応しない
// ============================================================
{
  const page = await newPage();
  await setCode(page, "a { content: abc#ff0000; }\nb { color: #ff0000; }\n");
  const count = await swatchCount(page);
  ok(`(7) 直前が英数字の#ff0000は無視され、独立した#ff0000だけが対象になる (${count})`, count === 1);
  await page.close();
}

// ============================================================
// 8. 1万行のファイルで、表示範囲外の色リテラルが装飾対象になっていない(性能)
// ============================================================
{
  const page = await newPage();
  await page.evaluate(() => window.__paneDebugEditor.setFileMode("sample.css", "code"));
  await page.waitForTimeout(150);
  const t0 = Date.now();
  await page.evaluate(() => {
    const lines = [];
    for (let i = 0; i < 10000; i++) lines.push(`.c${i} { color: #ff${(i % 100).toString(16).padStart(2, "0")}00; }`);
    window.__paneDebugEditor.setValue(lines.join("\n"));
  });
  await page.waitForTimeout(400);
  const ms = Date.now() - t0;
  const count = await swatchCount(page);
  ok(`(8) 1万行中、可視範囲外は装飾対象にならない(実際のスウォッチ数=${count}, 反映${ms}ms)`, count > 0 && count < 300);
  await page.close();
}

// ============================================================
// カラーピッカー(第4章)
// ============================================================

// 9. resolveContextMenu: 色リテラルの上でだけ info.color が付く
//    (main.js側で「色を変更…」をメニュー先頭に追加するための入口)
{
  const page = await newPage();
  await setCode(page, "a { color: #123456; }\n");
  const infoColor = await page.evaluate(() => {
    const text = window.__paneDebugEditor.getValue();
    const idx = text.indexOf("#123456");
    const pos = idx + 3;
    const c = window.__paneDebugEditor.view.coordsAtPos(pos);
    return window.__paneDebugEditor.resolveContextMenu((c.left + c.right) / 2, (c.top + c.bottom) / 2, null).color;
  });
  ok(`(9) 色リテラルの上のresolveContextMenuにcolorが載る (${JSON.stringify(infoColor)})`, !!infoColor && infoColor.text === "#123456");

  const infoNoColor = await page.evaluate(() => {
    const c = window.__paneDebugEditor.view.coordsAtPos(0);
    return window.__paneDebugEditor.resolveContextMenu((c.left + c.right) / 2, (c.top + c.bottom) / 2, null).color;
  });
  ok(`(9) 色以外の場所ではcolorが付かない (${JSON.stringify(infoNoColor)})`, infoNoColor === undefined);
  await page.close();
}

// 10. パネルの表示位置: 対象リテラルの矩形と重ならない・ビューポートからはみ出さない(下/上)
{
  const page = await newPage({ width: 1280, height: 900 });
  // 画面上部(下に出るはず)
  await setCode(page, "a { color: #ff6600; }\n" + "b {}\n".repeat(30));
  await page.evaluate(() => window.__paneDebugEditor.gotoLine(1));
  const r1 = await openPickerAt(page, "#ff6600");
  await page.waitForTimeout(150);
  const p1 = await panelRect(page);
  const overlap1 = rectsOverlap(p1, r1.anchorRect);
  const within1 = p1.left >= 0 && p1.top >= 0 && p1.right <= 1280 && p1.bottom <= 900;
  ok(`(10) 上部の色は下に開き、リテラルと重ならない (overlap=${overlap1})`, !overlap1);
  ok(`(10) 上部ケースでビューポートからはみ出さない`, within1);
  await closePanel(page);

  // 画面下部(上に出るはず)
  await setCode(page, "b {}\n".repeat(30) + "a { color: #ff6600; }\n");
  await page.evaluate(() => window.__paneDebugEditor.gotoLine(31));
  const r2 = await openPickerAt(page, "#ff6600");
  await page.waitForTimeout(150);
  const p2 = await panelRect(page);
  const overlap2 = rectsOverlap(p2, r2.anchorRect);
  const within2 = p2.left >= 0 && p2.top >= 0 && p2.right <= 1280 && p2.bottom <= 900;
  ok(`(10) 下部の色は上に開き、リテラルと重ならない (overlap=${overlap2}, panelBottom=${p2.bottom.toFixed(1)}, anchorTop=${r2.anchorRect.top.toFixed(1)})`,
    !overlap2 && p2.bottom <= r2.anchorRect.top + 1);
  ok(`(10) 下部ケースでビューポートからはみ出さない`, within2);
  await closePanel(page);
  await page.close();
}

// 11〜18: パネルの挙動全般
{
  const page = await newPage({ width: 1280, height: 900 });
  await setCode(page, "a { color: #14599f; }\nb { color: blue; }\n");
  const r = await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);
  ok(`(11) openColorPickerが成功しパネルが1つ開く`, r.opened && await page.$$eval(".color-picker-panel", (e) => e.length) === 1);

  // 11. 色相スライダーを動かすとパネルを閉じないまま本文が書き換わる
  const hue = await page.$(".cp-hue-slider");
  const hbox = await hue.boundingBox();
  await page.mouse.move(hbox.x + 4, hbox.y + hbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hbox.x + hbox.width * 0.6, hbox.y + hbox.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const afterDrag = await page.evaluate(() => window.__paneDebugEditor.getValue());
  const panelStillOpen = await page.$$eval(".color-picker-panel", (e) => e.length);
  ok(`(11) 色相スライダー操作でパネルを閉じずに本文が即座に書き換わる (${JSON.stringify(afterDrag)})`,
    panelStillOpen === 1 && afterDrag.includes("#14599f") === false);

  // 16. 表示・コピー文字列がリテラルの記法(hex)に一致する
  const primary = await page.$eval(".cp-primary", (e) => e.textContent);
  ok(`(16) hexリテラル編集中はプレビューの主表記もhex (${primary})`, /^#[0-9a-fA-F]{6}$/.test(primary));
  const secondary = await page.$eval(".cp-secondary", (e) => e.textContent);
  ok(`(16) 補助表記にRGB/HSLが併記される (${secondary})`, secondary.includes("RGB(") && secondary.includes("HSL("));

  // 13. 5種のパレットがそれぞれ5色
  const groups = await page.$$eval(".cp-palette-group", (els) => els.map((g) => ({
    title: g.querySelector(".cp-palette-title").textContent,
    n: g.querySelectorAll(".cp-palette-swatch").length,
  })));
  ok(`(13) パレットが5種類・各5色 (${JSON.stringify(groups)})`,
    groups.length === 5 && groups.every((g) => g.n === 5)
    && ["単色", "類似色", "補色", "三角配色", "四角配色"].every((t) => groups.some((g) => g.title === t)));

  // 生成規則どおりの色相か(類似色: h-30/h-15/h/h+15/h+30)を確認
  function rgbToH({ r, g, b }) {
    const rr = r / 255, gg = g / 255, bb = b / 255;
    const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb), d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === rr) h = ((gg - bb) / d) % 6; else if (max === gg) h = (bb - rr) / d + 2; else h = (rr - gg) / d + 4;
    h *= 60; if (h < 0) h += 360;
    return h;
  }
  const baseHex = await page.$eval(".cp-primary", (e) => e.textContent);
  const baseRgb = { r: parseInt(baseHex.slice(1, 3), 16), g: parseInt(baseHex.slice(3, 5), 16), b: parseInt(baseHex.slice(5, 7), 16) };
  const baseH = rgbToH(baseRgb);
  const analogousHexes = await page.$$eval(".cp-palette-group", (els) => {
    const g = [...els].find((x) => x.querySelector(".cp-palette-title").textContent === "類似色");
    return [...g.querySelectorAll(".cp-palette-swatch")].map((s) => s.dataset.color);
  });
  const hues = analogousHexes.map((hex) => {
    const m = hex.match(/^#([0-9a-fA-F]{6})/);
    if (!m) return null;
    const rgb = { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
    return rgbToH(rgb);
  });
  const norm = (h) => ((h % 360) + 360) % 360;
  const expected = [-30, -15, 0, 15, 30].map((d) => Math.round(norm(baseH + d)));
  const actual = hues.map((h) => (h == null ? null : Math.round(norm(h))));
  const hueClose = expected.every((e, i) => actual[i] != null && Math.abs(((actual[i] - e + 540) % 360) - 180) <= 2);
  ok(`(13) 類似色パレットの色相がh-30/h-15/h/h+15/h+30どおり (base=${baseH.toFixed(1)}, expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)})`, hueClose);

  // 各色にマウスを乗せるとツールチップ(title属性)が出る。表記はリテラルの記法に合わせる
  const swTitle = await page.$eval(".cp-palette-swatch", (e) => e.title);
  ok(`(13) パレットの色にツールチップ(title)がありhex表記 (${swTitle})`, /^#[0-9a-fA-F]{6}$/.test(swTitle));

  // 15. パレットを右クリック: コピー・パネルは閉じない・既定コンテキストメニューは出ない
  await page.evaluate(() => { window.__clipboard.length = 0; });
  const sw0 = await page.$(".cp-palette-swatch");
  let ctxMenuFired = false;
  await page.exposeFunction("__noop", () => {});
  const preventedCheck = await page.evaluate(() => {
    return new Promise((resolve) => {
      const sw = document.querySelector(".cp-palette-swatch");
      let prevented = null;
      sw.addEventListener("contextmenu", (e) => { prevented = e.defaultPrevented; }, { once: true });
      const rect = sw.getBoundingClientRect();
      sw.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2, button: 2 }));
      setTimeout(() => resolve(prevented), 50);
    });
  });
  ok(`(15) パレット右クリックでブラウザ既定メニューを出さない(e.preventDefault) (${preventedCheck})`, preventedCheck === true);
  await sw0.click({ button: "right" });
  await page.waitForTimeout(100);
  const clip = await page.evaluate(() => window.__clipboard.slice());
  const panelAfterRightClick = await page.$$eval(".color-picker-panel", (e) => e.length);
  ok(`(15) パレット右クリックで色番号がコピーされる (${JSON.stringify(clip)})`, clip.length >= 1 && /^#[0-9a-fA-F]{6}$/.test(clip[clip.length - 1]));
  ok(`(15) パレット右クリックではパネルが閉じない (${panelAfterRightClick})`, panelAfterRightClick === 1);
  const toast = await page.$(".cp-copy-toast");
  ok(`(15) コピー後に「コピーしました」トーストが出る`, !!toast && (await toast.textContent()) === "コピーしました");
  await page.waitForTimeout(1400);
  const toastGone = await page.$(".cp-copy-toast");
  ok(`(15) トーストが1.2秒程度で消える`, !toastGone);

  // 14. パレットを左クリックすると確定してパネルが閉じる
  await page.click(".cp-palette-swatch");
  await page.waitForTimeout(150);
  const afterPaletteClick = await page.evaluate(() => window.__paneDebugEditor.getValue());
  const panelAfterClick = await page.$$eval(".color-picker-panel", (e) => e.length);
  ok(`(14) パレットの色を左クリックすると確定してパネルが閉じる (panel=${panelAfterClick}, doc=${JSON.stringify(afterPaletteClick)})`, panelAfterClick === 0);

  // 12. 中間状態はアンドゥ履歴に積まれず、1回のアンドゥで元の色に戻る
  await page.evaluate(() => window.__paneDebugEditor.applyAction("undo"));
  await page.waitForTimeout(150);
  const afterUndo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(12) 1回のアンドゥで開いた時の色に戻る (${JSON.stringify(afterUndo)})`, afterUndo === "a { color: #14599f; }\nb { color: blue; }\n");
  await page.evaluate(() => window.__paneDebugEditor.applyAction("redo"));
  await page.waitForTimeout(150);
  const afterRedo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(12) やり直すと確定した色に戻る (${JSON.stringify(afterRedo)})`, afterRedo === afterPaletteClick);

  await page.close();
}

// 17. Escで開いた時の色に戻って閉じる
{
  const page = await newPage({ width: 1280, height: 900 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);
  const hue = await page.$(".cp-hue-slider");
  const hbox = await hue.boundingBox();
  await page.mouse.click(hbox.x + hbox.width * 0.7, hbox.y + hbox.height / 2);
  await page.waitForTimeout(150);
  const mid = await page.evaluate(() => window.__paneDebugEditor.getValue());
  await closePanel(page);
  const afterEsc = await page.evaluate(() => window.__paneDebugEditor.getValue());
  const panelAfterEsc = await page.$$eval(".color-picker-panel", (e) => e.length);
  ok(`(17) Escキャンセルで開いた時の色に戻る (mid=${JSON.stringify(mid)}, afterEsc=${JSON.stringify(afterEsc)})`,
    mid !== "a { color: #14599f; }\n" && afterEsc === "a { color: #14599f; }\n");
  ok(`(17) Escでパネルが閉じる`, panelAfterEsc === 0);
  await page.close();
}

// 18. 表記の保持: rgb(...)はrgb(...)のまま、#f60は3桁のまま、アルファは維持される
{
  const page = await newPage({ width: 1280, height: 900 });

  // rgb(...)のまま(適用ボタンで変更なし確定)
  await setCode(page, "a { color: rgb(255, 102, 0); }\n");
  await openPickerAt(page, "rgb(");
  await page.waitForTimeout(150);
  await page.click(".cp-apply");
  await page.waitForTimeout(150);
  const rgbKept = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(18) rgb(...)で編集してもrgb(...)のまま書き戻される (${JSON.stringify(rgbKept)})`, rgbKept === "a { color: rgb(255, 102, 0); }\n");

  // #f60(3桁)のまま。表現可能な色(#369等)に変えても3桁のまま
  await setCode(page, "a { color: #f60; }\n");
  const litInfo = await openPickerAt(page, "#f60");
  await page.waitForTimeout(150);
  // R入力を17の倍数(3桁で表現可能)に変更
  await page.fill('input[data-ch="r"]', "51"); // 0x33 = 3桁で表現可能
  await page.waitForTimeout(150);
  await page.click(".cp-apply");
  await page.waitForTimeout(150);
  const shortHexResult = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(18) 3桁で表現できる色は3桁のまま書き戻される (${JSON.stringify(shortHexResult)})`, /#[0-9a-fA-F]{3};/.test(shortHexResult));

  // 3桁で表現できない色になった場合は6桁へ広げる
  await setCode(page, "a { color: #f60; }\n");
  await openPickerAt(page, "#f60");
  await page.waitForTimeout(150);
  await page.fill('input[data-ch="r"]', "37"); // 17の倍数でない
  await page.waitForTimeout(150);
  await page.click(".cp-apply");
  await page.waitForTimeout(150);
  const widenedResult = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(18) 3桁で表現できない色は6桁へ広がる (${JSON.stringify(widenedResult)})`, /#[0-9a-fA-F]{6};/.test(widenedResult));

  // アルファ付きリテラルはアルファが維持される
  await setCode(page, "a { color: rgba(255, 102, 0, 0.5); }\n");
  await openPickerAt(page, "rgba(");
  await page.waitForTimeout(150);
  const alphaVisible = await page.$eval(".cp-alpha-slider", (e) => !e.hidden);
  await page.click(".cp-apply");
  await page.waitForTimeout(150);
  const alphaKept = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(18) アルファスライダーが表示される(元がアルファ付きのため)`, alphaVisible);
  ok(`(18) アルファ付きリテラルはアルファを維持したまま書き戻す (${JSON.stringify(alphaKept)})`, alphaKept.includes("0.5"));

  // アルファの無いリテラルではスライダーを出さない
  await setCode(page, "a { color: #ff6600; }\n");
  await openPickerAt(page, "#ff6600");
  await page.waitForTimeout(150);
  const alphaHiddenForOpaque = await page.$eval(".cp-alpha-slider", (e) => e.hidden);
  ok(`(18) アルファの無いリテラルでは不透明度スライダーを出さない`, alphaHiddenForOpaque);
  await closePanel(page);

  await page.close();
}

// ============================================================
// ページエラー・コンソールエラー0件
// ============================================================
ok(`ページエラー・コンソールエラー0件 (${allErrors.length + allConsoleErrors.length}件) ${JSON.stringify([...allErrors, ...allConsoleErrors]).slice(0, 3000)}`,
  allErrors.length === 0 && allConsoleErrors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
