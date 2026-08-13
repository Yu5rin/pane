// 仕様書 第5章の初期対応言語(14言語)を個別に列挙する。
// @codemirror/language-data の全言語同梱は行わず、load はすべて動的import。
// alias はMarkdownのフェンス情報文字列(```js 等)の解決に、
// extensions はコードモード(第1章)でのファイル拡張子解決に使う
// (どちらも LanguageDescription.matchLanguageName / matchFilename が参照する)。
import { LanguageDescription, StreamLanguage } from "@codemirror/language";

export const codeLanguages = [
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "jsx", "mjs", "cjs"],
    extensions: ["js", "jsx", "mjs", "cjs"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "typescript",
    alias: ["ts", "tsx"],
    extensions: ["ts", "tsx"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  }),
  LanguageDescription.of({
    name: "python",
    alias: ["py"],
    extensions: ["py"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: "csharp",
    alias: ["cs", "c#"],
    extensions: ["cs"],
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => StreamLanguage.define(m.csharp)),
  }),
  LanguageDescription.of({
    name: "sql",
    alias: ["sql"],
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  }),
  LanguageDescription.of({
    name: "json",
    alias: ["json"],
    extensions: ["json"],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: "yaml",
    alias: ["yml"],
    extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: "html",
    alias: ["htm"],
    extensions: ["html", "htm"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: "css",
    alias: [],
    extensions: ["css"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: "xml",
    alias: [],
    extensions: ["xml"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  }),
  LanguageDescription.of({
    name: "markdown",
    alias: ["md"],
    extensions: ["md", "markdown", "mdown", "mkd", "mmd"],
    load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  }),
  LanguageDescription.of({
    name: "powershell",
    alias: ["posh", "ps1"],
    extensions: ["ps1", "psm1", "psd1"],
    load: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => StreamLanguage.define(m.powerShell)),
  }),
  LanguageDescription.of({
    name: "batch",
    alias: ["bat", "cmd"],
    extensions: ["bat", "cmd"],
    load: () => import("./lang-batch.js").then((m) => StreamLanguage.define(m.batch)),
  }),
  LanguageDescription.of({
    name: "vb",
    alias: ["vbnet", "vbs"],
    extensions: ["vb"],
    load: () => import("@codemirror/legacy-modes/mode/vb").then((m) => StreamLanguage.define(m.vb)),
  }),
];

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mmd"]);

// ファイル種別と編集モード(仕様書 第1章): markdown / code / plain のいずれか。
export function resolveFileMode(filename) {
  if (!filename) return "markdown"; // 無題の新規文書は既定でMarkdown
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (LanguageDescription.matchFilename(codeLanguages, filename)) return "code";
  return "plain";
}
