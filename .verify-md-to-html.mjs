// src/md-to-html.js(HTMLとして書き出す・取扱説明書の画面で使う変換)のインライン装飾を固定する。
// ブラウザは使わない。esbuildで1つにまとめて読み込み、純粋な関数だけを試す。
//
// 2026-10-13、取扱説明書に「**`data` フォルダ**」(太字の先頭がインラインコード)と書いたら、
// 取扱説明書の画面が丸ごと表示されなくなった。太字の中身の範囲がインラインコードと同じ位置から
// 始まると、入れ物のノードを見つけられずに文書全体から辿り直し、外側の太字に再び出会って
// 同じ範囲の変換を呼び続けて、スタックを使い切っていた(src/md-to-html.js inlineHtml)。
import esbuild from "esbuild";

const entry = `
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough, Table, Superscript, Subscript, Emoji, Autolink } from "@lezer/markdown";
import { renderMarkdownToHtml } from "./src/md-to-html.js";
export function render(text) {
  const state = EditorState.create({ doc: text, extensions: [markdown({ extensions: [Strikethrough, Table, Superscript, Subscript, Emoji, Autolink] })] });
  return renderMarkdownToHtml(state, undefined, {});
}`;
const code = esbuild.buildSync({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: "js" },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
}).outputFiles[0].text;
const { render } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

let ng = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${cond || detail === undefined ? "" : `\n     実際: ${JSON.stringify(detail)}`}`);
  if (!cond) ng++;
};
const check = (md, expected) => {
  let html;
  try { html = render(md); } catch (e) { html = String(e); }
  ok(`${md} → ${expected}`, html.includes(expected), html);
};

check("x **`data`** y", "<strong><code>data</code></strong>");
check("**`data` フォルダ**へ", "<strong><code>data</code> フォルダ</strong>へ");
check("*`c`*", "<em><code>c</code></em>");
check("~~`c`~~", "<del><code>c</code></del>");
check("**[リンク](https://example.com)**", '<strong><a href="https://example.com">リンク</a></strong>');
check("**a `b` c**", "<strong>a <code>b</code> c</strong>");
check("a **b** c", "<p>a <strong>b</strong> c</p>");
check("[**太字**](https://example.com)", '<a href="https://example.com"><strong>太字</strong></a>');

console.log(`\nNG=${ng}`);
process.exit(ng ? 1 : 0);
