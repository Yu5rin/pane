// Pane ライブプレビューエディタ (CodeMirror 6)
// index.html から createEditor() で生成し、返り値のAPIで操作する。
// 依存はすべてesbuildでビルド成果物(dist/)に同梱する。実行時に外部CDNへは一切到達しない。
import { EditorView, keymap, Decoration, ViewPlugin, WidgetType, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment, StateEffect, StateField, Prec, Transaction, countColumn } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough, Table, Superscript, Subscript, Emoji, Autolink } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewline, undo, redo, moveLineUp, moveLineDown, copyLineDown, deleteLine, indentLess, indentSelection, selectAll } from "@codemirror/commands";
import { syntaxTree, syntaxHighlighting, HighlightStyle, LanguageDescription, bracketMatching, indentUnit, foldCode, unfoldCode, foldAll, unfoldAll, codeFolding, foldNodeProp, foldedRanges, foldEffect, unfoldEffect, language, foldService } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, startCompletion } from "@codemirror/autocomplete";
import { search, setSearchQuery, getSearchQuery, SearchQuery, findNext, findPrevious, replaceNext, replaceAll } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { codeLanguages, resolveFileMode } from "./languages.js";
import { extractHeadings, findHeadingBySlug, findEmojiCompletions, EMOJI_SHORTCODES, CALLOUT_TYPES } from "./markdown-extras.js";
import { renderMathToHtml } from "./math.js";
import { renderMermaid } from "./mermaid-render.js";
import { renderMarkdownToHtml, renderStandaloneHtml } from "./md-to-html.js";
import { charClass, computeTextStats } from "./text-stats.js";
import { sanitizeHtml, isSafeUrl } from "./html-sanitize.js";
import {
  CSS_COLOR_LANGS, findColorMatches, parseColorLiteral, readableTextColor,
} from "./color-picker.js";
// 不具合3の修正で使う。カラーピッカーパネル(color-picker-panel.js)の動的importが失敗した
// 場合にユーザーへ知らせるための、このアプリ既存の警告ダイアログ(confirmOpenExternal等と
// 同じ仕組み。詳細はdialog.js冒頭のコメント参照)。
import { paneAlert } from "./dialog.js";
// formatColorLiteral・openColorPickerPanel(カラーピッカーパネル本体)は、本文の色プレビュー
// 表示(常時の装飾)には要らず、「色を変更…」で実際にパネルを開いたときにしか使わない。
// 初期ロードJS削減(仕様書 第8.4節)のため、openColorPicker()の中で動的importする
// (math.js/mermaid-render.jsと同じ作法)。

// コードのハイライト配色(仕様書 第5章・第10.2節)。色は単独で決め打ちせず、
// style.cssで定義した--code-*トークンを参照する(実体はテーマごとにstyle.css/
// themes.cssで異なる具体色。詳細は style.css の「コードのハイライト配色」コメント参照)。
//
// 不具合修正1(ユーザー報告「```json のキーが色分けされず単調に見える」): Playwrightで
// 実描画のgetComputedStyle().colorを実測したところ、キー("port"等)を表す
// @lezer/highlightの t.propertyName にはこの配列に対応するルールが1つも無く、
// 生成されたCodeMirrorのDOMにそもそもハイライト用のspan自体が付かず、本文と同じ
// --ink色でそのまま描画されていた(=「効いていない」ではなく「このタグだけ未定義」で
// 発生していた不具合)。t.propertyNameは@lezer/json(JSONのキー)だけでなく、
// t.attributeName(HTML/XMLの属性名・@lezer/html)やt.definition(t.propertyName)
// (JSのオブジェクトリテラルのキー・YAMLのキー)の親タグでもある(.setに含まれる)ため、
// ここへ1行足すだけでそれらもまとめて色が付くようになる。
//
// 不具合修正2(ユーザー報告「Graft(VS Code Dark+系)と並べると色分けが明らかに弱い」):
// 実機比較のスクリーンショット付きで、`document.getElementById('back-btn')`のような
// 行で「document(変数)・getElementById(メソッド名)・'back-btn'(文字列)がPaneでは
// 地の色のまま」と指摘された。実測すると、t.variableName単体(修飾なしの変数参照)に
// 対応するルールが1つも無く(function()/definition()で修飾された場合しか色が
// 付いていなかった)、変数参照が軒並み無色(本文と同じ--ink)になっていたのが原因と
// 判明した。t.variableNameへのルールをここへ追加する。
// あわせて、キーワードをt.controlKeyword(if/for/return等の制御構文)とそれ以外
// (const/let/function等の宣言・修飾キーワード)で色を分けた(--code-kw2/--code-kw、
// VS Code Dark+が同様に2色を使い分けているのに合わせた)。
// 関数名(--code-fn)は「呼び出し・宣言される関数/メソッド名」、変数(--code-var)は
// 「変数の参照・宣言」で役割を分ける。t.function(...)で修飾されたものだけを
// --code-fnにし、無修飾のt.variableNameとt.definition(t.variableName)(変数宣言の
// 左辺)は--code-varにする。
//
// 不具合修正3(ユーザーからの正式な目標指定「Lezerでできる範囲でVS Code Dark+相当に
// 寄せて」を受けた追加調査): JS/TS/CSS/HTML/PythonをPaneで実際に開き、各トークンに
// 実際に付いている@lezer/highlightタグ(またはCSSクラス)をDOM上で実測して洗い出した
// (想像でtags.xxxに割り当てず、実測結果に基づいて追加している)。判明した不足分:
//   - t.tagName(HTML/JSXのタグ名、例<div>のdiv): tagName.setはtypeName/nameに
//     一般化されるため、専用ルールが無いと--code-type(型/クラス色)に吸収されて
//     しまっていた。実測でHTMLの"div"が--code-type色になっているのを確認した。
//     Dark+はタグ名をキーワードと同じ青(#569CD6)にしているため、--code-kwを
//     専用ルールで明示的に割り当てる(型色と切り離す)。
//   - t.color(CSS: #fffのような16進カラーリテラル)・t.unit(CSS: pxやem等の単位)への
//     ルールが無かった。実測すると、#fffはハイライト対象外(カラーピッカー機能の
//     別レイヤーでのみ薄く着色)のまま、pxはunitの.set継承でtags.keywordに
//     フォールバックし、実際にキーワードと同じ青で着色されていた(色の意味が
//     ずれる)。数値の一部として扱うのが一般的なため、両方--code-numに統一する。
//   - t.regexp(正規表現リテラル)へのルールが無く無色だった。Dark+は文字列と別の
//     赤(#D16969)を割り当てているため、専用の--code-regexを新設する。
//   - t.escape(文字列中の\nなどのエスケープ)へのルールが無く、文字列の中だけ
//     地の色が混じって見えていた。Dark+の対応表には無いが、無色のまま放置すると
//     文字列内で色が途切れて不自然なため、文字列色(--code-str)に含める。
// なお実測の結果、Lezerでは再現できないと判明した箇所(意味解析が必要でLezerの
// 構文タグだけでは判別できない): TypeScriptのenumメンバー名・SNAKE_CASE/ALL_CAPS
// 慣習による「定数」判定(Dark+の#4FC1FF「定数・列挙子」に相当)は、
// @lezer/javascriptの構文木上はただのvariableName/propertyNameとしてしか
// 現れず、命名規則や型情報を見るセマンティックハイライトが無いと判別できないため
// 非対応(Dark+と完全一致させることはできない。ここに正直に明記する)。
const codeHighlightStyle = HighlightStyle.define([
  { tag: t.controlKeyword, color: "var(--code-kw2)", fontWeight: "600" },
  { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: "var(--code-kw)", fontWeight: "600" },
  { tag: [t.atom, t.bool, t.self], color: "var(--code-kw)" },
  { tag: t.tagName, color: "var(--code-kw)" },
  { tag: [t.string, t.special(t.string), t.escape], color: "var(--code-str)" },
  { tag: t.regexp, color: "var(--code-regex)" },
  { tag: t.comment, color: "var(--code-cmt)", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float, t.color, t.unit], color: "var(--code-num)" },
  { tag: t.propertyName, color: "var(--code-prop)", fontWeight: "600" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-fn)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--code-var)" },
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
// headingStyle/unorderedListMarker/orderedListMarker/indentSizeOnSave/shiftTabAutoIndent/
// autoPairMarkdown/copyWholeLineWhenNoSelection/typewriterKeepCaretCentered/whitespaceOnExport/
// defaultCodeLanguage/defaultCodeLanguageApplyWhen/emojiAutocompleteも、この同じStateField経由で
// 扱う(いずれも「メニューバーから記法を生成するときの形」や編集挙動の設定で、ドキュメントを
// 再構築せず反映できるため)。
const DEFAULT_EXT_TOGGLES = {
  callouts: true, superSub: true, highlight: true, inlineMath: false, mathAutoNumber: "off", autoLinks: true,
  diagrams: true, codeBlockMath: false, codeAutoWrap: true, liveRenderingShowSourceOnFocus: true,
  whitespaceWhenWriting: "preserve", smartQuotes: "off", smartDashes: "off", recognizeUnicodePunctuation: false,
  headingStyle: "atx", unorderedListMarker: "-", orderedListMarker: ".", indentSizeOnSave: 4,
  shiftTabAutoIndent: false, autoPairMarkdown: true, copyWholeLineWhenNoSelection: true,
  typewriterKeepCaretCentered: true, whitespaceOnExport: "ignore", defaultCodeLanguage: "",
  defaultCodeLanguageApplyWhen: "menubar", emojiAutocomplete: "auto",
  // 厳格モード(仕様 strictMode、既定false)・コードブロック行番号(仕様 codeBlockLineNumbers、既定true)。
  strictMode: false, codeBlockLineNumbers: true,
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
// ローカル画像配信用の専用ホスト(不具合修正: 本文はhttps://pane.local/index.htmlとして
// 表示されており、そこ(pane.local)に割り当てられているのはアプリのdist/フォルダだけのため、
// "![](image-1.png)"のような相対パスはhttps://pane.local/image-1.pngと解決されdist/の中を
// 探して必ず404になっていた。実ファイルは編集中の.mdと同じフォルダにあるが、WebView2から
// そこは一切見えていなかった。C#側(Pane/MainForm.cs OnLocalFileResourceRequested)が
// pane-file.localホストへのリクエストごとに実ファイルを読んで返す(範囲外は403)。
const LOCAL_IMAGE_HOST = "https://pane-file.local/";

// 現在アクティブな文書のフォルダ(ローカル画像の相対パス解決の基準)。main.js側が
// setDocumentPath()で同期する。タブ形式でも「表示を切り替える直前」に呼ばれるため
// (main.js switchToTab/applyFileOpened参照)、その後に起きるライブプレビューの
// 装飾再構築(このモジュール内で同期的に走る)では常に切替後の値を参照できる。
let currentDocDir = null;

// Windowsのドライブレター(C:\...)絶対パス・UNC(\\server\share\...)かどうか。
function isAbsoluteLocalPath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

// 失敗しても例外を投げず元の文字列を返すdecodeURIComponent。
// 画像挿入(Pane/ImageInsertService.cs、imageAutoEscapeUrl既定true)が生成するMarkdownの
// 画像パスはURLエスケープ済み(例: "./%E7%84%A1%E9%A1%8C-1.png")のことがあるため、
// 実ファイルパスとして扱う前に元の文字列へ戻す必要がある。手書きの普通のパス(%を含まない)は
// 変化しない。"%"を含むが正規のエスケープでない場合(malformed)は例外を握りつぶし元の文字列を使う。
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// pane-file.localホストへのURLを組み立てる。実パスはクエリ文字列(?path=)に載せる
// (パスの区切り"/"やWindowsのドライブレター":"をURLのパスセグメントとして表現しようとすると
// UNC("\\server\share")や区切り文字自体を含む値の解釈が曖昧になるため、単一のクエリ値として
// まるごとencodeURIComponentする方が単純で確実)。
function toLocalImageUrl(fsPath) {
  return LOCAL_IMAGE_HOST + "?path=" + encodeURIComponent(fsPath);
}

// 画像パスの解決(仕様書 2.9.2)。typora-root-urlが指定されていれば"/"始まりのパスの
// 基準をそこにする(未指定時は文書フォルダを基準とみなす。妥当な既定値: ブラウザの
// オリジンに実体が無いWebView2内では「ページルート相対」に意味が無いため)。
// スキーム付き(https:, data: 等)や"//"始まりは外部/プロトコル相対とみなしそのまま使う
// (外部通信は行わない方針のため、pane-file.local経由にはしない=従来どおり素通しする)。
// それ以外(相対パス・Windows絶対パス)はpane-file.local経由のURLへ書き換える
// (基準フォルダが無い=無題文書等でまだ解決できない場合のみ、従来どおり未解決のまま返す)。
function resolveImageSrc(rawSrc, rootUrl) {
  if (!rawSrc) return rawSrc;
  // Windows絶対パス(例: "C:\..." "C:/...")は、一般的なURIスキーム判定の正規表現
  // (/^[a-zA-Z][\w+.-]*:/)にも「1文字のスキーム(c:)」として誤って一致してしまうため、
  // スキーム判定より先に見る(先にスキーム判定してしまうと、絶対パス画像がpane-file.local
  // 経由にならず未解決のまま渡り、ブラウザ側がERR_UNKNOWN_URL_SCHEMEで読み込みに失敗する)。
  if (isAbsoluteLocalPath(rawSrc)) return toLocalImageUrl(rawSrc);
  if (/^[a-zA-Z][\w+.-]*:/.test(rawSrc) || rawSrc.startsWith("//")) return rawSrc;

  // "/"始まりでtypora-root-urlが指定されている場合は、その配下として解決する。
  // ここだけは基準フォルダ(currentDocDir)の有無に関わらず効かせる。Front Matterで
  // 明示された基準は、文書がまだ無題(保存前)でも尊重されるべきものだからである
  // (この分岐を下の「基準フォルダが無ければ諦める」に巻き込むと、無題文書では
  // typora-root-urlの指定がまるごと無視されてしまう)。
  if (rawSrc.startsWith("/") && rootUrl) {
    const joined = safeDecodeURIComponent(rootUrl.replace(/\/+$/, "") + "/" + rawSrc.replace(/^\/+/, ""));
    // typora-root-url自体が絶対パス("C:\..." や "/...")ならそれをそのまま基準にできる。
    // 相対("./assets" 等)の場合は、さらに文書フォルダからの相対として解決する。
    if (isAbsoluteLocalPath(joined) || joined.startsWith("/")) return toLocalImageUrl(joined);
    if (currentDocDir) return toLocalImageUrl(currentDocDir.replace(/[\\/]+$/, "") + "/" + joined);
    return toLocalImageUrl(joined);
  }

  // typora-root-urlが無い"/"始まりは、WebView2内のオリジンに実体が無く
  // 「ページルート相対」に意味が無いため、文書フォルダからの相対とみなす。
  let effective = safeDecodeURIComponent(rawSrc.startsWith("/") ? rawSrc.replace(/^\/+/, "") : rawSrc);

  if (isAbsoluteLocalPath(effective)) return toLocalImageUrl(effective);
  if (!currentDocDir) return rawSrc; // 基準フォルダが無ければ解決できない(従来どおり)
  return toLocalImageUrl(currentDocDir.replace(/[\\/]+$/, "") + "/" + effective);
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
  if (!isSafeUrl(url)) {
    // html-sanitize.jsのisSafeUrl()と同じ基準で防御する。window.open("javascript:...")は
    // WebView2(Chromium)の仕様上スクリプトを実行しないため現状は実害が無いが、
    // md-to-html.jsの検証と一貫させ、万一の実装変更・別経路にも備える(#2)。
    console.log(`Pane: 安全でないURLのため開きませんでした: ${url}`);
    return;
  }
  confirmOpenExternal(url, () => window.open(url, "_blank", "noopener"));
}

// 外部サイトを開く前の確認(Graftと同じ考え方)。誤クリックで意図しないサイトが
// 既定のブラウザで開くのを防ぐ。ブラウザ標準の確認ダイアログはWebView2側の設定で
// ブロックされることがあるため使わず、自前のダイアログを出す。文書内リンク(#見出し)は確認しない。
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
// コードブロックの行番号(仕様 codeBlockLineNumbers、既定true)。フェンスコードブロックの
// 各コード行の先頭にウィジェットとして番号を差し込むだけで、ドキュメントのテキストは変えない
// (CodeCopyWidgetと同じ「装飾はウィジェットで足す、本文は書き換えない」方針)。
class CodeLineNumberWidget extends WidgetType {
  constructor(n) { super(); this.n = n; }
  eq(o) { return o.n === this.n; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-code-linenum";
    s.textContent = String(this.n);
    return s;
  }
  ignoreEvent() { return true; } // クリックしても何もしない(コピー用ではなく表示専用のため)
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
      // this.srcはMarkdown中の生のパスで、画像挿入時にURLエスケープ済みのことがある
      // (Pane/ImageInsertService.cs imageAutoEscapeUrl既定true。例: "%E7%84%A1%E9%A1%8C-1.png")。
      // そのまま表示すると読めない文字列になるため、表示用にデコードする(失敗時は元の文字列のまま)。
      wrap.textContent = `画像を読み込めません: ${safeDecodeURIComponent(this.src)}`;
    }, { once: true });
    wrap.appendChild(img);
    // クリックすると記法を展開して編集できる(仕様書 2.9.2)。posAtDOMで現在のドキュメント上の
    // 位置を求める(TableWidgetのpos()と同じ考え方。docの変更でウィジェットが使い回されても
    // 正しい位置を取れる)。取得できない場合のみ構築時のfromへフォールバックする。
    // 右クリック(e.button!==0)では反応しない。反応するとウィジェットが即座に生テキストへ
    // 置き換わってしまい、直後のcontextmenuイベントのe.targetが別のDOMに変わって右クリック
    // メニュー(docs/コンテキストメニュー仕様.md)の文脈判定(画像の上かどうか)を妨げてしまう
    // ため(キャレット移動自体はcontextmenu側のresolveClickContextが別途行う)。
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
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
        if (e.button !== 0) return; // 右クリックでは反応しない(理由は他のウィジェットと同じ)
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
          const showLineNumbers = toggles.codeBlockLineNumbers !== false; // 仕様 codeBlockLineNumbers、既定true
          let codeLineNo = 0;
          for (let ln = open.number; ln <= close.number; ln++) {
            const l = state.doc.line(ln);
            const isContentLine = ln > open.number && ln < close.number; // フェンス行自体(```)は除く
            const cls = "cm-codeblock-line" + (ln === open.number ? " cm-cb-first" : "") + (ln === close.number ? " cm-cb-last" : "")
              + (!blockLive && (ln === open.number || ln === close.number) ? " cm-cb-fence-hidden" : "") // 記号を隠している時だけフェンス行を圧縮
              + (toggles.codeAutoWrap === false ? " cm-cb-nowrap" : "") // 仕様書 codeAutoWrap: falseなら長い行を折り返さない
              + (showLineNumbers && isContentLine ? " cm-cb-numbered" : ""); // 行番号ぶんの左余白を確保
            marks.push({ from: l.from, to: l.from, deco: Decoration.line({ class: cls }), line: true });
            if (showLineNumbers && isContentLine) {
              codeLineNo++;
              marks.push({ from: l.from, to: l.from, deco: Decoration.widget({ widget: new CodeLineNumberWidget(codeLineNo), side: -1 }) });
            }
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
          // 厳格モード(仕様 strictMode)。見出し直後のスペース必須・強調記号内側の空白を許さない、
          // といったCommonMarkの基本ルールはlezer/markdown(構文木を作る側)が既定パーサーの時点で
          // 常に守っており、緩めた実装が別に存在するわけではない(実測確認済み)。そのためstrictMode
          // をONにしても差が出ない。唯一、lezerがCommonMark準拠の範囲で"_"による語中の強調
          // (例: "_snake_case_"のように、語の外側の"_"同士は正当な開始・終了境界を満たすため
          // 強調として成立してしまう)を許容しているのは、docs/設定項目一覧.mdの記述が無い場合の
          // 代替方針として挙げられた「アンダースコアによる語中の強調を強調として扱わない」に反する
          // ため、ONの時だけ追加でここを厳しくする(内側に別の"_"を含む"_..._"は強調として扱わない)。
          if (toggles.strictMode && state.doc.sliceString(nf, nf + 1) === "_"
              && state.doc.sliceString(nf + mlen, nt - mlen).includes("_")) {
            return; // 装飾を何も付けず、"_"を含む生のテキストのまま表示する
          }
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
        if (toggles.recognizeUnicodePunctuation) {
          // 全角の句読点をMarkdown記法として認識する(仕様書 recognizeUnicodePunctuation)。
          // "》"を引用のマーカーとして扱う(単一階層のみ。入れ子の全角引用には対応しない、
          // 通常の">"の多段引用[上のBlockquoteノード処理]とは別経路の簡易対応のため)。
          const uq = line.text.match(/^( {0,3})》[ 　]?/);
          if (uq && !quotedLines.has(line.number)) {
            marks.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: "tok-quote" }) });
            if (!lineLive) marks.push({ from: line.from + uq[1].length, to: line.from + uq[0].length, deco: Decoration.replace({}) });
          }
          // 全角の"［］（）"を、リンク・画像の"[]()"として解釈する(直接記法のみ。
          // 参照形式やリンクテキスト内のネストした強調等の再解析は行わない簡易対応)。
          let fim; const fire = /(！?)［([^］\n]*)］（([^）\n]*)）/g;
          while ((fim = fire.exec(line.text))) {
            const isImage = fim[1] === "！";
            const ff = line.from + fim.index, ft = ff + fim[0].length;
            if (cursorInside(view, ff, ft)) continue;
            if (isImage) {
              const rawSrc = fim[3].trim();
              if (!rawSrc) continue;
              const resolvedSrc = resolveImageSrc(rawSrc, imgRootUrl);
              marks.push({ from: ff, to: ft, deco: Decoration.replace({ widget: new ImageWidget(fim[2], rawSrc, resolvedSrc, ff) }) });
            } else {
              const href = fim[3].trim();
              const textFrom = ff + fim[1].length + 1; // "！"(あれば)+"［"ぶん
              const textTo = textFrom + fim[2].length;
              marks.push({ from: ff, to: textFrom, deco: Decoration.replace({}) });
              if (textTo < ft) marks.push({ from: textTo, to: ft, deco: Decoration.replace({}) });
              marks.push({ from: textFrom, to: textTo, deco: Decoration.mark({ class: "tok-link", attributes: { "data-href": href } }) });
            }
          }
        }
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

// ---- 引用・リストの空行でEnter2回で抜けられるようにする(ラウンド2の追加依頼) ----
// @codemirror/lang-markdownの標準Enter処理(insertNewlineContinueMarkupCommand、
// markdownLanguageExt()にPrec.highで同梱)は、空の項目でのEnterを次の2段階で扱う:
//   1回目: タイトな(項目間に空行の無い)リストを「非タイトへ変換」するだけで、見た目上
//          何も終了しない(内部的には空行を1つ余分に挿す)。
//   2回目: ようやく1段のマーカーを取り除く。
// つまりリストは実質3回Enterを押さないと抜けられない。引用も、直前の行が既に空の引用行に
// なっていないと解除しない(=最初の空行では素通り)という別の理由で同様に3回かかる。
// 一般的なMarkdownエディタ(Typora等)は「マーカーだけで中身が空の行でEnter」を押した
// 時点で即座に1段浅くする(それ以上浅くできなければプレーンな行になる)。この挙動を
// ライブラリより高い優先度(Prec.highest、下のkeymap登録箇所参照)で差し込む。
// 対象を「マーカーだけで中身が空の行」に厳密に絞ることで、中身のある行の通常継続・
// チェックボックスの継続・番号付けの繰り上げ等(すべて正しく動いている)は一切ここで
// 扱わずライブラリ側(Prec.high)・その次の素のhandleEnter()に素通しする(false を返す)。
//
// 引用の中のリスト・リストの中の引用・多段引用・ネストしたリストのいずれでも「1段だけ
// 浅くする」ため、カーソル位置の祖先(Blockquote/ListItem)を外側→内側の順に集め、各階層の
// 幅とマーカー文字列を求める。
//
// 引用と箇条書きでは、深い階層の行にその祖先の分がどう現れるかが根本的に違う点に注意
// (実機でsyntaxTree()の実際のノード範囲を調べて確認済み):
//   ・引用: ネストのどの深さでも、そのぶんの">"が文字どおり繰り返される
//     (例: "> > 入れ子"の2つの"> "はどちらも実在する文字)。
//   ・リスト: 浅い階層のリストは、深い行では自分のマーカー文字を再掲せず、
//     内容開始列に合わせた「幅ぶんの空白」としてしか現れない(実際にマーカー文字が
//     見えるのは最も深い階層だけ)。例えば"- outer\n    - inner"の2行目("    - inner")は、
//     外側の"- "の代わりに単なる空白(先頭2〜4文字ぶん)を挟んでいるだけで、"- "という
//     文字列そのものは2行目には存在しない。
// そのため各階層の「幅」(その階層ぶんが専有する列数)は、その階層のノード自身が最初に
// 現れた行(node.from)で実測する(@codemirror/lang-markdown内部のgetContext()と同じ
// 考え方。内部APIは非公開のためここで作り直す)必要があるが、「1段浅くした後の新しい
// 最深部」を表す文字列は、階層の種類によって組み立て方を変える:
//   ・その階層が引用なら、常に実際の">"文字列(自分の行からスライスしたもの)を使う。
//   ・その階層がリストで、かつ「1段浅くした後に一番深い階層になる」場合は、そのノード
//     自身の行から実測したマーカー文字列(例: "- ")をそのまま使う(それより浅いリストの
//     空白ではなく、正しいマーカー文字を見せる必要があるため)。
//   ・その階層がリストで、かつそれより深い階層がまだ残る(=最深部ではない)場合は、
//     幅ぶんの空白にする(リストの浅い階層は常に空白でしか表現されないため)。
// 不具合修正(実機のPlaywrightで再現・特定): CommonMarkの遅延継続(lazy continuation)により、
// 引用直後の行は">"が無くても引用パラグラフの続きとみなされ、syntaxTree().resolveInner()は
// Blockquoteを返す。この場合カーソル行には実際にはマーカー文字("> "等)が物理的に存在しない。
// 旧実装は「各階層の幅の合計」だけを求め、カーソル行の「合計幅より後ろが空白のみ」かどうか
// しか見ておらず、先頭の幅ぶんの中身そのものを一切検証していなかった。そのため引用から
// 抜けた直後の行に、ちょうどマーカー幅と同じ文字数(例: "> "と同じ2文字の"ab")を打つと、
// 「幅の合計(2) == 文字数(2)、その後ろ(空文字列)は空白のみ」を満たしてしまい、本文の
// "ab"をマーカーだと誤認して(handleEnterExitEmptyMarkup側で)消してしまっていた。
// 修正: 幅を足し合わせて位置を決めるのではなく、カーソル行の先頭から各階層を実際に
// 「消費」していく方式にする。消費できなければ(=その階層の実際のマーカーがカーソル行に
// 存在しなければ)対象外として通常の処理に委ねる。
function markupContext(state, pos) {
  const nodes = [];
  for (let cur = syntaxTree(state).resolveInner(pos, -1); cur; cur = cur.parent) {
    if (cur.name === "FencedCode") return []; // コードフェンス内は対象外
    if (cur.name === "ListItem" || cur.name === "Blockquote") nodes.push(cur);
  }
  if (!nodes.length) return [];
  nodes.reverse(); // 外側→内側の順にする
  const doc = state.doc;
  const line = state.doc.lineAt(pos); // カーソル行。ここから実際に消費していく(幅の合算はしない)
  let consumedInLine = 0; // カーソル行の先頭から、ここまでに消費した文字数
  const infos = []; // { kind: "quote"|"list", width(カーソル行から実測), marker }
  for (const node of nodes) {
    // 種類(引用/リスト)と、そのノードが定義する「幅」・マーカー文字列は、従来どおり
    // そのノード自身が最初に現れた行(node.from)で実測する(リストの浅い階層は自分の行には
    // 空白としてしか現れないため、これは変えられない。@codemirror/lang-markdown内部の
    // getContext()と同じ考え方)。
    const nodeLine = doc.lineAt(node.from);
    const tail = nodeLine.text.slice(node.from - nodeLine.from);
    let m, kind, width, marker;
    if (node.name === "Blockquote" && (m = /^ {0,3}>( ?)/.exec(tail))) {
      kind = "quote"; width = m[0].length; marker = m[0];
    } else if (node.name === "ListItem" && node.parent?.name === "OrderedList" && (m = /^( *)\d+[.)]( *)/.exec(tail))) {
      kind = "list"; width = m[0].length; marker = m[0];
    } else if (node.name === "ListItem" && node.parent?.name === "BulletList" && (m = /^( *)[-+*]( {1,4}\[[ xX]\])?( +)/.exec(tail))) {
      kind = "list"; width = m[0].length; marker = m[0];
    } else {
      return []; // 想定外の構造(パーサーの遅延継続等) → 対象外、通常の処理に委ねる
    }
    // ここがバグ①の本体: カーソル行の残りから、この階層ぶんを実際に消費できるか検証する。
    const remaining = line.text.slice(consumedInLine);
    if (kind === "quote") {
      // 引用は深さに関わらず常に実在する">"文字でなければならない。遅延継続の行にはこれが
      // 存在しない(単なる本文が続くだけ)ため、マッチしなければここで弾く
      // (=遅延継続の行はここでreturn []になり、以降は通常のEnter処理に委ねられる)。
      const qm = /^ {0,3}>( ?)/.exec(remaining);
      if (!qm) return [];
      // 1段浅くした後に表示する文字列も、カーソル行から実測した実物を使う(ネストした
      // 引用で外側と内側の"> "の実際の並びがそのまま欲しいため)。
      infos.push({ kind, width: qm[0].length, marker: qm[0] });
      consumedInLine += qm[0].length;
    } else {
      // リストは「その幅ぶんが空白のみ」または「そのノードから実測したマーカー文字列そのもの」
      // のいずれかであることを要求する(リストの浅い階層はマーカー文字を再掲せず空白でしか
      // 現れないため)。幅ぶんの文字がカーソル行に残っていない場合も対象外。
      const chunk = remaining.slice(0, width);
      if (chunk.length < width) return [];
      if (chunk !== marker && !/^ *$/.test(chunk)) return [];
      infos.push({ kind, width, marker });
      consumedInLine += width;
    }
  }
  // すべての階層を消費し終えた残りが空白のみでなければ対象外(本文が続く通常の継続行、
  // または遅延継続の本文行なので、ここでは扱わず通常の処理に委ねる)。
  if (line.text.slice(consumedInLine).trim() !== "") return [];
  return infos;
}
// 1段浅くした後の行の先頭に置くべき文字列を組み立てる(markupContext()のコメント参照)。
function renderMarkupPrefix(infos) {
  return infos.map((t, i) => {
    const isDeepest = i === infos.length - 1;
    if (t.kind === "quote" || isDeepest) return t.marker;
    return " ".repeat(t.width); // それより浅いリスト階層は常に空白でしか表現されない
  }).join("");
}
// 中身の無いマーカー行でEnterが押されたときの実処理。1段浅くする(最も内側の
// 階層を1つ取り除く。それ以上無ければプレーンな行になる)。行を分割はしない
// (ライブラリ側の解除処理と同じく、いまの行のマーカー部分を書き換えるだけ)。
function handleEnterExitEmptyMarkup(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false; // 選択がある場合は通常の処理へ
  const line = state.doc.lineAt(sel.from);
  if (line.text.slice(sel.from - line.from).trim() !== "") return false; // カーソルの後ろに中身が残るなら対象外
  const context = markupContext(state, sel.from);
  if (!context.length) return false;
  const totalWidth = context.reduce((n, t) => n + t.width, 0);
  if (sel.from - line.from < totalWidth) return false; // カーソルがまだマーカーの途中
  const newPrefix = renderMarkupPrefix(context.slice(0, -1)); // 最も内側の階層を1つ取り除く
  // 不具合修正(実機のPlaywrightで再現・特定): 引用から完全に抜ける(=最も内側の階層が
  // 引用で、1段浅くした結果もう何も残らずプレーンな行になる)ときは、間に空行を1つ挟んで
  // 引用ブロックを閉じる。CommonMarkでは空行が無いと遅延継続(直前行が引用パラグラフの
  // 続きとみなされる)が働くため、マーカー文字を消して見た目上抜けたつもりでも、パーサ上は
  // ずっと引用の中のまま扱われてしまう。保存した.mdを他のMarkdownビューア(GitHub等)で
  // 開くと、続けて書いた段落が引用の中に表示されてしまう=文字の見た目だけでなく文書の
  // 意味そのものが変わる不具合のため、空行を挟むのが正しい(Typoraも引用から抜けると
  // 空行を入れる)。
  // 「引用の中のリスト」から抜けてまだ引用だけが残る場合(context.length > 1のまま。
  // context[0]は外側から見た配列なので、除去されるのは常にcontextの最後の要素)や、
  // リストから完全に抜ける場合は今までどおり空行を挟まない(空行が無くてもCommonMark上
  // 問題が起きないため)。
  const exitingQuoteCompletely = context.length === 1 && context[0].kind === "quote";
  const insert = exitingQuoteCompletely ? "\n" + newPrefix : newPrefix;
  view.dispatch({
    changes: { from: line.from, to: sel.from, insert },
    selection: { anchor: line.from + insert.length },
    userEvent: "input",
  });
  return true;
}

// Enter処理: リスト/チェックリスト/番号を自動継続、空項目なら継続を終了。それ以外はインデントなし改行。
function handleEnter(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.from !== sel.to) return insertNewline(view);
  const line = state.doc.lineAt(sel.from);
  const before = line.text.slice(0, sel.from - line.from);
  // マーカー文字(-*+)・番号区切り(.か)のどちらも、実際にその文書で使われている形を
  // そのまま継続する(設定のunorderedListMarker/orderedListMarkerは新規作成時のみに使い、
  // 既存文書の継続はここでは設定に関わらずドキュメント側の実際の記法に合わせる)。
  const m = before.match(/^(\s*)([-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s)/);
  if (!m) return insertNewline(view); // リストでなければ素の改行(インデントを引き継がない)
  const rest = before.slice(m[0].length);
  if (!rest.trim()) {
    // 空のリスト項目でEnter → マーカーを消して継続終了
    view.dispatch({ changes: { from: line.from, to: sel.from, insert: "" }, selection: { anchor: line.from } });
    return true;
  }
  // マーカーを継続(番号は+1、チェックは未チェックで)
  let marker = m[2];
  const orderedMatch = marker.match(/^(\d+)([.)]\s)$/);
  const checkMatch = marker.match(/^([-*+])\s\[[ xX]\]\s$/);
  if (orderedMatch) marker = m[1] + (parseInt(orderedMatch[1], 10) + 1) + orderedMatch[2];
  else if (checkMatch) marker = m[1] + checkMatch[1] + " [ ] ";
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
  // 不具合2の修正: userEvent未指定(デフォルトのundefined)だとCodeMirrorのhistory結合規則
  // (!userEvent かつ変更範囲が隣接/重複)により、行/列操作を連続実行したときに1回の
  // アンドゥですべて戻ってしまう。カラーピッカーのfinish()と同じ考え方で、
  // "input.type"/"delete"系にマッチしないuserEventを付け、1操作=1アンドゥにする。
  view.dispatch({ changes: { from: t.from, to: t.to, insert: formatTableText(t) }, userEvent: "input.table" });
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
      // 右クリックでは反応しない(理由はImageWidgetのmousedownコメントと同じ:
      // 反応すると表ウィジェットが生テキストへ置き換わり、右クリックメニューの文脈判定を妨げる)。
      th.addEventListener("mousedown", (e) => { if (e.button !== 0 || e.target.closest(".tbl-ctl,.cm-table-col-resizer")) return; e.preventDefault(); selectCell(view, tableAt(view.state, pos()) || t, 0, cc); });
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
        td.addEventListener("mousedown", (e) => { if (e.button !== 0 || e.target.closest(".tbl-ctl,[data-href]")) return; e.preventDefault(); selectCell(view, tableAt(view.state, pos()) || t, rc + 2, cc); });
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    // セル内リンクのクリック。右クリック(e.button!==0)は無視する(既定はcontextmenuイベントに
    // 譲る。ここで反応するとリンクを開く確認ダイアログが右クリック時にも出てしまい、
    // 直後のcontextmenuイベントのe.targetがそのダイアログに奪われて右クリックメニューの
    // 文脈判定を妨げてしまうため)。
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const a = e.target.closest?.("[data-href]");
      if (a) { e.preventDefault(); openOrJumpLink(view, a.getAttribute("data-href") || "", e.ctrlKey || e.metaKey); }
    });
    return wrap;
  }
}
// フォーカス状態をStateに反映(表ウィジェットの装飾はブロック装飾のためStateFieldからしか
// 提供できず、view.hasFocusを直接読めない。キーボードを閉じたら表を描画するために必要)
//
// 不具合5の修正: 以前はfocusField/focusNotifierをlivePreviewExt()経由でlivePreviewComp
// (モード切替のたびreconfigureで丸ごと入れ替わるCompartment)に載せていた。CodeMirror本体は
// blur/focus発生の10ms後にsetTimeoutでview.stateを再取得し、EditorView.focusChangeEffect
// facetに登録された各プロバイダ(focusNotifierもその1つ)を呼び直す。その10ms待ちの間に
// setFileMode等でlivePreviewComp.reconfigure([])が実行されるとfocusField自体がstateから
// 消え、CodeMirror本体側の処理と競合して`RangeError: Field is not present in this state`が
// 発生していた(CodeMirror本体には手を入れられないため、こちら側で「常に存在する」ように
// するしかない)。docContextField等と同じく、モードに関わらず常設の拡張(buildExtensions()側)
// として登録することで、reconfigureのタイミングに関わらずfocusFieldが消えないようにする。
const focusEffect = StateEffect.define();
const focusField = StateField.define({ create: () => false, update: (v, tr) => { for (const ef of tr.effects) if (ef.is(focusEffect)) v = ef.value; return v; } });
const focusNotifier = EditorView.focusChangeEffect.of((state, focusing) => focusEffect.of(focusing));
// 表の一覧(findAllTables、構文木の全走査)は、表と無関係な変更(表の範囲に触れず"|"も
// 挿入されない)では再計算しない。表を1つも含まない/編集箇所から離れた大きな文書で
// 入力のたびに全木を辿るコストを避ける(仕様書 第8.2節・第8.4節)。
// startLine/endLine(表ウィジェットの行挿入・削除操作が使う)は位置remap後の行番号に
// 作り直す(その他のフィールド=header/aligns/bodyは内容が変わっていないためそのまま)。
function remapTableBlocks(tables, tr) {
  return tables.map((t) => {
    const from = tr.changes.mapPos(t.from);
    const to = tr.changes.mapPos(t.to, 1);
    const startLine = tr.state.doc.lineAt(from).number;
    const endLine = tr.state.doc.lineAt(Math.max(from, to - 1)).number;
    return { ...t, from, to, startLine, endLine };
  });
}
const tableBlocksField = StateField.define({
  create: (state) => findAllTables(state),
  update: (v, tr) => {
    if (!tr.docChanged) return v;
    return blockListNeedsRecompute(v, tr, ["|"]) ? findAllTables(tr.state) : remapTableBlocks(v, tr);
  },
});
const tableField = StateField.define({
  create: (state) => buildTableDeco(state, state.field(tableBlocksField)),
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect)))
    ? buildTableDeco(tr.state, tr.state.field(tableBlocksField))
    : v,
  provide: (f) => EditorView.decorations.from(f),
});
function buildTableDeco(state, tables) {
  const decos = [];
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  for (const t of tables) {
    if (focused && sel.from <= t.to && sel.to >= t.from) continue; // 編集モード(生テキスト)
    decos.push(Decoration.replace({ widget: new TableWidget(t), block: true }).range(t.from, t.to));
  }
  return Decoration.set(decos);
}
// ---- 目次 [toc](仕様書 M-12) ----
// [toc] だけの段落を見出し一覧ウィジェットに置換する。見出しの追加・削除・レベル変更は
// docChangedのたびに extractHeadings() を呼び直すため自動的に反映される。
// [toc]段落一覧そのもの(構文木の全Paragraph走査)は、多くの文書では1つも存在しないため
// blockListNeedsRecompute経由で差分更新する([toc]を使わない文書での入力毎の全木走査を避ける。
// 仕様書 第8.2節・第8.4節)。[toc]を実際に使っている場合はparas.length>0の間、従来どおり
// docChangedのたびにextractHeadings()を呼ぶ(見出しの変化を確実に拾うため、そこは変更しない)。
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
const tocParasField = StateField.define({
  create: (state) => findTocParagraphs(state),
  update: (v, tr) => {
    if (!tr.docChanged) return v;
    return blockListNeedsRecompute(v, tr, ["toc"]) ? findTocParagraphs(tr.state) : remapBlockRanges(v, tr.changes);
  },
});
function buildTocDeco(state, paras) {
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
  create: (state) => buildTocDeco(state, state.field(tocParasField)),
  update: (v, tr) => (tr.docChanged || tr.selection || tr.effects.some(e => e.is(focusEffect)))
    ? buildTocDeco(tr.state, tr.state.field(tocParasField))
    : v,
  provide: (f) => EditorView.decorations.from(f),
});

// ---- ブロック一覧系StateFieldの差分更新ヘルパー(表・[toc]・Mermaid/mathフェンス・生HTML共通) ----
// 仕様書 第8.2節の是正対象(表・hangingIndent)に加え、同種の構文木全走査(syntaxTree().iterate())が
// 表以外の複数箇所(目次・Mermaid・コードブロック内数式・生HTML)にも残っていたため、
// mathBlocksField(直下、既存)と同じ考え方をここへ切り出して横展開する。
// 「変更が対象になりうる兆候(トリガー文字列を含む挿入、または既存ブロックの範囲に触れる変更)」
// が無ければ、構文木を辿り直さずtr.changesで位置をずらすだけにする。
// triggersは小文字化した部分文字列の配列(挿入テキストを小文字化して部分一致で見る。
// 大文字小文字を問わない記法(例: [TOC])も拾えるように)。
// 判定はやや粗く倒してある(例: "|"を含む挿入は表と無関係でも再計算する)が、見落とし
// (再計算すべきなのにしない)より誤検知(不要な再計算)の方が安全なため、意図的にこちらへ倒す。
//
// 不具合1の修正(ラウンド3レビュー分・追加調査分の両方): 上記の「挿入テキストにトリガー
// 文字列を含むか」という判定には、性質の異なる2つの見落としがあった。
//   (a) 削除方向: コードフェンス(```)の中に表を書いてから開始・終端の```を両方"削除"して
//       生テキストに戻す操作は、何も挿入しない(削除のみ)ため素通りしてしまい、フェンスが
//       無くなって表・生HTML等として解釈できるようになったのに再計算されない(カーソル移動や
//       無関係な編集では直らず、後で偶然"|"や"<"を含む編集をした瞬間に直るという分かりにくい
//       不具合になっていた)。
//   (b) 分割入力: 実際のユーザー入力は1文字ずつのキー入力であり、1トランザクション=1文字が
//       基本になる。挿入/削除された「差分そのもの」だけを見ていると、"```mermaid"のような
//       複数文字のマーカーは1回のトランザクションでは決して現れず(どのトランザクションを
//       見てもマーカー全体ではなく1文字しか挿入されていない)、どのタイミングでもトリガーに
//       一致しないままになる。これは[toc]/```math/```mermaidいずれでも同様に起こり、
//       「実ユーザーの通常のタイピングではほぼ再計算されない」という重大度の高い見落としだった。
//
// 対策: 挿入/削除された差分そのものではなく、変更位置の前後を含む固定幅の"窓"の中に
// トリガー文字列が現れているかを見る。窓は変更後(tr.state)側・変更前(tr.startState)側の
// 両方で見る(挿入方向・削除方向どちらの見落としも拾うため)。窓の幅はトリガー文字列の
// 最大長+余白だけに留め、行の長さや文書サイズには比例させない(性能維持: 1文字ずつの
// 入力でSTR全体が揃った瞬間のトランザクションでは、カーソル位置の前後にSTRの残りの文字が
// 既に存在しているため、この窓の中に収まる)。
// フェンス境界そのもの(```/~~~)の増減は、このフィールドが対象とする記法がフェンスの
// 内側かどうかで解釈が変わってしまう、表・[toc]・Mermaid・生HTML・コードブロック内数式
// すべてに共通の境界なので、呼び出し側のtriggers配列に含まれているかどうかに関わらず
// 常にチェック対象へ加える(例: 表フィールドのtriggersは"|"だけだが、フェンスを消して
// 中の表が現れるケースもこれで拾う)。
const FENCE_MARK_TRIGGERS = ["```", "~~~"];
function windowContainsTrigger(doc, from, to, pad, triggers) {
  const wFrom = Math.max(0, from - pad);
  const wTo = Math.min(doc.length, to + pad);
  const text = doc.sliceString(wFrom, wTo).toLowerCase();
  return triggers.some((s) => text.includes(s));
}
function blockListNeedsRecompute(existing, tr, triggers) {
  const allTriggers = triggers.length ? [...triggers, ...FENCE_MARK_TRIGGERS] : FENCE_MARK_TRIGGERS;
  const pad = Math.max(...allTriggers.map((s) => s.length)) + 2; // トリガー最大長+前後の余白
  let needs = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (needs) return;
    // 変更後の文書で、挿入位置の前後の窓にトリガーが揃っていないか(1文字ずつの入力で
    // マーカーが完成した瞬間を拾う。既に打たれている残りの文字は変更後の文書に残っている)。
    if (windowContainsTrigger(tr.state.doc, fromB, toB, pad, allTriggers)) { needs = true; return; }
    // 変更前の文書で、削除位置の前後の窓にトリガーが揃っていないか(1文字ずつの削除で
    // マーカーを壊した/表れさせた瞬間を拾う)。
    if (windowContainsTrigger(tr.startState.doc, fromA, toA, pad, allTriggers)) { needs = true; return; }
    for (const b of existing) { if (fromA <= b.to && toA >= b.from) { needs = true; return; } }
  });
  return needs;
}
// 位置だけをtr.changesで移動させる(内容は変更範囲に触れていないことがblockListNeedsRecompute側で
// 保証済みなので、from/to以外のフィールド(code/text等)はそのまま使い回してよい)。
function remapBlockRanges(blocks, changes) {
  return blocks.map((b) => ({ ...b, from: changes.mapPos(b.from), to: changes.mapPos(b.to, 1) }));
}

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
  // 他5つ(表・[toc]・Mermaid・コードブロック内数式・生HTML)と同じくblockListNeedsRecompute経由の
  // 窓方式にする(バグ1の修正: 従来は挿入テキストのみに"$"を含むかで判定しており、削除だけで
  // "$$"が完成する操作(例: "$Ax$"→"x"を削除→"A"を削除→"$$")を検知できず、以降"$"を含まない
  // 編集をいくら重ねても再計算されないという不具合があった)。
  update: (v, tr) => {
    if (!tr.docChanged) return v;
    return blockListNeedsRecompute(v, tr, ["$"]) ? findMathBlocks(tr.state) : remapBlockRanges(v, tr.changes);
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
  // 構文木は既にインクリメンタル解析されているが、辿り直す(syntaxTree().iterate())こと自体は
  // 文書サイズに比例するコストがかかるため、Mermaidフェンスと無関係な変更(既存ブロックに
  // 触れず"```"も"mermaid"も挿入されない)では辿り直さない(§8.2・第8.4節、mathBlocksFieldと同じ考え方)。
  update: (v, tr) => {
    if (!tr.docChanged) return v;
    return blockListNeedsRecompute(v, tr, ["```", "mermaid"]) ? findMermaidBlocks(tr.state) : remapBlockRanges(v, tr.changes);
  },
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
  // mermaidBlocksFieldと同じ考え方(§8.2・第8.4節): ```mathフェンスと無関係な変更では
  // 構文木を辿り直さない。
  update: (v, tr) => {
    if (!tr.docChanged) return v;
    return blockListNeedsRecompute(v, tr, ["```", "math"]) ? findCodeMathBlocks(tr.state) : remapBlockRanges(v, tr.changes);
  },
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

// ---- コード中のカラープレビュー・カラーピッカー(docs/カラープレビュー仕様.md) ----
// 色の認識・パース・整形・パレット生成・コントラスト計算は src/color-picker.js に
// まとめてある(自前実装、外部ライブラリ不使用)。ここでは「どこが色を出してよい文脈か」の
// 判定(コードモード全体 / Markdownのコードフェンス内だけ)と、装飾(ViewPlugin)・
// カラーピッカーの開閉だけを扱う。
//
// 現在の編集モード(markdown/code/plain)とコード言語は、docModeComp/livePreviewComp等の
// Compartmentがモード切替のたびに丸ごと入れ替わってしまう(=そこに載せたStateFieldは
// モード間で消えてしまう)ため、それらとは独立の常設フィールドとして持つ。
// setFileMode/setCodeLanguageから、既存のCompartment再構成と一緒にこの効果も発行する。
const setDocContext = StateEffect.define();
const docContextField = StateField.define({
  create: () => ({ mode: "markdown", language: null }),
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setDocContext)) v = e.value; return v; },
});
// colorPreviewInCode設定(既定true)。extTogglesFieldはMarkdownモードでしか存在しない
// (livePreviewComp経由のため)ので、コードモードでも読めるようこちらも常設フィールドにする。
const setColorPreviewEnabled = StateEffect.define();
const colorPreviewEnabledField = StateField.define({
  create: () => true,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setColorPreviewEnabled)) v = e.value; return v; },
});
// カラーピッカーを開いている間、対象リテラルに枠線ハイライトを付ける(仕様書 4.4)。
// ドキュメント変更(ライブ反映中の書き換え)にも範囲を追従させる。
const setColorPickerHighlight = StateEffect.define();
const colorPickerHighlightField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setColorPickerHighlight)) v = e.value;
    if (v && tr.docChanged) {
      const from = tr.changes.mapPos(v.from), to = tr.changes.mapPos(v.to, 1);
      // 不具合1の修正: 対象範囲を含む編集(全選択して削除等)で範囲そのものが潰れることがある。
      // Decoration.mark()は空範囲を許さずthrowするため、潰れた場合はnullにしてハイライト無しに
      // する(openColorPicker側のcurrentTarget()もこのnullを「対象消失」として扱う)。
      v = from < to ? { from, to } : null;
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v ? Decoration.set([Decoration.mark({ class: "cm-color-picker-target" }).range(v.from, v.to)]) : Decoration.none)),
});

// スウォッチ(仕様書 3.1)。クリックできる要素にはしない(色の変更は右クリック経由、第4章)。
class ColorSwatchWidget extends WidgetType {
  constructor(rgba) { super(); this.rgba = rgba; }
  eq(o) { return o.rgba.r === this.rgba.r && o.rgba.g === this.rgba.g && o.rgba.b === this.rgba.b && o.rgba.a === this.rgba.a; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-color-swatch" + (this.rgba.a < 1 ? " cm-color-swatch-alpha" : "");
    span.style.setProperty("--cm-color-swatch", `rgba(${this.rgba.r},${this.rgba.g},${this.rgba.b},${this.rgba.a})`);
    return span;
  }
  ignoreEvent() { return false; }
}

// 現在のCSS変数(--paper/--ink)をRGBとして読む(コントラスト補正の基準色、仕様書 3.2)。
function cssVarRgb(name, fallbackHex) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = parseColorLiteral(raw) || parseColorLiteral(fallbackHex);
  return parsed ? { r: parsed.r, g: parsed.g, b: parsed.b } : { r: 0, g: 0, b: 0 };
}

// テキスト中の色リテラルを絶対位置つきで集める(呼び出し側が可視範囲だけに絞って呼ぶ)。
function scanColorsInRange(state, from, to, allowNames, out) {
  let pos = from;
  while (pos <= to) {
    const line = state.doc.lineAt(pos);
    const chunkFrom = Math.max(line.from, from);
    const chunkTo = Math.min(line.to, to);
    if (chunkFrom < chunkTo) {
      const text = state.sliceDoc(chunkFrom, chunkTo);
      for (const m of findColorMatches(text, allowNames)) out.push({ from: chunkFrom + m.from, to: chunkFrom + m.to, raw: m.raw });
    }
    if (line.to >= to) break;
    pos = line.to + 1;
  }
}
// FencedCodeノード1個ぶんの「中身(フェンス記号を除いた部分)」の範囲。閉じフェンスの無い
// 未終端コードブロックは対象外(livePreviewのFencedCode処理・codeBlockAtと同じ条件)。
function fencedCodeContentRange(state, node) {
  const marks = node.getChildren("CodeMark");
  if (marks.length < 2) return null;
  const openLine = state.doc.lineAt(node.from);
  const closeLine = state.doc.lineAt(Math.max(node.from, node.to - 1));
  const contentFrom = Math.min(openLine.to + 1, state.doc.length);
  const contentTo = closeLine.number > openLine.number ? Math.max(contentFrom, closeLine.from - 1) : contentFrom;
  const infoNode = node.getChild("CodeInfo");
  const lang = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to).trim().toLowerCase() : "";
  return { from: contentFrom, to: contentTo, lang };
}
// 可視範囲(view.visibleRanges)だけを走査して色リテラルの一覧を返す(性能要件。
// 全文書を毎回正規表現で舐めない)。適用先は仕様書第1章のとおり: コードモード全体、
// Markdownモードはコードフェンスの中だけ。plainモードとMarkdown本文には適用しない。
function collectVisibleColorLiterals(view) {
  const { state } = view;
  const ctxInfo = state.field(docContextField, false) ?? { mode: "markdown", language: null };
  if (ctxInfo.mode === "plain") return [];
  const out = [];
  for (const { from, to } of view.visibleRanges) {
    if (ctxInfo.mode === "code") {
      scanColorsInRange(state, from, to, CSS_COLOR_LANGS.has(ctxInfo.language || ""), out);
    } else {
      syntaxTree(state).iterate({
        from, to,
        enter: (node) => {
          if (node.name !== "FencedCode") return;
          const range = fencedCodeContentRange(state, node.node);
          if (!range) return false;
          const scanFrom = Math.max(range.from, from), scanTo = Math.min(range.to, to);
          if (scanFrom < scanTo) scanColorsInRange(state, scanFrom, scanTo, CSS_COLOR_LANGS.has(range.lang), out);
          return false; // CodeText等の子ノードへは降りない(scanColorsInRangeで直接テキストを見るため)
        },
      });
    }
  }
  return out;
}
// 指定位置(pos)を含む色リテラルを1つ返す(右クリックメニュー・editor.getColorLiteralAtの共通実装)。
// collectVisibleColorLiteralsと違い可視範囲に縛られない(右クリック位置は常にDOM上=可視のため
// 実用上は問題ないが、意味的にも「そのpos周辺の1行/1フェンス範囲だけ」を見るので軽量)。
function colorLiteralAt(view, pos) {
  const { state } = view;
  const ctxInfo = state.field(docContextField, false) ?? { mode: "markdown", language: null };
  if (ctxInfo.mode === "plain") return null;
  if ((state.field(colorPreviewEnabledField, false) ?? true) === false) return null;
  let scanFrom, scanTo, allowNames;
  if (ctxInfo.mode === "code") {
    const line = state.doc.lineAt(pos);
    scanFrom = line.from; scanTo = line.to;
    allowNames = CSS_COLOR_LANGS.has(ctxInfo.language || "");
  } else {
    const fn = findAncestorNode(state, pos, "FencedCode");
    if (!fn) return null;
    const range = fencedCodeContentRange(state, fn);
    if (!range || pos < range.from || pos > range.to) return null; // フェンス記号・言語名の行は対象外
    const line = state.doc.lineAt(pos);
    scanFrom = Math.max(line.from, range.from);
    scanTo = Math.min(line.to, range.to);
    allowNames = CSS_COLOR_LANGS.has(range.lang);
  }
  if (scanFrom >= scanTo) return null;
  const text = state.sliceDoc(scanFrom, scanTo);
  for (const m of findColorMatches(text, allowNames)) {
    const from = scanFrom + m.from, to = scanFrom + m.to;
    if (pos < from || pos > to) continue;
    const color = parseColorLiteral(m.raw);
    if (!color) continue;
    return { from, to, text: m.raw, color };
  }
  return null;
}

const colorPreviewPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged
      || u.transactions.some((tr) => tr.effects.some((e) => e.is(setDocContext) || e.is(setColorPreviewEnabled) || e.is(themeRefreshEffect))))
      this.decorations = this.build(u.view);
  }
  build(view) {
    if ((view.state.field(colorPreviewEnabledField, false) ?? true) === false) return Decoration.none;
    const literals = collectVisibleColorLiterals(view);
    if (!literals.length) return Decoration.none;
    const bgRgb = cssVarRgb("--paper", "#ffffff");
    const inkRgb = cssVarRgb("--ink", "#000000");
    // 色文字列をキーにしたコントラスト計算のキャッシュ(仕様書 3.2)。build()の呼び出しごとに
    // 新しく作るだけで、テーマ切り替え(updateがthemeRefreshEffectで再構築)・カスタムCSS適用後の
    // 最初の再構築時には自然に古い値を持ち越さない。
    const cache = new Map();
    const marks = [];
    for (const lit of literals) {
      const parsed = parseColorLiteral(lit.raw);
      if (!parsed) continue;
      let readable = cache.get(lit.raw);
      if (!readable) { readable = readableTextColor(parsed, bgRgb, inkRgb); cache.set(lit.raw, readable); }
      const style = `color:rgb(${Math.round(readable.r)},${Math.round(readable.g)},${Math.round(readable.b)})`;
      marks.push({ from: lit.from, to: lit.to, deco: Decoration.mark({ attributes: { style } }) });
      marks.push({ from: lit.from, to: lit.from, deco: Decoration.widget({ widget: new ColorSwatchWidget(parsed), side: -1 }) });
    }
    const ranges = marks.filter((m) => m.from < m.to || m.deco.spec.widget).map((m) => m.deco.range(m.from, m.to));
    return Decoration.set(ranges, true);
  }
}, { decorations: (v) => v.decorations });

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
  // mermaidBlocksField/codeMathBlocksFieldと同じ考え方(§8.2・第8.4節)。生HTMLブロックの
  // 開始行は必ず"<"を含むため、それが挿入されず既存ブロックにも触れない変更では
  // 構文木を辿り直さない。
  update: (v, tr) => {
    if (!tr.docChanged) return v;
    return blockListNeedsRecompute(v, tr, ["<"]) ? findHtmlBlocks(tr.state) : remapBlockRanges(v, tr.changes);
  },
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
//
// 不具合5の修正: 上のコメントが書かれた本来の意図に反して、実際にはemojiCompletion
// (=autocompletion()拡張、completionStateフィールドを内部で持つ)がlivePreviewExt()経由で
// livePreviewComp(モード切替のたびreconfigureされるCompartment)に載ってしまっていた。
// CodeMirror本体(@codemirror/autocomplete)はユーザーの入力/フォーカス喪失から一定時間後に
// setTimeoutでcompletionStateを読み直す処理を持つが、その待機中にsetFileMode等で
// livePreviewComp.reconfigure([])が実行されるとcompletionStateごと消え、
// `RangeError: Field is not present in this state`が発生していた(focusFieldと同種の原因)。
// focusField同様、拡張自体は常設(buildExtensions()側)にし、代わりにmarkdownモード以外では
// このsource関数がnullを返すことで「補完候補を出さない」を実現する
// (docContextFieldも常設フィールドなので、モードに関わらず安全に参照できる)。
function emojiCompletionSource(context) {
  if ((context.state.field(docContextField, false)?.mode ?? "markdown") !== "markdown") return null;
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
// Prec.highest: 括弧・引用符の自動ペアリング(autoPairComp、closeBrackets())は"と'を
// 特別扱いして自前で先取りしてしまうため、拡張の登録順(livePreviewCompはautoPairCompより
// 後ろ)のままだとsmartQuotes="input"のときにこのハンドラへ"/'の入力が届かない。
// 明示的に最優先度にして、closeBrackets()より先にこのハンドラへ入力を渡す。
const smartTypingInputHandler = Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
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
}));

// ---- Markdown記法の自動ペア(仕様書 autoPairMarkdown) ----
// */_/~のような、1文字だけでも意味を持つ対称マーカー(*斜体*・_斜体_・~下付き~)の自動ペア。
// 既存のautoPairing(closeBrackets、括弧・引用符)とは完全に独立した仕組みにする
// (autoPairComp/closeBrackets()の対象ペアには含めず、ここで自前実装する)。
// トグルはsmartTypingInputHandlerと同じくextTogglesField経由でその都度読む(Compartmentの
// 着脱は使わない)ため、設定変更が次のキー入力から即座に反映される。
//
// "="はここに含めない(ラウンド2で見つかったバグ・データ破壊の修正)。従来は"="も同じ
// MD_PAIR_CHARSに入れており、単独の"="を1回打っただけで即座に閉じ側の"="を追加していた。
// しかし"="は"=="(ハイライト)としてのみ意味を持ち、*・_・~と違って単独の"="には
// Markdown上何の意味も無い。にもかかわらず単独入力に反応していたため、"x=1"のようなごく
// 普通の文章・URLのクエリ文字列・base64画像("...AAA=)"のようなパディング)など、"="を含む
// ほぼすべての文書がタイプするだけで壊れていた(base64の場合はパディングが崩れて画像が
// 読み込めなくなる実害を確認済み)。
//
// 「ちょうど2つ連続した"="が確定した瞬間にだけ閉じ側の"=="を足す」という様子見方式も
// 検討したが、それでも"a==b"のような、ハイライトを意図しない普通の"=="(比較演算子を
// 説明する文章・注釈・整形されたテキスト等)を打つだけで誤発火し、同じ種類のデータ破壊が
// 形を変えて残ることを確認した(調査時に実測: "a==b==c==d==e"が"abcde========"になる等)。
// "="はプログラミングやURLで極めて高頻度に単独でも連続でも現れる文字であり、"(""["のような
// 括弧類ほど「対になっている方が圧倒的に多い」とは言えないため、自動ペアの都合の良さより
// 安全側を優先し、"="の自動ペアはここでは一切行わないことにする(タイプ中の自動ペアという
// 利便性は失うが、ツールバー/ショートカットの「ハイライト」操作(applyMdAction「highlight」→
// wrapSel("==")、こちらは選択範囲を明示的に"=="で囲むだけなので誤発火しようがない)で
// "==highlight=="を挿入する経路は従来どおり使える)。
const MD_PAIR_CHARS = { "*": "*", "_": "_", "~": "~" };
const mdAutoPairInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  const toggles = view.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  if (toggles.autoPairMarkdown === false) return false;
  if (!(text in MD_PAIR_CHARS)) return false;
  if (inCodeContext(view.state, from)) return false; // コードブロック・インラインコード・数式内は対象外
  if (from === to && (text === "*" || text === "_")) {
    // 行頭(空白のみが前にある)での"*"/"_"は箇条書き記号や水平線("___"等)の書きかけの
    // 可能性が高いため自動ペアの対象から外す(選択がある場合は行頭でも囲みたい場合が普通なので除外しない)。
    const lineStart = view.state.doc.lineAt(from).from;
    if (view.state.sliceDoc(lineStart, from).trim() === "") return false;
  }
  if (from !== to) {
    // 選択範囲があれば、その前後をマーカーで囲む(closeBrackets()の選択時の挙動と同じ考え方)
    view.dispatch({
      changes: [{ from, insert: text }, { from: to, insert: text }],
      selection: { anchor: from + text.length, head: to + text.length },
      userEvent: "input.type",
    });
    return true;
  }
  const after = view.state.sliceDoc(to, to + text.length);
  if (after === text) {
    // カーソルの直後に既に同じ閉じマーカーがある → 追加せずその上を乗り越えるだけ(closeBrackets同様)
    view.dispatch({ selection: { anchor: to + text.length }, userEvent: "input.type" });
    return true;
  }
  view.dispatch({
    changes: { from, to, insert: text + MD_PAIR_CHARS[text] },
    selection: { anchor: from + text.length },
    userEvent: "input.type",
  });
  return true;
});

// ---- 既定のコード言語(仕様書 defaultCodeLanguage・defaultCodeLanguageApplyWhen="markdown"|"both") ----
// 空行で"```"だけを入力し終えた瞬間(3つ目のバッククォートを打った時点)、行頭からの入力かつ
// 直後に他の文字が無ければ、既定言語を自動で付け足す。メニューバーからの挿入(P-06相当、
// "menubar"|"both")はapplyMdActionの"codeblock"ケース側で別途扱う。
const defaultCodeLangInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "`" || from !== to) return false;
  const toggles = view.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  const lang = toggles.defaultCodeLanguage;
  if (!lang) return false;
  if (toggles.defaultCodeLanguageApplyWhen !== "markdown" && toggles.defaultCodeLanguageApplyWhen !== "both") return false;
  const line = view.state.doc.lineAt(from);
  if (from !== line.to) return false; // 行の途中への挿入は対象外
  if (line.text.slice(0, from - line.from) !== "``") return false; // ちょうど3つ目の"`"のときだけ
  view.dispatch({
    changes: { from, to, insert: "`" + lang },
    selection: { anchor: from + 1 + lang.length },
    userEvent: "input.type",
  });
  return true;
});

const markdownLanguageExt = () => markdown({ extensions: [Strikethrough, Table, Superscript, Subscript, Emoji, Autolink], codeLanguages });
// 不具合5の修正: focusField/focusNotifier/emojiCompletionはここには含めない(常設拡張として
// buildExtensions()側に移した。理由はfocusField定義部・emojiCompletionSource定義部の
// コメント参照)。
const livePreviewExt = () => [
  livePreview, tableBlocksField, tableField, tableAutoFormat,
  frontmatterField, tocParasField, tocField, extTogglesField,
  mathBlocksField, mathBlockDecoField,
  mermaidBlocksField, mermaidBlockDecoField, // Mermaid図(仕様書 第4.2節・第8.3節)
  codeMathBlocksField, codeMathBlockDecoField, // ```mathフェンス(仕様書 codeBlockMathEnabled)
  htmlBlocksField, htmlBlockDecoField, // ブロックHTML(M-27〜M-31)
  softBreaksField, softBreakDecoField, // 仕様書 whitespaceWhenWriting="ignore"
  smartTypingInputHandler, // 仕様書 smartQuotes="input"・smartDashes
  mdAutoPairInputHandler, // 仕様書 autoPairMarkdown("="は含まない。理由はMD_PAIR_CHARS定義部参照)
  defaultCodeLangInputHandler, // 仕様書 defaultCodeLanguage・defaultCodeLanguageApplyWhen="markdown"
];

// コード折りたたみ(依頼: 「Graftのようにコードをたたむ」)のキー割り当て。
// @codemirror/languageの標準foldKeymapをそのまま使うと、既定の Ctrl-Shift-[ (foldCode) と
// Ctrl-Shift-] (unfoldCode) が、Pane既存のParagraphメニューのショートカット
// Ctrl+Shift+[ (para.olist 番号付きリスト) / Ctrl+Shift+] (para.list 箇条書きリスト)と
// 衝突する(src/commands.js)。Paneのショートカットはwindowのcaptureフェーズで先に
// e.preventDefault()+e.stopPropagation()するため、標準foldKeymapのこの2つはCodeMirrorまで
// 届かず常に無効化されてしまう(実害は無いが、キーボードから畳めなくなる)。
// そのため単体の折り畳み/展開だけ Alt-[ / Alt-] に付け替える(Pane・CodeMirror標準キーマップの
// いずれにも Alt-[ / Alt-] の割り当ては無いことを確認済み)。全折りたたみ/全展開
// (Ctrl-Alt-[ / Ctrl-Alt-])は元々衝突が無いため標準どおり残す。
const foldKeymapSafe = [
  { key: "Alt-[", run: foldCode },
  { key: "Alt-]", run: unfoldCode },
  { key: "Ctrl-Alt-[", run: foldAll },
  { key: "Ctrl-Alt-]", run: unfoldAll },
];

// 折りたたみマーカー・縦線(依頼: 「マーカーと縦線をコードのすぐ左(インデント位置)へ」)。
//
// 【経緯】 当初はGraftを模して、行番号ガターの右に専用の折りたたみガター(.cm-foldGutter)を
// 設け、@codemirror/viewの低レベルAPI(gutter()・GutterMarker)で階層ごとに固定幅
// (7px)でマーカー・縦線・角(└)を積み上げて描画していた。しかしユーザーへ図を見せたところ
// (承認済みの図は.tmp配下のproposal.png/proposal.html参照)、次の2点が問題と判明した。
//   - マーカーが行番号の右の狭い領域に、階層ごとに7pxずつという実際のコードのインデント幅
//     とは無関係な間隔で並んでいた(コードの見た目上のインデントと、マーカーの横位置が
//     揃わない)。
//   - 同じ階層に対して、ガター内の太い縦線(旧cm-fold-vline)と、本文側の細いインデント
//     ガイド(下記indentGuideMarks/indentGuideTheme)の、位置がズレた2本の線が同時に
//     出ていた。
// → 承認された修正案のとおり、マーカー・縦線を「本文(.cm-content)側、その行の実際の
//   インデント位置(=行頭の空白の終端、コードが始まる直前)」へ作り直した。
//
// 【マーカーを本文側へ(依頼1)】
// CodeMirrorのガター機構(gutter()/GutterMarker)は行の左端の専用トラックにしか描けない
// ため、「コードの直前」という本文内の任意の列に置くにはガターでは実現できない。
// widget decoration(Decoration.widget、FoldOpenMarkerWidget)として本文側に実装し直した。
// 位置は「その行を含む、複数行にまたがる折りたたみ可能範囲(foldNodeProp)の、祖先方向への
// 入れ子段数」ではなく、その行自身の行頭空白の文字数(=実際にコードが始まる列)を直接使う。
// 整形されたコードでは「祖先の入れ子段数」と「行頭の空白幅」は一致するはずだが、後者を
// 直接使うほうが「コードのすぐ左」という依頼の要求(あくまで見た目上の位置)によりまっすぐ
// 対応し、タブ/スペース混在などで両者がズレた場合でも見た目のインデントに追従する。
//
// 【折りたたみ範囲の縦線を1本にする(依頼2)】
// 縦線は新設せず、既存のインデントガイド(indentGuideMarks/indentGuideTheme、後述)を
// そのまま流用する。インデントガイドは「行頭の空白の文字数ぶん、codeIndentSizeごとに
// 縦線を引く」実装のため、整形されたコードであれば構文木上のfold祖先の深さと常に同じ列に
// 一致する。「同じ位置に別の線を重ねる」のではなく、そもそも折りたたみ専用の線を
// 描かないことで、太い線・二重線の問題を根本から無くした(=線は最初から1本しか存在
// しない)。終端の「└」も専用の角要素は作らず、閉じ行(`}`など)自身のインデントが浅く
// なることでその列の縦線が自然に途切れる、という既存のインデントガイドの挙動がそのまま
// 角の役割を兼ねる。
//
// 【濃淡による強調(判断ポイント)】
// 依頼にあった「折りたたみ範囲にあたる部分だけ線をわずかに濃くする」対策案は、実際に
// 試作・スクリーンショットで見比べたうえで不採用にした。理由:
//   - 承認済みの図(修正案側、proposal.html/.v2/.png)自体が、インデントガイドをどの深さ・
//     どの範囲でも同一色(#b6bcc2)で描いており、範囲ごとに濃淡を変える表現は含まれて
//     いない。
//   - 整形されたコードでは、ある列の縦線が実際に伸びている区間は、ほぼそのままその列を
//     開いた折りたたみ範囲の区間と一致する(同じ深さの兄弟ブロックが列を共有したまま
//     連続することは稀)。マーカーの位置(範囲の開始点)と線が続く長さだけで「どこから
//     どこまでがその範囲か」は十分読み取れる。これはVSCode・Graftを含む一般的な
//     インデントガイドの読み方でもあり、範囲ごとに色を変える実装はむしろ珍しい。
//   - 実装するには、indentGuideMarksが使っている単一の反復グラデーション(全深さ共通の
//     背景画像)を行ごとの多色グラデーションへ分解する必要があり、行境界14箇所以上で
//     色距離0.00(完全連続)を実測済みの現状の実装に手を入れる分だけ、継続性を壊す
//     リスクが増える。得られる視認性向上は上記の理由でごく小さいと判断し、リスクに
//     見合わないと結論づけた。
// マーカー自体の見た目(塗り+枠+記号)は前回(依頼3)の実測済みの配色をそのまま引き継ぐ
// (var(--ink-sub)の地にvar(--paper)の記号。9テーマでコントラスト比3.0以上を確認済み。
// 検証は.verify-codefold.mjs (T)節参照)。
const FOLD_MARKER_SIZE = 15; // マーカー本体の一辺(px)。旧実装(ガター)と同じ大きさを維持。
const FOLD_MARKER_GAP = 2; // 1行に複数のマーカーが並ぶ稀なケース(例: 1行に複数ブロックが
                            // 同時に開くワンライナー)での、マーカー同士の隙間(px)。

// 1行につき1つ(稀に複数)の折りたたみマーカーを、本文側(.cm-content)にwidget decorationで
// 描画する。マーカーは行の先頭(line.from、行頭の空白より前)に挿入した幅0のアンカー要素の
// 内側に、position:absoluteで「行頭の空白の文字数ぶん」右へ寄せて配置する。widget自体は
// 幅0のためテキストの流し込み位置(=コードの開始位置)を一切動かさない(依頼「本文の文字と
// 重ならないこと」への対応。行頭の空白の上に重ねる形)。
//
// 不具合修正(実装中に発覚): 当初は横位置をCSSの`ch`単位(calc(leftCh ch - ...px))で
// 計算していたが、実測したところ深いネストほどマーカーの右端とコード開始位置の間に隙間が
// 広がってしまっていた(depth1で3.6px、depth3で10.8px)。原因はCSSの`ch`単位が「フォントの
// '0'グリフの幅」で定義されており、このコード用フォントでは半角スペース文字自身の実際の
// 表示幅と完全には一致しない(スペース1文字あたり約1.8pxのズレ)ため。文字数が増えるほど
// 誤差が積み重なっていた。対策として、CodeMirror自身が内部で使っている実測値
// view.defaultCharacterWidth(px。indentGuideMarksのview.defaultLineHeightと同じ「JSで
// 実測したpx値をインラインstyleに焼き込む」作法)に置き換え、`ch`単位を一切使わないように
// した。これによりどの深さでもマーカー右端とコード開始位置の隙間が実測0px近辺になる
// (.verify-codefold.mjs (Q)節参照)。
//
// マーカーの最終的な左端px(はみ出しクランプ込み)を計算する共通関数。FoldOpenMarkerWidget.
// toDOM()と、依頼③「fold」モードの折りたたみ縦線(foldGuideLinePlugin)の両方から呼ぶ。
// 縦線はマーカーの中心(=この関数が返す左端 + FOLD_MARKER_SIZE/2)を通るように引く(依頼②)ため、
// マーカーと縦線が同じ関数から位置を得ることで、実装を分けたことによる再度のズレ(依頼②の
// 指摘「別々の計算だとまたズレる」)を構造的に防ぐ。
// opens: [{ leftCol, stackIndex, ... }]。charWidthPx: view.defaultCharacterWidth。
// contentPaddingLeftPx: .cm-contentの実際のpadding-left(px、はみ出しクランプの下限)。
function computeMarkerLeftsPx(opens, charWidthPx, contentPaddingLeftPx) {
  // 右端がちょうど行頭空白の終端(=コードの開始位置)に揃うよう、その列(leftCol列ぶん、
  // charWidthPxで実測px化)からマーカー幅ぶん左へ引く。複数個並ぶ場合はさらに左へずらす
  // (stackIndexが大きいほど外側)。
  const rawLefts = opens.map((o) =>
    o.leftCol * charWidthPx - (FOLD_MARKER_SIZE + o.stackIndex * (FOLD_MARKER_SIZE + FOLD_MARKER_GAP)));
  // このwidget(アンカー)はline.from、すなわち行頭空白より前(=.cm-contentのpadding-left
  // の内側の起点)に置かれているため、アンカー基準のleft座標は「-contentPaddingLeftPx」で
  // ちょうど.cm-content左端(paddingの外側)に一致する。これより左には出さないことで、
  // CSS側の余白設定に関わらずマーカーが本文エリアの外へはみ出さないことを保証する
  // (実機バグ修正の保険。CSS側の余白拡張が主対策、これは二重の安全策)。
  //
  // 不具合修正(このクランプの実装中に発覚): 1行に複数マーカーが並ぶ稀なケース(例:
  // "} else {"のようなコンボ行)で、外側のマーカーほどrawLeftがより大きく負になる。
  // 各マーカーを個別にMath.maxでクランプすると、はみ出し量が異なる複数のマーカーが
  // 揃って同じクランプ後の位置へ押し付けられ、マーカー同士が重なってしまう。そのため
  // 個別クランプではなく、最も外側(=最もはみ出す)のマーカーを基準に必要なシフト量を
  // 1つだけ求め、そのwidget内の全マーカーへ同じ量だけ加える(相対位置関係=互いの
  // 間隔をそのまま保ったまま、まとめて右へずらす)。
  const minRawLeft = Math.min(...rawLefts);
  const shiftPx = minRawLeft < -contentPaddingLeftPx ? (-contentPaddingLeftPx - minRawLeft) : 0;
  return rawLefts.map((l) => l + shiftPx);
}
//
// 不具合修正2回目(実機バグ①、Windows実機での報告「Tabでインデントするとマーカーが
// コードからどんどん離れていく」): 上のleftCol(旧名leftCh)は「行頭空白の文字数」を
// そのまま列数として使っていた。半角スペースは1文字=1列で一致するため上の修正だけで
// 揃っていたが、タブ文字は1文字なのに表示上はタブ幅(既定4、codeIndentSize)ぶん進むため、
// タブでインデントした行では「文字数」が実際の表示列数より小さくなり、マーカーが
// 実際のコード開始位置よりどんどん左(タブが増えるほど大きく)にずれていた。
// 対策: 行頭空白の「文字数」ではなく「表示上の列数」を使う。@codemirror/stateの
// countColumn(text, tabSize, to)は、タブを次のタブ停止位置まで切り上げて数える公開APIで、
// CodeMirror自身が内部のインデント計算に使っているのと同じロジック。tabSizeは
// state.tabSize(EditorState.tabSizeファセット。setCodeIndentSizeが設定するのと全く同じ値)
// を使うため、インデント幅の設定と常に一致する(buildFoldOpenMarkers参照)。
class FoldOpenMarkerWidget extends WidgetType {
  // opens: [{ range, folded, leftCol, stackIndex }]
  //   leftCol: 行頭空白の表示上の列数(タブはタブ幅ぶんとして数える。マーカーの右端を
  //     揃える基準列。countColumnで算出、上の不具合修正2回目のコメント参照)。
  //   stackIndex: 同じ行に複数開く稀なケースでの重なり回避用のずらし段(0が一番右
  //     =leftColに一番近い。深いネストほど右に来るのが自然なため0=最内側)。
  // lineHeightPx: view.defaultLineHeight。既存のIndentGuideBlankWidgetと同じ、実測px値を
  //   焼き込む方式(height:100%は祖先の高さ不定で解決できないため)。
  // charWidthPx: view.defaultCharacterWidth。上記の不具合修正で追加した、1文字(1列)ぶんの実測px幅。
  // contentPaddingLeftPx: 実機不具合の修正(はみ出し対策の保険)。.cm-content の実際の
  //   padding-left(px)。マーカーはleftCol=0(インデント無し行)のとき最大
  //   FOLD_MARKER_SIZE(15px)左へはみ出す構造のため、CSS側の余白(コードモード20px/
  //   Markdownモードは--editor-padding-left、既定32px・設定で変更可能)を広げるだけでなく、
  //   実際に効いている値がマーカー幅未満でも(設定で極端に狭くされても)本文エリアの外へは
  //   絶対に出ないよう、下のtoDOM()でこの値を使ってクランプする。
  constructor(opens, lineHeightPx, charWidthPx, contentPaddingLeftPx) {
    super();
    this.opens = opens;
    this.lineHeightPx = lineHeightPx;
    this.charWidthPx = charWidthPx;
    this.contentPaddingLeftPx = contentPaddingLeftPx;
    this.key = opens.map((o) => `${o.leftCol}:${o.stackIndex}:${o.range.from}-${o.range.to}-${o.folded}`).join("|") + `@${lineHeightPx}:${charWidthPx}:${contentPaddingLeftPx}`;
  }
  eq(other) { return this.key === other.key; }
  toDOM(view) {
    const anchor = document.createElement("span");
    anchor.className = "cm-fold-open-anchor";
    anchor.style.height = `${this.lineHeightPx}px`;
    // マーカーの最終的な左端px(はみ出しクランプ込み)は、インデントガイド(「fold」モード)の
    // 縦線の中心位置と完全に同じ計算(computeMarkerLeftsPx)から求める。別々の計算式だと
    // 端数処理の違いなどでまたズレる、という実機不具合②の教訓を踏まえた設計。
    const lefts = computeMarkerLeftsPx(this.opens, this.charWidthPx, this.contentPaddingLeftPx);
    this.opens.forEach((o, i) => {
      const el = document.createElement("span");
      el.className = "cm-fold-marker2";
      el.style.left = `${lefts[i]}px`;
      // 畳まれている(folded=true)→"+"、展開中(folded=false)→"−"。U+2212(MINUS SIGN)は
      // ハイフンマイナス(-)より線が太く、"+"と字面の太さが揃って見やすいためこちらを使う
      // (旧実装から引き継ぎ)。
      el.textContent = o.folded ? "+" : "−";
      el.title = view.state.phrase(o.folded ? "Unfold line" : "Fold line");
      // CodeMirror本体がこのクリックをカーソル移動として解釈しないよう、mousedown/click
      // 双方でpreventDefault+stopPropagationする(widget自体もignoreEvent()でtrueを返し
      // CodeMirrorの既定処理からは除外しているが、DOM上の親==.cm-line経由で他のリスナーへ
      // 伝播しないための保険を重ねる)。
      el.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFoldRange(view, o.range);
      });
      anchor.appendChild(el);
    });
    return anchor;
  }
  ignoreEvent() { return true; } // CodeMirror本体の既定処理(カーソル移動等)には委ねない
}

// posの位置での祖先チェーン(foldNodePropを持ち、複数行にまたがる範囲だけ)を、外側→内側の
// 順(=そのチェーンにおける「深さ」がそのまま配列indexになる順)で返す。
// syntaxTree(state).resolveStack(pos, side)は「posを含む祖先ノードの連なり」を内側→外側の
// 順に返すAPI(@codemirror/languageのsyntaxFolding()内部実装と同じ使い方)で、木の深さに
// 比例した計算量しかかからない(文書全体は舐めない)。
function collectFoldChainAt(state, pos, side) {
  const tree = syntaxTree(state);
  // 末尾まで構文解析が終わっていない範囲は諦める(foldable()自身と同じ安全策。巨大ファイル
  // で解析が追いついていない箇所を誤った範囲で扱わないため)。
  if (tree.length < pos) return [];
  const doc = state.doc;
  const chain = [];
  for (let iter = tree.resolveStack(pos, side); iter; iter = iter.next) {
    const cur = iter.node;
    const prop = cur.type.prop(foldNodeProp);
    if (!prop) continue;
    const value = prop(cur, state);
    if (!value) continue;
    const fromLine = doc.lineAt(value.from).number;
    const toLine = doc.lineAt(value.to).number;
    if (toLine <= fromLine) continue; // 1行に収まる範囲はマーカーを立てる意味が無い
    chain.push({ from: value.from, to: value.to, fromLine, toLine });
  }
  chain.reverse(); // 外側(深さ0)→内側の順にする
  return chain;
}
// 行lineNumberで新たに開く(または「} else {」のように閉じつつ開く)折りたたみ範囲の一覧を、
// 外側(浅い)→内側(深い)の順で返す。旧実装は縦線(vline)・角(elbow)も含めて分類していたが、
// それらは今回描かなくなった(既存のインデントガイドがその役割を兼ねるため)ので、
// マーカーが必要な「開始行」だけに絞ってある。
//
// 不具合(実装中に発覚、旧実装から継承): 行の1点(例えば行末)だけをresolveStackで解決すると、
// 「} else {」のように1行の中で範囲が閉じると同時に別の範囲が開くケースを取りこぼす
// (行末で解決すると、行の途中で終わった範囲=閉じたブロックは既に祖先チェーンから
// 外れてしまっており見えない)。そのため行頭(lineFrom)・行末(lineTo)の両方で解決し、
// 突き合わせる。
function collectLineFoldOpens(state, lineFrom, lineTo, lineNumber) {
  const startChain = collectFoldChainAt(state, lineFrom, -1); // 行頭時点でまだ開いている範囲(閉じかけの範囲も含む)
  const endChain = collectFoldChainAt(state, lineTo, 1); // 行末時点で開いている範囲(この行で新規に開いた範囲も含む)
  const depth = Math.max(startChain.length, endChain.length);
  const opens = [];
  for (let d = 0; d < depth; d++) {
    const s = startChain[d];
    const e = endChain[d];
    // 行頭側・行末側のどちらかが「この行を通過中(mid-span)」の範囲を示していれば、この行
    // では何も新しく開かない(縦線はインデントガイド側が担うため、ここでは何も作らない)。
    const through = (s && s.fromLine < lineNumber && s.toLine > lineNumber) ? s
      : (e && e.fromLine < lineNumber && e.toLine > lineNumber) ? e : null;
    if (through) continue;
    if (e && e.fromLine === lineNumber) opens.push({ range: e, folded: isRangeFolded(state, e) });
  }
  return opens;
}
// 範囲rangeが現在畳まれているかどうか。@codemirror/language内部のfindFold()は非公開のため、
// 同じ考え方(その範囲の開始位置ちょうどに折りたたみ装飾があるか)をfoldedRanges()
// (公開API)で自前実装する。
function isRangeFolded(state, range) {
  let found = false;
  foldedRanges(state).between(range.from, range.from, (a) => { if (a === range.from) found = true; });
  return found;
}
// マーカークリック時の開閉トグル。foldCode/unfoldCode(標準キーマップ)と同じfoldEffect/
// unfoldEffectを使うため、キーボード操作(Alt-[/Alt-])・全折りたたみ(Ctrl-Alt-[)などと
// 状態が完全に一致する(同じfoldNodeProp計算から得た同一のfrom/toを使っているため)。
function toggleFoldRange(view, range) {
  let existing = null;
  foldedRanges(view.state).between(range.from, range.from, (a, b) => { if (a === range.from) existing = { from: a, to: b }; });
  if (existing) view.dispatch({ effects: unfoldEffect.of(existing) });
  else view.dispatch({ effects: foldEffect.of(range) });
}

// ---- 言語未設定のコードモードでのインデントベース折りたたみ(改善③) ----
// 【背景】 上のcollectFoldChainAt()はfoldNodeProp(構文木のノードに付いた折りたたみ範囲の
// 情報)を辿る作りのため、言語が未選択(またはハイライトのロードに失敗してプレーン表示に
// フォールバックした)コードモードでは構文木そのものが無く、常に0件になる(実測: 新規文書を
// コードモードのまま「function outer() {...}」などと打ってもマーカーが1個も出ない)。
// VS Codeは言語未設定でもインデントの深さだけで折りたたみを提供しており、それに倣う。
//
// 【実装方式: foldServiceを採用】 自前でチェーンを組む方式ではなく、@codemirror/language の
// foldService(Facet)を使う方式にした。理由:
//   1. foldable(state, lineStart, lineEnd)(@codemirror/language)は「foldServiceに登録した
//      関数を優先的に呼び、何も返さなければfoldNodeProp由来のsyntaxFolding()にフォール
//      バックする」という実装になっている。foldCode/unfoldCode/foldAll/unfoldAll
//      (このファイルのfoldKeymapSafe、Alt-[ / Alt-] / Ctrl-Alt-[ / Ctrl-Alt-])は内部で
//      すべてこのfoldable()を呼ぶため、foldServiceとして登録するだけでキーボード操作にも
//      追加コード無しで同じ範囲が使われる(「キーボード操作との整合」の要求をこれだけで
//      満たせる)。
//   2. 「1行につき深さごとに複数のマーカーを出す」現行のcollectFoldChainAt/
//      collectLineFoldOpens方式との両立可否を検討した: あの方式は「1行の中で複数階層が
//      同時に開く」稀な構文ケース(例: 一行に複数ブロックが並ぶ"} else {")を、resolveStack
//      で祖先チェーンを丸ごと辿って表現するためのものだが、インデントには構文木のような
//      「同じ行に複数の兄弟ブロックが同時に開く」概念が存在しない
//      (ある行が新たに開く範囲は、その行自身が開始する範囲ただ1つに限られる)。そのため
//      チェーンを辿る仕組みは不要で、1行につきfoldable()を1回呼ぶだけの単純な方式で
//      過不足なく表現できると判断し、既存の複数マーカー設計と無理なく両立させた
//      (下記buildFoldOpenMarkers内の分岐を参照。言語が有る場合は従来どおり
//      collectLineFoldOpensを使い、この関数には一切触れない)。
//   3. 登録は「言語が未設定のときだけ」codeModeExtras()から追加する(currentCodeLanguage
//      === nullの分岐)。言語が設定されている通常のコードモード・Markdownモードでは
//      一切登録しないため、foldServiceが構文木由来の結果より先に呼ばれてしまい既存挙動を
//      壊す、という心配が構造的に起こらない(そもそも登録されていない)。
//
// 【アルゴリズム】(VS Codeのインデント折りたたみプロバイダと同じ考え方)
//   - 対象行の行頭空白の文字数を「その行のインデント」とする(タブ・スペース混在は
//     厳密な列換算をせず文字数のまま比較する。大半のコードはインデント方式が
//     ファイル内で統一されているため実用上問題にならない)
//   - 対象行より後ろを1行ずつ見ていき、空白のみの行は読み飛ばしつつ、対象行より深い
//     インデントの行が続く限りその範囲に含める。対象行以下(浅い/同じ)のインデントの
//     行に当たったら、そこで打ち切る(その行自体は範囲に含めない)
//   - 空行は範囲の途中に含めてよいが、範囲の終端は「最後に見つかった対象行より深い
//     実内容行」の行末にする(=末尾の空行は範囲に含めない)
//   - 対象行の直後から数えて、対象行より深い実内容行が1行も見つからなければ
//     (何も畳めない)nullを返す
//
// 【性能への配慮】 マーカー描画(buildFoldOpenMarkers)は画面内の行(view.viewportLineBlocks、
// 通常数十行)ぶんしか本関数を呼ばないが、各行ごとに「後ろに深い行がどこまで続くか」を
// 前方走査する必要があるため、病的な入力(例: 1万行ぶん単調に字下げが深くなり続ける
// ファイル)で画面内の行すべてが数千行先まで走査してしまうと重くなりうる。
// INDENT_FOLD_SCAN_LIMITで走査行数に上限を設け、文書全体を舐めることは無いようにする
// (上限に達したらそこで打ち切り、範囲はそこまでの分だけを返す近似で構わない。折りたたみは
// あくまで表示上の便宜であり、多少範囲が実際のブロック終端より手前で切れても実害は無い)。
// 1万行での実測(変更前後の比較)は今回の対応報告を参照。
const INDENT_FOLD_SCAN_LIMIT = 500;
function leadingWhitespaceLength(text) {
  const m = /^[ \t]*/.exec(text);
  return m[0].length;
}
function indentFoldRangeForLine(state, docLine) {
  const baseIndent = leadingWhitespaceLength(docLine.text);
  if (baseIndent === docLine.text.length) return null; // 空行自身は畳めない(中身が無い)
  const doc = state.doc;
  let lastDeepLine = 0; // 最後に見つかった「対象行より深い」実内容行の行番号(0=未発見)
  const limit = Math.min(doc.lines, docLine.number + INDENT_FOLD_SCAN_LIMIT);
  for (let n = docLine.number + 1; n <= limit; n++) {
    const t = doc.line(n).text;
    if (t.trim() === "") continue; // 空行は範囲の途中に含めてよい(打ち切り判定はしない)
    if (leadingWhitespaceLength(t) <= baseIndent) break; // 対象行以下の深さに戻った→ここで終わり
    lastDeepLine = n;
  }
  if (!lastDeepLine) return null; // 深い行が1つも無かった→折りたためない
  return { from: docLine.to, to: doc.line(lastDeepLine).to };
}
// foldService(state, lineStart, lineEnd) => {from,to}|null の形。foldable()経由でfoldCode等の
// 標準コマンドから呼ばれる(上記コメント参照)。
const indentFoldService = foldService.of((state, lineStart) => indentFoldRangeForLine(state, state.doc.lineAt(lineStart)));

// ある1つのdocLineが新たに開く折りたたみ範囲の一覧を、マーカー描画に必要な位置情報
// (leftCol・stackIndex)付きで返す。buildFoldOpenMarkers(マーカー本体)と
// buildFoldGuideLines(依頼③「fold」モードの縦線)の両方から呼ぶ共通処理として切り出した
// (単一の場所に集約することで、マーカーと縦線が常に同じ列計算・同じ折りたたみ範囲判定を
// 使うことを保証する)。
// 戻り値: [{ range, folded, leftCol, stackIndex }]
//   leftCol: 行頭空白の表示上の列数(タブはタブ幅ぶんとして数える。countColumn使用。
//     実機不具合①「Tabでインデントするとマーカーがどんどん離れていく」の修正本体。
//     以前は行頭空白の「文字数」をそのまま列数として使っており、タブ文字1個を1列としか
//     数えていなかった。タブは表示上タブ幅(既定4、codeIndentSize設定と同じ
//     state.tabSize)ぶん進むため、タブでインデントした行ほどマーカーが実際のコード
//     開始位置より大きく左にずれていた)。
//   stackIndex: 同じ行に複数開く稀なケースでの重なり回避用のずらし段(FoldOpenMarkerWidget参照)。
function lineFoldOpenSpecs(state, docLine, hasLanguage) {
  let opens;
  if (hasLanguage) {
    opens = collectLineFoldOpens(state, docLine.from, docLine.to, docLine.number);
  } else {
    // 言語未設定のフォールバック(改善③)。インデントベースでは1行につき「その行自身が
    // 開始する範囲」が高々1つしか無いため、collectLineFoldOpensのような複数階層の
    // チェーン集約は不要(indentFoldRangeForLine定義部のコメント参照)。
    const range = indentFoldRangeForLine(state, docLine);
    opens = range ? [{ range, folded: isRangeFolded(state, range) }] : [];
  }
  if (opens.length === 0) return [];
  const m = /^[ \t]+/.exec(docLine.text);
  // 実機不具合①の修正: 文字数(m[0].length)ではなく、countColumnで求めた表示上の列数を使う。
  // tabSizeはstate.tabSize(EditorState.tabSizeファセット)から取得し、setCodeIndentSizeが
  // 設定する値と常に一致させる(indentGuideTheme(size)に渡す値とも同じ経路で揃っており、
  // マーカーとインデントガイドが別々のタブ幅を参照してまたズレる、という事故を防ぐ)。
  const leftCol = m ? countColumn(docLine.text, state.tabSize, m[0].length) : 0;
  return opens.map((o, i) => ({ range: o.range, folded: o.folded, leftCol, stackIndex: opens.length - 1 - i }));
}

// 表示範囲(view.viewportLineBlocksのみ。文書全体は舐めない)から、マーカーが必要な行だけの
// widget decorationを組み立てる。indentGuideMarksと同じ「viewportだけを見る」作法。
function buildFoldOpenMarkers(view) {
  const marks = [];
  const { state } = view;
  const lineHeightPx = view.defaultLineHeight;
  const charWidthPx = view.defaultCharacterWidth; // 不具合修正(上記FoldOpenMarkerWidgetの
  // コメント参照): CSSの`ch`単位は使わず、実測した1文字ぶんのpx幅を直接使う。
  // 実機不具合の修正(はみ出し対策の保険): .cm-contentの実際のpadding-leftをgetComputedStyleで
  // 実測する。コードモードの固定値(20px)・Markdownモードの--editor-padding-left変数
  // (既定32px、設定で変更可能)のどちらであっても、実際に効いている値をそのまま拾えるため、
  // 「CSS側で余白を広げる」対策とは独立に、どんな余白設定でもマーカーが本文エリアの外へ
  // 出ないことをここで保証できる(FoldOpenMarkerWidget.toDOM()のクランプ参照)。
  const contentPaddingLeftPx = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
  // 改善③: 言語(構文木)が設定されているかどうかをループの外で一度だけ判定する
  // (state.facet(language)は現在アクティブなLanguageオブジェクト、無ければnull。
  // @codemirror/languageの公開APIで、docModeComp.reconfigure()に言語のsupportが
  // 積まれているかどうかをそのまま反映する)。構文木由来の判定(collectLineFoldOpens、
  // foldNodeProp経由)は言語が有る場合に限って従来どおり使い、無い場合だけインデント
  // ベースのフォールバック(indentFoldRangeForLine、上記コメント参照)に切り替える。
  const hasLanguage = !!state.facet(language);
  for (const line of view.viewportLineBlocks) {
    // 不具合修正(旧実装から継承): 範囲が畳まれている行は、view.viewportLineBlocksの
    // BlockInfo自体が「畳まれた範囲全体(複数のソース行ぶん)」を1つの行として表す
    // (line.to が元の最終行の終端まで伸びる)。これをそのままcollectLineFoldOpens()の
    // 行末位置に使うと、本来この行が開くはずの範囲自体を見失う(畳んだ直後にマーカーが
    // 消える不具合の原因になる)。折りたたみ状態に関わらず常に同じ結果になるよう、実際の
    // 文書上の1ソース行(state.doc.lineAt())の境界だけを使う(BlockInfoの境界は使わない)。
    // これにより「折りたたんだ状態({…}表示)でもマーカーが正しい位置に出る」ことが
    // 保証される(依頼の確認項目)。
    const docLine = state.doc.lineAt(line.from);
    const specs = lineFoldOpenSpecs(state, docLine, hasLanguage);
    if (specs.length === 0) continue;
    marks.push(Decoration.widget({ widget: new FoldOpenMarkerWidget(specs, lineHeightPx, charWidthPx, contentPaddingLeftPx), side: -1 }).range(line.from));
  }
  return Decoration.set(marks, true);
}
// docChanged/viewportChanged/foldState変化/言語変化/構文木変化/geometryChanged(行の高さや
// 文字幅が変わる設定変更)のいずれかで再構築する。geometryChangedはlineHeightPx・
// charWidthPxをwidgetのkeyに含めているため見落とすとマーカーの位置が古い値のままずれる
// (indentGuideMarksと同じ
// 理由)。foldState変化はマーカークリックによる開閉そのものを検知するために必須。
//
// 不具合修正(実機バグ①のテスト実装中に発覚): setCodeIndentSize()はcodeIndentComp
// (tabSize)とcodeModeExtrasComp(このプラグイン自体を含む配列)を「2回に分けて」
// dispatchする。このプラグイン(foldOpenMarkerPlugin)はモジュール直下で1度だけ生成される
// 安定した参照のため、codeModeExtrasComp.reconfigure(codeModeExtras())が呼ばれても、
// 配列の中身に含まれるこのプラグイン自体は(同じ参照のままなら)CodeMirrorによって
// 使い回され、constructor()が再実行されない(=既存のインスタンスがそのままupdate()を
// 呼ばれ続けるだけ)。そのため、tabSize変更(state.tabSizeファセットの値変化)自体は
// 上記のどの条件にも該当せず、マーカーがタブ幅変更後も古い位置のまま固まって動かない、
// という不具合があった(実測: codeIndentSizeを4→2に変えてもマーカーが1pxも動かなかった)。
// state.tabSizeの変化を明示的に検知して対策する。
const foldOpenMarkerPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildFoldOpenMarkers(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged || update.geometryChanged ||
        update.startState.tabSize !== update.state.tabSize ||
        foldedRanges(update.startState) !== foldedRanges(update.state) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = buildFoldOpenMarkers(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

// マーカーの見た目。色はテーマのCSS変数だけを参照するため、getComputedStyleでの再構築
// なしに9テーマすべてへ自動追従する(indentGuideThemeと同じ作法)。src/style.css・
// src/themes.cssは他エージェントが編集中のため触れず、ここ(EditorView.theme())だけで
// 完結させる。配色は前回(依頼3)実測済みの組み合わせをそのまま引き継ぐ: 地=
// var(--ink-sub)、記号=var(--paper)、枠=地と同じvar(--ink-sub)(塗りと一体の「塗りつぶ
// された四角」に見えるようにする)。ホバー時はvar(--accent)に切り替え、クリックできる
// ことを伝える。実測(9テーマ、.verify-codefold.mjs (T)節参照): 記号色と地色それぞれに
// ついて、背景(コード本文の地=var(--paper)相当)とのコントラスト比が3.0以上であることを
// 確認する。
const foldOpenMarkerTheme = EditorView.theme({
  // アンカー: 幅0・高さは実測px(JSで焼き込む)のinline-block。テキストの流し込み位置を
  // 一切動かさない(依頼「本文の文字と重ならないこと」への対応)。
  ".cm-fold-open-anchor": { position: "relative", display: "inline-block", width: "0", verticalAlign: "top" },
  ".cm-fold-marker2": {
    position: "absolute", top: "50%", transform: "translateY(-50%)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: `${FOLD_MARKER_SIZE}px`,
    height: `${FOLD_MARKER_SIZE}px`,
    lineHeight: "1",
    fontSize: "12px",
    fontWeight: "800",
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    color: "var(--paper)",
    border: "1.5px solid var(--ink-sub)",
    borderRadius: "3px",
    backgroundColor: "var(--ink-sub)",
    userSelect: "none",
    cursor: "pointer",
    zIndex: "2", // インデントガイド・本文より前面に出す(重なっても読める順序)
  },
  ".cm-fold-marker2:hover": {
    color: "var(--paper)",
    borderColor: "var(--accent)",
    backgroundColor: "var(--accent)",
  },
});

// インデントガイド(縦線)。ユーザー報告「コードモードのインデントが小さすぎる」への対応の一部。
// 実測の結果、Tabキーで新たに挿入されるインデント幅(indentUnit)と、既に書かれているスペース
// インデントの見た目の幅は別物で、後者はCSS側では変えようがない(スペースは文字なのでフォントの
// 文字幅ぶんの幅を持つ)。そこで、既存のインデントの深さそのものを列単位で視覚化することで
// 「小さすぎて分かりにくい」という体感を補う。行頭の空白(スペース/タブいずれも)をmark
// decorationで囲み、CSSの `1ch`(等幅フォントの1文字ぶん)を単位にした反復グラデーションで
// codeIndentSize(=タブ幅)ごとに縦線を引く。tab-sizeもchも同じ「文字幅」を基準にしているため、
// タブ・スペースどちらのインデントでもJSで実際のpx幅を測らずに列がそろう。
// 色は新規CSSを追加せず、罫線に使っている既存の変数--rule(全テーマ定義済み・控えめな色)を
// そのまま使う。src/style.css・src/themes.cssは他エージェントが配色を作り直し中のため触れず、
// EditorView.themeで完結させる。
// なお、この行(旧: 「インデントガイドは視認性を損なうため搭載しない」)は決定済み事項として
// 一度は見送られていたが、docs/仕様書.md 11章「決定済み」では逆に
// 「コードモードの範囲：…インデントガイド・折り返し切替まで」と明記されており、実装が
// 仕様書と食い違っていた。今回のユーザー報告を機に、仕様書どおりインデントガイドを実装する
// (詳細な経緯は今回の対応報告を参照)。
//
// 不具合修正1回目(前任、ユーザー報告「インデントガイドが｜をつなげただけでチープです。
// Graftと同じくきちんと繋がった線にしてください」): 空行の区間だけガイドが完全に消える
// (mark decorationは実在する文字にしか付けられず、文字数0の空行には装飾しようがない)
// ことを主因と見て、空行だけ別経路(widget decoration)で埋める対策を入れていた。前任は
// 「拡大スクリーンショットで空行をまたいで連続していることを確認した」と報告していたが、
// ユーザーの実機では依然として途切れて見える、との再指摘を受けた。
//
// 不具合修正2回目(今回、根本から実測し直した): 前任の見立て(=空行だけが特殊)は
// 誤りで、実際には非空白行同士の間にも隙間があった。Playwrightで.cm-lineと.cm-indent-guide
// のgetBoundingClientRect()を比較したところ、次の2つの不具合が独立して存在していた。
//   (a) 非空白行のガイドは通常のmark decoration(displayが既定のinline)のため、背景の
//       描画範囲がCSSのline-height(#cm-host .cm-scroller { line-height: var(--editor-
//       line-height, 1.95) } = 実測29.25px)ではなく、フォント自体の行送り(実測18px、
//       font-size 15pxの約1.2倍=ブラウザ既定のnormal)に閉じ込められていた。inline要素の
//       背景はline-heightではなくフォントの行送りぶんしか塗られない、というCSSの仕様上の
//       性質が原因(前任はここを見落としていた=空行以外は「隙間なく繋がっている」という
//       前任の前提自体が誤りだった)。そのため、空行を挟まない普通の行同士の境目でも
//       上下それぞれ(29.25-18)/2≈5.6pxずつ、計11px前後の隙間が毎行できていた。
//   (b) 空行を埋めるIndentGuideBlankWidgetは`height: 100%`を指定していたが、
//       inline-blockのheight:100%は「明示的な高さを持つ祖先」が無いと解決できず(通常の
//       フロー内では祖先の.cm-lineはheight:autoのため基準が無い)、実測すると高さ0pxで
//       全く塗られていなかった。つまり空行をまたぐ箇所は前任の対策後もなお完全に途切れた
//       ままだった(「空行をまたいで連続していることを確認した」という前任の報告は、実際には
//       確認できていなかったことになる)。
// 対策: (a)は`.cm-indent-guide`をinline-block化しvertical-align:topにする。実測した
// ところinline-blockは中身のテキスト(行頭の空白文字)による1行ぶんのline box(=line-height
// どおりの高さ)を自動的に確保するため、height指定なしで29.25px(=行の高さそのもの)に
// ぴったり一致することを確認済み(下記(a)の実測値: guideTop/guideBottomが.cm-lineの
// lineTop/lineBottomと完全一致)。(b)は%指定をやめ、CodeMirrorが実際に測った行の高さ
// `view.defaultLineHeight`(px)をJS側で直接読み取ってインラインstyleに焼き込む
// (パーセント解決に依存しないため、editorLineHeight設定やフォントサイズ変更後も常に
// 実際の行の高さと一致する)。
class IndentGuideBlankWidget extends WidgetType {
  // chars: ガイドの列数(幅=chars*1ch)。lineHeightPx: 実際に測った行の高さ(px、
  // view.defaultLineHeightから)。両方をwidgetの同一性判定(eq)にも含める。
  constructor(chars, lineHeightPx) { super(); this.chars = chars; this.lineHeightPx = lineHeightPx; }
  eq(o) { return o.chars === this.chars && o.lineHeightPx === this.lineHeightPx; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-indent-guide cm-indent-guide-blank";
    span.style.width = `${this.chars}ch`;
    // height:100%(パーセント指定)は祖先に明示的な高さが無いため解決できず0pxになっていた
    // (不具合の実測結果、上記コメント参照)。実測したpx値を直接指定することで確実に行の
    // 高さぶん塗る。
    span.style.height = `${this.lineHeightPx}px`;
    return span;
  }
  ignoreEvent() { return true; }
}
const indentGuideMarks = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) {
    // docChanged/viewportChangedに加え、geometryChanged(フォントサイズ・行の高さ設定の
    // 変更などでレイアウト寸法が変わった場合)でも再構築する。空行埋め用widgetの高さは
    // view.defaultLineHeightを焼き込んだ値のため、行の高さが変わったのに再構築しないと
    // 古い高さのまま隙間が復活してしまう。
    if (u.docChanged || u.viewportChanged || u.geometryChanged) this.decorations = this.build(u.view);
  }
  build(view) {
    // 空行埋め用widgetに焼き込む実際の行の高さ(px)。CodeMirrorが実測したデフォルト行高で、
    // #cm-host .cm-scroller のline-height(既定1.95倍)を反映した値になる。
    const lineHeightPx = view.defaultLineHeight;
    const marks = [];
    const { state } = view;
    const doc = state.doc;
    // 空行の前後にある直近の非空白行の行頭空白幅を求めるための小さなキャッシュ・探索。
    // 空行が連続する箇所(例: 大きなコメントアウト跡)で毎回ゼロから数え直さないよう、
    // 一度求めた行の幅は使い回す。探索は上限を設け(病的に長い空行の連続への対策)、
    // 見つからなければガイド無し(0)扱いにする。
    const widthCache = new Map();
    const SCAN_CAP = 200;
    function leadingWidth(lineNo) {
      let w = widthCache.get(lineNo);
      if (w !== undefined) return w;
      const text = doc.line(lineNo).text;
      const m = /^[ \t]+/.exec(text);
      w = m ? m[0].length : (text.length === 0 ? null : 0); // null = この行自身も空行(さらに外へ探索)
      widthCache.set(lineNo, w);
      return w;
    }
    function prevNonBlankWidth(lineNo) {
      for (let n = lineNo - 1, i = 0; n >= 1 && i < SCAN_CAP; n--, i++) {
        const w = leadingWidth(n);
        if (w !== null) return w;
      }
      return 0;
    }
    function nextNonBlankWidth(lineNo) {
      for (let n = lineNo + 1, i = 0; n <= doc.lines && i < SCAN_CAP; n++, i++) {
        const w = leadingWidth(n);
        if (w !== null) return w;
      }
      return 0;
    }
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = state.doc.lineAt(pos);
        if (line.length === 0) {
          // 空行: 前後の非空白行のインデント幅のうち小さいほうをガイド幅として埋める
          const w = Math.min(prevNonBlankWidth(line.number), nextNonBlankWidth(line.number));
          if (w > 0) marks.push(Decoration.widget({ widget: new IndentGuideBlankWidget(w, lineHeightPx), side: -1 }).range(line.from));
        } else {
          const m = /^[ \t]+/.exec(line.text);
          if (m && m[0].length > 0) marks.push(Decoration.mark({ class: "cm-indent-guide" }).range(line.from, line.from + m[0].length));
        }
        if (line.to + 1 > to) break;
        pos = line.to + 1;
      }
    }
    return Decoration.set(marks, true);
  }
}, { decorations: (v) => v.decorations });
// sizeはcodeIndentSize(=タブ幅)。呼び出しのたびに現在値を焼き込んだテーマ拡張を作る
// (codeModeExtras()がsetCodeIndentSize時にも呼び直されるため、都度最新値で再生成される)。
function indentGuideTheme(size) {
  return EditorView.theme({
    // display:inline-block + vertical-align:topが今回の根本修正の核心。既定のdisplay:inline
    // のままだと、背景の描画範囲がline-height(#cm-host .cm-scroller側で設定、既定1.95倍)
    // ではなくフォント自体の行送り(既定normalで約1.2倍)に閉じ込められ、上下に隙間ができる
    // (実測: line-height由来の行の高さ29.25pxに対し、inline時の背景は18pxしか塗られず、
    // 毎行11px前後の隙間ができていた)。inline-blockにすると、中身の空白文字が作る1行ぶんの
    // line box(=line-heightどおりの高さ)がそのまま要素自身の高さになるため、height指定
    // 無しで行の高さにぴったり一致する(実測値は今回の対応報告・.verify-codefold.mjs参照)。
    // vertical-align:topは、inline-block化で発生するbaseline基準の縦位置ずれ(既定だと
    // ベースライン合わせで上下にずれ、行の上端から始まらなくなる)を防ぎ、行の最上端から
    // 塗り始めるようにする。
    ".cm-indent-guide": {
      display: "inline-block",
      verticalAlign: "top",
      backgroundImage: "linear-gradient(to right, var(--rule) 0, var(--rule) 1px, transparent 1px, transparent 100%)",
      backgroundRepeat: "repeat-x",
      backgroundSize: `calc(${size} * 1ch) 100%`,
      // 実機不具合②の修正(ユーザー要望「折りたたみマーカーの中央からガイドを出したい。
      // 現在はマーカーの右から出ている」): このmark要素の右端は常に行頭空白の終端(=コード
      // 開始位置)にちょうど一致する(実文字をmark decorationで囲んでいるだけの実測値のため、
      // 近似無しに厳密に一致する)。それがそのままマーカーの右端の位置でもある
      // (FoldOpenMarkerWidget参照)ため、反復グラデーションの縦線もそこ(ボックスの右端、
      // ちょうどbackgroundSizeの整数倍の境界)に来ていた=マーカーの右肩から線が生えて
      // 見えていた。マーカーの「中心」から出したいので、線の側をマーカー幅の半分
      // (FOLD_MARKER_SIZE/2px)だけ左へずらす。
      // 実現方法の検討: 依頼どおりbackground-positionで実現できるか検討した。
      // background-position: -Xpx 0 は「背景画像の原点をボックスの左端からX px左へ置く」
      // 指定で、repeat-xと組み合わせると画像全体(=反復する縦線群)がボックス内でX pxぶん
      // 左へシフトして見える(CSSの背景位置の定義どおり)。この要素は行ごとに幅が異なる
      // (深さによって行頭空白の長さが違う)が、どの行のボックスも「行の先頭(列0)」を
      // 左端として測っているため原点が全行で共通しており、固定pxオフセットのbackground-
      // positionを掛けても行をまたいでズレない(=採用可能と判断)。
      // 別の描き方(SVG化・複数のグラデーションレイヤーに分ける等)を検討する必要は無かった。
      backgroundPosition: `${-(FOLD_MARKER_SIZE / 2)}px 0`,
    },
    // 空行を埋めるダミーspan(IndentGuideBlankWidget)は.cm-indent-guideのクラスも併せ持つため
    // display:inline-block・vertical-align:topは上の指定がそのまま効く。高さは以前ここで
    // `height: 100%`を指定していたが、祖先(.cm-line)に明示的な高さが無いためパーセントが
    // 解決できず実測0pxになっていた(不具合の実測結果、IndentGuideBlankWidget側のコメント
    // 参照)。今はwidget生成時にJS側でview.defaultLineHeightのpx値を直接インラインstyleへ
    // 書き込むため、.cm-indent-guide-blank専用のCSSルールはもう不要になった。
  });
}

// ---- 依頼③: インデントガイドの「fold」モード(折りたたみできる範囲のみ縦線を引く) ----
// 上のindentGuideMarks/indentGuideThemeは「行頭の空白」をmark decorationで囲み、CSSの反復
// グラデーションで全ての深さに一律に縦線を引く作りのため、「特定の深さ(=折りたたみ範囲が
// ある階層)だけ」を描き分けることができない。「fold」モードではそもそも別の描き方をする:
// 折りたたみマーカーが存在する行(=何かの範囲を新たに開く行)から、その範囲の最終行まで、
// マーカーの中心を通る縦線を1本引く(折りたたみ範囲に関係ない深さには何も引かない)。
//
// 二重線を絶対に出さないための設計(ユーザー指摘「インデントガイドが2本ある」の再発防止):
// codeModeExtras()側でindentGuideMarks/indentGuideTheme(allモード用)とfoldGuideLinePlugin/
// foldGuideLineTheme(foldモード用)は排他的にしか追加しない(コード内の分岐参照)。同じ行の
// 同じ列に2つの独立した仕組みが線を描く余地が構造的に無い。
//
// マーカーとの位置合わせ: 縦線のx座標はcomputeMarkerLeftsPx(マーカー本体と全く同じ関数)
// で求めた左端にFOLD_MARKER_SIZE/2を足した「マーカーの中心」を使う。マーカー・全モードの
// ガイド・foldモードの縦線が、常に同じ列計算(lineFoldOpenSpecsのcountColumn)・同じ
// クランプ計算(computeMarkerLeftsPx)から導かれるため、実装を分けたことによる再度のズレが
// 構造的に起きない。
//
// 性能への配慮: buildFoldOpenMarkersと同様、view.viewportLineBlocks(表示範囲のみ)しか
// 見ない。ただし「表示範囲の先頭より上で開始し、まだ表示範囲まで続いている範囲」
// (=マーカー自体は画面外だが、その内側にスクロールしている状態)も連続して線を引く必要が
// あるため、表示範囲の先頭1点についてだけ祖先チェーンを辿る(collectFoldChainAt/
// indentFoldAncestorsAt。いずれも文書全体は舐めず、構文木の深さ・後方走査の上限だけに
// 比例するコストで済む)。1万行での実測は今回の対応報告(.perf-typing.mjs)を参照。

// 言語未設定時(インデントベース折りたたみ)における、lineNumber行を包んでいる(=まだ
// 閉じずに伸びている)祖先範囲のチェーンを、外側→内側の順で返す。collectFoldChainAt
// (構文木版)の役割を、インデントの深さ比較だけで代替する。lineNumberより手前を1行ずつ
// 遡り、現在追っている深さより浅い行を見つけるたびにそれを親とみなし、そこからさらに
// 浅い行を探す…を繰り返す。INDENT_FOLD_SCAN_LIMIT(indentFoldRangeForLineと共通の上限)
// まで遡ったら打ち切る(病的に深いネストが続くファイルで、表示範囲の先頭がその奥の方に
// スクロールされていても、走査行数を有限に保つ。上限に達したらそこから上の祖先は諦める
// 近似で構わない。折りたたみ・そのガイドはあくまで表示上の便宜のため)。
function indentFoldAncestorsAt(state, lineNumber) {
  const doc = state.doc;
  const chain = [];
  if (lineNumber < 1 || lineNumber > doc.lines) return chain;
  let curIndent = leadingWhitespaceLength(doc.line(lineNumber).text);
  let n = lineNumber - 1;
  let scanned = 0;
  while (n >= 1 && scanned < INDENT_FOLD_SCAN_LIMIT) {
    const line = doc.line(n);
    scanned++;
    if (line.text.trim() === "") { n--; continue; } // 空行は無視して遡る(indentFoldRangeForLineと同じ扱い)
    const indent = leadingWhitespaceLength(line.text);
    if (indent < curIndent) {
      const range = indentFoldRangeForLine(state, line);
      if (range) chain.push({ from: range.from, to: range.to, fromLine: n, toLine: doc.lineAt(range.to).number });
      curIndent = indent;
      if (curIndent === 0) break; // これ以上浅い親は無い
    }
    n--;
  }
  chain.reverse(); // 外側(浅い)→内側の順にする(collectFoldChainAtと同じ並び)
  return chain;
}

// マーカーの中心を通る縦線1本ぶんのwidget。half=true(その範囲の開始行)のときは行の下半分
// だけ(マーカーの中心から下)を、false(それ以降の行・最終行)のときは行の全高を塗る
// (依頼「マーカーの中心から下へ」を、開始行では文字どおり中心を起点にすることで表現する)。
class FoldGuideLineWidget extends WidgetType {
  constructor(leftPx, lineHeightPx, half) {
    super();
    this.leftPx = leftPx;
    this.lineHeightPx = lineHeightPx;
    this.half = half;
  }
  eq(o) { return o.leftPx === this.leftPx && o.lineHeightPx === this.lineHeightPx && o.half === this.half; }
  toDOM() {
    // FoldOpenMarkerWidgetのアンカーと同じ理由: .cm-lineは既定でposition:staticのため、
    // absolute配置の子を置くには幅0のinline-blockでposition:relativeの基準を別途作る必要がある。
    const anchor = document.createElement("span");
    anchor.className = "cm-fold-guide-anchor";
    anchor.style.height = `${this.lineHeightPx}px`;
    const line = document.createElement("span");
    line.className = "cm-fold-guide-line";
    line.style.left = `${this.leftPx}px`;
    if (this.half) {
      line.style.top = "50%";
      line.style.height = `${this.lineHeightPx / 2}px`;
    } else {
      line.style.top = "0";
      line.style.height = `${this.lineHeightPx}px`;
    }
    anchor.appendChild(line);
    return anchor;
  }
  ignoreEvent() { return true; }
}
const foldGuideLineTheme = EditorView.theme({
  ".cm-fold-guide-anchor": { position: "relative", display: "inline-block", width: "0", verticalAlign: "top" },
  ".cm-fold-guide-line": {
    position: "absolute",
    width: "1px",
    backgroundColor: "var(--rule)", // allモードの縦線(indentGuideTheme)と同じ色を使う(見た目を揃える)
    pointerEvents: "none",
    zIndex: "1", // 本文より背面、マーカー(z-index:2)より背面(マーカーが線の手前に乗って見える)
  },
});

// 表示範囲から、foldモードで引くべき縦線のwidget decorationを組み立てる。
function buildFoldGuideLines(view) {
  const { state } = view;
  const doc = state.doc;
  const blocks = view.viewportLineBlocks;
  if (blocks.length === 0) return Decoration.none;
  const lineHeightPx = view.defaultLineHeight;
  const charWidthPx = view.defaultCharacterWidth;
  const contentPaddingLeftPx = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
  const hasLanguage = !!state.facet(language);
  const firstLineNo = doc.lineAt(blocks[0].from).number;

  // active: 表示範囲に関係する(まだ畳まれていない)折りたたみ範囲の一覧。
  //   { fromLine, toLine, leftPx(px。マーカーの中心。computeMarkerLeftsPx由来) }
  const active = [];
  const seenFrom = new Set(); // range.fromで重複排除(祖先チェーンと行走査の両方で拾いうるため)
  function pushRangesOfLine(docLine) {
    const specs = lineFoldOpenSpecs(state, docLine, hasLanguage);
    if (specs.length === 0) return;
    const lefts = computeMarkerLeftsPx(specs, charWidthPx, contentPaddingLeftPx);
    specs.forEach((o, i) => {
      if (o.folded) return; // 畳まれている範囲には線を引かない(依頼の仕様どおり)
      if (seenFrom.has(o.range.from)) return;
      seenFrom.add(o.range.from);
      const toLineNo = doc.lineAt(o.range.to).number;
      active.push({ fromLine: docLine.number, toLine: toLineNo, leftPx: lefts[i] + FOLD_MARKER_SIZE / 2 });
    });
  }

  // (1) 表示範囲内で新たに開く範囲(=マーカーが実際に見えている行)
  for (const block of blocks) pushRangesOfLine(doc.lineAt(block.from));

  // (2) 表示範囲の先頭より上で開始し、まだ表示範囲まで伸びている範囲(祖先チェーン)。
  //     マーカー自体は画面外でも、線は表示範囲の途中から連続して見える必要があるため。
  const ancestors = hasLanguage
    ? collectFoldChainAt(state, doc.line(firstLineNo).from, -1)
    : indentFoldAncestorsAt(state, firstLineNo);
  for (const anc of ancestors) {
    if (anc.toLine < firstLineNo) continue; // 表示範囲に届く前に閉じている
    if (seenFrom.has(anc.from)) continue;
    if (isRangeFolded(state, anc)) continue;
    seenFrom.add(anc.from);
    const originLine = doc.line(anc.fromLine);
    const specs = lineFoldOpenSpecs(state, originLine, hasLanguage);
    const idx = specs.findIndex((o) => o.range.from === anc.from);
    if (idx < 0) continue;
    const lefts = computeMarkerLeftsPx(specs, charWidthPx, contentPaddingLeftPx);
    active.push({ fromLine: anc.fromLine, toLine: anc.toLine, leftPx: lefts[idx] + FOLD_MARKER_SIZE / 2 });
  }
  if (active.length === 0) return Decoration.none;

  // (3) 表示範囲の各行について、その行を含むactiveレンジそれぞれに1本ずつwidgetを置く。
  const marks = [];
  for (const block of blocks) {
    const docLine = doc.lineAt(block.from);
    const n = docLine.number;
    for (const a of active) {
      if (n < a.fromLine || n > a.toLine) continue;
      marks.push(Decoration.widget({
        widget: new FoldGuideLineWidget(a.leftPx, lineHeightPx, n === a.fromLine),
        side: -1,
      }).range(block.from));
    }
  }
  return Decoration.set(marks, true);
}
// foldOpenMarkerPluginと全く同じ理由(コメント参照)でtabSize変化も明示的に検知する
// (このプラグインもモジュール直下の安定参照のため、codeModeExtrasComp経由の再構成だけでは
// constructor()が再実行されない)。
const foldGuideLinePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildFoldGuideLines(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged || update.geometryChanged ||
        update.startState.tabSize !== update.state.tabSize ||
        foldedRanges(update.startState) !== foldedRanges(update.state) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = buildFoldGuideLines(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

// コードモード限定の拡張を作る本体。codeFoldingOn/codeIndentGuidesOn/codeIndentSizeValueは
// createEditor()内のインスタンス状態(タブ/ウィンドウごとに独立)のため、この関数自体は
// createEditor()の中(該当state変数の宣言以降)で定義する。ここでは仕様のメモだけ残す。
// 仕様書 決定済み事項: 行番号・括弧の対応表示・インデントガイド・折りたたみまで。
// 矩形選択・コード補完・LSP連携・エラー診断は搭載しない。
// 折りたたみマーカーは行番号の右・本文の直前に出す(依頼画像どおりGraftと同じ並び)ため、
// lineNumbers()を先に、foldGutter()を後に置く(CodeMirrorのgutter表示順は、gutter()を
// 登録した拡張の並び順に一致する)。

// 選択が無いときのコピー・切り取り(仕様書 copyWholeLineWhenNoSelection、既定true)。
// カーソル行(末尾の改行含む。最終行など次行が無ければ改行なし)を対象にする。
// 選択がある場合は何もせず(既定のコピー/切り取りに委ねるためfalseを返す)、この機能の
// 対象外(defaultCopyFormat="html"のデュアルコピー等)にも影響しない。
function wholeLineClipboardHandler(view, e, isCut) {
  const toggles = view.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  const sel = view.state.selection.main;
  if (sel.from !== sel.to) return false; // 選択があれば通常のコピー/切り取りに任せる
  if (toggles.copyWholeLineWhenNoSelection === false) {
    // CodeMirror自身が既定で持つ「選択が無ければ現在行を対象にする」コピー/切り取りの
    // 挙動を打ち消す(stopImmediatePropagationで、同じイベントに対する他のハンドラ
    // ―CodeMirror本体の既定処理―の実行自体を止める。preventDefaultだけでは
    // 別のリスナーの実行は止まらないため)。何もクリップボードへ書き込まない。
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  }
  const line = view.state.doc.lineAt(sel.head);
  const to = Math.min(view.state.doc.length, line.to + 1); // 次行があればその改行まで含める
  const text = view.state.sliceDoc(line.from, to);
  e.clipboardData?.setData("text/plain", text);
  e.preventDefault();
  e.stopImmediatePropagation();
  if (isCut) view.dispatch({ changes: { from: line.from, to }, selection: { anchor: line.from } });
  return true;
}

// 本文のフォントサイズ(px)。Ctrl+マウスホイールでMIN〜MAXの範囲を1pxずつ変更する。
export const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 40;

export function createEditor(parent, { onChange, onFocus, onBlur, onCompositionChange, onRender, onPaste, onCopy, onSelectionChange } = {}) {
  const editable = new Compartment();
  const themeComp = new Compartment();
  // Undo履歴(@codemirror/commandsのhistory())をCompartmentに載せる(ラウンド2で見つかった
  // バグ・データ破損の修正)。setValue()定義部のコメント参照。Compartmentに載せていないと
  // reconfigureで履歴フィールドを一度外して付け直す、という「履歴クリア」の定番手段が使えない。
  const historyComp = new Compartment();
  // ファイル種別ごとの編集モード切り替え(仕様書 第1章: markdown / code / plain)。
  // コード/プレーンテキストのファイルではMarkdownの言語解析とライブプレビュー装飾を外す。
  const docModeComp = new Compartment();
  const livePreviewComp = new Compartment();
  const codeModeExtrasComp = new Compartment();
  // 折り返し表示のON/OFF(仕様書 N-05)。既定はON(従来どおり)。
  const wrapComp = new Compartment();
  // 自動ペアリング(仕様書 第2.10節 C-05)のON/OFF。既定はON。
  const autoPairComp = new Compartment();
  // コードブロックのインデント幅(仕様書 codeIndentSize)。CodeMirror標準のindentUnitを
  // Compartmentで切り替える。既定は4スペース。
  const codeIndentComp = new Compartment();
  // スペルチェック(仕様書 spellCheckEnabled)。.cm-contentのspellcheck属性を切り替える。既定OFF。
  const spellCheckComp = new Compartment();
  // フォーカスモード(V-06)・タイプライターモード(V-07)のON/OFF。
  const focusModeComp = new Compartment();
  const typewriterComp = new Compartment();
  let composing = false;
  // 検索パネル(search-ui.js)の件数自動更新用の購読先(バグ2の修正)。以前は
  // search-ui.js側がStateEffect.appendConfigで自前のupdateListenerをその時点の
  // state.configにだけ追加していたため、タブ切替(setEditorState→view.setState)で
  // configが丸ごと差し替わると購読が失われていた。この配列は(state.configではなく)
  // createEditor()のクロージャに属し、EditorState/configが何度差し替わっても
  // 生き続けるため、下のbuildExtensions()内の常設updateListener(常にどのconfigにも
  // 含まれる)経由で呼べば、タブ切替をまたいでも購読が切れない。
  const docChangeListeners = new Set();
  // 不具合3の修正: 世代トークン。setFileMode/setCodeLanguageはdesc.load()の完了を待つ間に
  // (a)別のsetFileMode/setCodeLanguage呼び出しが割り込む、(b)タブ切替(setEditorState)で
  // viewの中身がまるごと差し替わる、のいずれかが起きうる。どちらの場合も、awaitから
  // 戻ってきた時点で「待機開始時にアクティブだった対象」はもう存在しないため、
  // currentMode/currentCodeLanguageの書き換えやview.dispatchを行ってはいけない
  // (書き換えると、待っている間に別タブへ切り替わった後のviewを誤って壊してしまう)。
  // setFileMode/setCodeLanguage呼び出し開始時とsetEditorState(タブ切替)実行時の両方で
  // インクリメントし、await復帰後に「開始時に取得した値のまま = 割り込みが無かった」ことを
  // 確認してから適用する。
  let modeGen = 0;
  let currentMode = "markdown";
  // コードモード時に実際に適用している言語ID(src/file-types.js の FILE_TYPES[].id と一致)。
  // ステータスバーの言語表示・言語ピッカー(仕様書 第1章の拡張)に使う。markdown/plainモードや、
  // ハイライトのロードに失敗してプレーン表示にフォールバックした場合はnull。
  let currentCodeLanguage = null;
  // 自動ペアリング(仕様書 第2.10節 C-05)。既定はON。
  let autoPairingOn = true;
  // コードブロックのインデント幅(仕様書 codeIndentSize)。indentUnit/tabSizeの再構成や、
  // インデントガイドの間隔計算にも使うため、setCodeIndentSizeが更新するたびここへも保持する。
  let codeIndentSizeValue = 4;
  // コードモードの折りたたみ(依頼: 「Graftのようにコードをたたむ」)。既定ON。
  let codeFoldingOn = true;
  // コードモードのインデントガイド(縦線)。依頼③: 3択の設定にした(既定は"fold")。
  //   "none" … 表示しない
  //   "fold" … 折りたたみできる範囲のみ(マーカーの中心から最終行まで。既定)
  //   "all"  … すべてのインデント(旧来の挙動。indentGuideMarks/indentGuideThemeを使う)
  // 旧実装は真偽値(codeIndentGuidesOn)で常時ON/OFFしか無かったが、ユーザーから
  // 「インデントごとに罫線する必要はないと考えているが設定で切り替えたほうがいいか」との
  // 意見を受け、設定項目として追加した(docs/設定項目一覧.md codeIndentGuides参照)。
  let codeIndentGuidesMode = "fold";
  // コードモード限定の拡張(仕様書 決定済み事項: 行番号・括弧の対応表示・インデントガイド・
  // 折りたたみまで。矩形選択・コード補完・LSP連携・エラー診断は搭載しない)。
  // 折りたたみマーカーは今回(依頼: マーカーと縦線をコードのすぐ左へ)、行番号ガターではなく
  // 本文(.cm-content)側にwidget decorationとして描画するため、専用のガター登録は無い
  // (lineNumbers()だけを登録する。区切り線は#cm-host .cm-gutters側のCSS(style.css、
  // 他エージェント管理)がそのまま.cm-gutters=行番号ガターの右端に出すため、以前のような
  // border-right上書きハック(旧gutterDividerTheme)も不要になった)。
  // codeFoldingOn/codeIndentGuidesMode/codeIndentSizeValueはこのcreateEditor()インスタンス
  // (ウィンドウ/タブ)ごとの状態のため、この関数自体もここ(createEditor内)で定義する。
  const codeModeExtras = () => [
    lineNumbers(),
    ...(codeFoldingOn ? [
      codeFolding(), foldOpenMarkerPlugin, foldOpenMarkerTheme, keymap.of(foldKeymapSafe),
      // 改善③: 言語が未設定(currentCodeLanguage===null。ハイライトのロードに失敗して
      // プレーン表示にフォールバックした場合も含む)のときだけ、インデントベースの
      // フォールバックfoldServiceを追加する(indentFoldService定義部のコメント参照)。
      // 言語が設定されている通常のコードモードでは登録しない=既存の構文木ベースの
      // 折りたたみ(foldNodeProp)を一切妨げない。
      ...(currentCodeLanguage === null ? [indentFoldService] : []),
    ] : []),
    bracketMatching(),
    // 依頼③: allとfoldは排他(=二重線が出ないよう、どちらか一方だけを追加する)。
    // foldモードはcodeFoldingOnも条件に含める: 折りたたみ機能自体がOFFのときに
    // 「マーカーの無い縦線」だけが残るのは見た目上不自然なため(マーカーが1つも出ないのに
    // 縦線だけ生える状態を避ける)。
    ...(codeIndentGuidesMode === "all" ? [indentGuideMarks, indentGuideTheme(codeIndentSizeValue)] : []),
    ...(codeIndentGuidesMode === "fold" && codeFoldingOn ? [foldGuideLinePlugin, foldGuideLineTheme] : []),
  ];
  // ソースコードモード(仕様書 V-05): 記法マーカーを隠さない生表示。docModeComp(構文ハイライト)は
  // 外さず、livePreviewComp(装飾・マーカー非表示)だけを空にすることで実現する。markdownモード
  // かつsourceMode===falseの時だけライブプレビューを入れる、という条件はsetFileMode/setSourceMode
  // 双方から参照する内部状態としてここに持つ。
  let sourceMode = false;
  // 現在開いているカラーピッカーパネル(不具合2の修正)。openColorPicker()が呼ばれるたびに
  // { forceApplyAndClose() } を差し替えて保持する。同時に2つ目のopenColorPicker()が呼ばれた
  // 場合、こちらを使って前のパネルを閉じてから新しいパネルを開く(1つのeditorインスタンスに
  // つき色ピッカーパネルは常に高々1枚、という不変条件を保つ)。詳細はopenColorPicker側のコメント参照。
  let activeColorPicker = null;
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
      // 仕様書 typewriterKeepCaretCentered: falseなら常に中央固定はせず、画面内に収まる
      // 範囲でのみスクロールする("nearest": 既に見えていれば動かない)。
      const toggles = u.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
      const y = toggles.typewriterKeepCaretCentered === false ? "nearest" : "center";
      u.view.dispatch({ effects: EditorView.scrollIntoView(u.state.selection.main.head, { y }) });
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

  // タブ形式(仕様書 第2.10節 C-14、隠し設定)用: view構築時に使うextensionsの一覧を
  // 関数として持っておく。CompartmentのofはEditorState.create()の呼び出し時点での
  // クロージャ変数(autoPairingOn/spellCheck等)を評価するため、関数化しておけば
  // createFreshState()が呼ばれるたびに「その時点のアプリ全体設定」を反映した新規タブ用の
  // EditorStateを作れる(タブ切替でCompartmentの構成そのものを含めstateごと入れ替わるため、
  // 新規タブもここで一度だけ現在の設定を継承すれば以後は個別に切り替わっていく)。
  function buildExtensions() {
    return [
        historyComp.of(history()),
        // 引用・リストの空行でEnter2回で抜けられるようにする(ラウンド2の追加依頼、
        // handleEnterExitEmptyMarkup定義部のコメント参照)。@codemirror/lang-markdownの
        // 標準Enter処理はmarkdownLanguageExt()内でPrec.highのkeymapとして登録されるため、
        // それより先に評価されるようPrec.highestにする。対象を「マーカーだけで中身が
        // 空の行」に厳密に絞ってあり、それ以外は必ずfalseを返して素通しする(下のkeymap.of
        // 内のEnterバインディング・ライブラリ側のEnter処理へそのまま委ねる)ため、通常の
        // リスト継続・番号の繰り上げ・チェックボックスの継続には一切影響しない。
        // ソースコードモード(sourceMode)でもdocModeComp自体は変わらない(構文木は生きている)
        // ため、livePreviewComp配下ではなくここ(常設)に置く。
        Prec.highest(keymap.of([{ key: "Enter", run: (v) => (v.composing ? false : handleEnterExitEmptyMarkup(v)) }])),
        keymap.of([
          // Shift+Enterのソフトブレーク(仕様書 M-01)はEnter(リスト継続のhandleEnter)より
          // 先に評価する必要があるため先頭に置く(配列の先頭ほど優先。実際にはキー文字列が
          // "Shift-Enter"と"Enter"で別物のため衝突はしないが、指示どおり優先順位を明示する)。
          // IME変換中の確定Enterで誤発火しないよう、view.composingがtrueの間は既定動作に委ねる(falseを返す)。
          { key: "Shift-Enter", run: (v) => (v.composing ? false : insertSoftBreak(v)) },
          // 不具合Bの修正: 表の中でのTab/Shift-Tab(セル間移動)・Enter(最終セルでの行追加)は
          // handleTableKey()として実装済み(editor.tableKeyとしてAPI公開もされている)だったが、
          // 実際にキー入力へ配線する箇所がどこにも無く(配線漏れ)、Ctrl+Tで表を挿入して
          // セルにTabを押すと、セル移動せずindentWithTab(通常のインデント挿入)が代わりに
          // 実行され、以降の入力が最初のセルへ積み重なって表が壊れていた(Enterも同様に、
          // 表の最終セルでの行追加が起きず、handleEnter任せの素の改行になっていた)。
          // ここでCodeMirrorのキーマップとして配線する。表の外ではtableAt()がnullを返して
          // handleTableKey()がfalseを返すので、そのままEnterは従来どおりhandleEnter
          // (リスト継続等)に、Tab/Shift-Tabは後続のバインディング(下のカスタムShift-Tab→
          // indentWithTab)に委ねられ、表の外での既存のEnter/Tab/Shift-Tabの挙動
          // (インデント含む)は変えない。handleEnter・indentWithTab・直後のカスタム
          // Shift-Tabエントリ(shiftTabAutoIndent設定)のいずれよりも先に評価されるよう、
          // 配列の先頭(Shift-Enterの直後)に置く。
          // handleTableKey側が自前でisComposing中は何もしない(!ev.isComposing)ようになって
          // いるため、ここでは素通しでよい(表の外・IME変換中は従来どおりhandleEnter任せになる)。
          { key: "Enter", run: (v) => handleTableKey(v, { key: "Enter", shiftKey: false, isComposing: v.composing }) || handleEnter(v) },
          { key: "Tab", run: (v) => handleTableKey(v, { key: "Tab", shiftKey: false, isComposing: v.composing }) },
          { key: "Shift-Tab", run: (v) => handleTableKey(v, { key: "Tab", shiftKey: true, isComposing: v.composing }) },
          // 仕様書 shiftTabAutoIndent: falseならShift+Tabはアウトデント(indentLess、既定の
          // indentWithTabと同じ挙動)、trueなら自動インデント(indentSelection)にする。
          // indentWithTab自体もshift:indentLessでShift-Tabを扱うため、それより先に評価される
          // よう配列の前に置く(先勝ちで、この設定を反映したこのエントリが優先される)。
          {
            key: "Shift-Tab", run: (v) => {
              const auto = (v.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES).shiftTabAutoIndent;
              return auto ? indentSelection(v) : indentLess(v);
            },
          },
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
        // コードブロックのインデント幅(仕様書 codeIndentSize)。既定4。indentUnit(Tabキーで
        // 新たに挿入するスペースの数)に加えて、EditorState.tabSize(タブ文字1個の表示幅)も
        // 同じ値に連動させる。以前はtabSizeの指定が無くCodeMirror既定の4に固定されており、
        // タブ文字でインデントされたファイルはcodeIndentSizeをいくつに変えても表示幅が
        // 変わらなかった(実測で確認済み。詳細は今回の対応報告を参照)。
        // なお、この設定はあくまで「タブキーで新規入力する幅」と「タブ文字の表示幅」を
        // 揃えるものであり、スペースで既に書かれているインデントの見た目の幅までは変えられない
        // (スペースは文字なのでフォントの文字幅ぶんの幅を持つ。CSSでは伸縮できない)。
        codeIndentComp.of([indentUnit.of("    "), EditorState.tabSize.of(4)]),
        // スペルチェック(仕様書 spellCheckEnabled)。既定OFF。
        spellCheckComp.of(EditorView.contentAttributes.of({ spellcheck: "false" })),
        livePreviewComp.of(livePreviewExt()),
        codeModeExtrasComp.of([]),
        // コード中のカラープレビュー(docs/カラープレビュー仕様.md)。docModeComp/livePreviewComp
        // のようにモードで丸ごと入れ替わるCompartmentには載せない(常設。モード判定自体は
        // colorPreviewPlugin内でdocContextFieldを見て行う)。
        docContextField, colorPreviewEnabledField, colorPickerHighlightField, colorPreviewPlugin,
        // フォーカス状態(不具合5の修正: focusField定義部のコメント参照)。モードに関わらず
        // 常に存在させる必要があるため、livePreviewComp(モード切替のたびreconfigureされる
        // Compartment)には載せず、ここに常設で置く。
        focusField, focusNotifier,
        // 絵文字ショートコード補完(不具合5の修正: emojiCompletionSource定義部のコメント参照)。
        // completionStateフィールドがモード切替のたびに消えないよう常設にし、
        // markdownモード以外での候補表示はsource関数側(emojiCompletionSource)で抑止する。
        emojiCompletion,
        focusModeComp.of([]),
        typewriterComp.of([]),
        editable.of(EditorView.editable.of(true)),
        search({ top: false }),
        EditorView.updateListener.of((u) => {
          // 実機不具合の修正(main.jsのダーティ判定見直しに伴う性能改善): 呼び出し側(main.js)は
          // 引数を使っておらず、view.state.doc.toString()は1万行規模の文書で毎回の入力時に
          // 文書全体を文字列化する無駄なコストになっていたため引数を渡すのをやめる。
          // 本文の文字列が必要な呼び出し元はeditor.getValue()を都度呼ぶこと。
          if (u.docChanged && onChange) onChange();
          // 検索パネルの件数自動更新(バグ2の修正)。この常設リスナーはbuildExtensions()の
          // 戻り値としてどのEditorState(=どのタブ)にも常に含まれるため、docChangeListeners
          // に登録した購読者はタブ切替をまたいでも呼ばれ続ける。
          if (u.docChanged && docChangeListeners.size) for (const fn of docChangeListeners) fn(u);
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
          // 選択が無いときのコピー(仕様書 copyWholeLineWhenNoSelection、既定true)はカーソル行
          // 全体を対象にする。既定のコピーは選択が無ければ何もコピーしないため、これより先に
          // 判定する必要がある。
          copy: (e) => {
            if (wholeLineClipboardHandler(view, e, false)) return true;
            if (onCopy && onCopy(e)) { e.preventDefault(); return true; }
            return false;
          },
          // 選択が無いときの切り取り(仕様書 copyWholeLineWhenNoSelection)。行全体をクリップボードへ
          // コピーしたうえで、その行(末尾の改行含む)をドキュメントから削除する。
          cut: (e) => wholeLineClipboardHandler(view, e, true),
          // リンク装飾のタップでリンク先を開く(mousedownで先取りしてカーソル移動を抑止)。
          // 内部アンカー(#見出し)はCtrl/Cmd+クリック時のみジャンプする(仕様書 M-15)。
          // 右クリック(e.button!==0)はここで反応しない。反応すると右クリックのたびに
          // 外部リンク確認ダイアログが開いてしまい、直後のcontextmenuイベントのe.targetが
          // そのダイアログに奪われて右クリックメニュー(docs/コンテキストメニュー仕様.md)の
          // 文脈判定(リンクの上かどうか)を妨げてしまう。
          mousedown: (e) => {
            if (e.button !== 0) return false;
            const el = e.target?.closest?.(".tok-link[data-href]");
            if (!el) return false;
            e.preventDefault();
            openOrJumpLink(view, el.getAttribute("data-href") || "", e.ctrlKey || e.metaKey);
            return true;
          },
        }),
        themeComp.of(makeTheme()),
    ];
  }

  // setValue()専用: 文書を丸ごと差し替えつつ、Undo履歴だけは新規にする(下のsetValue定義部の
  // コメント参照)。当初はview.dispatch()でhistoryComp(Compartment)をreconfigure([])→
  // reconfigure(history())と2段階で切り替えていたが、実機不具合調査(ラウンド2)の過程で、
  // 「極端に深い(60,000段)ネストのHTMLを一度でも処理した直後に、どのCompartmentであれ
  // 1回でもreconfigureすると、以降その状態の構文木(@lezer/markdown)がブロック要素
  // (生HTMLブロック等)を正しく検出できなくなる」という、CodeMirrorの増分パースに関する
  // 別の不具合(このアプリのコードの外、ライブラリ側の相互作用によるもの)を新たに引き当てて
  // しまうことが発覚した(検証用スクリプトで再現・原因を特定済み。詳細は今回の対応報告参照)。
  // 60,000段ネストのような極端な入力は稀だが、「setValue()を呼ぶたびに何かをreconfigureする」
  // という設計そのものがこの地雷を踏みやすくするため、Compartmentのreconfigureは一切使わず、
  // view.setState()による全面差し替え(タブ切替と同じ方式。タブ切替でCtrl+Zが前のタブへ
  // 漏れないのと同じ理屈でUndo履歴が自然に空になる)に切り替える。
  // ただし全面差し替えは「その時点のアプリ全体設定」で作り直したbuildExtensions()を使うため、
  // 何もしなければモード(Markdown/コード/プレーン)やマークダウン記法トグル等、直前まで
  // 設定されていた値が既定値へ巻き戻ってしまう(buildExtensions()はdocModeComp等を常に
  // 既定のMarkdownモードで組み立てるため)。setValue()の呼び出し元(main.js)は必ず
  // editor.setFileMode(...)を先に呼んでからsetValue()を呼ぶ設計になっており、その結果
  // (どのCompartmentに何が設定されたか)を失ってはいけない。そのため:
  //   ・Compartmentの現在値はCompartment.get(state)で読み取り、そのままof()し直す
  //     (historyCompだけは対象から外し、常に新しいhistory()にする=これが履歴クリアの本体)。
  //   ・Compartmentではなく素のStateFieldにStateEffectで設定されている値
  //     (extTogglesField・colorPreviewEnabledField・docContextField。いずれも「文書の内容から
  //     導出される」のではなく「アプリ設定/ファイルの種別として外から注入される」値)は、
  //     buildExtensions()の既定値のままだと巻き戻ってしまうため、setState()の直後に
  //     同じ値を効果(StateEffect)として再度dispatchして復元する(これはCompartmentの
  //     reconfigureではない普通のdispatchなので、上記の不具合を踏まない)。
  const PRESERVED_COMPARTMENTS = [
    editable, themeComp, docModeComp, livePreviewComp, codeModeExtrasComp,
    wrapComp, autoPairComp, codeIndentComp, spellCheckComp, focusModeComp, typewriterComp,
  ]; // historyCompは意図的に含めない(常に新しいhistory()にする=履歴クリアの本体)。
  function buildExtensionsForSetValue(prevState) {
    return buildExtensions().map((item) => {
      const comp = item?.compartment;
      if (comp && PRESERVED_COMPARTMENTS.includes(comp)) {
        const current = comp.get(prevState);
        if (current !== undefined) return comp.of(current);
      }
      return item;
    });
  }

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: buildExtensions(),
    }),
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    // 新規文書・別ファイルを開く・ドラッグ&ドロップで別ファイルを開く等、「文書そのものが
    // 入れ替わる」ときに本文を丸ごと差し替える入口(main.jsのsetEditorValueQuiet経由でのみ
    // 呼ばれる)。Undo履歴も明示的にクリアする(ラウンド2で見つかったバグ・データ破損の修正)。
    // 従来はここが単なる「本文を丸ごと差し替えるだけの、履歴上は普通の1回の変更」として
    // 実装されており、Undo履歴をクリアしていなかった。そのため、モード切替(表示メニューで
    // コードモード⇔Markdownモードを行き来する操作。setFileMode参照)を挟んだ後に新規作成や
    // 別ファイルを開いてから数文字入力してCtrl+Zを繰り返すと、この「文書の入れ替わり」の
    // 境界を飛び越えて前の(無関係な)文書の内容が復元されてしまっていた(実機再現・
    // 保存すればデータ破損に直結する不具合として報告された)。
    // 履歴のクリアはview.setState()による全面差し替えで行う(buildExtensionsForSetValue定義部の
    // コメント参照。Compartmentのreconfigureは、極端に深いネストのHTMLを処理した直後に限って
    // 構文木の検出を壊す別の不具合を踏むことが分かったため、あえて避けている)。
    // タブ切替(setEditorState)と同様、待機中のsetFileMode/setCodeLanguageが後から古い結果を
    // 適用してしまわないようmodeGenも進めておく。
    setValue: (text) => {
      modeGen++;
      const prevState = view.state;
      // Compartmentではなく素のStateFieldにStateEffectで設定されている値(アプリ設定/
      // ファイル種別として外から注入され、文書の内容そのものからは導出されない値)は、
      // buildExtensions()の既定値のままだと巻き戻ってしまうため、先に読み取っておいて
      // setState()の後で同じ値を再度効果として当て直す。
      const prevExtToggles = prevState.field(extTogglesField, false);
      const prevColorPreviewEnabled = prevState.field(colorPreviewEnabledField, false);
      const prevDocContext = prevState.field(docContextField, false);
      view.setState(EditorState.create({
        doc: text || "",
        selection: { anchor: 0 },
        extensions: buildExtensionsForSetValue(prevState),
      }));
      const restoreEffects = [];
      if (prevExtToggles !== undefined) restoreEffects.push(setExtToggles.of(prevExtToggles));
      if (prevColorPreviewEnabled !== undefined) restoreEffects.push(setColorPreviewEnabled.of(prevColorPreviewEnabled));
      if (prevDocContext !== undefined) restoreEffects.push(setDocContext.of(prevDocContext));
      if (restoreEffects.length) view.dispatch({ effects: restoreEffects });
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
    // 戻り値: 実際に適用できたか(true)、待機中に別の呼び出し/タブ切替に割り込まれ
    // 何もしなかったか(false)。呼び出し側(main.js)が「自分の結果はもう有効か」を
    // 判断する材料として使う(不具合3・4の修正)。
    setFileMode: async (filename, forceMode) => {
      const myGen = ++modeGen; // この呼び出し自身の世代を確保
      const mode = forceMode || resolveFileMode(filename);
      if (mode === "markdown") {
        // ここまで await を挟んでいないため myGen は必ず最新(割り込みは起こり得ない)。
        currentMode = mode;
        currentCodeLanguage = null;
        view.dispatch({
          effects: [
            docModeComp.reconfigure(markdownLanguageExt()),
            // ソースコードモード(V-05)中は記法を隠さない生表示のままにする(sourceMode参照)。
            livePreviewComp.reconfigure(sourceMode ? [] : livePreviewExt()),
            codeModeExtrasComp.reconfigure([]),
            setDocContext.of({ mode: "markdown", language: null }), // カラープレビュー(docs/カラープレビュー仕様.md)用
          ],
        });
        return true;
      }
      if (mode === "code") {
        const desc = LanguageDescription.matchFilename(codeLanguages, filename || "");
        let support = null;
        try {
          support = desc ? await desc.load() : null; // ここで他の呼び出し/タブ切替が割り込みうる
        } catch {
          support = null; // 未対応/ロード失敗時はプレーン表示にフォールバックする
        }
        if (myGen !== modeGen) return false; // 待っている間に割り込まれた → この結果はもう適用しない
        currentMode = mode;
        currentCodeLanguage = support ? desc.name : null;
        view.dispatch({
          effects: [
            docModeComp.reconfigure(support ? [support] : []),
            livePreviewComp.reconfigure([]),
            codeModeExtrasComp.reconfigure(codeModeExtras()),
            setDocContext.of({ mode: "code", language: currentCodeLanguage }), // カラープレビュー用
          ],
        });
        return true;
      }
      // plain(await を挟まないため割り込みの心配はない)
      currentMode = mode;
      currentCodeLanguage = null;
      view.dispatch({
        effects: [
          docModeComp.reconfigure([]),
          livePreviewComp.reconfigure([]),
          codeModeExtrasComp.reconfigure([]),
          setDocContext.of({ mode: "plain", language: null }), // カラープレビュー用(plainには適用しない)
        ],
      });
      return true;
    },
    // 拡張子ではなく言語IDを直接指定してコードモードにする(仕様書 第1章の拡張: 内容からの
    // 自動判定・ステータスバーの言語ピッカーから使う)。setFileMode(code分岐)と同じ流儀
    // (LanguageDescription.matchFilename → desc.load() → docModeComp.reconfigure)を、
    // ファイル名でなく言語IDでの一致に置き換えただけ。ロード失敗時はプレーン表示に
    // フォールバックする作法も同じ。
    // 戻り値はsetFileModeと同じ意味(不具合3の修正)。
    setCodeLanguage: async (languageId) => {
      const myGen = ++modeGen;
      const desc = codeLanguages.find((d) => d.name === languageId) || null;
      let support = null;
      try {
        support = desc ? await desc.load() : null; // ここで他の呼び出し/タブ切替が割り込みうる
      } catch {
        support = null; // 未対応/ロード失敗時はプレーン表示にフォールバックする
      }
      if (myGen !== modeGen) return false; // 待っている間に割り込まれた → この結果はもう適用しない
      currentMode = "code";
      currentCodeLanguage = support ? desc.name : null;
      view.dispatch({
        effects: [
          docModeComp.reconfigure(support ? [support] : []),
          livePreviewComp.reconfigure([]),
          codeModeExtrasComp.reconfigure(codeModeExtras()),
          setDocContext.of({ mode: "code", language: currentCodeLanguage }), // カラープレビュー用
        ],
      });
      return true;
    },
    // 現在コードモードで適用している言語ID。markdown/plainモード時、またはハイライトの
    // ロードに失敗しプレーン表示へフォールバックした場合はnull。
    getCodeLanguage: () => currentCodeLanguage,
    // ---- コード中のカラープレビュー・カラーピッカー(docs/カラープレビュー仕様.md) ----
    // colorPreviewInCode設定(既定true)。main.js側のapply-settings配線から呼ばれる想定
    // (現状は本APIを公開するところまでで、main.jsへの実配線は別エージェントが行う。
    // 報告の「main.jsに必要な変更」参照)。
    setColorPreviewInCode: (on) => view.dispatch({ effects: setColorPreviewEnabled.of(on !== false) }),
    isColorPreviewInCode: () => view.state.field(colorPreviewEnabledField, false) ?? true,
    // 指定位置(ドキュメント座標)を含む色リテラルを返す(無ければnull)。
    // { from, to, text, color: {r,g,b,a,notation} }。右クリックメニューの文脈判定
    // (「色を変更…」の表示条件)・検証スクリプトの両方から使う共通の入口。
    getColorLiteralAt: (pos) => colorLiteralAt(view, pos),
    // 右クリックメニュー「色を変更…」から呼ぶ想定のカラーピッカー起動(仕様書 第4章)。
    // from/to/colorTextはgetColorLiteralAt(pos)が返したものをそのまま渡す。
    openColorPicker: (from, to, colorText) => {
      const parsed = parseColorLiteral(colorText);
      if (!parsed) return false;
      // 不具合2の修正: パネルを閉じずに別の色リテラルでopenColorPicker()を呼ぶと、呼び出しごとに
      // 独立したクロージャ(ended/panelHandle)が作られ、前回のパネルを閉じる処理が無かったため
      // .color-picker-panel が2枚同時にDOMへ残っていた。activeColorPicker(createEditor内で
      // 保持する、このeditorインスタンスに1つだけの参照)に前回分が残っていれば、新しいパネルを
      // 開く前にまずそれを閉じる。「別のリテラルをクリックした」は「パネルの外をクリックした」の
      // 一種とみなせるため、閉じ方はdocs/カラープレビュー仕様.md 第4.3節にある外側クリックと同じ
      // 「確定して閉じる(適用扱い)」に揃える(forceApplyAndCloseの実装は下記)。
      if (activeColorPicker) {
        activeColorPicker.forceApplyAndClose();
        activeColorPicker = null;
      }
      const rFrom = view.coordsAtPos(from);
      const rTo = view.coordsAtPos(Math.max(from, to - 1), -1);
      if (!rFrom || !rTo) return false;
      const anchorRect = {
        left: Math.min(rFrom.left, rTo.left), right: Math.max(rFrom.right, rTo.right),
        top: Math.min(rFrom.top, rTo.top), bottom: Math.max(rFrom.bottom, rTo.bottom),
      };
      const hasAlpha = (parsed.notation.kind === "hex" && (parsed.notation.hexLen === 4 || parsed.notation.hexLen === 8))
        || (parsed.notation.kind !== "hex" && parsed.notation.kind !== "name" && !!parsed.notation.hasAlpha);
      view.dispatch({ effects: setColorPickerHighlight.of({ from, to }) });
      // 不具合1の修正: 以前はcurFrom/curTo(パネルを開いた時点の座標)をJS側のクロージャ変数として
      // 保持し、そのまま書き込み先に使っていた。パネルを開いたまま別の場所で編集(例: 先頭への
      // 行挿入)が起きても、この座標は追従せず、書き込み位置がズレて文書を壊していた。
      // colorPickerHighlightField(枠線ハイライト用に既にmapPosで追従させているStateField)を
      // 対象範囲の唯一の情報源として使い回すことで、パネルを開いた後に起きた任意の変更
      // (自分の書き込みも他の編集も区別せず)に追従させる。
      let ended = false; // finish()/対象消失時の後始末の二重実行防止
      let panelHandle = null; // openColorPickerPanelの戻り値。対象消失時に強制クローズするのに使う
      // 不具合2の修正: このopenColorPicker呼び出し1回分を指す目印。activeColorPickerが
      // まさにこの呼び出しを指しているかどうかを、abandon/finish側で確認するのに使う
      // (「今closeしようとしているのは本当に自分自身か」を厳密にするための単純な参照比較用)。
      const thisPicker = {};
      // 対象範囲の「今」の位置を返す。範囲が編集で潰れている、またはそこにある文字列が
      // もはや色リテラルとして解釈できない場合はnull(=対象が壊れたとみなす)。
      const currentTarget = () => {
        const r = view.state.field(colorPickerHighlightField, false);
        if (!r || r.from >= r.to || r.to > view.state.doc.length) return null;
        if (!parseColorLiteral(view.state.sliceDoc(r.from, r.to))) return null;
        return r;
      };
      // 対象が編集で失われた場合の後始末: それ以上書き込まず、ハイライトを消して
      // (onCancel/onCommitを呼ばずに)パネルを強制的に閉じる。
      const abandon = () => {
        if (ended) return;
        ended = true;
        if (activeColorPicker === thisPicker) activeColorPicker = null; // 不具合2の修正: 参照を掃除する
        view.dispatch({ effects: setColorPickerHighlight.of(null) });
        if (panelHandle) panelHandle.close();
      };
      const writeLive = (text) => {
        if (ended) return;
        const target = currentTarget();
        if (!target) { abandon(); return; } // 対象が消えた/色リテラルでなくなった → これ以上書き込まない
        view.dispatch({
          changes: { from: target.from, to: target.to, insert: text },
          annotations: Transaction.addToHistory.of(false), // 仕様書 4.3: 中間状態はアンドゥ履歴に積まない
        });
      };
      // ドラッグ中の中間状態はいずれもaddToHistory:falseで書き換えるだけ(履歴に一切残らない)。
      // そのため確定時、そのまま閉じただけでは「開いた時の色→最終的な色」の変更が履歴のどこにも
      // 記録されない(pressing undoが無関係な直前の編集を巻き戻してしまう)。これを避けるため、
      // 確定の瞬間だけ (1)一旦「開いた時の色」へ無履歴で戻す → (2)そこから最終色への変更を
      // 通常の(履歴に残る)1回のトランザクションとして発行する、という2段階にする。
      // (2)の時点でのtr.startState.docは(1)により既に「開いた時の色」に戻っているため、
      // その差分だけが正しく1回分のアンドゥ対象になる。
      // (不具合1の修正)from/toの代わりに、この瞬間のcurrentTarget()を使う。対象が既に
      // 失われていれば何も書き込まずパネルを閉じるだけにする。
      const finish = (finalText) => {
        if (ended) return;
        ended = true;
        if (activeColorPicker === thisPicker) activeColorPicker = null; // 不具合2の修正: 参照を掃除する
        const target = currentTarget();
        if (target) {
          view.dispatch({
            changes: { from: target.from, to: target.to, insert: colorText },
            annotations: Transaction.addToHistory.of(false), // (1) 無履歴でいったん元へ戻す
          });
          if (finalText !== colorText) {
            // (2) 履歴に残る1回の変更。userEventは既定の"input.type"系の結合対象外にする
            // (直前の無関係な入力と同じグループへ自動結合され、アンドゥが1色ぶんを超えて
            // 巻き戻ってしまうのを防ぐ。CodeMirrorの履歴結合はuserEvent未指定/"input.type"系だと
            // 位置が隣接していれば直前のイベントへ自動的に結合されるため)。
            view.dispatch({ changes: { from: target.from, to: target.from + colorText.length, insert: finalText }, userEvent: "input.colorPicker" });
          }
        }
        view.dispatch({ effects: setColorPickerHighlight.of(null) });
        view.focus();
      };
      // 不具合2の修正: 「新しいパネルを開くとき、既に開いているパネルを閉じる」ための唯一の
      // 入口。docs/カラープレビュー仕様.md 第4.3節「パネルの外をクリックした場合は確定して
      // 閉じる(適用扱い)」に揃え、外側クリック(color-picker-panel.js側のonDocMouseDown→commit()→
      // onCommit)と同じ「現在の色で確定」という結果にする。ただしここではパネル自身に
      // 確定させる(=onCommitを呼ばせる)のではなく、こちら側でfinish()を直接呼ぶ。理由は、
      // writeLive()が既に(addToHistory:falseで)現在のライブ値をドキュメントへ反映済みなので、
      // currentTarget()の指す範囲の"今の"テキストがそのままライブ値そのものであり、
      // 動的importが未解決でpanelHandleがまだ無い(=何もライブ反映されていない)場合を含めて
      // 常に安全に「今の状態をfinalTextとしてfinish()する」だけで確定できるため
      // (finish()はfinalText===colorTextなら(2)の履歴付き変更を行わないので、何も
      // ドラッグしていない状態で閉じても余計な履歴は残らない)。
      // finish()自体はドキュメントを書き換えないので閉じる前後で位置がズレる心配も無い。
      // 最後にDOM上のパネルを閉じる(パネル側のcommit/cancelは呼ばない。確定は上のfinish()で
      // 既に行ったため、二重に走らせないようpanelHandle.close()を使う)。
      const forceApplyAndClose = () => {
        if (ended) return;
        const target = currentTarget();
        const finalText = target ? view.state.sliceDoc(target.from, target.to) : colorText;
        finish(finalText);
        if (panelHandle) panelHandle.close();
      };
      activeColorPicker = { forceApplyAndClose };
      // パネル本体(color-picker-panel.js)は動的importで必要になった瞬間にだけ読み込む。
      // 呼び出し自体は同期でtrueを返す(枠線ハイライトも上でdispatch済み)ため、
      // ここでのわずかな遅延は「パネルの表示が一瞬遅れる」以上の影響を持たない。
      // importが解決するまでの間にabandon()/finish()で既に閉じていたら(ended===true)、
      // パネルは作らない(対象喪失後に今さら開いても無意味なため)。
      import("./color-picker-panel.js").then(({ formatColorLiteral, openColorPickerPanel }) => {
        if (ended) return;
        panelHandle = openColorPickerPanel({
          anchorRect,
          initialColor: parsed,
          hasAlpha,
          formatColor: (rgba) => formatColorLiteral(rgba, parsed.notation),
          onChange: (rgba) => writeLive(formatColorLiteral(rgba, parsed.notation)),
          onCommit: (rgba) => finish(formatColorLiteral(rgba, parsed.notation)),
          onCancel: () => finish(colorText), // 開いた時の色に戻す。履歴には何も残らない
        });
      }).catch((err) => {
        // 不具合3の修正: 動的importが失敗した(オフライン/ファイル欠落等)場合、.catchが
        // 無いとunhandled rejectionになり、枠線のハイライトだけ表示されてパネルが開かない
        // まま操作不能になっていた。ここでは(1)まだ確定していなければabandon()でハイライトを
        // 消して対象消失扱いにし(パネルはpanelHandleがnullのまま=作られていないのでpanelHandle.
        // close()は何もしない)、(2)ユーザーに分かる形でエラーを知らせる(このアプリ既存の
        // 警告ダイアログpaneAlertを使う。confirmOpenExternal等と同じ流儀)。
        console.error("カラーピッカーパネルの読み込みに失敗しました:", err);
        abandon();
        paneAlert({ title: "カラーピッカーを開けません", message: "カラーピッカーの読み込みに失敗しました。もう一度お試しください。" });
      });
      return true;
    },
    // 折り返し表示のON/OFF(仕様書 N-05)
    setWordWrap: (on) => view.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) }),
    // 自動ペアリング(仕様書 第2.10節 C-05)のON/OFF。既定はON。C#設定画面から呼ばれる想定。
    setAutoPairing: (on) => {
      autoPairingOn = !!on;
      view.dispatch({ effects: autoPairComp.reconfigure(autoPairingOn ? closeBrackets() : []) });
    },
    isAutoPairing: () => autoPairingOn,
    // コードブロックのインデント幅(仕様書 codeIndentSize)。2/4/8以外の値は既定4にフォールバックする。
    // indentUnit(Tabキーで新規挿入する幅)とEditorState.tabSize(タブ文字の表示幅)を同時に
    // 切り替える。インデントガイドの間隔もこの値に連動しているため、コードモードで表示中なら
    // codeModeExtrasComp側も併せて作り直す(setAutoPairing等と同じ、モードに応じてComp再構成
    // するかどうかを出し分ける流儀)。
    setCodeIndentSize: (n) => {
      const size = [2, 4, 8].includes(n) ? n : 4;
      codeIndentSizeValue = size;
      view.dispatch({ effects: codeIndentComp.reconfigure([indentUnit.of(" ".repeat(size)), EditorState.tabSize.of(size)]) });
      if (currentMode === "code") view.dispatch({ effects: codeModeExtrasComp.reconfigure(codeModeExtras()) });
    },
    // コードモードの折りたたみ(fold gutter・fold keymap)のON/OFF。既定はON。
    setCodeFolding: (on) => {
      codeFoldingOn = !!on;
      if (currentMode === "code") view.dispatch({ effects: codeModeExtrasComp.reconfigure(codeModeExtras()) });
    },
    isCodeFolding: () => codeFoldingOn,
    // 依頼③: インデントガイドの表示モード("none"|"fold"|"all"、既定"fold")。
    // 不正な値は"fold"へ倒す(設定ファイルが手で壊されていても変な状態にならないよう、
    // AppSettings.cs側のValidateEnumと同じ方針)。
    setCodeIndentGuides: (mode) => {
      codeIndentGuidesMode = ["none", "fold", "all"].includes(mode) ? mode : "fold";
      if (currentMode === "code") view.dispatch({ effects: codeModeExtrasComp.reconfigure(codeModeExtras()) });
    },
    getCodeIndentGuides: () => codeIndentGuidesMode,
    // スペルチェック(仕様書 spellCheckEnabled)。.cm-contentのspellcheck属性を切り替える。
    // spellCheckAutoCorrect(自動修正)はWebView2側の機能でJSからは制御できないため未実装。
    setSpellCheck: (on) => {
      view.dispatch({ effects: spellCheckComp.reconfigure(EditorView.contentAttributes.of({ spellcheck: on ? "true" : "false" })) });
    },
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
      if (typewriterOn) {
        const toggles = view.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
        const y = toggles.typewriterKeepCaretCentered === false ? "nearest" : "center";
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y }) });
      }
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
    // whitespaceOnExport(仕様書、既定"ignore")が"preserve"のときは段落内の単独改行を<br>として
    // 書き出す(エクスポート・印刷・HTMLコピーいずれも同じ設定を使う)。
    getHtmlForClipboard: () => {
      const sel = view.state.selection.main;
      const range = sel.from === sel.to ? { from: 0, to: view.state.doc.length } : { from: sel.from, to: sel.to };
      const toggles = view.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
      return renderMarkdownToHtml(view.state, range, { preserveWhitespace: toggles.whitespaceOnExport === "preserve" });
    },
    // HTMLエクスポート(仕様書 File項目「エクスポート: HTML」)。文書全体を対象にする。
    // configはmain.js側でエクスポート設定(exportPageBreakBetweenTopHeadings等)から組み立てて渡す。
    // 数式のSVGレンダリング(exportMathAs="svg")が非同期なため、Promiseを返す。
    getStandaloneHtml: (config) => {
      const toggles = view.state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
      return renderStandaloneHtml(view.state, {
        css: EXPORT_CSS,
        preserveWhitespace: toggles.whitespaceOnExport === "preserve",
        // ローカル画像のdata:埋め込み(md-to-html.js resolveLocalImageFsPath参照)の基準フォルダ。
        // main.js側のresolveLocalImage(config側)と組み合わせて使う。
        docDir: currentDocDir,
        ...config,
      });
    },
    // カーソル位置の行に記法を挿入(ツールバー用)
    applyAction: (action, payload) => applyMdAction(view, action, payload),
    // 右クリックメニュー(docs/コンテキストメニュー仕様.md 第2章): クリック位置の文脈判定。
    resolveContextMenu: (x, y, targetEl) => resolveClickContext(view, x, y, targetEl),
    // リンクを開く/内部見出しへジャンプ(既存のクリック時の経路と同じ。外部サイトは
    // confirmOpenExternalを必ず通る)。modifierKeyをtrue固定にすることで、#見出しの
    // 内部アンカーもCtrlクリック相当としてジャンプさせる(右クリックメニューからの明示操作のため)。
    openLink: (href) => openOrJumpLink(view, href, true),
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
    // ---- タブ形式(仕様書 第2.10節 C-14、隠し設定)用API ----
    // 単一のview/エディタインスタンスを使い回し、タブ切替のたびEditorStateを丸ごと
    // 差し替える(タブごとにエディタを作らない。メモリと初期化コストのため)。
    // Compartmentの構成(言語モード・ライブプレビュー等)はEditorState自体に含まれるため
    // stateごと切り替われば自動的に復元されるが、createEditor内部のクロージャ変数
    // (currentMode/currentCodeLanguage/sourceMode)はstate外の付随情報のため、
    // 呼び出し側がgetModeSnapshot/applyModeSnapshotで別途同期する必要がある。
    getEditorState: () => view.state,
    // ローカル画像の相対パス解決の基準(resolveImageSrc参照)。main.js側で「表示する文書」が
    // 変わるたび(file-opened・タブ切替・新規文書等)に、その文書のパス(無題文書ならnull)で
    // 呼ぶこと。ライブプレビューの装飾再構築より前に同期させる必要があるため、
    // setEditorState/内容の書き換えより先に呼ぶ(main.js側の各呼び出し箇所を参照)。
    setDocumentPath: (path) => {
      currentDocDir = path ? path.replace(/[\\/][^\\/]*$/, "") : null;
    },
    setEditorState: (state) => {
      // 不具合3の修正: タブ切替でviewの中身がまるごと差し替わるため、その時点で
      // 実行中のsetFileMode/setCodeLanguageの世代を進めておく。これにより、待機中だった
      // 古い呼び出しがawaitから戻ってきても「割り込まれた」と判定されてdispatchされず、
      // 切り替わった後のタブ(=別のEditorState)を誤って書き換えることがなくなる。
      modeGen++;
      view.setState(state);
      if (onRender) requestAnimationFrame(() => onRender());
    },
    // 新規タブ用のまっさらなEditorState(履歴を含め何も持たない状態)を作る。
    // 現在のview構築に使ったCompartmentインスタンスをそのまま使うため、この戻り値は
    // 同じcreateEditor()のview(=同じエディタインスタンス)へのみsetEditorStateできる。
    createFreshState: (text) => EditorState.create({ doc: text || "", extensions: buildExtensions() }),
    // 検索パネル(search-ui.js)向け: 本文変更の通知を購読する(バグ2の修正、docChangeListeners
    // 定義部のコメント参照)。タブ切替でEditorStateが差し替わっても購読は切れない。
    // 戻り値は購読解除用の関数。
    onDocChange: (fn) => {
      docChangeListeners.add(fn);
      return () => docChangeListeners.delete(fn);
    },
    getModeSnapshot: () => ({ mode: currentMode, codeLanguage: currentCodeLanguage, sourceMode }),
    applyModeSnapshot: (snap) => {
      currentMode = snap?.mode ?? "markdown";
      currentCodeLanguage = snap?.codeLanguage ?? null;
      sourceMode = !!snap?.sourceMode;
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
    // 不具合2と同じ理由: メニュー/ツールバーからの明示操作なのでuserEventを付け、連続実行時に
    // まとめて1回のアンドゥにならないようにする。
    view.dispatch({ changes: { from: line.from + m[1].length, to: line.from + m[1].length + m[2].length, insert: "#".repeat(newLevel) }, userEvent: "input.mdAction" });
  } else if (delta > 0) {
    view.dispatch({ changes: { from: line.from, insert: "# " }, userEvent: "input.mdAction" });
  }
  view.focus();
}
// リスト種別の相互変換(仕様書 P-13)。target: "bullet" | "ordered" | "check"
// 新しく付け直すマーカーは設定(unorderedListMarker/orderedListMarker)に従う。
function convertListType(view, target) {
  const { state } = view;
  const toggles = state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  const uMarker = toggles.unorderedListMarker || "-";
  const oSep = toggles.orderedListMarker || ".";
  const line = state.doc.lineAt(state.selection.main.from);
  const m = line.text.match(/^(\s*)(?:[-*+]\s+\[[ xX]\]\s?|[-*+]\s|\d+[.)]\s)/);
  if (!m) return;
  const indent = m[1];
  const marker = target === "bullet" ? indent + uMarker + " " : target === "ordered" ? indent + "1" + oSep + " " : indent + uMarker + " [ ] ";
  // 不具合2と同じ理由でuserEventを付ける(連続実行時に1操作=1アンドゥにするため)。
  view.dispatch({ changes: { from: line.from, to: line.from + m[0].length, insert: marker }, userEvent: "input.mdAction" });
  view.focus();
}
// Setext形式の見出し(仕様書 headingStyle="setext")。レベル1・2のみ表現できるため、
// h1/h2のツールバー操作でのみ使う(h3以降は常にatx、呼び出し元のapplyMdActionで分岐済み)。
// 既に同じレベルの下線が付いていればトグルで解除する。
function applySetextHeading(view, level) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const text = line.text.replace(/^ {0,3}#{1,6}\s+/, "");
  const underlineChar = level === 1 ? "=" : "-";
  const nextLine = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const nextTrim = nextLine ? nextLine.text.trim() : "";
  const alreadyUnderlined = nextTrim !== "" && [...nextTrim].every((c) => c === underlineChar);
  // 不具合2と同じ理由でuserEventを付ける(連続実行時に1操作=1アンドゥにするため)。
  if (alreadyUnderlined) {
    view.dispatch({ changes: { from: line.from, to: nextLine.to, insert: text }, userEvent: "input.mdAction" });
  } else {
    const underline = underlineChar.repeat(Math.max(3, [...text].length));
    view.dispatch({ changes: { from: line.from, to: line.to, insert: `${text}\n${underline}` }, userEvent: "input.mdAction" });
  }
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
  // mutateTableと同じ理由(不具合2)でuserEventを付け、連続実行時にアンドゥが1操作分だけ戻るようにする。
  view.dispatch({ changes: { from: t.from, to: t.to, insert: formatTableText(t) }, userEvent: "input.table" });
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

// ---- 右クリックメニューの文脈判定(docs/コンテキストメニュー仕様.md 第2章) ----
// 右クリック位置がリンク/画像/表/コードブロック/見出し/リストのどれの上かを判定して返す。
// メニューの組み立て自体(どの項目を出すか)はmain.js側の責務で、ここは「そこに何があるか」
// だけを返す(コマンドの実装はJS側という方針の中でも、構文木を読む部分はeditor.jsに閉じ込め、
// main.jsは構文木を直接読まない)。
function findAncestorNode(state, pos, name) {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (let n = node; n; n = n.parent) if (n.name === name) return n;
  return null;
}
function imageInfoFromNode(state, n) {
  const text = state.doc.sliceString(n.from, n.to);
  const m = text.match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
  if (!m) return null;
  return { alt: m[1], src: m[2].trim(), from: n.from, to: n.to };
}
function linkInfoFromNode(state, n) {
  const text = state.doc.sliceString(n.from, n.to);
  // 直接記法[text](url)のみ対応する(参照形式[text][id]はラベル解決が絡み簡易対応の範囲を
  // 超えるため、ここでは検出せず素の段落として扱う)。
  const m = text.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
  if (!m) return null;
  return { href: m[2].trim(), from: n.from, to: n.to };
}
// ライブプレビューで画像が<img>ウィジェットに置き換わっている間は、posAtCoordsが
// ウィジェットの境界(from/to)のどちらかしか返せない(1個のウィジェットの内部座標までは
// 分からない)。DOM側(.cm-image-widget)がクリックされたことが分かっている場合は、
// view.posAtDOM()でそのウィジェットの位置(=nf)を取り、そこから構文木を辿り直す
// (ImageWidget.toDOMのmousedownハンドラと同じ手筋)。
function imageInfoAtDom(view, imgEl) {
  let pos;
  try { pos = view.posAtDOM(imgEl); } catch { return null; }
  const node = findAncestorNode(view.state, pos, "Image");
  return node ? imageInfoFromNode(view.state, node) : null;
}
// 表も画像と同じ理由(TableWidgetは表全体を1個のブロックウィジェットとして置き換える)で、
// 行/列の判定にはDOM(実際にクリックされた<td>/<th>)を使う。ヘッダー行は仕様上「行の削除」
// が効かないため、rowKind:"header"とbodyIndex:-1で区別する。
function tableInfoAtDom(view, tableEl, targetEl) {
  let pos;
  try { pos = view.posAtDOM(tableEl); } catch { return null; }
  const t = tableAt(view.state, pos);
  if (!t) return null;
  const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map((r) => r.length) : [0]), 1);
  const cellEl = targetEl?.closest?.("td, th");
  let rowKind = "header", bodyIndex = -1, col = 0;
  if (cellEl) {
    col = Math.min(cols - 1, cellEl.cellIndex ?? 0);
    if (cellEl.closest("tbody")) {
      rowKind = "body";
      const trEl = cellEl.closest("tr");
      bodyIndex = trEl ? Array.prototype.indexOf.call(trEl.parentElement.children, trEl) : 0;
    }
  }
  return { t, rowKind, bodyIndex, col, cols };
}
// ソースコードモード・選択がテーブルへ触れている間などはTableWidgetが使われず生テキストの
// ままになる(buildTableDeco参照)。その場合はDOM要素が無いため、行内の"|"の数からセル位置を
// 逆算する(selectStyleRangeAtCursorのテーブル分岐と同じ考え方)。
function tableInfoFromPos(state, t, pos) {
  const line = state.doc.lineAt(pos);
  const rowIdx = line.number - t.startLine; // 0=見出し 1=区切り 2以降=ボディ
  const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map((r) => r.length) : [0]), 1);
  const before = line.text.slice(0, pos - line.from);
  const col = Math.min(cols - 1, Math.max(0, (before.match(/\|/g) || []).length - 1));
  const rowKind = rowIdx <= 1 ? "header" : "body";
  const bodyIndex = rowIdx <= 1 ? -1 : rowIdx - 2;
  return { t, rowKind, bodyIndex, col, cols };
}
// カーソル位置を含む数式ブロック($$...$$)。$$…$$のブロック集合はmathBlocksFieldが
// 既に(docChangedのたびに全文再走査ではなく差分更新で)保持しているものをそのまま使う。
export function mathBlockAt(view, pos) {
  const blocks = view.state.field(mathBlocksField, false) ?? [];
  return blocks.find((b) => pos >= b.from && pos <= b.to) ?? null;
}
// インライン数式 $...$。ライブプレビュー本体(buildLiveDeco)と同じ正規表現で該当行を調べる。
function inlineMathAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const re = /\$([^\s$](?:[^$\n]*[^\s$])?)\$/g;
  let m;
  while ((m = re.exec(line.text))) {
    const f = line.from + m.index, tt = f + m[0].length;
    if (pos >= f && pos <= tt) return { from: f, to: tt };
  }
  return null;
}
// ブロック/インラインどちらの数式かを区別せず返す共通の入口。
function mathAt(view, pos) {
  const mb = mathBlockAt(view, pos);
  if (mb) return { from: mb.from, to: mb.to, display: true };
  const im = inlineMathAt(view.state, pos);
  if (im) return { from: im.from, to: im.to, display: false };
  return null;
}
// カーソル位置を含むFencedCode(コードブロック)ノード。開始/終了行・言語(CodeInfo)・
// 中身のテキストをまとめて返す(コピー・言語変更・削除のいずれもこれ1つから組み立てられる)。
function codeBlockAt(view, pos) {
  const state = view.state;
  const node = findAncestorNode(state, pos, "FencedCode");
  if (!node) return null;
  const marks = node.getChildren("CodeMark");
  if (marks.length < 2) return null; // 未終端(閉じフェンス無し)は対象外(ライブプレビューと同じ条件)
  const open = state.doc.lineAt(node.from);
  const close = state.doc.lineAt(Math.max(node.from, node.to - 1));
  const infoNode = node.getChild("CodeInfo");
  const lang = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to).trim() : "";
  let code = "";
  if (close.number > open.number) {
    code = state.sliceDoc(
      state.doc.line(Math.min(open.number + 1, close.number)).from,
      close.from > 0 ? close.from - 1 : close.from
    );
  }
  return { from: open.from, to: close.to, openLine: open, closeLine: close, openMark: marks[0], infoNode, lang, code };
}
// リストの現在の種別(見出しレベルアイコンのcheckedに使う。convertListTypeの逆引き)。
function detectListType(text) {
  if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(text)) return "check";
  if (/^\s*\d+[.)]\s/.test(text)) return "ordered";
  return "bullet";
}

// 右クリックの文脈をまとめて判定する。呼び出し前に「クリック位置へキャレットを移す」
// (選択範囲の中への右クリックは選択を保持する、仕様書 大原則5)処理もここで行う。
// x/yはCodeMirrorのcontentDOM基準のクライアント座標(contextmenuイベントのclientX/clientY)、
// targetEl はイベントのtarget(ライブプレビューのウィジェット判定に使う。省略可)。
export function resolveClickContext(view, x, y, targetEl) {
  const before = view.state;
  let pos = view.posAtCoords({ x, y });
  if (pos == null) pos = before.doc.length;

  // ---- ライブプレビューの置換ウィジェット越し(DOMヒットテストを優先する) ----
  // 必ず次のキャレット移動より先に行う。キャレット移動(view.dispatch)はウィジェットを
  // 生テキストへ置き換えることがあり(表・画像はcursorInside/選択範囲がその内側に入った
  // 時点で即座に切り替わる)、そうなるとtargetElがDOMツリーから切り離されてclosest()が
  // 辿れなくなったり、view.posAtDOM()が古い(既に取り除かれた)ノードに対して失敗したり
  // するため、DOM参照がまだ有効なうちに必要な情報を読み切っておく。
  let domContext = null;
  if (targetEl instanceof Element) {
    const linkEl = targetEl.closest("[data-href]");
    if (linkEl) {
      domContext = { kind: "link", href: linkEl.getAttribute("data-href") || "" };
      try { pos = view.posAtDOM(linkEl); } catch { /* posAtCoordsの結果をそのまま使う */ }
    } else {
      const imgEl = targetEl.closest(".cm-image-widget");
      if (imgEl) {
        const info = imageInfoAtDom(view, imgEl);
        if (info) { domContext = { kind: "image", ...info }; pos = info.from; }
      } else {
        const tableEl = targetEl.closest(".cm-table");
        if (tableEl) {
          const info = tableInfoAtDom(view, tableEl, targetEl);
          // 表全体(TableWidget)は1個のブロックウィジェットとして置き換わっており、
          // posAtCoords(x,y)はウィジェットの境界(from/to)のどちらかしか返せない。
          // to側(表の直後)に倒れるとtableAt()で表自体を再特定できず、後続の
          // mutateTable(view, カーソル位置, ...)が「表が見つからない」として何もしなくなって
          // しまう。それを避けるため、実際にクリックされた行(info.rowKind/bodyIndex、
          // DOMから判定済み)の行頭を使う。「行を削除」(deleteTableRow)のように
          // payloadを取らずカーソル位置だけで対象行を判定する既存アクションとの
          // 整合性も保てる(表の先頭に固定してしまうと常にヘッダー行として扱われてしまう)。
          if (info) {
            domContext = { kind: "table", ...info };
            const rowLine = info.rowKind === "body" ? info.t.startLine + 2 + info.bodyIndex : info.t.startLine;
            pos = before.doc.line(Math.min(Math.max(1, rowLine), before.doc.lines)).from;
          }
        }
      }
    }
  }

  // 大原則5: 右クリック位置にキャレットを移す(選択範囲の中への右クリックは選択を保持する)。
  const selBefore = before.selection.main;
  if (pos < selBefore.from || pos > selBefore.to) {
    view.dispatch({ selection: { anchor: pos } });
  }
  const state = view.state;
  const sel = state.selection.main;
  const hasSelection = !sel.empty;

  // カラープレビュー(docs/カラープレビュー仕様.md 第4章): 色リテラルの上での右クリックは
  // 他のkind判定(表・コードブロック・見出し等)と独立に「色を変更…」を先頭に出す対象になる。
  // どのkindが返るかに関わらず一律で info.color に載せる(main.js側でtree配列の先頭へ
  // 追加できるようにするための情報。main.jsは本エディタが公開するgetColorLiteralAt/
  // openColorPickerを呼ぶだけで済む)。
  const colorLit = colorLiteralAt(view, pos);
  const withColor = (obj) => (colorLit ? { ...obj, color: colorLit } : obj);

  if (domContext) return withColor({ ...domContext, hasSelection });

  // ---- ここから先は生テキスト(構文木・行テキスト)からの判定 ----
  const t = tableAt(state, pos);
  if (t) return withColor({ kind: "table", ...tableInfoFromPos(state, t, pos), hasSelection });

  const cb = codeBlockAt(view, pos);
  if (cb) return withColor({ kind: "codeblock", ...cb, hasSelection });

  const m = mathAt(view, pos);
  if (m) return withColor({ kind: "math", ...m, hasSelection });

  const imgNode = findAncestorNode(state, pos, "Image");
  if (imgNode) {
    const info = imageInfoFromNode(state, imgNode);
    if (info) return withColor({ kind: "image", ...info, hasSelection });
  }
  const linkNode = findAncestorNode(state, pos, "Link");
  if (linkNode) {
    const info = linkInfoFromNode(state, linkNode);
    if (info) return withColor({ kind: "link", ...info, hasSelection });
  }

  const line = state.doc.lineAt(pos);
  const atx = line.text.match(/^ {0,3}(#{1,6})\s/);
  if (atx) return withColor({ kind: "heading", level: atx[1].length, hasSelection });

  if (/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+\.\s+)/.test(line.text)) {
    return withColor({ kind: "list", listType: detectListType(line.text), hasSelection });
  }

  return withColor({ kind: "paragraph", hasSelection });
}

// ツールバーの記法挿入(CodeMirror版)
function applyMdAction(view, action, payload) {
  const { state } = view;
  const sel = state.selection.main;
  const s = sel.from, e = sel.to;
  const selText = state.sliceDoc(s, e);
  const line = state.doc.lineAt(s);
  // メニューバーからの記法生成(仕様書「記法の書き方」節)。見出しの記法(setext/atx)は
  // 呼び出し元(h1/h2ケース)で個別に分岐するため、ここではリスト記号・番号の区切りのみを扱う。
  const toggles = state.field(extTogglesField, false) ?? DEFAULT_EXT_TOGGLES;
  // 不具合2の修正: applyMdActionの各アクションはツールバー/メニュー/コンテキストメニューからの
  // 明示操作であり、表操作と同じく1操作=1アンドゥであるべき。userEvent未指定のままだと
  // CodeMirrorのhistory結合規則(!userEvent かつ変更範囲が隣接/重複)で連続実行時に
  // まとめて1回のアンドゥ対象になってしまう(表操作で実際に再現したのと同じ原因)。
  // "input.type"/"delete"系にマッチしない専用のuserEventを共通で付ける。
  const MD_ACTION_USER_EVENT = "input.mdAction";
  const linePrefix = (p) => {
    // 既存の同種プレフィックスがあればトグル、無ければ付与。浅いインデント(3個まで)の後ろで判定する
    const ind = line.text.match(/^ {0,3}/)[0].length;
    const base = line.from + ind;
    const cur = line.text.slice(ind).match(/^(#{1,6}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s|>\s)/);
    if (cur && cur[0] === p) {
      view.dispatch({ changes: { from: base, to: base + p.length }, selection: { anchor: Math.max(base, s - p.length) }, userEvent: MD_ACTION_USER_EVENT });
    } else if (cur) {
      view.dispatch({ changes: { from: base, to: base + cur[0].length, insert: p }, selection: { anchor: s - cur[0].length + p.length }, userEvent: MD_ACTION_USER_EVENT });
    } else {
      view.dispatch({ changes: { from: base, insert: p }, selection: { anchor: s + p.length }, userEvent: MD_ACTION_USER_EVENT });
    }
    view.focus();
  };
  const insert = (t, cursorOffset) => view.dispatch({ changes: { from: s, to: e, insert: t }, selection: { anchor: s + (cursorOffset ?? t.length) }, userEvent: MD_ACTION_USER_EVENT });
  // 不具合Aの修正: "**文章**"を選択してCtrl+Bをもう一度押すと"****文章****"になっていた
  // (常に無条件でw を前後に挿入するだけで、既に付いているマーカーを外す=トグルする経路が
  // 無かったため)。見出し(linePrefix、上記)が既存マーカーを検出して解除しているのと
  // 同じ考え方を、太字**・斜体*・打消し~~・ハイライト==・コード`・上付き^・下付き~の
  // 7種類(いずれもwrapSel経由。下線<u></u>はwrapPair側で開始/終了マーカーが非対称なため
  // 対象外)に入れる。
  //
  // 判定できるのは次の2パターン:
  //   (1) 選択範囲そのものがマーカーごと含まれている([**文章**]を選択) → 中身だけ残す
  //   (2) マーカーが選択範囲の外側にある(**[文章]**の[文章]だけを選択) → 外側のw を外す
  // これら以外(マーカーが無い、または曖昧)は従来どおり単純にwで囲む。
  //
  // 曖昧さの扱い: このアプリのマーカーはいずれも同じ文字の繰り返し(**, ~~, ==)か1文字
  // (*, `, ^, ~)なので、境界での「その文字の連続数」を数え、ちょうどw.lengthのときだけ
  // 完全一致とみなす。連続数がそれより長い場合(例: 太字**の外側にさらに斜体*が続いて
  // "***"になっている等、入れ子で"**太字と*斜体***"のようなケース)は、どちらの
  // マーカーの境界なのか文字だけでは判別できないため、安全側に倒してトグルせず通常の
  // wrapとして扱う(入れ子で誤爆しないこと)。
  const runLenBackward = (text, endExclusive, ch) => {
    let n = 0;
    while (n < endExclusive && text[endExclusive - 1 - n] === ch) n++;
    return n;
  };
  const runLenForward = (text, start, ch) => {
    let n = 0;
    while (start + n < text.length && text[start + n] === ch) n++;
    return n;
  };
  const wrapSel = (w) => {
    if (s !== e && w.split("").every((c) => c === w[0])) {
      const ch = w[0];
      // (1) 選択範囲そのものがマーカーごと含まれている場合
      if (selText.length >= 2 * w.length && selText.startsWith(w) && selText.endsWith(w)) {
        const leadRun = runLenForward(selText, 0, ch);
        const trailRun = runLenBackward(selText, selText.length, ch);
        if (leadRun === w.length && trailRun === w.length) {
          const inner = selText.slice(w.length, selText.length - w.length);
          view.dispatch({ changes: { from: s, to: e, insert: inner }, selection: { anchor: s, head: s + inner.length }, userEvent: MD_ACTION_USER_EVENT });
          return;
        }
      }
      // (2) マーカーが選択範囲の外側にある場合(直前w.length文字・直後w.length文字を見る。
      // ドキュメント境界(先頭/末尾)に達している場合はそれ以上先が無い=曖昧さも無いとみなす)。
      const before = state.sliceDoc(Math.max(0, s - w.length - 1), s);
      const after = state.sliceDoc(e, Math.min(state.doc.length, e + w.length + 1));
      if (before.slice(-w.length) === w && after.slice(0, w.length) === w) {
        const beforeRun = runLenBackward(before, before.length, ch);
        const afterRun = runLenForward(after, 0, ch);
        if (beforeRun === w.length && afterRun === w.length) {
          view.dispatch({
            changes: [{ from: s - w.length, to: s, insert: "" }, { from: e, to: e + w.length, insert: "" }],
            selection: { anchor: s - w.length, head: e - w.length },
            userEvent: MD_ACTION_USER_EVENT,
          });
          return;
        }
      }
    }
    // 選択が無い(カーソルのみ)場合は既存仕様どおり常に挿入する(マーカーの内側にカーソルを
    // 置いて続けて入力できるようにする、という従来の挙動を変えない)。
    view.dispatch({ changes: [{ from: s, insert: w }, { from: e, insert: w }], selection: { anchor: s + w.length, head: e + w.length }, userEvent: MD_ACTION_USER_EVENT });
  };
  const wrapPair = (open, close) => view.dispatch({ changes: [{ from: s, insert: open }, { from: e, insert: close }], selection: { anchor: s + open.length, head: e + open.length }, userEvent: MD_ACTION_USER_EVENT });

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
      view.dispatch({ changes: { from: s, to: e, insert: cleaned }, selection: { anchor: s, head: s + cleaned.length }, userEvent: MD_ACTION_USER_EVENT });
      break; // 仕様書 R-08
    }
    case "softBreak": insertSoftBreak(view); break; // 仕様書 E-02・M-01(共通処理はinsertSoftBreak)
    case "selectWord": selectWordAtCursor(view); break; // 仕様書 E-12
    case "deleteWord": deleteWordAtCursor(view); break; // 仕様書 E-13
    case "selectLine": selectLineAtCursor(view); break; // 仕様書 E-09
    case "selectStyleRange": selectStyleRangeAtCursor(view); break; // 仕様書 E-11
    case "deleteTableRow": deleteTableRowAtCursor(view); break; // 表の行を削除
    // ---- 表の行/列の挿入・削除・配置(docs/コンテキストメニュー仕様.md 第2.5節、新規実装) ----
    // いずれもmutateTable(TableWidgetのボタン群と同じ土台)で構造データを組み替えてから
    // formatTableText()で書き戻す。行/列位置はpayload(bodyIndex/col)で受け取る。
    // ライブプレビュー中の表はTableWidgetという1個のブロックウィジェットに置き換わっており、
    // カーソル位置(posAtCoords)だけでは正確な行/列までは分からないため、右クリック時に
    // DOM(実際にクリックされた<td>/<th>)から判定した値をmain.js側から渡してもらう
    // (resolveClickContextのtableInfoAtDom/tableInfoFromPosと同じ値)。
    case "tableInsertRowAbove": mutateTable(view, s, (t) => {
      const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map((r) => r.length) : [0]), 1);
      t.body.splice(Math.max(0, payload?.bodyIndex ?? 0), 0, Array(cols).fill(""));
    }); break;
    case "tableInsertRowBelow": mutateTable(view, s, (t) => {
      const cols = Math.max(t.header.length, ...(t.body.length ? t.body.map((r) => r.length) : [0]), 1);
      t.body.splice(Math.max(0, (payload?.bodyIndex ?? -1) + 1), 0, Array(cols).fill(""));
    }); break;
    case "tableInsertColLeft": mutateTable(view, s, (t) => {
      const col = payload?.col ?? 0;
      t.header.splice(col, 0, ""); t.aligns.splice(col, 0, null);
      for (const r of t.body) r.splice(col, 0, "");
    }); break;
    case "tableInsertColRight": mutateTable(view, s, (t) => {
      const col = payload?.col ?? 0;
      t.header.splice(col + 1, 0, ""); t.aligns.splice(col + 1, 0, null);
      for (const r of t.body) r.splice(col + 1, 0, "");
    }); break;
    case "tableDeleteCol": mutateTable(view, s, (t) => {
      if (t.header.length <= 1) return; // 最後の1列は消さない(TableWidgetの列削除ボタンと同じ条件)
      const col = payload?.col ?? 0;
      t.header.splice(col, 1); t.aligns.splice(col, 1);
      for (const r of t.body) r.splice(col, 1);
    }); break;
    case "tableDelete": {
      const t = tableAt(state, s);
      if (t) view.dispatch({ changes: { from: t.from, to: t.to, insert: "" }, userEvent: "input.table" }); // mutateTableと同じ理由(不具合2)
      break;
    }
    case "tableAlignLeft": mutateTable(view, s, (t) => { t.aligns[payload?.col ?? 0] = "left"; }); break;
    case "tableAlignCenter": mutateTable(view, s, (t) => { t.aligns[payload?.col ?? 0] = "center"; }); break;
    case "tableAlignRight": mutateTable(view, s, (t) => { t.aligns[payload?.col ?? 0] = "right"; }); break;
    case "tableAlignNone": mutateTable(view, s, (t) => { t.aligns[payload?.col ?? 0] = null; }); break;
    // ---- リンク/画像(第2.3節・第2.4節) ----
    case "linkUnlink": { // [text](url) → text
      const node = findAncestorNode(state, s, "Link");
      if (!node) break;
      const m = state.sliceDoc(node.from, node.to).match(/^\[([^\]]*)\]\(([^)]*)\)$/);
      if (!m) break;
      view.dispatch({ changes: { from: node.from, to: node.to, insert: m[1] }, userEvent: MD_ACTION_USER_EVENT });
      break;
    }
    case "linkEditUrl": { // URL部分を選択してキャレットを置く(直接編集できるように)
      const node = findAncestorNode(state, s, "Link");
      if (!node) break;
      const text = state.sliceDoc(node.from, node.to);
      const m = text.match(/^(\[[^\]]*\]\()([^)]*)(\))$/);
      if (!m) break;
      const urlFrom = node.from + m[1].length;
      view.dispatch({ selection: { anchor: urlFrom, head: urlFrom + m[2].length } });
      break;
    }
    case "imageDelete": {
      const node = findAncestorNode(state, s, "Image");
      if (node) view.dispatch({ changes: { from: node.from, to: node.to, insert: "" }, userEvent: MD_ACTION_USER_EVENT });
      break;
    }
    case "imageEditPath": { // パス部分を選択してキャレットを置く
      const node = findAncestorNode(state, s, "Image");
      if (!node) break;
      const text = state.sliceDoc(node.from, node.to);
      const m = text.match(/^(!\[[^\]]*\]\()([^)]*)(\))$/);
      if (!m) break;
      const pFrom = node.from + m[1].length;
      view.dispatch({ selection: { anchor: pFrom, head: pFrom + m[2].length } });
      break;
    }
    // ---- コードブロック(第2.6節) ----
    case "codeblockSetLang": {
      const cb = codeBlockAt(view, s);
      if (!cb) break;
      const lang = payload?.lang ?? "";
      if (cb.infoNode) view.dispatch({ changes: { from: cb.infoNode.from, to: cb.infoNode.to, insert: lang }, userEvent: MD_ACTION_USER_EVENT });
      else if (cb.openMark) view.dispatch({ changes: { from: cb.openMark.to, insert: lang }, userEvent: MD_ACTION_USER_EVENT });
      break;
    }
    case "codeblockDelete": {
      const cb = codeBlockAt(view, s);
      if (cb) view.dispatch({ changes: { from: cb.from, to: cb.to, insert: "" }, userEvent: MD_ACTION_USER_EVENT });
      break;
    }
    // ---- 数式ブロック/インライン数式(第2.9節) ----
    case "mathEditSelect": { // ソースを見せて中身を選択状態にする(display:trueならmathBlockDecoField等が
      // 選択範囲が中に入った時点で自動的に生テキスト表示へ切り替える。ここでは選択するだけでよい)
      const m = mathAt(view, s);
      if (!m) break;
      if (m.display) {
        const openLine = state.doc.lineAt(m.from);
        const closeLine = state.doc.lineAt(Math.max(m.from, m.to - 1));
        const cf = openLine.to + 1, ct = Math.max(cf, closeLine.from - 1);
        view.dispatch({ selection: { anchor: cf, head: ct } });
      } else {
        view.dispatch({ selection: { anchor: m.from + 1, head: m.to - 1 } });
      }
      break;
    }
    case "mathDelete": {
      const m = mathAt(view, s);
      if (m) view.dispatch({ changes: { from: m.from, to: m.to, insert: "" }, userEvent: MD_ACTION_USER_EVENT });
      break;
    }
    case "selectAll": selectAll(view); break; // 仕様書 第2.1節・第5節
    case "scrollToSelection": view.dispatch({ effects: EditorView.scrollIntoView(state.selection.main.head, { y: "center" }) }); break; // 仕様書 E-16
    case "headingUp": shiftHeadingLevel(view, -1); break; // 仕様書 P-03
    case "headingDown": shiftHeadingLevel(view, 1); break; // 仕様書 P-04
    case "listBullet": convertListType(view, "bullet"); break; // 仕様書 P-13
    case "listOrdered": convertListType(view, "ordered"); break;
    case "listCheck": convertListType(view, "check"); break;
    case "mathBlock": insert("$$\n" + selText + "\n$$", 3); break; // 仕様書 P-07
    case "frontMatter": {
      if (state.doc.length > 0 && state.doc.line(1).text === "---") break; // 既にある場合は何もしない
      view.dispatch({ changes: { from: 0, insert: "---\ntitle: \n---\n\n" }, selection: { anchor: 10 }, userEvent: MD_ACTION_USER_EVENT });
      break; // 仕様書 P-14
    }
    case "image": {
      // 実際のファイル選択・相対パス解決はC#側(main.js)が行い、結果をpayloadで受け取る
      const alt = payload?.alt ?? "";
      const path = payload?.path ?? "";
      const md = `![${alt}](${path})`;
      view.dispatch({ changes: { from: s, to: e, insert: md }, selection: { anchor: s + md.length }, userEvent: MD_ACTION_USER_EVENT });
      break; // 仕様書 R-07
    }
    case "h": linePrefix("## "); break;
    // headingStyle="setext"はレベル1・2のみ表現できる記法のため、そのときだけh1/h2を
    // Setext形式(下線)にする。レベル3以上は常にatx(仕様書の指示どおり)。
    case "h1": toggles.headingStyle === "setext" ? applySetextHeading(view, 1) : linePrefix("# "); break;
    case "h2": toggles.headingStyle === "setext" ? applySetextHeading(view, 2) : linePrefix("## "); break;
    case "h3": linePrefix("### "); break;
    case "h4": linePrefix("#### "); break;
    case "h5": linePrefix("##### "); break;
    case "h6": linePrefix("###### "); break;
    case "h0": { const m0 = line.text.match(/^( {0,3})(#{1,6}\s)/); if (m0) view.dispatch({ changes: { from: line.from + m0[1].length, to: line.from + m0[0].length }, selection: { anchor: Math.max(line.from, s - m0[2].length) }, userEvent: MD_ACTION_USER_EVENT }); break; }
    case "moveUp": moveLineUp(view); break;
    case "moveDown": moveLineDown(view); break;
    case "dupLine": copyLineDown(view); break;
    case "delLine": deleteLine(view); break;
    // 箇条書き・番号付きリストの記号は設定(unorderedListMarker/orderedListMarker)に従う。
    case "list": linePrefix(`${toggles.unorderedListMarker || "-"} `); break;
    case "olist": linePrefix(`1${toggles.orderedListMarker || "."} `); break;
    case "check": linePrefix(`${toggles.unorderedListMarker || "-"} [ ] `); break;
    case "quote": linePrefix("> "); break;
    case "link": { const label = selText || "リンク"; insert(`[${label}](https://)`, label.length + 11); break; } // カーソルはhttps://の直後
    case "codeblock": {
      // 仕様書 defaultCodeLanguage・defaultCodeLanguageApplyWhen="menubar"|"both":
      // メニューバー(ツールバー)からの挿入時のみ、ここで既定言語を付与する。
      const applyWhen = toggles.defaultCodeLanguageApplyWhen;
      const lang = (applyWhen === "menubar" || applyWhen === "both") ? (toggles.defaultCodeLanguage || "") : "";
      insert("```" + lang + "\n" + selText + "\n```", 4 + lang.length);
      break;
    }
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
    // 引用・リストのインデント幅(仕様書 indentSizeOnSave、既定4)。2/4/8以外の値は既定4にフォールバックする。
    case "indent": {
      const n = [2, 4, 8].includes(toggles.indentSizeOnSave) ? toggles.indentSizeOnSave : 4;
      view.dispatch({ changes: { from: line.from, insert: " ".repeat(n) }, userEvent: MD_ACTION_USER_EVENT });
      break;
    }
    case "outdent": {
      const n = [2, 4, 8].includes(toggles.indentSizeOnSave) ? toggles.indentSizeOnSave : 4;
      const m = line.text.match(new RegExp(`^( {1,${n}}|\\t)`));
      if (m) view.dispatch({ changes: { from: line.from, to: line.from + m[0].length }, userEvent: MD_ACTION_USER_EVENT });
      break;
    }

  }
  view.focus();
}
