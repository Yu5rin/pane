// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)で、CSSの中のCSS変数を読み書きする。
//
// 作成補助の画面は「CSSがただ1つの原本」という作り(仕様書)。フォームで色を変えたときは、
// CSSの本文のうち `:root { ... }`(ライト)または `html[data-theme="dark"] { ... }`(ダーク)の
// 中の宣言だけを書き換え、それ以外(利用者がセレクタを直接書いたもの・コメント)には触れない。
// 画面側はここで作った新しいCSSとの差分だけをエディタへ流し込む(minimalChange)。
//
// DOMにもCodeMirrorにも依存しない純粋な関数だけを置く(.verify-css-vars.mjs で固定)。
// 本格的なCSSパーサーは持たない。コメント・文字列・括弧の入れ子を読み飛ばしながら、
// 最上位のルールの「セレクタ { 本文 }」の位置と、本文の中の宣言の位置を拾うだけで足りる。

/** ライト用の変数を書くブロック。sample.css(Pane/ThemeFolderService.cs)と同じ書き方。 */
export const LIGHT_SELECTOR = ":root";
/** ダーク用の変数を書くブロック。ライトと同じ値でよい変数はここに書かなくてよい。 */
export const DARK_SELECTOR = 'html[data-theme="dark"]';

// セレクタの比較用に正規化する(空白を除き、引用符を " に揃える)。
function normalizeSelector(sel) {
  return sel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "").replace(/'/g, '"');
}

function selectorFor(scope) {
  return scope === "dark" ? DARK_SELECTOR : LIGHT_SELECTOR;
}

// css[i] から始まるコメント・文字列を読み飛ばした位置を返す。どちらでもなければ i のまま。
function skipCommentOrString(css, i) {
  if (css[i] === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }
  if (css[i] === '"' || css[i] === "'") {
    const quote = css[i];
    let j = i + 1;
    while (j < css.length && css[j] !== quote) {
      if (css[j] === "\\") j++;
      j++;
    }
    return Math.min(j + 1, css.length);
  }
  return i;
}

/**
 * 最上位のルールを並べる。@media 等の入れ子は1つのルールとして扱い、中には入らない。
 * 戻り値の各要素: { selector, start(セレクタの先頭), bodyStart("{"の次), bodyEnd("}"の位置), end("}"の次) }
 */
export function findTopLevelRules(css) {
  const rules = [];
  let i = 0;
  let selStart = 0;
  while (i < css.length) {
    const skipped = skipCommentOrString(css, i);
    if (skipped !== i) { i = skipped; continue; }
    const ch = css[i];
    if (ch === "{") {
      const bodyStart = i + 1;
      let depth = 1;
      let j = bodyStart;
      while (j < css.length && depth > 0) {
        const s = skipCommentOrString(css, j);
        if (s !== j) { j = s; continue; }
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        if (depth > 0) j++;
      }
      const bodyEnd = Math.min(j, css.length);
      const rawSelector = css.slice(selStart, i);
      // 前のルールとの間にあるコメントはセレクタに含めない(開始位置も後ろへずらす)。
      const leading = rawSelector.match(/^(\s|\/\*[\s\S]*?\*\/)*/)[0];
      rules.push({
        selector: rawSelector.slice(leading.length).trim(),
        start: selStart + leading.length,
        bodyStart,
        bodyEnd,
        end: Math.min(bodyEnd + 1, css.length),
      });
      i = bodyEnd + 1;
      selStart = i;
      continue;
    }
    if (ch === ";") {
      // @import などの本文を持たない文。次のルールのセレクタに混ぜない。
      selStart = i + 1;
    }
    i++;
  }
  return rules;
}

/**
 * ルールの本文から宣言を拾う。各要素: { name, value, start(名前の先頭), valueStart, valueEnd, end(";"の次、無ければ本文の末尾) }
 */
export function findDeclarations(css, bodyStart, bodyEnd) {
  const decls = [];
  let i = bodyStart;
  let declStart = bodyStart;
  let depth = 0;
  const flush = (endPos, terminatorLen) => {
    const text = css.slice(declStart, endPos);
    const colon = text.indexOf(":");
    if (colon > 0) {
      const leading = text.match(/^(\s|\/\*[\s\S]*?\*\/)*/)[0];
      const name = text.slice(leading.length, colon).trim();
      if (name) {
        const afterColon = declStart + colon + 1;
        const rawValue = css.slice(afterColon, endPos);
        const valueLead = rawValue.match(/^\s*/)[0].length;
        const valueTrail = rawValue.length - rawValue.trimEnd().length;
        decls.push({
          name,
          value: rawValue.trim(),
          start: declStart + leading.length,
          valueStart: afterColon + valueLead,
          valueEnd: endPos - valueTrail,
          end: endPos + terminatorLen,
        });
      }
    }
  };
  while (i < bodyEnd) {
    const skipped = skipCommentOrString(css, i);
    if (skipped !== i) {
      // 宣言の前のコメントは宣言に含めない。
      if (css.slice(declStart, i).trim() === "") declStart = skipped;
      i = skipped;
      continue;
    }
    const ch = css[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      flush(i, 1);
      declStart = i + 1;
    }
    i++;
  }
  if (css.slice(declStart, bodyEnd).trim()) flush(bodyEnd, 0);
  return decls;
}

function findScopeRules(css, scope) {
  const want = normalizeSelector(selectorFor(scope));
  return findTopLevelRules(css).filter((r) => normalizeSelector(r.selector) === want);
}

/**
 * scope("light" | "dark")のブロックに書かれた変数を Map で返す。同じ名前が何度も書かれて
 * いれば、CSSと同じく後ろのものを採る。
 */
export function readVars(css, scope) {
  const out = new Map();
  for (const rule of findScopeRules(css, scope)) {
    for (const d of findDeclarations(css, rule.bodyStart, rule.bodyEnd)) {
      if (d.name.startsWith("--")) out.set(d.name, d.value);
    }
  }
  return out;
}

/**
 * scope のブロックの変数 name を value にした新しいCSSを返す。
 *   - 既に書かれていれば、最後の宣言の値だけを差し替える(前後の空白・コメントはそのまま)
 *   - 書かれていなければ、最後のブロックの末尾に1行足す
 *   - ブロック自体が無ければ、CSSの末尾にブロックを足す
 * value が空なら removeVar と同じ。
 */
export function setVar(css, scope, name, value) {
  const v = String(value ?? "").trim();
  if (!v) return removeVar(css, scope, name);
  const rules = findScopeRules(css, scope);
  for (let r = rules.length - 1; r >= 0; r--) {
    const decls = findDeclarations(css, rules[r].bodyStart, rules[r].bodyEnd).filter((d) => d.name === name);
    if (decls.length) {
      const d = decls[decls.length - 1];
      return css.slice(0, d.valueStart) + v + css.slice(d.valueEnd);
    }
  }
  if (rules.length) {
    const rule = rules[rules.length - 1];
    const body = css.slice(rule.bodyStart, rule.bodyEnd);
    // 最後の宣言に ; が無ければ補う(無いまま足すと前の値に続けて読まれてしまう)。
    const trimmedBody = body.replace(/\s+$/, "");
    const needsSemicolon = trimmedBody.length > 0 && !/[;{]\s*$/.test(trimmedBody.replace(/\/\*[\s\S]*?\*\/\s*$/, "")) && findDeclarations(css, rule.bodyStart, rule.bodyEnd).length > 0;
    const insertAt = rule.bodyStart + trimmedBody.length;
    const line = `${needsSemicolon ? ";" : ""}\n  ${name}: ${v};\n`;
    return css.slice(0, insertAt) + line + css.slice(rule.bodyEnd);
  }
  const sep = css.length === 0 || css.endsWith("\n\n") ? "" : css.endsWith("\n") ? "\n" : "\n\n";
  return `${css}${sep}${selectorFor(scope)} {\n  ${name}: ${v};\n}\n`;
}

/** scope のブロックから変数 name の宣言をすべて取り除いた新しいCSSを返す(行ごと消す)。 */
export function removeVar(css, scope, name) {
  let out = css;
  // 後ろから消すと、前の位置がずれない。
  const rules = findScopeRules(out, scope).reverse();
  for (const rule of rules) {
    const decls = findDeclarations(out, rule.bodyStart, rule.bodyEnd).filter((d) => d.name === name).reverse();
    for (const d of decls) {
      let from = d.start;
      let to = d.end;
      // 行にほかの内容が無ければ、行ごと(改行まで)消す。
      const lineStart = out.lastIndexOf("\n", from - 1) + 1;
      const nl = out.indexOf("\n", to);
      const lineEnd = nl < 0 ? out.length : nl;
      const rest = out.slice(to, lineEnd);
      const restIsCommentOnly = /^\s*(\/\*[\s\S]*?\*\/)?\s*$/.test(rest);
      if (out.slice(lineStart, from).trim() === "" && restIsCommentOnly) {
        from = lineStart;
        to = nl < 0 ? out.length : nl + 1;
      }
      out = out.slice(0, from) + out.slice(to);
    }
  }
  return out;
}

/**
 * 2つの文字列の違いを、1か所の置き換え { from, to, insert } で表す(共通の先頭と末尾を除く)。
 * フォームで1項目を変えたときに、エディタ全体を差し替えずにその部分だけを変えるため
 * (カーソル位置と元に戻すの単位を保つ)。同じなら null。
 */
export function minimalChange(before, after) {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA--; }
  return { from: start, to: endB, insert: after.slice(start, endA) };
}
