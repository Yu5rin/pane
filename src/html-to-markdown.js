// クリップボードのHTMLをMarkdownへ変換する(スマートペースト、仕様書 第2.9.3節)。
// 他アプリ(Word/ブラウザ等)からコピーした書式付きテキストを、Paneの記法に近い
// Markdownへ簡易変換する。凝った構造(ネストしたテーブルの結合セル等)は諦めて
// プレーンテキスト寄りにフォールバックする方針(スマートペーストは「壊れないこと」を優先する)。
//
// isHtmlInputTooDangerous(): html-sanitize.js と同じ基準(入力の長さ・ネスト段数)で、
// DOMParserに渡す前に危険な入力を弾く。クリップボードのHTMLも生HTMLと同じく信頼できない
// 入力であり、DOMParser.parseFromString()自体が深いネストに対してほぼ二次関数的な
// コストを持つ点も共通のため、判定ロジックは一箇所(html-sanitize.js)にまとめて共用する。
import { isHtmlInputTooDangerous } from "./html-sanitize.js";

function textOf(node) {
  return node.textContent.replace(/\s+/g, " ").trim();
}

function inline(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent.replace(/\s+/g, " ");
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    const inner = inline(child);
    switch (tag) {
      case "strong": case "b": out += inner.trim() ? `**${inner}**` : ""; break;
      case "em": case "i": out += inner.trim() ? `*${inner}*` : ""; break;
      case "del": case "s": case "strike": out += inner.trim() ? `~~${inner}~~` : ""; break;
      case "code": out += inner.trim() ? `\`${inner}\`` : ""; break;
      case "mark": out += inner.trim() ? `==${inner}==` : ""; break;
      case "sup": out += inner.trim() ? `^${inner}^` : ""; break;
      case "sub": out += inner.trim() ? `~${inner}~` : ""; break;
      case "br": out += "  \n"; break;
      case "a": {
        const href = child.getAttribute("href") || "";
        out += href ? `[${inner || href}](${href})` : inner;
        break;
      }
      case "img": {
        const alt = child.getAttribute("alt") || "";
        const src = child.getAttribute("src") || "";
        out += src ? `![${alt}](${src})` : "";
        break;
      }
      default: out += inner;
    }
  }
  return out;
}

// 中にあれば「入れ物」とみなすブロック要素。
const BLOCK_TAGS = "p,div,h1,h2,h3,h4,h5,h6,ul,ol,table,pre,blockquote,hr,section,article";

// リストを行の並びにする。入れ子のリストは、親の項目の下へ字下げして続ける。
// 以前は項目の中身をすべて1行のインラインとして読んでいたので、入れ子のリストが親の項目の
// 文字とつながって「親子1子2」のような1行になっていた(2026-11 の点検)。
function listLines(listEl, depth) {
  const ordered = listEl.tagName.toLowerCase() === "ol";
  const indent = "  ".repeat(depth * 2); // 番号付きの下でも入れ子と認識されるよう、1段につき4つ
  const lines = [];
  let n = 1;
  for (const li of listEl.children) {
    if (li.tagName.toLowerCase() !== "li") continue;
    // 項目自身の文字(入れ子のリストを除いた部分)と、入れ子のリストとを分ける。
    const own = li.cloneNode(true);
    for (const nested of [...own.querySelectorAll("ul,ol")]) nested.remove();
    const text = inline(own).replace(/\s*\n\s*/g, " ").trim();
    lines.push(`${indent}${ordered ? `${n++}. ` : "- "}${text}`);
    for (const nested of li.children) {
      const t = nested.tagName.toLowerCase();
      if (t === "ul" || t === "ol") lines.push(...listLines(nested, depth + 1));
      // p や div に包まれた入れ子のリスト(Wordなど)も拾う。
      else for (const deep of nested.querySelectorAll(":scope > ul, :scope > ol")) lines.push(...listLines(deep, depth + 1));
    }
  }
  return lines;
}

function block(node, out, ctx) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent.replace(/\s+/g, " ").trim();
      if (t) out.push(t);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    const m = tag.match(/^h([1-6])$/);
    if (m) { out.push(`${"#".repeat(Number(m[1]))} ${inline(child).trim()}`); continue; }
    // div は、中にブロック(段落・見出し・リスト・表など)を持つなら入れ物として中へ降りる。
    // 以前は p と同じく1つの段落として扱っていたので、Webページやメールの本文
    // (全体が div で包まれている)を貼ると、段落も見出しもリストもつながった1行になっていた
    // (2026-11 の点検)。文字とインライン要素だけの div は、従来どおり1つの段落。
    if (tag === "div" && child.querySelector(BLOCK_TAGS)) { block(child, out, ctx); continue; }
    if (tag === "p" || tag === "div") { const t = inline(child).trim(); if (t) out.push(t); continue; }
    if (tag === "blockquote") {
      const inner = []; block(child, inner, ctx);
      out.push(inner.join("\n\n").split("\n").map((l) => "> " + l).join("\n"));
      continue;
    }
    if (tag === "pre") {
      const codeEl = child.querySelector("code");
      out.push("```\n" + (codeEl ? codeEl.textContent : child.textContent).replace(/\n$/, "") + "\n```");
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      // リストは1つのブロックとしてまとめてから積む(項目を1つずつ積むと、間に空行が入って
      // 各項目が段落として描かれる「ゆるいリスト」になる)。
      const items = listLines(child, 0);
      if (items.length) out.push(items.join("\n"));
      continue;
    }
    if (tag === "table") {
      // セルの中の「|」は「\|」にし、改行は空白にする。そのままだと列の区切りや行の区切りとして
      // 読まれて、表が崩れる(2026-11 の点検)。
      const cell = (c) => inline(c).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
      const rows = [...child.querySelectorAll("tr")].map((tr) => [...tr.children].map(cell));
      if (rows.length) {
        const cols = rows[0].length;
        out.push([
          "| " + rows[0].join(" | ") + " |",
          "| " + Array(cols).fill("---").join(" | ") + " |",
          ...rows.slice(1).map((r) => "| " + r.join(" | ") + " |"),
        ].join("\n"));
      }
      continue;
    }
    if (tag === "hr") { out.push("---"); continue; }
    if (tag === "br") continue;
    // 未対応のブロック要素は中身を再帰的に見る(div/section/article相当の包括タグ対策)
    block(child, out, ctx);
  }
}

// 「書式」と呼べる要素。1つも無ければ、そのHTMLはただの行の並びであって、
// Markdownへ変換しても得るものが無い(htmlIsPlainTextLike参照)。
const MEANINGFUL_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "table", "pre", "blockquote", "hr",
  "a[href]", "img",
  "strong", "b", "em", "i", "code", "del", "s", "strike", "mark", "sup", "sub",
].join(",");

/**
 * クリップボードのHTMLが「書式を持たない、ただの行の並び」かどうか。
 *
 * 【なぜ要るか】
 * メールソフトやテキスト系のアプリは、ただの複数行テキストをコピーしたときにも
 * text/html を一緒に載せる。その中身は各行を <div> や <p> で包んだだけのことが多い。
 * これをMarkdownへ変換すると、htmlToMarkdown は段落の区切りとして空行を入れるため、
 * 行数がほぼ倍になる。実機で21行のテキストを貼って35行になった
 * (docs/調査記録/修正-貼り付けで改行が増える.md)。
 *
 * 行頭の全角スペースが消える・連続した半角スペースが1つに縮む、といった副作用もある。
 * HTMLの空白の扱いとしては正しいが、書式が何も無いHTMLに対してそこまでする理由は無い。
 *
 * 見出し・リスト・表・引用・コード・リンク・画像・強調のどれか1つでもあれば、
 * 変換する値打ちがあるものとして従来どおり htmlToMarkdown に回す。
 */
export function htmlIsPlainTextLike(html) {
  if (!html) return false;
  // 危険な入力は htmlToMarkdown 側が空文字を返して自動的にプレーンテキストへ落ちる。
  // ここで判定を試みてDOMParserを走らせる必要は無い(そのコストこそ避けたいもの)。
  if (isHtmlInputTooDangerous(html)) return false;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return !doc.body.querySelector(MEANINGFUL_TAGS);
  } catch {
    return false;
  }
}

export function htmlToMarkdown(html) {
  // パース前に長さ・ネスト段数を見積もり、危険なら丸ごと打ち切る。呼び出し側(main.js)は
  // 戻り値が空文字列のときクリップボードのプレーンテキストへ自動的にフォールバックするため、
  // ここでは「変換できなかった」ものとして扱えばよく、別途プレーンテキスト化する必要はない。
  if (isHtmlInputTooDangerous(html)) {
    console.log(`Pane: 貼り付けられたHTMLが長すぎる/ネストが深すぎるため変換を打ち切りました(文字数=${String(html ?? "").length})`);
    return "";
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  block(doc.body, out, {});
  return out.join("\n\n");
}
