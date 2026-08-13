// Pane ライブプレビューエディタ (CodeMirror 6)
// index.html から createEditor() で生成し、返り値のAPIで操作する。
// 依存はすべてesbuildでビルド成果物(dist/)に同梱する。実行時に外部CDNへは一切到達しない。
import { EditorView, keymap, Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import { EditorState, Compartment, StateEffect, StateField } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough, Table, Superscript, Subscript, Emoji } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewline, undo, redo, moveLineUp, moveLineDown, copyLineDown, deleteLine } from "@codemirror/commands";
import { syntaxTree, syntaxHighlighting, HighlightStyle, LanguageDescription } from "@codemirror/language";
import { autocompletion } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { codeLanguages, resolveFileMode } from "./languages.js";
import { extractHeadings, findHeadingBySlug, findEmojiCompletions, EMOJI_SHORTCODES, CALLOUT_TYPES } from "./markdown-extras.js";
import { renderMathToHtml } from "./math.js";

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

// カーソル/選択がこの範囲に触れているか。フォーカスがなければ常に装飾。
function cursorInside(view, from, to) {
  if (!view.hasFocus) return false;
  for (const r of view.state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

// マークダウン記法拡張のON/OFF(仕様書 第2.10節 C-01)。既定はすべてON
// (導入前の挙動を変えないため)。C#設定画面からの変更は setExtensionToggles() 経由で届く。
// インライン数式・自動採番はTypora準拠で既定OFF。
const setExtToggles = StateEffect.define();
const DEFAULT_EXT_TOGGLES = { callouts: true, superSub: true, highlight: true, inlineMath: false, mathAutoNumber: false };
const extTogglesField = StateField.define({
  create: () => DEFAULT_EXT_TOGGLES,
  update: (v, tr) => { for (const ef of tr.effects) if (ef.is(setExtToggles)) v = { ...v, ...ef.value }; return v; },
});

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
  window.open(url, "_blank", "noopener");
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
    const toggles = state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
    const fm = state.field(frontmatterField, false);
    const mathBlocks = state.field(mathBlocksField, false) ?? [];
    const inMathBlock = (pos) => mathBlocks.some((b) => pos >= b.from && pos < b.to);
    const { links: linkRefs, footnotes: footnoteDefs } = collectReferences(state);
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
              + (!blockLive && (ln === open.number || ln === close.number) ? " cm-cb-fence-hidden" : ""); // 記号を隠している時だけフェンス行を圧縮
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
            if (quotedLines.has(ln)) continue; // 入れ子ノードでの二重装飾を防ぐ
            const line = state.doc.line(ln);
            const m = line.text.match(/^ {0,3}>\s?/);
            if (!m) continue;
            quotedLines.add(ln);
            const lineLive = view.hasFocus && state.selection.ranges.some(r => {
              const cl = state.doc.lineAt(r.head);
              return cl.number === line.number || (r.from !== r.to && r.from <= line.to && r.to >= line.from);
            });
            const isMarker = calloutType && ln === markerLn;
            if (isMarker && !lineLive) {
              marks.push({ from: line.from, to: line.to, deco: Decoration.replace({ widget: new CalloutMarkerWidget(calloutType) }) });
            } else if (!lineLive) {
              marks.push({ from: line.from, to: line.from + m[0].length, deco: Decoration.replace({}) });
            }
            const cls = calloutType ? `tok-quote cm-callout cm-callout-${calloutType}` : "tok-quote";
            marks.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: cls }) });
          }
          return;
        }
      }});
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
        const lineLive = view.hasFocus && state.selection.ranges.some(r => {
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
              marks.push({ from: mf, to: mt, deco: Decoration.replace({ widget: new MathWidget(mm[1], false, false) }) });
            }
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
// プレビュー描画(グリッド表 + ホバーで行/列操作)
class TableWidget extends WidgetType {
  constructor(t) { super(); this.t = t; this.key = JSON.stringify([t.header, t.aligns, t.body]); }
  eq(o) { return o.key === this.key; }
  ignoreEvent() { return true; }
  toDOM(view) {
    const t = this.t;
    const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map(r => r.length) : [0]), 1);
    const wrap = document.createElement("div");
    wrap.className = "cm-table";
    const tbl = document.createElement("table");
    const mkBtn = (label, title, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "tbl-ctl"; b.innerHTML = label; b.title = title; b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); fn(); }); return b; };
    const pos = () => { try { return view.posAtDOM(wrap); } catch { return t.from; } };
    // ヘッダー行(列操作ボタン付き)
    const thead = document.createElement("thead"); const hr = document.createElement("tr");
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
      th.addEventListener("mousedown", (e) => { if (e.target.closest(".tbl-ctl")) return; e.preventDefault(); selectCell(view, tableAt(view.state, pos()) || t, 0, cc); });
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
// ---- エディタ内検索(全一致ハイライト + ジャンプ) ----
const setSearchTerms = StateEffect.define();
const searchTermsField = StateField.define({
  create: () => [],
  update: (v, tr) => { for (const ef of tr.effects) if (ef.is(setSearchTerms)) v = ef.value; return v; },
});
function collectHits(state) {
  const terms = state.field(searchTermsField).filter(Boolean);
  if (!terms.length) return [];
  const text = state.doc.toString().toLowerCase();
  const hits = [];
  for (const t of terms) {
    const tl = t.toLowerCase();
    let i = 0;
    while ((i = text.indexOf(tl, i)) >= 0) { hits.push([i, i + tl.length]); i += tl.length; }
  }
  return hits.sort((a, b) => a[0] - b[0]);
}
// リスト系の折り返し行のハンギングインデント(1行目のテキスト開始位置に揃える)は
// livePreviewのbuild()内(可視範囲の行走査)でcm-hangクラスとして付与している。
const searchHighlight = EditorView.decorations.compute([searchTermsField, "doc", "selection"], (state) => {
  const hits = collectHits(state);
  if (!hits.length) return Decoration.none;
  const sel = state.selection.main;
  return Decoration.set(hits.map(h => {
    // 選択範囲がこのヒットと一致していれば「選択中」として黄色ハイライト
    const active = sel.from === h[0] && sel.to === h[1];
    return Decoration.mark({ class: active ? "cm-search-hit cm-search-hit-active" : "cm-search-hit" }).range(h[0], h[1]);
  }), true);
});

// ---- 絵文字ショートコードの入力補完(仕様書 M-22) ----
function emojiCompletionSource(context) {
  const word = context.matchBefore(/:[a-zA-Z0-9_+-]*$/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
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
const markdownLanguageExt = () => markdown({ extensions: [Strikethrough, Table, Superscript, Subscript, Emoji], codeLanguages });
const livePreviewExt = () => [
  livePreview, focusField, focusNotifier, tableField, tableAutoFormat,
  frontmatterField, tocField, extTogglesField, emojiCompletion,
  mathBlocksField, mathBlockDecoField,
];

export function createEditor(parent, { onChange, onFocus, onBlur, onCompositionChange, onRender, onKeydown } = {}) {
  const editable = new Compartment();
  const themeComp = new Compartment();
  // ファイル種別ごとの編集モード切り替え(仕様書 第1章: markdown / code / plain)。
  // コード/プレーンテキストのファイルではMarkdownの言語解析とライブプレビュー装飾を外す。
  const docModeComp = new Compartment();
  const livePreviewComp = new Compartment();
  let composing = false;
  const makeTheme = () => {
    const cs = getComputedStyle(document.documentElement);
    const ink = cs.getPropertyValue("--ink").trim() || "#1F2428";
    const accentSoft = cs.getPropertyValue("--accent-soft").trim() || "#E1EFED";
    return EditorView.theme({
      "&": { fontSize: "15px", height: "100%", backgroundColor: "transparent" },
      ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.85" },
      ".cm-content": { padding: "0", caretColor: ink },
      ".cm-cursor, .cm-cursor-primary": { borderLeftColor: ink, borderLeftWidth: "2px" },
      "&.cm-focused": { outline: "none" },
      ".cm-selectionBackground": { backgroundColor: accentSoft },
    });
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        keymap.of([
          { key: "Enter", run: handleEnter },
          indentWithTab,
          ...defaultKeymap.filter(k => k.key !== "Enter"),
          ...historyKeymap,
        ]),
        docModeComp.of(markdownLanguageExt()),
        syntaxHighlighting(codeHighlightStyle),
        EditorView.lineWrapping,
        livePreviewComp.of(livePreviewExt()),
        editable.of(EditorView.editable.of(true)),
        searchTermsField, searchHighlight,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onChange) onChange(view.state.doc.toString());
          if (u.focusChanged) { (view.hasFocus ? onFocus : onBlur)?.(); }
          if ((u.docChanged || u.viewportChanged || u.selectionSet) && onRender) requestAnimationFrame(() => onRender());
        }),
        EditorView.domEventHandlers({
          compositionstart: () => { composing = true; onCompositionChange?.(true); },
          compositionend: () => { composing = false; onCompositionChange?.(false); },
          // アプリ側ショートカット(Md装飾/Tab/リスト継続)をCMの既定キー処理より先に評価
          keydown: (e) => { if (onKeydown && onKeydown(e)) { e.preventDefault(); return true; } return false; },
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
    setSearch: (terms) => view.dispatch({ effects: setSearchTerms.of(terms || []) }),
    searchJump: (dir) => {
      const hits = collectHits(view.state);
      if (!hits.length) return;
      const cur = view.state.selection.main.from;
      const target = dir > 0 ? (hits.find(h => h[0] > cur) || hits[0])
                             : ([...hits].reverse().find(h => h[0] < cur) || hits[hits.length - 1]);
      view.dispatch({ selection: { anchor: target[0], head: target[1] },
                      effects: EditorView.scrollIntoView(target[0], { y: "center" }) });
    },
    setEditable: (on) => view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(on)) }),
    // マークダウン記法拡張のON/OFF(仕様書 第2.10節 C-01)。設定ダイアログでの変更を反映する。
    setExtensionToggles: (toggles) => view.dispatch({ effects: setExtToggles.of(toggles) }),
    // ファイルを開いた際に拡張子から編集モードを切り替える(仕様書 第1章)。
    // markdown: 従来どおりライブプレビュー一式。code: 該当言語を動的ロードして
    // シンタックスハイライトのみ適用(ライブプレビュー装飾は外す)。plain: 装飾なし。
    setFileMode: async (filename) => {
      const mode = resolveFileMode(filename);
      if (mode === "markdown") {
        view.dispatch({
          effects: [
            docModeComp.reconfigure(markdownLanguageExt()),
            livePreviewComp.reconfigure(livePreviewExt()),
          ],
        });
        return;
      }
      if (mode === "code") {
        const desc = LanguageDescription.matchFilename(codeLanguages, filename);
        let support = null;
        try {
          support = desc ? await desc.load() : null;
        } catch {
          support = null; // 未対応/ロード失敗時はプレーン表示にフォールバックする
        }
        view.dispatch({
          effects: [
            docModeComp.reconfigure(support ? [support] : []),
            livePreviewComp.reconfigure([]),
          ],
        });
        return;
      }
      // plain
      view.dispatch({
        effects: [docModeComp.reconfigure([]), livePreviewComp.reconfigure([])],
      });
    },
    // カーソル位置の行に記法を挿入(ツールバー用)
    applyAction: (action) => applyMdAction(view, action),
    refreshTheme: () => view.dispatch({ effects: themeComp.reconfigure(makeTheme()) }),
    destroy: () => view.destroy(),
  };
}

// ツールバーの記法挿入(CodeMirror版)
function applyMdAction(view, action) {
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

  switch (action) {
    case "bold": wrapSel("**"); break;
    case "italic": wrapSel("*"); break;
    case "strike": wrapSel("~~"); break;
    case "highlight": wrapSel("=="); break;
    case "code": wrapSel("`"); break;
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
