// 仕様書 第2.9節のマークダウン記法拡張で共有するユーティリティ。
// サイドバーのアウトライン(第2.8節 S-01、Phase 6で実装予定)とも
// 同じ見出し抽出ロジックを使うため、ここに独立させておく。
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

// extractHeadingsがensureFullParse時に構文木を最後まで伸ばすのに使う上限時間(ミリ秒)。
// src/md-to-html.jsの同名の定数と同じ考え方(一度きりの処理なので長めに取る)。
const ENSURE_PARSE_TIMEOUT_MS = 10000;

const HEADING_NODE_NAMES = new Set([
  "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2",
]);

function headingLevel(nodeName) {
  if (nodeName === "SetextHeading1") return 1;
  if (nodeName === "SetextHeading2") return 2;
  return Number(nodeName.slice(-1));
}

// アウトラインパネル(仕様書 chapterLevelInOutline)に出す見出しの最大レベル。
// サイドバー(src/sidebar.js、編集不可)はextractHeadings(state)を引数無しで直接呼ぶため、
// ここでの既定値をmain.js側からsetOutlineMaxLevel()で更新することでアウトライン表示だけを
// 絞り込む。[toc]記法・見出しへのジャンプ(editor.js)はこの既定値の影響を受けないよう、
// 呼び出し側でmaxLevelを明示的に6(全レベル)指定して呼ぶこと。
let outlineMaxLevel = 6;
export function setOutlineMaxLevel(n) {
  const v = Math.floor(n);
  outlineMaxLevel = Number.isFinite(v) ? Math.max(1, Math.min(6, v)) : 6;
}

// GitHub風の見出しスラグ生成。日本語等の非ASCII文字はそのまま残し、
// 空白をハイフンに、記号は除去する。
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()#>!.,:;'"“”‘’]/g, "")
    .replace(/\s+/g, "-");
}

// 見出し一覧を構文木から抽出する(全行の正規表現走査ではなく、見出しノードのみを辿る)。
// 目次ウィジェット・内部リンクのジャンプ先解決の両方から使う共通ロジック。
//
// ensureFullParse: 文書の末尾まで確実にパースしてから抽出するかどうか(既定false)。
//   CodeMirrorの構文木は遅延パースで、syntaxTree(state)は「今までにパースが済んだ範囲」
//   までしか伸びていない。EditorViewがある場合(本文のアウトラインパネル)はCodeMirrorが
//   アイドル時にバックグラウンドでパースを進めるため、少し待てば文書全体に追いつく。
//   そのため、入力のたびに呼ばれるアウトライン側は既定のfalseのままにして、1文字打つ
//   たびに全文パースが走らないようにする(第8章の入力遅延の目標を守るため)。
//   いっぽう取扱説明書ウィンドウ(src/help-entry.js)はEditorViewを作らずEditorStateだけを
//   組み立てて呼ぶため、バックグラウンドパース自体が動かず、放っておいても木が伸びない
//   (実測で425行の説明書のうち11見出しまでしか拾えず、目次が途中で切れていた)。
//   このように「一度きりの変換で、確実に文書全体が要る」呼び出し側だけtrueにする。
export function extractHeadings(state, maxLevel = outlineMaxLevel, { ensureFullParse = false } = {}) {
  const headings = [];
  const slugCount = new Map();
  const tree = ensureFullParse
    ? (ensureSyntaxTree(state, state.doc.length, ENSURE_PARSE_TIMEOUT_MS) ?? syntaxTree(state))
    : syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (!HEADING_NODE_NAMES.has(node.name)) return;
      const level = headingLevel(node.name);
      if (level > maxLevel) return false; // chapterLevelInOutlineより深い見出しはアウトラインに出さない
      let text;
      if (node.name.startsWith("Setext")) {
        // SetextHeadingは下線行(HeaderMark)を含むため、上のテキスト行のみを見出し文字列とする
        const firstLine = state.doc.lineAt(node.from);
        text = firstLine.text.trim();
      } else {
        const mark = node.node.getChild("HeaderMark");
        const from = mark ? mark.to : node.from;
        text = state.doc.sliceString(from, node.to).trim();
      }
      if (!text) return false;
      let slug = slugify(text) || "section";
      const n = slugCount.get(slug) ?? 0;
      slugCount.set(slug, n + 1);
      if (n > 0) slug = `${slug}-${n}`;
      headings.push({ level, text, from: node.from, to: node.to, slug });
      return false; // 見出し内部(インライン装飾)へは降りない
    },
  });
  return headings;
}

// [text](#heading) 形式の内部リンクのジャンプ先を、見出しスラグから解決する。
// アウトライン表示の絞り込み(chapterLevelInOutline)とは無関係に、全レベルの見出しを対象にする。
export function findHeadingBySlug(state, slug) {
  const target = slug.toLowerCase();
  return extractHeadings(state, 6).find((h) => h.slug === target);
}

// よく使われる範囲の絵文字ショートコード(仕様書 M-22)。
// 全Unicode絵文字を最初から網羅する必要はないため、GitHub等でも頻出する
// 代表的なものに絞る。
export const EMOJI_SHORTCODES = {
  smile: "😄", smiley: "😃", grin: "😁", laughing: "😆", joy: "😂",
  wink: "😉", blush: "😊", innocent: "😇", relaxed: "☺️", heart_eyes: "😍",
  kissing_heart: "😘", thinking: "🤔", neutral_face: "😐", expressionless: "😑",
  unamused: "😒", sweat_smile: "😅", pensive: "😔", confused: "😕",
  cry: "😢", sob: "😭", angry: "😠", rage: "😡", scream: "😱",
  tired_face: "😫", sleepy: "😪", sleeping: "😴", mask: "😷",
  sunglasses: "😎", astonished: "😲", flushed: "😳", cold_sweat: "😰",
  wave: "👋", thumbsup: "👍", "+1": "👍", thumbsdown: "👎", "-1": "👎",
  clap: "👏", pray: "🙏", muscle: "💪", ok_hand: "👌", point_up: "☝️",
  raised_hands: "🙌", handshake: "🤝", eyes: "👀", heart: "❤️",
  broken_heart: "💔", sparkles: "✨", star: "⭐", fire: "🔥", boom: "💥",
  zap: "⚡", tada: "🎉", confetti_ball: "🎊", gift: "🎁", balloon: "🎈",
  100: "💯", warning: "⚠️", no_entry: "⛔", white_check_mark: "✅",
  x: "❌", heavy_check_mark: "✔️", question: "❓", exclamation: "❗",
  bulb: "💡", memo: "📝", pencil2: "✏️", book: "📖", books: "📚",
  bookmark: "🔖", pushpin: "📌", round_pushpin: "📍", link: "🔗",
  wrench: "🔧", hammer: "🔨", gear: "⚙️", lock: "🔒", key: "🔑",
  mag: "🔍", bell: "🔔", email: "📧", calendar: "📅", clock1: "🕐",
  hourglass: "⌛", rocket: "🚀", airplane: "✈️", car: "🚗",
  house: "🏠", coffee: "☕", pizza: "🍕", beer: "🍺", cake: "🍰",
  sun: "☀️", cloud: "☁️", rainbow: "🌈", moon: "🌙", snowflake: "❄️",
  dog: "🐶", cat: "🐱", bug: "🐛", octocat: "🐙",
};

export function findEmojiCompletions(query) {
  const q = query.toLowerCase();
  return Object.keys(EMOJI_SHORTCODES)
    .filter((code) => code.toLowerCase().startsWith(q))
    .slice(0, 30)
    .map((code) => ({ code, emoji: EMOJI_SHORTCODES[code] }));
}

// GitHub式アラート(仕様書 M-13)の種別。ラベルは日本語表記、アイコン形状は
// note/tip/important は情報系、warning/caution は注意系の2系統に分けて
// 視覚的に区別する(色相を持たないデザイントークンのため、形状と濃淡で差を付ける)。
export const CALLOUT_TYPES = {
  note: { label: "メモ", shape: "info" },
  tip: { label: "ヒント", shape: "info" },
  important: { label: "重要", shape: "info" },
  warning: { label: "警告", shape: "alert" },
  caution: { label: "注意", shape: "alert" },
};
