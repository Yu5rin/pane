// 設定画面(仕様書 第2.10節 C-01〜C-14)。
// 製品相当のサイドバー形式(左: カテゴリ一覧、右: 設定項目)のモーダルオーバーレイを
// HTML側だけで組み立てる。C#側のブリッジは実装済みで、使うメッセージは以下の4つ:
//   送信 { type: "get-settings" }                         → 受信 { type: "settings", ...全項目... }
//   送信 { type: "save-settings", settings: {...全項目...} } → 受信 { type: "save-settings-result", ok, error, blockedExtensions? }
// 上記2つの受信メッセージはmain.js側のhandleHostMessageから
// handleSettingsLoaded(msg) / handleSaveResult(msg) として本モジュールへ渡してもらう想定。
// これに加えて「参照…」ボタン用の { type: "browse-path-result", field, path } は、main.js側の
// ルーティングを待たずに済むよう、本モジュール自身がctx.bridgeへ直接addEventListenerして拾う
// (WebView2のaddEventListenerは複数リスナーを許すため、main.js側の唯一のリスナーと共存できる)。
//
// 設定キー・型・既定値・カテゴリ分けは docs/設定項目一覧.md を正とする。本ファイルの
// FIELD_DEFS はその表をそのままJSの形にしたもので、キー名を変えたり値を増やしたりしない。
//
// createSettings(ctx) の戻り値: { open(category), close(), isOpen(), handleSettingsLoaded, handleSaveResult }
// ctxに期待するもの:
//   bridge      window.chrome.webview または null(無ければ「保存」できないが、画面自体は開ける)
//   commands    buildCommands(ctx)の戻り値(キーバインドタブの一覧に使う)
//   shortcutsSuppressed  真偽値の書き込み用フラグ。キーバインド再設定中はtrueにして、
//                        commands.js側の全域ショートカット発火を止めてもらう(bindShortcuts参照)。
import { FILE_TYPES, CATEGORIES } from "./file-types.js";
import { MENU_LABELS, isAssignableShortcut } from "./commands.js";
import { paneConfirm, paneAlert } from "./dialog.js";
// Tabキーでのフォーカス閉じ込め・開閉時のフォーカス退避復帰は、独自ダイアログ(dialog.js)や
// コマンドパレット(commands.js)と全く同じロジックのため、共通モジュール(focus-trap.js)を使う
// (role="dialog" aria-modal="true"を付けているのにTabで背後のメニューバーへ抜けてしまう、
// という不整合を無くすため。詳細はfocus-trap.js側のコメント参照)。
import { trapTabKey, focusModal } from "./focus-trap.js";
// ツールチップの詳しさ(依頼2)。文言テーブル自体はsrc/tooltips.jsに集約してあり、
// ここでは設定画面自身の各項目(チェックボックス・セレクト等)にdata-tip属性で識別子を
// 振り、現在選んでいる段階(draft.tooltipDetail)に応じてtitleを組み立てるのに使う。
import { resolveTooltip, DEFAULT_TOOLTIP_DETAIL, TOOLTIP_LEVELS } from "./tooltips.js";

// 本文フォントサイズの既定値(src/editor.js の DEFAULT_FONT_SIZE と同じ値)。
// editor.jsから直接importしないのは、設定画面専用ウィンドウ(settings-entry.js)の
// バンドルにCodeMirror本体を巻き込まないため(この定数1つのためだけにeditor.jsの
// バンドルへ依存すると、settings-entry.js側のチャンクが不必要に肥大化する)。
// editor.js側の値を変える場合はこちらも合わせて変更すること。
const DEFAULT_FONT_SIZE = 15;

// ---- アイコン(仕様書の絵文字禁止・アイコン規約: viewBox 0 0 24 24, stroke=currentColor) ----
const ICON_ATTRS = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const ICON_CLOSE = `<svg ${ICON_ATTRS}><path d="M6 6l12 12M18 6 6 18"/></svg>`;
const ICON_GENERAL = `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.5 7.5 0 0 0 0-2l1.9-1.4-2-3.4-2.2.6a7.6 7.6 0 0 0-1.7-1L14.9 3.5h-4l-.5 2.3a7.6 7.6 0 0 0-1.7 1l-2.2-.6-2 3.4L6.4 11a7.5 7.5 0 0 0 0 2l-1.9 1.4 2 3.4 2.2-.6a7.6 7.6 0 0 0 1.7 1l.5 2.3h4l.5-2.3a7.6 7.6 0 0 0 1.7-1l2.2.6 2-3.4z"/></svg>`;
const ICON_FILE = `<svg ${ICON_ATTRS}><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 21v-6h6v6"/></svg>`;
const ICON_EDIT = `<svg ${ICON_ATTRS}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const ICON_MARKDOWN = `<svg ${ICON_ATTRS}><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>`;
const ICON_IMAGE = `<svg ${ICON_ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16.5 15.5 11 6 20"/></svg>`;
const ICON_EXPORT = `<svg ${ICON_ATTRS}><path d="M6 9V4h9l3 3v2"/><rect x="3.5" y="9" width="17" height="7.5" rx="1"/><path d="M7.5 20.5h9v-4h-9z"/></svg>`;
const ICON_APPEARANCE = `<svg ${ICON_ATTRS}><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2s-.4-1.5-.9-2-.2-2 1-2H16a4 4 0 0 0 4-4c0-4.4-3.6-8-8-8Z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15" cy="8" r="1"/><circle cx="16.5" cy="12" r="1"/></svg>`;
const ICON_FILETYPES = `<svg ${ICON_ATTRS}><path d="M9 15l6-6"/><path d="M10 6l.7-.7a4 4 0 1 1 5.7 5.7l-.7.7"/><path d="M14 18l-.7.7a4 4 0 1 1-5.7-5.7l.7-.7"/></svg>`;
const ICON_KEYBOARD = `<svg ${ICON_ATTRS}><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12"/></svg>`;
const ICON_ADVANCED = `<svg ${ICON_ATTRS}><path d="M4 6h9M17 6h3M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="15" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>`;
const ICON_VERSION_INFO = `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/></svg>`;
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

// 編集モードの自動判定(仕様: C#側AppSettings.AutoDetectModeと同じ4値、既定はstandard)。
const AUTO_DETECT_MODES = ["off", "suggest", "standard", "aggressive"];

// ---- 左サイドバーのカテゴリ ----
// 元は仕様書指定の10カテゴリだったが、使いやすさ改善(よく使う順・関連性の高い順への
// 並び替え)の一環でGraftと同じく末尾に「バージョン情報」を追加し、11カテゴリとした。
// カテゴリ自体の並びは元のまま(一般→ファイル→編集→Markdown→画像→エクスポート→外観→
// 関連付け→キーボード→詳細という「基本→内容→見た目→システム連携→高度な設定」の流れが
// 一般的なエディタ(VS Code・Typora)の構成に近く合理的なため)。「バージョン情報」のみ
// 必ず最後に置く。
const NAV_ITEMS = [
  { id: "general", label: "一般", icon: ICON_GENERAL },
  { id: "file", label: "ファイル", icon: ICON_FILE },
  { id: "edit", label: "編集", icon: ICON_EDIT },
  { id: "markdown", label: "Markdown", icon: ICON_MARKDOWN },
  { id: "image", label: "画像", icon: ICON_IMAGE },
  { id: "export", label: "エクスポート・印刷", icon: ICON_EXPORT },
  { id: "appearance", label: "外観", icon: ICON_APPEARANCE },
  { id: "fileTypes", label: "ファイルの関連付け", icon: ICON_FILETYPES },
  { id: "keyboard", label: "キーボード", icon: ICON_KEYBOARD },
  { id: "advanced", label: "詳細", icon: ICON_ADVANCED },
  { id: "versionInfo", label: "バージョン情報", icon: ICON_VERSION_INFO },
];

// ---- 検索欄用の索引(カテゴリID → そのカテゴリ内に出てくる語)。厳密な自動生成はせず、
// 各カテゴリの見出し・項目ラベルを手で列挙する(項目を増やしたときはここにも追記すること)。----
const SEARCH_INDEX = {
  general: ["起動時の動作", "前回開いていたファイルを復元", "何も開かない", "指定したフォルダを開く", "起動フォルダ", "最後のウィンドウを閉じたら終了", "常駐", "起動を速く", "ステータスバー", "アウトライン", "折りたたみ", "最近使ったファイル", "ホイールで拡大縮小", "ツールチップ", "説明の詳しさ", "マウスカーソル", "ヘルプ"],
  file: ["自動保存", "保存の間隔", "未保存の下書き", "復元", "ファイル切替", "文字コード", "エンコード", "改行コード", "既定の拡張子"],
  edit: ["インデント幅", "コードブロック", "折り返し", "Shift", "Tab", "自動ペアリング", "括弧", "引用符", "絵文字", "自動補完", "生表示", "コピー形式", "行コピー", "タイプライター", "スペルチェック", "自動修正", "読了時間", "読了速度", "自動判定", "拡張子ごとの編集モード", "カラープレビュー", "色のプレビュー", "色", "スウォッチ", "カラーピッカー", "現在の行", "現在行", "アクティブ行", "強調表示", "行番号ガター"],
  markdown: ["インライン数式", "数式", "上付き", "下付き", "ハイライト", "作図", "ダイアグラム", "自動リンク", "Callouts", "厳格モード", "見出しの記法", "箇条書き", "リスト記号", "番号付きリスト", "行番号", "自動採番", "アウトラインの階層", "コード言語", "空白", "改行", "スマート引用符", "スマートダッシュ", "句読点"],
  image: ["画像の挿入", "画像フォルダ", "ローカル画像", "オンライン画像", "相対パス", "URLエスケープ"],
  export: ["用紙サイズ", "余白", "マージン", "ヘッダー", "フッター", "ページ区切り", "アウトライン", "書き出し先フォルダ", "書き出し後", "保存ダイアログ", "数式の書き出し", "YAML", "フロントマター", "印刷"],
  appearance: ["テーマ", "ライトテーマ", "ダークテーマ", "本文フォント", "等幅フォント", "フォント", "文字サイズ", "行の高さ", "行間", "最大幅", "文字数カウント", "カスタムCSS"],
  fileTypes: ["拡張子", "関連付け", "エクスプローラー", "新規作成メニュー", "既定のアプリ"],
  keyboard: ["キーバインド", "ショートカット", "キー割り当て"],
  advanced: ["デバッグ", "隠しファイル", "除外パターン", "設定ファイルの場所", "既定に戻す", "リセット", "履歴を消去", "編集モードの記憶", "既定のアプリ設定"],
  versionInfo: ["バージョン", "アプリのバージョン", "WebView2", "ランタイム", ".NET", "設定ファイルの場所", "ログファイル", "ログの場所", "カスタムCSSフォルダ", "テーマフォルダ", "ライセンス", "OSS", "オープンソース", "About"],
};

// ---- 設定項目のスキーマ(docs/設定項目一覧.mdをそのままJSにしたもの) ----
// kind: "bool" | "number" | "enum" | "string" | "nullableString"
// number は min/max(資料に範囲が明記されている項目のみ)、values(離散値、セレクトで扱う)、
// step(既定1)を持てる。nullableString は空文字を保存時にnullへ変換する(string?型の項目)。
const FIELD_DEFS = {
  // ---- 一般 ----
  startupBehavior: { kind: "enum", values: ["blank", "restoreSession", "customFolder"], def: "blank" },
  startupFolderPath: { kind: "nullableString", def: "" },
  quitOnLastWindowClosed: { kind: "bool", def: true },
  preloadOnStartup: { kind: "bool", def: false },
  showStatusBar: { kind: "bool", def: true },
  showOutlineByDefault: { kind: "bool", def: false },
  collapsibleOutline: { kind: "bool", def: true },
  // サイドバー幅(ユーザー要望、ドラッグでのリサイズ結果)。displayModeと同じ理由で、
  // 設定画面には切替UIを一切出さない(ドラッグで直接変えられるものを設定画面にも
  // 置くと二重になるため)が、FIELD_DEFS自体は残す(直接編集された値もdraftが保持・
  // 保存できるように)。
  sidebarWidthPx: { kind: "number", def: 240, min: 180, max: 600 },
  recordRecentFiles: { kind: "bool", def: true },
  zoomWithCtrlWheel: { kind: "bool", def: true },
  // ツールチップの詳しさ(依頼2)。none/minimal/standard/detailedの4段階、既定はstandard。
  // 文言そのものはsrc/tooltips.jsのTOOLTIPS(将来のF1ヘルプ/多言語対応でも共用する想定)。
  tooltipDetail: { kind: "enum", values: TOOLTIP_LEVELS, def: DEFAULT_TOOLTIP_DETAIL },
  // 表示形式(仕様書 第2.10節 C-14)。タブ形式は実装済みだが、ユーザー指示により設定画面には
  // 切替UIを一切出さない(意図してウィンドウ形式から変更できないようにする隠し機能)。
  // settings.jsonを直接テキストエディタで編集して"tab"にした場合のみ有効になる。
  // FIELD_DEFS自体は残しておく(UIが無くても、直接編集された値をdraftが保持・保存できるように
  // するため。UIが無い=保存もしない、にはしない)。
  displayMode: { kind: "enum", values: ["window", "tab"], def: "window" },

  // ---- ファイル(保存と復元) ----
  autoSaveEnabled: { kind: "bool", def: true },
  autoSaveIntervalSeconds: { kind: "number", def: 30, min: 5, max: 600 },
  recoverUnsavedDrafts: { kind: "bool", def: true },
  saveWithoutAskingOnSwitch: { kind: "bool", def: false },
  defaultEncoding: { kind: "enum", values: ["utf8", "utf8bom", "shiftjis", "utf16le"], def: "utf8" },
  defaultLineEnding: { kind: "enum", values: ["crlf", "lf"], def: "crlf" },
  defaultFileExtension: { kind: "string", def: "md" },

  // ---- 編集 ----
  indentSizeOnSave: { kind: "number", def: 4, values: [2, 4, 8] },
  codeIndentSize: { kind: "number", def: 4, values: [2, 4, 8] },
  codeFoldingEnabled: { kind: "bool", def: true },
  codeIndentGuides: { kind: "enum", values: ["none", "fold", "all"], def: "fold" },
  codeAutoWrap: { kind: "bool", def: true },
  codeActiveLineHighlight: { kind: "bool", def: true },
  colorPreviewInCode: { kind: "bool", def: true },
  shiftTabAutoIndent: { kind: "bool", def: false },
  autoPairing: { kind: "bool", def: true },
  autoPairMarkdown: { kind: "bool", def: true },
  emojiAutocomplete: { kind: "enum", values: ["off", "esc", "auto"], def: "auto" },
  liveRenderingShowSourceOnFocus: { kind: "bool", def: true },
  defaultCopyFormat: { kind: "enum", values: ["markdown", "html"], def: "markdown" },
  copyWholeLineWhenNoSelection: { kind: "bool", def: true },
  typewriterKeepCaretCentered: { kind: "bool", def: true },
  spellCheckEnabled: { kind: "bool", def: false },
  spellCheckAutoCorrect: { kind: "bool", def: false },
  readingSpeedWpm: { kind: "number", def: 0, min: 0, max: 2000 },
  autoDetectMode: { kind: "enum", values: AUTO_DETECT_MODES, def: "standard" },

  // ---- Markdown: 記法サポート ----
  inlineMathEnabled: { kind: "bool", def: false },
  codeBlockMathEnabled: { kind: "bool", def: false },
  superSubscriptEnabled: { kind: "bool", def: true },
  highlightEnabled: { kind: "bool", def: true },
  diagramsEnabled: { kind: "bool", def: true },
  autoLinksEnabled: { kind: "bool", def: true },
  calloutsEnabled: { kind: "bool", def: true },
  // ---- Markdown: 記法の書き方 ----
  strictMode: { kind: "bool", def: false },
  headingStyle: { kind: "enum", values: ["atx", "setext"], def: "atx" },
  unorderedListMarker: { kind: "enum", values: ["-", "*", "+"], def: "-" },
  orderedListMarker: { kind: "enum", values: [".", ")"], def: "." },
  codeBlockLineNumbers: { kind: "bool", def: true },
  mathAutoNumber: { kind: "enum", values: ["off", "ams", "all"], def: "off" },
  chapterLevelInOutline: { kind: "number", def: 6, min: 1, max: 6 },
  defaultCodeLanguage: { kind: "string", def: "" },
  defaultCodeLanguageApplyWhen: { kind: "enum", values: ["markdown", "menubar", "both"], def: "menubar" },
  // ---- Markdown: 空白と改行 ----
  whitespaceWhenWriting: { kind: "enum", values: ["preserve", "ignore"], def: "preserve" },
  whitespaceOnExport: { kind: "enum", values: ["preserve", "ignore"], def: "ignore" },
  // ---- Markdown: スマート置換 ----
  smartQuotes: { kind: "enum", values: ["off", "input", "render"], def: "off" },
  smartDashes: { kind: "enum", values: ["off", "endash", "emdash"], def: "off" },
  recognizeUnicodePunctuation: { kind: "bool", def: false },

  // ---- 画像 ----
  imageInsertAction: { kind: "enum", values: ["none", "currentFolder", "assets", "filenameAssets", "custom"], def: "none" },
  imageCustomFolder: { kind: "string", def: "" },
  imageApplyToLocal: { kind: "bool", def: true },
  imageApplyToOnline: { kind: "bool", def: false },
  imagePreferRelativePath: { kind: "bool", def: true },
  imageAddDotSlash: { kind: "bool", def: false },
  imageAutoEscapeUrl: { kind: "bool", def: true },

  // ---- エクスポート・印刷 ----
  exportPaperSize: { kind: "enum", values: ["a4", "a3", "b5", "letter", "legal", "tabloid", "custom"], def: "a4" },
  exportCustomWidthMm: { kind: "number", def: 210, min: 10, max: 2000 },
  exportCustomHeightMm: { kind: "number", def: 297, min: 10, max: 2000 },
  exportOrientation: { kind: "enum", values: ["portrait", "landscape"], def: "portrait" },
  exportMarginTopMm: { kind: "number", def: 20, min: 0, max: 300 },
  exportMarginBottomMm: { kind: "number", def: 20, min: 0, max: 300 },
  exportMarginLeftMm: { kind: "number", def: 20, min: 0, max: 300 },
  exportMarginRightMm: { kind: "number", def: 20, min: 0, max: 300 },
  exportHeaderText: { kind: "string", def: "" },
  exportFooterText: { kind: "string", def: "" },
  exportPageBreakBetweenTopHeadings: { kind: "bool", def: false },
  exportIncludeOutline: { kind: "bool", def: false },
  exportOutlineWidthPx: { kind: "number", def: 260, min: 100, max: 800 },
  exportAppendHead: { kind: "string", def: "" },
  exportAppendBody: { kind: "string", def: "" },
  exportDefaultFolder: { kind: "enum", values: ["sameAsFile", "custom"], def: "sameAsFile" },
  exportCustomFolder: { kind: "string", def: "" },
  exportAfter: { kind: "enum", values: ["none", "openFile", "openFolder"], def: "none" },
  exportShowSaveDialog: { kind: "bool", def: true },
  exportMathAs: { kind: "enum", values: ["svg", "latex"], def: "svg" },
  exportReadYamlFrontMatter: { kind: "bool", def: true },

  // ---- 外観 ----
  theme: { kind: "enum", values: ["light", "dark", "system"], def: "system" },
  lightTheme: { kind: "enum", values: ["default", "sepia", "github", "solarized-light"], def: "default" },
  darkTheme: { kind: "enum", values: ["default", "nord", "dracula", "solarized-dark", "night"], def: "default" },
  useSeparateThemeInDarkMode: { kind: "bool", def: true },
  customCssPath: { kind: "nullableString", def: "" },
  editorFontFamily: { kind: "nullableString", def: "" },
  editorMonospaceFontFamily: { kind: "nullableString", def: "" },
  editorFontSize: { kind: "number", def: DEFAULT_FONT_SIZE, min: 8, max: 72 },
  // 仕様書 第10.3節: 本文の行送りは1.95(日本語のため現行の1.85から広げる)。
  editorLineHeight: { kind: "number", def: 1.95, min: 1.0, max: 3.0, step: 0.05 },
  // 仕様書 第10.3節: 本文の最大幅は42文字相当。全角文字はおおよそ正方形(幅=フォントサイズの
  // 1em)とみなせるため、全角42文字分を「既定フォントサイズ(DEFAULT_FONT_SIZE) × 42」で
  // 算出する(Pane/AppSettings.csの既定値と同じ計算式・同じ値に揃えること)。
  // Markdownモードのときだけ適用する(コード/プレーンテキストは無制限のまま。src/style.css参照)。
  // 0を指定すると従来どおり無制限になる。
  editorMaxWidthPx: { kind: "number", def: DEFAULT_FONT_SIZE * 42, min: 0, max: 5000 },
  // 左右個別に指定できる(ユーザー要望)。旧・editorPaddingX(左右共通1値)からの移行は
  // Pane/AppSettings.cs GetEffectiveEditorPaddingLeft/Rightが行う。
  editorPaddingLeft: { kind: "number", def: 32, min: 0, max: 200 },
  editorPaddingRight: { kind: "number", def: 32, min: 0, max: 200 },
  showWordCount: { kind: "bool", def: true },

  // ---- ファイルの関連付け ----
  explorerNewMenuEnabled: { kind: "bool", def: false },

  // ---- 詳細 ----
  enableDebug: { kind: "bool", def: false },
  verboseLogging: { kind: "bool", def: false },
  showHiddenFilesInTree: { kind: "bool", def: false },
  addToPath: { kind: "bool", def: false },
};

function coerceIncoming(def, raw) {
  switch (def.kind) {
    case "bool": return typeof raw === "boolean" ? raw : def.def;
    case "number": return Number.isFinite(raw) ? raw : def.def;
    case "enum": return def.values.includes(raw) ? raw : def.def;
    case "string": return typeof raw === "string" ? raw : def.def;
    case "nullableString": return typeof raw === "string" ? raw : def.def; // nullはdef("")へ
    default: return def.def;
  }
}

function coerceOutgoing(def, val) {
  switch (def.kind) {
    case "bool": return !!val;
    case "number": {
      let n = Number(val);
      if (!Number.isFinite(n)) n = def.def;
      if (Array.isArray(def.values)) {
        // 離散値(2|4|8など): 一致しなければ最も近い値へ丸める
        if (!def.values.includes(n)) n = def.values.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), def.values[0]);
      } else {
        if (Number.isFinite(def.min)) n = Math.max(def.min, n);
        if (Number.isFinite(def.max)) n = Math.min(def.max, n);
      }
      return n;
    }
    case "enum": return def.values.includes(val) ? val : def.def;
    case "string": return typeof val === "string" ? val : def.def;
    case "nullableString": return val ? val : null;
    default: return val;
  }
}

// scalar項目(FIELD_DEFS)+ 複合項目(オブジェクト・配列)の両方を含む既定値。
// ブリッジが無い(ブラウザ単体)場合や、get-settingsの応答が届く前に使う。
const DEFAULTS = {
  ...Object.fromEntries(Object.entries(FIELD_DEFS).map(([k, d]) => [k, d.def])),
  keyBindings: {},
  associatedExtensions: [],
  fileModeOverrides: {},
  fileTreePatterns: [],
  perFileModes: {},
  installedFonts: [],
  monospaceFonts: [],
  pandocAvailable: false,
  settingsFilePath: "",
  // ---- 「バージョン情報」カテゴリ表示専用(保存対象ではない環境情報) ----
  appVersion: "",
  webView2Version: "",
  dotNetVersion: "",
  logFolderPath: "",
  themeFolderPath: "",
  licenses: [],
};

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

// ---- ファイルの関連付け(3階層チェックボックス)用の下ごしらえ ----
// FILE_TYPES/CATEGORIESは静的なので、カテゴリ→言語の対応づけは一度だけ計算しておく。
const CATEGORY_ORDER = Object.keys(CATEGORIES);
const TYPES_BY_CATEGORY = new Map(CATEGORY_ORDER.map((key) => [key, FILE_TYPES.filter((t) => t.category === key)]));
const ALL_EXTENSIONS = FILE_TYPES.flatMap((t) => t.extensions);
const MARKDOWN_EXTENSIONS = FILE_TYPES.find((t) => t.id === "markdown").extensions;

// ---- キーバインド捕捉時の組み合わせ文字列化 ----
// commands.jsのparseShortcut/matchesShortcutが解釈できる形("Ctrl+Shift+K"のように"+"区切り、
// 修飾子はCtrl/Shift/Alt)に合わせる。記号キーはcommands.js側もe.code(物理キー)で判定して
// いるため、ここでも同じ7キーだけはe.codeから逆引きし、Shift併用時にe.keyが別文字になる
// 問題(例: Shift+` は e.key が "~")を避ける。
const SYMBOL_CODE_REVERSE = { Backquote: "`", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Digit0: "0" };
function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const key = SYMBOL_CODE_REVERSE[e.code] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}

// ---- 汎用のHTML断片組み立てヘルパー ----
// wireCommonFields(data-field方式)にそのまま乗るマークアップを返すだけの関数群。
// 「新しいクラスは本当に必要なときだけ」の方針に従い、既存の
// settings-checkbox-row/settings-select-row/settings-text-row/settings-field-descを使い回す。
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// ---- 現在の関連付け先(「ファイルの関連付け」カテゴリ) ----
// Paneはインストーラ無しのポータブル配布のため、exeの置き場所が自由。関連付けは登録した
// 時点のexeのフルパスをレジストリへ書くので、新しいバージョンを別の場所に置いて使い始めても、
// ファイルをダブルクリックしたときには古いバージョンが起動し続ける(実際にv1.0.0を掴んだまま
// v1.0.1を使っているつもりになる事故が起きた)。それを利用者に見せて直せるようにするための
// 表示とボタン。
//
// 判定は「パスが違うかどうか」ではなく「関連付け先exeのバージョンが今より古いかどうか」で行う
// (同じバージョンが別の場所にあるだけなら実害が無いので警告しない)。状態はC#側
// (FileAssociationService.GetCurrentTarget)が決める6種類:
//   older   … 今より古いバージョンを指している(これが主な警告対象)
//   same    … 今と同じバージョン(パスが違っていても問題なし)
//   newer   … 今より新しいバージョン。上書きすると新しい版が起動しなくなるので文言を分ける
//   unknown … exeはあるがバージョンを読み取れなかった
//   missing … 登録先のexeが存在しない(壊れている)
//   none    … 関連付けが1つも登録されていない
const ASSOC_STATUSES = ["older", "same", "newer", "unknown", "missing", "none"];
// 「関連付けを今のPaneに更新」ボタンが送るsave-settingsに付ける目印。C#側はこれを
// そのままsave-settings-resultへ返してくるので、通常の「保存」ボタンの結果と区別できる。
const ASSOC_REFRESH_REASON = "refresh-file-association";

function normalizeAssocTarget(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    status: ASSOC_STATUSES.includes(v.status) ? v.status : "none",
    path: typeof v.path === "string" ? v.path : "",
    currentPath: typeof v.currentPath === "string" ? v.currentPath : "",
    extensionCount: Number.isFinite(v.extensionCount) ? v.extensionCount : 0,
    registeredVersion: typeof v.registeredVersion === "string" ? v.registeredVersion : "",
    currentVersion: typeof v.currentVersion === "string" ? v.currentVersion : "",
  };
}

// バージョン表記の表示用("1.0.1" → "v1.0.1"。読めなかった場合は「バージョン不明」)。
function assocVersionLabel(text) {
  return text ? `v${escapeHtml(text)}` : "バージョン不明";
}

// ---- 設定項目のツールチップ(依頼2) ----
// src/tooltips.jsのTOOLTIPSに個別の文言が無い項目のフォールバックとして、
// 「ラベル。説明」の形の文言を組み立てるための下ごしらえ。field*ヘルパーが
// 呼ばれるたびに、その項目の(HTMLタグを除いた)ラベルと説明文をここへ登録しておく。
const FIELD_TOOLTIP_FALLBACK = {};
function stripHtml(s) {
  return String(s ?? "").replace(/<[^>]*>/g, "");
}
function registerFieldFallback(key, label, desc) {
  FIELD_TOOLTIP_FALLBACK[key] = { label: stripHtml(label), desc: stripHtml(desc) };
}
// invert: true を渡すと、チェックボックスの見た目(チェックON/OFF)と実際の設定値
// (draft[key])を反転させる。quitOnLastWindowClosed用(依頼: 「最後のウィンドウを閉じても
// 常駐させる」という、チェックを付けると常駐する向きのUIにしたいが、設定キー自体は
// 既存互換のため反転させずに残す)。data-invert属性を付け、実際の反転処理はここではなく
// wireCommonFields側で行う(値の読み書きが集約されている場所と揃えるため)。
// data-tip: ツールチップの識別子(依頼2)。外側の<label>全体をホバー対象にする
// (チェックボックス本体だけでなくラベル文字にカーソルを合わせても出るように)。
function fieldCheckbox(key, title, desc, { invert = false } = {}) {
  registerFieldFallback(key, title, desc);
  return `<label class="settings-checkbox-row" data-tip="${key}"><input type="checkbox" data-field="${key}"${invert ? " data-invert" : ""}><span class="settings-checkbox-title">${title}${desc ? `<span class="settings-field-desc">${desc}</span>` : ""}</span></label>`;
}
function fieldSelect(key, label, options, desc) {
  registerFieldFallback(key, label, desc);
  const opts = options.map(([v, t]) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`).join("");
  return `<label class="settings-select-row" data-tip="${key}">${label}
      <select data-field="${key}">${opts}</select>
      ${desc ? `<span class="settings-field-desc">${desc}</span>` : ""}
    </label>`;
}
// indentSizeOnSave/codeIndentSizeのような離散数値(2|4|8)をセレクトで扱う。
// data-numericを付け、wireCommonFields側でNumber変換させる。
function fieldNumericSelect(key, label, desc) {
  registerFieldFallback(key, label, desc);
  const def = FIELD_DEFS[key];
  const opts = def.values.map((v) => `<option value="${v}">${v}</option>`).join("");
  return `<label class="settings-select-row" data-tip="${key}">${label}
      <select data-field="${key}" data-numeric>${opts}</select>
      ${desc ? `<span class="settings-field-desc">${desc}</span>` : ""}
    </label>`;
}
function fieldNumber(key, label, desc) {
  registerFieldFallback(key, label, desc);
  const def = FIELD_DEFS[key] ?? {};
  const attrs = [];
  if (Number.isFinite(def.min)) attrs.push(`min="${def.min}"`);
  if (Number.isFinite(def.max)) attrs.push(`max="${def.max}"`);
  attrs.push(`step="${def.step ?? 1}"`);
  return `<label class="settings-text-row" data-tip="${key}">${label}
      <input type="number" data-field="${key}" ${attrs.join(" ")}>
      ${desc ? `<span class="settings-field-desc">${desc}</span>` : ""}
    </label>`;
}
function fieldText(key, label, placeholder, desc) {
  registerFieldFallback(key, label, desc);
  return `<label class="settings-text-row" data-tip="${key}">${label}
      <input type="text" data-field="${key}" placeholder="${escapeHtml(placeholder || "")}">
      ${desc ? `<span class="settings-field-desc">${desc}</span>` : ""}
    </label>`;
}
function fieldTextarea(key, label, desc, opts) {
  registerFieldFallback(key, label, desc);
  const lines = opts && opts.lines;
  const rows = (opts && opts.rows) || 3;
  return `<label class="settings-text-row" data-tip="${key}">${label}
      <textarea data-field="${key}"${lines ? " data-lines" : ""} rows="${rows}"></textarea>
      ${desc ? `<span class="settings-field-desc">${desc}</span>` : ""}
    </label>`;
}
// フォルダ・ファイルパスを選ぶ項目(startupFolderPath/imageCustomFolder/exportCustomFolder/
// customCssPath)。テキスト入力+「参照…」ボタン。ボタンはbridgeへbrowse-pathを送るだけで、
// 返信(browse-path-result)が来なくても崩れない(ブリッジが無ければボタン自体を無効化する)。
function fieldPath(ctx, key, kind, label, placeholder, desc) {
  registerFieldFallback(key, label, desc);
  const disabledAttr = ctx.bridge ? "" : " disabled";
  return `<label class="settings-path-row" data-tip="${key}">${label}
      <span class="settings-path-input-row">
        <input type="text" data-field="${key}" placeholder="${escapeHtml(placeholder || "")}">
        <button type="button" class="btn tiny settings-path-browse-btn" data-browse-field="${key}" data-browse-kind="${kind}"${disabledAttr}>参照…</button>
      </span>
      ${desc ? `<span class="settings-field-desc">${desc}</span>` : ""}
    </label>`;
}

const REPLACEMENT_TOKENS_DESC = "使える置換文字列: <code>{title}</code> <code>{page}</code> <code>{pages}</code> <code>{date}</code> <code>{time}</code> <code>{path}</code>";

// mode: "modal"(既定、本文と同じウィンドウの中にオーバーレイで出す) | "page"
// (専用ウィンドウの中身としてウィンドウ全体に広がる形で出す。設定専用ウィンドウ
// (settings-entry.js)から使う。オーバーレイの黒背景・角丸・影を出さない点だけが違い、
// DOM構造・データの流れ・保存/検証ロジックはすべて共通)。
export function createSettings(ctx, { mode = "modal" } = {}) {
  let overlay = null;
  // 「開いている(=ユーザーに見えている)か」を表すフラグ。以前は!!overlayで代用していたが、
  // pageモード(専用ウィンドウ)ではウィンドウを閉じてもoverlay(DOM)を破棄せず残すように
  // なったため(実バグ①の修正、destroy()参照)、overlayの有無と「開いているか」が一致しなく
  // なった。isOpen()・schedulePrefetch()はこちらを見る。
  // 注意(pageモードでの制約): open()〜destroy()の間だけtrueにする、というJS側から見える
  // 唯一のライフサイクルで判定している。pageモードでは専用ウィンドウを閉じたあとC#側が
  // インスタンスを再利用してHide()/Reveal()を繰り返すが、Reveal()はJS側のopen()を
  // 呼び直さない("settings"メッセージを送るだけ)ため、このフラグは初回close以降ずっと
  // falseのままになる(=ネイティブウィンドウが実際に再表示されていてもtrueへは戻らない)。
  // 現状isOpen()の呼び出し元は無く、schedulePrefetch()にとってはこの「closeされたら
  // 二度とtrueに戻らない」という性質はむしろ好都合(閉じたあとは常に先読みしてキャッシュを
  // 温め続けられる)なので、このままにしている。将来isOpen()に「今まさに画面に出ているか」を
  // 厳密に問い合わせる用途が増えたら、C#側からReveal()時に何らかの通知を送るなど別の仕組みが要る。
  let isShown = false;
  let navEl = null;
  let contentEl = null;
  let msgEl = null;
  let saveBtn = null;
  let searchInput = null;
  let restoreFocus = null; // focusModal()の戻り値。閉じたときに開く前の要素へフォーカスを戻す。

  let draft = null; // 編集中の値。get-settingsの応答(またはDEFAULTS)から作る作業コピー
  // テーマのプレビュー用に、開いた時点(=保存済みの値)のテーマ関連4項目だけを控えておく。
  // キャンセル/×/Escで閉じるときにこの値へ戻す(下のrevertThemePreview参照)。
  let themeBaseline = null;
  // ツールチップの詳しさ(依頼2)も、テーマと同じく「保存前でも選んだ瞬間にプレビューしたい」
  // 項目。開いた時点(=保存済みの値)を控えておき、キャンセル/×/Escで閉じるときに戻す。
  let tooltipBaseline = null;
  let dirty = false; // 未保存の変更があるか(閉じる際の確認に使う)
  let activeCategory = "general";
  let searchQuery = ""; // 上部の検索欄の入力値(カテゴリ絞り込み用)

  // ---- 起動後の先読みキャッシュ(パフォーマンス対策 a) ----
  // 起動直後の空き時間にget-settingsを送っておき、応答(生のmsg)をここへ保持する。
  // open()時にこれがあれば、C#側の往復を待たずに即座に描画できる。
  // 実測(計測1: get-settings送信〜settings応答受信)では、この往復がopen()の遅さの
  // 支配的要因だった(DOM構築自体は最も重い「ファイルの関連付け」カテゴリでも10ms未満)。
  let settingsCache = null;
  let prefetchPending = false;

  // 空き時間に処理を回すためのヘルパー。requestIdleCallback非対応環境(古いWebView2ランタイム等)
  // ではsetTimeoutにフォールバックする。いずれにせよ起動直後の同期処理(main.js側の初期化)を
  // 邪魔しないよう、呼び出し元は常にこれ経由でスケジュールする。
  function idleSchedule(fn) {
    if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 2000 });
    else setTimeout(fn, 300);
  }

  // 空き時間にget-settingsを先送りしてキャッシュを温めておく。open()中(既にモーダルが
  // 開いている間)はopen()自身が最新を取りに行くため、ここでは何もしない。
  function schedulePrefetch() {
    if (!ctx.bridge || prefetchPending) return;
    prefetchPending = true;
    idleSchedule(() => {
      prefetchPending = false;
      // 「開いている間はopen()自身が最新を取りに行く」の判定はisShownで行う(overlayでは
      // pageモードで閉じた後も常にtrueになってしまい、以後この先読みが永久に走らなくなるため)。
      if (isShown) return;
      ctx.bridge.postMessage({ type: "get-settings" });
    });
  }

  // 「ファイルの関連付け」カテゴリで表示する警告(save-settings-resultのblockedExtensions)。
  // 保存操作をまたいでも(モーダルを閉じるまで)表示し続けるため、draftとは別に保持する。
  let blockedExtensions = [];

  // ファイルの関連付けタブの状態。draftが差し替わるたび(handleSettingsLoaded/open)に
  // selectedExtensionsだけ作り直す。開閉状態(expanded*)はタブを行き来しても保持したいので
  // draftとは別に、このモジュールが生きている間ずっと保持する。
  let selectedExtensions = new Set();
  // 既定はすべて折りたたみ。7分類×96言語×229拡張子を最初から広げると縦に非常に長くなり、
  // ウィンドウが小さいと目的の分類まで辿り着けなくなるため。
  const expandedCategories = new Set();
  const expandedLanguages = new Set();
  let extInputs = new Map();
  let langInputs = new Map();
  let catInputs = new Map();

  // 拡張子ごとの編集モード上書き(fileModeOverrides)タブの状態。
  // 行は入力途中(拡張子が空・重複)も許すため、draft.fileModeOverridesとは別に
  // {id, ext, mode}の配列で持ち、保存直前にbuildFileModeOverrides()で正規化する。
  let fmRows = [];
  let fmRowIdSeq = 0;
  let fmRowEls = new Map(); // id -> {rowEl, extInput, modeSelect, warnEl}(入力中の全行再描画を避けるため)

  // 更新(バージョン情報タブ)の状態。phaseは
  //   idle      … まだ何も押していない
  //   checking  … 「更新を確認」の返事待ち
  //   checked   … 確認が終わった(checkResultに結果が入っている)
  //   applying  … 「更新する」を押してダウンロード〜入れ替え中
  //   failed    … 適用の途中で失敗した(progressMessageに理由が入っている)
  // 設定ウィンドウを開いている間だけ保持すればよいので、保存はしない。
  let updatePhase = "idle";
  let updateCheckResult = null;
  let updateProgress = null; // { message, percent } percentが0未満なら進捗バーを出さない

  // キーバインドタブの状態。
  let capturingCommandId = null;
  let activeCaptureCleanup = null; // タブ切替・保存・閉じる際に捕捉を強制終了させるための解除関数
  let captureRejectMessage = null; // 割り当て不可なキーを押した際、捕捉を続けたまま表示する案内文

  // 「参照…」ボタンの返信(browse-path-result)を、main.js側のルーティングに頼らず自前で拾う。
  // WebView2のaddEventListenerは複数リスナーの登録を許すため、main.js側の唯一のリスナーとは
  // 独立に動作できる(C#側が未実装で返信が来なくても、ここには何も届かないだけで壊れない)。
  if (ctx.bridge) {
    ctx.bridge.addEventListener("message", (e) => {
      const msg = e && e.data;
      if (!msg) return;
      if (msg.type === "browse-path-result") { handleBrowsePathResult(msg); return; }
      // apply-settings(仕様書 第2.10節): 他ウィンドウでの変更や保存直後の再配布で届く。
      // main.js側は自分の初期化用にこれを処理するだけで本モジュールへは回してくれないため、
      // browse-path-resultと同じ仕組みで直接拾う。先読みキャッシュはもう古いかもしれないので
      // 無効化し、次の空き時間に取り直す(モーダルが開いていればopen()が既に最新を追っている)。
      if (msg.type === "apply-settings") {
        settingsCache = null;
        schedulePrefetch();
      }
      // 更新の確認・適用(仕様書 U-01〜U-04)の返信。バージョン情報タブを開いている
      // ときだけ意味を持つが、閉じている間に届いても状態だけ更新しておけば、
      // 開き直したときにそのまま最後の結果が出る。
      if (msg.type === "update-check-result") { handleUpdateCheckResult(msg); return; }
      if (msg.type === "update-progress") { handleUpdateProgress(msg); return; }
    });
  }

  // 起動後の空き時間に先読みを1回仕掛けておく(open()が呼ばれる前に済ませておきたいため、
  // モジュール初期化時に無条件でスケジュールする)。
  schedulePrefetch();
  window.__paneSettingsDebug = { getCache: () => settingsCache, getPrefetchPending: () => prefetchPending };

  function isOpen() {
    return isShown;
  }

  function setMessage(text, isError) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.classList.toggle("error", !!isError);
  }

  function markDirty() {
    dirty = true;
    setMessage("", false);
  }

  // ---- テーマのプレビュー(仕様書 第2.10節 C-06 / ユーザー要望「保存前でもプレビューしたい」) ----
  // 「テーマ」「ライトテーマ」「ダークテーマ」「ダークモードでは別のテーマを使う」の4項目は、
  // 選んだ瞬間にこの設定画面自身の配色(document.documentElement)とネイティブタイトルバーへ
  // 即座に反映する。settings.jsonへはsave()が呼ばれるまで一切書き込まない
  // (draftはただのメモリ上の作業コピーで、ここでは読むだけ・書き込まない)。
  //
  // 反映先はこの設定画面自身に限る(本文ウィンドウ=MainFormへは送らない)。理由:
  //   ・本文ウィンドウ側の即時反映(保存時のBroadcastSettingsChanged→PostCapabilities)は
  //     このタスクの対象外のPane/MainForm.cs・src/main.jsが持っており、そちらは編集禁止
  //     (他エージェントが並行編集中)。保存前の値をMainForm側へ送る新しい経路を追加するには
  //     その2ファイルの変更が要るため、今回のスコープでは行わない。
  //   ・本文ウィンドウは従来どおり保存後にしか変わらないため、そもそも保存前に変化するものが
  //     無い=キャンセルしても戻すべき状態が存在しない(壊れようがない)。
  //   ・複数の本文ウィンドウが開いていても、保存時はPaneApplicationContext.BroadcastSettingsChanged
  //     が全ウィンドウへ一律に配信するため、「一部の本文ウィンドウだけプレビューが残る」ような
  //     不整合は起きない。
  function resolveIsDark(theme) {
    if (theme === "dark") return true;
    if (theme === "light") return false;
    try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; }
  }

  // { theme, lightTheme, darkTheme, useSeparateThemeInDarkMode } を実際にdocumentへ適用する。
  // main.jsのapply-settings受信(useSeparateThemeInDarkMode=falseならlightThemeを使う)と
  // 全く同じロジック(src/main.js 2084-2099行参照)。previewTheme()/revertThemePreview()の
  // 両方から呼ぶ共通処理。
  function applyThemeValues(fields) {
    const isDark = resolveIsDark(fields.theme);
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    document.documentElement.dataset.lightTheme = fields.lightTheme || "default";
    document.documentElement.dataset.darkTheme =
      (fields.useSeparateThemeInDarkMode === false ? fields.lightTheme : fields.darkTheme) || "default";
    // ネイティブタイトルバー(設定ウィンドウ自身)の配色。C#側(SettingsWindow.cs)の
    // "preview-theme"受け口がisDarkだけを見てWindowChrome.ApplyTheme(既定色)を塗り直す。
    // modalモード(ブリッジ無しのブラウザ単体動作)ではctx.bridgeがnullなのでpostMessage自体が
    // 呼ばれない(何もしないだけで安全)。
    ctx.bridge?.postMessage({ type: "preview-theme", isDark });
  }

  function snapshotThemeBaseline() {
    themeBaseline = {
      theme: draft.theme,
      lightTheme: draft.lightTheme,
      darkTheme: draft.darkTheme,
      useSeparateThemeInDarkMode: draft.useSeparateThemeInDarkMode,
    };
  }

  function previewTheme() {
    if (!draft) return;
    applyThemeValues(draft);
  }

  // キャンセル/×/Escで閉じるときに、開いた時点のテーマへ戻す(保存はしない)。
  function revertThemePreview() {
    if (!themeBaseline) return;
    applyThemeValues(themeBaseline);
  }

  // renderAppearance()から呼ぶ。wireCommonFields()は汎用配線(draftの更新+markDirty)しか
  // しないため、テーマ関連の4項目にだけ追加でpreviewTheme()を呼ぶリスナーを重ねる
  // (addEventListenerは複数リスナーを許すため、wireCommonFieldsの配線とは独立に共存できる)。
  function wireThemePreview(container) {
    for (const key of ["theme", "lightTheme", "darkTheme"]) {
      container.querySelector(`[data-field="${key}"]`)?.addEventListener("change", previewTheme);
    }
    container.querySelector('[data-field="useSeparateThemeInDarkMode"]')?.addEventListener("change", previewTheme);
  }

  // ---- ツールチップの詳しさのプレビュー(依頼2) ----
  // テーマと同じ考え方: 選んだ瞬間に反映し、settings.jsonへの書き込みはsave()まで待たない。
  // 反映先は2つ:
  //   (1) この設定画面自身が持つ各項目のtitle(applySettingsTooltips、renderContent経由で
  //       カテゴリを切り替えるたびにも再適用される)。
  //   (2) 本文側(ctx.setTooltipLevel)。modalモード(本文と同じ文書にオーバーレイで重ねる)
  //       ではこれだけで本文のメニューバー・ステータスバー等のtitleが即座に変わる。
  //       pageモード(専用ウィンドウ)ではctxが本文ウィンドウの物ではないため、
  //       ここでの即時プレビューは専用ウィンドウ自身の項目(1)にとどまり、本文側は
  //       従来の設定と同様「保存後にapply-settingsが届いた時点」で反映される
  //       (テーマプレビューが本文ウィンドウへは反映されないのと同じ制約。上のapplyThemeValues
  //       のコメント参照)。
  function snapshotTooltipBaseline() {
    tooltipBaseline = draft.tooltipDetail;
  }
  function previewTooltipDetail() {
    if (!draft || !contentEl) return;
    applySettingsTooltips(contentEl); // このカテゴリ内の各項目のtitleを新しい段階で再計算する
    ctx.setTooltipLevel?.(draft.tooltipDetail);
  }
  function revertTooltipPreview() {
    if (tooltipBaseline == null || !draft) return;
    draft.tooltipDetail = tooltipBaseline;
    ctx.setTooltipLevel?.(tooltipBaseline);
  }
  function wireTooltipPreview(container) {
    container.querySelector('[data-field="tooltipDetail"]')?.addEventListener("change", previewTooltipDetail);
  }

  function cancelActiveCapture() {
    if (activeCaptureCleanup) activeCaptureCleanup();
  }

  // ---- 開閉 ----
  function buildShell() {
    const isPage = mode === "page";
    overlay = document.createElement("div");
    overlay.className = isPage ? "settings-modal-overlay settings-modal-overlay-page" : "settings-modal-overlay";
    // pageモード(専用ウィンドウ)はオーバーレイの背景の上に浮かぶモーダルダイアログではなく、
    // ウィンドウの中身そのものなので、role="dialog"/aria-modalは付けない。
    const dialogAttrs = isPage ? "" : ' role="dialog" aria-modal="true" aria-label="設定"';
    overlay.innerHTML = `
      <div class="settings-modal${isPage ? " settings-modal-page" : ""}"${dialogAttrs}>
        <div class="settings-modal-head">
          <div class="settings-modal-title">設定</div>
          ${mode === "page" ? "" : `<button type="button" class="settings-modal-close" data-tip="settings-modal-close" aria-label="閉じる">${ICON_CLOSE}</button>`}
        </div>
        <div class="settings-search-row">
          ${ICON_SEARCH}
          <input type="search" class="settings-search-input" data-tip="settings-search" placeholder="設定を検索…" aria-label="設定を検索">
        </div>
        <div class="settings-modal-body">
          <nav class="settings-nav"></nav>
          <div class="settings-content"></div>
        </div>
        <div class="settings-modal-foot">
          <div class="settings-modal-msg"></div>
          <div class="settings-modal-actions">
            <button type="button" class="btn" data-act="cancel" data-tip="settings-cancel">キャンセル</button>
            <button type="button" class="btn primary" data-act="save" data-tip="settings-save">保存</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    navEl = overlay.querySelector(".settings-nav");
    contentEl = overlay.querySelector(".settings-content");
    msgEl = overlay.querySelector(".settings-modal-msg");
    saveBtn = overlay.querySelector('[data-act="save"]');
    searchInput = overlay.querySelector(".settings-search-input");
    // ページ表示モード(専用ウィンドウ)では画面内の×を出していない(ウィンドウの×と二重になるため)。
    overlay.querySelector(".settings-modal-close")?.addEventListener("click", requestClose);
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", requestClose);
    saveBtn.addEventListener("click", save);
    searchInput.addEventListener("input", onSearchInput);
    // 背景(オーバーレイ自身)をクリックした場合も閉じる(仕様書内の他オーバーレイと同様の慣習)。
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) requestClose(); });
    document.addEventListener("keydown", onDocumentKeydown, true);
  }

  function destroy() {
    cancelActiveCapture();
    // 「開いているか」はoverlayの有無ではなくこのフラグで判定する(pageモードでは
    // 下記のとおりoverlayが閉じた後も残り続けるため)。isOpen()/schedulePrefetch()参照。
    isShown = false;

    if (mode === "page") {
      // 【実バグ①の修正】pageモード(専用ウィンドウ)の「閉じる」は、C#側
      // (Pane/SettingsWindow.OnFormClosing)がウィンドウを非表示にするだけでインスタンス・
      // WebView2を破棄せず、次にReveal()で同じものを使い回す方式になっている。もしここで
      // 従来どおりoverlayをDOMから除去すると、settings-entry.jsはページ読み込み時に
      // open()を一度しか呼ばないため、次にReveal()経由で"settings"応答が届いても
      // handleSettingsLoaded()が「if (!overlay) return;」で早期リターンし続け、
      // 二度と再描画されなくなってしまう(ここが実際のバグの原因)。そのためpageモードでは
      // DOM(overlayとその子要素への参照)を残したまま、「まだ何も読み込んでいない」相当の
      // 状態までリセットするだけにする。
      //
      // documentへのkeydownリスナー(onDocumentKeydown)はbuildShell()内で一度だけ登録して
      // おり、pageモードはoverlayが残り続ける以上buildShell()を二度と呼ばない
      // (=登録し直すこともない)ため、ここで外さなくても二重登録にはならない。
      // 閉じている間はネイティブウィンドウごと非表示(Hide())でこのドキュメントがキー入力を
      // 受け取ること自体が無いので、外さずに付けたままにしておく。
      draft = null;
      themeBaseline = null;
      tooltipBaseline = null;
      dirty = false;
      searchQuery = "";
      if (searchInput) searchInput.value = "";
      blockedExtensions = [];
      // キャッシュ(settingsCache)があれば、それを使って即座に(次のget-settings応答を
      // 待たずに)再描画しておく。ネイティブウィンドウがHide()されている間はこの再描画は
      // ユーザーから見えないが、狙いはReveal()時の体感速度: Reveal()もPostSettingsSnapshotで
      // 最新値を送ってくるがpostMessage経由の非同期応答になるため、先にキャッシュから
      // 復元しておけばShow()した瞬間には既に(多少古いかもしれないが)正しい形の内容が
      // 乗っている状態にできる(open()が先読みキャッシュを使う場合と同じ考え方)。
      // その直後にReveal()からの新しい"settings"応答がhandleSettingsLoaded経由で
      // 最新値に上書きする。キャッシュが無ければ、open()の初回と同じく
      // 「読み込んでいます…」に戻し、Reveal()からの応答を待つ。
      if (settingsCache) {
        applyLoadedSettings(settingsCache);
      } else {
        renderNav(); // searchQueryをリセットしたので、これに合わせてナビだけ描き直す
        contentEl.innerHTML = '<div class="settings-loading">読み込んでいます…</div>';
      }
    } else {
      // modalモード(本文ウィンドウ内のオーバーレイ)は従来どおりDOMごと破棄する
      // (pageモードの都合でこちらの挙動を変えないこと)。
      document.removeEventListener("keydown", onDocumentKeydown, true);
      overlay?.remove();
      overlay = null;
      navEl = contentEl = msgEl = saveBtn = searchInput = null;
      draft = null;
      themeBaseline = null;
      tooltipBaseline = null;
      dirty = false;
      searchQuery = "";
      blockedExtensions = [];
    }

    // 開く前にフォーカスがあった要素(設定ボタン等)へ戻す(focus-trap.js)。
    restoreFocus?.();
    restoreFocus = null;
    // pageモード(専用ウィンドウ)では「閉じる」= ウィンドウそのものを閉じる。
    // オーバーレイをDOMから外すだけのmodalモードと違い、C#側(SettingsWindow)へ
    // 明示的に閉じるよう頼む必要がある。
    if (mode === "page") ctx.bridge?.postMessage({ type: "close-settings-window" });
  }

  // Escapeで閉じる(仕様書)。キーバインド捕捉中はそちらを優先させ(行側のリスナーが処理する)、
  // ここでは何もしない。捕捉中かどうかはonKeydown側がcapturingCommandIdより先にリスナー登録
  // されているとは限らないため、ここで明示的に判定する。
  // Tabキーはtrapatabkey(focus-trap.js)で.settings-modal配下に閉じ込める
  // (role="dialog" aria-modal="true"を付けているのに背後のメニューバーへ抜けてしまう、
  // という不整合を解消するため)。pageモード(専用ウィンドウ)には背後のメニューバーは
  // 無いが、ウィンドウ内でTabがループする挙動自体は同じく自然なので区別しない。
  function onDocumentKeydown(e) {
    if (capturingCommandId) return;
    if (e.key === "Escape") { e.preventDefault(); requestClose(); return; }
    const modalEl = overlay?.querySelector(".settings-modal");
    if (modalEl) trapTabKey(e, modalEl);
  }

  async function requestClose() {
    cancelActiveCapture();
    if (dirty && !(await paneConfirm({ title: "閉じますか?", message: "保存されていない変更があります。閉じてもよろしいですか?", okLabel: "閉じる", danger: true }))) return;
    // キャンセル/×/Esc(いずれもここを通る)で実際に閉じることが決まった時点で、
    // プレビュー中だったテーマを開いた時点の値へ戻す(保存はしない。設定ファイルには
    // 一度も書き込んでいないため、ここではdocumentの見た目とネイティブタイトルバーを
    // 巻き戻すだけでよい)。
    revertThemePreview();
    revertTooltipPreview();
    destroy();
  }

  function open(category) {
    // isOpen()の判定はこのフラグを見る(overlayの有無ではない。pageモードでは閉じた後も
    // overlayが残るため。destroy()のコメント参照)。呼ばれた時点で「開いている」とみなす。
    isShown = true;
    if (overlay) {
      if (category) { activeCategory = category; renderNav(); renderContent(); }
      return;
    }
    activeCategory = category || activeCategory || "general";
    dirty = false;
    buildShell();
    renderNav(); // カテゴリ一覧自体はdraft(get-settingsの応答)を待たずに出せる
    // 開く前にフォーカスがあった要素(設定ボタン等)を覚えつつ、検索欄へ初期フォーカスする
    // (focus-trap.js)。閉じたときにこの記憶した要素へ戻す(destroy()参照)。
    restoreFocus = focusModal(searchInput);
    if (ctx.bridge) {
      // 開いたときは常に最新を取りに行く(先読みキャッシュが古い可能性・他ウィンドウでの
      // 変更に備えるため)。ただし応答を待たずに済むよう、キャッシュがあれば先にそれで
      // 描画してしまい、応答が届いたらhandleSettingsLoadedが(触られていなければ)差分を
      // 反映する。
      ctx.bridge.postMessage({ type: "get-settings" });
      if (settingsCache) {
        applyLoadedSettings(settingsCache);
      } else {
        draft = null;
        contentEl.innerHTML = '<div class="settings-loading">読み込んでいます…</div>';
      }
    } else {
      draft = clone(DEFAULTS);
      selectedExtensions = new Set(draft.associatedExtensions);
      fmRows = buildFmRows(draft.fileModeOverrides);
      snapshotThemeBaseline();
      previewTheme();
      snapshotTooltipBaseline();
      renderContent();
    }
  }

  // get-settings応答(またはキャッシュされた同形式のmsg)からdraftを組み立て、
  // 開いている画面へ反映する。open()の即時描画(キャッシュから)とhandleSettingsLoaded
  // (応答受信時)の両方から呼ばれる共通処理。
  function applyLoadedSettings(msg) {
    draft = {};
    for (const [key, def] of Object.entries(FIELD_DEFS)) {
      draft[key] = coerceIncoming(def, msg[key]);
    }
    // 複合項目(オブジェクト・配列)はFIELD_DEFSの外で個別に扱う。
    draft.keyBindings = msg.keyBindings ? { ...msg.keyBindings } : {};
    draft.associatedExtensions = Array.isArray(msg.associatedExtensions) ? msg.associatedExtensions.slice() : [];
    draft.fileModeOverrides = msg.fileModeOverrides && typeof msg.fileModeOverrides === "object" ? { ...msg.fileModeOverrides } : {};
    draft.fileTreePatterns = Array.isArray(msg.fileTreePatterns) ? msg.fileTreePatterns.slice() : [];
    // perFileModes: 資料の指示どおりUIには出さない。読み込んだ値をそのまま保存時に送り返すだけ。
    draft.perFileModes = msg.perFileModes && typeof msg.perFileModes === "object" ? { ...msg.perFileModes } : {};
    // 保存対象ではない(表示にのみ使う)。
    draft.installedFonts = Array.isArray(msg.installedFonts) ? msg.installedFonts.slice() : [];
    draft.monospaceFonts = Array.isArray(msg.monospaceFonts) ? msg.monospaceFonts.slice() : [];
    draft.pandocAvailable = !!msg.pandocAvailable;
    draft.settingsFilePath = typeof msg.settingsFilePath === "string" ? msg.settingsFilePath : "";
    // 「バージョン情報」カテゴリ表示専用(保存対象ではない環境情報)。
    draft.appVersion = typeof msg.appVersion === "string" ? msg.appVersion : "";
    draft.webView2Version = typeof msg.webView2Version === "string" ? msg.webView2Version : "";
    draft.dotNetVersion = typeof msg.dotNetVersion === "string" ? msg.dotNetVersion : "";
    draft.logFolderPath = typeof msg.logFolderPath === "string" ? msg.logFolderPath : "";
    draft.themeFolderPath = typeof msg.themeFolderPath === "string" ? msg.themeFolderPath : "";
    draft.licenses = Array.isArray(msg.licenses) ? msg.licenses.slice() : [];
    // いまレジストリに登録されている関連付け先(表示専用。保存対象ではない)。
    // C#側 FileAssociationService.GetCurrentTarget の結果で、押したときだけ更新される。
    draft.fileAssociationTarget = normalizeAssocTarget(msg.fileAssociationTarget);

    selectedExtensions = new Set(draft.associatedExtensions);
    fmRows = buildFmRows(draft.fileModeOverrides);
    blockedExtensions = [];
    dirty = false;
    // この時点のテーマ関連4項目(=保存済みの値)をキャンセル時の戻し先として控えておく
    // (設定画面自身の初期配色は既にsettings-entry.js側の起動時処理(applyTheme)・
    // SettingsWindow.OnHandleCreatedが適用済みのため、ここではdocumentへの反映は行わず
    // 値の記録だけにとどめる。previewTheme()は「選んだ瞬間」=wireThemePreview経由の
    // change時にだけ呼ぶ)。
    snapshotThemeBaseline();
    snapshotTooltipBaseline();
    renderNav();
    renderContent();
  }

  // main.jsのhandleHostMessageから"settings"受信時に呼ばれる。開いているかどうかに関わらず
  // 毎回呼ばれる(起動直後の先読みの応答もここに届く)。
  function handleSettingsLoaded(msg) {
    settingsCache = clone(msg); // 次にopen()されたときすぐ描画できるよう常に保持しておく
    if (!overlay) return; // 開いていなければキャッシュを更新するだけ
    if (!draft) { applyLoadedSettings(msg); return; } // 読み込み中(ローディング表示)だった
    // ここに来るのは、open()時にキャッシュから即描画した後、開いたときに送り直した
    // get-settingsの応答が届いた場合。ユーザーが既に何か触っていたら上書きしない
    // (安全側に倒す。「まだ何も触っていない場合のみ反映する」)。
    if (dirty) return;
    applyLoadedSettings(msg);
  }

  // fileModeOverrides({拡張子: モード})→ 編集用の行配列に変換する。
  function buildFmRows(overrides) {
    return Object.entries(overrides ?? {}).map(([ext, mode]) => ({ id: ++fmRowIdSeq, ext, mode: mode || "markdown" }));
  }

  function buildSavePayload() {
    const payload = {};
    for (const [key, def] of Object.entries(FIELD_DEFS)) {
      payload[key] = coerceOutgoing(def, draft[key]);
    }
    payload.keyBindings = draft.keyBindings;
    payload.associatedExtensions = Array.from(selectedExtensions);
    payload.fileModeOverrides = buildFileModeOverrides();
    payload.fileTreePatterns = (draft.fileTreePatterns ?? []).slice();
    payload.perFileModes = draft.perFileModes ?? {};
    return payload;
  }

  // fmRows(入力途中の状態を含む行配列)→ 保存用の{拡張子: モード}に正規化する。
  // 拡張子が空の行は捨て、先頭ドットを除去して小文字化する。重複時は後勝ち。
  function normalizeExtKey(text) {
    return String(text ?? "").trim().replace(/^\./, "").toLowerCase();
  }
  function buildFileModeOverrides() {
    const result = {};
    for (const row of fmRows) {
      const key = normalizeExtKey(row.ext);
      if (!key) continue;
      result[key] = row.mode;
    }
    return result;
  }

  async function save() {
    cancelActiveCapture();
    if (!ctx.bridge) {
      // ブリッジが無いブラウザ単体動作では永続化先(C#側AppSettings)が無いため保存できない。
      // 画面自体は最後まで操作できるようにしておき、保存時にのみ案内する(仕様書の指示どおり)。
      await paneAlert({ title: "保存できません", message: "設定の保存はデスクトップアプリ版でのみ利用できます。" });
      return;
    }
    if (!draft) return;
    saveBtn.disabled = true;
    setMessage("保存しています…", false);
    ctx.bridge.postMessage({ type: "save-settings", settings: buildSavePayload() });
  }

  // main.jsのhandleHostMessageから"save-settings-result"受信時に呼ばれる。
  function handleSaveResult(msg) {
    if (!overlay) return;
    // 「関連付けを今のPaneに更新」ボタンの結果は、通常の保存とは扱いが全く違う
    // (画面は閉じない・保存ボタンの状態も触らない)ため、先に分岐する。
    if (msg.reason === ASSOC_REFRESH_REASON) { handleAssocRefreshResult(msg); return; }
    if (saveBtn) saveBtn.disabled = false;
    if (!msg.ok) {
      setMessage(msg.error || "設定を保存できませんでした。", true);
      return;
    }
    dirty = false;
    if (Array.isArray(msg.blockedExtensions) && msg.blockedExtensions.length) {
      // 一部の拡張子はWindows側の「既定のアプリ」で他アプリが選ばれているため反映されなかった。
      // 「ファイルの関連付け」カテゴリに警告を出したいので、モーダルは閉じずに残す。
      blockedExtensions = msg.blockedExtensions.slice();
      setMessage("設定を保存しました。一部の拡張子の関連付けは変更されていません。", false);
      renderContent();
      return;
    }
    blockedExtensions = [];
    destroy();
  }

  // ---- 「関連付けを今のPaneに更新」ボタン ----
  // 現在チェックが入っている拡張子を「一括で」今のexeへ登録し直す。登録そのものは
  // C#側の既存処理(FileAssociationService.Apply→Register)がそのまま行うため、
  // ここで新しい登録ロジックは持たない。
  //
  // 送るのは既存の save-settings で、settingsには associatedExtensions だけを載せる。
  // C#側は「含まれている項目だけ反映する」部分更新なので、編集途中の他の設定を巻き込んで
  // 保存してしまうことは無い(通常の「保存」ボタンが送る全項目のペイロードとは別物)。
  // 通常の保存と区別するため reason を付け、C#側はそれを応答へそのまま返してくる。
  let assocRefreshPending = false;

  async function refreshFileAssociation(btn) {
    if (!ctx.bridge) {
      // ブリッジが無いブラウザ単体動作ではレジストリが無いため実行できない(保存と同じ扱い)。
      await paneAlert({ title: "更新できません", message: "ファイルの関連付けの更新は、デスクトップアプリ版でのみ利用できます。" });
      return;
    }
    if (assocRefreshPending) return; // 連打で二重に送らない
    assocRefreshPending = true;
    if (btn) btn.disabled = true;
    ctx.bridge.postMessage({
      type: "save-settings",
      reason: ASSOC_REFRESH_REASON,
      settings: { associatedExtensions: Array.from(selectedExtensions) },
    });
  }

  // 上のボタンで送ったsave-settingsの応答。表示を最新の関連付け先へ差し替えたうえで、
  // 結果を独自ダイアログ(paneAlert)で知らせる。失敗は握りつぶさずそのまま伝える。
  async function handleAssocRefreshResult(msg) {
    assocRefreshPending = false;
    if (draft) draft.fileAssociationTarget = normalizeAssocTarget(msg.fileAssociationTarget);
    if (Array.isArray(msg.blockedExtensions)) blockedExtensions = msg.blockedExtensions.slice();
    // 「現在の関連付け先」の表示を更新する(このカテゴリを開いているときだけ描き直せばよい)。
    if (activeCategory === "fileTypes") renderContent();

    if (!msg.ok) {
      await paneAlert({
        title: "関連付けを更新できませんでした",
        message: msg.error || "ファイルの関連付けを更新できませんでした。ログ(設定→バージョン情報→今日のログを開く)に詳細が記録されています。",
      });
      return;
    }

    const t = draft?.fileAssociationTarget ?? normalizeAssocTarget(msg.fileAssociationTarget);
    const count = t.extensionCount;
    if (count === 0) {
      await paneAlert({
        title: "関連付けは登録されていません",
        message: "チェックが入っている拡張子が無いため、関連付けは登録されませんでした。ダブルクリックでPaneを開きたい拡張子にチェックを入れてから、もう一度お試しください。",
      });
      return;
    }
    const versionText = t.currentVersion ? `Pane v${t.currentVersion}` : "今のPane";
    let message = `${count}件の拡張子の関連付けを、今の${versionText}(${t.currentPath || "パス不明"})へ登録し直しました。`;
    if (blockedExtensions.length) {
      // UserChoice(Windowsの「既定のアプリ」)で他アプリが選ばれている拡張子は、
      // アプリ側からは変更できない。従来どおり画面側に案内を出したうえで、ここでも触れておく。
      message += `\n\nただし ${blockedExtensions.map((e) => "." + e).join(" ")} は、Windowsの「既定のアプリ」で他のアプリが選ばれているため変更できませんでした。画面の案内から選び直してください。`;
    }
    await paneAlert({ title: "関連付けを更新しました", message });
  }

  // 「参照…」ボタンの応答。draftの該当キーへ入れ、そのフィールドが今表示中なら入力欄にも反映する。
  function handleBrowsePathResult(msg) {
    if (!draft) return;
    const field = msg.field;
    if (typeof field !== "string" || !(field in draft || field in FIELD_DEFS)) return;
    draft[field] = msg.path ?? "";
    markDirty();
    const input = contentEl?.querySelector(`input[type="text"][data-field="${field}"]`);
    if (input) input.value = draft[field] ?? "";
  }

  // ---- 検索欄(上部、全カテゴリ横断) ----
  function onSearchInput() {
    searchQuery = searchInput.value.trim();
    renderNav();
    const visible = visibleCategoryIds();
    if (visible.length && !visible.includes(activeCategory)) {
      activeCategory = visible[0];
      renderContent();
    }
  }
  function visibleCategoryIds() {
    if (!searchQuery) return NAV_ITEMS.map((i) => i.id);
    const q = searchQuery.toLowerCase();
    return NAV_ITEMS.filter((item) => {
      if (item.label.toLowerCase().includes(q)) return true;
      const idx = SEARCH_INDEX[item.id] || [];
      return idx.some((s) => s.toLowerCase().includes(q));
    }).map((i) => i.id);
  }

  // ---- ナビゲーション(左のカテゴリ一覧) ----
  function renderNav() {
    const visible = new Set(visibleCategoryIds());
    const items = NAV_ITEMS.filter((item) => visible.has(item.id));
    navEl.innerHTML = items.length
      ? items.map((item) =>
          `<button type="button" class="settings-nav-item${item.id === activeCategory ? " active" : ""}" data-cat="${item.id}">${item.icon}<span>${item.label}</span></button>`
        ).join("")
      : '<div class="settings-nav-empty">一致する項目がありません</div>';
    for (const btn of navEl.querySelectorAll("[data-cat]")) {
      btn.addEventListener("click", () => {
        if (btn.dataset.cat === activeCategory) return;
        activeCategory = btn.dataset.cat;
        renderNav();
        renderContent();
      });
    }
  }

  // ---- 右側(設定項目)の共通ヘルパー ----
  // ラジオ(name属性でグループ化。nameがそのままdraftのキー)・チェックボックス・セレクト・
  // テキスト/数値/複数行入力のうち、data-field(またはラジオはname)属性が付いた要素をまとめて
  // draftへ双方向で結びつける。ほとんどのカテゴリはこれだけで済むため、カテゴリごとの
  // 個別配線コードを持たずに済ませる。
  function wireCommonFields(container) {
    const radioNames = new Set(Array.from(container.querySelectorAll('input[type="radio"][name]')).map((r) => r.name));
    for (const name of radioNames) {
      for (const r of container.querySelectorAll(`input[type="radio"][name="${name}"]`)) {
        r.checked = draft[name] === r.value;
        r.addEventListener("change", () => { if (r.checked) { draft[name] = r.value; markDirty(); } });
      }
    }
    for (const cb of container.querySelectorAll('input[type="checkbox"][data-field]')) {
      const key = cb.dataset.field;
      // data-invert: UI上のチェックの意味と設定値(draft[key])を反転させる項目
      // (quitOnLastWindowClosed用。fieldCheckboxのコメント参照)。チェックON=常駐する
      // ⇔ draft.quitOnLastWindowClosed=false、という向きになる。
      const invert = cb.hasAttribute("data-invert");
      cb.checked = invert ? !draft[key] : !!draft[key];
      cb.addEventListener("change", () => { draft[key] = invert ? !cb.checked : cb.checked; markDirty(); });
    }
    for (const sel of container.querySelectorAll("select[data-field]")) {
      const key = sel.dataset.field;
      const numeric = sel.hasAttribute("data-numeric");
      sel.value = numeric ? String(draft[key]) : (draft[key] ?? "");
      sel.addEventListener("change", () => {
        draft[key] = numeric ? Number(sel.value) : sel.value;
        markDirty();
      });
    }
    for (const inp of container.querySelectorAll('input[type="text"][data-field]')) {
      const key = inp.dataset.field;
      inp.value = draft[key] ?? "";
      inp.addEventListener("input", () => { draft[key] = inp.value; markDirty(); });
    }
    // 数値入力は打鍵のたびではなく確定時(change=blur/Enter)にだけ範囲を丸める
    // (入力途中の値をその都度clampすると桁を打っている最中に値が飛んで打ちにくくなるため)。
    // step指定(小数、例: 行の高さ)がある場合は整数丸めではなくstep単位で丸める。
    for (const inp of container.querySelectorAll('input[type="number"][data-field]')) {
      const key = inp.dataset.field;
      inp.value = draft[key] ?? "";
      inp.addEventListener("change", () => {
        let n = Number(inp.value);
        if (!Number.isFinite(n)) n = DEFAULTS[key];
        const step = Number(inp.step);
        if (Number.isFinite(step) && step > 0 && step !== 1) {
          n = Math.round(n / step) * step;
          const decimals = (String(step).split(".")[1] || "").length;
          n = Number(n.toFixed(decimals));
        } else {
          n = Math.round(n);
        }
        const min = Number(inp.min), max = Number(inp.max);
        if (Number.isFinite(min)) n = Math.max(min, n);
        if (Number.isFinite(max)) n = Math.min(max, n);
        inp.value = n;
        draft[key] = n;
        markDirty();
      });
    }
    // 複数行入力: data-linesが無ければ生文字列(exportAppendHead等)、あれば改行区切りの
    // 配列(fileTreePatterns)として扱う。
    for (const ta of container.querySelectorAll("textarea[data-field]")) {
      const key = ta.dataset.field;
      const lines = ta.hasAttribute("data-lines");
      ta.value = lines ? (Array.isArray(draft[key]) ? draft[key].join("\n") : "") : (draft[key] ?? "");
      ta.addEventListener("input", () => {
        draft[key] = lines ? ta.value.split("\n").map((s) => s.trim()).filter(Boolean) : ta.value;
        markDirty();
      });
    }
    applySettingsTooltips(container);
  }

  // ---- 設定画面の各項目自体のツールチップ(依頼2) ----
  // data-tip="設定キー"を持つ要素(field*ヘルパーが生成する各行の<label>)へ、現在の
  // draft.tooltipDetailに応じたtitleを設定する。wireCommonFields()の末尾から毎回呼ばれる
  // ため、カテゴリを切り替えるたびに常に最新の段階が反映される。
  //   ・none/minimal: 出さない(設定画面はラベル自体で何の項目か分かるため、
  //     「最低限」でも状態以外の説明は不要という依頼2の解釈をさらに進め、
  //     状態を示す情報を持たない設定項目では常に抑制する)。
  //   ・standard/detailed: src/tooltips.jsのTOOLTIPSに専用の文言があればそれを使い、
  //     無ければ「ラベル。説明文(desc)」から自動で組み立てたフォールバックを使う
  //     (FIELD_TOOLTIP_FALLBACK、上のfield*ヘルパー参照)。descが無い項目はラベルのみになる。
  function applySettingsTooltips(container) {
    const level = draft?.tooltipDetail ?? DEFAULT_TOOLTIP_DETAIL;
    for (const el of container.querySelectorAll("[data-tip]")) {
      if (level === "none" || level === "minimal") { el.title = ""; continue; }
      const key = el.dataset.tip;
      const fb = FIELD_TOOLTIP_FALLBACK[key];
      const fallbackText = fb ? (fb.desc ? `${fb.label}。${fb.desc}` : fb.label) : "";
      const fallback = fallbackText ? { standard: fallbackText, detailed: fallbackText } : null;
      const text = resolveTooltip(key, level, { fallback });
      if (text !== null) el.title = text;
    }
  }

  // 「参照…」ボタン。押すとbrowse-pathを送るだけ(結果はhandleBrowsePathResultで受ける)。
  function wireBrowseButtons(container) {
    for (const btn of container.querySelectorAll("[data-browse-field]")) {
      btn.addEventListener("click", () => {
        if (!ctx.bridge) return;
        ctx.bridge.postMessage({ type: "browse-path", field: btn.dataset.browseField, kind: btn.dataset.browseKind });
      });
    }
  }

  // ---- 各カテゴリの描画 ----
  // 並び順(使いやすさ改善): 「起動時の動作」は最初に一度決めたらほぼ変えない設定だが、
  // アプリを開いてまず目に入る動作のため先頭に据え置く。次に画面表示まわり(ステータスバー・
  // アウトライン・表示形式・ズーム)をひとまとめにし、その次にファイル履歴、最後に
  // 「常駐」「終了時の挙動」という頻度の低い起動・終了系の設定を置いた
  // (元は表示系・履歴・起動終了系が1つの平らなグループに混在していたのを3グループへ分割)。
  function renderGeneral(el) {
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">起動時の動作</div>
        <label class="settings-radio"><input type="radio" name="startupBehavior" value="restoreSession"><span>前回開いていたファイルを復元</span></label>
        <label class="settings-radio"><input type="radio" name="startupBehavior" value="blank"><span>何も開かない</span></label>
        <label class="settings-radio"><input type="radio" name="startupBehavior" value="customFolder"><span>指定したフォルダを開く</span></label>
        ${fieldPath(ctx, "startupFolderPath", "folder", "起動時に開くフォルダ", "(未設定)")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">画面の表示</div>
        ${fieldCheckbox("showStatusBar", "ステータスバーを表示")}
        ${fieldCheckbox("showOutlineByDefault", "アウトラインを既定で表示")}
        ${fieldCheckbox("collapsibleOutline", "アウトラインの折りたたみ")}
        ${fieldCheckbox("zoomWithCtrlWheel", "Ctrl+マウスホイールで文字サイズを拡大縮小")}
      </div>
      <!-- 表示形式(displayMode)の切替UIはここには置かない(ユーザー指示: ウィンドウ形式から
           変更できないようにする隠し機能。docs/設定項目一覧.md参照)。 -->
      <div class="settings-group">
        <div class="settings-group-title">ファイル履歴</div>
        ${fieldCheckbox("recordRecentFiles", "最近使ったファイルを記録")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">起動・終了</div>
        <!-- ユーザー報告: 「チェックを付ける=常駐する」だと誤解していた
             (旧文言「最後のウィンドウを閉じたら終了する」はチェックON=終了する、という
             逆の意味だった)。文言だけでなくチェックの意味自体を反転させる。
             設定キー(quitOnLastWindowClosed)・既定値・C#側の判定ロジック
             (PaneApplicationContext.OnWindowClosed)は変更しない(互換性優先。判断の理由は
             docs/設定項目一覧.md側の注記を参照)。fieldCheckboxのinvert:trueにより、
             このチェックボックスだけ「チェックON = 常駐する(draft.quitOnLastWindowClosed
             = false)」という向きで表示・保存する。
             文言の体言止め統一(依頼1)でもこの2つの文言だけは意図的に変えない
             (ユーザー指示。チェックの意味が反転した経緯があり、動詞まで含めて丁寧に
             説明する現状の言い回しが必要なため)。 -->
        ${fieldCheckbox("quitOnLastWindowClosed", "最後のウィンドウを閉じても常駐させる(次回の起動が速くなります)",
          "オフにすると、最後のウィンドウを閉じたときにPaneごと終了します。下の項目とは独立していて、こちらは「ウィンドウを閉じたときに常駐し続けるか」の設定です。",
          { invert: true })}
        ${fieldCheckbox("preloadOnStartup", "PCの起動時からあらかじめ常駐しておく(起動が速くなります)",
          "こちらは「PCの起動直後から常駐するか」の設定です(上の項目とは独立して動作します)。")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">ヘルプ</div>
        ${fieldSelect("tooltipDetail", "ツールチップの詳しさ", [
          ["none", "表示しない"], ["minimal", "最低限"], ["standard", "標準"], ["detailed", "詳しい"],
        ], "設定画面やメニューバー・ステータスバーのボタンにカーソルを合わせたときに出る説明の詳しさです。")}
      </div>`;
    wireCommonFields(el);
    wireBrowseButtons(el);
    wireTooltipPreview(el);
  }

  function renderFile(el) {
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">自動保存</div>
        ${fieldCheckbox("autoSaveEnabled", "自動保存")}
        ${fieldNumber("autoSaveIntervalSeconds", "自動保存の間隔(秒)")}
        ${fieldCheckbox("recoverUnsavedDrafts", "未保存の下書きを次回起動時に復元")}
        ${fieldCheckbox("saveWithoutAskingOnSwitch", "サイドバーでのファイル切り替え時、確認せず保存")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">保存形式の既定値</div>
        ${fieldSelect("defaultEncoding", "既定の文字コード", [["utf8", "UTF-8"], ["utf8bom", "UTF-8 (BOM付き)"], ["shiftjis", "Shift_JIS"], ["utf16le", "UTF-16 LE"]])}
        ${fieldSelect("defaultLineEnding", "既定の改行コード", [["crlf", "CRLF"], ["lf", "LF"]])}
        ${fieldText("defaultFileExtension", "既定の拡張子", "md", "ドットは付けずに入力します(例: md)")}
      </div>`;
    wireCommonFields(el);
  }

  // 並び順(使いやすさ改善): 入力中に常に効いてくる「入力補助」(自動ペアリング等)を先頭に、
  // 次にインデント・折り返しという構造系の設定、次にコピー・タイプライター等の編集体験、
  // 最後にスペルチェック・自動判定・拡張子ごとの上書きという頻度の低い/上級者向け設定という順に
  // した。元は「インデント→自動ペアリング→絵文字/コピー/読了速度→スペルチェック→自動判定→
  // 拡張子上書き」の順だったが、日常的に効果を体感しやすい入力補助を最優先にした。
  function renderEdit(el) {
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">入力補助</div>
        <label class="settings-checkbox-row" data-tip="autoPairing"><input type="checkbox" data-field="autoPairing"><span class="settings-checkbox-title">自動ペアリング<span class="settings-field-desc">括弧・引用符を入力すると自動的に閉じます</span></span></label>
        ${fieldCheckbox("autoPairMarkdown", "Markdown記法の自動ペアリング", "例: <code>**</code> <code>_</code> などを自動的に閉じます")}
        ${fieldSelect("emojiAutocomplete", "絵文字の自動補完", [["off", "オフ"], ["esc", "Escで確定"], ["auto", "自動確定"]])}
        ${fieldCheckbox("liveRenderingShowSourceOnFocus", "カーソル行の記法を生表示")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">インデント・折り返し</div>
        ${fieldNumericSelect("indentSizeOnSave", "引用・リストのインデント幅")}
        ${fieldNumericSelect("codeIndentSize", "コードモードのインデント幅", "Tabキーで挿入するスペースの数と、タブ文字の表示幅です。半角スペースで書かれた既存のインデントの見た目は変わりません")}
        ${fieldCheckbox("codeFoldingEnabled", "コードモードの折りたたみ", "関数・オブジェクト・配列などの行番号の左に折りたたみマーカーを表示します")}
        ${fieldSelect("codeIndentGuides", "インデントガイド(縦線)", [["none", "表示しない"], ["fold", "折りたたみできる範囲のみ"], ["all", "すべてのインデント"]], "コードモードで、インデントの深さを示す縦線をどこまで表示するかです")}
        ${fieldCheckbox("codeAutoWrap", "コードブロックの長い行を折り返し")}
        ${fieldCheckbox("codeActiveLineHighlight", "現在の行を強調表示", "カーソルのある行を本文・行番号ガターの両方で背景色を淡く変えて示します。選択範囲があるときは表示しません")}
        ${fieldCheckbox("colorPreviewInCode", "コード中の色をプレビュー表示", "16進・rgb・hsl等の色指定にスウォッチと文字色を付けます")}
        ${fieldCheckbox("shiftTabAutoIndent", "Shift+Tabでインデントを解除")}
        <label class="settings-checkbox-row" data-tip="strictMode"><input type="checkbox" data-field="strictMode"><span class="settings-checkbox-title">厳格モード<span class="settings-field-desc">見出しやリスト記号の記法を厳密に解釈します</span></span></label>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">コピー・カーソル</div>
        <label class="settings-select-row">コピー形式
          <select data-field="defaultCopyFormat">
            <option value="markdown">マークダウン</option>
            <option value="html">HTML</option>
          </select>
          <span class="settings-field-desc">他アプリへ貼り付けるときに書式を保つか</span>
        </label>
        ${fieldCheckbox("copyWholeLineWhenNoSelection", "選択が無いときはCtrl+C/Xで行全体をコピー")}
        ${fieldCheckbox("typewriterKeepCaretCentered", "タイプライターモード(カーソル行を画面中央に保つ)")}
        ${fieldNumber("readingSpeedWpm", "読了速度(分あたりの文字数)", "0を指定すると自動計算します")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">スペルチェック</div>
        ${fieldCheckbox("spellCheckEnabled", "スペルチェック")}
        <label class="settings-checkbox-row" data-tip="spellCheckAutoCorrect"><input type="checkbox" data-field="spellCheckAutoCorrect"><span class="settings-checkbox-title">スペルチェックの自動修正を有効にする<span class="settings-field-desc">WebView2の制約により、この項目からは制御できません。Windowsの入力設定に従います</span></span></label>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">編集モードの自動判定</div>
        <p class="settings-intro">通常は拡張子から編集モードを判断します。無題の新規文書では、内容からも判断できます。</p>
        <label class="settings-radio"><input type="radio" name="autoDetectMode" value="off"><span>オフ<span class="settings-field-desc">内容からは判断しません</span></span></label>
        <label class="settings-radio"><input type="radio" name="autoDetectMode" value="suggest"><span>控えめ<span class="settings-field-desc">切り替えず、ステータスバーで提案だけします</span></span></label>
        <label class="settings-radio"><input type="radio" name="autoDetectMode" value="standard"><span>標準(推奨)<span class="settings-field-desc">無題の新規文書のみ自動で切り替えます。切り替え後に取り消せます</span></span></label>
        <label class="settings-radio"><input type="radio" name="autoDetectMode" value="aggressive"><span>積極的<span class="settings-field-desc">拡張子のあるファイルでも、内容と食い違う場合は提案します</span></span></label>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">拡張子ごとの編集モード</div>
        <p class="settings-intro">通常は拡張子から自動で判断します。ここに登録した拡張子だけ、指定したモードで開きます。</p>
        <div class="fm-list" data-field="fileModeOverrides"></div>
        <button type="button" class="btn tiny fm-add">+ 追加</button>
      </div>`;
    wireCommonFields(el);
    renderFmRows(el.querySelector(".fm-list"));
    el.querySelector(".fm-add").addEventListener("click", () => {
      fmRows.push({ id: ++fmRowIdSeq, ext: "", mode: "markdown" });
      renderFmRows(el.querySelector(".fm-list"));
      markDirty();
      el.querySelector(".fm-row:last-child .fm-ext")?.focus();
    });
  }

  // ---- 拡張子ごとの編集モード上書き(fileModeOverrides)の行描画 ----
  // 1文字入力するたびに全行を再構築するとフォーカス・キャレット位置が飛ぶため、
  // 行の増減(追加・削除)時だけDOMを作り直し、入力自体は既存要素へ直接反映する。
  function renderFmRows(listEl) {
    listEl.innerHTML = fmRows.map((row) => `
      <div class="fm-row" data-row-id="${row.id}">
        <input type="text" class="fm-ext" placeholder=".js">
        <select class="fm-mode">
          <option value="markdown">Markdown</option>
          <option value="code">コード</option>
          <option value="plain">プレーンテキスト</option>
        </select>
        <button type="button" class="icon-btn fm-remove" aria-label="削除">${ICON_CLOSE}</button>
        <span class="kb-cell-warn fm-warn"></span>
      </div>`).join("");
    fmRowEls = new Map();
    for (const row of fmRows) {
      const rowEl = listEl.querySelector(`[data-row-id="${row.id}"]`);
      const extInput = rowEl.querySelector(".fm-ext");
      const modeSelect = rowEl.querySelector(".fm-mode");
      const warnEl = rowEl.querySelector(".fm-warn");
      extInput.value = row.ext;
      modeSelect.value = row.mode;
      fmRowEls.set(row.id, { rowEl, extInput, modeSelect, warnEl });
      extInput.addEventListener("input", () => {
        row.ext = extInput.value;
        updateFmWarnings();
        markDirty();
      });
      modeSelect.addEventListener("change", () => {
        row.mode = modeSelect.value;
        markDirty();
      });
      rowEl.querySelector(".fm-remove").addEventListener("click", () => {
        fmRows = fmRows.filter((r) => r.id !== row.id);
        renderFmRows(listEl);
        markDirty();
      });
    }
    updateFmWarnings();
  }

  // 正規化後の拡張子キーが重複している行に警告を出す(保存自体は後勝ちで許可)。
  function updateFmWarnings() {
    const counts = new Map();
    for (const row of fmRows) {
      const key = normalizeExtKey(row.ext);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const row of fmRows) {
      const els = fmRowEls.get(row.id);
      if (!els) continue;
      const key = normalizeExtKey(row.ext);
      const dup = !!key && counts.get(key) > 1;
      els.warnEl.textContent = dup ? "拡張子が重複しています" : "";
      els.rowEl.classList.toggle("fm-row-dup", dup);
    }
  }

  // 記法サポートの並び順(使いやすさ改善): 一般的な文書でよく使う記法(自動リンク・
  // ハイライト・Callouts・作図)を上に、専門的・利用頻度が低い記法(上付き下付き・数式)を
  // 下に寄せた。元は特に意図のない並びだった。
  function renderMarkdownCategory(el) {
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">記法サポート</div>
        ${fieldCheckbox("autoLinksEnabled", "URLの自動リンク化")}
        <label class="settings-checkbox-row" data-tip="highlightEnabled"><input type="checkbox" data-field="highlightEnabled"><span class="settings-checkbox-title">ハイライト<span class="settings-field-desc">例: <code>==ハイライト==</code></span></span></label>
        <label class="settings-checkbox-row" data-tip="calloutsEnabled"><input type="checkbox" data-field="calloutsEnabled"><span class="settings-checkbox-title">Callouts<span class="settings-field-desc">例: <code>&gt; [!NOTE]</code></span></span></label>
        ${fieldCheckbox("diagramsEnabled", "作図(Mermaidなどのダイアグラム)")}
        <label class="settings-checkbox-row" data-tip="superSubscriptEnabled"><input type="checkbox" data-field="superSubscriptEnabled"><span class="settings-checkbox-title">上付き・下付き<span class="settings-field-desc">例: <code>x^2^</code>、<code>H~2~O</code></span></span></label>
        <label class="settings-checkbox-row" data-tip="inlineMathEnabled"><input type="checkbox" data-field="inlineMathEnabled"><span class="settings-checkbox-title">インライン数式<span class="settings-field-desc">例: <code>$E=mc^2$</code></span></span></label>
        ${fieldCheckbox("codeBlockMathEnabled", "コードブロック内の数式記法")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">記法の書き方</div>
        <label class="settings-checkbox-row" data-tip="strictMode"><input type="checkbox" data-field="strictMode"><span class="settings-checkbox-title">厳格モード(再掲)<span class="settings-field-desc">「編集」カテゴリと同じ項目です</span></span></label>
        ${fieldSelect("headingStyle", "見出しの記法", [["atx", "ATX形式(# 見出し)"], ["setext", "Setext形式(下線)"]])}
        ${fieldSelect("unorderedListMarker", "箇条書きの記号", [["-", "-"], ["*", "*"], ["+", "+"]])}
        ${fieldSelect("orderedListMarker", "番号付きリストの記号", [[".", "1."], [")", "1)"]])}
        <label class="settings-checkbox-row" data-tip="codeBlockLineNumbers"><input type="checkbox" data-field="codeBlockLineNumbers"><span class="settings-checkbox-title">コードブロックの行番号<span class="settings-field-desc">フェンス付きコードブロックの左に行番号を表示します</span></span></label>
        ${fieldSelect("mathAutoNumber", "数式の自動採番", [["off", "しない"], ["ams", "amsmath形式のみ"], ["all", "すべて"]])}
        ${fieldNumber("chapterLevelInOutline", "アウトラインに含める見出しの階層")}
        ${fieldText("defaultCodeLanguage", "既定のコード言語", "(なし)", "コードブロックを挿入するときの既定の言語ID")}
        ${fieldSelect("defaultCodeLanguageApplyWhen", "既定のコード言語を適用する場面", [["markdown", "```のみ入力したとき"], ["menubar", "メニューバーから挿入したとき"], ["both", "どちらも"]])}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">空白と改行</div>
        ${fieldSelect("whitespaceWhenWriting", "編集中の空白の扱い", [["preserve", "そのまま保持"], ["ignore", "余分な空白を無視"]])}
        ${fieldSelect("whitespaceOnExport", "書き出し時の空白の扱い", [["preserve", "そのまま保持"], ["ignore", "余分な空白を無視"]])}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">スマート置換</div>
        ${fieldSelect("smartQuotes", "スマート引用符", [["off", "オフ"], ["input", "入力時に変換"], ["render", "表示時のみ変換"]])}
        ${fieldSelect("smartDashes", "スマートダッシュ", [["off", "オフ"], ["endash", "-- を – に変換"], ["emdash", "-- を — に変換"]])}
        ${fieldCheckbox("recognizeUnicodePunctuation", "全角句読点をMarkdown記法として認識")}
      </div>`;
    wireCommonFields(el);
  }

  // 並び順(使いやすさ改善): 「まず何をするか」を決める保存先(imageInsertAction/
  // imageCustomFolder)を先頭に置くのはそのまま、パスの書き方に関する細かい挙動は
  // 別グループへ分け、どちらが主設定でどちらが微調整かを見出しで分かるようにした。
  function renderImage(el) {
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">保存先</div>
        ${fieldSelect("imageInsertAction", "画像を挿入したときの動作", [["none", "何もしない"], ["currentFolder", "現在のフォルダにコピー"], ["assets", "assetsフォルダにコピー"], ["filenameAssets", "ファイル名.assetsフォルダにコピー"], ["custom", "指定したフォルダにコピー"]])}
        ${fieldPath(ctx, "imageCustomFolder", "folder", "画像のコピー先フォルダ", "./assets", "<code>./</code> <code>../</code> で始まる相対パスか絶対パス。<code>${filename}</code>は現在のファイル名(拡張子なし)に展開します")}
        ${fieldCheckbox("imageApplyToLocal", "ローカルの画像に適用")}
        ${fieldCheckbox("imageApplyToOnline", "オンライン(URL)の画像にも適用")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">パスの書き方</div>
        ${fieldCheckbox("imagePreferRelativePath", "できるだけ相対パスで記述")}
        ${fieldCheckbox("imageAddDotSlash", "相対パスの先頭に ./ を付加")}
        ${fieldCheckbox("imageAutoEscapeUrl", "画像URLの空白などを自動的にエスケープ")}
      </div>`;
    wireCommonFields(el);
    wireBrowseButtons(el);
  }

  function renderExport(el) {
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">用紙</div>
        ${fieldSelect("exportPaperSize", "用紙サイズ", [["a4", "A4"], ["a3", "A3"], ["b5", "B5"], ["letter", "Letter"], ["legal", "Legal"], ["tabloid", "Tabloid"], ["custom", "カスタム"]])}
        ${fieldNumber("exportCustomWidthMm", "カスタム用紙の幅(mm)")}
        ${fieldNumber("exportCustomHeightMm", "カスタム用紙の高さ(mm)")}
        ${fieldSelect("exportOrientation", "向き", [["portrait", "縦"], ["landscape", "横"]])}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">余白(mm)</div>
        ${fieldNumber("exportMarginTopMm", "上")}
        ${fieldNumber("exportMarginBottomMm", "下")}
        ${fieldNumber("exportMarginLeftMm", "左")}
        ${fieldNumber("exportMarginRightMm", "右")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">ヘッダー・フッター</div>
        ${fieldText("exportHeaderText", "ヘッダー", "", REPLACEMENT_TOKENS_DESC)}
        ${fieldText("exportFooterText", "フッター", "", REPLACEMENT_TOKENS_DESC)}
        ${fieldCheckbox("exportPageBreakBetweenTopHeadings", "最上位見出しの前でページ区切り")}
        ${fieldCheckbox("exportIncludeOutline", "アウトラインを含める")}
        ${fieldNumber("exportOutlineWidthPx", "アウトラインの幅(px)")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">出力への追加(上級者向け)</div>
        ${fieldTextarea("exportAppendHead", "&lt;head&gt;内に追加するHTML", "書き出したHTMLの&lt;head&gt;末尾にそのまま挿入します")}
        ${fieldTextarea("exportAppendBody", "&lt;body&gt;内に追加するHTML", "書き出したHTMLの&lt;body&gt;末尾にそのまま挿入します")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">書き出し先・後処理</div>
        ${fieldSelect("exportDefaultFolder", "書き出し先フォルダ", [["sameAsFile", "ファイルと同じフォルダ"], ["custom", "指定したフォルダ"]])}
        ${fieldPath(ctx, "exportCustomFolder", "folder", "書き出し先の指定フォルダ", "(未設定)")}
        ${fieldSelect("exportAfter", "書き出し後の動作", [["none", "何もしない"], ["openFile", "ファイルを開く"], ["openFolder", "フォルダを開く"]])}
        ${fieldCheckbox("exportShowSaveDialog", "書き出し時に保存ダイアログを表示")}
        ${fieldSelect("exportMathAs", "数式の書き出し形式", [["svg", "SVG画像"], ["latex", "LaTeXソース"]])}
        ${fieldCheckbox("exportReadYamlFrontMatter", "YAMLフロントマターを読み取り")}
      </div>`;
    wireCommonFields(el);
    wireBrowseButtons(el);
  }

  // ---- フォント選択欄(本文/等幅)----
  // installedFonts/monospaceFontsが届いている場合はドロップダウン、届かない/空の場合は
  // 従来どおりのテキスト入力にフォールバックする。どちらの場合もdata-field/data-font-preview
  // 属性を付けておき、wireCommonFields(既存の汎用配線)とwireFontPreviews(プレビュー反映)の
  // 両方から同じ要素を扱えるようにする。
  function fontOptionHtml(name, selected) {
    const label = escapeHtml(name);
    // CSS文字列(font-family: '...')としてのエスケープ→HTML属性としてのエスケープの順で行う
    // (フォント名に ' や \ が含まれていても壊れないように)。
    const cssName = String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const styleAttr = escapeHtml(`font-family: '${cssName}'`);
    return `<option value="${label}" style="${styleAttr}"${selected ? " selected" : ""}>${label}</option>`;
  }
  function renderFontField(key, list, labelText, placeholder) {
    const current = draft[key] || "";
    if (!Array.isArray(list) || !list.length) {
      // フォールバック: 従来どおりのテキスト入力(ブラウザ単体・C#側が未対応の場合)。
      return `<label class="settings-text-row">${labelText}
          <input type="text" data-field="${key}" data-font-preview placeholder="${escapeHtml(placeholder)}">
        </label>`;
    }
    // 保存済みの値が一覧に無くても選択状態を保つため、先頭付近(既定の直後)に追加しておく。
    const options = list.slice();
    if (current && !options.includes(current)) options.unshift(current);
    const optionsHtml = options.map((f) => fontOptionHtml(f, f === current)).join("");
    return `<label class="settings-select-row">${labelText}
        <select data-field="${key}" data-font-preview>
          <option value=""${current === "" ? " selected" : ""}>(既定)</option>
          ${optionsHtml}
        </select>
      </label>`;
  }
  // data-font-preview付きの入力/セレクトの現在値を、対応するdata-font-preview-target要素の
  // font-familyへ即時反映する。style属性の文字列組み立てではなくstyle.fontFamilyへの代入で
  // 行うため、フォント名のエスケープを気にする必要がない。
  function wireFontPreviews(container) {
    for (const field of container.querySelectorAll("[data-font-preview]")) {
      const key = field.dataset.field;
      const target = container.querySelector(`[data-font-preview-target="${key}"]`);
      if (!target) continue;
      const apply = () => { target.style.fontFamily = field.value ? `'${field.value}'` : ""; };
      apply();
      field.addEventListener(field.tagName === "SELECT" ? "change" : "input", apply);
    }
  }

  // 並び順(使いやすさ改善): テーマ関連(ライト/ダークのプリセットも含めて1か所にまとめる)→
  // フォント・文字サイズ(よく触る)→ 余白・最大幅(細かい調整、下の方)→ カスタムCSS(上級者向け)→
  // 文字数カウント表示。従来はライト/ダークのプリセットがテーマ選択と別グループになっていたのを
  // 1つの「テーマ」グループへ統合し、本文の余白・最大幅は「レイアウト」として独立させ下側へ移した。
  function renderAppearance(el) {
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">テーマ</div>
        <label class="settings-select-row">テーマ
          <select data-field="theme">
            <option value="system">システムに合わせる</option>
            <option value="light">ライト</option>
            <option value="dark">ダーク</option>
          </select>
        </label>
        <label class="settings-select-row">ライトテーマ
          <select data-field="lightTheme">
            <option value="default">標準</option>
            <option value="sepia">セピア</option>
            <option value="github">GitHub風</option>
            <option value="solarized-light">Solarized Light</option>
          </select>
        </label>
        ${fieldCheckbox("useSeparateThemeInDarkMode", "ダークモードで別のテーマを使用")}
        <label class="settings-select-row">ダークテーマ
          <select data-field="darkTheme">
            <option value="default">標準</option>
            <option value="nord">Nord</option>
            <option value="dracula">Dracula</option>
            <option value="solarized-dark">Solarized Dark</option>
            <option value="night">Night</option>
          </select>
        </label>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">フォント</div>
        ${renderFontField("editorFontFamily", draft.installedFonts, "本文フォント", "(既定のフォントを使用)")}
        <div class="settings-field-desc">プレビュー: <span data-font-preview-target="editorFontFamily" style="font-size: 15px;">あア亜 Aa Bb Cc 0123</span></div>
        ${renderFontField("editorMonospaceFontFamily", draft.monospaceFonts, "等幅フォント", "(既定のフォントを使用)")}
        <div class="settings-field-desc">プレビュー: <span data-font-preview-target="editorMonospaceFontFamily" style="font-size: 15px;">あア亜 Aa Bb Cc 0123</span></div>
        ${fieldNumber("editorFontSize", "文字サイズ")}
        ${fieldNumber("editorLineHeight", "行の高さ")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">レイアウト</div>
        ${fieldNumber("editorPaddingLeft", "本文の左余白(px)")}
        ${fieldNumber("editorPaddingRight", "本文の右余白(px)")}
        ${fieldNumber("editorMaxWidthPx", "本文の最大幅(px)", "0を指定するとテーマの既定値を使います")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">カスタムCSS</div>
        ${fieldPath(ctx, "customCssPath", "file", "カスタムCSS", "(未設定)", "指定したCSSファイルを本文に追加で適用します")}
        <div class="settings-info-row">
          <span class="settings-field-desc">何もない状態から書くのは大変なので、参考になるサンプルCSSを用意しています。</span>
          <button type="button" class="btn tiny" data-action="open-theme-folder">サンプルのあるフォルダを開く</button>
        </div>
      </div>
      <div class="settings-group">
        <label class="settings-checkbox-row" data-tip="showWordCount"><input type="checkbox" data-field="showWordCount"><span class="settings-checkbox-title">文字数カウントを常に表示</span></label>
      </div>`;
    wireCommonFields(el);
    wireThemePreview(el); // テーマ4項目は選んだ瞬間にこの画面自身へプレビューする(上のpreviewTheme参照)
    wireFontPreviews(el);
    wireBrowseButtons(el);
    el.querySelector('[data-action="open-theme-folder"]')?.addEventListener("click", () => {
      ctx.bridge?.postMessage({ type: "open-theme-folder" });
    });
  }

  // ---- 現在の関連付け先の表示 + 「関連付けを今のPaneに更新」ボタン ----
  // 状態ごとに文言と見た目を変える。注意を促す3状態(older/missing/newer)は、
  // 既存の警告用クラス(.ft-blocked-warn)をそのまま使う(新しい配色は増やさない)。
  // ボタンはどの状態でも押せる(「同じバージョン」でも押して困ることは無い)。
  function assocTargetHtml() {
    const t = draft.fileAssociationTarget ?? normalizeAssocTarget(null);
    const here = t.currentPath
      ? `今のPane: ${assocVersionLabel(t.currentVersion)}(${escapeHtml(t.currentPath)})`
      : `今のPane: ${assocVersionLabel(t.currentVersion)}`;
    const there = t.path ? escapeHtml(t.path) : "(不明)";
    // 「更新」という言い方は、新しい版を古い版で上書きすることになるnewerでは使わない。
    const btnLabel = t.status === "newer" ? "関連付けを今のPaneに切り替える" : "関連付けを今のPaneに更新";
    const btn = `<button type="button" class="btn tiny" data-action="refresh-file-association" data-tip="refreshFileAssociation">${btnLabel}</button>`;

    // 注意を促す状態。<p>に本文、その下にボタンを置く(.ft-blocked-warnの中身と同じ作り)。
    const warn = (text) =>
      `<div class="ft-blocked-warn" data-assoc-status="${t.status}"><p>${text}</p>${btn}</div>`;
    // 問題の無い状態。「バージョン情報」カテゴリと同じ1行レイアウト。
    const info = (text) =>
      `<div class="settings-info-row" data-assoc-status="${t.status}"><span class="settings-info-label">${text}</span>${btn}</div>`;

    switch (t.status) {
      case "older":
        return warn(
          `ファイルをダブルクリックしたときに起動するのは、<b>今より古い ${assocVersionLabel(t.registeredVersion)} のPane</b>です(${there})。` +
          `そのため、この${assocVersionLabel(t.currentVersion)}での修正や設定は、ダブルクリックで開いたときには反映されません。` +
          `下のボタンを押すと、チェックしている拡張子すべてをまとめて今のPaneへ登録し直します。<br>${here}`
        );
      case "missing":
        return warn(
          `関連付けに登録されているPaneが見つかりません(${there})。exeを移動または削除したあと、関連付けだけが古い場所を指したまま残っています。` +
          `このままではファイルをダブルクリックしても開けません。下のボタンを押すと、チェックしている拡張子すべてをまとめて今のPaneへ登録し直します。<br>${here}`
        );
      case "newer":
        return warn(
          `関連付けられているのは、<b>今より新しい ${assocVersionLabel(t.registeredVersion)} のPane</b>です(${there})。` +
          `下のボタンを押すと、ダブルクリックで開くPaneはこの${assocVersionLabel(t.currentVersion)}に変わり、新しい方は使われなくなります。` +
          `新しい方を使い続けたい場合は、このまま何もしないでください。<br>${here}`
        );
      case "unknown":
        return info(
          `関連付けられているPaneのバージョンを読み取れませんでした: ${there}。<br>${here}`
        );
      case "none":
        return info(
          `ファイルの関連付けはまだ登録されていません。<br>${here}`
        );
      default: // same
        return info(
          `この Pane(${assocVersionLabel(t.currentVersion)})が関連付けられています。ダブルクリックで開くPaneは最新の状態です。<br>${here}`
        );
    }
  }

  // ---- ファイルの関連付け(3階層チェックボックス、仕様書 C-13) ----
  // カテゴリ→言語→拡張子の3階層。カテゴリ・言語のチェックは配下すべての一括ON/OFFとし、
  // 配下が一部だけONならindeterminate(中間状態)にする。DOM自体は開くたびに1回だけ組み立て、
  // チェック状態の同期(syncFileTypeTree)はinput要素のcheckedプロパティを直接書き換えるだけに
  // 留めることで、145拡張子分のチェックのたびにinnerHTMLを再構築してスクロール位置や
  // 開閉状態が失われるのを避ける。
  function renderFileTypes(el) {
    const catBlocks = CATEGORY_ORDER.map((catKey) => {
      const types = TYPES_BY_CATEGORY.get(catKey);
      if (!types.length) return "";
      const catExpanded = expandedCategories.has(catKey);
      const langRows = types.map((type) => {
        const langExpanded = expandedLanguages.has(type.id);
        const extRows = type.extensions.map((ext) =>
          `<label class="ft-row ft-row-ext"><input type="checkbox" data-ext="${ext}"><span>.${ext}</span></label>`
        ).join("");
        return `
          <div class="ft-lang">
            <div class="ft-row ft-row-lang">
              <button type="button" class="ft-chevron${langExpanded ? " expanded" : ""}" data-toggle-lang="${type.id}" aria-label="展開・折りたたみ">${ICON_CHEVRON}</button>
              <label class="ft-row-label"><input type="checkbox" data-lang="${type.id}"><span>${type.label} <span class="ft-ext-hint">(${type.extensions.map((e) => "." + e).join(" ")})</span></span></label>
            </div>
            <div class="ft-ext-list" data-lang-body="${type.id}"${langExpanded ? "" : " hidden"}>${extRows}</div>
          </div>`;
      }).join("");
      return `
        <div class="ft-category">
          <div class="ft-row ft-row-category">
            <button type="button" class="ft-chevron${catExpanded ? " expanded" : ""}" data-toggle-cat="${catKey}" aria-label="展開・折りたたみ">${ICON_CHEVRON}</button>
            <label class="ft-row-label"><input type="checkbox" data-cat="${catKey}"><span>${CATEGORIES[catKey]}</span></label>
          </div>
          <div class="ft-lang-list" data-cat-body="${catKey}"${catExpanded ? "" : " hidden"}>${langRows}</div>
        </div>`;
    }).join("");

    // Windowsは、アプリが自分で既定のアプリを書き換えることを禁止している(UserChoiceキーが
    // ハッシュで保護されている)。そのため拡張子ごとに、Windows標準の「開く方法を選ぶ」
    // ダイアログを直接開くボタンを出して、そこでPaneを選んでもらう形にする。
    // 押すたびにその拡張子のダイアログが出るので、警告を読んで自分で設定を探す必要がない。
    const blockedBanner = blockedExtensions.length ? `
      <div class="ft-blocked-warn">
        <p>次の拡張子は、Windowsの「既定のアプリ」で他のアプリが選ばれています。Windowsの仕組み上アプリ側からは変更できないため、下のボタンから選び直してください(押すとWindowsの「開く方法を選ぶ」画面が出るので、Paneを選んでください)。</p>
        <div class="ft-blocked-list">
          ${blockedExtensions.map((e) => `<button type="button" class="btn tiny" data-open-with="${e}">.${e} を選び直す</button>`).join("")}
        </div>
        <button type="button" class="btn tiny" data-action="open-default-apps-settings">Windowsの設定画面を開く</button>
      </div>` : "";

    el.innerHTML = `
      ${blockedBanner}
      <p class="settings-intro">チェックした拡張子のファイルを、エクスプローラーからダブルクリックしたときにPaneで開くようにします。</p>
      <div class="settings-group" data-assoc-target>
        <div class="settings-group-title">現在の関連付け先</div>
        ${assocTargetHtml()}
      </div>
      <div class="ft-quickrow">
        <button type="button" class="btn tiny" data-quick="markdown">マークダウンのみ</button>
        <button type="button" class="btn tiny" data-quick="all">すべて選択</button>
        <button type="button" class="btn tiny" data-quick="none">すべて解除</button>
        <span class="ft-count"></span>
      </div>
      <div class="ft-tree" data-field="associatedExtensions">${catBlocks}</div>
      <div class="settings-group">
        ${fieldCheckbox("explorerNewMenuEnabled", "エクスプローラーの右クリック→「新規作成」にMarkdownファイルを追加")}
      </div>`;

    wireCommonFields(el);

    const openApps = el.querySelector('[data-action="open-default-apps-settings"]');
    if (openApps) openApps.addEventListener("click", () => ctx.bridge?.postMessage({ type: "open-default-apps-settings" }));

    // 「関連付けを今のPaneに更新」。押したときだけレジストリを書き換える(この画面を
    // 開いただけでは何も起きない)。
    const refreshAssoc = el.querySelector('[data-action="refresh-file-association"]');
    if (refreshAssoc) refreshAssoc.addEventListener("click", () => refreshFileAssociation(refreshAssoc));

    // 拡張子ごとの「開く方法を選ぶ」ダイアログ(C#側 DefaultAppsHelper.OpenWithDialog)。
    for (const btn of el.querySelectorAll("[data-open-with]")) {
      btn.addEventListener("click", () => {
        ctx.bridge?.postMessage({ type: "open-with-dialog", extension: btn.dataset.openWith });
      });
    }

    extInputs = new Map(Array.from(el.querySelectorAll("input[data-ext]")).map((inp) => [inp.dataset.ext, inp]));
    langInputs = new Map(Array.from(el.querySelectorAll("input[data-lang]")).map((inp) => [inp.dataset.lang, inp]));
    catInputs = new Map(Array.from(el.querySelectorAll("input[data-cat]")).map((inp) => [inp.dataset.cat, inp]));

    for (const btn of el.querySelectorAll("[data-toggle-cat]")) {
      btn.addEventListener("click", () => {
        const key = btn.dataset.toggleCat;
        const body = el.querySelector(`[data-cat-body="${key}"]`);
        const expand = body.hidden;
        body.hidden = !expand;
        btn.classList.toggle("expanded", expand);
        if (expand) expandedCategories.add(key); else expandedCategories.delete(key);
      });
    }
    for (const btn of el.querySelectorAll("[data-toggle-lang]")) {
      btn.addEventListener("click", () => {
        const key = btn.dataset.toggleLang;
        const body = el.querySelector(`[data-lang-body="${key}"]`);
        const expand = body.hidden;
        body.hidden = !expand;
        btn.classList.toggle("expanded", expand);
        if (expand) expandedLanguages.add(key); else expandedLanguages.delete(key);
      });
    }

    for (const [ext, inp] of extInputs) {
      inp.addEventListener("change", () => {
        if (inp.checked) selectedExtensions.add(ext); else selectedExtensions.delete(ext);
        syncFileTypeTree();
        markDirty();
      });
    }
    for (const [id, inp] of langInputs) {
      const type = FILE_TYPES.find((t) => t.id === id);
      inp.addEventListener("change", () => {
        for (const ext of type.extensions) { if (inp.checked) selectedExtensions.add(ext); else selectedExtensions.delete(ext); }
        syncFileTypeTree();
        markDirty();
      });
    }
    for (const [catKey, inp] of catInputs) {
      const types = TYPES_BY_CATEGORY.get(catKey);
      inp.addEventListener("change", () => {
        for (const type of types) for (const ext of type.extensions) { if (inp.checked) selectedExtensions.add(ext); else selectedExtensions.delete(ext); }
        syncFileTypeTree();
        markDirty();
      });
    }
    el.querySelector('[data-quick="markdown"]').addEventListener("click", () => { selectedExtensions = new Set(MARKDOWN_EXTENSIONS); syncFileTypeTree(); markDirty(); });
    el.querySelector('[data-quick="all"]').addEventListener("click", () => { selectedExtensions = new Set(ALL_EXTENSIONS); syncFileTypeTree(); markDirty(); });
    el.querySelector('[data-quick="none"]').addEventListener("click", () => { selectedExtensions = new Set(); syncFileTypeTree(); markDirty(); });

    syncFileTypeTree();
  }

  function syncFileTypeTree() {
    let total = 0;
    for (const catKey of CATEGORY_ORDER) {
      const types = TYPES_BY_CATEGORY.get(catKey);
      let catExtCount = 0, catCheckedCount = 0;
      for (const type of types) {
        let langCheckedCount = 0;
        for (const ext of type.extensions) {
          const checked = selectedExtensions.has(ext);
          if (checked) { langCheckedCount++; catCheckedCount++; total++; }
          catExtCount++;
          const extInput = extInputs.get(ext);
          if (extInput) extInput.checked = checked;
        }
        const langInput = langInputs.get(type.id);
        if (langInput) {
          langInput.checked = type.extensions.length > 0 && langCheckedCount === type.extensions.length;
          langInput.indeterminate = langCheckedCount > 0 && langCheckedCount < type.extensions.length;
        }
      }
      const catInput = catInputs.get(catKey);
      if (catInput) {
        catInput.checked = catExtCount > 0 && catCheckedCount === catExtCount;
        catInput.indeterminate = catCheckedCount > 0 && catCheckedCount < catExtCount;
      }
    }
    const countEl = contentEl?.querySelector(".ft-count");
    if (countEl) countEl.textContent = `現在 ${total} 個の拡張子が選択されています`;
  }

  // ---- キーボード(キーバインド一覧、仕様書 C-10) ----
  function effectiveShortcut(cmd) {
    return draft.keyBindings[cmd.id] || cmd.defaultShortcut || "";
  }

  function renderKeybindings(el) {
    const commands = (ctx.commands ?? []).filter((c) => typeof c.run === "function");
    el.innerHTML = `
      <p class="settings-intro">行をクリックしたあと、割り当てたいキーを押してください。Escapeで取り消し、Deleteで既定に戻せます。</p>
      <div class="kb-table" data-field="keyBindings"></div>`;
    renderKeybindingRows(el.querySelector(".kb-table"), commands);
  }

  function renderKeybindingRows(table, commands) {
    // 重複検出(仕様書: 既に使われている組み合わせなら赤系で警告。保存自体は許可する)。
    const byShortcut = new Map();
    for (const cmd of commands) {
      const sc = effectiveShortcut(cmd);
      if (!sc) continue;
      if (!byShortcut.has(sc)) byShortcut.set(sc, []);
      byShortcut.get(sc).push(cmd);
    }
    table.innerHTML = commands.map((cmd) => {
      const sc = effectiveShortcut(cmd);
      const conflictWith = sc && byShortcut.get(sc).length > 1 ? byShortcut.get(sc).filter((c) => c.id !== cmd.id) : [];
      const capturing = capturingCommandId === cmd.id;
      const menuLabel = cmd.menu ? (MENU_LABELS[cmd.menu] ?? cmd.menu) : "";
      // 捕捉中に割り当て不可なキーが押された場合は、重複警告と同じ見た目(kb-cell-warn)で
      // 理由を案内する。捕捉状態は続行するため、キー入力欄の表示("キーを押してください…")は変えない。
      const warnText = capturing && captureRejectMessage ? captureRejectMessage
        : (conflictWith.length && !capturing ? `${conflictWith.map((c) => c.label).join("・")} と重複` : "");
      return `
        <button type="button" class="kb-row${capturing ? " capturing" : ""}${conflictWith.length ? " conflict" : ""}" data-cmd="${cmd.id}">
          <span class="kb-cell-label">${menuLabel ? menuLabel + ": " : ""}${cmd.label}</span>
          <span class="kb-cell-shortcut">${capturing ? "キーを押してください…" : (sc ? `<kbd>${sc}</kbd>` : "(なし)")}</span>
          ${warnText ? `<span class="kb-cell-warn">${warnText}</span>` : ""}
        </button>`;
    }).join("");
    for (const row of table.querySelectorAll(".kb-row")) {
      row.addEventListener("click", () => startCapture(row.dataset.cmd, table, commands));
    }
  }

  function startCapture(cmdId, table, commands) {
    cancelActiveCapture(); // 別の行を続けてクリックした場合、前の捕捉待ちを終わらせる
    capturingCommandId = cmdId;
    captureRejectMessage = null;
    ctx.shortcutsSuppressed = true; // 既存のショートカット発火を止める(commands.js側で参照)
    renderKeybindingRows(table, commands);

    function onKeydown(e) {
      e.preventDefault();
      e.stopPropagation();
      // Escapeは常に「捕捉の取り消し」。設定画面自体を閉じる操作と揃え、修飾キーの
      // 有無によらず割り当て対象にはしない(閉じる操作としての一貫性を優先する)。
      if (e.key === "Escape") { finishCapture(); return; }
      // Delete/Backspaceは無modifierのときだけ「既定に戻す」の意味を持たせる。
      // Ctrl/Altを伴う場合(例: Ctrl+Backspace)は通常の割り当て候補として下へ処理を続ける。
      const noModifier = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if ((e.key === "Delete" || e.key === "Backspace") && noModifier) {
        delete draft.keyBindings[cmdId];
        markDirty();
        finishCapture();
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return; // 修飾キー単体はまだ待つ(押している途中)
      const combo = comboFromEvent(e);
      if (!combo) return;
      // 実害防止のための本体チェック: Ctrl/Altを伴わない文字キー単独などを割り当てて
      // しまうと、bindShortcutsがcaptureフェーズでpreventDefaultするためエディタで
      // その文字が二度と入力できなくなる(設定画面からの再割り当てでしか復旧できない)。
      // commands.js側(保存済み設定のサニタイズ)と同じ判定関数を使い、基準を一元化している。
      if (!isAssignableShortcut(combo)) {
        captureRejectMessage = "Ctrl または Alt との組み合わせか、ファンクションキーを指定してください";
        renderKeybindingRows(table, commands); // 捕捉状態は継続し、理由だけ表示して待ち続ける
        return;
      }
      draft.keyBindings[cmdId] = combo;
      markDirty();
      finishCapture();
    }
    function finishCapture() {
      document.removeEventListener("keydown", onKeydown, true);
      ctx.shortcutsSuppressed = false;
      capturingCommandId = null;
      captureRejectMessage = null;
      activeCaptureCleanup = null;
      renderKeybindingRows(table, commands);
    }
    activeCaptureCleanup = finishCapture;
    document.addEventListener("keydown", onKeydown, true);
  }

  // ---- 詳細: 値ではなくアクションのボタン ----
  // 破壊的な操作(設定のリセット・履歴の消去)は、押してすぐには送らず、画面内に収まる
  // 自前の確認表示(adv-confirm)を挟む。ブラウザ標準の確認ダイアログは使わない(WebView2でブロックされうるため)。
  const NON_DESTRUCTIVE_ACTIONS = [
    { action: "open-settings-file", label: "設定ファイルの場所を開く" },
    { action: "open-default-apps-settings", label: "Windowsの「既定のアプリ」設定を開く" },
  ];
  const DESTRUCTIVE_ACTIONS = [
    { action: "reset-settings", label: "設定をすべて既定に戻す", confirm: "本当にすべての設定を既定値に戻しますか?この操作は取り消せません。", confirmLabel: "既定に戻す" },
    { action: "clear-recent-files", label: "最近使ったファイルの履歴を消去", confirm: "最近使ったファイルの履歴をすべて消去しますか?この操作は取り消せません。", confirmLabel: "消去する" },
    { action: "clear-per-file-modes", label: "ファイル単位の編集モード記憶を消去", confirm: "ファイルごとに記憶した編集モードをすべて消去しますか?この操作は取り消せません。", confirmLabel: "消去する" },
  ];

  function renderAdvanced(el) {
    el.innerHTML = `
      <div class="settings-group">
        ${fieldCheckbox("enableDebug", "開発者ツールを使えるようにする", "Shift+F12 で WebView2 の開発者ツールを開けるようになります。")}
        ${fieldCheckbox("verboseLogging", "詳細ログを記録する", "普段は起動・保存・エラーなどの節目だけを記録します。これを有効にすると、メニュー操作や画面の更新まで1つ残らず記録します。不具合の報告を求められたときだけ使ってください(ログが読みにくくなります)。")}
        ${fieldCheckbox("showHiddenFilesInTree", "隠しファイルを表示")}
      </div>
      <div class="settings-group">
        ${fieldTextarea("fileTreePatterns", "ファイルツリーの除外パターン", "1行に1パターン(glob)。<code>!</code>で始めると除外の否定になります。", { lines: true, rows: 4 })}
      </div>
      <div class="settings-group">
        ${fieldCheckbox("addToPath", "コマンドラインからのPane起動を有効化", "exeのあるフォルダをユーザー環境変数PATHへ追加します(管理者権限は不要)。インストーラは使わない方針のため、この設定からのみ登録・解除します。")}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">操作</div>
        <div class="adv-actions">
          ${NON_DESTRUCTIVE_ACTIONS.map((a) => `
            <div class="adv-action-row">
              <button type="button" class="btn tiny" data-action="${a.action}">${a.label}</button>
            </div>`).join("")}
          ${DESTRUCTIVE_ACTIONS.map((a) => `
            <div class="adv-action-row" data-confirm-row="${a.action}">
              <button type="button" class="btn tiny danger" data-danger-action="${a.action}">${a.label}</button>
              <div class="adv-confirm" hidden>
                <span class="adv-confirm-text">${a.confirm}</span>
                <button type="button" class="btn tiny danger" data-confirm-yes="${a.action}">${a.confirmLabel}</button>
                <button type="button" class="btn tiny" data-confirm-no="${a.action}">キャンセル</button>
              </div>
            </div>`).join("")}
        </div>
        <div class="adv-action-msg" aria-live="polite"></div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">設定ファイル</div>
        <div class="settings-field-desc">${draft.settingsFilePath ? escapeHtml(draft.settingsFilePath) : "(不明)"}</div>
      </div>`;
    wireCommonFields(el);
    wireAdvancedActions(el);
  }

  function wireAdvancedActions(el) {
    const msgEl2 = el.querySelector(".adv-action-msg");
    const showMsg = (text) => {
      if (!msgEl2) return;
      msgEl2.textContent = text;
      setTimeout(() => { if (msgEl2.isConnected) msgEl2.textContent = ""; }, 2500);
    };
    for (const btn of el.querySelectorAll('.adv-action-row > [data-action]')) {
      btn.addEventListener("click", () => {
        ctx.bridge?.postMessage({ type: btn.dataset.action });
        showMsg("実行しました");
      });
    }
    for (const row of el.querySelectorAll("[data-confirm-row]")) {
      const action = row.dataset.confirmRow;
      const confirmEl = row.querySelector(".adv-confirm");
      row.querySelector(`[data-danger-action="${action}"]`).addEventListener("click", () => { confirmEl.hidden = false; });
      row.querySelector(`[data-confirm-no="${action}"]`).addEventListener("click", () => { confirmEl.hidden = true; });
      row.querySelector(`[data-confirm-yes="${action}"]`).addEventListener("click", () => {
        confirmEl.hidden = true;
        ctx.bridge?.postMessage({ type: action });
        showMsg("実行しました");
      });
    }
  }

  // ---- バージョン情報(Graftと同じく設定の最後にまとめる。C-01〜C-14には無い追加カテゴリ) ----
  // すべて表示専用(保存対象ではない)。値はSettingsBridge.PostSettingsSnapshotが
  // "settings"応答に含める(appVersion/webView2Version/dotNetVersion/logFolderPath/
  // themeFolderPath/licenses。既存のsettingsFilePathも流用)。ボタンはブリッジへ
  // メッセージを送るだけで、応答を待たず押した側だけ完結する(advanced操作ボタンと同じ作法)。
  // ---- 更新(仕様書 U-01〜U-04) ----
  // 通信するのは利用者がボタンを押したときだけで、起動時や定期的な確認は行わない。
  // 画面はupdatePhase/updateCheckResult/updateProgressの3つだけを見て組み立て、
  // C#からの返信が届くたびにこのセクションだけを描き直す(入力欄が無いので作り直してよい)。
  function updateSectionHtml() {
    if (!ctx.bridge) {
      return '<div class="settings-field-desc">この画面単体では更新を確認できません。</div>';
    }
    const busy = updatePhase === "checking" || updatePhase === "applying";
    const checkLabel = updatePhase === "checking" ? "確認しています…" : "更新を確認";
    let body = "";

    if (updatePhase === "applying" || updatePhase === "failed") {
      const percent = updateProgress && typeof updateProgress.percent === "number" ? updateProgress.percent : -1;
      const isError = updatePhase === "failed";
      body = `
        <div class="settings-update-status${isError ? " error" : ""}">${escapeHtml((updateProgress && updateProgress.message) || "")}</div>
        ${percent >= 0 ? `<div class="settings-update-bar"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>` : ""}`;
    } else if (updatePhase === "checked" && updateCheckResult) {
      const r = updateCheckResult;
      const sizeText = r.sizeBytes > 0 ? `（約${Math.round(r.sizeBytes / (1024 * 1024))}MB）` : "";
      body = `
        <div class="settings-update-status${r.status === "error" ? " error" : ""}">${escapeHtml(r.message || "")}</div>
        <div class="settings-info-row">
          ${r.canApply ? `<button type="button" class="btn tiny primary" data-update-action="apply">更新する${escapeHtml(sizeText)}</button>` : ""}
          ${r.releaseUrl ? '<button type="button" class="btn tiny" data-update-action="open-release">リリースページを開く</button>' : ""}
        </div>`;
    }

    // 問い合わせ先を隠さずに出す(仕様書 U-02)。どこへ通信するのかを、設定ファイルを
    // 開かなくてもこの画面で確かめられるようにするため。
    const url = draft.updateCheckUrl || "";
    return `
      <p class="settings-intro">確認と更新は、下のボタンを押したときにだけ行います。自動では通信しません。</p>
      <div class="settings-info-row">
        <button type="button" class="btn tiny" data-update-action="check"${busy ? " disabled" : ""}>${escapeHtml(checkLabel)}</button>
      </div>
      ${body}
      ${url ? `<div class="settings-field-desc">問い合わせ先: ${escapeHtml(url)}</div>` : ""}`;
  }

  // 更新セクションだけを描き直す。バージョン情報タブを開いていなければ何もしない
  // (状態は残るので、開き直したときに最後の結果がそのまま出る)。
  function refreshUpdateSection() {
    const host = contentEl && contentEl.querySelector("[data-update-section]");
    if (!host) return;
    host.innerHTML = updateSectionHtml();
    bindUpdateSection(host);
  }

  function bindUpdateSection(host) {
    for (const btn of host.querySelectorAll("[data-update-action]")) {
      btn.addEventListener("click", () => onUpdateAction(btn.dataset.updateAction));
    }
  }

  async function onUpdateAction(action) {
    if (!ctx.bridge) return;
    if (action === "check") {
      updatePhase = "checking";
      updateCheckResult = null;
      updateProgress = null;
      refreshUpdateSection();
      ctx.bridge.postMessage({ type: "check-update" });
      return;
    }
    if (action === "open-release") {
      ctx.bridge.postMessage({ type: "open-release-page" });
      return;
    }
    if (action === "apply") {
      // 入れ替えのあと自動で再起動するため、始める前に必ず確認する
      // (押し間違いで作業中のウィンドウが閉じてしまうのを防ぐ)。
      const version = (updateCheckResult && updateCheckResult.latestVersion) || "新しい版";
      const ok = await paneConfirm({
        title: "更新しますか?",
        message: `${version} をダウンロードして入れ替えます。入れ替えのあとPaneは再起動します。` +
          "保存していない文書があると更新できないので、先に保存してください。",
        okLabel: "更新する",
      });
      if (!ok) return;
      updatePhase = "applying";
      updateProgress = { message: "準備しています…", percent: -1 };
      refreshUpdateSection();
      ctx.bridge.postMessage({ type: "apply-update" });
    }
  }

  function handleUpdateCheckResult(msg) {
    updatePhase = "checked";
    updateCheckResult = {
      status: msg.status || "error",
      currentVersion: msg.currentVersion || "",
      latestVersion: msg.latestVersion || "",
      message: msg.message || "",
      releaseUrl: msg.releaseUrl || "",
      canApply: !!msg.canApply,
      sizeBytes: typeof msg.sizeBytes === "number" ? msg.sizeBytes : 0,
    };
    refreshUpdateSection();
  }

  function handleUpdateProgress(msg) {
    // stage="error"は適用の失敗。それ以外(checking/downloading/applying/restarting)は
    // 進行中で、restartingまで来たらこの画面は間もなく閉じられる。
    updatePhase = msg.stage === "error" ? "failed" : "applying";
    updateProgress = {
      message: msg.message || "",
      percent: typeof msg.percent === "number" ? msg.percent : -1,
    };
    refreshUpdateSection();
  }

  function renderVersionInfo(el) {
    const licensesHtml = (draft.licenses ?? []).map((lic) => `
      <div class="settings-license-row">
        <span class="settings-license-name">${escapeHtml(lic.name ?? "")}</span>
        <span class="settings-license-type">${escapeHtml(lic.license ?? "")}</span>
      </div>`).join("");
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">Pane</div>
        <div class="settings-field-desc">バージョン: ${escapeHtml(draft.appVersion || "不明")}</div>
        <div class="settings-field-desc">WebView2ランタイム: ${escapeHtml(draft.webView2Version || "不明")}</div>
        <div class="settings-field-desc">.NET: ${escapeHtml(draft.dotNetVersion || "不明")}</div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">更新</div>
        <div data-update-section>${updateSectionHtml()}</div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">場所</div>
        <div class="settings-info-row">
          <span class="settings-info-label">設定ファイル: ${draft.settingsFilePath ? escapeHtml(draft.settingsFilePath) : "(不明)"}</span>
          <button type="button" class="btn tiny" data-action="open-settings-file">開く</button>
        </div>
        <div class="settings-info-row">
          <span class="settings-info-label">ログファイル: ${draft.logFolderPath ? escapeHtml(draft.logFolderPath) : "(不明)"}</span>
          <button type="button" class="btn tiny" data-action="open-log-folder">フォルダを開く</button>
          <button type="button" class="btn tiny" data-action="open-today-log">今日のログを開く</button>
        </div>
        <div class="settings-info-row">
          <span class="settings-info-label">カスタムCSSフォルダ: ${draft.themeFolderPath ? escapeHtml(draft.themeFolderPath) : "(不明)"}</span>
          <button type="button" class="btn tiny" data-action="open-theme-folder">開く</button>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">ライセンス</div>
        <p class="settings-intro">Pane本体、および同梱している主要なオープンソースソフトウェアのライセンスです。</p>
        <div class="settings-license-list">${licensesHtml || '<span class="settings-field-desc">(読み込み中…)</span>'}</div>
      </div>`;
    for (const btn of el.querySelectorAll("[data-action]")) {
      btn.addEventListener("click", () => ctx.bridge?.postMessage({ type: btn.dataset.action }));
    }
    const updateHost = el.querySelector("[data-update-section]");
    if (updateHost) bindUpdateSection(updateHost);
  }

  // ---- カテゴリ切替のディスパッチ ----
  function renderContent() {
    if (!contentEl || !draft) return;
    cancelActiveCapture(); // タブを離れる際はキーバインド捕捉待ちを残さない
    switch (activeCategory) {
      case "file": renderFile(contentEl); break;
      case "edit": renderEdit(contentEl); break;
      case "markdown": renderMarkdownCategory(contentEl); break;
      case "image": renderImage(contentEl); break;
      case "export": renderExport(contentEl); break;
      case "appearance": renderAppearance(contentEl); break;
      case "fileTypes": renderFileTypes(contentEl); break;
      case "keyboard": renderKeybindings(contentEl); break;
      case "advanced": renderAdvanced(contentEl); break;
      case "versionInfo": renderVersionInfo(contentEl); break;
      default: renderGeneral(contentEl); break;
    }
  }

  return { open, close: requestClose, isOpen, handleSettingsLoaded, handleSaveResult };
}
