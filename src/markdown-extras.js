// 仕様書 第2.9節のマークダウン記法拡張で共有するユーティリティ。
// サイドバーのアウトライン(第2.8節 S-01、Phase 6で実装予定)とも
// 同じ見出し抽出ロジックを使うため、ここに独立させておく。
import { syntaxTree } from "@codemirror/language";

const HEADING_NODE_NAMES = new Set([
  "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2",
]);

function headingLevel(nodeName) {
  if (nodeName === "SetextHeading1") return 1;
  if (nodeName === "SetextHeading2") return 2;
  return Number(nodeName.slice(-1));
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
export function extractHeadings(state) {
  const headings = [];
  const slugCount = new Map();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (!HEADING_NODE_NAMES.has(node.name)) return;
      const level = headingLevel(node.name);
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
export function findHeadingBySlug(state, slug) {
  const target = slug.toLowerCase();
  return extractHeadings(state).find((h) => h.slug === target);
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
