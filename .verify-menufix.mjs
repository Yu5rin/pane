// メニュー周りの不具合修正の回帰検証。ポートは8154。
//   (1) 見出しを続けて押したときに、遅れて届く「前のメニューが閉じた」通知(menu-closed)で
//       いま開いているメニューの状態まで消えてしまわないこと。
//       → メニュー外クリックで close-menu が送られ続けること。
//   (2) Alt単押し1回ごとにメニューバーの表示/非表示が切り替わること。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
let okCount = 0, ngCount = 0;
const errors = [], consoleErrors = [];
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
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

const countClose = () => page.evaluate(() => window.__sent.filter((m) => m.type === "close-menu").length);
const isOpen = (label) => page.evaluate((l) => [...document.querySelectorAll("#menubar .menu-top")]
  .some((b) => b.textContent === l && b.classList.contains("open")), label);

// ---- (1) 見出しを続けて押す ----
await page.click("#menubar .menu-top:text('ファイル')");
await page.waitForTimeout(150);
ok("(1) 「ファイル」を押すとハイライトされる", await isOpen("ファイル"));

// C#役: 「編集」の open-menu を受ける前に、まだ「ファイル」が開いている状態。
await page.click("#menubar .menu-top:text('編集')");
await page.waitForTimeout(50);
// C#側は新しいポップアップを出す前に前のポップアップを閉じるため、
// 「ファイルが閉じた」通知がこのタイミングで遅れて届く。
await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "File" }));
await page.waitForTimeout(150);
ok("(1) 遅れて届いたmenu-closed(File)で「編集」のハイライトが消えない", await isOpen("編集"));
ok("(1) 「ファイル」のハイライトは消えている", !(await isOpen("ファイル")));

// この状態で本文をクリック → close-menu が送られる(=メニュー外クリックで閉じる)。
const before = await countClose();
await page.mouse.click(400, 300);
await page.waitForTimeout(150);
const after = await countClose();
ok("(1) メニュー外クリックでclose-menuが送られる", after === before + 1, `(${before}->${after})`);
ok("(1) メニュー外クリック後はハイライトが消える", !(await isOpen("編集")));

// 3つ続けて押しても同じであること(ファイル→編集→表示→段落)。
const seq = [["ファイル", "File"], ["編集", "Edit"], ["表示", "View"], ["段落", "Paragraph"]];
for (let i = 0; i < seq.length; i++) {
  const [label, name] = seq[i];
  // 直前に開いていたメニュー(1つ目は直前のメニュー外クリックで閉じているのでなし)。
  const prev = i === 0 ? null : seq[i - 1][1];
  await page.click(`#menubar .menu-top:text('${label}')`);
  await page.waitForTimeout(30);
  if (prev) await page.evaluate((p) => window.__reply({ type: "menu-closed", menu: p }), prev);
  await page.waitForTimeout(80);
  ok(`(1) 連続クリック: 「${label}」が開いた状態を保つ`, await isOpen(label), `(${name})`);
}
const before2 = await countClose();
await page.mouse.click(400, 300);
await page.waitForTimeout(150);
ok("(1) 4つ連続で押したあとも1回のメニュー外クリックで閉じる", (await countClose()) === before2 + 1);

// ---- (2) Alt単押し ----
const menubarHidden = () => page.evaluate(() => document.querySelector("#menubar").classList.contains("hidden"));
ok("(2) 初期状態ではメニューバーが表示されている", !(await menubarHidden()));
for (let i = 1; i <= 4; i++) {
  await page.keyboard.press("Alt");
  await page.waitForTimeout(120);
  const expected = i % 2 === 1;
  ok(`(2) Alt ${i}回目で表示/非表示が切り替わる(非表示=${expected})`, (await menubarHidden()) === expected);
}
// Alt+他キーの組み合わせでは切り替わらない。
const beforeAltShift = await menubarHidden();
await page.keyboard.press("Alt+Shift+5");
await page.waitForTimeout(120);
ok("(2) Alt+他キーの組み合わせでは切り替わらない", (await menubarHidden()) === beforeAltShift);

ok("ページエラー0件", errors.length === 0, JSON.stringify(errors));
ok("コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount === 0 ? 0 : 1);
