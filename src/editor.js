// Pane ライブプレビューエディタ (CodeMirror 6)
// index.html から createEditor() で生成し、返り値のAPIで操作する。
// 依存はすべてesbuildでビルド成果物(dist/)に同梱する。実行時に外部CDNへは一切到達しない。
import { EditorView, keymap, Decoration, ViewPlugin, WidgetType, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment, StateEffect, StateField } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough, Table, Superscript, Subscript, Emoji, Autolink } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewline, undo, redo, moveLineUp, moveLineDown, copyLineDown, deleteLine, indentLess, indentSelection } from "@codemirror/commands";
import { syntaxTree, syntaxHighlighting, HighlightStyle, LanguageDescription, bracketMatching, indentUnit } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, startCompletion } from "@codemirror/autocomplete";
import { search, setSearchQuery, getSearchQuery, SearchQuery, findNext, findPrevious, replaceNext, replaceAll } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { codeLanguages, resolveFileMode } from "./languages.js";
import { extractHeadings, findHeadingBySlug, findEmojiCompletions, EMOJI_SHORTCODES, CALLOUT_TYPES } from "./markdown-extras.js";
import { renderMathToHtml } from "./math.js";
import { renderMermaid } from "./mermaid-render.js";
import { renderMarkdownToHtml, renderStandaloneHtml } from "./md-to-html.js";
import { charClass, computeTextStats } from "./text-stats.js";
import { sanitizeHtml } from "./html-sanitize.js";

// コードのハイライト配色(仕様書 第5章・第10.2節)。色は単独で決め打ちせず、
// style.cssで定義した--code-*トークン(--ink/--ink-mute/--accentから派生)を参照する。
const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "var(--code-kw)", fontWeight: "600" },
  { tag: [t.atom, t.bool, t.self], color: "var(--code-kw)" },
  { tag: [t.string, t.special(t.string)], color: "var(--code-str)" },
  { tag: t.comment, color: "var(--code-cmt)", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float], color: "var(--code-num)" },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: "var(--code-fn)" },
  { tag: [t.typeName, t.className], color: "var(--code-type)" },
  { tag: [t.operator, t.punctuation, t.meta], color: "var(--code-op)" },
]);

// HTMLエクスポート(スタイルあり、仕様書 File項目「エクスポート: HTML」)用の最小限の閲覧用CSS。
// アプリ実行時にしか存在しないCSSカスタムプロパティ(--ink等)には依存しない、自己完結した値にする。
const EXPORT_CSS = `body{font-family:"Yu Gothic UI","Segoe UI",sans-serif;line-height:1.85;color:#1F2428;max-width:840px;margin:2.5rem auto;padding:0 1.5rem;}
.pane-export h1,.pane-export h2,.pane-export h3,.pane-export h4,.pane-export h5,.pane-export h6{font-weight:700;margin:1.6em 0 .6em;}
.pane-export code{background:#F0F2F1;padding:.15em .35em;border-radius:4px;font-family:ui-monospace,Consolas,monospace;}
.pane-export pre{background:#F0F2F1;padding:.8em 1em;border-radius:8px;overflow-x:auto;}
.pane-export pre code{background:none;padding:0;}
.pane-export blockquote{border-left:3px solid #7BAFA6;margin:0;padding:.2em 1em;color:#5A6B68;}
.pane-export table{border-collapse:collapse;}
.pane-export th,.pane-export td{border:1px solid #D8DEDC;padding:.4em .7em;}
.pane-export img{max-width:100%;}
.pane-export mark{background:#FCE9A8;}`;

// 現在のテーマがダークかどうか。main.js側で <html data-theme="dark"> を切り替えているので
// (main.jsは編集対象外のため、その挙動に合わせてここから直接DOMを読む)、Mermaidの配色を
// テーマに連動させる際の判定に使う。
function isDarkTheme() {
  return document.documentElement.dataset.theme === "dark";
}

// カーソル/選択がこの範囲に触れているか。フォーカスがなければ常に装飾。
// liveRenderingShowSourceOnFocusがfalseの間は、カーソルが乗っていても常に装飾したまま
// (生の記法を見せない)にする。
function cursorInside(view, from, to) {
  if (!view.hasFocus) return false;
  if (!revealOnFocus(view.state)) return false;
  for (const r of view.state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

// マークダウン記法拡張のON/OFF(仕様書 第2.10節 C-01)。既定はすべてON
// (導入前の挙動を変えないため)。C#設定画面からの変更は setExtensionToggles() 経由で届く。
// インライン数式・自動採番はTypora準拠で既定OFF。
const setExtToggles = StateEffect.define();
// 自動リンク(M-17)は既定ON(Typoraも既定で有効なため、他のTypora非準拠拡張とは扱いを分ける)。
// mathAutoNumberは"off"|"ams"|"all"の3値(仕様書 mathAutoNumber)。
// diagrams/codeBlockMath/codeAutoWrap/liveRenderingShowSourceOnFocus/whitespaceWhenWriting/
// smartQuotes/smartDashes/recognizeUnicodePunctuationは、いずれもドキュメントを再構築せずに
// 反映できるようこの同じStateField経由で扱う(既存のautoLinksと同じ流儀)。
const DEFAULT_EXT_TOGGLES = {
  callouts: true, superSub: true, highlight: true, inlineMath: false, mathAutoNumber: "off", autoLinks: true,
  diagrams: true, codeBlockMath: false, codeAutoWrap: true, liveRenderingShowSourceOnFocus: true,
  whitespaceWhenWriting: "preserve", smartQuotes: "off", smartDashes: "off", recognizeUnicodePunctuation: false,
};
const extTogglesField = StateField.define({
  create: () => DEFAULT_EXT_TOGGLES,
  update: (v, tr) => { for (const ef of tr.effects) if (ef.is(setExtToggles)) v = { ...v, ...ef.value }; return v; },
});
// カーソル/選択が触れている記法だけ生表示する既存の挙動全体のON/OFF(仕様書 liveRenderingShowSourceOnFocus)。
// falseなら、カーソルが乗っていても記法マーカーを隠したままにする。
function revealOnFocus(state) {
  return (state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES).liveRenderingShowSourceOnFocus !== false;
}

// ---- YAML Front Matter(仕様書 M-11) ----
// 先頭が正確に "---" の行から始まる場合のみ検出する。閉じの "---" が
// 見つかるまで走査するが、上限行数を設けて巨大文書での際限のない走査を防ぐ。
const FRONTMATTER_SCAN_CAP = 1000;
function computeFrontmatter(state) {
  const doc = state.doc;
  if (doc.lines < 1 || doc.line(1).text !== "---") return null;
  const cap = Math.min(doc.lines, FRONTMATTER_SCAN_CAP);
  for (let n = 2; n <= cap; n++) {
    if (doc.line(n).text === "---") return { from: 0, to: doc.line(n).to };
  }
  return null;
}
const frontmatterField = StateField.define({
  create: computeFrontmatter,
  update: (v, tr) => {
    if (!tr.docChanged) return v;
    // 先頭付近(front matter判定に影響しうる範囲)以外の変更では再計算しない
    const boundary = Math.max(4, v ? v.to : 0);
    return tr.changes.touchesRange(0, boundary) ? computeFrontmatter(tr.state) : v;
  },
});
// YAML Front Matterの typora-root-url 相当のキーを読み取る(仕様書 2.9.2)。
// フルのYAMLパーサは持ち込まず、他のfront matter処理(computeFrontmatter等)と同様に
// 素朴な正規表現で該当行の値だけを拾う。
function frontmatterRootUrl(state, fm) {
  if (!fm) return null;
  const text = state.doc.sliceString(0, fm.to);
  const m = text.match(/^[ \t]*typora-root-url[ \t]*:[ \t]*(.+?)[ \t]*$/mi);
  if (!m) return null;
  const v = m[1].trim().replace(/^["']|["']$/g, "");
  return v || null;
}
// 画像パスの解決(仕様書 2.9.2)。typora-root-urlが指定されていれば"/"始まりのパスの
// 基準をそこにする。スキーム付き(https:, data: 等)や"//"始まりは外部/プロトコル相対と
// みなしそのまま使う。それ以外(通常の相対パス)はブラウザの既定解決に委ねる(従来どおり)。
function resolveImageSrc(rawSrc, rootUrl) {
  if (!rawSrc) return rawSrc;
  if (/^[a-zA-Z][\w+.-]*:/.test(rawSrc) || rawSrc.startsWith("//")) return rawSrc;
  if (rawSrc.startsWith("/") && rootUrl) {
    return rootUrl.replace(/\/+$/, "") + "/" + rawSrc.replace(/^\/+/, "");
  }
  return rawSrc;
}
// 自動リンク(仕様書 M-17)のリンク先を決める。スキームが既に付いていればそのまま、
// "www."始まりはhttps://を補い、"@"を含む(スキーム無し)ものはメールアドレスとみなし
// mailto:を補う(<foo@bar.com> や 裸のfoo@bar.comの場合。mailto:/xmpp:付きは1つ目の分岐で素通り)。
function autolinkHref(text) {
  if (/^[a-zA-Z][\w+.-]*:/.test(text)) return text;
  if (text.startsWith("www.")) return "https://" + text;
  if (text.includes("@")) return "mailto:" + text;
  return text;
}

// ---- 参照リンク(M-16)・脚注定義(M-09)の収集 ----
// LinkReference ノード([id]: url 形式)を1回の木走査でまとめて集める。
// ラベルが "^" で始まるものは脚注定義として区別する。
function collectReferences(state) {
  const links = new Map();
  const footnotes = new Map();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "LinkReference") return;
      const labelNode = node.node.getChild("LinkLabel");
      if (!labelNode) return false;
      const label = state.doc.sliceString(labelNode.from, labelNode.to).slice(1, -1);
      const urlNode = node.node.getChild("URL");
      const url = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : "";
      if (label.startsWith("^")) footnotes.set(label.slice(1), { content: url, from: node.from, to: node.to });
      else links.set(label.trim().toLowerCase(), url);
      return false;
    },
  });
  return { links, footnotes };
}

// ---- Callouts / GitHub式アラート(M-13) ----
// Blockquoteの最初の行が "> [!TYPE]" のみの場合にその種別を返す。
function detectCalloutType(state, blockquoteNode) {
  const firstLine = state.doc.lineAt(blockquoteNode.from);
  const m = firstLine.text.match(/^ {0,3}>\s?\[!(\w+)\]\s*$/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  return CALLOUT_TYPES[type] ? type : null;
}

// 内部アンカー([text](#heading))はCtrl/Cmd+クリックでジャンプし(仕様書 M-15)、
// それ以外の外部リンクは従来どおりクリックで新規タブに開く。
function openOrJumpLink(view, href, modifierKey) {
  if (!href) return;
  if (href.startsWith("#")) {
    if (!modifierKey) return;
    const heading = findHeadingBySlug(view.state, decodeURIComponent(href.slice(1)));
    if (heading) {
      view.dispatch({
        selection: { anchor: heading.from },
        effects: EditorView.scrollIntoView(heading.from, { y: "center" }),
      });
      view.focus();
    }
    return;
  }
  let url = href;
  if (!/^[a-zA-Z][\w+.-]*:/.test(url)) url = "https://" + url;
  confirmOpenExternal(url, () => window.open(url, "_blank", "noopener"));
}

// 外部サイトを開く前の確認(Graftと同じ考え方)。誤クリックで意図しないサイトが
// 既定のブラウザで開くのを防ぐ。window.confirm はWebView2側の設定でブロックされる
// ことがあるため使わず、自前のダイアログを出す。文書内リンク(#見出し)は確認しない。
let externalLinkDialog = null;
function confirmOpenExternal(url, onConfirm) {
  externalLinkDialog?.remove();

  const overlay = document.createElement("div");
  overlay.className = "extlink-overlay";
  const box = document.createElement("div");
  box.className = "extlink-box";

  const title = document.createElement("div");
  title.className = "extlink-title";
  title.textContent = "外部サイトを開きますか?";

  // URLは必ずtextContentで入れる(HTMLとして解釈させない)。長いURLは折り返して全文見せる。
  const urlEl = document.createElement("div");
  urlEl.className = "extlink-url";
  urlEl.textContent = url;

  const actions = document.createElement("div");
  actions.className = "extlink-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "extlink-btn";
  cancel.textContent = "キャンセル";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "extlink-btn extlink-btn-primary";
  open.textContent = "開く";

  function close() {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    externalLinkDialog = null;
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(); onConfirm(); }
  }

  cancel.addEventListener("click", close);
  open.addEventListener("click", () => { close(); onConfirm(); });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);

  actions.append(cancel, open);
  box.append(title, urlEl, actions);
  overlay.append(box);
  document.body.appendChild(overlay);
  externalLinkDialog = overlay;
  open.focus(); // 既定は「開く」。Enterでそのまま開ける
}

class BulletWidget extends WidgetType {
  toDOM() { const s = document.createElement("span"); s.textContent = "• "; s.className = "cm-bullet"; return s; }
}
class HrWidget extends WidgetType {
  toDOM() { const hr = document.createElement("hr"); hr.className = "cm-hr"; return hr; }
}
class CodeCopyWidget extends WidgetType {
  constructor(code) { super(); this.code = code; }
  eq(o) { return o.code === this.code; }
  toDOM() {
    const btn = document.createElement("button");
    btn.className = "cm-code-copy";
    btn.type = "button";
    btn.setAttribute("aria-label", "コードをコピー");
    btn.innerHTML = '<svg class="ic-copy" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="2.5"/><path d="M9 20h8.5a2.5 2.5 0 0 0 2.5-2.5V9"/></svg><svg class="ic-done" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      try { await navigator.clipboard.writeText(this.code); }
      catch { try { const t = document.createElement("textarea"); t.value = this.code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); } catch { /* コピーはベストエフォート、表示は常に行う */ } }
      btn.classList.add("done");
      setTimeout(() => btn.classList.remove("done"), 1200);
    });
    return btn;
  }
  ignoreEvent() { return false; }
}
class CalloutMarkerWidget extends WidgetType {
  constructor(type) { super(); this.type = type; }
  eq(o) { return o.type === this.type; }
  toDOM() {
    const info = CALLOUT_TYPES[this.type];
    const span = document.createElement("span");
    span.className = `cm-callout-marker cm-callout-marker-${this.type}`;
    const icon = info.shape === "alert"
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 21.5 20h-19z"/><path d="M12 9.5v5"/><circle cx="12" cy="17.2" r=".6" fill="currentColor" stroke="none"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor" stroke="none"/></svg>';
    span.innerHTML = `${icon}<b>${info.label}</b>`;
    return span;
  }
  ignoreEvent() { return false; }
}
class FootnoteRefWidget extends WidgetType {
  constructor(id, content) { super(); this.id = id; this.content = content; }
  eq(o) { return o.id === this.id && o.content === this.content; }
  toDOM() {
    const sup = document.createElement("sup");
    sup.className = "cm-footnote-ref";
    const num = document.createElement("span");
    num.className = "cm-footnote-num";
    num.textContent = this.id;
    sup.appendChild(num);
    if (this.content) {
      const pop = document.createElement("span");
      pop.className = "cm-footnote-popup";
      pop.textContent = this.content;
      sup.appendChild(pop);
    }
    return sup;
  }
  ignoreEvent() { return false; }
}
class FootnoteDefLabelWidget extends WidgetType {
  constructor(id) { super(); this.id = id; }
  eq(o) { return o.id === this.id; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-footnote-def-label";
    span.textContent = this.id;
    return span;
  }
  ignoreEvent() { return false; }
}
class EmojiWidget extends WidgetType {
  constructor(glyph, code) { super(); this.glyph = glyph; this.code = code; }
  eq(o) { return o.glyph === this.glyph && o.code === this.code; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-emoji";
    span.textContent = this.glyph;
    span.title = `:${this.code}:`;
    return span;
  }
  ignoreEvent() { return false; }
}
// スマート引用符・スマートダッシュの表示専用置換(仕様書 smartQuotes="render"・smartDashes)用の
// 汎用ウィジェット。1文字(または短い置換文字列)をそのまま表示するだけで、クリック等の
// 特別な挙動は持たない。
class GlyphWidget extends WidgetType {
  constructor(glyph) { super(); this.glyph = glyph; }
  eq(o) { return o.glyph === this.glyph; }
  toDOM() { const span = document.createElement("span"); span.className = "cm-glyph"; span.textContent = this.glyph; return span; }
  ignoreEvent() { return false; }
}
// "を開き引用符/閉じ引用符どちらにするかの判定は共通(表示専用のGlyphWidgetと、
// ドキュメントを直接書き換えるsmartTypingInputHandlerの両方から使う)。
function smartQuoteChar(open, straightChar) {
  if (straightChar === '"') return open ? "“" : "”"; // “ / ”
  return open ? "‘" : "’"; // ‘ / ’
}
// 画像のライブプレビュー(仕様書 M-18・第2.9.2節)。数式・Mermaid・表と異なり画像は
// インライン要素(段落の途中に来うる)なので、ブロックウィジェット(StateField側でblock:true
// にして提供する方式)ではなく、既存のLink装飾と同じくlivePreviewのDecoration.replace
// (ブロック指定なしの通常の置換)で表示する。単独行の画像(段落の中身が画像だけ)も
// 同じ扱いで問題ない(画像を含むcm-line自体が既にブロック単位で改行されるため、
// 見た目上は他の行と同じく独立した1行として表示される)。
class ImageWidget extends WidgetType {
  constructor(alt, src, resolvedSrc, from) { super(); this.alt = alt; this.src = src; this.resolvedSrc = resolvedSrc; this.from = from; }
  eq(o) { return o.alt === this.alt && o.src === this.src && o.resolvedSrc === this.resolvedSrc; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "cm-image-widget";
    wrap.dataset.resolvedSrc = this.resolvedSrc; // 読み込み失敗でimg要素が消えても解決後のパスを参照できるようにしておく
    const img = document.createElement("img");
    img.alt = this.alt;
    img.src = this.resolvedSrc;
    // 読み込みに失敗した画像(このアプリは外部通信を行わないため、リモートURLの画像は
    // 必ず失敗する)は、壊れたアイコンのまま残さず代替テキストに差し替える。
    img.addEventListener("error", () => {
      img.remove();
      wrap.classList.add("cm-image-error");
      wrap.textContent = `画像を読み込めません: ${this.src}`;
    }, { once: true });
    wrap.appendChild(img);
    // クリックすると記法を展開して編集できる(仕様書 2.9.2)。posAtDOMで現在のドキュメント上の
    // 位置を求める(TableWidgetのpos()と同じ考え方。docの変更でウィジェットが使い回されても
    // 正しい位置を取れる)。取得できない場合のみ構築時のfromへフォールバックする。
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      let pos = this.from;
      try { pos = view.posAtDOM(wrap); } catch { /* フォールバックのfromを使う */ }
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "nearest" }) });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}
class MathWidget extends WidgetType {
  constructor(tex, display, autoNumber) { super(); this.tex = tex; this.display = display; this.autoNumber = autoNumber; }
  eq(o) { return o.tex === this.tex && o.display === this.display && o.autoNumber === this.autoNumber; }
  toDOM() {
    const wrap = document.createElement(this.display ? "div" : "span");
    wrap.className = this.display ? "cm-math-block" : "cm-math-inline";
    wrap.textContent = "…";
    renderMathToHtml(this.tex, { display: this.display, autoNumber: this.autoNumber }).then(({ html, error, message }) => {
      if (error) {
        wrap.textContent = `数式エラー: ${message}`;
        wrap.classList.add("cm-math-error");
        return;
      }
      wrap.innerHTML = html;
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}
// Mermaid図(仕様書 第4.2節・第8.3節)。MathWidgetと同じ作法: まず「…」を表示し、
// toDOM()が呼ばれた時点(=実際に画面へ出るとき)で初めてrenderMermaid()を呼んで非同期に
// 差し替える。可視範囲外のブロックを先読みして描画することはしない。
class MermaidWidget extends WidgetType {
  constructor(code, dark) { super(); this.code = code; this.dark = dark; }
  eq(o) { return o.code === this.code && o.dark === this.dark; }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-mermaid-block";
    wrap.textContent = "…";
    renderMermaid(this.code, { dark: this.dark }).then(({ svg, error, message }) => {
      if (error) {
        wrap.textContent = `Mermaidエラー: ${message}`;
        wrap.classList.add("cm-mermaid-error");
        return;
      }
      wrap.innerHTML = svg;
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}
class TocWidget extends WidgetType {
  constructor(headings) { super(); this.headings = headings; this.key = JSON.stringify(headings.map((h) => [h.level, h.text, h.slug])); }
  eq(o) { return o.key === this.key; }
  ignoreEvent() { return true; }
  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = "cm-toc";
    if (!this.headings.length) {
      const empty = document.createElement("div");
      empty.className = "cm-toc-empty";
      empty.textContent = "見出しがありません";
      wrap.appendChild(empty);
      return wrap;
    }
    const list = document.createElement("div");
    list.className = "cm-toc-list";
    for (const h of this.headings) {
      const a = document.createElement("a");
      a.href = "#" + h.slug;
      a.className = `cm-toc-item cm-toc-h${h.level}`;
      a.textContent = h.text;
      a.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: h.from }, effects: EditorView.scrollIntoView(h.from, { y: "center" }) });
        view.focus();
      });
      list.appendChild(a);
    }
    wrap.appendChild(list);
    return wrap;
  }
}
class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement("input");
    box.type = "checkbox"; box.checked = this.checked; box.className = "cm-checkbox";
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("change", () => {
      const line = view.state.doc.lineAt(this.pos);
      const m = line.text.match(/^(\s*[-*+]\s+\[)([ xX])(\])/);
      if (!m) return;
      const at = line.from + m[1].length;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() { return false; }
}
// インラインHTML(仕様書 第2.9節 M-27〜M-31)。開始タグ〜終了タグの範囲、または
// <img>のような単体タグの範囲を、サニタイズ済みDOMに置き換えて表示するウィジェット。
// video/iframe/aなど内部にクリック・再生操作を持つ要素を含みうるため、CodeMirrorに
// クリック等を横取りさせずウィジェット自身のDOMに委ねる(TableWidget等と同じ扱い)。
class HtmlInlineWidget extends WidgetType {
  constructor(html) { super(); this.html = html; }
  eq(o) { return o.html === this.html; }
  ignoreEvent() { return true; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-html-inline";
    // sanitizeHtml()は安全なDOMノード(DocumentFragment)を返す。innerHTMLへ生文字列を
    // 渡すことは一切しない(サニタイズ結果であっても、という意味ではなくそもそも文字列化
    // した時点でエスケープの取り違え等の事故を招きうるため、DOM要素のまま扱う)。
    span.appendChild(sanitizeHtml(this.html));
    return span;
  }
}
// ブロックHTML(<iframe>や<div>...</div>が段落として単独で置かれている場合。M-29〜M-31)。
class HtmlBlockWidget extends WidgetType {
  constructor(html) { super(); this.html = html; }
  eq(o) { return o.html === this.html; }
  ignoreEvent() { return true; }
  toDOM() {
    const div = document.createElement("div");
    div.className = "cm-html-block";
    div.appendChild(sanitizeHtml(this.html));
    return div;
  }
}
// 閉じタグを取らない要素(単体で完結するのでペア探索の対象にしない)
const VOID_HTML_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// HTMLTagノードの生テキストからタグ名・開始/終了・自己終端かどうかを判定する
function parseHtmlTagText(text) {
  const closeMatch = text.match(/^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>$/);
  if (closeMatch) return { isClose: true, name: closeMatch[1].toLowerCase() };
  const openMatch = text.match(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)/);
  if (!openMatch) return null; // 不正な形式(コメント等)は対象外。生テキストのまま表示される
  return { isClose: false, name: openMatch[1].toLowerCase(), selfClose: /\/\s*>$/.test(text) };
}
// インラインHTML(M-27〜M-31)の開始タグ〜終了タグをペアリングする。
// @lezer/markdownの構文木はHTMLTagノードを開始・終了の対にせず並列に並べるだけなので、
// タグ名を見ながら自前でスタック照合する。同じ親ノード(同じParagraph/見出し/強調等)の
// 中だけで対応付けることで、ブロックをまたいだ誤対応(離れた場所の同名タグ同士が
// 誤って1つの範囲にまとまってしまう事故)を避ける。
function pairInlineHtmlTags(state, tagNodes) {
  const byParent = new Map();
  for (const tn of tagNodes) {
    const list = byParent.get(tn.parentFrom);
    if (list) list.push(tn); else byParent.set(tn.parentFrom, [tn]);
  }
  const pairs = [];
  const singles = [];
  for (const list of byParent.values()) {
    const stack = [];
    for (const tn of list) {
      const text = state.doc.sliceString(tn.from, tn.to);
      const parsed = parseHtmlTagText(text);
      if (!parsed) continue;
      if (parsed.isClose) {
        // 直近から同名の開始タグを探す。対応しない閉じタグは無視(生テキストのまま)。
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === parsed.name) {
            pairs.push({ from: stack[i].from, to: tn.to });
            stack.length = i; // 対応が壊れていた内側の未閉じタグはあきらめて捨てる
            break;
          }
        }
      } else if (parsed.selfClose || VOID_HTML_TAGS.has(parsed.name)) {
        singles.push({ from: tn.from, to: tn.to });
      } else {
        stack.push({ from: tn.from, to: tn.to, name: parsed.name });
      }
    }
    // 閉じタグの無い開始タグ(stackに残った分)は対応する終了位置が無いため描画しない
  }
  return { pairs, singles };
}

const livePreview = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view);
    requestAnimationFrame(() => { if (!view.destroyed) view.dispatch({ effects: [] }); });
  }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || u.transactions.length)
      this.decorations = this.build(u.view);
  }
  build(view) {
    const { state } = view;
    const marks = [];
    const quotedLines = new Set();
    const seenFences = new Set();
    const seenTables = new Set();
    const htmlTagNodes = []; // インラインHTML(M-27〜M-31)。ペアリングは木走査後にまとめて行う
    const toggles = state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
    const fm = state.field(frontmatterField, false);
    const mathBlocks = state.field(mathBlocksField, false) ?? [];
    const inMathBlock = (pos) => mathBlocks.some((b) => pos >= b.from && pos < b.to);
    // ブロックHTML(htmlBlocksField、下記参照)の範囲内は行ベースの記法解釈(見出し・箇条書き等)を
    // 行わない。数式ブロックと同じ理由(生のHTMLをMarkdown記法として誤爆させないため)。
    const htmlBlocks = state.field(htmlBlocksField, false) ?? [];
    const inHtmlBlock = (pos) => htmlBlocks.some((b) => pos >= b.from && pos < b.to);
    const { links: linkRefs, footnotes: footnoteDefs } = collectReferences(state);
    // 画像パスの基準(仕様書 2.9.2 typora-root-url相当)。front matterが無ければnull
    // (=従来どおりの相対パス解決)。
    const imgRootUrl = fm ? frontmatterRootUrl(state, fm) : null;
    const tree = syntaxTree(state);
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({ from, to, enter: (node) => {
        const name = node.name, nf = node.from, nt = node.to;
        if (fm && nt <= fm.to) return false; // YAML Front Matter内は生テキスト扱い(M-11)
        const live = cursorInside(view, nf, nt);
        if (name === "FencedCode") {
          // コードフェンス検出: 構文木のFencedCodeノードを可視範囲だけ辿る(全行走査はしない)
          if (seenFences.has(nf)) return false; // visibleRangesの重複区間での二重処理を防ぐ
          seenFences.add(nf);
          if (node.node.getChildren("CodeMark").length < 2) return false; // 未終端(閉じフェンス無し)は装飾しない
          const open = state.doc.lineAt(nf);
          const close = state.doc.lineAt(Math.max(nf, nt - 1));
          const blockLive = cursorInside(view, open.from, close.to);
          marks.push({ from: open.from, to: close.to, deco: Decoration.mark({ class: "tok-codeblock" }) });
          // 行全体を塗るブロック背景(行デコレーション)。開始行にコピー用マーカーを付与。
          for (let ln = open.number; ln <= close.number; ln++) {
            const l = state.doc.line(ln);
            const cls = "cm-codeblock-line" + (ln === open.number ? " cm-cb-first" : "") + (ln === close.number ? " cm-cb-last" : "")
              + (!blockLive && (ln === open.number || ln === close.number) ? " cm-cb-fence-hidden" : "") // 記号を隠している時だけフェンス行を圧縮
              + (toggles.codeAutoWrap === false ? " cm-cb-nowrap" : ""); // 仕様書 codeAutoWrap: falseなら長い行を折り返さない
            marks.push({ from: l.from, to: l.from, deco: Decoration.line({ class: cls }), line: true });
          }
          // コピーボタンを開始フェンス行の行末にwidgetで配置(行デコレーションとは位置/sideが異なるため競合しない)
          if (open.number + 1 <= close.number - 1 || close.number > open.number) {
            const codeText = state.sliceDoc(
              state.doc.line(Math.min(open.number + 1, close.number)).from,
              close.from > 0 ? close.from - 1 : close.from
            );
            marks.push({ from: open.to, to: open.to, deco: Decoration.widget({ widget: new CodeCopyWidget(codeText), side: 1 }) });
          }
          if (!blockLive) {
            // フェンス行の```記号のみ隠す(改行は含めない。ViewPluginでは改行をreplaceできない)
            if (open.from < open.to) marks.push({ from: open.from, to: open.to, deco: Decoration.replace({}) });
            if (close.from < close.to) marks.push({ from: close.from, to: close.to, deco: Decoration.replace({}) });
          }
          return false; // CodeMark/CodeInfo/CodeTextの子ノードへは降りない
        }
        if (name === "Table") {
          // 表の行装飾: 構文木のTable/TableHeader/TableDelimiter/TableRowを可視範囲だけ辿る(全行走査はしない)
          if (seenTables.has(nf)) return false;
          seenTables.add(nf);
          const t = node.node;
          const header = t.getChild("TableHeader");
          if (header) {
            const hl = state.doc.lineAt(header.from);
            marks.push({ from: hl.from, to: hl.from, deco: Decoration.line({ class: "cm-table-row cm-table-header" }), line: true });
          }
          const delim = t.getChild("TableDelimiter");
          if (delim) {
            const dl = state.doc.lineAt(delim.from);
            const sepLive = cursorInside(view, dl.from, dl.to + 1);
            if (!sepLive) marks.push({ from: dl.from, to: dl.to, deco: Decoration.replace({}) });
            else marks.push({ from: dl.from, to: dl.to, deco: Decoration.mark({ class: "tok-table-sep" }) });
          }
          for (const row of t.getChildren("TableRow")) {
            const rl = state.doc.lineAt(row.from);
            marks.push({ from: rl.from, to: rl.from, deco: Decoration.line({ class: "cm-table-row" }), line: true });
          }
          return false; // TableCell等の子ノードへは降りない
        }
        if (name === "StrongEmphasis" || name === "Emphasis") {
          const cls = name === "StrongEmphasis" ? "tok-bold" : "tok-italic";
          const mlen = name === "StrongEmphasis" ? 2 : 1;
          marks.push({ from: nf, to: nt, deco: Decoration.mark({ class: cls }) });
          if (!live) { marks.push({ from: nf, to: nf + mlen, deco: Decoration.replace({}) }); marks.push({ from: nt - mlen, to: nt, deco: Decoration.replace({}) }); }
          return;
        }
        if (name === "Strikethrough") {
          marks.push({ from: nf, to: nt, deco: Decoration.mark({ class: "tok-strike" }) });
          if (!live) { marks.push({ from: nf, to: nf + 2, deco: Decoration.replace({}) }); marks.push({ from: nt - 2, to: nt, deco: Decoration.replace({}) }); }
          return;
        }
        if (name === "InlineCode") {
          marks.push({ from: nf, to: nt, deco: Decoration.mark({ class: "tok-code" }) });
          if (!live) { marks.push({ from: nf, to: nf + 1, deco: Decoration.replace({}) }); marks.push({ from: nt - 1, to: nt, deco: Decoration.replace({}) }); }
          return;
        }
        if (name === "Image") {
          // 画像のライブプレビュー(仕様書 M-18・第2.9.2節)。既存のLink直接記法と同じ流儀で
          // ノード全体の生テキストを正規表現で読む(alt/pathそれぞれの子ノードが無く、
          // "]"と"("の間の生テキストとしてしか取れないため。Linkの直接記法と同じ理由)。
          if (live) return; // カーソルが記法内にあるときは生記法のまま(既存の他の記法と同じ)
          const text = state.doc.sliceString(nf, nt);
          const m = text.match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
          if (!m) return false; // 参照形式などの非対応の形は生テキストのまま(子ノードも見ない)
          const alt = m[1];
          const rawSrc = m[2].trim();
          if (!rawSrc) return false;
          const resolvedSrc = resolveImageSrc(rawSrc, imgRootUrl);
          marks.push({ from: nf, to: nt, deco: Decoration.replace({ widget: new ImageWidget(alt, rawSrc, resolvedSrc, nf) }) });
          return false; // 子ノード(LinkMark/URL)は個別処理不要
        }
        if (name === "Link") {
          const text = state.doc.sliceString(nf, nt);
          // 脚注の本文中参照 [^id] (仕様書 M-09)。ホバーで内容をポップアップ表示する。
          const fnm = text.match(/^\[\^([^\]]+)\]$/);
          if (fnm) {
            if (!live) {
              const def = footnoteDefs.get(fnm[1]);
              marks.push({ from: nf, to: nt, deco: Decoration.replace({ widget: new FootnoteRefWidget(fnm[1], def?.content ?? "") }) });
            }
            return false;
          }
          if (live) return;
          // 直接リンク [text](url)
          const direct = text.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
          if (direct) {
            marks.push({ from: nf, to: nf + 1, deco: Decoration.replace({}) });
            const cb = nf + 1 + direct[1].length;
            marks.push({ from: cb, to: nt, deco: Decoration.replace({}) });
            marks.push({ from: nf + 1, to: cb, deco: Decoration.mark({ class: "tok-link", attributes: { "data-href": direct[2] } }) });
            return;
          }
          // 参照リンク [text][id] およびショートカット参照 [id](仕様書 M-16)
          const refExplicit = text.match(/^\[([^\]]*)\]\[([^\]]*)\]$/);
          if (refExplicit || /^\[[^\]]*\]$/.test(text)) {
            const linkText = refExplicit ? refExplicit[1] : text.slice(1, -1);
            const label = refExplicit ? (refExplicit[2] || refExplicit[1]) : linkText;
            const url = linkRefs.get(label.trim().toLowerCase());
            if (url !== undefined) {
              const textFrom = nf + 1;
              const textTo = textFrom + linkText.length;
              marks.push({ from: nf, to: textFrom, deco: Decoration.replace({}) });
              if (textTo < nt) marks.push({ from: textTo, to: nt, deco: Decoration.replace({}) });
              marks.push({ from: textFrom, to: textTo, deco: Decoration.mark({ class: "tok-link", attributes: { "data-href": url } }) });
            }
          }
          return;
        }
        if (name === "Autolink") {
          // <url> 形式の自動リンク(仕様書 M-17)。コアのCommonMarkパーサが標準で
          // このノードを生成する(<https://...> や <foo@bar.com>)ため拡張の追加は不要。
          // 構文木のノードとして判定しているため、コードブロック・インラインコード・数式
          // ブロックの中では(それらの中は元々インライン解析されない・別扱いのため)ここに来ない。
          if (!toggles.autoLinks || inMathBlock(nf) || live) return false;
          const urlNode = node.node.getChild("URL");
          if (!urlNode) return false;
          const href = autolinkHref(state.doc.sliceString(urlNode.from, urlNode.to));
          marks.push({ from: urlNode.from, to: urlNode.to, deco: Decoration.mark({ class: "tok-link", attributes: { "data-href": href } }) });
          marks.push({ from: nf, to: nf + 1, deco: Decoration.replace({}) }); // 開き "<"
          marks.push({ from: nt - 1, to: nt, deco: Decoration.replace({}) }); // 閉じ ">"
          return false; // URL子ノードは既に処理済み
        }
        if (name === "URL") {
          // 裸のURL・メールアドレス(仕様書 M-17、GFM拡張のAutolinkが生成する"URL"ノード)。
          // Image/Autolinkは子孫へ降りないためここに来ないが、Linkは直接記法のテキスト中に
          // 入れ子の装飾(太字等)を許すためreturn falseしていない。そのLinkの内部URL(既に
          // Decoration.replaceで非表示にしている範囲)を誤って二重装飾しないよう親で弾く。
          const parentName = node.node.parent?.name;
          if (parentName === "Link" || parentName === "Image" || parentName === "Autolink") return;
          if (!toggles.autoLinks || inMathBlock(nf) || live) return;
          const href = autolinkHref(state.doc.sliceString(nf, nt));
          marks.push({ from: nf, to: nt, deco: Decoration.mark({ class: "tok-link", attributes: { "data-href": href } }) });
          return;
        }
        if (name === "LinkReference") {
          // 脚注定義ブロック [^id]: 内容 (仕様書 M-09)。通常の段落と区別できる見た目にする。
          const labelNode = node.node.getChild("LinkLabel");
          if (!labelNode) return;
          const label = state.doc.sliceString(labelNode.from, labelNode.to).slice(1, -1);
          if (!label.startsWith("^")) return; // 通常の参照リンク定義(M-16)は特別な装飾をしない
          const id = label.slice(1);
          const startLn = state.doc.lineAt(nf).number;
          const endLn = state.doc.lineAt(Math.max(nf, nt - 1)).number;
          for (let ln = startLn; ln <= endLn; ln++) {
            const l = state.doc.line(ln);
            marks.push({ from: l.from, to: l.from, deco: Decoration.line({ class: "cm-footnote-def" + (ln === startLn ? " cm-footnote-def-first" : "") }), line: true });
          }
          if (!live) {
            const markEnd = Math.min(nt, labelNode.to + 1); // "[^id]:" までを隠す
            marks.push({ from: nf, to: markEnd, deco: Decoration.replace({ widget: new FootnoteDefLabelWidget(id) }) });
          }
          return;
        }
        if (name === "Superscript" || name === "Subscript") {
          if (!toggles.superSub) return;
          const cls = name === "Superscript" ? "tok-sup" : "tok-sub";
          marks.push({ from: nf, to: nt, deco: Decoration.mark({ class: cls }) });
          if (!live) { marks.push({ from: nf, to: nf + 1, deco: Decoration.replace({}) }); marks.push({ from: nt - 1, to: nt, deco: Decoration.replace({}) }); }
          return;
        }
        if (name === "Emoji") {
          if (live) return;
          const code = state.doc.sliceString(nf + 1, nt - 1);
          const glyph = EMOJI_SHORTCODES[code];
          if (glyph) marks.push({ from: nf, to: nt, deco: Decoration.replace({ widget: new EmojiWidget(glyph, code) }) });
          return; // 未対応のショートコードはプレーン表示のまま
        }
        if (name === "Blockquote") {
          // 複数行の引用は行ごとに装飾。「>」の無い行(仕様上の遅延継続)は引用装飾しない。
          // 先頭行が "> [!TYPE]" ならCallouts(仕様書 M-13)として種別ごとの見た目にする。
          const calloutType = toggles.callouts ? detectCalloutType(state, node.node) : null;
          const lastLn = state.doc.lineAt(Math.min(nt, state.doc.length)).number;
          const markerLn = state.doc.lineAt(nf).number;
          for (let ln = markerLn; ln <= lastLn; ln++) {
            if (quotedLines.has(ln)) continue; // 入れ子ノードでの二重装飾を防ぐ(最も外側のBlockquoteノードで1回だけ処理する)
            const line = state.doc.line(ln);
            // 多段引用(仕様書 M-03)。1行に連続する "> " をネストの深さぶんすべて数える
            // (例: "> > 入れ子" ならdepth=2)。木のQuoteMarkノードを個別に辿らなくても、
            // 行頭のマーカーは常にこの形で連続するため素朴な繰り返しマッチで十分。
            let depth = 0, consumed = 0, rest = line.text;
            for (;;) {
              const lm = rest.match(/^ {0,3}>\s?/);
              if (!lm) break;
              depth++; consumed += lm[0].length; rest = rest.slice(lm[0].length);
            }
            if (depth === 0) continue;
            quotedLines.add(ln);
            const lineLive = view.hasFocus && revealOnFocus(state) && state.selection.ranges.some(r => {
              const cl = state.doc.lineAt(r.head);
              return cl.number === line.number || (r.from !== r.to && r.from <= line.to && r.to >= line.from);
            });
            const isMarker = calloutType && ln === markerLn;
            if (isMarker && !lineLive) {
              marks.push({ from: line.from, to: line.to, deco: Decoration.replace({ widget: new CalloutMarkerWidget(calloutType) }) });
            } else if (!lineLive) {
              // depthぶんのマーカーをまとめて隠す(内側の">"も含めて画面に見えないようにする)
              marks.push({ from: line.from, to: line.from + consumed, deco: Decoration.replace({}) });
            }
            const cls = calloutType ? `tok-quote cm-callout cm-callout-${calloutType}` : "tok-quote";
            if (depth >= 2) {
              // 2段目以降は深さに応じて左の罫線を重ねて表示する(仕様書 M-03)。
              // .tok-quote のborder-leftは1本分の見た目のため、多段では
              // 複数のinset box-shadowを重ねて段数ぶんの罫線に見せる(色は交互に変化させる)。
              const step = 6;
              const shadows = [];
              for (let d = 1; d <= depth; d++) shadows.push(`inset ${3 + (d - 1) * step}px 0 0 0 ${d % 2 ? "var(--accent)" : "var(--accent-soft)"}`);
              const style = `border-left:none;box-shadow:${shadows.join(",")};padding-left:${10 + (depth - 1) * step}px;`;
              marks.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: `${cls} cm-quote-nested`, attributes: { style } }) });
            } else {
              marks.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: cls }) });
            }
          }
          return;
        }
        if (name === "HTMLTag") {
          // インラインHTML(M-27〜M-31)。木走査中はまだ開始/終了タグの対応が分からないため
          // ここでは収集するだけにし、ペアリングは可視範囲の走査がすべて終わってからまとめて行う。
          if (inHtmlBlock(nf)) return; // ブロックHTML(htmlBlockDecoFieldが描画を担当)の中は対象外
          htmlTagNodes.push({ from: nf, to: nt, parentFrom: node.node.parent ? node.node.parent.from : -1 });
          return;
        }
      }});
    }
    if (htmlTagNodes.length) {
      // インラインHTML(M-27〜M-31): 開始タグ〜終了タグ、または<img>等の単体タグをまとめて
      // 安全なDOMに描画する。カーソル/選択が範囲に触れている時だけ生のタグ表示に戻す
      // (既存の太字・斜体・リンクと同じ挙動。cursorInside()は既存ヘルパー)。
      const { pairs, singles } = pairInlineHtmlTags(state, htmlTagNodes);
      for (const p of pairs) {
        if (cursorInside(view, p.from, p.to)) continue;
        marks.push({ from: p.from, to: p.to, deco: Decoration.replace({ widget: new HtmlInlineWidget(state.sliceDoc(p.from, p.to)) }) });
      }
      for (const s of singles) {
        if (cursorInside(view, s.from, s.to)) continue;
        marks.push({ from: s.from, to: s.to, deco: Decoration.replace({ widget: new HtmlInlineWidget(state.sliceDoc(s.from, s.to)) }) });
      }
    }
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = state.doc.lineAt(pos);
        if (fm && line.from < fm.to) {
          // YAML Front Matter(M-11): 本文と異なる背景色を充てるだけで、記法解釈はしない
          const cls = "cm-frontmatter" + (line.number === 1 ? " cm-fm-first" : "") + (line.to === fm.to ? " cm-fm-last" : "");
          marks.push({ from: line.from, to: line.from, deco: Decoration.line({ class: cls }), line: true });
          if (line.to + 1 > to) break;
          pos = line.to + 1;
          continue;
        }
        if (inMathBlock(line.from)) {
          // 数式ブロック内(mathBlockDecoFieldが描画を担当)は他の記法解釈をしない
          if (line.to + 1 > to) break;
          pos = line.to + 1;
          continue;
        }
        if (inHtmlBlock(line.from)) {
          // ブロックHTML内(htmlBlockDecoFieldが描画を担当)は他の記法解釈をしない(M-29〜M-31)
          if (line.to + 1 > to) break;
          pos = line.to + 1;
          continue;
        }
        const lineLive = view.hasFocus && revealOnFocus(state) && state.selection.ranges.some(r => {
          const cl = state.doc.lineAt(r.head);
          return cl.number === line.number || (r.from !== r.to && r.from <= line.to && r.to >= line.from);
        });
        const hd = line.text.match(/^( {0,3})(#{1,6})\s/);
        if (hd) { const lvl = hd[2].length; marks.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: `tok-h${lvl}` }) }); if (!lineLive) marks.push({ from: line.from, to: line.from + hd[0].length, deco: Decoration.replace({}) }); }
        if (/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line.text)) {
          if (lineLive) marks.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: "tok-hr-src" }) });
          else marks.push({ from: line.from, to: line.to, deco: Decoration.replace({ widget: new HrWidget() }) });
          if (line.to + 1 > to) break; pos = line.to + 1; continue;
        }
        const cm = line.text.match(/^(\s*[-*+]\s+)\[([ xX])\](\s?)/);
        if (cm) {
          const checked = cm[2].toLowerCase() === "x";
          const boxFrom = line.from + cm[1].length, boxTo = boxFrom + 3 + cm[3].length;
          marks.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: checked ? "tok-done" : "" }) });
          marks.push({ from: line.from, to: line.from + cm[1].length, deco: Decoration.replace({}) });
          marks.push({ from: boxFrom, to: boxTo, deco: Decoration.replace({ widget: new CheckboxWidget(checked, line.from) }) });
        } else {
          const lm = line.text.match(/^(\s*)([-*+])(\s)/);
          if (lm) { const mkFrom = line.from + lm[1].length, mkTo = mkFrom + 1 + lm[3].length; marks.push({ from: mkFrom, to: mkTo, deco: Decoration.replace({ widget: new BulletWidget() }) }); }
        }
        if (toggles.highlight) {
          let hm; const re = /==([^=\n]+)==/g;
          while ((hm = re.exec(line.text))) { const hf = line.from + hm.index, ht = hf + hm[0].length; marks.push({ from: hf, to: ht, deco: Decoration.mark({ class: "tok-mark" }) }); if (!cursorInside(view, hf, ht)) { marks.push({ from: hf, to: hf + 2, deco: Decoration.replace({}) }); marks.push({ from: ht - 2, to: ht, deco: Decoration.replace({}) }); } }
        }
        if (toggles.inlineMath) {
          // インライン数式 $...$(仕様書 M-23)。前後に空白を含まない($による通貨表記等との
          // 誤爆を避けるTypora同様のルール)。カーソルが乗っている間は生記法のまま。
          let mm; const mre = /\$([^\s$](?:[^$\n]*[^\s$])?)\$/g;
          while ((mm = mre.exec(line.text))) {
            const mf = line.from + mm.index, mt = mf + mm[0].length;
            if (!cursorInside(view, mf, mt)) {
              marks.push({ from: mf, to: mt, deco: Decoration.replace({ widget: new MathWidget(mm[1], false, "off") }) }); // インライン数式は自動採番の対象外(Typora準拠)
            }
          }
        }
        if (toggles.smartQuotes === "render") {
          // スマート引用符(仕様書 smartQuotes="render"): 表示だけ変換し、文書のテキストは変えない。
          // "input"モード(ドキュメントのテキストを直接置換する側、smartTypingInputHandler参照)とは
          // 別経路。カーソルが乗っている位置は生の記号のまま。
          let qm; const qre = /["']/g;
          while ((qm = qre.exec(line.text))) {
            const qf = line.from + qm.index, qt = qf + 1;
            if (cursorInside(view, qf, qt)) continue;
            const before = qm.index > 0 ? line.text[qm.index - 1] : "";
            const open = !before || /[\s([{＜「『（【〈《]/.test(before);
            marks.push({ from: qf, to: qt, deco: Decoration.replace({ widget: new GlyphWidget(smartQuoteChar(open, qm[0])) }) });
          }
        }
        if (toggles.smartDashes !== "off" && toggles.smartQuotes !== "input") {
          // スマートダッシュ(仕様書 smartDashes)。適用タイミングはsmartQuotesと同じ考え方にする:
          // smartQuotes="input"のときはsmartTypingInputHandlerがドキュメントのテキスト自体を
          // 直接置換するため、ここでの表示専用の二重変換はしない。それ以外(off/render)の間は
          // 表示だけ変換する(テキストは変えない)。
          let dm; const dre = /-{2,3}/g;
          while ((dm = dre.exec(line.text))) {
            const df = line.from + dm.index, dt = df + dm[0].length;
            if (cursorInside(view, df, dt)) continue;
            const ch = toggles.smartDashes === "emdash" ? "—" : (dm[0].length >= 3 ? "—" : "–");
            marks.push({ from: df, to: dt, deco: Decoration.replace({ widget: new GlyphWidget(ch) }) });
          }
        }
        // リスト系の折り返し行を1行目のテキスト開始位置に揃える(ハンギングインデント)
        const hang = line.text.match(/^(\s*)(?:[-*+]\s+\[[ xX]\]\s?|[-*+]\s|\d+\.\s)/);
        if (hang) marks.push({ from: line.from, to: line.from, deco: Decoration.line({ attributes: { class: "cm-hang", style: `--hang:${hang[0].length}ch` } }), line: true });
        if (line.to + 1 > to) break;
        pos = line.to + 1;
      }
    }
    const ranges = marks.filter(m => m.from < m.to || m.deco.spec.widget || m.line).map(m => m.deco.range(m.from, m.to));
    return Decoration.set(ranges, true);
  }
}, { decorations: v => v.decorations });

// フォーカスモード(仕様書 V-06): カーソルのある段落以外の行を減光する。
// 「段落」は構文木のParagraphノードではなく「空行で挟まれたブロック」として判定する
// (構文木ベースだと見出し・リスト等が対象外になり、かえって不自然になるため。指示どおり)。
function paragraphLineRangeAt(doc, pos) {
  const cursorLine = doc.lineAt(pos);
  let from = cursorLine.number;
  while (from > 1 && doc.line(from - 1).text.trim() !== "") from--;
  let to = cursorLine.number;
  while (to < doc.lines && doc.line(to + 1).text.trim() !== "") to++;
  return { from, to };
}
const focusMode = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view);
  }
  build(view) {
    // livePreviewと同じ性能方針: 文書全体ではなくview.visibleRangesの中だけを走査する。
    const { state } = view;
    const { from: paraFrom, to: paraTo } = paragraphLineRangeAt(state.doc, state.selection.main.head);
    const marks = [];
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = state.doc.lineAt(pos);
        if (line.number < paraFrom || line.number > paraTo) {
          marks.push(Decoration.line({ class: "cm-dimmed" }).range(line.from));
        }
        if (line.to + 1 > to) break;
        pos = line.to + 1;
      }
    }
    return Decoration.set(marks, true);
  }
}, { decorations: v => v.decorations });

// ソフトブレーク(仕様書 第2.9節 M-01): 行末に半角スペース2つ+改行を挿入する。
// ツールバー操作(applyMdAction の softBreak ケース)とShift+Enterキーの両方から呼ぶ
// 共通処理として切り出し、処理内容が2箇所に重複しないようにする。
function insertSoftBreak(view) {
  const { state } = view;
  const sel = state.selection.main;
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "  \n" }, selection: { anchor: sel.from + 3 } });
  return true;
}

// Enter処理: リスト/チェックリスト/番号を自動継続、空項目なら継続を終了。それ以外はインデントなし改行。
function handleEnter(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.from !== sel.to) return insertNewline(view);
  const line = state.doc.lineAt(sel.from);
  const before = line.text.slice(0, sel.from - line.from);
  const m = before.match(/^(\s*)(- \[[ xX]\] |[-*+] |(\d+)\. )/);
  if (!m) return insertNewline(view); // リストでなければ素の改行(インデントを引き継がない)
  const rest = before.slice(m[0].length);
  if (!rest.trim()) {
    // 空のリスト項目でEnter → マーカーを消して継続終了
    view.dispatch({ changes: { from: line.from, to: sel.from, insert: "" }, selection: { anchor: line.from } });
    return true;
  }
  // マーカーを継続(番号は+1、チェックは未チェックで)
  let marker = m[2];
  if (m[3]) marker = m[1] + (parseInt(m[3], 10) + 1) + ". ";
  else if (marker.startsWith("- [")) marker = m[1] + "- [ ] ";
  else marker = m[1] + marker;
  view.dispatch({ changes: { from: sel.from, insert: "\n" + marker }, selection: { anchor: sel.from + 1 + marker.length } });
  return true;
}

// 本体向けAPI: エディタを生成して操作関数を返す
// ---- Markdownテーブル ----
function splitCells(t) {
  let s = t.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map(c => c.trim());
}
// 構文木のTableノード(from/toを持つオブジェクト)から表データを組み立てる
function tableFromNode(state, node) {
  const startLine = state.doc.lineAt(node.from).number;
  const endLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
  const lines = []; for (let i = startLine; i <= endLine; i++) lines.push(state.doc.line(i).text);
  const aligns = splitCells(lines[1]).map(c => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null);
  return { from: state.doc.line(startLine).from, to: state.doc.line(endLine).to, startLine, endLine,
           header: splitCells(lines[0]), aligns, body: lines.slice(2).map(splitCells) };
}
// カーソル位置を含むTableノードを探す(親を辿るだけでO(木の深さ)。全行走査はしない)
function tableNodeAt(state, pos) {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node && node.name !== "Table") node = node.parent;
  return node;
}
// Table を含みうるノード(表を持てないノードへは降りずに枝刈りする)
const TABLE_CONTAINER_NAMES = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);
// ドキュメント内のTableノードをすべて取得する(表ウィジェットの描画に使う)。
// 正規表現による行走査ではなく構文木を辿るため、表を含みえないノード(段落・見出し・
// コードブロック等)へは降りずに打ち切る。表の描画はブロック装飾(block: true)であり
// CodeMirrorの制約上StateFieldからしか提供できないため、view.visibleRangesは使えない。
function findAllTables(state) {
  const tables = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "Table") { tables.push(tableFromNode(state, node)); return false; }
      if (!TABLE_CONTAINER_NAMES.has(node.name)) return false;
    },
  });
  return tables;
}
const dispW = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0xFF ? 2 : 1), 0); // 表示幅(全角=2)
function padCell(s, w, align) {
  const gap = Math.max(0, w - dispW(s));
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
  return s + " ".repeat(gap);
}
// 列幅を揃えたMarkdownを生成(自動整形)
function formatTableText(t) {
  const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map(r => r.length) : [0]), 1);
  const norm = (r) => Array.from({ length: cols }, (_, i) => r[i] ?? "");
  const header = norm(t.header), body = t.body.map(norm);
  const aligns = Array.from({ length: cols }, (_, i) => t.aligns[i] ?? null);
  const widths = Array.from({ length: cols }, (_, i) => Math.max(3, dispW(header[i]), ...body.map(r => dispW(r[i]))));
  const row = (r) => "| " + r.map((c, i) => padCell(c, widths[i], aligns[i])).join(" | ") + " |";
  const sep = "| " + widths.map((w, i) => {
    const a = aligns[i];
    if (a === "center") return ":" + "-".repeat(Math.max(1, w - 2)) + ":";
    if (a === "right") return "-".repeat(Math.max(1, w - 1)) + ":";
    if (a === "left") return ":" + "-".repeat(Math.max(1, w - 1));
    return "-".repeat(w);
  }).join(" | ") + " |";
  return [row(header), sep, ...body.map(row)].join("\n");
}
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// セル内インライン記法(太字/斜体/打消/ハイライト/コード/リンク/内部リンク)のみ対応
function renderInline(s) {
  let h = escHtml(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/\*([^*]+)\*/g, "<i>$1</i>");
  h = h.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  h = h.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="tok-link" data-href="$2">$1</span>');
  return h;
}
// 生テキスト上のセル位置(行内のc番目セルの末尾)を求める
function cellPos(state, t, rowIdx, c) {
  const line = state.doc.line(t.startLine + rowIdx);
  let i = line.text.indexOf("|") + 1, cell = 0;
  while (cell < c) { const p = line.text.indexOf("|", i); if (p < 0) break; i = p + 1; cell++; }
  let j = line.text.indexOf("|", i); if (j < 0) j = line.text.length;
  const seg = line.text.slice(i, j);
  const lead = seg.match(/^\s*/)[0].length, trail = seg.match(/\s*$/)[0].length;
  return { from: line.from + i + lead, to: line.from + j - trail };
}
function selectCell(view, t, rowIdx, c) {
  const p = cellPos(view.state, t, rowIdx, c);
  view.dispatch({ selection: { anchor: p.from, head: p.to }, effects: EditorView.scrollIntoView(p.from, { y: "nearest" }) });
  view.focus();
}
function tableAt(state, pos) {
  const node = tableNodeAt(state, pos);
  return node ? tableFromNode(state, node) : undefined;
}
function mutateTable(view, pos, fn) {
  const t = tableAt(view.state, pos);
  if (!t) return;
  fn(t);
  view.dispatch({ changes: { from: t.from, to: t.to, insert: formatTableText(t) } });
}
// ---- 列幅のドラッグ調整(仕様書 M-08) ----
// Markdownの表記法には列幅の概念が無いため、ドキュメントのテキストには一切書き込まない。
// 「表の識別子(ヘッダー内容から導く) → 列幅配列(px)」のMapをエディタインスタンス
// (EditorView)ごとに保持し、ウィジェットが作り直されて(eq()がfalseになって)も
// 同じ表なら復元できるようにする。ファイルを閉じれば(=EditorViewが破棄されれば)
// WeakMapごと自然に消えてよく、永続化はしない。
const tableColWidthsByView = new WeakMap();
// 表の識別子: 行番号ではなくヘッダー行のセル内容から導く(行番号依存だと上に行を
// 足しただけで幅が飛んでしまう)。
function tableColKey(t) { return JSON.stringify(t.header); }
function getColWidths(view, key) {
  return tableColWidthsByView.get(view)?.get(key) ?? [];
}
function setColWidths(view, key, widths) {
  let store = tableColWidthsByView.get(view);
  if (!store) { store = new Map(); tableColWidthsByView.set(view, store); }
  store.set(key, widths);
}
// 列境界のドラッグ処理本体。Pointer Eventsを使う(mousedown/mousemoveだと要素外に
// 出た際に追従しない)。setPointerCaptureで捕捉するため、pointermove/pointerupは
// マウスがリサイザ要素の外に出てもリサイザ自身に届く。
const TABLE_COL_MIN_WIDTH = 48;
function startColResize(e, view, colKey, colEls, headerCells, colIndex, tbl) {
  // preventDefault/stopPropagationを呼ばないとCodeMirrorがこのpointerdownを
  // カーソル移動として解釈し、表が編集モード(生テキスト表示)に切り替わって
  // ドラッグが中断されてしまう。
  e.preventDefault();
  e.stopPropagation();
  const resizer = e.currentTarget;
  resizer.setPointerCapture(e.pointerId);
  // 初回ドラッグ時は他の列の見た目が変わらないよう、現在の描画幅をそのまま各<col>に
  // 固定してからtable-layout:fixedへ切り替える(そうしないと未設定の列がfixedレイアウト
  // 下で均等割りされ、ドラッグしていない列の幅まで変わってしまう)。
  colEls.forEach((col, i) => { if (!col.style.width) col.style.width = headerCells[i].getBoundingClientRect().width + "px"; });
  tbl.style.tableLayout = "fixed";
  const col = colEls[colIndex];
  const startWidth = parseFloat(col.style.width);
  const startX = e.clientX;
  const onMove = (ev) => {
    const w = Math.max(TABLE_COL_MIN_WIDTH, Math.round(startWidth + (ev.clientX - startX)));
    col.style.width = w + "px";
  };
  const onUp = (ev) => {
    resizer.removeEventListener("pointermove", onMove);
    resizer.removeEventListener("pointerup", onUp);
    resizer.removeEventListener("pointercancel", onUp);
    try { resizer.releasePointerCapture(ev.pointerId); } catch { /* 既に解放済みなら無視 */ }
    setColWidths(view, colKey, colEls.map((c) => (c.style.width ? parseFloat(c.style.width) : undefined)));
  };
  resizer.addEventListener("pointermove", onMove);
  resizer.addEventListener("pointerup", onUp);
  resizer.addEventListener("pointercancel", onUp);
}
// プレビュー描画(グリッド表 + ホバーで行/列操作)
class TableWidget extends WidgetType {
  constructor(t) { super(); this.t = t; this.key = JSON.stringify([t.header, t.aligns, t.body]); this.colKey = tableColKey(t); }
  eq(o) { return o.key === this.key; }
  ignoreEvent() { return true; }
  toDOM(view) {
    const t = this.t;
    const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map(r => r.length) : [0]), 1);
    const wrap = document.createElement("div");
    wrap.className = "cm-table";
    const tbl = document.createElement("table");
    // 列幅(過去にドラッグ済みならMapから復元)。1度もドラッグしていない表は全列
    // 未設定のままにし、table-layoutもauto(既定)のままにして従来どおりの自動幅を保つ。
    const savedWidths = getColWidths(view, this.colKey);
    const colgroup = document.createElement("colgroup");
    const colEls = [];
    for (let c = 0; c < cols; c++) {
      const col = document.createElement("col");
      if (savedWidths[c] != null) col.style.width = savedWidths[c] + "px";
      colgroup.appendChild(col);
      colEls.push(col);
    }
    if (savedWidths.some((w) => w != null)) tbl.style.tableLayout = "fixed";
    tbl.appendChild(colgroup);
    const mkBtn = (label, title, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "tbl-ctl"; b.innerHTML = label; b.title = title; b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); fn(); }); return b; };
    const pos = () => { try { return view.posAtDOM(wrap); } catch { return t.from; } };
    // ヘッダー行(列操作ボタン付き)
    const thead = document.createElement("thead"); const hr = document.createElement("tr");
    const headerCells = [];
    for (let c = 0; c < cols; c++) {
      const th = document.createElement("th");
      th.style.textAlign = t.aligns[c] || "left";
      th.innerHTML = renderInline(t.header[c] ?? "");
      const ctl = document.createElement("span"); ctl.className = "tbl-ctls";
      const cc = c;
      if (cc > 0) ctl.appendChild(mkBtn("&#x25C0;", "列を左へ移動", () => mutateTable(view, pos(), (x) => { for (const arr of [x.header, x.aligns, ...x.body]) arr.splice(cc - 1, 0, ...arr.splice(cc, 1)); })));
      ctl.appendChild(mkBtn("+", "右に列を追加", () => mutateTable(view, pos(), (x) => { x.header.splice(cc + 1, 0, ""); x.aligns.splice(cc + 1, 0, null); for (const r of x.body) r.splice(cc + 1, 0, ""); })));
      if (cols > 1) ctl.appendChild(mkBtn("&#x2212;", "この列を削除", () => mutateTable(view, pos(), (x) => { x.header.splice(cc, 1); x.aligns.splice(cc, 1); for (const r of x.body) r.splice(cc, 1); })));
      if (cc < cols - 1) ctl.appendChild(mkBtn("&#x25B6;", "列を右へ移動", () => mutateTable(view, pos(), (x) => { for (const arr of [x.header, x.aligns, ...x.body]) arr.splice(cc + 1, 0, ...arr.splice(cc, 1)); })));
      th.appendChild(ctl);
      th.addEventListener("mousedown", (e) => { if (e.target.closest(".tbl-ctl,.cm-table-col-resizer")) return; e.preventDefault(); selectCell(view, tableAt(view.state, pos()) || t, 0, cc); });
      // 列幅リサイザ(最終列の右端には出さない)
      if (cc < cols - 1) {
        const resizer = document.createElement("div");
        resizer.className = "cm-table-col-resizer";
        resizer.addEventListener("pointerdown", (e) => startColResize(e, view, this.colKey, colEls, headerCells, cc, tbl));
        th.appendChild(resizer);
      }
      headerCells.push(th);
      hr.appendChild(th);
    }
    thead.appendChild(hr); tbl.appendChild(thead);
    // ボディ(行操作ボタン付き)
    const tb = document.createElement("tbody");
    t.body.forEach((r, ri) => {
      const tr = document.createElement("tr");
      for (let c = 0; c < cols; c++) {
        const td = document.createElement("td");
        td.style.textAlign = t.aligns[c] || "left";
        td.innerHTML = renderInline(r[c] ?? "");
        if (c === 0) {
          const ctl = document.createElement("span"); ctl.className = "tbl-ctls tbl-row-ctls";
          ctl.appendChild(mkBtn("+", "下に行を追加", () => mutateTable(view, pos(), (x) => x.body.splice(ri + 1, 0, Array(cols).fill("")))));
          ctl.appendChild(mkBtn("&#x2212;", "この行を削除", () => mutateTable(view, pos(), (x) => x.body.splice(ri, 1))));
          td.appendChild(ctl);
        }
        const rc = ri, cc = c;
        td.addEventListener("mousedown", (e) => { if (e.target.closest(".tbl-ctl,[data-href]")) return; e.preventDefault(); selectCell(view, tableAt(view.state, pos()) || t, rc + 2, cc); });
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    // セル内リンクのクリック
    wrap.addEventListener("mousedown", (e) => {
      const a = e.target.closest?.("[data-href]");
      if (a) { e.preventDefault(); openOrJumpLink(view, a.getAttribute("data-href") || "", e.ctrlKey || e.metaKey); }
    });
    return wrap;
  }
}
// フォーカス状態をStateに反映(表ウィジェットの装飾はブロック装飾のためStateFieldからしか
// 提供できず、view.hasFocusを直接読めない。キーボードを閉じたら表を描画するために必要)
const focusEffect = StateEffect.define();
const focusField = StateField.define({ create: () => false, update: (v, tr) => { for (const ef of tr.effects) if (ef.is(focusEffect)) v = ef.value; return v; } });
const focusNotifier = EditorView.focusChangeEffect.of((state, focusing) => focusEffect.of(focusing));
const tableField = StateField.define({
  create: buildTableDeco,
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect))) ? buildTableDeco(tr.state) : v,
  provide: (f) => EditorView.decorations.from(f),
});
function buildTableDeco(state) {
  const decos = [];
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  for (const t of findAllTables(state)) {
    if (focused && sel.from <= t.to && sel.to >= t.from) continue; // 編集モード(生テキスト)
    decos.push(Decoration.replace({ widget: new TableWidget(t), block: true }).range(t.from, t.to));
  }
  return Decoration.set(decos);
}
// ---- 目次 [toc](仕様書 M-12) ----
// [toc] だけの段落を見出し一覧ウィジェットに置換する。見出しの追加・削除・レベル変更は
// docChangedのたびに extractHeadings() を呼び直すため自動的に反映される。
function findTocParagraphs(state) {
  const paras = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Paragraph") return;
      const txt = state.doc.sliceString(node.from, node.to).trim();
      if (/^\[toc\]$/i.test(txt)) paras.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return paras;
}
function buildTocDeco(state) {
  const paras = findTocParagraphs(state);
  if (!paras.length) return Decoration.none;
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  const headings = extractHeadings(state);
  const decos = [];
  for (const p of paras) {
    if (focused && sel.from <= p.to && sel.to >= p.from) continue; // 編集モード(生テキスト)
    decos.push(Decoration.replace({ widget: new TocWidget(headings), block: true }).range(p.from, p.to));
  }
  return Decoration.set(decos);
}
const tocField = StateField.define({
  create: buildTocDeco,
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect))) ? buildTocDeco(tr.state) : v,
  provide: (f) => EditorView.decorations.from(f),
});

// ---- 数式ブロック $$...$$(仕様書 M-07・第5章) ----
// "$$"だけの行から次の"$$"だけの行までを1ブロックとする。構文木に数式ノードは
// 存在しないため行走査になるが、全文書を毎回走査しないよう、既存ブロックに触れる
// 変更・新たに"$"を含む変更があった場合だけ findMathBlocks() で全体を再計算する
// (§8.2と同じ考え方: 通常の入力ではO(変更量)で済ませる)。
const MATH_BLOCK_SCAN_CAP = 500;
function findMathBlockEnd(doc, openLineNumber) {
  const capLine = Math.min(doc.lines, openLineNumber + MATH_BLOCK_SCAN_CAP);
  for (let n = openLineNumber + 1; n <= capLine; n++) {
    if (doc.line(n).text.trim() === "$$") return n;
  }
  return null;
}
function findMathBlocks(state) {
  const doc = state.doc;
  const blocks = [];
  for (let n = 1; n <= doc.lines; n++) {
    if (doc.line(n).text.trim() !== "$$") continue;
    const endLn = findMathBlockEnd(doc, n);
    if (!endLn) continue;
    const openLine = doc.line(n), closeLine = doc.line(endLn);
    const textFrom = openLine.to + 1;
    const textTo = Math.max(textFrom, closeLine.from - 1);
    blocks.push({ from: openLine.from, to: closeLine.to, text: doc.sliceString(textFrom, textTo) });
    n = endLn;
  }
  return blocks;
}
function buildMathBlockDeco(state, blocks) {
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  const toggles = state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  const decos = [];
  for (const b of blocks) {
    if (focused && sel.from <= b.to && sel.to >= b.from) continue; // 編集モード(生テキスト)
    decos.push(Decoration.replace({ widget: new MathWidget(b.text, true, toggles.mathAutoNumber), block: true }).range(b.from, b.to));
  }
  return Decoration.set(decos);
}
const mathBlocksField = StateField.define({
  create: (state) => findMathBlocks(state),
  update: (v, tr) => {
    if (!tr.docChanged) return v;
    let needsRecompute = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (needsRecompute) return;
      if (inserted.toString().includes("$")) { needsRecompute = true; return; }
      for (const b of v) { if (fromA <= b.to && toA >= b.from) { needsRecompute = true; return; } }
    });
    if (needsRecompute) return findMathBlocks(tr.state);
    return v.map((b) => ({ from: tr.changes.mapPos(b.from), to: tr.changes.mapPos(b.to, 1), text: b.text }));
  },
});
const mathBlockDecoField = StateField.define({
  create: (state) => buildMathBlockDeco(state, state.field(mathBlocksField)),
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect) || e.is(setExtToggles)))
    ? buildMathBlockDeco(tr.state, tr.state.field(mathBlocksField))
    : v,
  provide: (f) => EditorView.decorations.from(f),
});

// テーマ切替(main.jsのdocument.documentElement.dataset.theme切替→refreshTheme())をMermaidの
// 再描画に伝えるためのStateEffect。mermaidBlockDecoFieldはウィジェットのeq()判定に使うdark
// フラグをisDarkTheme()から都度読むだけなので、これをdocChanged/selection以外の「再構築の
// きっかけ」として使う(setExtTogglesをmathBlockDecoFieldが使っているのと同じやり方)。
const themeRefreshEffect = StateEffect.define();

// ---- Mermaid図(仕様書 第4.2節「flowchart.js/js-sequence → Mermaidで代替する」・第8.3節) ----
// ```mermaid フェンスコードブロックを図として描画する。フェンス自体は構文木上ただの
// FencedCodeノードなので、htmlBlocksFieldと同じく構文木を辿るだけで検出できる(数式ブロックの
// ような自前の行走査は不要)。ブロック装飾(block: true)はStateFieldからしか提供できない制約は
// 数式ブロック・表と共通のため、同じ2段構成(生の範囲一覧のmermaidBlocksField/実際に置き換える
// mermaidBlockDecoField)にする。
function findMermaidBlocks(state) {
  const blocks = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const fn = node.node;
      if (fn.getChildren("CodeMark").length < 2) return false; // 未終端(閉じフェンス無し)は対象外
      const info = fn.getChild("CodeInfo");
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
      if (lang !== "mermaid") return false; // 言語名がmermaidのフェンスだけを対象にする
      const open = state.doc.lineAt(node.from);
      const close = state.doc.lineAt(Math.max(node.from, node.to - 1));
      // コード本文(開始・終了フェンス行を除いた部分)。閉じフェンスの無い1行だけのフェンス等の
      // 端数ケースは、コピー用ウィジェットの抽出ロジック(上記CodeCopyWidget挿入箇所)と同じ考え方で扱う。
      const bodyFromLine = Math.min(open.number + 1, close.number);
      const bodyFrom = state.doc.line(bodyFromLine).from;
      const bodyTo = close.number > open.number ? Math.max(bodyFrom, close.from - 1) : bodyFrom;
      blocks.push({ from: open.from, to: close.to, code: state.sliceDoc(bodyFrom, bodyTo) });
      return false; // 内側(CodeText等)へは降りない
    },
  });
  return blocks;
}
const mermaidBlocksField = StateField.define({
  create: (state) => findMermaidBlocks(state),
  // HTMLBlockと同様、構文木は既にインクリメンタル解析されているため文書変更のたびに
  // 辿り直すだけでよい(全文字列を毎回正規表現走査するわけではない)。
  update: (v, tr) => (tr.docChanged ? findMermaidBlocks(tr.state) : v),
});
function buildMermaidBlockDeco(state, blocks) {
  // 仕様書 diagramsEnabled: falseなら図として描画せず、通常のフェンスコードのまま
  // (livePreviewのFencedCode処理に委ねる。ここでは空のDecoration.setを返すだけでよい)。
  if (!(state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES).diagrams) return Decoration.none;
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  const dark = isDarkTheme();
  const decos = [];
  for (const b of blocks) {
    if (focused && sel.from <= b.to && sel.to >= b.from) continue; // カーソル/選択がフェンス内→生のコードを表示
    // 実際の描画(renderMermaid呼び出し)はここではなくMermaidWidget.toDOM()で行う。
    // ここで先読みして描画してしまうと、可視範囲外のブロックまで全部レンダリングすることになり
    // 仕様書第8.3節(可視範囲に入ったものだけ実行する)に反する。
    decos.push(Decoration.replace({ widget: new MermaidWidget(b.code, dark), block: true }).range(b.from, b.to));
  }
  return Decoration.set(decos);
}
const mermaidBlockDecoField = StateField.define({
  create: (state) => buildMermaidBlockDeco(state, state.field(mermaidBlocksField)),
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect) || e.is(themeRefreshEffect) || e.is(setExtToggles)))
    ? buildMermaidBlockDeco(tr.state, tr.state.field(mermaidBlocksField))
    : v,
  provide: (f) => EditorView.decorations.from(f),
});

// ---- コードブロック内の数式(仕様書 codeBlockMathEnabled) ----
// ```math フェンスコードブロックを数式として描画する。Mermaid(上記)と全く同じ構成
// (FencedCodeを構文木から検出→フォーカスに応じてウィジェットに置き換え)を踏襲し、
// 実際のレンダリングは既存の数式ブロック($$...$$)と同じMathWidget/renderMathToHtmlを流用する。
function findCodeMathBlocks(state) {
  const blocks = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const fn = node.node;
      if (fn.getChildren("CodeMark").length < 2) return false;
      const info = fn.getChild("CodeInfo");
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
      if (lang !== "math") return false;
      const open = state.doc.lineAt(node.from);
      const close = state.doc.lineAt(Math.max(node.from, node.to - 1));
      const bodyFromLine = Math.min(open.number + 1, close.number);
      const bodyFrom = state.doc.line(bodyFromLine).from;
      const bodyTo = close.number > open.number ? Math.max(bodyFrom, close.from - 1) : bodyFrom;
      blocks.push({ from: open.from, to: close.to, text: state.sliceDoc(bodyFrom, bodyTo) });
      return false;
    },
  });
  return blocks;
}
const codeMathBlocksField = StateField.define({
  create: (state) => findCodeMathBlocks(state),
  update: (v, tr) => (tr.docChanged ? findCodeMathBlocks(tr.state) : v),
});
function buildCodeMathBlockDeco(state, blocks) {
  const toggles = state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  if (!toggles.codeBlockMath) return Decoration.none; // 仕様書 codeBlockMathEnabled: falseなら通常のコードブロックのまま
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  const decos = [];
  for (const b of blocks) {
    if (focused && sel.from <= b.to && sel.to >= b.from) continue; // カーソル/選択がフェンス内→生のコードを表示
    decos.push(Decoration.replace({ widget: new MathWidget(b.text, true, toggles.mathAutoNumber), block: true }).range(b.from, b.to));
  }
  return Decoration.set(decos);
}
const codeMathBlockDecoField = StateField.define({
  create: (state) => buildCodeMathBlockDeco(state, state.field(codeMathBlocksField)),
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect) || e.is(setExtToggles)))
    ? buildCodeMathBlockDeco(tr.state, tr.state.field(codeMathBlocksField))
    : v,
  provide: (f) => EditorView.decorations.from(f),
});

// ---- 空白と改行(仕様書 whitespaceWhenWriting) ----
// "ignore"のとき、段落内の単独改行(ソフトブレーク)を表示上だけ空白1つとして描画する
// (ドキュメントのテキストは変えない)。ViewPluginが提供する装飾は改行をまたいで置換できない
// 制約があるため(CodeMirrorの仕様。表・数式ブロック等の複数行ウィジェットと同じ理由で
// StateFieldにする必要がある)、専用のStateFieldとして実装する。今回は改行1文字だけを
// 幅の狭いスペースに差し替える非ブロックDecoration.replaceのため、block:trueは使わない
// (block:trueの複数行ウィジェットと違い、前後の行はそのまま編集・装飾できる)。
class SoftBreakWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-softbreak"; s.textContent = " "; return s; }
  ignoreEvent() { return false; }
}
function findParagraphSoftBreaks(state) {
  const breaks = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Paragraph") return;
      const fromLine = state.doc.lineAt(node.from).number;
      const toLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
      for (let ln = fromLine; ln < toLine; ln++) {
        const line = state.doc.line(ln);
        if (line.to < state.doc.length) breaks.push({ from: line.to, to: line.to + 1 });
      }
      return false; // 段落内部(インライン装飾)へは降りない。改行位置だけが目的
    },
  });
  return breaks;
}
const softBreaksField = StateField.define({
  create: (state) => findParagraphSoftBreaks(state),
  update: (v, tr) => (tr.docChanged ? findParagraphSoftBreaks(tr.state) : v),
});
function buildSoftBreakDeco(state, breaks) {
  const toggles = state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  if (toggles.whitespaceWhenWriting !== "ignore") return Decoration.none;
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  const decos = [];
  for (const b of breaks) {
    if (b.from >= b.to) continue;
    if (focused) {
      // 改行の前後どちらかの行にカーソル/選択が触れている間は生の改行のまま(編集しやすくするため)
      const beforeLine = state.doc.lineAt(b.from);
      const afterLine = state.doc.lineAt(Math.min(state.doc.length, b.to));
      const touches = sel.from <= afterLine.to && sel.to >= beforeLine.from;
      if (touches) continue;
    }
    decos.push(Decoration.replace({ widget: new SoftBreakWidget() }).range(b.from, b.to));
  }
  return Decoration.set(decos);
}
const softBreakDecoField = StateField.define({
  create: (state) => buildSoftBreakDeco(state, state.field(softBreaksField)),
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect) || e.is(setExtToggles)))
    ? buildSoftBreakDeco(tr.state, tr.state.field(softBreaksField))
    : v,
  provide: (f) => EditorView.decorations.from(f),
});

// ---- ブロックHTML(仕様書 第2.9節 M-27〜M-31) ----
// <iframe ...></iframe>や<div>...</div>が段落として単独で置かれている場合、@lezer/markdownの
// 構文木は "HTMLBlock" ノードとして検出してくれる(インラインのHTMLTagと異なり、開始/終了を
// 自前でペアリングする必要は無い)。ブロック装飾(block: true)はCodeMirrorの制約上
// StateFieldからしか提供できずview.visibleRangesが使えないため、表(tableField)・
// 数式ブロック(mathBlockDecoField)と同じ2段構成にする: 生の範囲一覧を持つ
// htmlBlocksField(livePreviewのbuild()からも「この行はHTML内か」の判定に使う)と、
// フォーカス/選択に応じて実際に置き換えるhtmlBlockDecoFieldに分ける。
function findHtmlBlocks(state) {
  const blocks = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "HTMLBlock") { blocks.push({ from: node.from, to: node.to }); return false; }
    },
  });
  return blocks;
}
const htmlBlocksField = StateField.define({
  create: (state) => findHtmlBlocks(state),
  // HTMLBlockは構文木のノードであり(数式ブロックのような自前の行走査ではなく)構文木が
  // 既にインクリメンタル解析を行っているため、tableField/tocFieldと同様に文書変更のたびに
  // 構文木を辿るだけでよい(全文字列を毎回正規表現走査するわけではない)。
  update: (v, tr) => (tr.docChanged ? findHtmlBlocks(tr.state) : v),
});
function buildHtmlBlockDeco(state, blocks) {
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  const decos = [];
  for (const b of blocks) {
    if (focused && sel.from <= b.to && sel.to >= b.from) continue; // 編集モード(生テキスト)
    decos.push(Decoration.replace({ widget: new HtmlBlockWidget(state.sliceDoc(b.from, b.to)), block: true }).range(b.from, b.to));
  }
  return Decoration.set(decos);
}
const htmlBlockDecoField = StateField.define({
  create: (state) => buildHtmlBlockDeco(state, state.field(htmlBlocksField)),
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect)))
    ? buildHtmlBlockDeco(tr.state, tr.state.field(htmlBlocksField))
    : v,
  provide: (f) => EditorView.decorations.from(f),
});

// テーブルから離れたら自動整形(編集中は整形しない)
const tableAutoFormat = EditorView.updateListener.of((u) => {
  if (!u.selectionSet && !u.focusChanged) return;
  const prev = tableAt(u.startState, u.startState.selection.main.head);
  if (!prev) return;
  const mapped = u.changes.mapPos(prev.from, 1);
  const now = u.view.hasFocus && tableAt(u.state, u.state.selection.main.head);
  if (now && now.from === mapped) return; // まだ同じ表を編集中
  setTimeout(() => {
    const t = tableAt(u.view.state, Math.min(mapped, u.view.state.doc.length));
    if (!t) return;
    const fmt = formatTableText(t);
    if (u.view.state.sliceDoc(t.from, t.to) !== fmt) u.view.dispatch({ changes: { from: t.from, to: t.to, insert: fmt } });
  }, 0);
});
// 表内のTab/Enterナビゲーション
function handleTableKey(view, ev) {
  const state = view.state, pos = state.selection.main.head;
  const t = tableAt(state, pos);
  if (!t) return false;
  const line = state.doc.lineAt(pos);
  const rowIdx = line.number - t.startLine; // 0=見出し 1=区切り 2以降=ボディ
  const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map(r => r.length) : [0]), 1);
  const before = line.text.slice(0, pos - line.from);
  const c = Math.min(cols - 1, Math.max(0, (before.match(/\|/g) || []).length - 1));
  if (ev.key === "Tab") {
    let r = rowIdx === 1 ? 2 : rowIdx, nc = c + (ev.shiftKey ? -1 : 1), nr = r;
    if (nc >= cols) { nc = 0; nr = r === 0 ? 2 : r + 1; }
    if (nc < 0) { if (r === 0) return true; nr = r === 2 ? 0 : r - 1; nc = cols - 1; }
    if (nr >= 2 && nr - 2 >= t.body.length) return true; // 最終セルのTabは何もしない
    selectCell(view, t, nr, nc);
    return true;
  }
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    if (line.number === t.endLine && c >= cols - 1) { // 最終行の最終セル → 行追加
      t.body.push(Array(cols).fill(""));
      view.dispatch({ changes: { from: t.from, to: t.to, insert: formatTableText(t) } });
      const nt = tableAt(view.state, t.from);
      if (nt) selectCell(view, nt, nt.body.length + 1, 0);
      return true;
    }
  }
  return false;
}
// ---- 検索・置換(仕様書 E-17〜E-19) ----
// マッチの検出・ハイライト・正規表現/大文字小文字/単語単位の判定は
// @codemirror/search の SearchQuery / search() 拡張に任せる。パネルUIは
// 自前で構築する(src/search-ui.js)ため、既定の検索キーマップ・パネルは使わない。
function countSearchMatches(state) {
  const query = getSearchQuery(state);
  if (!query.valid) return { count: 0, index: -1 };
  const cursor = query.getCursor(state);
  const sel = state.selection.main;
  let count = 0, index = -1;
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    if (r.value.from === sel.from && r.value.to === sel.to) index = count;
    count++;
  }
  return { count, index };
}
// リスト系の折り返し行のハンギングインデント(1行目のテキスト開始位置に揃える)は
// livePreviewのbuild()内(可視範囲の行走査)でcm-hangクラスとして付与している。


// ---- 絵文字ショートコードの入力補完(仕様書 M-22・emojiAutocomplete) ----
// "off"なら常に候補を出さない。"esc"なら自動起動(入力のたびの呼び出し)では反応せず、
// 下記のEscapeキーバインド経由のstartCompletion(explicit呼び出し)でのみ候補を出す。
// "auto"(既定)は従来どおり":"入力のたびに自動で候補を出す。拡張自体は常時マウントしたまま
// (Compartmentでの着脱ではなく)状態に応じてsource関数がnullを返すだけにすることで、
// 他のトグル設定と同じくextTogglesFieldのStateEffect経由で即時反映できるようにする。
function emojiCompletionSource(context) {
  const mode = (context.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES).emojiAutocomplete ?? "auto";
  if (mode === "off") return null;
  const word = context.matchBefore(/:[a-zA-Z0-9_+-]*$/);
  if (!word) return null;
  if (mode === "esc" && !context.explicit) return null; // Escapeでの明示呼び出し時のみ
  if (word.from === word.to && !context.explicit) return null;
  const query = word.text.slice(1);
  if (!query) return null;
  const options = findEmojiCompletions(query).map(({ code, emoji }) => ({
    label: `:${code}:`, displayLabel: `${emoji} :${code}:`, apply: `:${code}:`, type: "text",
  }));
  if (!options.length) return null;
  return { from: word.from, options };
}
const emojiCompletion = autocompletion({ override: [emojiCompletionSource], icons: false });

// Markdown文書(ライブプレビュー一式)の拡張子集合。docModeComp/livePreviewCompの既定値。
// Autolink(@lezer/markdown のGFM拡張)は "www./http(s)://" や裸のメールアドレス等を
// "URL" ノードとして検出する(<url>形式は拡張なしでコアパーサが標準対応済み、仕様書 M-17)。
// ---- スマート引用符・スマートダッシュの"input"タイミング(ドキュメントのテキスト自体を置換) ----
// 仕様書: smartQuotes="input"は入力時に文書のテキストごと置換する。smartDashesの適用タイミングは
// smartQuotesと同じ考え方にする(このファイルの方針として、smartQuotes="input"の間だけ
// smartDashesも実テキストを書き換え、それ以外はlivePreview側の表示専用変換に任せる)。
const CODE_CONTEXT_NODES = new Set(["InlineCode", "CodeText", "CodeMark", "CodeInfo", "FencedCode"]);
function inCodeContext(state, pos) {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node) { if (CODE_CONTEXT_NODES.has(node.name)) return true; node = node.parent; }
  const mathBlocks = state.field(mathBlocksField, false) ?? [];
  return mathBlocks.some((b) => pos >= b.from && pos <= b.to);
}
const smartTypingInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to) return false; // 選択の置換は対象外(意図しない変換を避ける)
  const toggles = view.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  const wantsQuotes = toggles.smartQuotes === "input";
  const wantsDashes = toggles.smartDashes !== "off" && toggles.smartQuotes === "input";
  if (!wantsQuotes && !wantsDashes) return false;
  if (inCodeContext(view.state, from)) return false;
  if ((text === '"' || text === "'") && wantsQuotes) {
    const before = view.state.sliceDoc(Math.max(0, from - 1), from);
    const open = !before || /[\s([{＜「『（【〈《]/.test(before);
    const ch = smartQuoteChar(open, text);
    view.dispatch({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: "input.type" });
    return true;
  }
  if (text.length === 1 && text !== "-" && wantsDashes) {
    // ハイフンの連続の直後に別の文字が入力された時点で、その連続を変換する
    // (2〜3個目のハイフンを打った瞬間には、まだ後何個続くか分からないため)。
    const before = view.state.sliceDoc(Math.max(0, from - 3), from);
    const m = before.match(/-{2,3}$/);
    if (m) {
      const runLen = m[0].length;
      const ch = toggles.smartDashes === "emdash" ? "—" : (runLen >= 3 ? "—" : "–");
      const runFrom = from - runLen;
      view.dispatch({
        changes: [{ from: runFrom, to: from, insert: ch }, { from, to, insert: text }],
        selection: { anchor: runFrom + ch.length + text.length },
        userEvent: "input.type",
      });
      return true;
    }
  }
  return false;
});

const markdownLanguageExt = () => markdown({ extensions: [Strikethrough, Table, Superscript, Subscript, Emoji, Autolink], codeLanguages });
const livePreviewExt = () => [
  livePreview, focusField, focusNotifier, tableField, tableAutoFormat,
  frontmatterField, tocField, extTogglesField, emojiCompletion,
  mathBlocksField, mathBlockDecoField,
  mermaidBlocksField, mermaidBlockDecoField, // Mermaid図(仕様書 第4.2節・第8.3節)
  codeMathBlocksField, codeMathBlockDecoField, // ```mathフェンス(仕様書 codeBlockMathEnabled)
  htmlBlocksField, htmlBlockDecoField, // ブロックHTML(M-27〜M-31)
  softBreaksField, softBreakDecoField, // 仕様書 whitespaceWhenWriting="ignore"
  smartTypingInputHandler, // 仕様書 smartQuotes="input"・smartDashes
];

// コードモード限定の拡張(仕様書 決定済み事項: 行番号・括弧の対応表示まで。
// インデントガイドは視認性を損なうため搭載しない。矩形選択・コード補完・LSP連携・
// エラー診断も搭載しない)。
const codeModeExtras = () => [lineNumbers(), bracketMatching()];

// 本文のフォントサイズ(px)。Ctrl+マウスホイールでMIN〜MAXの範囲を1pxずつ変更する。
export const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 40;

export function createEditor(parent, { onChange, onFocus, onBlur, onCompositionChange, onRender, onPaste, onCopy, onSelectionChange } = {}) {
  const editable = new Compartment();
  const themeComp = new Compartment();
  // ファイル種別ごとの編集モード切り替え(仕様書 第1章: markdown / code / plain)。
  // コード/プレーンテキストのファイルではMarkdownの言語解析とライブプレビュー装飾を外す。
  const docModeComp = new Compartment();
  const livePreviewComp = new Compartment();
  const codeModeExtrasComp = new Compartment();
  // 折り返し表示のON/OFF(仕様書 N-05)。既定はON(従来どおり)。
  const wrapComp = new Compartment();
  // 自動ペアリング(仕様書 第2.10節 C-05)のON/OFF。既定はON。
  const autoPairComp = new Compartment();
  // フォーカスモード(V-06)・タイプライターモード(V-07)のON/OFF。
  const focusModeComp = new Compartment();
  const typewriterComp = new Compartment();
  let composing = false;
  let currentMode = "markdown";
  // コードモード時に実際に適用している言語ID(src/file-types.js の FILE_TYPES[].id と一致)。
  // ステータスバーの言語表示・言語ピッカー(仕様書 第1章の拡張)に使う。markdown/plainモードや、
  // ハイライトのロードに失敗してプレーン表示にフォールバックした場合はnull。
  let currentCodeLanguage = null;
  // 自動ペアリング(仕様書 第2.10節 C-05)。既定はON。
  let autoPairingOn = true;
  // ソースコードモード(仕様書 V-05): 記法マーカーを隠さない生表示。docModeComp(構文ハイライト)は
  // 外さず、livePreviewComp(装飾・マーカー非表示)だけを空にすることで実現する。markdownモード
  // かつsourceMode===falseの時だけライブプレビューを入れる、という条件はsetFileMode/setSourceMode
  // 双方から参照する内部状態としてここに持つ。
  let sourceMode = false;
  let focusModeOn = false;
  let typewriterOn = false;
  // 本文のフォントサイズ(Ctrl+マウスホイールで変更する。メニューバー・ステータスバーは
  // ページ全体のズームではなくここだけを変えるため影響を受けない)。
  let fontSize = DEFAULT_FONT_SIZE;
  // タイプライターモード用のscrollIntoViewは自前でdispatchするため、それによって発生する
  // updateListenerの再入(無限ループ)を防ぐフラグ。
  let applyingTypewriterScroll = false;
  const typewriterListener = EditorView.updateListener.of((u) => {
    if (applyingTypewriterScroll) return; // 自分が起こしたスクロールには反応しない
    if (!u.docChanged && !u.selectionSet) return;
    applyingTypewriterScroll = true;
    try {
      u.view.dispatch({ effects: EditorView.scrollIntoView(u.state.selection.main.head, { y: "center" }) });
    } finally {
      applyingTypewriterScroll = false;
    }
  });
  const makeTheme = () => {
    const cs = getComputedStyle(document.documentElement);
    const ink = cs.getPropertyValue("--ink").trim() || "#1F2428";
    const accentSoft = cs.getPropertyValue("--accent-soft").trim() || "#E1EFED";
    return EditorView.theme({
      "&": { fontSize: fontSize + "px", height: "100%", backgroundColor: "transparent" },
      ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.85" },
      ".cm-content": { padding: "0", caretColor: ink },
      ".cm-cursor, .cm-cursor-primary": { borderLeftColor: ink, borderLeftWidth: "2px" },
      "&.cm-focused": { outline: "none" },
      ".cm-selectionBackground": { backgroundColor: accentSoft },
      // ライブプレビューHTML(仕様書 M-27〜M-31)。描画結果がエディタ幅からはみ出さないよう
      // 最低限max-widthだけ指定する(style.cssは別エージェントが編集中のため触らず、ここに書く)。
      ".cm-html-inline": { display: "inline-block", maxWidth: "100%", verticalAlign: "middle" },
      ".cm-html-block": { display: "block", maxWidth: "100%", overflowX: "auto" },
      ".cm-html-inline img, .cm-html-inline video, .cm-html-inline iframe, .cm-html-inline table": { maxWidth: "100%" },
      ".cm-html-block img, .cm-html-block video, .cm-html-block iframe, .cm-html-block table": { maxWidth: "100%" },
      // Mermaid図(仕様書 第4.2節・第8.3節)。cm-math-block/cm-math-errorと同じ見せ方に揃える:
      // 描画中は中央寄せの「…」プレースホルダ、SVGはエディタ幅からはみ出さないようmax-width指定、
      // エラー時は数式エラーと同系統の目立つ表示にする。
      ".cm-mermaid-block": { display: "block", textAlign: "center", padding: "10px 4px", overflowX: "auto", maxWidth: "100%" },
      ".cm-mermaid-block svg": { maxWidth: "100%", height: "auto" },
      ".cm-mermaid-error": { color: "var(--danger)", fontFamily: "var(--font-mono)", fontSize: ".85em", textAlign: "left" },
      // 表の列幅ドラッグ調整用リサイザ(仕様書 M-08)。ヘッダーセルの右端に重ねる掴み代。
      // 最終列には付けない(TableWidget側で生成しない)。style.cssは別エージェントが
      // 編集中のため触らず、既存の.cm-table系スタイルに合わせてここに追記する。
      ".cm-table-col-resizer": { position: "absolute", top: "0", bottom: "0", right: "-3px", width: "6px", cursor: "col-resize", zIndex: "3", touchAction: "none" },
      ".cm-table-col-resizer:hover, .cm-table-col-resizer:active": { background: "var(--accent)", opacity: "0.5" },
      // 画像のライブプレビュー(仕様書 M-18・第2.9.2節)。インライン要素として段落に混在できるよう
      // inline-blockにし、本文幅からはみ出さないようmax-width:100%にする(style.cssは
      // 別エージェントが編集中のため触らず、ここに書く)。
      ".cm-image-widget": { display: "inline-block", maxWidth: "100%", verticalAlign: "middle", cursor: "pointer" },
      ".cm-image-widget img": { maxWidth: "100%", display: "block", borderRadius: "4px" },
      // 読み込み失敗時の代替表示(壊れたアイコンのまま残さない)。数式エラーと同系統の見た目にする。
      ".cm-image-widget.cm-image-error": { display: "inline-block", padding: "3px 8px", fontSize: ".85em", color: "var(--danger)", background: "var(--code-bg)", borderRadius: "4px", fontFamily: "var(--font-mono)", cursor: "pointer" },
      // 多段引用(仕様書 M-03)。.tok-quoteのborder-leftは1段ぶんの見た目のため、2段目以降は
      // JS側(livePreview)で計算したbox-shadowの重ね書きに置き換える(border-leftは無効化する)。
      ".cm-quote-nested": { borderLeft: "none" },
    });
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        keymap.of([
          // Shift+Enterのソフトブレーク(仕様書 M-01)はEnter(リスト継続のhandleEnter)より
          // 先に評価する必要があるため先頭に置く(配列の先頭ほど優先。実際にはキー文字列が
          // "Shift-Enter"と"Enter"で別物のため衝突はしないが、指示どおり優先順位を明示する)。
          // IME変換中の確定Enterで誤発火しないよう、view.composingがtrueの間は既定動作に委ねる(falseを返す)。
          { key: "Shift-Enter", run: (v) => (v.composing ? false : insertSoftBreak(v)) },
          { key: "Enter", run: handleEnter },
          indentWithTab,
          // closeBrackets()の閉じ括弧削除(Backspaceで対の括弧をまとめて消す)は、
          // defaultKeymapの素のBackspaceより先に評価されるようindentWithTabの直後・
          // defaultKeymapより前に置く(Enter/Tabの優先順位には影響しない)。
          ...closeBracketsKeymap,
          ...defaultKeymap.filter(k => k.key !== "Enter"),
          ...historyKeymap,
        ]),
        docModeComp.of(markdownLanguageExt()),
        syntaxHighlighting(codeHighlightStyle),
        wrapComp.of(EditorView.lineWrapping),
        // 自動ペアリング(仕様書 第2.10節 C-05)。Compartmentで動的にON/OFFできるようにし、既定はON。
        // closeBrackets()の既定ペア(丸括弧・角括弧・波括弧・引用符)のみを使う。Markdown固有の
        // 記法文字(*_~`)まで自動ペアリングするとやりすぎで邪魔になりうるため、あえて追加しない
        // (判断に迷う点であり、追加するかどうかは仕様確定後の判断に委ねる)。
        autoPairComp.of(autoPairingOn ? closeBrackets() : []),
        livePreviewComp.of(livePreviewExt()),
        codeModeExtrasComp.of([]),
        focusModeComp.of([]),
        typewriterComp.of([]),
        editable.of(EditorView.editable.of(true)),
        search({ top: false }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onChange) onChange(view.state.doc.toString());
          if (u.focusChanged) { (view.hasFocus ? onFocus : onBlur)?.(); }
          if ((u.docChanged || u.viewportChanged || u.selectionSet) && onRender) requestAnimationFrame(() => onRender());
          // 行/列・文字数カウント(ステータスバー)用の軽量な通知。doc変化でもカーソル位置は
          // ずれるため、docChangedとselectionSetの両方で呼ぶ(重い集計はここでは行わない)。
          if ((u.docChanged || u.selectionSet) && onSelectionChange) onSelectionChange();
        }),
        EditorView.domEventHandlers({
          compositionstart: () => { composing = true; onCompositionChange?.(true); },
          compositionend: () => { composing = false; onCompositionChange?.(false); },
          // スマートペースト(仕様書 第2.9.3節): HTML形式のクリップボードをMarkdownへ変換して
          // 挿入する。CMの既定貼り付け処理より先に評価し、変換しない場合は既定動作に委ねる。
          paste: (e) => { if (onPaste && onPaste(e)) { e.preventDefault(); return true; } return false; },
          // 既定のコピー形式(仕様書 第2.9.3節、設定で切替可能): 有効な場合はHTMLも併せて
          // クリップボードへ書き込む。CMの既定コピー処理より先に評価する。
          copy: (e) => { if (onCopy && onCopy(e)) { e.preventDefault(); return true; } return false; },
          // リンク装飾のタップでリンク先を開く(mousedownで先取りしてカーソル移動を抑止)。
          // 内部アンカー(#見出し)はCtrl/Cmd+クリック時のみジャンプする(仕様書 M-15)。
          mousedown: (e) => {
            const el = e.target?.closest?.(".tok-link[data-href]");
            if (!el) return false;
            e.preventDefault();
            openOrJumpLink(view, el.getAttribute("data-href") || "", e.ctrlKey || e.metaKey);
            return true;
          },
        }),
        themeComp.of(makeTheme()),
      ],
    }),
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text || "" }, selection: { anchor: 0 } });
      if (onRender) requestAnimationFrame(() => onRender());
    },
    focus: () => view.focus(),
    blur: () => view.contentDOM.blur(),
    isComposing: () => composing,
    hasFocus: () => view.hasFocus,
    tableKey: (ev) => handleTableKey(view, ev),
    setEditable: (on) => view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(on)) }),
    // マークダウン記法拡張のON/OFF(仕様書 第2.10節 C-01)。設定ダイアログでの変更を反映する。
    setExtensionToggles: (toggles) => view.dispatch({ effects: setExtToggles.of(toggles) }),
    getMode: () => currentMode,
    // ファイルを開いた際に拡張子から編集モードを切り替える(仕様書 第1章)。
    // markdown: 従来どおりライブプレビュー一式。code: 該当言語を動的ロードして
    // シンタックスハイライトのみ適用(ライブプレビュー装飾は外す)。plain: 装飾なし。
    // filenameの拡張子で自動判定するが、forceModeを渡すと手動切替(第10.5節メニュー)にも使える。
    setFileMode: async (filename, forceMode) => {
      const mode = forceMode || resolveFileMode(filename);
      currentMode = mode;
      if (mode === "markdown") {
        currentCodeLanguage = null;
        view.dispatch({
          effects: [
            docModeComp.reconfigure(markdownLanguageExt()),
            // ソースコードモード(V-05)中は記法を隠さない生表示のままにする(sourceMode参照)。
            livePreviewComp.reconfigure(sourceMode ? [] : livePreviewExt()),
            codeModeExtrasComp.reconfigure([]),
          ],
        });
        return;
      }
      if (mode === "code") {
        const desc = LanguageDescription.matchFilename(codeLanguages, filename || "");
        let support = null;
        try {
          support = desc ? await desc.load() : null;
        } catch {
          support = null; // 未対応/ロード失敗時はプレーン表示にフォールバックする
        }
        currentCodeLanguage = support ? desc.name : null;
        view.dispatch({
          effects: [
            docModeComp.reconfigure(support ? [support] : []),
            livePreviewComp.reconfigure([]),
            codeModeExtrasComp.reconfigure(codeModeExtras()),
          ],
        });
        return;
      }
      // plain
      currentCodeLanguage = null;
      view.dispatch({
        effects: [
          docModeComp.reconfigure([]),
          livePreviewComp.reconfigure([]),
          codeModeExtrasComp.reconfigure([]),
        ],
      });
    },
    // 拡張子ではなく言語IDを直接指定してコードモードにする(仕様書 第1章の拡張: 内容からの
    // 自動判定・ステータスバーの言語ピッカーから使う)。setFileMode(code分岐)と同じ流儀
    // (LanguageDescription.matchFilename → desc.load() → docModeComp.reconfigure)を、
    // ファイル名でなく言語IDでの一致に置き換えただけ。ロード失敗時はプレーン表示に
    // フォールバックする作法も同じ。
    setCodeLanguage: async (languageId) => {
      const desc = codeLanguages.find((d) => d.name === languageId) || null;
      let support = null;
      try {
        support = desc ? await desc.load() : null;
      } catch {
        support = null; // 未対応/ロード失敗時はプレーン表示にフォールバックする
      }
      currentMode = "code";
      currentCodeLanguage = support ? desc.name : null;
      view.dispatch({
        effects: [
          docModeComp.reconfigure(support ? [support] : []),
          livePreviewComp.reconfigure([]),
          codeModeExtrasComp.reconfigure(codeModeExtras()),
        ],
      });
    },
    // 現在コードモードで適用している言語ID。markdown/plainモード時、またはハイライトの
    // ロードに失敗しプレーン表示へフォールバックした場合はnull。
    getCodeLanguage: () => currentCodeLanguage,
    // 折り返し表示のON/OFF(仕様書 N-05)
    setWordWrap: (on) => view.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) }),
    // 自動ペアリング(仕様書 第2.10節 C-05)のON/OFF。既定はON。C#設定画面から呼ばれる想定。
    setAutoPairing: (on) => {
      autoPairingOn = !!on;
      view.dispatch({ effects: autoPairComp.reconfigure(autoPairingOn ? closeBrackets() : []) });
    },
    isAutoPairing: () => autoPairingOn,
    // 自動リンク(仕様書 M-17)のON/OFF。既定はON。C#設定画面のautoLinksEnabledから
    // apply-settings経由で呼ばれる想定(main.js側の配線は別途行う)。既存のマークダウン記法
    // 拡張トグル(extTogglesField/setExtensionToggles)の仕組みにそのまま乗せる。
    setAutoLinks: (on) => view.dispatch({ effects: setExtToggles.of({ autoLinks: !!on }) }),
    isAutoLinks: () => (view.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES).autoLinks,
    // ソースコードモード(仕様書 V-05): 記法マーカーを隠さない生表示。Markdownの構文ハイライト
    // (docModeComp)自体は外さない。markdownモード以外の時はlivePreviewComp自体が既に空なので
    // 見た目には影響しないが、状態は保持しておき次にmarkdownモードへ戻った時に反映する。
    setSourceMode: (on) => {
      sourceMode = !!on;
      if (currentMode === "markdown") {
        view.dispatch({ effects: livePreviewComp.reconfigure(sourceMode ? [] : livePreviewExt()) });
      }
    },
    isSourceMode: () => sourceMode,
    // フォーカスモード(仕様書 V-06): カーソルのある段落以外の行を減光する。
    setFocusMode: (on) => {
      focusModeOn = !!on;
      view.dispatch({ effects: focusModeComp.reconfigure(focusModeOn ? [focusMode] : []) });
    },
    isFocusMode: () => focusModeOn,
    // タイプライターモード(仕様書 V-07): 現在行を画面中央に固定する。
    setTypewriterMode: (on) => {
      typewriterOn = !!on;
      view.dispatch({ effects: typewriterComp.reconfigure(typewriterOn ? [typewriterListener] : []) });
      if (typewriterOn) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
    },
    isTypewriterMode: () => typewriterOn,
    // 指定行へジャンプ(仕様書 N-04)
    gotoLine: (n) => {
      const clamped = Math.max(1, Math.min(view.state.doc.lines, Math.floor(n) || 1));
      const line = view.state.doc.line(clamped);
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
      view.focus();
    },
    // サイドバーのアウトラインパネル(仕様書 第2.8節 S-01)から見出しへジャンプ。
    // [toc]記法のTocWidget(本ファイル内)のクリック処理と同じ挙動。
    jumpToHeading: (heading) => {
      view.dispatch({ selection: { anchor: heading.from }, effects: EditorView.scrollIntoView(heading.from, { y: "center" }) });
      view.focus();
    },
    // ---- 文字数カウント(仕様書 第2.7節 W-01〜W-03、第3章 N-03) ----
    // 行/列(カーソル位置から直接取れる軽量な情報。入力・カーソル移動のたびに呼んでよい)。
    getCursorInfo: () => {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number, col: head - line.from + 1 };
    },
    // 選択範囲の文字数(こちらも軽量。sel.to - sel.fromを返すだけ)。
    getSelectionLength: () => {
      const sel = view.state.selection.main;
      return sel.to - sel.from;
    },
    // ステータスバーの文字数表示用。doc.lengthを直接返す(getValue()のtoString()より軽い)。
    getDocLength: () => view.state.doc.length,
    // クリックで開く詳細ポップアップ用(W-02)。単語数・段落数の集計は文書全体の走査を伴う
    // 重い処理のため、呼び出し側はポップアップを開いた瞬間にだけ呼ぶこと(入力のたびに呼ばない)。
    // 選択範囲があればそちらの集計も併せて返す(W-03)。
    getDetailedStats: () => {
      const sel = view.state.selection.main;
      return {
        doc: computeTextStats(view.state.doc.toString()),
        selection: sel.from === sel.to ? null : computeTextStats(view.state.sliceDoc(sel.from, sel.to)),
      };
    },
    // ---- 検索・置換(仕様書 E-17〜E-19) ----
    setSearchQuery: (opts) => view.dispatch({ effects: setSearchQuery.of(new SearchQuery(opts)) }),
    findNext: () => findNext(view),
    findPrevious: () => findPrevious(view),
    replaceNext: () => replaceNext(view),
    replaceAllMatches: () => replaceAll(view),
    getSearchMatchInfo: () => countSearchMatches(view.state),
    // マークダウンとしてコピー(仕様書 E-04)。選択があれば選択範囲、無ければ全文。
    getMarkdownForClipboard: () => {
      const sel = view.state.selection.main;
      return sel.from === sel.to ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
    },
    // HTMLとしてコピー(仕様書 E-05)。選択があれば選択範囲、無ければ全文をHTML化する。
    getHtmlForClipboard: () => {
      const sel = view.state.selection.main;
      const range = sel.from === sel.to ? { from: 0, to: view.state.doc.length } : { from: sel.from, to: sel.to };
      return renderMarkdownToHtml(view.state, range);
    },
    // HTMLエクスポート(仕様書 File項目「エクスポート: HTML」)。文書全体を対象にする。
    getStandaloneHtml: (title, styled) => renderStandaloneHtml(view.state, title, EXPORT_CSS, styled),
    // カーソル位置の行に記法を挿入(ツールバー用)
    applyAction: (action, payload) => applyMdAction(view, action, payload),
    // 選択範囲をテキストで置き換える(プレーンテキスト貼り付け・スマートペースト用)
    pasteText: (text) => { view.dispatch(view.state.replaceSelection(text)); view.focus(); },
    // themeRefreshEffectも併せて発行し、Mermaid図(mermaidBlockDecoField)をdark/lightに
    // 合わせて再描画させる(既存のMathWidgetはCSS変数のみで配色するため再描画不要だが、
    // MermaidはSVG自体をtheme:"dark"/"default"で作り直す必要があるため)。
    refreshTheme: () => view.dispatch({ effects: [themeComp.reconfigure(makeTheme()), themeRefreshEffect.of(null)] }),
    // 本文のフォントサイズ(Ctrl+マウスホイール)。範囲外の値は丸め、実際に適用した値を返す。
    getFontSize: () => fontSize,
    setFontSize: (size) => {
      const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size) || DEFAULT_FONT_SIZE));
      if (clamped !== fontSize) {
        fontSize = clamped;
        view.dispatch({ effects: themeComp.reconfigure(makeTheme()) });
      }
      return fontSize;
    },
    destroy: () => view.destroy(),
  };
}

// ---- 文字種境界での単語判定(仕様書 E-12注記: 日本語は形態素境界ではなく文字種境界で判定) ----
// charClass自体はtext-stats.js(文字数カウントの単語数集計と共用)からimportしている。
function wordRangeAt(text, pos) {
  if (!text.length) return { from: pos, to: pos };
  const at = Math.min(pos, text.length - 1);
  const cls = charClass(text[at] ?? text[Math.max(0, at - 1)]);
  if (cls === "space") return { from: pos, to: pos };
  let from = pos, to = pos;
  while (from > 0 && charClass(text[from - 1]) === cls) from--;
  while (to < text.length && charClass(text[to]) === cls) to++;
  return { from, to };
}
function selectWordAtCursor(view) {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const r = wordRangeAt(line.text, pos - line.from);
  if (r.from === r.to) return;
  view.dispatch({ selection: { anchor: line.from + r.from, head: line.from + r.to } });
}
function deleteWordAtCursor(view) {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const r = wordRangeAt(line.text, pos - line.from);
  if (r.from === r.to) return;
  view.dispatch({ changes: { from: line.from + r.from, to: line.from + r.to }, selection: { anchor: line.from + r.from } });
}
// 行/文を選択(仕様書 E-09、表内では行を選択)
function selectLineAtCursor(view) {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  view.dispatch({ selection: { anchor: line.from, head: line.to } });
}
// スタイル範囲を選択(仕様書 E-11、表内ではセルを選択)
const STYLE_NODE_NAMES = new Set(["StrongEmphasis", "Emphasis", "Strikethrough", "InlineCode", "Link", "Superscript", "Subscript"]);
function selectStyleRangeAtCursor(view) {
  const { state } = view;
  const pos = state.selection.main.head;
  const t = tableAt(state, pos);
  if (t) {
    const line = state.doc.lineAt(pos);
    const rowIdx = line.number - t.startLine;
    const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map((r) => r.length) : [0]), 1);
    const before = line.text.slice(0, pos - line.from);
    const c = Math.min(cols - 1, Math.max(0, (before.match(/\|/g) || []).length - 1));
    selectCell(view, t, rowIdx, c);
    return;
  }
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node && !STYLE_NODE_NAMES.has(node.name)) node = node.parent;
  if (node) view.dispatch({ selection: { anchor: node.from, head: node.to } });
}
// 見出しレベルの上げ下げ(仕様書 P-03・P-04)。delta<0で上げる(#を減らす)、delta>0で下げる。
function shiftHeadingLevel(view, delta) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const m = line.text.match(/^( {0,3})(#{1,6})(\s+)/);
  if (m) {
    const newLevel = Math.min(6, Math.max(1, m[2].length + delta));
    if (newLevel === m[2].length) return;
    view.dispatch({ changes: { from: line.from + m[1].length, to: line.from + m[1].length + m[2].length, insert: "#".repeat(newLevel) } });
  } else if (delta > 0) {
    view.dispatch({ changes: { from: line.from, insert: "# " } });
  }
  view.focus();
}
// リスト種別の相互変換(仕様書 P-13)。target: "bullet" | "ordered" | "check"
function convertListType(view, target) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const m = line.text.match(/^(\s*)(?:[-*+]\s+\[[ xX]\]\s?|[-*+]\s|\d+\.\s)/);
  if (!m) return;
  const indent = m[1];
  const marker = target === "bullet" ? indent + "- " : target === "ordered" ? indent + "1. " : indent + "- [ ] ";
  view.dispatch({ changes: { from: line.from, to: line.from + m[0].length, insert: marker } });
  view.focus();
}
// 表の行を削除(仕様書 Edit系)。ヘッダー・区切り行では何もしない。
function deleteTableRowAtCursor(view) {
  const { state } = view;
  const pos = state.selection.main.head;
  const t = tableAt(state, pos);
  if (!t) return;
  const line = state.doc.lineAt(pos);
  const rowIdx = line.number - t.startLine; // 0=見出し 1=区切り 2以降=ボディ
  const bodyIdx = rowIdx - 2;
  if (bodyIdx < 0 || bodyIdx >= t.body.length) return;
  t.body.splice(bodyIdx, 1);
  view.dispatch({ changes: { from: t.from, to: t.to, insert: formatTableText(t) } });
  view.focus();
}
// 書式を消去(仕様書 R-08)。選択範囲のマークダウン記法をすべて除去する。
function eraseFormatting(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^ {0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/, ""))
    .join("\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\^([^^]+)\^/g, "$1")
    .replace(/~([^~]+)~/g, "$1");
}

// ツールバーの記法挿入(CodeMirror版)
function applyMdAction(view, action, payload) {
  const { state } = view;
  const sel = state.selection.main;
  const s = sel.from, e = sel.to;
  const selText = state.sliceDoc(s, e);
  const line = state.doc.lineAt(s);
  const linePrefix = (p) => {
    // 既存の同種プレフィックスがあればトグル、無ければ付与。浅いインデント(3個まで)の後ろで判定する
    const ind = line.text.match(/^ {0,3}/)[0].length;
    const base = line.from + ind;
    const cur = line.text.slice(ind).match(/^(#{1,6}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s|>\s)/);
    if (cur && cur[0] === p) {
      view.dispatch({ changes: { from: base, to: base + p.length }, selection: { anchor: Math.max(base, s - p.length) } });
    } else if (cur) {
      view.dispatch({ changes: { from: base, to: base + cur[0].length, insert: p }, selection: { anchor: s - cur[0].length + p.length } });
    } else {
      view.dispatch({ changes: { from: base, insert: p }, selection: { anchor: s + p.length } });
    }
    view.focus();
  };
  const insert = (t, cursorOffset) => view.dispatch({ changes: { from: s, to: e, insert: t }, selection: { anchor: s + (cursorOffset ?? t.length) } });
  const wrapSel = (w) => view.dispatch({ changes: [{ from: s, insert: w }, { from: e, insert: w }], selection: { anchor: s + w.length, head: e + w.length } });
  const wrapPair = (open, close) => view.dispatch({ changes: [{ from: s, insert: open }, { from: e, insert: close }], selection: { anchor: s + open.length, head: e + open.length } });

  switch (action) {
    case "bold": wrapSel("**"); break;
    case "italic": wrapSel("*"); break;
    case "strike": wrapSel("~~"); break;
    case "highlight": wrapSel("=="); break;
    case "code": wrapSel("`"); break;
    case "underline": wrapPair("<u>", "</u>"); break; // 仕様書 R-03
    case "superscript": wrapSel("^"); break;
    case "subscript": wrapSel("~"); break;
    case "eraseFormat": {
      const cleaned = eraseFormatting(selText);
      view.dispatch({ changes: { from: s, to: e, insert: cleaned }, selection: { anchor: s, head: s + cleaned.length } });
      break; // 仕様書 R-08
    }
    case "softBreak": insertSoftBreak(view); break; // 仕様書 E-02・M-01(共通処理はinsertSoftBreak)
    case "selectWord": selectWordAtCursor(view); break; // 仕様書 E-12
    case "deleteWord": deleteWordAtCursor(view); break; // 仕様書 E-13
    case "selectLine": selectLineAtCursor(view); break; // 仕様書 E-09
    case "selectStyleRange": selectStyleRangeAtCursor(view); break; // 仕様書 E-11
    case "deleteTableRow": deleteTableRowAtCursor(view); break; // 表の行を削除
    case "scrollToSelection": view.dispatch({ effects: EditorView.scrollIntoView(state.selection.main.head, { y: "center" }) }); break; // 仕様書 E-16
    case "headingUp": shiftHeadingLevel(view, -1); break; // 仕様書 P-03
    case "headingDown": shiftHeadingLevel(view, 1); break; // 仕様書 P-04
    case "listBullet": convertListType(view, "bullet"); break; // 仕様書 P-13
    case "listOrdered": convertListType(view, "ordered"); break;
    case "listCheck": convertListType(view, "check"); break;
    case "mathBlock": insert("$$\n" + selText + "\n$$", 3); break; // 仕様書 P-07
    case "frontMatter": {
      if (state.doc.length > 0 && state.doc.line(1).text === "---") break; // 既にある場合は何もしない
      view.dispatch({ changes: { from: 0, insert: "---\ntitle: \n---\n\n" }, selection: { anchor: 10 } });
      break; // 仕様書 P-14
    }
    case "image": {
      // 実際のファイル選択・相対パス解決はC#側(main.js)が行い、結果をpayloadで受け取る
      const alt = payload?.alt ?? "";
      const path = payload?.path ?? "";
      const md = `![${alt}](${path})`;
      view.dispatch({ changes: { from: s, to: e, insert: md }, selection: { anchor: s + md.length } });
      break; // 仕様書 R-07
    }
    case "h": linePrefix("## "); break;
    case "h1": linePrefix("# "); break;
    case "h2": linePrefix("## "); break;
    case "h3": linePrefix("### "); break;
    case "h4": linePrefix("#### "); break;
    case "h5": linePrefix("##### "); break;
    case "h6": linePrefix("###### "); break;
    case "h0": { const m0 = line.text.match(/^( {0,3})(#{1,6}\s)/); if (m0) view.dispatch({ changes: { from: line.from + m0[1].length, to: line.from + m0[0].length }, selection: { anchor: Math.max(line.from, s - m0[2].length) } }); break; }
    case "moveUp": moveLineUp(view); break;
    case "moveDown": moveLineDown(view); break;
    case "dupLine": copyLineDown(view); break;
    case "delLine": deleteLine(view); break;
    case "list": linePrefix("- "); break;
    case "olist": linePrefix("1. "); break;
    case "check": linePrefix("- [ ] "); break;
    case "quote": linePrefix("> "); break;
    case "link": { const label = selText || "リンク"; insert(`[${label}](https://)`, label.length + 11); break; } // カーソルはhttps://の直後
    case "codeblock": insert("```\n" + selText + "\n```", 4); break;
    case "hr": {
      const atLineStart = s === line.from;       // 行の先頭にカーソルがあるか
      if (atLineStart) insert("---\n");          // 行頭なら前の改行は不要、後ろだけ
      else insert("\n\n---\n");                 // 行途中なら前後に改行
      break;
    }
    case "table": insert("\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n", 3); break;
    case "date": { const d = new Date(); insert(`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`); break; }
    case "time": { const d = new Date(); insert(`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`); break; }
    case "undo": undo(view); break;
    case "redo": redo(view); break;
    case "indent": { const ls = line.text.match(/^\s*/)[0]; view.dispatch({ changes: { from: line.from, insert: "  " } }); break; }
    case "outdent": { const m = line.text.match(/^( {1,2}|\t)/); if (m) view.dispatch({ changes: { from: line.from, to: line.from + m[0].length } }); break; }

  }
  view.focus();
}
