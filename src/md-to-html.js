// MarkdownをHTMLへ変換する。仕様書 E-05(HTMLとしてコピー)・X-02/X-03(HTMLエクスポート)で
// 共用する。ライブプレビューと同じ構文木(@lezer/markdown)を辿るため、見た目の解釈は一致する。
import { syntaxTree } from "@codemirror/language";
import { EMOJI_SHORTCODES } from "./markdown-extras.js";

function escText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ==mark== と脚注参照[^id]は構文木のノードを持たない(仕様書のマークダウン拡張は
// ライブプレビュー側で正規表現処理している)ため、プレーンテキスト部分にのみ適用する。
// opts.preserveWhitespace(仕様書 whitespaceOnExport="preserve")のときは、段落内の
// 単独改行(ソフトブレーク)を<br>に変換して見た目上も改行を保つ。既定(false="ignore")では
// 何もしない(HTMLの通常の空白畳み込みにより1つの空白として表示される、CommonMarkの既定挙動)。
function inlineTextToHtml(s, opts) {
  let h = escText(s);
  h = h.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  h = h.replace(/\[\^([^\]]+)\]/g, (_m, id) => `<sup id="fnref-${id}"><a href="#fn-${id}">${id}</a></sup>`);
  if (opts?.preserveWhitespace) h = h.replace(/\n/g, "<br>\n");
  return h;
}

function linkTarget(doc, node) {
  // Link/Image共通: 直接記法( [text](url) )の場合はURLノードから、
  // 未対応の参照記法はhrefなし(テキストのみ)として扱う。
  const urlNode = node.getChild("URL");
  return urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
}

// 範囲[from,to)内のインライン装飾を子ノードだけ辿って変換する(孫ノードは再帰呼び出しで処理)。
function inlineHtml(doc, tree, from, to, opts) {
  let html = "";
  let pos = from;
  const node = tree.resolve(from, 1);
  const container = node.from <= from && node.to >= to ? node : tree.topNode;

  function render(n) {
    let c = n.firstChild;
    while (c) {
      if (c.to <= from || c.from >= to) { c = c.nextSibling; continue; }
      if (c.from > pos) { html += inlineTextToHtml(doc.sliceString(pos, c.from), opts); pos = c.from; }
      switch (c.name) {
        case "StrongEmphasis": html += `<strong>${inlineHtml(doc, tree, c.from + 2, c.to - 2, opts)}</strong>`; pos = c.to; break;
        case "Emphasis": html += `<em>${inlineHtml(doc, tree, c.from + 1, c.to - 1, opts)}</em>`; pos = c.to; break;
        case "Strikethrough": html += `<del>${inlineHtml(doc, tree, c.from + 2, c.to - 2, opts)}</del>`; pos = c.to; break;
        case "Superscript": html += `<sup>${inlineHtml(doc, tree, c.from + 1, c.to - 1, opts)}</sup>`; pos = c.to; break;
        case "Subscript": html += `<sub>${inlineHtml(doc, tree, c.from + 1, c.to - 1, opts)}</sub>`; pos = c.to; break;
        case "InlineCode": html += `<code>${escText(doc.sliceString(c.from + 1, c.to - 1))}</code>`; pos = c.to; break;
        case "Emoji": {
          const code = doc.sliceString(c.from + 1, c.to - 1);
          html += EMOJI_SHORTCODES[code] ?? escText(doc.sliceString(c.from, c.to));
          pos = c.to;
          break;
        }
        case "Image": {
          const alt = c.getChild("LinkLabel") ? "" : ""; // altテキストの抽出は簡略化(直接記法のみ対応)
          const marks = c.getChildren("LinkMark");
          const textFrom = marks[0] ? marks[0].to : c.from;
          const textTo = marks[1] ? marks[1].from : textFrom;
          const altText = doc.sliceString(textFrom, textTo);
          html += `<img src="${escText(linkTarget(doc, c))}" alt="${escText(altText)}">`;
          pos = c.to;
          break;
        }
        case "Link": {
          const text = doc.sliceString(c.from, c.to);
          if (/^\[\^[^\]]+\]$/.test(text)) {
            // 脚注参照は本文と同じ扱い(inlineTextToHtmlの正規表現に委ねる)
            html += inlineTextToHtml(text, opts);
          } else {
            const marks = c.getChildren("LinkMark");
            const textFrom = marks[0] ? marks[0].to : c.from;
            const textTo = marks[1] ? marks[1].from : textFrom;
            const href = linkTarget(doc, c);
            html += href
              ? `<a href="${escText(href)}">${inlineHtml(doc, tree, textFrom, textTo, opts)}</a>`
              : inlineTextToHtml(text, opts);
          }
          pos = c.to;
          break;
        }
        default:
          render(c); // 未対応ノードは子をそのまま辿る
      }
      c = c.nextSibling;
    }
  }
  render(container);
  if (pos < to) html += inlineTextToHtml(doc.sliceString(pos, to), opts);
  return html;
}

function renderList(doc, tree, node, ordered, opts) {
  const tag = ordered ? "ol" : "ul";
  let html = `<${tag}>`;
  for (let item = node.firstChild; item; item = item.nextSibling) {
    if (item.name !== "ListItem") continue;
    const task = item.getChild("Task");
    let inner = "";
    let checkboxPrefix = "";
    let nestedList = "";
    for (let c = item.firstChild; c; c = c.nextSibling) {
      if (c.name === "Paragraph") {
        inner += inlineHtml(doc, tree, c.from, c.to, opts);
      } else if (c.name === "Task") {
        // タスク項目はTaskMarker([ ]/[x])に続くテキストがParagraphに包まれず直下にある
        const marker = c.getChild("TaskMarker");
        const checked = marker ? /x/i.test(doc.sliceString(marker.from, marker.to)) : false;
        checkboxPrefix = `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
        let textFrom = marker ? marker.to : c.from;
        while (textFrom < c.to && /\s/.test(doc.sliceString(textFrom, textFrom + 1))) textFrom++;
        inner += inlineHtml(doc, tree, textFrom, c.to, opts);
      } else if (c.name === "BulletList") {
        nestedList += renderList(doc, tree, c, false, opts);
      } else if (c.name === "OrderedList") {
        nestedList += renderList(doc, tree, c, true, opts);
      }
    }
    html += `<li>${checkboxPrefix}${inner}${nestedList}</li>`;
  }
  html += `</${tag}>`;
  return html;
}

function renderTable(doc, tree, node, opts) {
  const header = node.getChild("TableHeader");
  let html = "<table>";
  if (header) {
    html += "<thead><tr>";
    for (const cell of header.getChildren("TableCell")) {
      html += `<th>${inlineHtml(doc, tree, cell.from, cell.to, opts)}</th>`;
    }
    html += "</tr></thead>";
  }
  html += "<tbody>";
  for (const row of node.getChildren("TableRow")) {
    html += "<tr>";
    for (const cell of row.getChildren("TableCell")) {
      html += `<td>${inlineHtml(doc, tree, cell.from, cell.to, opts)}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

function renderBlockquote(doc, tree, node, opts) {
  let html = "<blockquote>";
  for (let c = node.firstChild; c; c = c.nextSibling) {
    html += renderBlock(doc, tree, c, opts);
  }
  html += "</blockquote>";
  return html;
}

function renderFencedCode(doc, node) {
  const info = node.getChild("CodeInfo");
  const text = node.getChild("CodeText");
  const lang = info ? doc.sliceString(info.from, info.to) : "";
  const code = text ? doc.sliceString(text.from, text.to) : "";
  const cls = lang ? ` class="language-${escText(lang)}"` : "";
  return `<pre><code${cls}>${escText(code)}</code></pre>`;
}

function renderBlock(doc, tree, node, opts) {
  switch (node.name) {
    case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
    case "ATXHeading4": case "ATXHeading5": case "ATXHeading6": {
      const level = Number(node.name.slice(-1));
      const mark = node.getChild("HeaderMark");
      let from = mark ? mark.to : node.from;
      while (from < node.to && /\s/.test(doc.sliceString(from, from + 1))) from++;
      return `<h${level}>${inlineHtml(doc, tree, from, node.to, opts)}</h${level}>`;
    }
    case "SetextHeading1": return `<h1>${inlineHtml(doc, tree, node.from, node.to, opts)}</h1>`;
    case "SetextHeading2": return `<h2>${inlineHtml(doc, tree, node.from, node.to, opts)}</h2>`;
    case "Paragraph": return `<p>${inlineHtml(doc, tree, node.from, node.to, opts)}</p>`;
    case "BulletList": return renderList(doc, tree, node, false, opts);
    case "OrderedList": return renderList(doc, tree, node, true, opts);
    case "Blockquote": return renderBlockquote(doc, tree, node, opts);
    case "FencedCode": return renderFencedCode(doc, node);
    case "Table": return renderTable(doc, tree, node, opts);
    case "HorizontalRule": return "<hr>";
    case "LinkReference": return ""; // 参照リンク定義自体は出力しない(脚注定義は別途処理)
    default: return "";
  }
}

// 脚注定義( [^id]: 内容 )を文末の<ol>として出力する(仕様書 M-09)。
function renderFootnotes(doc, tree) {
  const items = [];
  tree.iterate({
    enter: (node) => {
      if (node.name !== "LinkReference") return;
      const labelNode = node.node.getChild("LinkLabel");
      if (!labelNode) return false;
      const label = doc.sliceString(labelNode.from, labelNode.to).slice(1, -1);
      if (!label.startsWith("^")) return false;
      const urlNode = node.node.getChild("URL");
      const content = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
      items.push({ id: label.slice(1), content });
      return false;
    },
  });
  if (!items.length) return "";
  const lis = items.map((it) => `<li id="fn-${it.id}">${escText(it.content)} <a href="#fnref-${it.id}">↩</a></li>`).join("");
  return `<hr><ol class="footnotes">${lis}</ol>`;
}

// 文書全体(範囲指定時はその範囲のみ)をHTMLへ変換する。
// opts.preserveWhitespace(仕様書 whitespaceOnExport)がtrueなら、段落内の単独改行を
// <br>として書き出す(既定のfalseは、HTMLの空白畳み込みに任せる="ignore"相当)。
export function renderMarkdownToHtml(state, { from = 0, to = state.doc.length } = {}, opts) {
  const doc = state.doc;
  const tree = syntaxTree(state);
  let html = "";
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.to <= from || node.from >= to) continue;
    html += renderBlock(doc, tree, node, opts);
  }
  if (from === 0 && to === doc.length) html += renderFootnotes(doc, tree);
  return html;
}

// テーマCSSを埋め込んだ単一HTMLファイル(仕様書 X-02)。styledがfalseなら
// スタイルなし版(X-03)になる。
export function renderStandaloneHtml(state, title, css, styled, opts) {
  const body = renderMarkdownToHtml(state, undefined, opts);
  const styleTag = styled && css ? `<style>${css}</style>` : "";
  return `<!DOCTYPE html>\n<html lang="ja"><head><meta charset="UTF-8"><title>${escText(title)}</title>${styleTag}</head><body>${styled ? '<div class="pane-export">' : ""}${body}${styled ? "</div>" : ""}</body></html>\n`;
}
