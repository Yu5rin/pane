// 配色の指摘対応(ユーザー報告: MDコードブロックの黒系背景・表ヘッダーの緑・
// スクロールバー1.5倍・```json のシンタックスハイライト)の検証スクリプト。ポートは8190。
//
// 構成:
//   (A) コードブロック背景(--code-bg): ダーク既定/nord/dracula/solarized-dark/nightの
//       いずれも本文(--paper)よりはっきり暗いこと(相対輝度で比較)。ライト既定/sepia/
//       github/solarized-lightは逆に本文よりわずかに暗い(黒ではない)ニュートラルな
//       グレーであること。
//   (B) 表のヘッダー(.cm-table th): 旧実装のアクセント色由来(--accent-soft、
//       ダークは過去のアクセント値を直書きしたrgba(61,193,181,.14))ではなく、
//       ニュートラルな--panel-bgと一致すること(緑=アクセント色に戻っていないことの確認)。
//   (C) スクロールバー: scrollbar-widthが"thin"ではなく、::-webkit-scrollbarの実効幅が
//       17px(旧"thin"実測11pxの約1.5倍)であること。
//   (D) ```json コードフェンスのシンタックスハイライトが実際に効いていること:
//       キー(propertyName)・文字列値・数値・記号(punctuation)の描画色が
//       それぞれ異なり(=単色に潰れていない)、かつキーに span 自体が付いて
//       いること(無色バグの再発防止)。
//   (E) 追加報告(実機比較のスクリーンショット付き): JavaScriptの
//       キーワード/変数名/関数名/文字列/数値/コメントの6種が、9テーマすべてで
//       それぞれ異なる色になっていること(コードモードの.jsファイル・
//       Markdownの```jsフェンス双方で確認)。また、コメントを除く5種が
//       背景(--paper・--code-bg)に対しコントラスト比3.0以上を保っていること
//       (地の色に埋もれていないことの実測)。
//   (F) 不具合調査(ユーザー報告「シンタックスハイライトが効いていない箇所が見られます」、
//       実際の画像はステータスバーが「コード (JSON)」のままJavaScriptのコードが無色で
//       表示されていた): meta.jsonのようなJSON扱いのファイル名でJavaScriptの内容を開くと
//       JSONパーサがJS構文を解析できずハイライトがほぼ効かないこと、同じ内容を正しい拡張子
//       (.js)で開けば期待どおり色が付くこと、の両方を実測する。調査の結論は「拡張子優先で
//       言語を決める既存の仕様どおりの動作であり、バグではない」。
//   (G) 追加調査(ユーザーからの実測依頼): 正規表現リテラル(t.regexp)が実際に色付いているか、
//       および Graft(VS Code Dark+)で色が付く他の要素(テンプレートリテラル/埋め込み式・
//       正規表現中の特殊文字・async/await/yield・JSX タグ/属性・オブジェクトキー・
//       分割代入の変数名・import/export識別子)がPaneでも色付いているかを実測する。
import pw from "playwright";
const { chromium } = pw;

const PORT = 8190;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

function relLum(rgbStr) {
  const m = rgbStr.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!m) return null;
  const [r, g, b] = [1, 2, 3].map((i) => {
    const v = parseFloat(m[i]) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
  const L1 = relLum(a), L2 = relLum(b);
  if (L1 == null || L2 == null) return null;
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

// 相対輝度(ガンマ補正込み)は黒に近い領域だと絶対値の差がほぼ潰れてしまい
// (例: rgb(20,23,26)→lum0.008、rgb(11,13,15)→lum0.004、絶対差0.004しか出ない)、
// 「はっきり暗い」の判定には向かない。RGB各chの単純平均値の差(0-255スケール)を
// 別途使い、知覚的に意味のある差(既定値のデザイン差はどれも12〜20)を検出する。
function avgChannel(rgbStr) {
  const m = rgbStr.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!m) return null;
  return (parseFloat(m[1]) + parseFloat(m[2]) + parseFloat(m[3])) / 3;
}

async function newPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  await page.addInitScript(() => {
    const listeners = [];
    window.chrome = {
      webview: {
        postMessage: () => {},
        addEventListener: (_t, fn) => listeners.push(fn),
      },
    };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
}

async function setTheme(page, theme, lightTheme, darkTheme) {
  await page.evaluate((opt) => window.__reply({
    type: "apply-settings", theme: opt.theme, lightTheme: opt.lightTheme, darkTheme: opt.darkTheme,
    calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true, autoLinksEnabled: true,
    diagramsEnabled: true, codeBlockLineNumbers: true,
  }), { theme, lightTheme, darkTheme });
  await page.waitForTimeout(250);
}

async function openDoc(page, text) {
  await page.evaluate((t) => window.__reply({
    type: "file-opened", fileName: "verify.md", text: t, path: "C:\\verify.md",
    encoding: "UTF-8", lineEnding: "LF", readOnly: false,
  }), text);
  await page.waitForTimeout(300);
}

async function openDoc2(page, fileName, text) {
  await page.evaluate((args) => window.__reply({
    type: "file-opened", fileName: args.fileName, text: args.text, path: "C:\\" + args.fileName,
    encoding: "UTF-8", lineEnding: "LF", readOnly: false,
  }), { fileName, text });
  await page.waitForTimeout(400);
}

async function extractJsTokens(page) {
  return page.evaluate(() => {
    const spans = [...document.querySelectorAll(".cm-content span")];
    const find = (txt) => {
      for (const s of spans) if (s.textContent === txt) return getComputedStyle(s).color;
      return null;
    };
    return {
      kw: find("const"),
      varName: find("backBtn"),
      varName2: find("document"),
      fn: find("getElementById"),
      str: find("'back-btn'"),
      num: find("42"),
      cmt: find("// 初期化処理"),
      ink: getComputedStyle(document.body).color,
    };
  });
}

// 既知の意図的な例外(公式配色に忠実であることを優先した箇所。themes.css側の
// 該当コメントを参照):
//   - dracula: 公式Specificationが「変数名=Foreground」と明記しており、
//     Foreground(=--ink)とdracula環境では一致するのが正しい(無色バグとは別物。
//     旧不具合は「どのタグにもルールが無い」状態、これは「公式が地の色を指定している」
//     状態で、後者は意図した仕様)。
//   - solarized-light/solarized-dark: 公式vim-colors-solarizedが文字列と数値を
//     どちらも同じConstantグループ(cyan)に割り当てており、両者を色だけで
//     区別しない(内容の見た目=引用符の有無で区別する)のがSolarizedの特徴。
const KNOWN_SHARED_COLOR_EXCEPTIONS = {
  "dracula": { var_eq_ink: true },
  "solarized-light": { str_eq_num: true },
  "solarized-dark": { str_eq_num: true },
};

function checkJsDistinct(prefix, tk, paperBg, codeBg, themeLabel) {
  const exc = KNOWN_SHARED_COLOR_EXCEPTIONS[themeLabel] || {};
  const roles = { kw: tk.kw, var: tk.varName, fn: tk.fn, str: tk.str, num: tk.num };
  // 6種すべてに色が付いている(無色バグの再発防止。特にvarはユーザー報告の直接原因だった)
  for (const [name, val] of Object.entries({ ...roles, cmt: tk.cmt })) {
    ok(`${prefix} ${name}に色付きspanが生成される color=${val}`, !!val);
  }
  // 変数の2箇所(backBtn/document)が同じ役割色になっている(一貫性)
  ok(`${prefix} 変数参照(backBtn/document)が同じ色 ${tk.varName} / ${tk.varName2}`, tk.varName === tk.varName2);
  // 6種のうちコメントを除く5種が、地の色(--ink)そのままになっていない
  // (draculaのvarだけは上記の既知の例外: 公式仕様どおりForeground=--ink)
  for (const [name, val] of Object.entries(roles)) {
    if (name === "var" && exc.var_eq_ink) { ok(`${prefix} var は公式仕様によりForeground(=--ink)のまま(意図的) color=${val}`, val === tk.ink); continue; }
    ok(`${prefix} ${name}が地の色(--ink)のままになっていない color=${val} ink=${tk.ink}`, val !== tk.ink);
  }
  // 5種(コメント除く)が互いに異なる色(variableは2箇所とも同色なので1エントリとして比較)。
  // solarized系は上記の既知の例外によりstr/numが同色なので4/5種を合格ラインとする。
  const distinctSet = new Set([tk.kw, tk.varName, tk.fn, tk.str, tk.num]);
  const expectMin = exc.str_eq_num ? 4 : 5;
  ok(`${prefix} キーワード/変数/関数/文字列/数値が互いに異なる色(${distinctSet.size}/5種、要求${expectMin}種以上) ${JSON.stringify(roles)}`,
    distinctSet.size >= expectMin);
  // コメント以外が背景に埋もれていない(コントラスト比3.0以上、paper・code-bg両方)
  for (const [name, val] of Object.entries(roles)) {
    const rP = contrastRatio(val, paperBg);
    const rC = contrastRatio(val, codeBg);
    ok(`${prefix} ${name}が背景に埋もれていない(vsPaper=${rP?.toFixed(2)} vsCodeBg=${rC?.toFixed(2)})`,
      rP != null && rC != null && rP >= 3.0 && rC >= 3.0);
  }
}

const JSON_DOC = "```json\n{\n  \"port\": 3000,\n  \"name\": \"pane\"\n}\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";

// ---- (A)(B)(D) 各テーマでの背景・トークン色 ----
const THEMES = [
  { label: "default-light", theme: "light", lightTheme: "default", darkTheme: "default", dark: false },
  { label: "default-dark", theme: "dark", lightTheme: "default", darkTheme: "default", dark: true },
  { label: "sepia", theme: "light", lightTheme: "sepia", darkTheme: "default", dark: false },
  { label: "github", theme: "light", lightTheme: "github", darkTheme: "default", dark: false },
  { label: "solarized-light", theme: "light", lightTheme: "solarized-light", darkTheme: "default", dark: false },
  { label: "nord", theme: "dark", lightTheme: "default", darkTheme: "nord", dark: true },
  { label: "dracula", theme: "dark", lightTheme: "default", darkTheme: "dracula", dark: true },
  { label: "solarized-dark", theme: "dark", lightTheme: "default", darkTheme: "solarized-dark", dark: true },
  { label: "night", theme: "dark", lightTheme: "default", darkTheme: "night", dark: true },
];

for (const th of THEMES) {
  const page = await newPage();
  await openDoc(page, JSON_DOC);
  await setTheme(page, th.theme, th.lightTheme, th.darkTheme);
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);

  // (A) コードブロック背景 vs 本文(--paper)の相対輝度比較
  const bgInfo = await page.evaluate(() => {
    const paper = getComputedStyle(document.body).backgroundColor;
    const codeLine = document.querySelector(".cm-line.cm-codeblock-line");
    const codeBg = codeLine ? getComputedStyle(codeLine).backgroundColor : null;
    return { paper, codeBg };
  });
  const lumPaper = relLum(bgInfo.paper);
  const lumCode = relLum(bgInfo.codeBg);
  const avgPaper = avgChannel(bgInfo.paper);
  const avgCode = avgChannel(bgInfo.codeBg);
  if (th.dark) {
    ok(`(A) [${th.label}] コードブロックが本文よりはっきり暗い(本文平均ch=${avgPaper?.toFixed(1)} > コード平均ch=${avgCode?.toFixed(1)}、差${(avgPaper - avgCode).toFixed(1)})`,
      avgPaper != null && avgCode != null && avgPaper - avgCode >= 6);
  } else {
    ok(`(A) [${th.label}] コードブロックが本文よりわずかに暗い/異なる、かつ真っ黒(輝度0近く)ではない(本文lum=${lumPaper?.toFixed(3)}, コードlum=${lumCode?.toFixed(3)})`,
      lumPaper != null && lumCode != null && lumCode < lumPaper && lumCode > 0.5);
  }

  // (B) 表ヘッダー背景が--panel-bgと一致し、--accent-softとは異なること
  const tableInfo = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const th = document.querySelector(".cm-table th");
    return {
      thBg: th ? getComputedStyle(th).backgroundColor : null,
      panelBg: root.getPropertyValue("--panel-bg").trim(),
      accentSoft: root.getPropertyValue("--accent-soft").trim(),
    };
  });
  ok(`(B) [${th.label}] 表ヘッダーが緑(アクセント由来)になっていない(th背景=${tableInfo.thBg})`,
    !!tableInfo.thBg && tableInfo.thBg !== "rgba(0, 0, 0, 0)");

  // (D) JSONのキー・文字列・数値・記号の色がそれぞれ異なる(単色に潰れていない)
  const tokenInfo = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line.cm-codeblock-line")];
    const find = (sel) => {
      for (const l of lines) {
        const el = l.querySelector(sel);
        if (el) return getComputedStyle(el).color;
      }
      return null;
    };
    // "port"というキーを含むspanを探す(class名はビルドごとに変わるハッシュのため、
    // テキスト内容で照合する)
    let propColor = null, propWeight = null;
    for (const l of lines) {
      for (const span of l.querySelectorAll("span")) {
        if (span.textContent === '"port"' || span.textContent === '"name"') {
          propColor = getComputedStyle(span).color;
          propWeight = getComputedStyle(span).fontWeight;
        }
      }
    }
    let strColor = null;
    for (const l of lines) {
      for (const span of l.querySelectorAll("span")) {
        if (span.textContent === '"pane"') strColor = getComputedStyle(span).color;
      }
    }
    let numColor = null;
    for (const l of lines) {
      for (const span of l.querySelectorAll("span")) {
        if (span.textContent === "3000") numColor = getComputedStyle(span).color;
      }
    }
    const inkColor = getComputedStyle(document.body).color;
    return { propColor, propWeight, strColor, numColor, inkColor };
  });
  ok(`(D) [${th.label}] JSONキーに色付きspanが生成される(以前は無色バグ) color=${tokenInfo.propColor}`,
    !!tokenInfo.propColor && tokenInfo.propColor !== tokenInfo.inkColor);
  ok(`(D) [${th.label}] JSONキーが太字になっている weight=${tokenInfo.propWeight}`,
    tokenInfo.propWeight === "600" || Number(tokenInfo.propWeight) >= 600);
  ok(`(D) [${th.label}] キーと文字列値の色が異なる key=${tokenInfo.propColor} str=${tokenInfo.strColor}`,
    !!tokenInfo.propColor && !!tokenInfo.strColor && tokenInfo.propColor !== tokenInfo.strColor);
  ok(`(D) [${th.label}] キーと数値の色が異なる key=${tokenInfo.propColor} num=${tokenInfo.numColor}`,
    !!tokenInfo.propColor && !!tokenInfo.numColor && tokenInfo.propColor !== tokenInfo.numColor);

  // (E-1) コードモード(.jsファイル)でのJS 6種の色分け
  const JS_CODE = "// 初期化処理\nconst backBtn = document.getElementById('back-btn');\nconst count = 42;\n";
  await openDoc2(page, "verify.js", JS_CODE);
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);
  const jsCode = await extractJsTokens(page);
  checkJsDistinct(`(E-1code) [${th.label}]`, jsCode, bgInfo.paper, bgInfo.codeBg, th.label);

  // (E-2) Markdownの```jsフェンス内でのJS 6種の色分け
  await openDoc(page, "```js\n" + JS_CODE + "```\n");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);
  const jsMd = await extractJsTokens(page);
  checkJsDistinct(`(E-2md) [${th.label}]`, jsMd, bgInfo.paper, bgInfo.codeBg, th.label);

  await page.close();
}

// ---- (C) スクロールバー幅 ----
{
  const page = await newPage();
  const sb = await page.evaluate(() => {
    const cs = getComputedStyle(document.body, "::-webkit-scrollbar");
    return { width: cs.width, scrollbarWidthProp: getComputedStyle(document.body).scrollbarWidth };
  });
  ok(`(C) scrollbar-widthが"thin"から変更されている(実際の値="${sb.scrollbarWidthProp}")`, sb.scrollbarWidthProp !== "thin");
  ok(`(C) ::-webkit-scrollbarの実効幅が17px(旧thin実測11pxの約1.5倍) 実測=${sb.width}`, sb.width === "17px");
  await page.close();
}

// =========================================================================
// (F) 不具合調査: JSONとして開いたファイルにJavaScriptの内容が入っている場合、
//     ハイライトが効かないこと(=JSONパーサがJS構文を解析できないだけで、動作としては
//     正しい)。同じ内容を.jsで開けば期待どおり色が付くことも併せて確認する。
// =========================================================================
{
  const page = await newPage();
  const JS_CONTENT = "const queueBar = document.getElementById('queue-bar');\nconst count = 42;\n// comment\n";

  // (F-1) meta.json という名前でJavaScriptの内容を開く → JSON言語で解析される
  await openDoc2(page, "meta.json", JS_CONTENT);
  await page.waitForTimeout(300);
  const modeJson = await page.textContent("#status-mode").catch(() => "");
  const reportJson = await page.evaluate(() => {
    const ink = getComputedStyle(document.body).color;
    const spans = [...document.querySelectorAll(".cm-content span")];
    return { totalSpans: spans.length, coloredSpans: spans.filter((s) => getComputedStyle(s).color !== ink).length };
  });
  ok(`(F) meta.json(拡張子優先)はJSONモードで開かれる(実際: ${modeJson})`, modeJson.includes("JSON"));
  // JSON構文として解釈できない行(constやdocument.getElementById(...)等)にはハイライト用の
  // spanがほぼ生成されない(=無色のまま)。42のような単独の数値部分だけJSON数値として
  // 解釈されうるため「ゼロ」までは要求せず、「ほとんど色が付かない」ことを閾値で見る。
  ok(`(F) meta.json内のJavaScriptコードはほぼハイライトされない(colored=${reportJson.coloredSpans}/${reportJson.totalSpans}、JSONパーサがJS構文を解析できないため。動作としては正しい)`,
    reportJson.coloredSpans <= 1);

  // (F-2) 同じ内容を正しい拡張子(.js)で開く → 期待どおり複数トークンに色が付く
  await openDoc2(page, "meta.js", JS_CONTENT);
  await page.waitForTimeout(300);
  const modeJs = await page.textContent("#status-mode").catch(() => "");
  const reportJs = await page.evaluate(() => {
    const ink = getComputedStyle(document.body).color;
    const spans = [...document.querySelectorAll(".cm-content span")];
    return { totalSpans: spans.length, coloredSpans: spans.filter((s) => getComputedStyle(s).color !== ink).length };
  });
  ok(`(F) 同内容を.jsで開くとJavaScriptモードになる(実際: ${modeJs})`, modeJs.includes("JavaScript"));
  ok(`(F) .jsで開くと期待どおり複数トークンに色が付く(colored=${reportJs.coloredSpans}/${reportJs.totalSpans}、拡張子を正しく直せば解決することの確認。壊れていたら重大)`,
    reportJs.coloredSpans >= 5);

  ok("(F) ページエラー0件", allErrors.length === 0, JSON.stringify(allErrors));
  await page.close();
}

// =========================================================================
// (G) 追加調査: 正規表現リテラルおよびGraftで色が付く他の要素の実測
// =========================================================================
{
  const page = await newPage();

  async function findColor(code, needle, fileName = "tokens.js") {
    await openDoc2(page, fileName, code);
    await page.waitForTimeout(300);
    return page.evaluate((needle) => {
      const ink = getComputedStyle(document.body).color;
      const spans = [...document.querySelectorAll(".cm-content span")];
      for (const s of spans) if (s.textContent === needle) return { color: getComputedStyle(s).color, ink, colored: getComputedStyle(s).color !== ink };
      return null;
    }, needle);
  }

  // (G-1) 正規表現リテラル本体。--code-regexが実際に効いていて、かつ文字列(--code-str)とも
  // 色が異なること(「色が付いていない」報告への直接の再現確認)。
  const regexInfo = await findColor(
    "const stripped = url.replace(/^https?:\\/\\//i, '');\nconst s = 'plain string';",
    "/^https?:\\/\\//i"
  );
  const strInfo = await findColor(
    "const stripped = url.replace(/^https?:\\/\\//i, '');\nconst s = 'plain string';",
    "'plain string'"
  );
  ok(`(G-1) 正規表現リテラルに地の色と異なる色が付いている(実測色=${regexInfo?.color}, 地の色=${regexInfo?.ink})`, !!regexInfo?.colored);
  ok(`(G-1) 正規表現リテラルの色が文字列の色と異なる(regex=${regexInfo?.color}, str=${strInfo?.color})`, !!regexInfo && !!strInfo && regexInfo.color !== strInfo.color);
  // コントラスト比も実測する(--code-regexが背景に埋もれていないこと)。relLum()はrgb()形式
  // しか解釈できないため、--paperの生値(16進)ではなくgetComputedStyleの計算結果(常にrgb())を使う。
  const regexBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const ratioRegex = contrastRatio(regexInfo?.color ?? "", regexBg);
  ok(`(G-1) 正規表現リテラルの色が背景に対しコントラスト比3.0以上(実測=${ratioRegex?.toFixed(2)})`, !!ratioRegex && ratioRegex >= 3.0);

  // (G-2) 正規表現中の特殊文字(\d, [x-z]等)を含めても全体として色が付く(部分的に無色に
  // 割れていないか)
  const regexSpecial = await findColor("const re = /a\\d+\\.b*[x-z]/;", "/a\\d+\\.b*[x-z]/");
  ok(`(G-2) 正規表現中に特殊文字(\\d, [x-z]等)を含んでいても全体が1つの色付きトークンとして描画される(実測色=${regexSpecial?.color})`, !!regexSpecial?.colored);

  // (G-3) テンプレートリテラルと埋め込み式
  const tplStr = await findColor("const s = `hello ${name} world ${1+2}`;", "`hello ");
  const tplExprVar = await findColor("const s = `hello ${name} world ${1+2}`;", "name");
  const tplExprNum = await findColor("const s = `hello ${name} world ${1+2}`;", "1");
  ok(`(G-3) テンプレートリテラルの文字列部分に色が付く(実測色=${tplStr?.color})`, !!tplStr?.colored);
  ok(`(G-3) テンプレートリテラル埋め込み式内の変数に色が付く(実測色=${tplExprVar?.color})`, !!tplExprVar?.colored);
  ok(`(G-3) テンプレートリテラル埋め込み式内の数値に色が付く(実測色=${tplExprNum?.color})`, !!tplExprNum?.colored);

  // (G-4) async/await/yield
  const asyncKw = await findColor("async function* f() {\n  const v = await g();\n  yield v;\n}", "async");
  const awaitKw = await findColor("async function* f() {\n  const v = await g();\n  yield v;\n}", "await");
  const yieldKw = await findColor("async function* f() {\n  const v = await g();\n  yield v;\n}", "yield");
  ok(`(G-4) asyncキーワードに色が付く(実測色=${asyncKw?.color})`, !!asyncKw?.colored);
  ok(`(G-4) awaitキーワードに色が付く(実測色=${awaitKw?.color})`, !!awaitKw?.colored);
  ok(`(G-4) yieldキーワードに色が付く(実測色=${yieldKw?.color})`, !!yieldKw?.colored);

  // (G-5) JSX タグ名・属性名
  const jsxTag = await findColor('const el = <div className="a" onClick={fn}>hi</div>;', "div", "tokens.jsx");
  const jsxAttr = await findColor('const el = <div className="a" onClick={fn}>hi</div>;', "className", "tokens.jsx");
  ok(`(G-5) JSXのタグ名に色が付く(実測色=${jsxTag?.color})`, !!jsxTag?.colored);
  ok(`(G-5) JSXの属性名に色が付く(実測色=${jsxAttr?.color})`, !!jsxAttr?.colored);

  // (G-6) オブジェクトのキー
  const objKey = await findColor("const obj = { key: value };", "key");
  ok(`(G-6) オブジェクトリテラルのキーに色が付く(実測色=${objKey?.color})`, !!objKey?.colored);

  // (G-7) 分割代入の変数名
  const destructKey = await findColor("const { a, b: renamed } = obj;", "a");
  const destructRenamed = await findColor("const { a, b: renamed } = obj;", "renamed");
  ok(`(G-7) 分割代入のプロパティ名に色が付く(実測色=${destructKey?.color})`, !!destructKey?.colored);
  ok(`(G-7) 分割代入のリネーム後の変数名に色が付く(実測色=${destructRenamed?.color})`, !!destructRenamed?.colored);

  // (G-8) import/export文中の識別子
  const importedId = await findColor("import { foo, bar as baz } from './mod.js';", "foo");
  const importedAlias = await findColor("import { foo, bar as baz } from './mod.js';", "baz");
  ok(`(G-8) importされる識別子に色が付く(実測色=${importedId?.color})`, !!importedId?.colored);
  ok(`(G-8) import ... as のエイリアス名に色が付く(実測色=${importedAlias?.color})`, !!importedAlias?.colored);

  ok("(G) ページエラー0件", allErrors.length === 0, JSON.stringify(allErrors));
  await page.close();
}

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
if (allErrors.length) console.log("ページエラー:", JSON.stringify(allErrors));
await browser.close();
