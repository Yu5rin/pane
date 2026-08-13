// コマンドレジストリ・メニューバー・コマンドパレット(仕様書 第2章・第10.1節・第10.4節)。
// 「メニューバーと機能を重複させ、どちらか一方だけでも全操作に到達できる状態にする」
// という設計方針(第10.1節)に沿い、メニュー項目とコマンドパレット項目は同じ配列
// (buildCommands の戻り値)を参照する。
//
// ctx の形:
//   {
//     editor,                 // createEditor()の戻り値
//     bridge,                 // window.chrome.webview または null
//     getState(),              // { mode, isReadOnly, pandocAvailable, wordWrap, sourceMode, focusMode,
//                              //   typewriterMode, fullscreen, alwaysOnTop, showWordCount,
//                              //   keyBindings(コマンドID→ショートカット文字列。設定画面 C-10), ... } を返す
//     actions: { ... },       // main.js側のファイル操作・ダイアログ等のオーケストレーション
//   }

// Paneは仕様書上Windows専用(WinForms + WebView2)のため、修飾キーはCtrl固定でよい。
const MOD = "Ctrl";

// メニュー配下の項目定義。grayed(ctx)がtrueを返す項目は無効表示にする
// (仕様書: フォルダ機能に依存する項目はPhase 6まで準備中)。
export function buildCommands(ctx) {
  const editor = () => ctx.editor;
  const app = (fn) => () => fn(ctx);

  const commands = [
    // ---- File(第2.1節) ----
    { id: "file.new", menu: "File", label: "新規作成", shortcut: `${MOD}+N`, run: app((c) => c.actions.newDocument()) },
    { id: "file.newWindow", menu: "File", label: "新しいウィンドウ", shortcut: `${MOD}+Shift+N`, run: app((c) => c.actions.newWindow()) },
    { id: "file.newTab", menu: "File", label: "新しいタブ", grayed: () => true, note: "準備中(Phase 8)" },
    { id: "file.open", menu: "File", label: "開く", shortcut: `${MOD}+O`, run: app((c) => c.actions.openFile()) },
    { id: "file.openFolder", menu: "File", label: "フォルダを開く", run: app((c) => c.actions.openFolder()) },
    { id: "file.quickOpen", menu: "File", label: "クイックオープン", shortcut: `${MOD}+P`, run: app((c) => c.actions.openQuickOpen()), enabled: () => ctx.getState().folderLoaded },
    { id: "file.reopenClosed", menu: "File", label: "閉じたファイルを再度開く", shortcut: `${MOD}+Shift+T`, run: app((c) => c.actions.reopenClosed()), enabled: () => ctx.getState().hasClosedFile },
    {
      id: "file.recentFiles", menu: "File", label: "最近使ったファイル",
      submenu: () => {
        const files = ctx.getState().recentFiles ?? [];
        if (!files.length) return [{ label: "(なし)", disabled: true }];
        return files.map((p) => ({ label: p, run: () => ctx.actions.openRecentFile(p) }));
      },
      separatorAfter: true,
    },
    { id: "file.save", menu: "File", label: "保存", shortcut: `${MOD}+S`, run: app((c) => c.actions.save()) },
    { id: "file.saveAs", menu: "File", label: "名前を付けて保存", shortcut: `${MOD}+Shift+S`, run: app((c) => c.actions.saveAs()), separatorAfter: true },
    { id: "file.exportPdf", menu: "File", label: "エクスポート: PDF", run: app((c) => c.actions.exportAs("pdf")) },
    { id: "file.exportHtml", menu: "File", label: "エクスポート: HTML", run: app((c) => c.actions.exportAs("html")) },
    { id: "file.exportHtmlPlain", menu: "File", label: "エクスポート: HTML(スタイルなし)", run: app((c) => c.actions.exportAs("html-plain")) },
    { id: "file.exportWord", menu: "File", label: "エクスポート: Word", run: app((c) => c.actions.exportAs("docx")), enabled: () => ctx.getState().pandocAvailable, note: "Pandoc未導入" },
    { id: "file.exportEpub", menu: "File", label: "エクスポート: EPUB", run: app((c) => c.actions.exportAs("epub")), enabled: () => ctx.getState().pandocAvailable, note: "Pandoc未導入", separatorAfter: true },
    { id: "file.print", menu: "File", label: "印刷", shortcut: `${MOD}+Alt+P`, run: app((c) => c.actions.print()), separatorAfter: true },
    { id: "file.settings", menu: "File", label: "設定", shortcut: `${MOD}+,`, run: app((c) => c.actions.openSettings()), separatorAfter: true },
    { id: "file.close", menu: "File", label: "閉じる", shortcut: `${MOD}+W`, run: app((c) => c.actions.closeWindow()) },

    // ---- Edit(第2.2節) ----
    { id: "edit.copyMarkdown", menu: "Edit", label: "マークダウンとしてコピー", shortcut: `${MOD}+Shift+C`, run: app((c) => c.actions.copyAsMarkdown()) },
    { id: "edit.copyHtml", menu: "Edit", label: "HTMLとしてコピー", run: app((c) => c.actions.copyAsHtml()) },
    { id: "edit.pastePlain", menu: "Edit", label: "プレーンテキストとして貼り付け", shortcut: `${MOD}+Shift+V`, run: app((c) => c.actions.pasteAsPlainText()), separatorAfter: true },
    { id: "edit.selectLine", menu: "Edit", label: "行/文を選択", shortcut: `${MOD}+L`, run: () => editor().applyAction("selectLine") },
    { id: "edit.selectStyleRange", menu: "Edit", label: "スタイル範囲を選択", shortcut: `${MOD}+E`, run: () => editor().applyAction("selectStyleRange") },
    { id: "edit.selectWord", menu: "Edit", label: "単語を選択", shortcut: `${MOD}+D`, run: () => editor().applyAction("selectWord") },
    { id: "edit.deleteWord", menu: "Edit", label: "単語を削除", shortcut: `${MOD}+Shift+D`, run: () => editor().applyAction("deleteWord") },
    { id: "edit.deleteTableRow", menu: "Edit", label: "表の行を削除", shortcut: `${MOD}+Shift+Backspace`, run: () => editor().applyAction("deleteTableRow"), separatorAfter: true },
    { id: "edit.jumpToSelection", menu: "Edit", label: "選択箇所へジャンプ", shortcut: `${MOD}+J`, run: () => editor().applyAction("scrollToSelection"), separatorAfter: true },
    { id: "edit.find", menu: "Edit", label: "検索", shortcut: `${MOD}+F`, run: app((c) => c.actions.openSearch()) },
    { id: "edit.findNext", menu: "Edit", label: "次を検索", shortcut: "F3", run: () => editor().findNext() },
    { id: "edit.findPrev", menu: "Edit", label: "前を検索", shortcut: "Shift+F3", run: () => editor().findPrevious() },
    { id: "edit.replace", menu: "Edit", label: "置換", shortcut: `${MOD}+H`, run: app((c) => c.actions.openReplace()) },
    { id: "edit.globalSearch", menu: "Edit", label: "フォルダ内を検索", shortcut: `${MOD}+Shift+F`, run: app((c) => c.actions.openGlobalSearch()), separatorAfter: true },
    // 日時の挿入(仕様書 第3章 N-14): Windowsのメモ帳と同じくF5キー、書式は YYYY/MM/DD HH:mm。
    { id: "edit.insertDateTime", menu: "Edit", label: "日時の挿入", shortcut: "F5", run: app((c) => c.actions.insertDateTime()) },

    // ---- Paragraph(第2.3節) ----
    { id: "para.h1", menu: "Paragraph", label: "見出し1", shortcut: `${MOD}+1`, run: () => editor().applyAction("h1") },
    { id: "para.h2", menu: "Paragraph", label: "見出し2", shortcut: `${MOD}+2`, run: () => editor().applyAction("h2") },
    { id: "para.h3", menu: "Paragraph", label: "見出し3", shortcut: `${MOD}+3`, run: () => editor().applyAction("h3") },
    { id: "para.h4", menu: "Paragraph", label: "見出し4", shortcut: `${MOD}+4`, run: () => editor().applyAction("h4") },
    { id: "para.h5", menu: "Paragraph", label: "見出し5", shortcut: `${MOD}+5`, run: () => editor().applyAction("h5") },
    { id: "para.h6", menu: "Paragraph", label: "見出し6", shortcut: `${MOD}+6`, run: () => editor().applyAction("h6") },
    { id: "para.p", menu: "Paragraph", label: "段落(見出し解除)", shortcut: `${MOD}+0`, run: () => editor().applyAction("h0") },
    { id: "para.headingUp", menu: "Paragraph", label: "見出しレベルを上げる", shortcut: `${MOD}+=`, run: () => editor().applyAction("headingUp") },
    { id: "para.headingDown", menu: "Paragraph", label: "見出しレベルを下げる", shortcut: `${MOD}+-`, run: () => editor().applyAction("headingDown"), separatorAfter: true },
    { id: "para.table", menu: "Paragraph", label: "表を挿入", shortcut: `${MOD}+T`, run: () => editor().applyAction("table") },
    { id: "para.codeblock", menu: "Paragraph", label: "コードブロックを挿入", shortcut: `${MOD}+Shift+K`, run: () => editor().applyAction("codeblock") },
    { id: "para.mathBlock", menu: "Paragraph", label: "数式ブロックを挿入", shortcut: `${MOD}+Shift+M`, run: () => editor().applyAction("mathBlock") },
    { id: "para.quote", menu: "Paragraph", label: "引用", shortcut: `${MOD}+Shift+Q`, run: () => editor().applyAction("quote") },
    { id: "para.olist", menu: "Paragraph", label: "番号付きリスト", shortcut: `${MOD}+Shift+[`, run: () => editor().applyAction("olist") },
    { id: "para.list", menu: "Paragraph", label: "箇条書きリスト", shortcut: `${MOD}+Shift+]`, run: () => editor().applyAction("list") },
    { id: "para.indent", menu: "Paragraph", label: "インデント", shortcut: `${MOD}+[`, run: () => editor().applyAction("indent") },
    { id: "para.outdent", menu: "Paragraph", label: "アウトデント", shortcut: `${MOD}+]`, run: () => editor().applyAction("outdent"), separatorAfter: true },
    { id: "para.listBullet", menu: "Paragraph", label: "箇条書きに変換", contextOnly: true, run: () => editor().applyAction("listBullet") },
    { id: "para.listOrdered", menu: "Paragraph", label: "番号付きリストに変換", contextOnly: true, run: () => editor().applyAction("listOrdered") },
    { id: "para.listCheck", menu: "Paragraph", label: "タスクリストに変換", contextOnly: true, run: () => editor().applyAction("listCheck"), separatorAfter: true },
    { id: "para.frontMatter", menu: "Paragraph", label: "YAML Front Matterを挿入", run: () => editor().applyAction("frontMatter") },

    // ---- Format(第2.4節) ----
    { id: "format.bold", menu: "Format", label: "太字", shortcut: `${MOD}+B`, run: () => editor().applyAction("bold") },
    { id: "format.italic", menu: "Format", label: "斜体", shortcut: `${MOD}+I`, run: () => editor().applyAction("italic") },
    { id: "format.underline", menu: "Format", label: "下線", shortcut: `${MOD}+U`, run: () => editor().applyAction("underline") },
    { id: "format.code", menu: "Format", label: "インラインコード", shortcut: "Ctrl+Shift+`", run: () => editor().applyAction("code") },
    { id: "format.strike", menu: "Format", label: "打消し線", shortcut: "Alt+Shift+5", run: () => editor().applyAction("strike") },
    { id: "format.highlight", menu: "Format", label: "ハイライト", run: () => editor().applyAction("highlight") },
    { id: "format.superscript", menu: "Format", label: "上付き文字", run: () => editor().applyAction("superscript") },
    { id: "format.subscript", menu: "Format", label: "下付き文字", run: () => editor().applyAction("subscript"), separatorAfter: true },
    { id: "format.link", menu: "Format", label: "ハイパーリンク", shortcut: `${MOD}+K`, run: () => editor().applyAction("link") },
    { id: "format.image", menu: "Format", label: "画像", shortcut: `${MOD}+Shift+I`, run: app((c) => c.actions.insertImageFlow()), separatorAfter: true },
    { id: "format.eraseFormat", menu: "Format", label: "書式を消去", shortcut: `${MOD}+\\`, run: () => editor().applyAction("eraseFormat") },

    // ---- View(第2.5節) ----
    { id: "view.sidebar", menu: "View", label: "サイドバーの表示切替", shortcut: `${MOD}+Shift+L`, run: app((c) => c.actions.toggleSidebar()), checked: () => ctx.getState().sidebarOpen },
    { id: "view.outline", menu: "View", label: "アウトラインパネル", shortcut: `${MOD}+Shift+1`, run: app((c) => c.actions.showSidebarPanel("outline")), checked: () => ctx.getState().sidebarOpen && ctx.getState().sidebarPanel === "outline" },
    { id: "view.articleList", menu: "View", label: "記事リスト", shortcut: `${MOD}+Shift+2`, run: app((c) => c.actions.showSidebarPanel("files")), checked: () => ctx.getState().sidebarOpen && ctx.getState().sidebarPanel === "files" },
    { id: "view.fileTree", menu: "View", label: "ファイルツリー", shortcut: `${MOD}+Shift+3`, run: app((c) => c.actions.showSidebarPanel("tree")), checked: () => ctx.getState().sidebarOpen && ctx.getState().sidebarPanel === "tree", separatorAfter: true },
    { id: "view.modeMarkdown", menu: "View", label: "Markdownモード", run: app((c) => c.actions.setMode("markdown")), checked: () => ctx.getState().mode === "markdown" },
    { id: "view.modePlain", menu: "View", label: "プレーンテキストモード", run: app((c) => c.actions.setMode("plain")), checked: () => ctx.getState().mode === "plain" },
    { id: "view.modeCode", menu: "View", label: "コードモード", run: app((c) => c.actions.setMode("code")), checked: () => ctx.getState().mode === "code", separatorAfter: true },
    { id: "view.sourceMode", menu: "View", label: "ソースコードモード", shortcut: `${MOD}+/`, run: app((c) => c.actions.toggleSourceMode()), checked: () => ctx.getState().sourceMode },
    { id: "view.focusMode", menu: "View", label: "フォーカスモード", shortcut: "F8", run: app((c) => c.actions.toggleFocusMode()), checked: () => ctx.getState().focusMode },
    { id: "view.typewriterMode", menu: "View", label: "タイプライターモード", shortcut: "F9", run: app((c) => c.actions.toggleTypewriterMode()), checked: () => ctx.getState().typewriterMode, separatorAfter: true },
    { id: "view.wordWrap", menu: "View", label: "折り返し表示", run: app((c) => c.actions.toggleWordWrap()), checked: () => ctx.getState().wordWrap },
    { id: "view.gotoLine", menu: "View", label: "指定行へジャンプ", shortcut: `${MOD}+G`, run: app((c) => c.actions.gotoLineFlow()), separatorAfter: true },
    { id: "view.fullscreen", menu: "View", label: "全画面表示", shortcut: "F11", run: app((c) => c.actions.toggleFullscreen()), checked: () => ctx.getState().fullscreen },
    { id: "view.zoomReset", menu: "View", label: "実際のサイズ", shortcut: `${MOD}+Shift+0`, run: app((c) => c.actions.zoomReset()) },
    { id: "view.zoomIn", menu: "View", label: "拡大", shortcut: `${MOD}+Shift+=`, run: app((c) => c.actions.zoomIn()) },
    { id: "view.zoomOut", menu: "View", label: "縮小", shortcut: `${MOD}+Shift+-`, run: app((c) => c.actions.zoomOut()), separatorAfter: true },
    { id: "view.switchDocument", menu: "View", label: "開いている文書を切り替え", shortcut: `${MOD}+Tab`, run: app((c) => c.actions.switchDocument()) },
    { id: "view.alwaysOnTop", menu: "View", label: "常に手前に表示", run: app((c) => c.actions.toggleAlwaysOnTop()), checked: () => ctx.getState().alwaysOnTop, separatorAfter: true },
    { id: "view.wordCount", menu: "View", label: "文字数カウントの表示", run: app((c) => c.actions.toggleWordCount()), checked: () => ctx.getState().showWordCount, separatorAfter: true },
    { id: "view.devtools", menu: "View", label: "開発者ツール", shortcut: "Shift+F12", run: app((c) => c.actions.openDevTools()), enabled: () => !!ctx.bridge },
  ];

  // キーバインドのカスタマイズ(仕様書 第2.10節 C-10)。設定画面(settings.js)で
  // 保存されたctx.getState().keyBindings(コマンドID→ショートカット文字列)があれば、
  // ここでコマンド定義の既定shortcutを差し替える。
  applyKeyBindings(commands, ctx.getState().keyBindings);
  return commands;
}

// commands配列(buildCommandsの戻り値と同一のインスタンス)へ、保存済みキーバインドを
// 適用する。各コマンドオブジェクトを直接書き換えるため、メニューバー・コマンドパレット・
// ショートカット待受け(bindShortcuts)・設定画面はいずれも同じ配列を参照している限り、
// 再生成なしに新しい値をすぐ参照できる(設定保存直後にmain.js側から呼び直す想定)。
// defaultShortcutには最初に呼ばれた時点のshortcut(=コマンド定義に書かれた既定値)を
// 保持しておき、設定画面の「既定に戻す」操作がkeyBindingsから該当エントリを削除するだけで
// 済むようにする。
export function applyKeyBindings(commands, keyBindings) {
  for (const cmd of commands) {
    if (cmd.defaultShortcut === undefined) cmd.defaultShortcut = cmd.shortcut;
    const custom = keyBindings?.[cmd.id];
    // 設定ファイルに直接書き込まれた(手動編集/旧バージョン保存分の)値は、settings.js側の
    // 入力制限をすり抜けている可能性がある。ここでも同じ判定(isAssignableShortcut)を
    // 通し、修飾キーなしの単独文字キーのような危険な割り当てを弾いて既定値へフォールバック
    // させる。放置すると bindShortcuts が window の capture フェーズでそのキーを
    // preventDefault してしまい、エディタ上でその文字が二度と入力できなくなる
    // (設定画面からの再割り当てでしか復旧できない)事故につながるため。
    if (custom && !isAssignableShortcut(custom)) {
      console.warn(`[keybindings] "${custom}" は割り当て不可なショートカットのため無視し、既定値 "${cmd.defaultShortcut ?? "(なし)"}" にフォールバックしました (${cmd.id})`);
      cmd.shortcut = cmd.defaultShortcut;
      continue;
    }
    cmd.shortcut = custom || cmd.defaultShortcut;
  }
}

// ---- ショートカット文字列の割り当て可否判定 ----
// settings.js(キー捕捉時の入力制限)と本ファイルのapplyKeyBindings(保存済み設定の
// サニタイズ)の双方から使う共通ロジック。判定基準(実害防止のため):
//   ・Ctrl または Alt を含む組み合わせ → 許可(通常の文字入力と衝突しない)
//   ・ファンクションキー(F1〜F12)単独、およびShiftとの併用 → 許可
//   ・上記以外(修飾キーなしの文字/数字/記号キー、Shiftのみを伴う文字キーなど) → 拒否
// 拒否対象を割り当ててしまうと、bindShortcutsがwindowのcaptureフェーズでそのキー入力を
// preventDefaultするため、エディタでその文字が二度と入力できなくなる
// (設定画面から割り当て直す以外に復旧手段がない)。
const ASSIGNABLE_MODIFIER_TOKENS = new Set(["Ctrl", "Shift", "Alt"]);
const FUNCTION_KEY_RE = /^F([1-9]|1[0-2])$/i;
export function isAssignableShortcut(shortcutString) {
  if (!shortcutString || typeof shortcutString !== "string") return false;
  const parts = shortcutString.split("+").filter(Boolean);
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  // "Ctrl+Shift"のように末尾まで修飾子しかない(=キー本体が無い)壊れた値は拒否。
  if (!mods.every((m) => ASSIGNABLE_MODIFIER_TOKENS.has(m))) return false;
  if (ASSIGNABLE_MODIFIER_TOKENS.has(key)) return false;
  if (mods.includes("Ctrl") || mods.includes("Alt")) return true;
  // Ctrl/Altを伴わない場合は、ファンクションキー単独(Shift併用可)のみ許可する。
  return FUNCTION_KEY_RE.test(key);
}

// ---- メニューバー(仕様書 第10.1節・第10.4節) ----
// 既定は表示。Altキーで表示・非表示をトグルする(表示中はショートカット一覧としても機能する)。
// 内部の分類キー(コマンド定義の menu プロパティ、File/Edit/Paragraph/Format/View)は
// 既存コード全体の判定に使われているため英語のまま維持し、表示ラベルだけ日本語化する
// (多言語対応は将来別途行う予定のため、ここでは決め打ちの日本語のみとする)。
export const MENU_LABELS = { File: "ファイル", Edit: "編集", Paragraph: "段落", Format: "書式", View: "表示" };
export function initMenuBar(container, commands, ctx) {
  // 並びは「ファイル、編集、表示、段落、書式」。
  const menus = ["File", "Edit", "View", "Paragraph", "Format"];
  // コンテナ末尾には右端寄せ用のスペーサーとテーマ切替ボタンが静的HTML側で既に置かれているため、
  // それらは残したまま、メニュー項目だけをその手前に挿入する。
  const anchor = container.firstChild;
  container.querySelectorAll(".menu-top").forEach((el) => el.remove());
  container.setAttribute("role", "menubar");
  let openMenu = null;

  // ---- ネイティブポップアップ経路(ブリッジがある場合) ----
  // ウィンドウを小さくすると項目数の多いメニュー(例: 表示メニュー20項目)が画面外へ
  // はみ出す問題への対応(ユーザー要望)。ブリッジがあるときだけ、HTMLドロップダウンの
  // 代わりにWinFormsのネイティブなポップアップ(Pane/NativeMenu.cs、ToolStripDropDownMenu)を
  // 使う。見出しがクリックされた時点の状態を評価してJSONにしC#へ送り、選ばれた項目の実行は
  // 既存のcommand.run()経路をそのまま使う(コマンドの実装はC#側に持たせない)。
  // 開いている間に別の見出しへマウスを移動する「メニュー間の移動」には対応しない
  // (ネイティブのポップアップが表示されている間、マウスはOS側のポップアップに捕捉され
  // HTML側の見出しボタンのmouseenterはそもそも発火しない。仕様上ここまでで良いとされている)。
  const useNative = !!ctx.bridge;
  // id→実行関数の対応表。開くたびに作り直す(「最近使ったファイル」等の動的なsubmenuは
  // 開くたびに内容が変わり得るため)。submenu項目は元々idを持たないため、ここで
  // `${親のid}/${index}` という一意なidをその場で振り、選択時にこの対応表経由で
  // 元の実行関数へ辿れるようにする。
  let nativeRunRegistry = new Map();
  let nativeOpenBtn = null;

  function buildNativeItem(item) {
    const grayed = item.grayed?.(ctx) ?? false;
    const enabled = !grayed && (item.enabled ? item.enabled(ctx) : true);
    const node = {
      id: item.id ?? null,
      label: item.label,
      shortcut: item.shortcut ?? "",
      enabled,
      checked: !!item.checked?.(ctx),
      separatorAfter: !!item.separatorAfter,
      note: item.note ?? "",
    };
    if (item.id) nativeRunRegistry.set(item.id, item.run);
    if (item.submenu) {
      node.submenu = item.submenu(ctx).map((entry, i) => {
        const subId = `${item.id}/${i}`;
        if (!entry.disabled) nativeRunRegistry.set(subId, entry.run);
        return { id: subId, label: entry.label, shortcut: "", enabled: !entry.disabled, checked: false, separatorAfter: false, note: "" };
      });
    }
    return node;
  }

  function openNativeMenu(menuName, btn) {
    // 開いている見出しをもう一度押したら閉じるだけにする(一般的なメニューの挙動)。
    if (nativeOpenBtn === btn) {
      clearNativeHighlight();
      ctx.bridge?.postMessage({ type: "close-menu" });
      return;
    }
    // 前のメニューがmenu-closed/menu-commandを受け取らないまま次が開かれた場合に備え、
    // 念のため先にハイライトを解除しておく(通常はC#側が前のポップアップを閉じてから
    // 新しいポップアップを開くため起きないはずだが、取りこぼし防止)。
    clearNativeHighlight();
    nativeRunRegistry = new Map();
    const items = commands.filter((c) => c.menu === menuName && !c.contextOnly).map(buildNativeItem);
    nativeOpenBtn = btn;
    btn.classList.add("open");
    // WebView2内のCSSピクセル座標で送る。C#側(Pane/MainForm.HandleOpenMenuRequest)で
    // DeviceDpiとWebView2の画面上の位置(_webView.PointToScreen)を使って画面座標へ変換する。
    const rect = btn.getBoundingClientRect();
    ctx.bridge.postMessage({ type: "open-menu", menu: menuName, x: rect.left, y: rect.bottom, items });
    watchOutsideClick();
  }

  // ネイティブポップアップは別のウィンドウとして表示されるため、WebView2の中(=本文や
  // ステータスバー)をクリックしてもポップアップ側はそれを検知できず、開いたままになる。
  // 本文側でクリックを拾ってC#へ「閉じて」と伝える。
  let outsideClickHandler = null;
  function watchOutsideClick() {
    stopOutsideClickWatch();
    outsideClickHandler = (e) => {
      // メニューバーの見出し自体のクリックは、そちらのハンドラが開き直しを行うので無視する。
      if (e.target instanceof Element && e.target.closest(".menu-top")) return;
      stopOutsideClickWatch();
      clearNativeHighlight();
      ctx.bridge?.postMessage({ type: "close-menu" });
    };
    window.addEventListener("pointerdown", outsideClickHandler, true);
  }
  function stopOutsideClickWatch() {
    if (!outsideClickHandler) return;
    window.removeEventListener("pointerdown", outsideClickHandler, true);
    outsideClickHandler = null;
  }

  function clearNativeHighlight() {
    stopOutsideClickWatch();
    nativeOpenBtn?.classList.remove("open");
    nativeOpenBtn = null;
  }

  // C#(Pane/NativeMenu.cs)からの応答。main.jsのhandleHostMessageから呼ばれる。
  // menu-command(項目が選ばれた)・menu-closed(選ばずに閉じられた)のどちらか一方が必ず届く。
  function handleMenuCommand(id) {
    clearNativeHighlight();
    nativeRunRegistry.get(id)?.();
  }
  function handleMenuClosed() {
    clearNativeHighlight();
  }

  function closeAll() {
    container.querySelectorAll(".menu-dropdown").forEach((el) => el.remove());
    container.querySelectorAll(".menu-top.open").forEach((el) => el.classList.remove("open"));
    openMenu = null;
    document.removeEventListener("mousedown", onOutsideClick, true);
    document.removeEventListener("keydown", onMenuKeydown, true);
  }
  function onOutsideClick(e) {
    if (!container.contains(e.target)) closeAll();
  }
  function onMenuKeydown(e) {
    if (e.key === "Escape") { closeAll(); return; }
  }

  // サブメニュー(最近使ったファイル等)を親項目の右側に表示する。動的リストなので
  // 開くたびに item.submenu(ctx) を呼び直す。
  function renderSubmenu(entries, anchorRow) {
    const rect = anchorRow.getBoundingClientRect();
    const sub = document.createElement("div");
    sub.className = "menu-dropdown";
    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "menu-item" + (entry.disabled ? " disabled" : "");
      row.innerHTML = `<span class="menu-item-check"></span><span class="menu-item-label">${entry.label}</span><span class="menu-item-shortcut"></span>`;
      if (entry.disabled) row.disabled = true;
      else row.addEventListener("click", () => { closeAll(); entry.run(); });
      sub.appendChild(row);
    }
    sub.style.left = rect.right + "px";
    sub.style.top = rect.top + "px";
    container.appendChild(sub);
    return sub;
  }

  function renderDropdown(menuName, anchorEl) {
    const items = commands.filter((c) => c.menu === menuName && !c.contextOnly);
    const dd = document.createElement("div");
    dd.className = "menu-dropdown";
    for (const item of items) {
      const grayed = item.grayed?.(ctx) ?? false;
      const enabled = !grayed && (item.enabled ? item.enabled(ctx) : true);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "menu-item" + (enabled ? "" : " disabled");
      const checked = item.checked?.(ctx);
      row.innerHTML = `<span class="menu-item-check">${checked ? "✓" : ""}</span>` +
        `<span class="menu-item-label">${item.label}</span>` +
        `<span class="menu-item-shortcut">${item.submenu ? "▶" : item.shortcut ? item.shortcut : (item.note ?? "")}</span>`;
      if (item.submenu) {
        let subEl = null;
        row.addEventListener("mouseenter", () => {
          subEl?.remove();
          subEl = renderSubmenu(item.submenu(ctx), row);
        });
        row.addEventListener("mouseleave", (e) => {
          if (subEl && !subEl.contains(e.relatedTarget)) { subEl.remove(); subEl = null; }
        });
      } else if (enabled) {
        row.addEventListener("click", () => { closeAll(); item.run(); });
      } else {
        row.disabled = true;
        if (item.note) row.title = item.note;
      }
      dd.appendChild(row);
      if (item.separatorAfter) {
        const sep = document.createElement("div");
        sep.className = "menu-separator";
        dd.appendChild(sep);
      }
    }
    const rect = anchorEl.getBoundingClientRect();
    dd.style.left = rect.left + "px";
    dd.style.top = rect.bottom + "px";
    container.appendChild(dd);
    return dd;
  }

  for (const menuName of menus) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-top";
    btn.textContent = MENU_LABELS[menuName] ?? menuName;
    if (useNative) {
      btn.addEventListener("click", () => openNativeMenu(menuName, btn));
    } else {
      btn.addEventListener("click", () => {
        if (openMenu === menuName) { closeAll(); return; }
        closeAll();
        openMenu = menuName;
        btn.classList.add("open");
        renderDropdown(menuName, btn);
        document.addEventListener("mousedown", onOutsideClick, true);
        document.addEventListener("keydown", onMenuKeydown, true);
      });
      btn.addEventListener("mouseenter", () => {
        if (openMenu && openMenu !== menuName) {
          closeAll();
          openMenu = menuName;
          btn.classList.add("open");
          renderDropdown(menuName, btn);
          document.addEventListener("mousedown", onOutsideClick, true);
          document.addEventListener("keydown", onMenuKeydown, true);
        }
      });
    }
    container.insertBefore(btn, anchor);
  }

  // ---- メニューバー右端の設定・ヘルプアイコン(Graftと同じ並び。テーマ切替の右隣) ----
  // ボタン自体は静的HTML側(index.html)に既に置かれているため、ここではクリック時の
  // 配線だけを行う。テーマ切替ボタン(#btn-theme)自体の配線は従来どおりmain.jsが持つ。
  const settingsBtn = container.querySelector("#btn-menu-settings");
  if (settingsBtn) {
    // 「file.settingsコマンドと同じ動作」にする指示どおり、commands配列から引いて実行する
    // (ctx.actions.openSettings()を直接呼んでも結果は同じだが、メニュー/コマンドパレットと
    // 完全に同じ経路を通すことで将来コマンド側だけ変更されても追従できるようにする)。
    settingsBtn.addEventListener("click", () => {
      commands.find((c) => c.id === "file.settings")?.run();
    });
  }
  const helpBtn = container.querySelector("#btn-menu-help");
  if (helpBtn) {
    // ヘルプ本体(F1相当の説明画面)はまだ無いため、暫定的に設定画面の
    // 「バージョン情報」カテゴリを開く。ブリッジがある場合は専用ウィンドウ(SettingsWindow)を
    // 開かせるため、通常のopenSettings()と同じくopen-settings-windowを送る
    // (カテゴリ指定を追加で載せておくが、現状SettingsWindow側は未対応でも実害はない)。
    // ブリッジが無いブラウザ単体動作ではctx.actions.openSettings(category)がその場で
    // モーダルを開き、バージョン情報カテゴリが選択された状態で表示される。
    helpBtn.addEventListener("click", () => {
      if (ctx.bridge) {
        ctx.bridge.postMessage({ type: "open-settings-window", category: "versionInfo" });
      } else {
        ctx.actions?.openSettings?.("versionInfo");
      }
    });
  }

  // Altキーでの表示・非表示トグル(仕様書 第10.1節・第10.4節)。
  // 単押しのAltのみを対象とし、Alt+他キーの組み合わせ(OS標準ショートカット等)は無視する。
  let altArmed = false;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && !e.repeat) altArmed = true;
    else if (e.key !== "Alt") altArmed = false;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && altArmed) {
      altArmed = false;
      container.classList.toggle("hidden");
      closeAll();
    }
  });

  return { closeAll, handleMenuCommand, handleMenuClosed };
}

// ---- コマンドパレット(Ctrl+Shift+P、仕様書 第10.1節) ----
export function initCommandPalette(root, commands, ctx) {
  let overlay = null;
  function close() {
    overlay?.remove();
    overlay = null;
  }
  function open() {
    if (overlay) { close(); return; }
    const available = commands.filter((c) => !c.contextOnly && !(c.grayed?.(ctx) ?? false) && (c.enabled ? c.enabled(ctx) : true));
    overlay = document.createElement("div");
    overlay.className = "palette-overlay";
    overlay.innerHTML = `<div class="palette"><input id="palette-input" placeholder="コマンドを検索…" autocomplete="off"><ul id="palette-list"></ul></div>`;
    root.appendChild(overlay);
    const input = overlay.querySelector("#palette-input");
    const list = overlay.querySelector("#palette-list");
    let sel = 0;
    let filtered = available;
    function render() {
      list.innerHTML = "";
      filtered.forEach((cmd, i) => {
        const li = document.createElement("li");
        li.className = i === sel ? "sel" : "";
        const menuLabel = cmd.menu ? (MENU_LABELS[cmd.menu] ?? cmd.menu) : "";
        li.innerHTML = `<span>${menuLabel ? menuLabel + ": " : ""}${cmd.label}</span>` + (cmd.shortcut ? `<span class="palette-shortcut">${cmd.shortcut}</span>` : "");
        li.addEventListener("mousedown", (e) => { e.preventDefault(); close(); cmd.run(); });
        list.appendChild(li);
      });
    }
    function filter() {
      const q = input.value.trim().toLowerCase();
      filtered = !q ? available : available.filter((c) => c.label.toLowerCase().includes(q) || (c.menu ?? "").toLowerCase().includes(q));
      sel = 0;
      render();
    }
    input.addEventListener("input", filter);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); render(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); render(); return; }
      if (e.key === "Enter") { e.preventDefault(); const cmd = filtered[sel]; if (cmd) { close(); cmd.run(); } return; }
    });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    filter();
    input.focus();
  }
  return { open, close };
}

// ---- 右クリックコンテキストメニュー(仕様書 第10.1節「右クリックからも呼び出せる」) ----
export function initContextMenu(hostEl, commands, ctx, resolveContextCommandIds) {
  let menuEl = null;
  function close() { menuEl?.remove(); menuEl = null; }
  hostEl.addEventListener("contextmenu", (e) => {
    const ids = resolveContextCommandIds(ctx, e);
    if (!ids || !ids.length) return; // 既定のブラウザメニューに任せる(未対応箇所)
    e.preventDefault();
    close();
    menuEl = document.createElement("div");
    menuEl.className = "menu-dropdown";
    menuEl.style.left = e.clientX + "px";
    menuEl.style.top = e.clientY + "px";
    for (const id of ids) {
      const cmd = commands.find((c) => c.id === id);
      if (!cmd) continue;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "menu-item";
      row.innerHTML = `<span class="menu-item-check"></span><span class="menu-item-label">${cmd.label}</span><span class="menu-item-shortcut">${cmd.shortcut ?? ""}</span>`;
      row.addEventListener("click", () => { close(); cmd.run(); });
      menuEl.appendChild(row);
    }
    document.body.appendChild(menuEl);
    const onOutside = (ev) => { if (!menuEl.contains(ev.target)) { close(); document.removeEventListener("mousedown", onOutside, true); } };
    document.addEventListener("mousedown", onOutside, true);
  });
  return { close };
}

// ---- ショートカット・ディスパッチ ----
// メニューバーが非表示でもショートカットキー自体は常に有効(第10.4節: 表示中は一覧としても機能する、
// であって非表示中は無効になるわけではない)。
//
// 全ショートカットをwindowのcaptureフェーズ(第3引数true)で1本にまとめて待ち受ける。
// captureフェーズはターゲット(CodeMirrorのcontentDOM・検索ボックスのinput等)へ
// イベントが届く前に発火するため、(1)CodeMirror既定のキーマップ(Ctrl+I/U/[/]等)より
// 確実に先着でき、(2)検索ボックス等どのDOM要素にフォーカスがあっても素通りしない。
// 割り当てているショートカットはすべてCtrl修飾または機能キーのみ(通常の文字入力と
// 衝突しない)ため、入力欄にフォーカスがあってもここで奪って問題ない。
function isShortcutEnabled(cmd, ctx) {
  const grayed = cmd.grayed?.(ctx) ?? false;
  return !grayed && (cmd.enabled ? cmd.enabled(ctx) : true);
}
export function bindShortcuts(commands, ctx) {
  // combo(修飾キーの分解結果)は毎回その場でparseShortcut()する。設定画面(C-10)で
  // キーバインドを変更すると commands.js の applyKeyBindings() が同じ配列インスタンスの
  // cmd.shortcut を書き換えるため、ここで事前にparseした結果をキャッシュしてしまうと
  // アプリ再起動なしには新しい割り当てが効かなくなってしまう。コマンド数は高々百程度で
  // parseShortcut自体も文字列split程度の軽さのため、キー入力のたびに毎回読み直しても
  // 体感できるコストにはならない。
  window.addEventListener("keydown", (e) => {
    // 設定画面(settings.js)でキーバインドを再設定中(「キーを押してください」状態)は、
    // ここで先に既存のショートカットを発火させてしまうと、割り当てたい組み合わせが
    // 既に何かに割り当たっている場合に(まさにその確認をしたい場面で)意図せずコマンドが
    // 実行されてしまう。ctx.shortcutsSuppressedはそのキャプチャ中だけsettings.js側が立てる
    // フラグで、window(捕捉フェーズ)はdocument(同じく捕捉フェーズ)より必ず先に発火するため、
    // ここで止めない限りsettings.js側のリスナーまでイベントが届かない。
    if (ctx.shortcutsSuppressed) return;
    for (const cmd of commands) {
      if (!cmd.shortcut) continue;
      if (!matchesShortcut(e, parseShortcut(cmd.shortcut))) continue;
      if (!isShortcutEnabled(cmd, ctx)) {
        console.log(`[shortcut] ${cmd.shortcut} は一致したが無効(grayed/enabled=false): ${cmd.id}`);
        continue;
      }
      e.preventDefault();
      e.stopPropagation();
      console.log(`[shortcut] ${cmd.shortcut} -> ${cmd.id}`);
      cmd.run();
      return;
    }
  }, true);
}
function parseShortcut(s) {
  const parts = s.split("+");
  const key = parts.pop();
  return {
    key: key.toLowerCase(),
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}
// 記号キーはShift併用時にe.keyが別の文字になる(例: Shift+` → "~")ため、
// 物理キー(e.code)で判定する。それ以外は論理キー(e.key)で判定する。
// "0"はShift併用時にe.keyが")"になる(Ctrl+Shift+0、実際のサイズ)ため、他の記号キーと
// 同様に物理キー(e.code)で判定する対象へ加える。
const SYMBOL_CODE_MAP = { "`": "Backquote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal", "0": "Digit0" };
function matchesShortcut(e, combo) {
  if (SYMBOL_CODE_MAP[combo.key]) {
    if (e.code !== SYMBOL_CODE_MAP[combo.key]) return false;
  } else if (e.key.toLowerCase() !== combo.key) {
    return false;
  }
  if ((e.ctrlKey || e.metaKey) !== combo.ctrl) return false;
  if (e.shiftKey !== combo.shift) return false;
  if (e.altKey !== combo.alt) return false;
  return true;
}
