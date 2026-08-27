// カラーピッカー改善3件(実機フィードバック対応)の検証スクリプト。ポートは8177。
// 1. パネル内Ctrl+Z/Ctrl+Y(パネル内だけのアンドゥ履歴。本文側の履歴とは独立)
// 2. キャンセルボタン(Escと同じ「開いた時の色に戻す」動作。パネル外クリックは適用扱い)
// 3. RGB/16進の数値入力欄が3桁で欠けない
//
// 「触ってよいファイル」はsrc/color-picker.js・src/style.cssのみのため、
// パネルを開く入口は既存の editor.openColorPicker / getColorLiteralAt をそのまま使う
// (.verify-colorpreview.mjsと同じ作法)。
import pw from "playwright";
const { chromium } = pw;

const PORT = 8177;
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
async function closePanelWithEscape(page) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }
// input要素に値をセットし、input/changeの両方を発火させる(fillだとchangeが発火しない
// 環境があるため、pushHistorySnapshot()の発火条件をテストで確実にコントロールする)。
async function setNumberField(page, ch, value) {
  await page.evaluate(({ ch, value }) => {
    const inp = document.querySelector(`.color-picker-panel input[data-ch="${ch}"]`);
    const proto = Object.getPrototypeOf(inp);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc.set.call(inp, String(value));
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  }, { ch, value });
  await page.waitForTimeout(80);
}
async function focusPanel(page) {
  // パネル内キー処理はroot.contains(document.activeElement)を見るため、パネル内の
  // 何らかの要素へフォーカスを移してからキー操作を行う(root.focus()は開いた直後だけ)。
  await page.evaluate(() => document.querySelector(".color-picker-panel").focus());
}
function contrastOf(fg, bg) {
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    const [r, g, b] = m[1].split(",").map((x) => parseFloat(x));
    return { r, g, b };
  };
  const lin = (v) => { const cs = v / 255; return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4); };
  const lum = (o) => 0.2126 * lin(o.r) + 0.7152 * lin(o.g) + 0.0722 * lin(o.b);
  const l1 = lum(parse(fg)), l2 = lum(parse(bg));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ============================================================
// 1. 色を3回変えたあとCtrl+Zを2回押すと1回目の変更後の色に戻る。Ctrl+Yで進める。
// ============================================================
{
  const page = await newPage({ width: 1280, height: 900 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  // 元の色は#14599f(R=0x14=20)なので、テストで使う値は偶然これと一致しないものを選ぶ
  // (以前r=20を使っていたところ、元の色と偶然一致してredo後の判定が誤ってNGになっていた)。
  await setNumberField(page, "r", 60);
  const afterFirst = await page.evaluate(() => window.__paneDebugEditor.getValue());
  await setNumberField(page, "r", 90);
  await setNumberField(page, "r", 120);
  const afterThird = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(1) 3回の数値入力でそれぞれ本文が書き換わる (1回目=${JSON.stringify(afterFirst)}, 3回目=${JSON.stringify(afterThird)})`,
    afterFirst.includes("#3c599f") && afterThird.includes("#78599f"));

  await focusPanel(page);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(100);
  const afterTwoUndo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(1) Ctrl+Zを2回で1回目の変更後の色に戻る (${JSON.stringify(afterTwoUndo)})`, afterTwoUndo === afterFirst);

  await page.keyboard.press("Control+y");
  await page.waitForTimeout(100);
  const afterRedo1 = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(1) Ctrl+Yでやり直せる`, afterRedo1.includes("#14599f") === false && afterRedo1 !== afterFirst);

  // Ctrl+Shift+Zでも進められること(Ctrl+Yと同義)
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(100);
  const afterRedo2 = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(1) Ctrl+Yを繰り返すと3回目の色まで進む (${JSON.stringify(afterRedo2)})`, afterRedo2 === afterThird);

  await closePanelWithEscape(page);
  await page.close();
}

// ============================================================
// 2. ドラッグ中の連続変化が1つの履歴としてまとまっていること
// ============================================================
{
  const page = await newPage({ width: 1280, height: 900 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  const histBefore = await page.$eval(".color-picker-panel", (e) => e.dataset.cpHistLen);
  ok(`(2) パネルを開いた直後は履歴1件(開いた時の色) (${histBefore})`, histBefore === "1");

  const hue = await page.$(".cp-hue-slider");
  const hbox = await hue.boundingBox();
  await page.mouse.move(hbox.x + 4, hbox.y + hbox.height / 2);
  await page.mouse.down();
  // ドラッグ中に何度もmousemoveさせる(連続変化)
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(hbox.x + 4 + (hbox.width - 8) * (i / 8), hbox.y + hbox.height / 2);
    await page.waitForTimeout(15);
  }
  const histDuringDrag = await page.$eval(".color-picker-panel", (e) => e.dataset.cpHistLen);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const histAfterDrag = await page.$eval(".color-picker-panel", (e) => e.dataset.cpHistLen);
  ok(`(2) ドラッグ中は履歴が増えない (during=${histDuringDrag})`, histDuringDrag === "1");
  ok(`(2) ドラッグ終了(pointerup)で履歴が1件だけ増える (before=1, after=${histAfterDrag})`, histAfterDrag === "2");

  await closePanelWithEscape(page);
  await page.close();
}

// ============================================================
// 3. パネルを閉じたあと、本文側のCtrl+Z 1回で「開く前の色」に戻ること(既存仕様の維持)
// ============================================================
{
  const page = await newPage({ width: 1280, height: 900 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  // パネル内で何度も色を変える(パネル内履歴を複数積む)
  await setNumberField(page, "r", 10);
  await setNumberField(page, "r", 20);
  const hue = await page.$(".cp-hue-slider");
  const hbox = await hue.boundingBox();
  await page.mouse.click(hbox.x + hbox.width * 0.5, hbox.y + hbox.height / 2);
  await page.waitForTimeout(100);

  await page.click(".cp-apply");
  await page.waitForTimeout(150);
  const afterApply = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(3) 適用で確定される (${JSON.stringify(afterApply)})`, afterApply !== "a { color: #14599f; }\n");

  await page.evaluate(() => window.__paneDebugEditor.applyAction("undo"));
  await page.waitForTimeout(150);
  const afterUndo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(3) パネルを閉じた後、本文側Ctrl+Z相当(applyAction undo)1回で開く前の色に戻る (${JSON.stringify(afterUndo)})`,
    afterUndo === "a { color: #14599f; }\n");

  // このアンドゥでもう一度Ctrl+Zしても、パネル内で何度色を変えたかに関わらず、
  // それより前(パネルを開く前)の編集は1回分しか消費しない、という健全性も併せて確認する。
  await page.evaluate(() => window.__paneDebugEditor.applyAction("redo"));
  await page.waitForTimeout(150);
  const afterRedo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(3) redoで確定後の色に戻る (${JSON.stringify(afterRedo)})`, afterRedo === afterApply);

  await page.close();
}

// ============================================================
// 4. 「キャンセル」ボタン: 開いた時の色に戻り、パネルが閉じる
// ============================================================
{
  const page = await newPage({ width: 1280, height: 900 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  const cancelBtn = await page.$(".cp-cancel");
  ok(`(4) キャンセルボタンが存在する`, !!cancelBtn);
  ok(`(4) キャンセルボタンのラベルが「キャンセル」`, (await cancelBtn.textContent()).trim() === "キャンセル");

  await setNumberField(page, "r", 5);
  const mid = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(4) キャンセル前に本文が書き換わっている`, mid !== "a { color: #14599f; }\n");

  await cancelBtn.click();
  await page.waitForTimeout(150);
  const afterCancel = await page.evaluate(() => window.__paneDebugEditor.getValue());
  const panelAfterCancel = await page.$$eval(".color-picker-panel", (e) => e.length);
  ok(`(4) キャンセルで開いた時の色に戻る (${JSON.stringify(afterCancel)})`, afterCancel === "a { color: #14599f; }\n");
  ok(`(4) キャンセルでパネルが閉じる`, panelAfterCancel === 0);
  await page.close();
}

// ============================================================
// 5. 「適用」ボタン: 確定して閉じる(併せてキャンセルの並び順=適用の隣も確認)
// ============================================================
{
  const page = await newPage({ width: 1280, height: 900 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  const order = await page.$eval(".cp-actions", (e) => [...e.children].map((c) => c.className));
  ok(`(5) キャンセルボタンの隣に適用ボタンが並ぶ (${JSON.stringify(order)})`,
    order.length === 2 && order[0].includes("cp-cancel") && order[1].includes("cp-apply"));

  await setNumberField(page, "r", 77);
  await page.click(".cp-apply");
  await page.waitForTimeout(150);
  const afterApply = await page.evaluate(() => window.__paneDebugEditor.getValue());
  const panelAfterApply = await page.$$eval(".color-picker-panel", (e) => e.length);
  ok(`(5) 適用で確定して本文が最終色になる (${JSON.stringify(afterApply)})`, afterApply.includes("#4d599f"));
  ok(`(5) 適用でパネルが閉じる`, panelAfterApply === 0);
  await page.close();
}

// ============================================================
// 6. RGB入力欄・16進入力欄が3桁(255)で欠けないこと
// ============================================================
{
  const page = await newPage({ width: 1280, height: 900 });
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  await setNumberField(page, "r", 255);
  await setNumberField(page, "g", 255);
  await setNumberField(page, "b", 255);
  await page.waitForTimeout(100);

  const overflow = await page.evaluate(() => {
    const out = {};
    for (const ch of ["r", "g", "b"]) {
      const el = document.querySelector(`.color-picker-panel input[data-ch="${ch}"]`);
      out[ch] = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, value: el.value };
    }
    const hex = document.querySelector('.color-picker-panel input[data-ch="hex"]');
    out.hex = { scrollWidth: hex.scrollWidth, clientWidth: hex.clientWidth, value: hex.value };
    return out;
  });
  for (const ch of ["r", "g", "b"]) {
    ok(`(6) ${ch.toUpperCase()}欄に255を入れても表示が欠けない (scrollWidth=${overflow[ch].scrollWidth} <= clientWidth=${overflow[ch].clientWidth}, value=${overflow[ch].value})`,
      overflow[ch].scrollWidth <= overflow[ch].clientWidth);
  }
  ok(`(6) 16進欄(ffffff)も表示が欠けない (scrollWidth=${overflow.hex.scrollWidth} <= clientWidth=${overflow.hex.clientWidth}, value=${overflow.hex.value})`,
    overflow.hex.scrollWidth <= overflow.hex.clientWidth);

  // スピナー(上下ボタン)を消してもキーボードの上下キーによる増減は残ることを確認
  const rInput = await page.$('.color-picker-panel input[data-ch="r"]');
  await rInput.click();
  await rInput.fill("100");
  await rInput.dispatchEvent("change");
  await page.waitForTimeout(80);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(80);
  const afterArrowUp = await rInput.inputValue();
  ok(`(6) スピナーを消してもキーボード上下キーでの増減は残る (100 -> ${afterArrowUp})`, afterArrowUp === "101");

  await closePanelWithEscape(page);
  await page.close();
}

// ============================================================
// 7. ライト/ダーク両テーマでパネル内の文字と背景のコントラストが確保されている
// ============================================================
for (const theme of ["light", "dark"]) {
  const page = await newPage({ width: 1280, height: 900 });
  if (theme === "dark") {
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; window.__paneDebugEditor.refreshTheme(); });
    await page.waitForTimeout(200);
  }
  await setCode(page, "a { color: #14599f; }\n");
  await openPickerAt(page, "#14599f");
  await page.waitForTimeout(150);

  const info = await page.evaluate(() => {
    const panel = document.querySelector(".color-picker-panel");
    const panelBg = getComputedStyle(panel).backgroundColor;
    const targets = [".cp-primary", ".cp-secondary", ".cp-num-field", ".cp-cancel", ".cp-apply"];
    return targets.map((sel) => {
      const el = document.querySelector(sel);
      const cs = getComputedStyle(el);
      // ボタンは自前の背景を持つのでボタン自身の背景と比較し、それ以外はパネル背景と比較する
      const bg = (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") ? cs.backgroundColor : panelBg;
      return { sel, color: cs.color, bg };
    });
  });
  let allPass = true;
  for (const { sel, color, bg } of info) {
    const ratio = contrastOf(color, bg);
    const pass = ratio >= 4.5 - 1e-6;
    if (!pass) allPass = false;
    ok(`(7-${theme}) ${sel} の文字色/背景コントラスト比 ${ratio.toFixed(2)} (${color} vs ${bg})`, pass);
  }
  ok(`(7-${theme}) 全要素でコントラスト確保`, allPass);

  await closePanelWithEscape(page);
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
