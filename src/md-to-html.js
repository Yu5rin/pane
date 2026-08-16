// MarkdownをHTMLへ変換する。仕様書 E-05(HTMLとしてコピー)・X-02/X-03(HTMLエクスポート)で
// 共用する。ライブプレビューと同じ構文木(@lezer/markdown)を辿るため、見た目の解釈は一致する。
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EMOJI_SHORTCODES, extractHeadings } from "./markdown-extras.js";
import { renderMathToHtml } from "./math.js";
// 生HTML(html-sanitize.js)と同じ基準でURLの安全性を検証する。Markdown記法の
// リンク・画像だけ検証対象外というのは一貫性を欠くため、判定ロジックを共用する。
import { isSafeUrl } from "./html-sanitize.js";

// renderMarkdownToHtmlが構文木を最後まで伸ばすのに使う上限時間(ミリ秒、ensureSyntaxTree参照)。
// エクスポートも取扱説明書の表示もユーザーの明示操作に対する一度きりの処理で、
// 入力のたびに走る類のものではないため、長めに取って確実に最後まで出すことを優先する
// (10万行クラスの文書でも構文木のパース自体は1秒前後で終わる。ここに達するのは
// 異常なほど巨大な文書だけで、その場合も途中までのHTMLは出力される)。
const ENSURE_PARSE_TIMEOUT_MS = 10000;

function escText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) {
  return escText(s).replace(/"/g, "&quot;");
}

// インライン数式($...$)検出の正規表現。editor.js(ライブプレビュー)のカーソル行走査と
// 同じ規則(前後に空白を含まない。$による通貨表記等との誤爆を避けるTypora同様のルール)。
const INLINE_MATH_RE = /\$([^\s$](?:[^$\n]*[^\s$])?)\$/g;

// ==mark== と脚注参照[^id]は構文木のノードを持たない(仕様書のマークダウン拡張は
// ライブプレビュー側で正規表現処理している)ため、プレーンテキスト部分にのみ適用する。
// opts.preserveWhitespace(仕様書 whitespaceOnExport="preserve")のときは、段落内の
// 単独改行(ソフトブレーク)を<br>に変換して見た目上も改行を保つ。既定(false="ignore")では
// 何もしない(HTMLの通常の空白畳み込みにより1つの空白として表示される、CommonMarkの既定挙動)。
//
// opts.collectMathがtrueのとき(仕様書 exportMathAs="svg")、インライン数式($...$)を検出して
// プレースホルダ(<span class="pane-math-ph" data-i="N">)に差し替え、実際のtexはopts.mathPlaceholders
// へ積む(レンダリングはMathJaxの非同期APIのため、この関数自体は同期のまま保つ。実際の置換は
// renderStandaloneHtml側でsubstituteMathPlaceholders()を呼んで行う)。
function inlineTextToHtml(s, opts) {
  let raw = s;
  if (opts?.collectMath) {
    raw = raw.replace(INLINE_MATH_RE, (_m, tex) => {
      const idx = opts.mathPlaceholders.length;
      opts.mathPlaceholders.push({ tex, display: false });
      return ` MATH${idx} `;
    });
  }
  let h = escText(raw);
  h = h.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  h = h.replace(/\[\^([^\]]+)\]/g, (_m, id) => `<sup id="fnref-${id}"><a href="#fn-${id}">${id}</a></sup>`);
  if (opts?.preserveWhitespace) h = h.replace(/\n/g, "<br>\n");
  // プレースホルダの復元は最後に行う(マーカーは記号を含まない単純な文字列のため、
  // escText等の前段の変換を通しても壊れない。順序はどこでもよいが分かりやすさのためここに置く)。
  if (opts?.collectMath) {
    h = h.replace(/ MATH(\d+) /g, (_m, idx) => `<span class="pane-math-ph" data-i="${idx}"></span>`);
  }
  return h;
}

function linkTarget(doc, node) {
  // Link/Image共通: 直接記法( [text](url) )の場合はURLノードから、
  // 未対応の参照記法はhrefなし(テキストのみ)として扱う。
  const urlNode = node.getChild("URL");
  return urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
}

// 画像パスの解決(仕様書 2.9.2 typora-root-url相当、exportReadYamlFrontMatter経由でここへ渡る)。
// editor.js内の同名関数と同じ規則: スキーム付き(https:, data: 等)や"//"始まりはそのまま、
// "/"始まりのパスはrootUrlが指定されていればその基準に付け替える。それ以外は変更しない
// (このファイルはHTMLエクスポート/クリップボードコピー用で、実行中のPaneアプリ内でしか
// 使えないpane-file.localホストへは書き換えない。ローカル画像のエクスポート対応は
// resolveLocalImageFsPath/substituteImagePlaceholders側でdata:として埋め込む)。
// Windows絶対パス(例: "C:\..." "C:/...")・UNC("\\server\share\...")かどうか。
function isAbsoluteLocalPath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

function resolveImageSrc(rawSrc, rootUrl) {
  if (!rawSrc) return rawSrc;
  // Windows絶対パスは、一般的なURIスキーム判定の正規表現(/^[a-zA-Z][\w+.-]*:/)にも
  // 「1文字のスキーム(c:)」として誤って一致してしまうため、スキーム判定より先に見る
  // (editor.js resolveImageSrcと同じ理由)。この関数自体はどちらでも同じrawSrcを返すため
  // 挙動は変わらないが、resolveLocalImageFsPathとの一貫性のためここでも明示的に扱う。
  if (isAbsoluteLocalPath(rawSrc)) return rawSrc;
  if (/^[a-zA-Z][\w+.-]*:/.test(rawSrc) || rawSrc.startsWith("//")) return rawSrc;
  if (rawSrc.startsWith("/") && rootUrl) {
    return rootUrl.replace(/\/+$/, "") + "/" + rawSrc.replace(/^\/+/, "");
  }
  return rawSrc;
}

// 失敗しても例外を投げず元の文字列を返すdecodeURIComponent(editor.jsの同名関数と同じ理由。
// 画像挿入時にURLエスケープされたパスを実ファイル名へ戻すため)。
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ローカル画像ファイルの実パスを求める(HTMLエクスポートでdata:として埋め込むための下調べ)。
// editor.js resolveImageSrcと同じ規則(typora-root-url・URLエスケープ・Windows絶対パス/UNC・
// 文書フォルダ基準の相対パス)で解決するが、戻り値はURLではなくファイルシステムパスそのもの
// (存在確認・実際の読み込みはC#側、Pane/MainForm.cs ResolveAllowedLocalFilePathが行う)。
// スキーム付き・"//"始まり(外部/データURL、埋め込み不要)や、基準フォルダ(docDir)が無い
// 相対パス(無題文書のエクスポート等)はnullを返す。
function resolveLocalImageFsPath(rawSrc, rootUrl, docDir) {
  if (!rawSrc) return null;
  // Windows絶対パスをスキーム判定より先に見る理由はresolveImageSrc参照。ここを先にしないと
  // "C:\..."が「スキーム付きURL」と誤判定され、埋め込み対象から漏れてしまう。
  if (isAbsoluteLocalPath(rawSrc)) return rawSrc;
  if (/^[a-zA-Z][\w+.-]*:/.test(rawSrc) || rawSrc.startsWith("//")) return null;
  let effective = rawSrc;
  if (rawSrc.startsWith("/")) {
    effective = rootUrl
      ? rootUrl.replace(/\/+$/, "") + "/" + rawSrc.replace(/^\/+/, "")
      : rawSrc.replace(/^\/+/, "");
  }
  effective = safeDecodeURIComponent(effective);
  if (isAbsoluteLocalPath(effective)) return effective; // typora-root-urlが絶対パスだった場合
  if (!docDir) return null;
  return docDir.replace(/[\\/]+$/, "") + "/" + effective;
}

// ローカル画像のdata:埋め込み(HTMLエクスポート、opts.resolveLocalImageが渡された場合のみ)。
// imagePlaceholders各要素のfsPathをresolveLocalImage(main.js側、C#へブリッジ経由で読み取りを
// 依頼する関数。Pane/MainForm.cs HandleReadLocalImageRequest参照)で解決し、プレースホルダを
// 実際の<img>タグへ差し替える。読み込めなかった(範囲外・存在しない・サイズ超過等)画像は
// data URIの代わりに元のMarkdown記法どおりの相対/絶対パスへフォールバックする
// (エクスポート先が元の文書と同じフォルダなら、それでも表示できる場合があるため。
// 仕様: エクスポートしたHTMLはpane-file.localホストが存在しない環境で単体のファイルとして
// 開かれるので、pane-file.local経由のURLは使わない)。
export async function substituteImagePlaceholders(html, imagePlaceholders, resolveLocalImage) {
  if (!imagePlaceholders.length) return html;
  const results = await Promise.all(
    imagePlaceholders.map((p) => Promise.resolve(resolveLocalImage(p.fsPath)).catch(() => null))
  );
  let out = html;
  imagePlaceholders.forEach((p, idx) => {
    const placeholder = `<span class="pane-img-ph" data-i="${idx}"></span>`;
    const src = results[idx] || p.fallbackSrc;
    const replacement = src && isSafeUrl(src, { allowDataImage: true })
      ? `<img src="${escText(src)}" alt="${escText(p.alt)}">`
      : "";
    out = out.split(placeholder).join(replacement);
  });
  return out;
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
          const rawTarget = linkTarget(doc, c);
          // ローカル画像はdata:として埋め込む(opts.resolveLocalImageが渡されている=
          // HTMLエクスポート時のみ試みる。E-05のHTMLとしてコピー等では従来どおり未解決のまま)。
          const fsPath = opts?.resolveLocalImage
            ? resolveLocalImageFsPath(rawTarget, opts?.rootUrl, opts?.docDir)
            : null;
          if (fsPath) {
            const idx = opts.imagePlaceholders.length;
            opts.imagePlaceholders.push({ fsPath, alt: altText, fallbackSrc: rawTarget });
            html += `<span class="pane-img-ph" data-i="${idx}"></span>`;
            pos = c.to;
            break;
          }
          const src = resolveImageSrc(rawTarget, opts?.rootUrl);
          if (src && isSafeUrl(src, { allowDataImage: true })) {
            html += `<img src="${escText(src)}" alt="${escText(altText)}">`;
          } else {
            // javascript:等の安全でないURLは<img>にせず、Markdown記法をそのままテキストとして
            // 残す(html-sanitize.jsのisSafeUrl()と同じ基準。黙って画像を消すのではなく、
            // 変換されなかったことが原文の見た目からそのまま分かるようにする)。
            html += inlineTextToHtml(doc.sliceString(c.from, c.to), opts);
          }
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
            // 安全でないURL(javascript:/vbscript:/data:等。isSafeUrl()参照)はリンク化せず、
            // href無しのときと同じくMarkdown記法をそのままテキストとして残す(黙ってリンクを
            // 消すのではなく、変換されなかったことが原文の見た目からそのまま分かるようにする)。
            html += (href && isSafeUrl(href))
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

// 見出し(仕様書 exportPageBreakBetweenTopHeadings・exportIncludeOutline)共通の属性文字列。
// opts.headingIds: Map<開始位置, スラグ> (extractHeadings()の結果から作る。renderStandaloneHtml参照)。
// opts.pageBreakFroms: Set<開始位置> ページ区切りを入れるべき見出しの開始位置。
function headingAttrs(node, opts) {
  let attrs = "";
  const slug = opts?.headingIds?.get(node.from);
  if (slug) attrs += ` id="${escAttr(slug)}"`;
  if (opts?.pageBreakFroms?.has(node.from)) attrs += ` style="break-before:page"`;
  return attrs;
}

function renderBlock(doc, tree, node, opts) {
  switch (node.name) {
    case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
    case "ATXHeading4": case "ATXHeading5": case "ATXHeading6": {
      const level = Number(node.name.slice(-1));
      const mark = node.getChild("HeaderMark");
      let from = mark ? mark.to : node.from;
      while (from < node.to && /\s/.test(doc.sliceString(from, from + 1))) from++;
      const attrs = headingAttrs(node, opts);
      return `<h${level}${attrs}>${inlineHtml(doc, tree, from, node.to, opts)}</h${level}>`;
    }
    case "SetextHeading1": return `<h1${headingAttrs(node, opts)}>${inlineHtml(doc, tree, node.from, node.to, opts)}</h1>`;
    case "SetextHeading2": return `<h2${headingAttrs(node, opts)}>${inlineHtml(doc, tree, node.from, node.to, opts)}</h2>`;
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

// 数式ブロック($$ ... $$、独立行の"$$"で開閉。仕様書M-23/editor.jsのfindMathBlocksと同じ規則)を
// 文書全体から検出する。exportMathAs="svg"のときにブロック単位で丸ごとプレースホルダへ差し替えるため、
// 構文木の解釈(段落等)より先に判定する。
function findMathBlockRanges(doc) {
  const blocks = [];
  for (let n = 1; n <= doc.lines; n++) {
    if (doc.line(n).text.trim() !== "$$") continue;
    let endLn = null;
    for (let m = n + 1; m <= doc.lines; m++) {
      if (doc.line(m).text.trim() === "$$") { endLn = m; break; }
    }
    if (!endLn) continue;
    const openLine = doc.line(n), closeLine = doc.line(endLn);
    const textFrom = openLine.to + 1;
    const textTo = Math.max(textFrom, closeLine.from - 1);
    blocks.push({ from: openLine.from, to: closeLine.to, text: doc.sliceString(textFrom, textTo) });
    n = endLn;
  }
  return blocks;
}

// 文書全体(範囲指定時はその範囲のみ)をHTMLへ変換する。
// opts.preserveWhitespace(仕様書 whitespaceOnExport)がtrueなら、段落内の単独改行を
// <br>として書き出す(既定のfalseは、HTMLの空白畳み込みに任せる="ignore"相当)。
// opts.collectMath(仕様書 exportMathAs="svg")がtrueのとき、数式ブロック・インライン数式を
// プレースホルダへ差し替え、texをopts.mathPlaceholdersへ積む(renderStandaloneHtml参照)。
export function renderMarkdownToHtml(state, { from = 0, to = state.doc.length } = {}, opts) {
  const doc = state.doc;
  // 不具合修正: syntaxTree(state)はCodeMirrorの遅延パースの結果をそのまま返すため、
  // 文書全体の構文木になっているとは限らない(既にパースが済んだ範囲までしか木が伸びていない)。
  // ここは「文書のこの範囲をまるごとHTMLにする」処理なので、途中で木が切れると、そこから
  // 後ろの見出し・段落・表がまるごと出力から欠落する。
  //   ・取扱説明書ウィンドウ(src/help-entry.js)ではEditorViewを作らずEditorState.create()した
  //     直後に呼ぶため、ほとんど何もパースされておらず、実測で本文が4章の途中で切れていた。
  //   ・HTML/PDFエクスポート(src/editor.js)でも、長い文書を一度も下までスクロールせずに
  //     実行すると同じ理由で途中までしか書き出されない。
  // ensureSyntaxTreeでto位置まで確実にパースしてから使う。上限時間内に終わらなかった場合だけ
  // nullが返るので、その時は従来どおり(途中まででも出力する)にフォールバックする。
  const tree = ensureSyntaxTree(state, to, ENSURE_PARSE_TIMEOUT_MS) ?? syntaxTree(state);
  const mathBlocks = opts?.collectMath ? findMathBlockRanges(doc) : [];
  let html = "";
  let node = tree.topNode.firstChild;
  while (node) {
    if (node.to <= from || node.from >= to) { node = node.nextSibling; continue; }
    const mb = mathBlocks.find((b) => node.from >= b.from && node.from < b.to);
    if (mb) {
      // 数式ブロックの範囲は構文木上どう解釈されていても(通常は1つのParagraphになる)まとめて
      // 1つのプレースホルダに差し替える。範囲に重なる後続ノードは読み飛ばす。
      const idx = opts.mathPlaceholders.length;
      opts.mathPlaceholders.push({ tex: mb.text, display: true });
      html += `<div class="pane-math-ph" data-i="${idx}"></div>`;
      while (node && node.from < mb.to) node = node.nextSibling;
      continue;
    }
    html += renderBlock(doc, tree, node, opts);
    node = node.nextSibling;
  }
  if (from === 0 && to === doc.length) html += renderFootnotes(doc, tree);
  return html;
}

// mathPlaceholders([{tex, display}, ...])をMathJaxで実際にレンダリングし、htmlの中の
// プレースホルダを差し替える(仕様書 exportMathAs="svg")。レンダリングに失敗した数式は
// 元のLaTeXソースをそのまま表示するフォールバックにする。
export async function substituteMathPlaceholders(html, mathPlaceholders) {
  if (!mathPlaceholders.length) return html;
  const rendered = await Promise.all(mathPlaceholders.map(({ tex, display }) =>
    renderMathToHtml(tex, { display, autoNumber: "off" }).catch((e) => ({ html: null, error: true, message: String(e) }))));
  let out = html;
  mathPlaceholders.forEach(({ tex, display }, idx) => {
    const placeholder = display
      ? `<div class="pane-math-ph" data-i="${idx}"></div>`
      : `<span class="pane-math-ph" data-i="${idx}"></span>`;
    const r = rendered[idx];
    const replacement = r && !r.error && r.html
      ? (display ? `<div class="pane-math-svg">${r.html}</div>` : r.html)
      : `<span class="pane-math-error" title="数式のレンダリングに失敗しました">${escText(display ? `$$${tex}$$` : `$${tex}$`)}</span>`;
    out = out.split(placeholder).join(replacement);
  });
  return out;
}

// アウトライン(仕様書 exportIncludeOutline/exportOutlineWidthPx)。見出し一覧から
// 単純なリンク一覧を作る(サイドバーのアウトラインパネルと役割は同じだが、エクスポート結果は
// 単体HTMLとして独立して開かれるため、こちらは専用の簡易版を持つ)。
function renderOutlineHtml(headings, widthPx) {
  const items = headings
    .map((h) => `<a class="pane-outline-item pane-outline-l${h.level}" href="#${escAttr(h.slug)}">${escText(h.text)}</a>`)
    .join("");
  return `<nav class="pane-export-outline" style="width:${Math.max(0, widthPx | 0)}px">${items}</nav>`;
}

// アウトライン・数式プレースホルダ用の最小限のCSS。テーマCSS(EXPORT_CSS、editor.js)とは
// 独立して常に効かせる必要があるため、こちらは<style>を分けて埋め込む。
function structureCss(widthPx) {
  return `.pane-export-layout{display:flex;align-items:flex-start;gap:24px}` +
    `.pane-export-outline{flex:0 0 ${Math.max(0, widthPx | 0)}px;position:sticky;top:0;` +
    `max-height:100vh;overflow:auto;box-sizing:border-box;padding-right:12px;font-size:.9em}` +
    `.pane-outline-item{display:block;text-decoration:none;padding:2px 0;color:inherit}` +
    `.pane-outline-l2{padding-left:.9em}.pane-outline-l3{padding-left:1.8em}` +
    `.pane-outline-l4{padding-left:2.7em}.pane-outline-l5{padding-left:3.6em}.pane-outline-l6{padding-left:4.5em}` +
    `.pane-export-content{flex:1 1 auto;min-width:0}` +
    `.pane-math-error{color:#c00;font-family:var(--font-mono,monospace)}` +
    `@media print{.pane-export-outline{display:none}}`;
}

// テーマCSSを埋め込んだ単一HTMLファイル(仕様書 X-02)。styledがfalseなら
// スタイルなし版(X-03)になる。config(すべて省略可):
//   title, css, styled, preserveWhitespace(whitespaceOnExport)
//   mathAs(exportMathAs: "svg"|"latex")
//   pageBreakBetweenTopHeadings(exportPageBreakBetweenTopHeadings)
//   includeOutline / outlineWidthPx(exportIncludeOutline / exportOutlineWidthPx)
//   appendHead / appendBody(exportAppendHead / exportAppendBody。サニタイズしない)
//   rootUrl(exportReadYamlFrontMatterで読んだtypora-root-url)
// 数式のSVGレンダリング(MathJax)が非同期なため、この関数はPromiseを返す。
export async function renderStandaloneHtml(state, config = {}) {
  const {
    title = "",
    css = "",
    styled = true,
    preserveWhitespace = false,
    mathAs = "latex",
    pageBreakBetweenTopHeadings = false,
    includeOutline = false,
    outlineWidthPx = 260,
    appendHead = "",
    appendBody = "",
    rootUrl = null,
    docDir = null,
    resolveLocalImage = null,
  } = config;

  // エクスポートは一度きりの処理なので、文書の末尾まで確実に解析してから見出しを集める
  // (遅延解析のままだと長い文書で後半の見出しにidが振られない。extractHeadings参照)。
  const headings = extractHeadings(state, 6, { ensureFullParse: true });
  const headingIds = new Map(headings.map((h) => [h.from, h.slug]));
  const pageBreakFroms = new Set();
  if (pageBreakBetweenTopHeadings) {
    let sawTop = false;
    for (const h of headings) {
      if (h.level !== 1) continue;
      if (sawTop) pageBreakFroms.add(h.from); // 最初の最上位見出しの前には入れない(先頭が空白ページになるのを防ぐ)
      sawTop = true;
    }
  }

  const mathPlaceholders = [];
  const imagePlaceholders = [];
  const collectMath = mathAs === "svg";
  let body = renderMarkdownToHtml(state, undefined, {
    preserveWhitespace, headingIds, pageBreakFroms, rootUrl, collectMath, mathPlaceholders,
    docDir, resolveLocalImage, imagePlaceholders,
  });
  if (collectMath && mathPlaceholders.length) {
    body = await substituteMathPlaceholders(body, mathPlaceholders);
  }
  if (resolveLocalImage && imagePlaceholders.length) {
    body = await substituteImagePlaceholders(body, imagePlaceholders, resolveLocalImage);
  }

  const contentHtml = styled ? `<div class="pane-export">${body}</div>` : body;
  const bodyWrapped = includeOutline
    ? `<div class="pane-export-layout">${renderOutlineHtml(headings, outlineWidthPx)}<div class="pane-export-content">${contentHtml}</div></div>`
    : contentHtml;

  const styleTag = styled && css ? `<style>${css}</style>` : "";
  const structureStyleTag = includeOutline || collectMath ? `<style>${structureCss(outlineWidthPx)}</style>` : "";
  // exportAppendHead/exportAppendBody(仕様書): ユーザーが設定画面に自分で書いたHTML文字列を
  // そのまま追記する。信頼できる入力(本人がPane上で設定したもの)であるため意図的にサニタイズしない。
  const headExtra = appendHead ? `\n<!-- exportAppendHead: ユーザー入力をサニタイズせずそのまま挿入 -->\n${appendHead}` : "";
  const bodyExtra = appendBody ? `\n<!-- exportAppendBody: ユーザー入力をサニタイズせずそのまま挿入 -->\n${appendBody}` : "";

  return `<!DOCTYPE html>\n<html lang="ja"><head><meta charset="UTF-8"><title>${escText(title)}</title>${styleTag}${structureStyleTag}${headExtra}\n</head><body>${bodyWrapped}${bodyExtra}</body></html>\n`;
}

// YAML Front Matter(仕様書 exportReadYamlFrontMatter)から読み取るキー。一次資料
// (docs/設定項目一覧.md)には具体的なキー名の指定が無い(「typora-root-url、ページ設定」は例示)ため、
// このファイルを正としてここで定める(報告にも明記する)。
//   typora-root-url                                … "/"始まり画像パスの基準URL(仕様書2.9.2相当)
//   title                                            … {title}プレースホルダ・<title>タグに使う文書タイトル
//   header / footer                                  … exportHeaderText / exportFooterText の上書き
//   page-size                                        … exportPaperSize の上書き
//   page-width-mm / page-height-mm                   … page-size: custom のときの寸法
//   page-orientation                                 … exportOrientation の上書き
//   page-margin-top/bottom/left/right(いずれも末尾mm) … exportMargin*Mm の上書き
const FRONT_MATTER_KEYS = {
  "typora-root-url": "rootUrl",
  title: "title",
  header: "header",
  footer: "footer",
  "page-size": "pageSize",
  "page-width-mm": "pageWidthMm",
  "page-height-mm": "pageHeightMm",
  "page-orientation": "pageOrientation",
  "page-margin-top": "marginTopMm",
  "page-margin-bottom": "marginBottomMm",
  "page-margin-left": "marginLeftMm",
  "page-margin-right": "marginRightMm",
};
const FRONT_MATTER_NUMERIC = new Set([
  "pageWidthMm", "pageHeightMm", "marginTopMm", "marginBottomMm", "marginLeftMm", "marginRightMm",
]);

export function parseFrontMatterOverrides(fullText) {
  if (!fullText.startsWith("---")) return {};
  const lines = fullText.split(/\r\n|\n/);
  if (lines[0].trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return {};
  const body = lines.slice(1, end).join("\n");
  const result = {};
  for (const [key, prop] of Object.entries(FRONT_MATTER_KEYS)) {
    const re = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, "mi");
    const m = body.match(re);
    if (!m) continue;
    const raw = m[1].trim().replace(/^["']|["']$/g, "");
    if (FRONT_MATTER_NUMERIC.has(prop)) {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) result[prop] = n;
    } else if (raw) {
      result[prop] = raw;
    }
  }
  return result;
}
