// 内容からの編集モード自動判定エンジン(仕様書 第1章の拡張)。
// 「新規ファイルにコードを貼り付けたら勝手にコードモードにしてほしい」という要望に応えるための
// 判定処理そのものだけを純粋関数として切り出す。DOM・CodeMirror・main.jsの状態には
// 一切依存しない(単体で検証しやすくするため。適用タイミング・UI通知はmain.js側の責務)。
//
// export function detectContentMode(text) -> { mode, language, confidence, reason }
//   mode:       "markdown" | "code" | "plain"
//   language:   modeが"code"の時のみ意味を持つ言語ID(src/file-types.js の FILE_TYPES[].id と一致)。
//               特定できなければ null。
//   confidence: 0〜1。呼び出し側はこれを閾値判定してから適用すること。
//   reason:     判定根拠の短い日本語文字列(ステータスバー表示・デバッグ用)。

// 誤爆が一番うるさいのは書き始めのため、短すぎるテキストは保守的に判定しない。
const MIN_LENGTH = 40;
const MIN_LINES = 3;

// ---- Markdown固有記法の検出 ----
// フェンスコードブロックの「中身」は判定対象から除外する。Markdown文書の中にコードブロックが
// あるのはごく普通で、中身をそのままコード判定のシグナルに使うと事故(貼り付けたMarkdownを
// コードと誤判定する)を招くため。フェンスの開始/終了行自体は「フェンスがある」という
// Markdownシグナルとして残す(中身は空行に置き換え、行数はズレさせない)。
function stripFencedCodeBodies(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  let fenceChar = "";
  for (const line of lines) {
    const openMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!inFence && openMatch) {
      inFence = true;
      fenceChar = openMatch[1][0];
      out.push(line);
      continue;
    }
    if (inFence) {
      const closeRe = fenceChar === "`" ? /^ {0,3}`{3,}\s*$/ : /^ {0,3}~{3,}\s*$/;
      if (closeRe.test(line)) { inFence = false; out.push(line); } else out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Markdown固有記法のスコアリング。score(重み合計)とhits(命中した記法カテゴリ名の配列)を返す。
function scoreMarkdown(text) {
  const s = stripFencedCodeBodies(text);
  let score = 0;
  const hits = [];

  const headingMatches = s.match(/^ {0,3}#{1,6} +\S.*$/gm) || [];
  if (headingMatches.length >= 1) { score += 1; hits.push("見出し"); }
  if (headingMatches.length >= 3) score += 1; // 見出しが1〜2個だけではコード中のコメントと区別しづらいため弱めに扱う

  const listMatches = s.match(/^ {0,3}(?:[-*+] +\S|\d+\. +\S)/gm) || [];
  if (listMatches.length >= 1) { score += 2; hits.push("リスト"); }

  if (/\*\*[^*\n]+\*\*/.test(s) || /__[^_\n]+__/.test(s)) { score += 1; hits.push("強調"); }

  // 表: ヘッダー行の直後に "---|---" のような区切り行がある(Markdown表にほぼ固有の記法)。
  const hasTable = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/m.test(s);
  if (hasTable) { score += 3; hits.push("表"); }

  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(s)) { score += 2; hits.push("リンク"); }

  if (/^ {0,3}>\s?\S/m.test(s)) { score += 1; hits.push("引用"); }

  const fenceLines = s.match(/^ {0,3}(`{3,}|~{3,})/gm) || [];
  if (fenceLines.length >= 2) { score += 1; hits.push("コードフェンス"); }

  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(s)) { score += 1; hits.push("水平線"); }

  return { score, hits, hasTable };
}

// ---- 確実な手がかり(シバン行・宣言等) ----
// これらが見つかった場合はconfidenceを高くする(仕様書の指示どおり)。
const STRONG_SIGNALS = [
  { re: /^#!.*\bpython[\d.]*\b/m, language: "python", reason: "シバン行(python)" },
  { re: /^#!.*\b(bash|sh|zsh|ksh|fish)\b/m, language: "shell", reason: "シバン行(シェル)" },
  { re: /^#!.*\bnode\b/m, language: "javascript", reason: "シバン行(node)" },
  { re: /^#!.*\bperl\b/m, language: "perl", reason: "シバン行(perl)" },
  { re: /^#!.*\bruby\b/m, language: "ruby", reason: "シバン行(ruby)" },
  { re: /<\?php/, language: "php", reason: "PHP開始タグ" },
  { re: /^\s*#include\s*<[\w./]+>/m, language: "c", reason: "#include" }, // C/C++の判別は下で補正
  { re: /^\s*package\s+main\s*$/m, language: "go", reason: "package main" },
  { re: /^\s*using\s+System\s*;/m, language: "csharp", reason: "using System;" },
  { re: /<!DOCTYPE\s+html/i, language: "html", reason: "DOCTYPE宣言" },
  { re: /^\s*<\?xml\s+version\s*=/m, language: "xml", reason: "XML宣言" },
];
// #include<...> はC/C++共通のため、C++固有の記法が見えたらcppへ補正する。
const CPP_HINT_RE = /\bstd::|namespace\s+\w+|cout\s*<<|\btemplate\s*</;

// ---- 予約語・記号によるスコアリング(強い手がかりが無かった場合の一般判定) ----
// 各要素は [正規表現, 重み]。1言語につき複数マッチすれば加算する。
const LANGUAGE_RULES = [
  { id: "typescript", rules: [
    [/\binterface\s+\w+\s*{/, 3],
    [/:\s*(string|number|boolean|any|void|unknown|never)\b/, 3],
    [/^\s*type\s+\w+\s*=/m, 2],
    [/<[\w.]+>\s*\(/, 1],
    [/\bimport\s+.*\bfrom\s+['"]/, 1],
    [/\bexport\s+(default\s+)?(class|function|const|interface|type)\b/, 1],
  ] },
  { id: "javascript", rules: [
    [/\b(const|let|var)\s+\w+\s*=/, 1],
    [/function\s*\w*\s*\([^)]*\)\s*{/, 2],
    [/=>\s*[{(]/, 2],
    // 実機報告(改善②)への対応: "chrome.action.onClicked.addListener(async () => {...})"の
    // ような、インデントの無いコールバック登録コードでは上の"=>"ルールだけでは閾値
    // (LANGUAGE_SCORE_THRESHOLD=3)に届かなかった。"async ("はJS/TSのアロー関数・async関数に
    // ほぼ固有の組み合わせで誤判定のリスクが低いため、単独シグナルとして追加する。
    [/\basync\s*\(/, 2],
    [/\basync\s+function\b/, 2],
    [/console\.log\(/, 2],
    [/\brequire\(/, 1],
    [/\bexport\s+(default\s+)?(class|function|const)\b/, 1],
    [/\bimport\s+.*\bfrom\s+['"]/, 1],
  ] },
  { id: "python", rules: [
    [/^\s*def\s+\w+\s*\([^)]*\)\s*:\s*$/m, 3],
    [/^\s*(import|from)\s+[\w.]+/m, 2],
    [/\bself\b/, 1],
    [/^\s*class\s+\w+[\w(),\s]*:\s*$/m, 2],
    [/^\s*elif\b/m, 1],
    [/^\s*(if|for|while)\b.*:\s*$/m, 1],
    [/\bprint\(/, 1],
  ] },
  { id: "html", rules: [
    [/<!DOCTYPE\s+html/i, 4],
    [/<html[\s>]/i, 2],
    [/<\/?(div|span|head|body|script|style|section|header|footer|a|p)\b/i, 1],
  ] },
  { id: "xml", rules: [
    [/^\s*<\?xml\s+version\s*=/m, 4],
    [/<\/[\w:.-]+>/, 1],
    [/<[\w:.-]+[^>]*\/>/, 1],
  ] },
  { id: "css", rules: [
    [/[\w-]+\s*:\s*[^;{}]+;/, 2],
    [/@media\b/, 2],
    [/^\s*[.#][\w-]+[^{}]*{\s*$/m, 2],
  ] },
  { id: "sql", rules: [
    [/\bSELECT\b[\s\S]{0,200}\bFROM\b/i, 3],
    [/\bCREATE\s+TABLE\b/i, 3],
    [/\bINSERT\s+INTO\b/i, 2],
    [/\bWHERE\b/i, 1],
  ] },
  { id: "shell", rules: [
    [/^#!.*\b(bash|sh|zsh)\b/m, 3],
    [/^\s*(fi|then|elif|done)\s*$/m, 2],
    [/^\s*echo\s+/m, 1],
    [/\$\{?\w+\}?/, 1],
  ] },
  { id: "csharp", rules: [
    [/\busing\s+System\b/, 3],
    [/\bnamespace\s+\w+/, 2],
    [/\bConsole\.WriteLine/, 2],
    [/\bpublic\s+(class|static|void|interface)\b/, 1],
  ] },
  { id: "java", rules: [
    [/\bpublic\s+class\s+\w+/, 3],
    [/\bSystem\.out\.println/, 3],
    [/^\s*import\s+java\./m, 2],
    [/^\s*package\s+[\w.]+;\s*$/m, 1],
  ] },
  { id: "go", rules: [
    [/^\s*package\s+main\s*$/m, 3],
    [/\bfunc\s+\w+\s*\(/, 2],
    [/:=\s*/, 2],
    [/\bfmt\.Print/, 2],
  ] },
  { id: "rust", rules: [
    [/println!\(/, 3],
    [/\bfn\s+\w+\s*\(/, 2],
    [/\blet\s+mut\b/, 2],
    [/\buse\s+std::/, 2],
  ] },
  { id: "cpp", rules: [
    [/\bstd::/, 3],
    [/\bnamespace\s+\w+/, 2],
    [/\bcout\s*<</, 2],
    [/\btemplate\s*</, 2],
    [/\bclass\s+\w+\s*(:\s*public\s+\w+)?\s*{/, 1],
  ] },
  { id: "c", rules: [
    [/^\s*#include\s*<[\w.]+>/m, 2],
    [/\bprintf\s*\(/, 2],
    [/\bmalloc\s*\(/, 2],
    [/^\s*int\s+main\s*\(/m, 2],
  ] },
  { id: "yaml", rules: [
    [/^---\s*$/m, 2],
    [/^[\w.-]+:\s*(\S.*)?$/m, 1],
    [/^\s*-\s+\S/m, 1],
  ] },
];
const LANGUAGE_SCORE_THRESHOLD = 3;

// ---- 言語だけの判定(シバン行・JSON・予約語スコアリング)を共通化 ----
// detectContentMode()のステップ2〜4(Markdown/コード/プレーンという「モード」の決定に
// 関わる部分を除いた、純粋に「言語は何か」の判定ロジック)を切り出したもの。
// detectContentMode()自身と、下のdetectCodeLanguage()(改善②: コードモードで言語未設定の
// ときに使う、モード決定ゲート抜きの言語判定)の両方から呼ばれる。
function scoreLanguageOnly(raw) {
  // 確実な手がかり(シバン行・宣言等)。
  for (const sig of STRONG_SIGNALS) {
    if (sig.re.test(raw)) {
      const language = sig.language === "c" && CPP_HINT_RE.test(raw) ? "cpp" : sig.language;
      return { language, confidence: 0.92, reason: sig.reason };
    }
  }

  // JSON: JSON.parseが成功し、かつ結果がオブジェクト/配列の場合のみ(数値・文字列だけの
  // 短いテキストがJSONと誤判定されるのを防ぐ)。
  const trimmed = raw.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        return { language: "json", confidence: 0.95, reason: "JSONとして解析可能" };
      }
    } catch { /* JSONではない。次の判定へ */ }
  }

  // 予約語・記号のスコアリング。最高得点の言語が閾値を超えていればそれを採用する。
  let best = null;
  for (const { id, rules } of LANGUAGE_RULES) {
    let score = 0;
    for (const [re, weight] of rules) if (re.test(raw)) score += weight;
    if (!best || score > best.score) best = { id, score };
  }
  if (best && best.score >= LANGUAGE_SCORE_THRESHOLD) {
    return {
      language: best.id,
      confidence: Math.min(0.9, 0.3 + best.score * 0.09),
      reason: `${best.id}の特徴的な記法`,
    };
  }

  return { language: null, confidence: 0, reason: "特徴的な記法が見つかりませんでした" };
}

export function detectContentMode(text) {
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();
  const lineCount = trimmed ? trimmed.split("\n").length : 0;
  if (trimmed.length < MIN_LENGTH || lineCount < MIN_LINES) {
    return { mode: "plain", language: null, confidence: 0, reason: "テキストが短すぎるため判定しません" };
  }

  // 1. Markdown固有記法(フェンス内は除外)。1種類の記法だけでは(コード中のコメントの
  //    誤爆等を避けるため)不十分とし、原則2種類以上の記法が揃って初めてMarkdownと判定する。
  //    ただし表(ヘッダー+区切り行)はMarkdownにほぼ固有の記法のため、単独でも十分とする。
  const md = scoreMarkdown(raw);
  if (md.score >= 3 && (md.hits.length >= 2 || md.hasTable)) {
    return {
      mode: "markdown", language: null,
      confidence: Math.min(0.97, 0.4 + md.score * 0.08),
      reason: `Markdown記法(${md.hits.join("・")})`,
    };
  }

  // 2〜4. 言語判定(シバン行→JSON→予約語スコアリングの順、scoreLanguageOnly参照)。
  //       Markdownと断定できるほどではなかった場合に、コードだと確信できるシグナルが
  //       あればそちらを優先する。
  const lang = scoreLanguageOnly(raw);
  if (lang.language) {
    return { mode: "code", language: lang.language, confidence: lang.confidence, reason: lang.reason };
  }

  // どの弱いMarkdown記法よりも決定力が無ければ最後に緩くMarkdown判定を試す
  // (見出し1つだけ、等の弱い単独シグナルでも、コード判定が一切できなかった場合の次善)。
  if (md.score >= 2) {
    return {
      mode: "markdown", language: null,
      confidence: Math.min(0.6, 0.3 + md.score * 0.08),
      reason: `Markdown記法(${md.hits.join("・")})`,
    };
  }

  return { mode: "plain", language: null, confidence: 0.2, reason: "特徴的な記法が見つかりませんでした" };
}

// ---- コードモードで言語未設定のときの「言語だけ」の判定(改善②) ----
// 【背景】 detectContentMode()はMarkdown/コード/プレーンという「モード」自体を決める関数の
// ため、書き始めの誤爆(短いテキストでうっかりモードが切り替わってしまうこと)を防ぐ目的で
// MIN_LENGTH/MIN_LINESという強めのゲートを掛けている。この関数の呼び出し元
// (main.jsのmaybeAutoDetectCodeLanguage、「表示メニュー→コードモード」への手動切替直後、
// および言語未設定のコードモードで入力が続いている間)は、モードそのものは既に「コードで
// ある」と(ユーザー自身の操作で)確定済みで、外れても実害は構文ハイライトの色が違う
// だけ(モードが誤って切り替わることはない)。そのためモード決定用の強いゲートは適用せず、
// シバン行・JSON・言語別スコアリングという判定ロジックの中身(scoreLanguageOnly、
// STRONG_SIGNALS/LANGUAGE_RULES)だけをそのまま再利用する(依頼の「まず既存の判定機構を
// 読んで再利用できるか確認する」を踏まえた結論: ロジック本体は共通化して再利用しつつ、
// 「どれだけ短い/曖昧な内容から判定してよいか」というゲートの強さはモード決定用の
// detectContentMode()とは別物として扱う、という判断)。
// 極端に短い内容(記号数文字だけ等)でのノイズだけは避けたいので、最小限のゲートは残す。
const MIN_LENGTH_CODE_LANGUAGE = 8;
export function detectCodeLanguage(text) {
  const raw = typeof text === "string" ? text : "";
  if (raw.trim().length < MIN_LENGTH_CODE_LANGUAGE) {
    return { language: null, confidence: 0, reason: "テキストが短すぎるため判定しません" };
  }
  return scoreLanguageOnly(raw);
}
