// 起動時間の内訳計測([計測:JS])の検証。
//
// 実機で「Navigate から initial-render-ready までに約2.7秒かかっており、それが起動時間の
// 8割を占める」ことは分かったが、その中身がまったく見えていなかった。src/main.js に
// 区間ごとのマークを入れ、initial-render-ready の直前に1行だけまとめて出すようにした
// (reportStartupMetrics)。ここではその1行が「送られること」「区間が揃っていること」
// 「数値として辻褄が合っていること」を確認する。
//
// 実際の所要時間そのもの(何msかかるか)は実行環境に依存するため検証対象にしない。
// ここで担保するのは、実機ログを読んだときに内訳が欠けていない、という点だけ。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

const PORT = 8212;
const SAMPLE = "# 見出し\n\n本文です。\n";

async function newPage() {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.chrome = {
      webview: {
        postMessage: (m) => window.__sent.push(m),
        addEventListener: (_t, fn) => listeners.push(fn),
      },
    };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);
  return { page, errors };
}

// C#側へ送られたログのうち、起動の内訳の1行を取り出す。
function metricsLine(page) {
  return page.evaluate(() => {
    const m = window.__sent.find((x) => x.type === "log" && String(x.message).startsWith("[計測:JS] 起動の内訳"));
    return m ? { level: m.level, message: String(m.message) } : null;
  });
}
function indexOfType(page, type) {
  return page.evaluate((t) => window.__sent.findIndex((m) => m.type === t), type);
}
function indexOfMetrics(page) {
  return page.evaluate(() =>
    window.__sent.findIndex((x) => x.type === "log" && String(x.message).startsWith("[計測:JS] 起動の内訳")));
}

// "ラベル=123ms" の並びから { ラベル: 123 } を作る。
// 区間だけを取り出す。行は「... 合計=NNNms | 区間, 区間, ... | 読み込み: 参考値, 参考値」の形で、
// 「読み込み:」より後ろは区間ではない参考値(ファイルの取得時間など)。参考値は増えることが
// あるため、名前で1つずつ除外するのではなく、この境目で切って区間だけを見る。
function parseSegments(message) {
  const out = {};
  const body = message.split("読み込み:")[0];
  for (const m of body.matchAll(/([^\s,|]+)=(\d+)ms/g)) out[m[1]] = Number(m[2]);
  return out;
}

// ---- (1) 通常の起動順で、内訳が1行だけ送られる ----
{
  const { page, errors } = await newPage();

  ok("(1-a) 起動直後はまだ内訳を送っていない", (await metricsLine(page)) === null);

  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark" }));
  await page.waitForTimeout(150);
  ok("(1-b) apply-settingsのみではまだ送らない(initial-render-readyと同じ条件)",
    (await metricsLine(page)) === null);

  await page.evaluate(({ text }) => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md", text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { text: SAMPLE });
  await page.waitForTimeout(300);

  const line = await metricsLine(page);
  ok("(1-c) 本文反映後に内訳が送られる", line !== null);
  if (line) console.log(`     ${line.message}`);

  // 既定のログレベルでも必ず残るよう info で送る必要がある
  // (level="log" にすると設定「詳細ログを記録する」を有効にしないと記録されない)。
  ok(`(1-d) レベルがinfo(既定のログ設定でも記録される) level=${line?.level}`, line?.level === "info");

  const metricsIdx = await indexOfMetrics(page);
  const readyIdx = await indexOfType(page, "initial-render-ready");
  ok(`(1-e) initial-render-readyより前に送られる(計測=${metricsIdx}, ready=${readyIdx})`,
    metricsIdx >= 0 && readyIdx >= 0 && metricsIdx < readyIdx);

  const seg = parseSegments(line?.message ?? "");
  for (const label of ["合計", "HTML取得", "バンドル評価", "エディタ生成", "UI初期化"]) {
    ok(`(1-f) 区間「${label}」がある (${seg[label]}ms)`, typeof seg[label] === "number");
  }
  // 設定・本文の反映は、届いた順によってラベルが2つとも出る。
  ok(`(1-g) 区間「設定反映(apply-settings)」がある (${seg["設定反映(apply-settings)"]}ms)`,
    typeof seg["設定反映(apply-settings)"] === "number");
  ok(`(1-h) 区間「本文反映(new-document/file-opened)」がある (${seg["本文反映(new-document/file-opened)"]}ms)`,
    typeof seg["本文反映(new-document/file-opened)"] === "number");

  // 各区間の和が合計とおおむね一致する(区間の取りこぼしが無いことの確認)。
  // 四捨五入の誤差が区間ごとに最大1msずつ乗るため、区間数ぶんの許容を持たせる。
  const total = seg["合計"] ?? 0;
  const names = Object.keys(seg).filter((k) => k !== "合計");
  const sum = names.reduce((a, k) => a + seg[k], 0);
  ok(`(1-i) 区間の和(${sum}ms)が合計(${total}ms)とおおむね一致する(差=${Math.abs(total - sum)}ms)`,
    Math.abs(total - sum) <= names.length + 1);

  ok(`(1-j) 合計が正の値 (${total}ms)`, total > 0);

  // 参考値(読み込んだファイルの取得時間とサイズ)も出ていること。
  ok(`(1-k) main.jsの取得時間とサイズが出ている`, /main\.js=\d+ms\/(\d+KB|サイズ不明)/.test(line?.message ?? ""));

  // 2回目以降は送らない(1回の起動につき1行)。
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light" }));
  await page.waitForTimeout(200);
  const count = await page.evaluate(() =>
    window.__sent.filter((x) => x.type === "log" && String(x.message).startsWith("[計測:JS] 起動の内訳")).length);
  ok(`(1-l) 内訳は1回しか送らない (${count}回)`, count === 1);

  ok(`(1-m) ページエラー・コンソールエラーが0件 (${errors.length}件)`, errors.length === 0);
  if (errors.length) console.log(errors.join("\n"));
  await page.close();
}

// ---- (2) 逆順(file-opened → apply-settings)でも内訳が揃う ----
{
  const { page, errors } = await newPage();

  await page.evaluate(({ text }) => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md", text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { text: SAMPLE });
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark" }));
  await page.waitForTimeout(300);

  const line = await metricsLine(page);
  ok("(2-a) 逆順でも内訳が送られる", line !== null);
  const seg = parseSegments(line?.message ?? "");
  ok(`(2-b) 逆順でも両方の区間が揃う`,
    typeof seg["設定反映(apply-settings)"] === "number" &&
    typeof seg["本文反映(new-document/file-opened)"] === "number");
  ok(`(2-c) ページエラー・コンソールエラーが0件 (${errors.length}件)`, errors.length === 0);
  if (errors.length) console.log(errors.join("\n"));
  await page.close();
}

// ---- (3) 新規文書(new-document)での起動でも出る ----
{
  const { page, errors } = await newPage();
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light" }));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__reply({ type: "new-document", encoding: "UTF-8", lineEnding: "CRLF" }));
  await page.waitForTimeout(300);

  const line = await metricsLine(page);
  ok("(3-a) new-document経由の起動でも内訳が送られる", line !== null);
  ok(`(3-b) ページエラー・コンソールエラーが0件 (${errors.length}件)`, errors.length === 0);
  if (errors.length) console.log(errors.join("\n"));
  await page.close();
}

await browser.close();
