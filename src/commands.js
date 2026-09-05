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

// Tabキーでのフォーカス閉じ込め・開閉時のフォーカス退避復帰は、独自ダイアログ(dialog.js)や
// 設定画面(settings.js)と全く同じロジックのため、共通モジュール(focus-trap.js)を使う
// (role="dialog" aria-modal="true"を付けているのにTabで背後のメニューバーへ抜けてしまう、
// という不整合を無くすため)。
import { trapTabKey, focusModal } from "./focus-trap.js";
// F3/Shift+F3(次を検索・前を検索、グローバルショートカット経由)の実行後に検索パネルの
// 件数表示を更新するためのフック(不具合2)。search-ui.js側の解説コメント参照。
import { refreshOpenSearchCount } from "./search-ui.js";

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
    // タブ形式(仕様書 第2.10節 C-14)。設定画面には切替UIを出さない隠し機能のため、
    // 有効になるのはsettings.jsonを直接編集してdisplayMode:"tab"にした場合のみ
    // (既定のウィンドウ形式では常に無効表示のまま)。
    // ショートカットは割り当てない(Ctrl+Tは既に「表を挿入」para.tableが使用済み)。
    { id: "file.newTab", menu: "File", label: "新しいタブ", grayed: (c) => c.getState().displayMode !== "tab", run: app((c) => c.actions.newTab()) },
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
    { id: "file.duplicate", menu: "File", label: "複製", enabled: () => !!ctx.bridge, run: app((c) => c.actions.duplicateDocument()) },
    { id: "file.saveAs", menu: "File", label: "名前を付けて保存", shortcut: `${MOD}+Shift+S`, run: app((c) => c.actions.saveAs()), separatorAfter: true },
    // enabled: () => !ctx.getState().exporting(総点検 指摘20)。押した後に何も表示されず、
    // Pandoc/PrintToPdfAsyncの完了を待つ間もう一度選べて二重に実行できてしまっていた不具合の
    // 対応。exportingはmain.js exportAs()が二重実行防止のために持つ状態(getState()参照)で、
    // ここで全エクスポート項目をまとめて無効表示にすることでメニュー・コマンドパレット・
    // ショートカット(bindShortcuts側もisCommandEnabledで同じenabledを見る)の入口をすべて塞ぐ。
    // ただし本当の二重起動防止はC#側(MainForm.cs _exportInProgress)にも別途持たせてある
    // (詳細はmain.js exportInProgressのコメント参照)。
    { id: "file.exportPdf", menu: "File", label: "エクスポート: PDF", run: app((c) => c.actions.exportAs("pdf")), enabled: () => !ctx.getState().exporting },
    { id: "file.exportHtml", menu: "File", label: "エクスポート: HTML", run: app((c) => c.actions.exportAs("html")), enabled: () => !ctx.getState().exporting },
    { id: "file.exportHtmlPlain", menu: "File", label: "エクスポート: HTML(スタイルなし)", run: app((c) => c.actions.exportAs("html-plain")), enabled: () => !ctx.getState().exporting },
    { id: "file.exportWord", menu: "File", label: "エクスポート: Word", run: app((c) => c.actions.exportAs("docx")), enabled: () => ctx.getState().pandocAvailable && !ctx.getState().exporting, note: "Pandoc未導入" },
    { id: "file.exportEpub", menu: "File", label: "エクスポート: EPUB", run: app((c) => c.actions.exportAs("epub")), enabled: () => ctx.getState().pandocAvailable && !ctx.getState().exporting, note: "Pandoc未導入" },
    // 仕様書 第2.11節 X-05「Word / RTF / LaTeX / EPUB / Textile 等」。既存のPandoc呼び出し
    // (docx/epub)の作りをそのまま踏襲する。
    { id: "file.exportRtf", menu: "File", label: "エクスポート: RTF", run: app((c) => c.actions.exportAs("rtf")), enabled: () => ctx.getState().pandocAvailable && !ctx.getState().exporting, note: "Pandoc未導入" },
    { id: "file.exportLatex", menu: "File", label: "エクスポート: LaTeX", run: app((c) => c.actions.exportAs("latex")), enabled: () => ctx.getState().pandocAvailable && !ctx.getState().exporting, note: "Pandoc未導入" },
    { id: "file.exportTextile", menu: "File", label: "エクスポート: Textile", run: app((c) => c.actions.exportAs("textile")), enabled: () => ctx.getState().pandocAvailable && !ctx.getState().exporting, note: "Pandoc未導入", separatorAfter: true },
    { id: "file.print", menu: "File", label: "印刷", shortcut: `${MOD}+Alt+P`, run: app((c) => c.actions.print()), separatorAfter: true },
    { id: "file.settings", menu: "File", label: "設定", shortcut: `${MOD}+,`, run: app((c) => c.actions.openSettings()), separatorAfter: true },
    { id: "file.close", menu: "File", label: "閉じる", shortcut: `${MOD}+W`, run: app((c) => c.actions.closeWindow()) },

    // ---- ヘルプ(メニューバーには出さない。F1・メニューバー右上の「?」ボタン・コマンドパレットから
    // 開く。OSの慣習どおりF1はヘルプを開く唯一の目的のキーで、本文編集中の他のショートカットとは
    // 衝突しない値のため無条件に割り当てる) ----
    { id: "help.manual", label: "取扱説明書を開く", shortcut: "F1", run: app((c) => c.actions.openHelp()) },

    // ---- Edit(第2.2節) ----
    // 標準の編集操作(E-01〜E-03・E-08・E-14・E-15)。キーボードでも行えるが、Typoraと同じく
    // メニューからも辿れるようにする(仕様書 第2章はTyporaのメニュー構成に沿って整理されている)。
    //
    // shortcut ではなく keyHint でキー表記を出しているのは、shortcut に書くと bindShortcuts が
    // window の捕捉フェーズでそのキーを横取りしてしまうため。Enter・Ctrl+A・Ctrl+Home などは
    // 検索ボックス・設定画面・ダイアログといった本文以外の入力欄でも使う基本キーで、
    // 横取りするとそれらの中で本文が操作されてしまう。キー入力そのものはCodeMirrorと
    // 各入力欄のネイティブ動作に任せ、ここではメニューからの実行経路とキーの案内だけを出す
    // (設定のキーバインド画面からは、必要ならユーザーが独自の割り当てを追加できる)。
    // 元に戻す/やり直す(仕様書10.1「メニューバーと機能を重複させ、どちらか一方だけでも
    // 全操作に到達できる状態にする」)。実際のキー入力はCodeMirrorのhistoryKeymap(editor.js)が
    // 元から処理しており、この2項目が無くても動作自体はしていた(総点検 指摘H3で発覚)。
    // これまで右クリックメニュー(main.js buildContextMenuTree)にしか出ておらず、
    // マウス派・タッチ操作の利用者には到達手段が無かった。他の基本キーと同じ理由で
    // shortcutではなくkeyHintにする(Ctrl+Z/Ctrl+Yはbindshortcutsで横取りしない)。
    { id: "edit.undo", menu: "Edit", label: "元に戻す", keyHint: `${MOD}+Z`, run: () => editor().applyAction("undo") },
    { id: "edit.redo", menu: "Edit", label: "やり直す", keyHint: `${MOD}+Y`, run: () => editor().applyAction("redo"), separatorAfter: true },
    { id: "edit.newParagraph", menu: "Edit", label: "段落を追加", keyHint: "Enter", run: () => editor().applyAction("newParagraph") },
    { id: "edit.softBreak", menu: "Edit", label: "改行(ソフトブレーク)", keyHint: "Shift+Enter", run: () => editor().applyAction("softBreak"), separatorAfter: true },
    { id: "edit.cut", menu: "Edit", label: "切り取り", keyHint: `${MOD}+X`, enabled: () => ctx.getState().hasSelection, run: () => document.execCommand("cut") },
    { id: "edit.copy", menu: "Edit", label: "コピー", keyHint: `${MOD}+C`, enabled: () => ctx.getState().hasSelection, run: () => document.execCommand("copy") },
    { id: "edit.paste", menu: "Edit", label: "貼り付け", keyHint: `${MOD}+V`, run: app((c) => c.actions.pasteRich()) },
    { id: "edit.selectAll", menu: "Edit", label: "すべて選択", keyHint: `${MOD}+A`, run: () => editor().applyAction("selectAll"), separatorAfter: true },
    { id: "edit.copyMarkdown", menu: "Edit", label: "Markdownとしてコピー", shortcut: `${MOD}+Shift+C`, run: app((c) => c.actions.copyAsMarkdown()) },
    { id: "edit.copyHtml", menu: "Edit", label: "HTMLとしてコピー", run: app((c) => c.actions.copyAsHtml()) },
    { id: "edit.pastePlain", menu: "Edit", label: "プレーンテキストとして貼り付け", shortcut: `${MOD}+Shift+V`, run: app((c) => c.actions.pasteAsPlainText()), separatorAfter: true },
    { id: "edit.selectLine", menu: "Edit", label: "行/文を選択", shortcut: `${MOD}+L`, run: () => editor().applyAction("selectLine") },
    { id: "edit.selectStyleRange", menu: "Edit", label: "スタイル範囲を選択", shortcut: `${MOD}+E`, run: () => editor().applyAction("selectStyleRange") },
    { id: "edit.selectWord", menu: "Edit", label: "単語を選択", shortcut: `${MOD}+D`, run: () => editor().applyAction("selectWord") },
    { id: "edit.deleteWord", menu: "Edit", label: "単語を削除", shortcut: `${MOD}+Shift+D`, run: () => editor().applyAction("deleteWord") },
    { id: "edit.deleteTableRow", menu: "Edit", label: "表の行を削除", shortcut: `${MOD}+Shift+Backspace`, run: () => editor().applyAction("deleteTableRow"), separatorAfter: true },
    { id: "edit.docStart", menu: "Edit", label: "先頭へジャンプ", keyHint: `${MOD}+Home`, run: () => editor().applyAction("docStart") },
    { id: "edit.docEnd", menu: "Edit", label: "末尾へジャンプ", keyHint: `${MOD}+End`, run: () => editor().applyAction("docEnd") },
    { id: "edit.jumpToSelection", menu: "Edit", label: "選択箇所へジャンプ", shortcut: `${MOD}+J`, run: () => editor().applyAction("scrollToSelection"), separatorAfter: true },
    { id: "edit.find", menu: "Edit", label: "検索", shortcut: `${MOD}+F`, run: app((c) => c.actions.openSearch()) },
    // ボタン(↓次を検索/↑前を検索)クリック時はsearch-ui.js内のハンドラがupdateCount()を
    // 直接呼ぶが、ここ(グローバルショートカット経由)はそれを経由しないため、選択箇所は
    // 進むのに「n / 総数」表示だけが古いままになっていた(不具合2)。refreshOpenSearchCount()で
    // 検索パネルが開いていれば表示を追従させる(閉じていれば何もしない)。
    { id: "edit.findNext", menu: "Edit", label: "次を検索", shortcut: "F3", run: () => { editor().findNext(); refreshOpenSearchCount(); } },
    { id: "edit.findPrev", menu: "Edit", label: "前を検索", shortcut: "Shift+F3", run: () => { editor().findPrevious(); refreshOpenSearchCount(); } },
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
    // 水平線: 右クリックの「段落」サブメニュー(main.js)にしか無く、メニューバー・コマンドパレット
    // からは呼べなかった(総点検 指摘H3/M5)。挿入処理自体(applyAction("hr"))は右クリックと共用。
    { id: "para.hr", menu: "Paragraph", label: "水平線", run: () => editor().applyAction("hr") },
    { id: "para.quote", menu: "Paragraph", label: "引用", shortcut: `${MOD}+Shift+Q`, run: () => editor().applyAction("quote") },
    { id: "para.olist", menu: "Paragraph", label: "番号付きリスト", shortcut: `${MOD}+Shift+[`, run: () => editor().applyAction("olist") },
    { id: "para.list", menu: "Paragraph", label: "箇条書きリスト", shortcut: `${MOD}+Shift+]`, run: () => editor().applyAction("list") },
    // タスクリスト: 新しい行に「- [ ] 」を挿入する(applyAction("check"))。既存の行をタスク
    // リストへ変換する para.listCheck(下のcontextOnly、"listCheck"アクション)とは別物で、
    // 右クリックの「段落」サブメニューにあったものをこちらもメニューバーへ出す(H3/M5)。
    { id: "para.taskList", menu: "Paragraph", label: "タスクリスト", run: () => editor().applyAction("check") },
    { id: "para.indent", menu: "Paragraph", label: "インデント", shortcut: `${MOD}+[`, run: () => editor().applyAction("indent") },
    { id: "para.outdent", menu: "Paragraph", label: "インデント解除", shortcut: `${MOD}+]`, run: () => editor().applyAction("outdent"), separatorAfter: true },
    { id: "para.listBullet", menu: "Paragraph", label: "箇条書きに変換", contextOnly: true, run: () => editor().applyAction("listBullet") },
    { id: "para.listOrdered", menu: "Paragraph", label: "番号付きリストに変換", contextOnly: true, run: () => editor().applyAction("listOrdered") },
    { id: "para.listCheck", menu: "Paragraph", label: "タスクリストに変換", contextOnly: true, run: () => editor().applyAction("listCheck"), separatorAfter: true },
    { id: "para.frontMatter", menu: "Paragraph", label: "YAML Front Matterを挿入", run: () => editor().applyAction("frontMatter") },

    // ---- Format(第2.4節) ----
    { id: "format.bold", menu: "Format", label: "太字", shortcut: `${MOD}+B`, run: () => editor().applyAction("bold") },
    { id: "format.italic", menu: "Format", label: "斜体", shortcut: `${MOD}+I`, run: () => editor().applyAction("italic") },
    { id: "format.underline", menu: "Format", label: "下線", shortcut: `${MOD}+U`, run: () => editor().applyAction("underline") },
    { id: "format.code", menu: "Format", label: "インラインコード", shortcut: "Ctrl+Shift+`", run: () => editor().applyAction("code") },
    { id: "format.strike", menu: "Format", label: "取り消し線", shortcut: "Alt+Shift+5", run: () => editor().applyAction("strike") },
    { id: "format.highlight", menu: "Format", label: "ハイライト", run: () => editor().applyAction("highlight") },
    { id: "format.superscript", menu: "Format", label: "上付き文字", run: () => editor().applyAction("superscript") },
    { id: "format.subscript", menu: "Format", label: "下付き文字", run: () => editor().applyAction("subscript"), separatorAfter: true },
    { id: "format.link", menu: "Format", label: "リンク", shortcut: `${MOD}+K`, run: () => editor().applyAction("link") },
    { id: "format.image", menu: "Format", label: "画像", shortcut: `${MOD}+Shift+I`, run: app((c) => c.actions.insertImageFlow()), separatorAfter: true },
    { id: "format.eraseFormat", menu: "Format", label: "書式を消去", shortcut: `${MOD}+\\`, run: () => editor().applyAction("eraseFormat") },

    // ---- View(第2.5節) ----
    { id: "view.sidebar", menu: "View", label: "サイドバーの表示切替", shortcut: `${MOD}+Shift+L`, run: app((c) => c.actions.toggleSidebar()), checked: () => ctx.getState().sidebarOpen },
    { id: "view.outline", menu: "View", label: "アウトラインパネル", shortcut: `${MOD}+Shift+1`, run: app((c) => c.actions.showSidebarPanel("outline")), checked: () => ctx.getState().sidebarOpen && ctx.getState().sidebarPanel === "outline" },
    // id(view.articleList)は仕様策定初期の仮名の名残。表示名は「ファイルリスト」に統一済み(仕様書 S-02)だが、
    // idはユーザーのキーボード設定(keyBindings、コマンドID→ショートカット文字列)が参照しているため変えない。
    { id: "view.articleList", menu: "View", label: "ファイルリスト", shortcut: `${MOD}+Shift+2`, run: app((c) => c.actions.showSidebarPanel("files")), checked: () => ctx.getState().sidebarOpen && ctx.getState().sidebarPanel === "files" },
    { id: "view.fileTree", menu: "View", label: "ファイルツリー", shortcut: `${MOD}+Shift+3`, run: app((c) => c.actions.showSidebarPanel("tree")), checked: () => ctx.getState().sidebarOpen && ctx.getState().sidebarPanel === "tree", separatorAfter: true },
    { id: "view.modeMarkdown", menu: "View", label: "Markdownモード", run: app((c) => c.actions.setMode("markdown")), checked: () => ctx.getState().mode === "markdown" },
    { id: "view.modePlain", menu: "View", label: "プレーンテキストモード", run: app((c) => c.actions.setMode("plain")), checked: () => ctx.getState().mode === "plain" },
    { id: "view.modeCode", menu: "View", label: "コードモード", run: app((c) => c.actions.setMode("code")), checked: () => ctx.getState().mode === "code", separatorAfter: true },
    { id: "view.sourceMode", menu: "View", label: "記法を隠さない表示", shortcut: `${MOD}+/`, run: app((c) => c.actions.toggleSourceMode()), checked: () => ctx.getState().sourceMode },
    { id: "view.focusMode", menu: "View", label: "フォーカスモード", shortcut: "F8", run: app((c) => c.actions.toggleFocusMode()), checked: () => ctx.getState().focusMode },
    { id: "view.typewriterMode", menu: "View", label: "タイプライターモード", shortcut: "F9", run: app((c) => c.actions.toggleTypewriterMode()), checked: () => ctx.getState().typewriterMode, separatorAfter: true },
    { id: "view.wordWrap", menu: "View", label: "折り返し表示", shortcut: "Alt+Z", run: app((c) => c.actions.toggleWordWrap()), checked: () => ctx.getState().wordWrap, separatorAfter: true },
    // ---- 折りたたみ(依頼④、VS Codeのコマンドを参考に追加。コードモード限定) ----
    // enabled: コードモードかつコードモードの折りたたみ機能自体がON(editor().isCodeFolding())
    // のときだけ有効にする。他のモードでは畳める範囲という概念自体が無く、折りたたみが
    // OFFのときはfoldNodeProp由来の情報はあっても実際に開閉する仕組み(codeFolding()拡張)が
    // 積まれていないため(src/editor.js codeModeExtras参照)。既存のenabled運用(例:
    // file.quickOpenのfolderLoaded)に合わせた作法。
    //
    // カーソル位置の折りたたみ/展開・すべて折りたたむ/展開は、既存のCodeMirrorキーマップ
    // (Alt-[ / Alt-] / Ctrl-Alt-[ / Ctrl-Alt-]、src/editor.js foldKeymapSafe)と全く同じ
    // 実体(foldCode/unfoldCode/foldAll/unfoldAll)を呼ぶ。ここにも同じshortcutを設定して
    // メニューに表示することで、bindShortcuts(window捕捉フェーズ)がその組み合わせの
    // 実際の発火元になる(para.olistがCtrl+Shift+[を横取りしているのと全く同じ構造。
    // 詳細はeditor.js foldKeymapSafe定義部のコメント参照)。CodeMirror側のキーマップは
    // 実質的にフォールバックとして残る形になるが、二重発火はしない(bindShortcutsが
    // stopPropagation()するため後続のCodeMirror側キーマップには到達しない)。
    { id: "view.foldAtCursor", menu: "View", label: "カーソル位置を折りたたむ", shortcut: "Alt+[", run: () => editor().foldAtCursor(), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding() },
    { id: "view.unfoldAtCursor", menu: "View", label: "カーソル位置を展開", shortcut: "Alt+]", run: () => editor().unfoldAtCursor(), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding() },
    { id: "view.foldAllRanges", menu: "View", label: "すべて折りたたむ", shortcut: "Ctrl+Alt+[", run: () => editor().foldAllRanges(), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding() },
    { id: "view.unfoldAllRanges", menu: "View", label: "すべて展開", shortcut: "Ctrl+Alt+]", run: () => editor().unfoldAllRanges(), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding(), separatorAfter: true },
    // 再帰的な折りたたみ/展開(VS Code Fold/Unfold Recursively相当)。判断ポイント(和音
    // キーについて): VS Codeはこの系統のコマンドに既定でCtrl+K Ctrl+[のような2打鍵の
    // 和音キーを割り当てているが、Paneの既存のショートカット体系(src/commands.js
    // bindShortcuts/parseShortcut/matchesShortcut)は「1回のkeydownイベント+同時押しの
    // 修飾キー」しか認識しない単発方式で、2打鍵を待ち受ける仕組みそのものが存在しない
    // (設定画面のキーバインド変更(C-10)も単発の組み合わせしか入力できない作り)。
    // 無理に和音キーの仕組みを新設すると、既存の全ショートカットが前提にしている
    // 「1回のkeydownで即判定する」設計や、キーバインド設定UIとの整合を広く見直す
    // 必要が生じ、この依頼の範囲を大きく超える。以下6コマンド(再帰的な折りたたみ/展開・
    // レベル1〜5・すべてのコメントブロック)は、既存の空いている単発の組み合わせも
    // 見当たらなかったため、無理に割り当てず、メニュー(および同じ配列を参照する
    // コマンドパレット)からのみ実行できる形にとどめた。
    { id: "view.foldRecursively", menu: "View", label: "カーソル位置を再帰的に折りたたむ", run: () => editor().foldRecursivelyAtCursor(), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding() },
    { id: "view.unfoldRecursively", menu: "View", label: "カーソル位置を再帰的に展開", run: () => editor().unfoldRecursivelyAtCursor(), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding(), separatorAfter: true },
    // レベル1〜5で折りたたむ(VS Code Fold Level 1..5相当)。
    { id: "view.foldLevel1", menu: "View", label: "レベル1で折りたたむ", run: () => editor().foldToLevel(1), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding() },
    { id: "view.foldLevel2", menu: "View", label: "レベル2で折りたたむ", run: () => editor().foldToLevel(2), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding() },
    { id: "view.foldLevel3", menu: "View", label: "レベル3で折りたたむ", run: () => editor().foldToLevel(3), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding() },
    { id: "view.foldLevel4", menu: "View", label: "レベル4で折りたたむ", run: () => editor().foldToLevel(4), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding() },
    { id: "view.foldLevel5", menu: "View", label: "レベル5で折りたたむ", run: () => editor().foldToLevel(5), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding(), separatorAfter: true },
    // すべてのコメントブロックを折りたたむ(VS Code Fold All Block Comments相当。
    // ユーザーが例に挙げた項目そのもの)。
    { id: "view.foldAllBlockComments", menu: "View", label: "すべてのコメントブロックを折りたたむ", run: () => editor().foldAllBlockComments(), enabled: () => ctx.getState().mode === "code" && editor().isCodeFolding(), separatorAfter: true },
    { id: "view.gotoLine", menu: "View", label: "指定行へジャンプ", shortcut: `${MOD}+G`, run: app((c) => c.actions.gotoLineFlow()), separatorAfter: true },
    { id: "view.fullscreen", menu: "View", label: "全画面表示", shortcut: "F11", run: app((c) => c.actions.toggleFullscreen()), checked: () => ctx.getState().fullscreen },
    { id: "view.zoomReset", menu: "View", label: "文字サイズを既定に戻す", shortcut: `${MOD}+Shift+0`, run: app((c) => c.actions.zoomReset()) },
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

// ---- ネイティブポップアップの「いま開いているのはどちらか」の一元管理 ----
// メニューバー(initMenuBar)と右クリックメニュー(initContextMenu)は、C#側(Pane/NativeMenu.cs)では
// 「1つのポップアップ」という同じ概念を共有しており、"menu-command" / "menu-closed" もどちらの
// 経路から開いたかに関わらず同じメッセージ形で届く。同時に開けるポップアップは常に1つだけ
// (NativeMenu.Show内のCloseCurrent()が前のポップアップを必ず閉じる)なので、最後に開いた側だけが
// 応答を受け取れるよう、ここで「いま応答を受けるべき相手」を1つだけ覚えておく。
let activeNativeOwner = null; // { handleMenuCommand(id), handleMenuClosed(menu), handleMenuArrowSwitch?(menu, direction) } | null
export function routeNativeMenuCommand(id) { activeNativeOwner?.handleMenuCommand(id); }
export function routeNativeMenuClosed(menu) { activeNativeOwner?.handleMenuClosed(menu); }
// handleMenuArrowSwitchは今のところメニューバー(initMenuBar)側しか持たない(右クリック
// メニュー側では隣へのメニュー切り替えという概念自体が無いため、handleMenuHoverSwitchと同じ扱い)。
export function routeNativeMenuArrowSwitch(menu, direction) { activeNativeOwner?.handleMenuArrowSwitch?.(menu, direction); }

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
  //
  // 開いている間に別の見出しへマウスを移動すると、クリックしなくても隣のメニューへ切り替わる
  // (Windows標準のメニューバーの挙動)。
  // 【ラウンド2で見つかった不具合の修正】以前は「ネイティブのポップアップが表示されている間、
  // マウスはOS側のポップアップに捕捉されHTML側のmouseenterは発火しない」という前提のもと、
  // C#側(Pane/NativeMenu.cs・MainForm.cs)がポップアップ自身の受け取るマウス移動を見て
  // 判定・通知する方式を実装していたが、実機ではその通知("menu-hover-switch")が一度も
  // 送られておらず機能していないことが確認された。加えて、ユーザー自身が実機で「メニュー表示中に
  // 別の見出しへカーソルを乗せると、その見出しの:hover色が実際に変わる」ことを確認しており、
  // これはHTML側がマウスの位置変化を検知できていることの証拠である(上記前提が誤りだった)。
  // そこでこの版では、見出しボタン自体のmouseenter(下のforループ内)でホバーを検知し、
  // handleMenuHoverSwitchを直接呼ぶ(C#との往復は不要)。実際の切り替えはopenNativeMenuを
  // 呼び直すだけで、クリックしたときとまったく同じ経路(前のポップアップを閉じて新しいものを
  // 開く→前のポップアップの遅れたmenu-closedはnativeOpenMenuNameとの突き合わせで無視される)に
  // 乗るため、既存の「連打しても1回で消えない」対策をそのまま利用できる。
  const useNative = !!ctx.bridge;
  // id→実行関数の対応表。開くたびに作り直す(「最近使ったファイル」等の動的なsubmenuは
  // 開くたびに内容が変わり得るため)。submenu項目は元々idを持たないため、ここで
  // `${親のid}/${index}` という一意なidをその場で振り、選択時にこの対応表経由で
  // 元の実行関数へ辿れるようにする。
  let nativeRunRegistry = new Map();
  let nativeOpenBtn = null;
  // いま開いているネイティブメニューの名前("File"等)。C#から遅れて届く「前のメニューが
  // 閉じた」通知(menu-closed)と、いま開いているメニューを取り違えないために持つ。
  let nativeOpenMenuName = null;
  // 見出し名→ボタン要素。ホバー切り替え(handleMenuHoverSwitch)で、mouseenterが発火した
  // 見出し名から実際のボタン要素を引くために使う。ボタン自体は下のforループで生成されるため、
  // この時点ではまだ空(参照は関数呼び出し時点で解決されるので問題ない)。
  const menuButtons = new Map();
  // 実機での切り分け用ログ(仕様書外・デバッグ支援)。mouseenterが実際に発火しているか、
  // どう判定したかをC#側のログファイルへも残す(main.jsのlogToHostと同じプロトコル)。
  // 50msごとの連続発火のような大量ログにならないよう、mouseenter自体が「見出しの上に
  // カーソルが乗った瞬間」にしか発火しない離散イベントであることを利用し、判定結果を
  // 都度1行だけ出す(ポーリングではないため、これ自体がログ量の抑制になっている)。
  function hoverLog(message) {
    console.log(message);
    ctx.bridge?.postMessage({ type: "log", level: "log", message: String(message) });
  }

  function buildNativeItem(item) {
    const grayed = item.grayed?.(ctx) ?? false;
    const enabled = !grayed && (item.enabled ? item.enabled(ctx) : true);
    const node = {
      id: item.id ?? null,
      label: item.label,
      // keyHintは「キー操作の案内だけを出し、ここではキーを横取りしない」項目用
      // (bindShortcutsはshortcutしか見ない)。詳細はEditメニューの標準操作のコメント参照。
      shortcut: item.shortcut ?? item.keyHint ?? "",
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

  // 直前にopenNativeMenu()を開いたのがホバー切り替え(handleMenuHoverSwitch)によるものかどうか。
  // 【ラウンド2のmouseenter対応で新たに気づいた不具合の修正】実際のマウス操作では、別の見出しへ
  // クリックする際に必ず先にその見出しへのmouseenterが発火する(ポインタが移動してからでないと
  // クリックできないため)。そのため「Fileが開いている間にEditへクリックしよう」とすると、
  // 先にmouseenterでホバー切り替えが起きてEditが開き(nativeOpenBtnがEditボタンに変わり)、
  // 直後に届くclickイベントが「もう同じ見出しが開いているので閉じる」という
  // トグル閉じ判定に引っかかってしまい、開いたばかりのEditを即座に閉じてしまっていた
  // (クリックでの通常のメニュー切り替えそのものが機能しなくなる、という重大な回帰)。
  // ホバー切り替えで開いた直後の(=まだ再クリックによる明示的な閉じる意図ではない)クリックは
  // トグル閉じの対象から除外し、開いたままにする(1回だけ判定を消費する)。ホバーを経由せず
  // 同じ見出しを連続でクリックした場合(このフラグがfalseのまま)は従来どおり閉じる。
  let nativeOpenedByHover = false;

  function openNativeMenu(menuName, btn, { viaHover = false } = {}) {
    if (nativeOpenBtn === btn) {
      if (nativeOpenedByHover && !viaHover) {
        // ホバーで開いたばかりの見出しへの、直後のクリック(上のコメント参照) → 何もせず
        // 開いたままにする。このクリック1回ぶんだけの猶予なので、ここで消費しておく。
        nativeOpenedByHover = false;
        return;
      }
      // 開いている見出しをもう一度押したら閉じるだけにする(一般的なメニューの挙動)。
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
    nativeOpenMenuName = menuName;
    nativeOpenedByHover = viaHover;
    activeNativeOwner = { handleMenuCommand, handleMenuClosed, handleMenuArrowSwitch }; // 応答は自分宛てとして受け取る
    btn.classList.add("open");
    // WebView2内のCSSピクセル座標で送る。C#側(Pane/MainForm.HandleOpenMenuRequest)で
    // DeviceDpiとWebView2の画面上の位置(_webView.PointToScreen)を使って画面座標へ変換する。
    const rect = btn.getBoundingClientRect();
    ctx.bridge.postMessage({ type: "open-menu", menu: menuName, x: rect.left, y: rect.bottom, items });
    watchOutsideClick();
  }

  // メニューバーの見出しボタンのmouseenter(下のforループ内)から呼ぶ「隣の見出しへ
  // 切り替えてほしい」判定。メニューが開いていない(クリックされていない)ときはホバー
  // だけでは開かない、という標準の挙動を守るため、nativeOpenMenuNameがnullなら何もしない。
  // 開いている見出し自身へのホバーも何もしない(menuName === nativeOpenMenuNameで弾く)。
  function handleMenuHoverSwitch(menuName) {
    if (!nativeOpenMenuName) return; // どのメニューも開いていない → ホバーだけでは開かない
    if (menuName === nativeOpenMenuName) return; // 開いている見出し自身へのホバーは無視
    const btn = menuButtons.get(menuName);
    if (!btn) return;
    hoverLog(`メニューのホバー切り替え: ${nativeOpenMenuName} → ${menuName}`);
    openNativeMenu(menuName, btn, { viaHover: true });
  }

  // メニューのキーボード操作(ユーザー報告: ←→で隣の見出しへ移動できない)。C#側
  // (Pane/NativeMenu.cs)が←→キーを検知して"menu-arrow-switch"で知らせてくる。
  // ToolStripDropDownMenu単体には「隣のメニューへ移る」機能が無く、メニューバーの並び順
  // (menus配列)を知っているのはJS側だけなので、実際にどのメニューへ切り替えるかの決定は
  // ここで行う。切り替え自体はhandleMenuHoverSwitchと全く同じopenNativeMenu経路を再利用する
  // (要望どおりホバー切り替えと共通化)。
  //   ・見出し(File/Edit/View/Paragraph/Format)の並びはmenus配列の順そのまま。
  //   ・端(先頭/末尾)では折り返す(Windows標準のメニューバーに合わせる。左端で←を押すと
  //     右端(Format)へ、右端で→を押すと左端(File)へ回り込む)。
  function handleMenuArrowSwitch(currentMenuName, direction) {
    if (!nativeOpenMenuName || currentMenuName !== nativeOpenMenuName) return; // 届いた時点で既に別のメニューへ切り替わっていた等、状態が食い違っていれば何もしない
    const idx = menus.indexOf(currentMenuName);
    if (idx < 0) return;
    const nextIdx = direction === "next" ? (idx + 1) % menus.length : (idx - 1 + menus.length) % menus.length;
    const nextMenuName = menus[nextIdx];
    const btn = menuButtons.get(nextMenuName);
    if (!btn) return;
    hoverLog(`キーボードでのメニュー切り替え: ${currentMenuName} → ${nextMenuName} (${direction})`);
    openNativeMenu(nextMenuName, btn);
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
    nativeOpenMenuName = null;
    nativeOpenedByHover = false;
  }

  // C#(Pane/NativeMenu.cs)からの応答。main.jsのhandleHostMessageから呼ばれる。
  // menu-command(項目が選ばれた)・menu-closed(選ばずに閉じられた)のどちらか一方が必ず届く。
  function handleMenuCommand(id) {
    clearNativeHighlight();
    nativeRunRegistry.get(id)?.();
  }
  // menu-closed には閉じられたメニュー名(C#側 MainForm.HandleOpenMenuRequest が
  // onClosed で付ける menu)が入っている。
  //
  // 「ファイル」を開いたまま「編集」を押すと、C#側は新しいポップアップを出す前に前の
  // ポップアップを閉じるため、"編集"を開いた直後に「"ファイル"が閉じた」という遅れた通知が
  // 届く。これを無条件にclearNativeHighlight()すると、実際には編集メニューが開いている
  // のにJS側は「どのメニューも開いていない」状態になり、画面外クリックの監視
  // (watchOutsideClick)まで解除されてしまう。結果として
  //   ・メニュー外をクリックしても閉じない
  //   ・見出しを連続して押すと1回で消えない
  // という不具合になっていた。いま開いているメニュー名と一致しない通知は無視する。
  function handleMenuClosed(menuName) {
    if (menuName && nativeOpenMenuName && menuName !== nativeOpenMenuName) return;
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
        `<span class="menu-item-shortcut">${item.submenu ? "▶" : item.shortcut ? item.shortcut : (item.keyHint ?? item.note ?? "")}</span>`;
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
    menuButtons.set(menuName, btn);
    if (useNative) {
      btn.addEventListener("click", () => openNativeMenu(menuName, btn));
      // ホバー切り替え(ラウンド2の修正、上のコメント参照)。切り分けのため、mouseenter
      // 自体が実際に発火しているかをまず常にログへ残す(離散イベントなので大量にはならない)。
      // 実際の切り替えが起きるのは「いずれかのメニューが開いている」かつ「開いている見出し
      // 自身へのホバーではない」場合だけ(handleMenuHoverSwitch内で判定)。
      btn.addEventListener("mouseenter", () => {
        hoverLog(`メニュー見出しへmouseenter: menu=${menuName}, 開いているメニュー=${nativeOpenMenuName ?? "(なし)"}`);
        handleMenuHoverSwitch(menuName);
      });
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
    // 取扱説明書ウィンドウ(F1)を開く。「help.manualコマンドと同じ動作」にする(file.settingsボタンと
    // 同じ流儀。メニュー/コマンドパレット/F1のいずれからでも完全に同じ経路を通す)。
    helpBtn.addEventListener("click", () => {
      commands.find((c) => c.id === "help.manual")?.run();
    });
  }

  // Altキーでの表示・非表示トグル(仕様書 第10.1節・第10.4節)。
  // 単押しのAltのみを対象とし、Alt+他キーの組み合わせ(OS標準ショートカット等)は無視する。
  //
  // preventDefault()を必ず呼ぶのは、Alt単押しをWebView2の外(WinForms本体のウィンドウ
  // プロシージャ)へ伝えないため。伝わるとWindowsが「メニューモード」(SC_KEYMENU)に入って
  // WebView2からキーボードフォーカスが外れ、次のAltはメニューモードを抜けるだけで
  // JS側に届かなくなる。そのため「初回は1回、以降は2回押さないと切り替わらない」という
  // 挙動になっていた。
  let altArmed = false;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      altArmed = true;
      e.preventDefault();
    } else if (e.key !== "Alt") {
      altArmed = false;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Alt") return;
    if (!altArmed) return;
    altArmed = false;
    e.preventDefault();
    container.classList.toggle("hidden");
    closeAll();
  });

  return { closeAll, handleMenuCommand, handleMenuClosed, handleMenuHoverSwitch };
}

// ---- コマンドパレット(Ctrl+Shift+P、仕様書 第10.1節) ----
export function initCommandPalette(root, commands, ctx) {
  let overlay = null;
  let restoreFocus = null; // focusModal()の戻り値。閉じたときに開く前の要素へフォーカスを戻す。
  function close() {
    overlay?.remove();
    overlay = null;
    // 開く前にフォーカスがあった要素(メニューバーのボタン等)へ戻す(focus-trap.js)。
    restoreFocus?.();
    restoreFocus = null;
  }
  function open() {
    if (overlay) { close(); return; }
    const available = commands.filter((c) => !c.contextOnly && !(c.grayed?.(ctx) ?? false) && (c.enabled ? c.enabled(ctx) : true));
    overlay = document.createElement("div");
    overlay.className = "palette-overlay";
    // role="dialog" aria-modal="true"は設定画面(settings.js)・独自ダイアログ(dialog.js)と
    // 揃え、支援技術に「これはモーダルである」ことを伝える。
    overlay.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="コマンドパレット"><input id="palette-input" placeholder="コマンドを検索…" autocomplete="off"><ul id="palette-list"></ul></div>`;
    root.appendChild(overlay);
    const paletteEl = overlay.querySelector(".palette");
    const input = overlay.querySelector("#palette-input");
    const list = overlay.querySelector("#palette-list");
    let sel = 0;
    let filtered = available;
    // UI点検第2弾 指摘9の修正: 絞り込み結果が0件のとき、以前は入力欄の下が
    // 空白のリストになり、「一致なし」なのか読み込み中なのか区別が付かなかった
    // (quick-open.jsの.palette-empty(フォルダ未読み込み時の案内)と同じクラス・
    // 見た目に揃える)。
    function render() {
      list.innerHTML = "";
      if (filtered.length === 0) {
        const li = document.createElement("li");
        li.className = "palette-empty";
        li.textContent = "一致するコマンドがありません";
        list.appendChild(li);
        return;
      }
      filtered.forEach((cmd, i) => {
        const li = document.createElement("li");
        li.className = i === sel ? "sel" : "";
        const menuLabel = cmd.menu ? (MENU_LABELS[cmd.menu] ?? cmd.menu) : "";
        const keyText = cmd.shortcut || cmd.keyHint || "";
        li.innerHTML = `<span>${menuLabel ? menuLabel + ": " : ""}${cmd.label}</span>` + (keyText ? `<span class="palette-shortcut">${keyText}</span>` : "");
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
      // 一覧(li)側はTabで移動できる要素を持たない(結果はクリック/Enterで選ぶ設計のため)。
      // フォーカス可能なのは検索欄(input)のみなので、trapTabKeyを通すと自身にとどまり続け、
      // 結果的に背後のメニューバーへ抜けなくなる(focus-trap.js)。
      trapTabKey(e, paletteEl);
    });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    filter();
    // 開く前にフォーカスがあった要素を覚えつつ検索欄へ初期フォーカスする(focus-trap.js)。
    // 閉じたときにこの記憶した要素へ戻す(close()参照)。
    restoreFocus = focusModal(input);
  }
  return { open, close };
}

// ---- 右クリック(コンテキスト)メニュー(docs/コンテキストメニュー仕様.md) ----
// 「文脈ノード」の形: { label, shortcut?, checked?, enabled?(既定true), note?, run?, separatorAfter?, submenu?(同じ形の配列) }。
// run を持つ項目が葉、submenu を持つ項目が入れ子(仕様書は1階層のみ使う)。
// commands配列(File/Edit/...)のような「id→定義」の静的レジストリではなく、呼び出し側
// (main.js・sidebar.js)がクリック位置の文脈に応じてその場で組み立てて渡す動的な木である点が
// buildCommands()と異なる(同じ仕組みに無理に統合しない)。

// 入力欄(input/textarea)の上の最小メニュー(仕様書 第5節)。OS標準相当の構成のみで、
// マークダウン固有の項目は一切出さない。document.execCommandは非推奨だが、input/textarea
// 単体への操作(cut/copy/paste/delete/undo/redo)としては現役でどのブラウザでも確実に効く
// (Clipboard APIの非同期権限確認を待たずに済む利点もある)。
function buildInputMenuTree(target) {
  const hasSelection = target.selectionStart !== target.selectionEnd;
  const exec = (cmd) => () => { target.focus(); document.execCommand(cmd); };
  return [
    { label: "元に戻す", run: exec("undo") },
    { label: "やり直す", run: exec("redo"), separatorAfter: true },
    { label: "切り取り", enabled: hasSelection, run: exec("cut") },
    { label: "コピー", enabled: hasSelection, run: exec("copy") },
    { label: "貼り付け", run: exec("paste") },
    { label: "削除", enabled: hasSelection, run: exec("delete"), separatorAfter: true },
    { label: "すべて選択", run: () => { target.focus(); target.select(); } },
  ];
}

// 文脈ノードの木 → NativeMenu.MenuItemData(open-menuと同じJSON形)への変換。
// idは「実行したい関数」を引くためだけの使い捨てキーで、commands配列のドット付きid
// (例: "file.save")とは別名前空間にする(絶対に衝突しないよう、ドットを含まない連番にする)。
let ctxIdSeq = 0;
function compileForNative(tree) {
  const registry = new Map();
  function conv(nodes) {
    return nodes.map((n) => {
      const hasSubmenu = !!n.submenu;
      const id = hasSubmenu ? null : `ctx${ctxIdSeq++}`;
      if (id) registry.set(id, n.run);
      return {
        id,
        label: n.label,
        shortcut: n.shortcut ?? "",
        enabled: n.enabled !== false,
        checked: !!n.checked,
        separatorAfter: !!n.separatorAfter,
        note: n.note ?? "",
        submenu: hasSubmenu ? conv(n.submenu) : undefined,
      };
    });
  }
  return { items: conv(tree), registry };
}

// HTMLフォールバック(ブリッジが無い環境。検証スクリプト・ブラウザ単体確認用)のレンダリング。
// メニューバーのHTMLフォールバック(renderDropdown/renderSubmenu、上のinitMenuBar内)と
// ほぼ同じ見た目・構造にするが、文脈ノードの木(run/submenuを直接持つ)を描くための
// 独立した実装として持つ(呼び出し元がcommands配列を経由しないため共有できない)。
function renderFallbackTree(tree, x, y) {
  const root = document.createElement("div");
  root.className = "menu-dropdown";
  root.style.left = x + "px";
  root.style.top = y + "px";

  function renderInto(container, nodes) {
    for (const n of nodes) {
      const row = document.createElement("button");
      row.type = "button";
      const enabled = n.enabled !== false;
      row.className = "menu-item" + (enabled ? "" : " disabled");
      row.innerHTML = `<span class="menu-item-check">${n.checked ? "✓" : ""}</span>` +
        `<span class="menu-item-label">${n.label}</span>` +
        `<span class="menu-item-shortcut">${n.submenu ? "▶" : n.shortcut ? n.shortcut : (n.note ?? "")}</span>`;
      if (n.submenu) {
        let subEl = null;
        row.addEventListener("mouseenter", () => {
          subEl?.remove();
          subEl = document.createElement("div");
          subEl.className = "menu-dropdown";
          const rect = row.getBoundingClientRect();
          subEl.style.left = rect.right + "px";
          subEl.style.top = rect.top + "px";
          renderInto(subEl, n.submenu);
          root.appendChild(subEl);
        });
        row.addEventListener("mouseleave", (e) => {
          if (subEl && !subEl.contains(e.relatedTarget)) { subEl.remove(); subEl = null; }
        });
      } else if (enabled) {
        row.addEventListener("click", () => { closeFallbackMenu(); n.run(); });
      } else {
        row.disabled = true;
        if (n.note) row.title = n.note;
      }
      container.appendChild(row);
      if (n.separatorAfter) {
        const sep = document.createElement("div");
        sep.className = "menu-separator";
        container.appendChild(sep);
      }
    }
  }
  renderInto(root, tree);
  document.body.appendChild(root);
  return root;
}
let fallbackMenuEl = null;
let fallbackOutsideHandler = null;
function closeFallbackMenu() {
  fallbackMenuEl?.remove();
  fallbackMenuEl = null;
  if (fallbackOutsideHandler) {
    document.removeEventListener("mousedown", fallbackOutsideHandler, true);
    fallbackOutsideHandler = null;
  }
}

// ネイティブポップアップ経路での「WebView2内クリックで閉じる」監視(initMenuBarの
// watchOutsideClick/stopOutsideClickWatchと同じ理由・同じ作法。ポップアップは別ウィンドウの
// ため、WebView2の中のクリックはポップアップ側からは検知できない)。
let ctxOutsideClickHandler = null;
function stopCtxOutsideWatch() {
  if (!ctxOutsideClickHandler) return;
  window.removeEventListener("pointerdown", ctxOutsideClickHandler, true);
  ctxOutsideClickHandler = null;
}
function watchCtxOutsideClick(ctx) {
  stopCtxOutsideWatch();
  ctxOutsideClickHandler = () => { stopCtxOutsideWatch(); ctx.bridge?.postMessage({ type: "close-menu" }); };
  window.addEventListener("pointerdown", ctxOutsideClickHandler, true);
}

// 文脈ノードの木を実際に表示する。ブリッジがあればネイティブポップアップ(Pane/NativeMenu.cs)、
// 無ければHTMLの.menu-dropdownにフォールバックする(仕様書 大原則2)。
// 呼び出し元(本文・サイドバーのアウトライン/ファイル一覧/ファイルツリー・入力欄)から共通に使う。
export function showContextMenu(ctx, x, y, tree) {
  closeFallbackMenu();
  if (ctx.bridge) {
    const { items, registry } = compileForNative(tree);
    const handleMenuCommand = (id) => { stopCtxOutsideWatch(); registry.get(id)?.(); };
    // menu-closedのmenuは常に"__context__"(C#側 MainForm.HandleOpenContextMenuRequest)。
    // メニューバー側から遅れて届いた別名の通知を誤って自分宛てと解釈しないよう名前を確認する
    // (initMenuBarのhandleMenuClosedと同じ理由の防御)。
    const handleMenuClosed = (menu) => { if (menu !== "__context__") return; stopCtxOutsideWatch(); };
    activeNativeOwner = { handleMenuCommand, handleMenuClosed };
    ctx.bridge.postMessage({ type: "open-context-menu", x, y, items });
    watchCtxOutsideClick(ctx);
  } else {
    fallbackMenuEl = renderFallbackTree(tree, x, y);
    fallbackOutsideHandler = (e) => { if (!fallbackMenuEl.contains(e.target)) closeFallbackMenu(); };
    document.addEventListener("mousedown", fallbackOutsideHandler, true);
  }
}

// contextmenu イベントの受け口。rootEl配下のどこで右クリックされても、まず入力欄
// (input/textarea)かどうかを最優先で判定し(仕様書 第5節、どの文脈にいても入力欄は
// 入力欄用の最小メニューになる)、そうでなければ resolveTree(ctx, e) に文脈の判定を委ねる。
// resolveTree が null/空配列を返した場所(メニューバー・ステータスバー・サイドバーの余白等)
// では何も表示しない(仕様書 第6節。既定メニューの抑止自体は呼び出し元が別途、最外周で
// document.addEventListener("contextmenu", ..., true) により行う)。
export function initContextMenu(rootEl, ctx, resolveTree) {
  rootEl.addEventListener("contextmenu", (e) => {
    const inputTarget = e.target instanceof Element ? e.target.closest("input, textarea") : null;
    const tree = inputTarget ? buildInputMenuTree(inputTarget) : resolveTree?.(ctx, e);
    if (!tree || !tree.length) return;
    e.preventDefault();
    showContextMenu(ctx, e.clientX, e.clientY, tree);
  });
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
// "0"はShift併用時にe.keyが")"になる(Ctrl+Shift+0、文字サイズを既定に戻す)ため、他の記号キーと
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
