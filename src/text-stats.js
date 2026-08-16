// 文字数・単語数・行数・段落数の集計ロジック(仕様書 第2.7節 W-01〜W-03)。
// editor.js(単語選択・単語削除等、カーソル位置の「単語」の判定)と main.js(ステータスバー・
// 文字数カウントの詳細ポップアップ)の双方が同じ「文字種の切れ目」判定を必要とするため、
// charClass をここに集約して重複実装を避ける。

// 文字種境界での単語判定(仕様書 第2.7節注記: 日本語には単語区切りが存在しないため、
// 単語数は空白区切りではなく文字種の切れ目で数える。Typoraより日本語に適した挙動とする)。
export function charClass(ch) {
  if (!ch) return "other";
  if (/\s/.test(ch)) return "space";
  if (/[0-9a-zA-Z_]/.test(ch)) return "latin";
  if (/[぀-ゟ]/.test(ch)) return "hiragana";
  if (/[゠-ヿ]/.test(ch)) return "katakana";
  if (/[一-鿿]/.test(ch)) return "kanji";
  return "other"; // 記号・句読点等はそれぞれ1文字単位の境界として扱う
}

// 単語数(W-01/W-02): 文字種が変わるたびに1単語と数える。「other」(記号・句読点等)は
// 連続していても1文字ごとに独立した単語として扱う(charClassのコメント参照)。
export function countWords(text) {
  let count = 0;
  let prevClass = null;
  for (const ch of text) {
    const cls = charClass(ch);
    if (cls === "space") { prevClass = null; continue; }
    if (cls === "other") { count++; prevClass = null; continue; } // 記号は1文字=1単語
    if (cls !== prevClass) count++;
    prevClass = cls;
  }
  return count;
}

// 段落数(W-02): 空行(空白のみの行を含む)で区切られたブロックの数。
// editor.jsのフォーカスモード(V-06)が採用する「空行に挟まれたブロック」と同じ定義だが、
// あちらは可視範囲のみを見る軽量版、こちらは文字数カウント用に対象テキスト全体を走査する版。
export function countParagraphs(text) {
  const lines = text.split("\n");
  let count = 0;
  let inParagraph = false;
  for (const line of lines) {
    if (line.trim() === "") { inParagraph = false; continue; }
    if (!inParagraph) { count++; inParagraph = true; }
  }
  return count;
}

// 読了時間(仕様書 第2.7節 W-02): 日本語の一般的な黙読速度は400〜600文字/分程度とされる。
// その中間かつ切りのよい500文字/分を基準に計算する。空白・改行は読む対象ではないため、
// 空白を除いた文字数を使う。1分未満は「1分未満」と表示する(0分と表示すると誤解を招くため)。
const READING_CHARS_PER_MINUTE = 500;

// 設定 readingSpeedWpm(既定0=自動、設定項目一覧.md「編集」節)。0なら上のREADING_CHARS_PER_MINUTE
// による自動計算のまま、1以上ならその値(語/分)で計算する。editor.js側のgetDetailedStats()は
// computeTextStats(text)を引数無しの書式で呼ぶため(editor.jsは編集対象外)、呼び出し側の
// シグネチャを変えずに反映できるよう、main.jsのapply-settingsからここへ直接設定する
// モジュール内状態として持つ。
let configuredWpm = 0;
export function setReadingSpeedWpm(wpm) {
  configuredWpm = Number.isFinite(wpm) && wpm >= 1 ? Math.floor(wpm) : 0;
}

export function estimateReadingTime(charsWithoutSpace, words) {
  const minutes = configuredWpm > 0 ? words / configuredWpm : charsWithoutSpace / READING_CHARS_PER_MINUTE;
  if (minutes < 1) return "1分未満";
  return `約${Math.ceil(minutes)}分`;
}

// 文字数(空白含む/除く)・単語数・行数・段落数・読了時間をまとめて計算する(W-01/W-02)。
// 文書全体の走査を伴う重い処理のため、呼び出し側(main.js)は「入力のたびではなく、
// ポップアップを開いた瞬間にだけ呼ぶ」という性能方針を徹底すること。
export function computeTextStats(text) {
  const charsWithoutSpace = text.replace(/\s/g, "").length;
  const words = countWords(text);
  return {
    charsWithSpace: text.length,
    charsWithoutSpace,
    words,
    lines: text.split("\n").length,
    paragraphs: countParagraphs(text),
    readingTime: estimateReadingTime(charsWithoutSpace, words),
  };
}
