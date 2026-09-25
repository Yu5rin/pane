// コードのハイライト配色(editor.js から切り出したもの)。本文のコードブロック・コードモードと、
// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)のCSS編集欄で同じ色分けを使うため、
// 小さなモジュールに分けた。作成補助の画面が editor.js 全体(CodeMirror拡張一式・数式・
// Mermaid等)を読み込まずに済むようにするため。
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

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
export const codeHighlightStyle = HighlightStyle.define([
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
