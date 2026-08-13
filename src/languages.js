// コードモード(仕様書 第1章・第5章)で使うCodeMirror言語一覧。
// 対応言語そのものの定義(拡張子・カテゴリ・ローダー)は src/file-types.js に
// 一元化してあり、ここではその FILE_TYPES から LanguageDescription の配列を
// 組み立てるだけにする(Pane/FileTypes.generated.cs もFILE_TYPESから生成されるため、
// 「対応拡張子」の定義元は常にfile-types.js の1箇所に保たれる)。
// alias はMarkdownのフェンス情報文字列(```js 等)の解決に、
// extensions はコードモード(第1章)でのファイル拡張子解決に使う
// (どちらも LanguageDescription.matchLanguageName / matchFilename が参照する)。
import { LanguageDescription } from "@codemirror/language";
import { FILE_TYPES } from "./file-types.js";

// load が null の言語(プレーンテキスト扱い: txt/csv 等)はハイライト対象ではないため
// LanguageDescription を作らない。拡張子としては後述の resolveFileMode 判定にのみ
// 使われ、その場合は自然と "plain" に落ちる(codeLanguages に無いので code 判定されない)。
export const codeLanguages = FILE_TYPES.filter((type) => type.load).map((type) =>
  LanguageDescription.of({
    name: type.id,
    alias: [type.id, ...type.extensions],
    extensions: type.extensions,
    load: type.load,
  })
);

const MARKDOWN_EXTENSIONS = new Set(
  FILE_TYPES.find((type) => type.id === "markdown").extensions
);

// ファイル種別と編集モード(仕様書 第1章): markdown / code / plain のいずれか。
export function resolveFileMode(filename) {
  if (!filename) return "markdown"; // 無題の新規文書は既定でMarkdown
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (LanguageDescription.matchFilename(codeLanguages, filename)) return "code";
  return "plain";
}
