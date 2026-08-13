// Windows バッチファイル(.bat/.cmd)向けの簡易ストリームパーサー。
// @codemirror/lang-* にも @codemirror/legacy-modes にもBatch用のモードが
// 存在しないため、仕様書 第5章の対応言語一覧(PowerShell / Batch / VB)を
// 満たすために最小限のトークナイザを自作する。
// トークン種別の文字列(comment/keyword/string/number/atom等)は
// @codemirror/language の StreamLanguage が標準タグへ自動対応させる。
const KEYWORDS = new Set([
  "echo", "set", "setlocal", "endlocal", "if", "else", "for", "in", "do",
  "goto", "call", "exit", "pause", "cls", "shift", "start", "cd", "chdir",
  "del", "erase", "copy", "move", "ren", "rename", "mkdir", "md", "rmdir",
  "rd", "type", "exist", "not", "defined", "errorlevel", "equ", "neq",
  "lss", "leq", "gtr", "geq",
]);

export const batch = {
  startState() {
    return {};
  },
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^\s*(::|rem\b)/i)) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match(/^\s*:[\w-]+/)) {
        return "atom"; // ラベル(:label)。GOTOの飛び先。
      }
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^%~?[a-zA-Z0-9_]*%/) || stream.match(/^!\w+!/)) {
      return "variableName"; // %VAR% / %1 / %~dp0 / !VAR!(遅延展開)
    }
    if (stream.match(/^"([^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^\d+/)) return "number";
    if (stream.match(/^[A-Za-z_][\w-]*/)) {
      return KEYWORDS.has(stream.current().toLowerCase()) ? "keyword" : null;
    }
    stream.next();
    return null;
  },
};
