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
      let i = 1;
      for (const li of child.children) {
        if (li.tagName.toLowerCase() !== "li") continue;
        const prefix = tag === "ol" ? `${i++}. ` : "- ";
        out.push(prefix + inline(li).trim());
      }
      continue;
    }
    if (tag === "table") {
      const rows = [...child.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).trim()));
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
