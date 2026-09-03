# UI点検メモ（観点1: 見た目・UI）

作業中に随時追記する。根拠（ファイル:行）付きの指摘のみ。

## 進捗
- [x] CLAUDE.md / 仕様書 第8章・第10章 読了（3回目セッションで再読）
- [x] テーマ定義の所在特定（style.css / themes.css / JS注入）
- [x] style.css 通読
- [x] main.js / editor.js / sidebar.js / search-ui.js / global-search.js / dialog.js / quick-open.js
- [x] settings.js / settings-window.html / help-entry.js / help-window.html
- [x] C#: PaneDialog / MainForm / SettingsWindow / HelpWindow / UpdateService

## 指摘（発見順）

### 前提（テーマ定義の所在）
- テーマは CSS のみで定義。`src/style.css` の `:root` / `html[data-theme="dark"]`（既定ライト・ダーク）と `src/themes.css`（sepia/github/solarized-light/nord/dracula/solarized-dark/night の7プリセット）。JS は `main.js:2627-2640`（apply-settings）で `data-theme` / `data-light-theme` / `data-dark-theme` を html 要素へ付けるだけで色値は注入しない（カスタムCSSは `applyCustomCss` main.js:776）。
- 9テーマのトークン値を抽出してコントラスト比を計算した（スクリプトは scratchpad/contrast.mjs、WCAG 2.x の式）。

### 指摘1【高】accent-soft 背景 + accent 文字の組み合わせがメニュー以外の12箇所で低コントラストのまま
- 該当: `src/style.css:395` `#palette-list li.sel`、`:500` `.sidebar-tab.active`、`:510` `.outline-item.current`、`:538` `.file-item.current`、`:556` `.tree-item.current`、`:616` `.search-toggle:has(input:checked)`、`:622` `.cm-matchingBracket`、`:1072` `.cm-tooltip-autocomplete li[aria-selected]`、`:1108` `.settings-nav-item.active`、`:1191` `.ad-banner-action`、`:1640` `.help-toc-item.active`、`:399` `#palette-list mark`
- 事象: solarized-dark で 2.61:1、sepia 3.02、solarized-light 3.15、dracula 4.41、github 4.56、nord 4.59（12.5〜13px 通常ウェイト、AA=4.5 未満が6テーマ）。サイドバーで「今開いているファイル」「現在の見出し」、設定画面の「選択中カテゴリ」、コマンドパレットの「選択行」が読みにくい。
- 原因: `style.css:406-412` のコメントが認めている通り、メニューバーは `--menu-hover-fg` を導入して直したが、同じ `background: var(--accent-soft); color: var(--accent)` を使う他のセレクタは `var(--accent)` 決め打ちのまま。

### 指摘2【高】ダイアログの主ボタン文字色が3つのライト系/ソラライズド系テーマで AA 未満
- 該当: `src/style.css:1276` `.pane-dialog-btn-primary { background: var(--accent); color: var(--surface) }`、`:1257` `.extlink-btn-primary`（同じ）。使用側 `src/dialog.js` paneConfirm/paneAlert/paneInput、`editor.js` confirmOpenExternal
- 事象: solarized-light 3.00:1、solarized-dark 3.53、sepia 3.58（12px 太字）。「保存せずに閉じる」等の確認ダイアログの OK ボタン文字が薄い。
- 原因: 文字色を `--surface`（各テーマの面色）にしているが、accent が中明度（#268BD2 / #A9762C）のテーマでは面色との差が足りない。`.btn.primary`（style.css:277-278）は `#fff` / `#0E1513` 決め打ちで同じ問題（sepia 3.95、sollight 3.68）。


### 指摘3【高】ステータスバーの文字(11px)が5テーマでAA未満
- 該当: `src/index.html:41` `#statusbar { font-size: 11px; color: var(--ink-mute); background: var(--chrome-bg) }`（行・列、文字コード、改行コード、文字数、ズーム、「未保存」すべて）
- 事象: `--ink-mute` on `--chrome-bg` の比が solarized-light 2.77、solarized-dark 2.99、night 3.05、sepia 3.75、既定ライト 4.26（AA=4.5未満）。11pxの小さい文字と組み合わさり、ステータスバーの情報が読めない。
- 原因: 各テーマの `--chrome-bg`（themes.css）は「本文より濃い」方針で決めているが、その上に置く文字色の検証をしていない（`--ink-mute` は本文 `--paper` 用に選ばれた値）。`--menu-hover-fg` のようなバー専用の文字色トークンが無い。

### 指摘4【中】サイドバー・タブバー・行番号の補助色文字が暗系3テーマで3:1未満
- 該当: `src/style.css` `.outline-item[data-level="4"|"5"|"6"] { color: var(--ink-mute) }`、`.tree-root-label`（11px, --ink-mute）、`.tab-item`（非アクティブ, --ink-mute）、`.tabbar-new-btn`、`.cm-code-linenum`（--ink-mute on --code-bg, .85em）
- 事象: `--ink-mute` on サイドバー背景(`--surface`) が solarized-dark 2.42、night 2.73、solarized-light 3.64、dracula 3.81、nord 4.02。行番号(`--ink-mute` on `--code-bg`)は night 2.89、solarized-dark 3.17、solarized-light 3.64、sepia 3.99。h4〜h6の見出し行がアウトラインでほぼ読めず、コードブロックの行番号も薄い。
- 原因: themes.css の solarized-dark(`--ink-mute: #586E75`)・night(`#6A7280`) は元テーマの "comment" 色を補助文字に流用しているが、`--surface`/`--code-bg` の方が `--paper` より暗い/明るいため差が縮む。

### 指摘5【中】ダイアログ本文・小さい補助文字（--ink-sub）が3テーマでAA未満
- 該当: `src/style.css` `.pane-dialog-message`（12.5px, --ink-sub on --surface）、`.file-item-dir`（10.5px）、`.search-result-file-path`（10.5px）、`.menu-item-shortcut`（10.5px）、`.tree-icon`、`.settings-field-desc`（11.5px）、`.tok-h4`（h4見出し, --ink-sub on --paper）
- 事象: `--ink-sub` on `--surface` が solarized-light 3.64、night 3.79、solarized-dark 4.11。「保存されていない変更があります…」の確認文が薄い。`.tok-h4` は night 3.24 / solarized-light 4.13 / sepia 4.44 で、本文中の h4 見出しが本文より読みにくい（仕様10.3に h4 を補助色にする根拠は無い）。
- 原因: 10.5〜12.5px という小さいサイズに補助色を重ねている。テーマ側の `--ink-sub` は本文背景向けにしか検証されていない。

### 指摘6【中】取扱説明書の検索で「現在のヒット」語が読めない（3テーマ）
- 該当: `src/style.css` `mark.help-search-hit.current { background: var(--accent); color: var(--paper) }`（help-entry.js の検索バーで使用）
- 事象: `--paper` on `--accent` が sepia 3.36、solarized-light 3.41、solarized-dark 4.08。Enterで移動した先の語だけ読めない。
- 原因: 指摘2と同根。`--accent` が中明度のテーマで、明るい紙色を文字にすると差が足りない。

### 指摘7【低】危険操作ボタン（ごみ箱へ移動 等）の文字色が nord/dracula/solarized-dark で 3.5〜4.5
- 該当: `src/style.css` `.pane-dialog-btn-danger { background: var(--danger); color: var(--surface); font-weight: 700 }`（dialog.js paneConfirm danger:true、sidebar.js:179 deleteEntryFlow 等）
- 事象: `--surface` on `--danger`（ダーク共通 #E07B6E）が nord 3.46、dracula 4.06、solarized-dark 4.47（12px太字はAA 4.5が必要）。
- 原因: `--danger` は style.css の既定ダーク値のままで、テーマプリセットは `--surface` だけを明るく上書きしている。

### 指摘8【中】コマンドパレット／クイックオープン／設定ナビ／取説目次のマウスホバーが既定ライトで見えない
- 該当: `src/style.css` `@media (hover:hover)` 内 `#palette-list li:hover { background: var(--paper) }`（パレット背景は `.palette { background: var(--surface) }`）、`.settings-nav-item:hover { background: var(--surface) }`（`.settings-nav { background: var(--paper) }` の上）、`.help-toc-item:hover { background: var(--surface) }`（`.help-sidebar { background: var(--paper) }` の上）、`.settings-modal-close:hover` / `.ad-banner-close:hover { background: var(--paper) }`
- 事象: 既定ライトは `--surface #FFFFFF` と `--paper #FBFBFA` の差が 4/255（比 1.04）。マウスを乗せても行の背景が変わって見えず、クリック対象が分からない。github（#FFF vs #F6F8FA）、sepia（#FBF3E3 vs #F4ECD8）も 1.06〜1.07。
- 原因: ホバー色を「surface と paper を入れ替える」で作っているため、両者が近いテーマで消える。他の行（メニュー・サイドバー）は `--accent-soft` を使っており、同じにすれば済む。

### 指摘9【中】クイックオープン(Ctrl+P)で絞り込み結果が0件のとき何も出ない
- 該当: `src/quick-open.js:66-75` `render()`（`filtered` を回すだけで空のときの表示が無い）。`.palette-empty` は「フォルダが読み込まれていません」(同:55-63) にしか使われていない
- 事象: 一致しない文字列を打つと、入力欄の下が空白のリストになる。「一致なし」なのか「読み込み中」なのか分からない。
- 原因: 0件分岐が無い。

### 指摘10【中】サイドバーを広げた状態で Ctrl+F の検索パネルが左に切れる
- 該当: `src/style.css` `.search-panel { position: absolute; top: 8px; right: 16px }`、`.search-row input[type="text"] { width: 190px }`（固定幅）、`src/index.html:36` `#cm-host { overflow: hidden; position: relative }`、`src/sidebar.js:52-57` サイドバー幅は最大 `min(600, innerWidth*0.5)`
- 事象: 検索行は 190px入力 + 52pxカウント + ↑↓ + Aa/単語/.* + 置換 + ✕ で概ね 480〜520px（フォント依存）。ウィンドウ幅 960 でサイドバーを上限(480px)まで広げると `#cm-host` は約480px となり、右寄せ配置のパネルの左端（＝検索入力欄）が `overflow: hidden` で切れる。幅 800 では約100px 分消える。
- 原因: パネル幅がコンテンツ幅固定で `max-width` や `left` の下限が無く、置換行も同じ。

### 指摘11【低】本体ウィンドウに最小サイズが無い
- 該当: `Pane/MainForm.cs`（`MinimumSize` 指定なし。`SettingsWindow.cs:111` と `HelpWindow.cs:74` には 640x480 がある）
- 事象: 本体だけWinForms既定（約130px幅）まで縮められ、`#menubar`（style.css: `display:flex`、overflow指定なし）の5項目＋右端3ボタンがバー外へはみ出す。サイドバー最小180px(sidebar.js:52)を開いていると本文幅が0になる。
- 原因: 設定・ヘルプには付けた最小サイズを本体に付けていない。

### 指摘12【低】角丸・影・ウェイトが仕様10.1/10.3と一致していない（画面ごとにバラバラ）
- 角丸（仕様: コントロール6px、ウィンドウ枠8px）: `.palette` 14px、`.settings-modal` 14px、`.settings` 14px、`.pane-dialog-box` 12px、`.extlink-box` 12px、`.search-panel` 10px、`.ctx-menu` 10px、`.ad-banner` 10px、`.color-picker-panel` 10px、`--radius: 10px`(.btn)、`.settings-nav-item`/`.help-toc-item`/`.sidebar-open-folder-btn`/`select` 8px、`.settings-search-row`/`.ft-blocked-warn` 9px、`.pane-dialog-btn`/`.menu-item` 6px。同じ「浮かぶパネル」でもメニュー8・コンテキストメニュー10・パレット14・ダイアログ12。
- 影（仕様: 影・グラデーションを使わない）: `--shadow-pop` を `.menu-dropdown` `.palette` `.search-panel` `.ctx-menu` `.ad-banner` `.settings-modal` `.pane-dialog-box` `.color-picker-panel` `.cm-footnote-popup` `.help-search-bar` `.cp-copy-toast` で使用。`.cm-table .tbl-ctl` は独自の `box-shadow: 0 1px 3px rgba(0,0,0,.18)`。
- ウェイト（仕様: 400と500のみ）: `.tok-h1`〜`.tok-h4` 700、`.settings-modal-title` 700、`.pane-dialog-title` 700、`.pane-dialog-btn-primary` 700、`.wc-head` 700、`.cm-table th` 700、`.outline-item[data-level="1"]` 600、`.settings-nav-item.active` 600、`.tree-root-label` 600 ほか多数。
- ボタン: `.pane-dialog-btn`(12px / 6px 14px / r6) `.sidebar-open-folder-btn`(12px / 6px 14px / r8) `.ad-banner-btn`(11.5px / 5px 10px / r6) `.btn`(14px / 9px 16px / r10) `.cp-eyedropper`(12px / 6px / r6) と、文字サイズ・余白・角丸がすべて違う。
- 事象: 実害は小さいが、画面を行き来すると密度と形が変わって見える。仕様書に数値があるので揃える基準はある。

### 指摘13【低】テーマプリセットが `--input-bg` `--danger-soft` `--pre-bg` を上書きしていない
- 該当: `src/themes.css` 7ブロックすべてに `--input-bg` の定義が無い（style.css `:root` #FAFBFB / `html[data-theme="dark"]` #171C20 のまま）。使用側: `.pane-dialog-input`、`.cp-num-field input`
- 事象: sepia の名前変更・新規ファイルダイアログの入力欄だけ青白い #FAFBFB になり紙色 #FBF3E3 と合わない。nord では surface #3B4252 の上に #171C20 の入力欄が置かれ、極端に暗い穴に見える。`--danger-soft`（`.ft-blocked-warn` `.adv-confirm` の背景）も同様にダーク共通 #3A2320 のまま。
- 原因: プリセット追加時に上書き対象トークンを絞ったため。

### 指摘14【低】ステータスバー全体が等幅フォント
- 該当: `src/index.html:41` `#statusbar { font-family: var(--font-mono) }`
- 事象: 「行 1, 列 1」「未保存」「Markdown」など日本語UI文言も JetBrains Mono→BIZ UDゴシック で表示され、メニューバー(Inter/Noto Sans JP)と書体が変わる。仕様10.3では等幅は「コード」用。

### 指摘15【中】タブ形式でタブが溢れると、横スクロールバー(17px)がタブバー(32px)の中に出てタブが15pxに潰れる
- 該当: `src/style.css:444` `.tabbar-list { overflow-x: auto; overflow-y: hidden }`（高さは `#tabbar { height: 32px }` に stretch）、`src/style.css` `*::-webkit-scrollbar { width: 17px; height: 17px }`（全要素共通）。同 :436-441 のコメントで「専用の指定は不要」と明記し、タブ一覧だけ細くする指定を意図的に外している。
- 事象: タブの合計幅（1本120〜220px）がウィンドウ幅を超えた瞬間、`.tabbar-list` の内側に高さ17pxの横スクロールバーが現れ、`.tab-item`（align-items: stretch）の高さが 32−17=15px になる。12.5pxの文字と閉じるボタン（padding 3px + 16px SVG）が15pxに収まらず上下が切れる。
- 原因: 全体スクロールバーを17pxに太くした変更を、高さ固定のタブバーにそのまま適用した。

### 指摘16【中】エラー表示に例外の型名・例外メッセージがそのまま出る
- 該当（型名）: `Pane/UpdateService.cs:227` `Error(currentVersionText, $"更新を確認できませんでした({ex.GetType().Name})。")` → settings.js:2094 でそのまま `.settings-update-status.error` に表示。利用者には「更新を確認できませんでした(HttpRequestException)。」「(TaskCanceledException)」のように見える。
- 該当（ex.Message 直出し）: `Pane/MainForm.cs:2055,2114,2528`「ファイルを開けませんでした。\n{ex.Message}」、`:3741`「エクスポートに失敗しました。\n{ex.Message}」、`:1804/1817/1830`（削除・改名・作成）、`:4060`（画像挿入）、`Pane/SettingsBridge.cs:296`「更新に失敗しました: {ex.Message}」、`:625-676`（関連付け・新規作成メニュー・スタートアップ・PATH）、`Pane/FolderService.cs:259,351,373` → `src/sidebar.js:285,385`「フォルダの読み込みに失敗しました: ${folder.error}」、`Pane/MainForm.cs:2426` → `src/global-search.js:83`（検索エラーをそのまま本文に）。
- 事象: .NET の例外メッセージは「パス 'C:\Users\...\x.md' へのアクセスが拒否されました。」「Response status code does not indicate success: 403 (Forbidden).」のように、絶対パスや英語のHTTP生値を含む。ユーザーは自分で次に何をすればいいか分からない。
- 原因: 例外種別ごとの言い換え（見つからない／使用中／権限が無い／通信できない）をせず、メッセージを連結している。

### 指摘17【高】本文のリンク・リスト記号・脚注番号など「アクセント色の文字」が sepia / solarized-light / solarized-dark で AA 未満
- 該当: `src/style.css` `.tok-link { color: var(--accent) }`（本文リンク、15px通常）、`.cm-bullet`（リスト記号）、`.cm-footnote-num`（.78em）、`.cm-footnote-def-label`、`.cm-toc-item:hover`、`.help-article a`（取扱説明書のリンク）、`.settings-tabs button.on`、`.keymap-scope`（10px）、`.menu-item-check`、`.tab-item-dirty`、`.wc-val.wc-sel`、`.adv-action-msg`、`.md-cheat td:first-child`、`.search-row button:hover`、`.help-search-nav-btn:hover`
- 事象: `--accent` on `--paper` が sepia 3.36、solarized-light 3.41、solarized-dark 4.08。`--accent` on `--surface`（メニュー・設定・サイドバー面）は solarized-light 3.00、solarized-dark 3.53、sepia 3.58、github 4.88、dracula 4.89。sepia/solarized 系を選ぶと本文中のリンク文字と脚注番号が薄く、取扱説明書内のリンクも同様。
- 原因: themes.css の sepia `--accent: #A9762C`、solarized の `#268BD2` は元テーマの「アクセント面」向けの中明度色で、文字色として使うには暗さが足りない。既定ライト `#2F6F68`（5.64）・github `#0969DA`（5.19）は文字用に十分暗い。指摘1・2・6と同根で、`--accent` を「面」と「文字」に分ける（例: `--accent-ink`）のが根本策。

### 指摘18【中】フォルダを開いてから一覧が出るまで、サイドバーが「フォルダが読み込まれていません」のまま
- 該当: `src/main.js:1567-1571` `openFolder()`（`open-folder` を送るだけ）、`src/sidebar.js:124-138` `renderFolderPrompt()`、`sidebar.js:420-432` `setFolder()`（`folder-loaded` 受信時にだけ描画）、`Pane/MainForm.cs:2300-2336` `LoadFolderAsync`（`FolderService.ScanAsync` 完了後に1回だけ `folder-loaded` を送る）
- 事象: フォルダ選択ダイアログを閉じてから走査完了までの間、サイドバーは「フォルダが読み込まれていません／フォルダを開く」ボタンのまま。ファイル数が多いフォルダでは数秒その状態が続き、押しても何も起きなかったように見える（もう一度押すと2つ目の走査が始まる）。グローバル検索には「検索中…」（global-search.js:85）があるのに、フォルダ読み込みには「読み込み中」の状態が無い。
- 原因: `folder` が null か結果かの2状態しか持たず、「読み込み中」の状態が JS 側に無い。C# 側も走査開始の通知を送っていない。

### 指摘19【低】脚注のホバーポップアップが文書の先頭付近で上に切れる
- 該当: `src/style.css` `.cm-footnote-popup { position: absolute; bottom: 125%; ... }`、`#cm-host .cm-scroller { overflow-y: auto }`
- 事象: 脚注参照 `[^1]` が最初の1〜3行にあると、上方向に出るポップアップの上半分がスクロール領域の外へ出て `overflow` で切れる。
- 原因: 上方向固定で、はみ出すときに下へ出す分岐が無い。

### 指摘20【中】エクスポート（特に Pandoc 経由の docx/epub 等）の実行中に何も表示されない
- 該当: `src/main.js:1383-1409` `exportAs()`（`bridge.postMessage({type:"export"...})` を送って終わり。処理中の表示や二重実行防止が無い）、`src/main.js:2733-2735` `export-done`（`exitExportLayout()` のみ）、`Pane/MainForm.cs:3711-3725`（`await ExportViaPandocAsync` / `PrintToPdfAsync` を待つ間、画面への通知が無い）
- 事象: docx/epub/rtf は外部プロセス（Pandoc）の起動を待つため数秒かかるが、その間メニューもボタンも通常どおり反応し、完了・失敗（`:3741` のダイアログ）まで何も出ない。ユーザーはもう一度メニューを選び、保存ダイアログが2回出る。
- 原因: 「処理中」状態がJS側に無い（更新の適用には `updatePhase` と進捗バーがあるのと対照的）。

## 調査済みで問題なしと判断したもの（再調査不要）
- Mermaid / 数式: 描画中は「…」プレースホルダ（editor.js MathWidget/MermaidWidget toDOM）、エラーは `数式エラー:`/`Mermaidエラー:` を danger 色で表示。
- グローバル検索: 「検索中…」「一致する項目がありません」「件数が多いため一部のみ」あり（global-search.js）。
- サイドバー空状態: 「見出しがありません」「ファイルがありません」「フォルダが読み込まれていません+ボタン」あり。
- 最近使ったファイルが空: `(なし)` の無効項目（commands.js:51）。
- 設定画面: 読み込み中 `.settings-loading`、更新確認は「確認しています…」+ボタン無効化、適用は進捗バー。
- 取扱説明書: 読み込み失敗時の文言は内部情報を含まない（help-entry.js:342）。WebView2 は initial-render-ready まで非表示でテーマ色を塗る（HelpWindow.cs:84-90）。
- C#自前ダイアログ（PaneDialog.cs）: テーマ色・DPI・ボタン幅は妥当。
- ステータスバーの幅不足: main.js の ResizeObserver で短縮・非表示（index.html コメント）。
- メニューバーのホバー文字色: `--menu-hover-fg` で9テーマ個別に対応済み。

## まとめ

### 今すぐ直すべきもの
1. 指摘17・1・2・6（同根）: `--accent` を文字色として使う箇所が sepia / solarized-light / solarized-dark で 2.6〜4.1。本文リンク・脚注番号・サイドバーの選択行・ダイアログの主ボタン・取説検索の現在ヒットが読めない。`--accent-ink`（文字用）と `--accent`（面用）を分けて themes.css で9テーマ分を定義する。
2. 指摘3: ステータスバー（11px, `--ink-mute` on `--chrome-bg`）が5テーマで AA 未満。バー専用の文字色トークン（`--chrome-fg`）を足す。
3. 指摘15: タブ形式でタブが溢れると横スクロールバー17pxがタブを15pxに潰す。`.tabbar-list::-webkit-scrollbar { height: 4px }` 程度に個別指定。
4. 指摘16: `ex.GetType().Name` / `ex.Message` の直出し。特に UpdateService.cs:227 の型名と、SettingsBridge.cs:296 の更新失敗。
5. 指摘18・20: フォルダ読み込み中とエクスポート中の「処理中」状態が無い。
6. 指摘8・9: パレット系のホバーが見えない／クイックオープン・コマンドパレットの0件表示が無い。

### 余裕があれば直すもの
- 指摘4・5・7: 補助色（`--ink-mute` / `--ink-sub`）を小さい文字に使う箇所と、danger ボタンの文字色。
- 指摘10: サイドバーを広げた状態での検索パネルの切れ。
- 指摘11: 本体ウィンドウの最小サイズ。
- 指摘12・13・14・19: 角丸・影・ウェイト・ボタン寸法の統一、テーマ未上書きトークン、ステータスバーの等幅フォント、脚注ポップアップの位置。
