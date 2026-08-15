// ツールチップの文言を1箇所に集約するモジュール(依頼2: 設定「ツールチップの詳しさ」)。
//
// 狙い:
//   ・HTML/各JSに`title`属性を直接書き散らすと、4段階×全要素ぶんの文言を保守できない。
//   ・将来の多言語対応(実装予定)では、文言がこの1ファイルにまとまっていないと詰む。
//   ・将来のF1ヘルプ(説明書、今回は未実装)からも、このテーブルをそのまま参照して使う
//     想定(TOOLTIPSのcategory/standard/detailedがそのまま説明書の下書きになる)。
//     そのため detailed の文章は、ツールチップ限定の言い回し(「クリックで」等の前提)を
//     避け、単独で読んでも意味が通るように書く。
//
// 識別子(TOOLTIPSのキー): 対象要素のid属性をそのまま使う。idを持たない要素には
// 呼び出し側(HTML/JS)で`data-tip="任意の識別子"`を付けてもらい、そちらを使う
// (id優先、無ければdata-tip。applyTooltip参照)。設定画面の各項目は、
// docs/設定項目一覧.md の設定キー名をそのまま識別子として使う(src/settings.js側で
// 各フィールドの外側<label>にdata-tip="設定キー"を付けている)。
//
// 4段階(依頼2の表):
//   none     … 表示しない
//   minimal  … 最低限。「今どうなっているか」を示す情報が中心、機能説明は付けない。
//              ・状態を表示するボタン(文字コード・改行コード等)は現在の値だけを出す
//                (minimalMode:"state"。呼び出し側がstateとして動的な値を渡す)。
//              ・アイコンだけで用途が分からないボタン(設定・ヘルプ等)は名前だけ出す
//                (minimalMode:"label")。
//              ・設定画面の項目は、ラベル自体に何の設定か書いてあるため出さない
//                (settings.js側で一律に抑制。このファイルには書かない)。
//   standard … 既定。ネットリテラシーのある人が見て分かる程度の説明。
//   detailed … 「何ができて、どうなるか」を具体的に書く。
//
// ショートカットキー(例: "Ctrl+,")は、あれば段階に関わらず常に付記する(noneを除く)。
// entry.shortcutに書いておけば、resolveTooltip側が自動で末尾に" (Ctrl+,)"のように足す。

export const TOOLTIP_LEVELS = ["none", "minimal", "standard", "detailed"];
export const DEFAULT_TOOLTIP_DETAIL = "standard";

// ---- 現在の段階の共有(モジュール横断) ----
// main.jsが持つ現在の段階(tooltipLevel)をここにも複製しておき、sidebar.js/global-search.js
// のように「一覧の各行にファイルパス等をtitleとして出す」箇所(id/data-tipを個別に振るには
// 数が多すぎる動的な項目)が、ctxを介さずにここから直接「今noneかどうか」だけを読めるように
// する。文言テーブルを引く一括適用(applyTooltipsIn)とは別に、こちらは「noneなら出さない」
// という最低限のルールだけを守らせるための軽量な仕組み。main.jsのsetTooltipLevel側で
// setCurrentLevel()も一緒に呼ぶ(main.js参照)。
let currentLevel = DEFAULT_TOOLTIP_DETAIL;
export function setCurrentLevel(level) {
  currentLevel = TOOLTIP_LEVELS.includes(level) ? level : DEFAULT_TOOLTIP_DETAIL;
}
export function getCurrentLevel() {
  return currentLevel;
}

// 将来の説明書での章分類に流用する想定のラベル(このファイル内では表示に使わないが、
// キーの一覧性・保守性のためエントリ側にcategoryとして持たせておく)。
export const TOOLTIP_CATEGORIES = {
  menubar: "メニューバー",
  tabbar: "タブバー",
  sidebar: "サイドバー",
  statusbar: "ステータスバー",
  search: "検索・置換パネル",
  colorPicker: "カラーピッカー",
  banner: "通知バナー",
  settings: "設定画面",
};

// entry: {
//   category:    TOOLTIP_CATEGORIESのキー(説明書用の分類。省略可)
//   label:       アイコンのみのボタン等、minimalで出す名前(省略時はstandardを使う)
//   minimalMode: "label"(既定) | "state"(呼び出し側が渡すstateを出す) | "suppress"(出さない)
//   standard:    標準段階の文言
//   detailed:    詳しい段階の文言(省略時はstandardを使う)
//   shortcut:    "Ctrl+,"のような文字列。あれば全段階(none以外)の末尾に" (Ctrl+,)"を付記する
// }
export const TOOLTIPS = {
  // ---- 設定画面 ----
  // インデントガイド(縦線)の表示モード設定。settings.js側のfieldSelect呼び出しが
  // 自動生成するフォールバック文言(ラベル+desc)でも4段階(none/minimal/standard/detailed)は
  // 一応成立するが、standard/detailedが同一文になってしまう。この項目はTOOLTIPSに専用の
  // 文言を用意し、detailedでは3つの選択肢それぞれの意味まで書く。
  // 文言更新(マーカー位置を本文エリアの左端に固定する変更に伴う): 以前は「マーカーの
  // 中心から」と書いていたが、マーカーが本文エリアの左端の固定位置に変わり、縦線は
  // 実際のコードのインデント位置に引くようになった(マーカーとは別の場所)ため、
  // 「その行の先頭(開始行)から」に改めた。あわせてL字の終端についても触れる。
  codeIndentGuides: {
    category: "settings",
    minimalMode: "suppress", // 設定画面の項目はラベル自体で何の設定か分かるため(他の設定項目と同じ扱い)
    standard: "コードモードで、インデントの深さを示す縦線をどこまで表示するかです",
    detailed: "コードモードのインデントガイド(縦線)の表示範囲を選びます。「表示しない」は縦線を一切引きません。「折りたたみできる範囲のみ」(既定)は、関数・オブジェクト・配列など折りたたみマーカーが実際にある階層にだけ、その範囲の開始行から最終行まで線を引き、最終行では右へ短い横棒を出してL字に終わります。「すべてのインデント」は、折りたたみとは無関係にインデントの深さすべてに一律で線を引きます(こちらも、折りたたみ範囲に対応する階層はL字で終わります)。",
  },
  // ---- メニューバー ----
  "btn-theme": {
    category: "menubar",
    label: "テーマ切替",
    minimalMode: "label",
    standard: "ライトテーマとダークテーマを切り替えます",
    detailed: "画面全体をライトテーマとダークテーマの間で切り替えます。選んだ結果は保存され、次回Paneを起動したときも同じテーマで開きます。ライト/ダークそれぞれで使うテーマの色(配色プリセット)自体は「設定」の「外観」で選べます。",
  },
  "btn-menu-settings": {
    category: "menubar",
    label: "設定",
    minimalMode: "label",
    standard: "設定画面を開きます",
    detailed: "起動時の動作・自動保存・編集の挙動・Markdown記法・外観・キーボードなど、Paneのほぼすべての動作をカテゴリ別に変更できる設定画面を開きます。",
    shortcut: "Ctrl+,",
  },
  "btn-menu-help": {
    category: "menubar",
    label: "ヘルプ",
    minimalMode: "label",
    standard: "ヘルプメニューを開きます",
    detailed: "バージョン情報や、困ったときの手がかりをまとめたヘルプメニューを開きます。",
  },

  // ---- タブバー(displayMode:"tab"の隠し設定を使っている場合のみ表示) ----
  "tabbar-new": {
    category: "tabbar",
    label: "新しいタブ",
    minimalMode: "label",
    standard: "新しいタブを開いて無題の文書を作成します",
    detailed: "現在のウィンドウの中に新しいタブを追加し、無題の文書を新規作成します。ウィンドウ自体を増やす「新規ウィンドウ」とは別の操作です。",
  },

  // ---- サイドバー ----
  "sidebar-tab-outline": {
    category: "sidebar",
    label: "アウトライン",
    minimalMode: "label",
    standard: "見出しの一覧(アウトライン)を表示します",
    detailed: "本文中の見出し(#・##等)を階層付きの一覧にして表示します。項目をクリックすると本文の該当箇所へ移動します。表示する見出しの深さは「設定」の「Markdown」で変更できます。",
    shortcut: "Ctrl+Shift+1",
  },
  "sidebar-tab-files": {
    category: "sidebar",
    label: "ファイル",
    minimalMode: "label",
    standard: "最近使ったファイルの一覧を表示します",
    detailed: "最近開いたファイルを新しい順に一覧表示します。クリックするとそのファイルを開きます。記録するかどうか自体は「設定」の「一般」にある「最近使ったファイルを記録」で変更できます。",
    shortcut: "Ctrl+Shift+2",
  },
  "sidebar-tab-tree": {
    category: "sidebar",
    label: "ファイルツリー",
    minimalMode: "label",
    standard: "開いているフォルダのファイルツリーを表示します",
    detailed: "現在のファイルの親フォルダ(または明示的に開いたフォルダ)の中身を、フォルダ構造のまま一覧表示します。ファイルをクリックすると開きます。隠しファイルを表示するかどうかは「設定」の「詳細」で変更できます。",
    shortcut: "Ctrl+Shift+3",
  },
  "sidebar-resize-handle": {
    category: "sidebar",
    minimalMode: "suppress",
    standard: "ドラッグでサイドバーの幅を変更します(ダブルクリックで既定幅に戻す)",
    detailed: "このハンドルを左右にドラッグすると、サイドバーの幅を自由に変更できます。ダブルクリックすると既定の幅に戻ります。変更した幅は次回起動時も記憶されます。",
  },

  // ---- ステータスバー ----
  "status-sidebar": {
    category: "statusbar",
    label: "サイドバー表示切替",
    minimalMode: "label",
    standard: "サイドバーの表示/非表示を切り替えます",
    detailed: "アウトライン・ファイル・ファイルツリーをまとめたサイドバー全体の表示/非表示を切り替えます。最後に開いていたタブ(アウトライン等)を覚えていて、再度表示したときはそのタブが開きます。",
    shortcut: "Ctrl+Shift+L",
  },
  "status-mode": {
    category: "statusbar",
    label: "編集モード",
    minimalMode: "state",
    standard: "クリックすると、コードモードで使う言語を選び直せます",
    detailed: "現在の編集モード(Markdown/コード/プレーンテキスト)を表示します。コードモードのときにクリックすると、シンタックスハイライトに使うプログラミング言語を選び直せます。内容からモードを自動判定する動作自体は「設定」の「編集」にある「編集モードの自動判定」で調整できます。",
  },
  "status-position": {
    category: "statusbar",
    minimalMode: "state",
    standard: "カーソルがある行番号と列番号です",
    detailed: "現在カーソルがある位置を「行, 列」の形式で表示します。行・列とも1から数えます。選択範囲がある場合はカーソル側(選択の終端)の位置を表示します。",
  },
  "status-encoding": {
    category: "statusbar",
    label: "文字コード",
    minimalMode: "state",
    standard: "クリックすると、保存時の文字コードを変更できます",
    detailed: "このファイルを保存するときに使う文字コード(UTF-8等)を表示します。クリックすると一覧から選び直せます。ここで変更しても本文の内容自体は変わらず、次に保存したときに選んだ文字コードで書き出されます。既定の文字コードは「設定」の「ファイル」で変更できます。",
  },
  "status-line-ending": {
    category: "statusbar",
    label: "改行コード",
    minimalMode: "state",
    standard: "クリックすると、保存時の改行コードを変更できます",
    detailed: "このファイルを保存するときに使う改行コード(CRLF/LF/CR)を表示します。クリックすると一覧から選び直せます。改行コードが混在していたファイルも、ここで1つを選ぶとその改行コードに統一されます。既定の改行コードは「設定」の「ファイル」で変更できます。",
  },
  "status-wrap": {
    category: "statusbar",
    label: "折り返し表示",
    minimalMode: "state",
    standard: "クリックすると、長い行の折り返し表示を切り替えられます",
    detailed: "コードブロックなど1行が画面幅を超える箇所を、折り返して表示するか・横スクロールさせるかを切り替えます。クリックのたびにオン/オフが切り替わります。既定値は「設定」の「編集」にある「コードブロックの長い行を折り返し」で変更できます。",
  },
  "status-count": {
    category: "statusbar",
    label: "文字数",
    minimalMode: "state",
    standard: "文書全体の文字数です。クリックすると詳細を表示します",
    detailed: "文書全体の文字数(選択中は選択範囲の文字数も併記)を表示します。クリックすると、単語数・行数・段落数・読了時間の目安まで含めた詳細なポップアップが開きます。この項目自体を表示するかどうかは「設定」の「外観」で変更できます。",
  },
  "status-zoom": {
    category: "statusbar",
    label: "拡大率",
    minimalMode: "state",
    standard: "本文の文字サイズの拡大率です。クリックすると100%に戻します",
    detailed: "既定の文字サイズに対する、現在の本文フォントサイズの拡大率を表示します。Ctrl+マウスホイールで変更でき(「設定」の「一般」でオン/オフ可)、クリックすると100%(既定サイズ)に一発で戻せます。",
  },

  // ---- 通知バナー(内容からの編集モード自動判定) ----
  "ad-banner-close": {
    category: "banner",
    label: "閉じる",
    minimalMode: "label",
    standard: "この通知を閉じます",
    detailed: "編集モードの自動判定に関するこの通知を閉じます。判定の動作自体は「設定」の「編集」にある「編集モードの自動判定」で変更できます。",
  },

  // ---- 検索・置換パネル ----
  "search-query": {
    category: "search",
    minimalMode: "suppress",
    standard: "検索する文字列を入力します",
    detailed: "本文から探したい文字列を入力します。入力するたびに一致箇所がその場でハイライトされます。「Aa」「単語」「.*」の各チェックで、大文字小文字の区別・単語単位一致・正規表現を切り替えられます。",
  },
  "search-count": {
    category: "search",
    minimalMode: "state",
    standard: "一致した件数と、現在何件目を選択中かです",
    detailed: "検索条件に一致した件数と、そのうち現在何件目にカーソルがあるかを「現在位置 / 総件数」の形式で表示します。一致が無い場合は「見つかりません」と表示します。",
  },
  "search-prev": {
    category: "search",
    label: "前を検索",
    minimalMode: "label",
    standard: "1つ前の一致箇所へ移動します",
    detailed: "検索条件に一致する箇所のうち、現在位置より前(文書の先頭方向)にある直近の箇所へカーソルを移動します。先頭まで来たら末尾側から探し直します。",
    shortcut: "Shift+F3",
  },
  "search-next": {
    category: "search",
    label: "次を検索",
    minimalMode: "label",
    standard: "次の一致箇所へ移動します",
    detailed: "検索条件に一致する箇所のうち、現在位置より後(文書の末尾方向)にある直近の箇所へカーソルを移動します。末尾まで来たら先頭側から探し直します。",
    shortcut: "F3",
  },
  "search-case": {
    category: "search",
    label: "大文字と小文字を区別",
    minimalMode: "suppress",
    standard: "大文字と小文字を区別して検索します",
    detailed: "オンにすると、たとえば「Pane」と「pane」を別の文字列として検索します(既定はオフで区別しません)。",
  },
  "search-word": {
    category: "search",
    label: "単語単位で検索",
    minimalMode: "suppress",
    standard: "単語として完全に一致する箇所だけを検索します",
    detailed: "オンにすると、たとえば「cat」で検索したときに「category」の一部としては一致せず、「cat」という単語そのものにだけ一致します。",
  },
  "search-regex": {
    category: "search",
    label: "正規表現",
    minimalMode: "suppress",
    standard: "検索欄の内容を正規表現として解釈します",
    detailed: "オンにすると、検索欄・置換後欄の内容を正規表現(JavaScriptの正規表現構文)として扱います。置換後欄では$1のようにキャプチャグループを参照できます。",
  },
  "search-toggle-replace": {
    category: "search",
    label: "置換",
    minimalMode: "label",
    standard: "置換用の入力欄を表示します",
    detailed: "置換後の文字列を入力する行を表示/非表示します。表示中は「置換」(1件ずつ)「すべて置換」のボタンが使えます。",
  },
  "search-close": {
    category: "search",
    label: "閉じる",
    minimalMode: "label",
    standard: "検索・置換パネルを閉じます",
    detailed: "検索・置換パネルを閉じ、検索条件によるハイライトも消します。本文の内容は変わりません。",
    shortcut: "Esc",
  },
  "replace-query": {
    category: "search",
    minimalMode: "suppress",
    standard: "置換後の文字列を入力します",
    detailed: "「置換」「すべて置換」を押したときに、一致箇所をこの文字列で置き換えます。「正規表現」がオンのときは$1のようにキャプチャグループを参照できます。",
  },
  "replace-one": {
    category: "search",
    label: "置換",
    minimalMode: "label",
    standard: "現在選択中の一致箇所だけを置換します",
    detailed: "現在カーソル/選択がある一致箇所だけを置換後の文字列に置き換え、次の一致箇所へ移動します。1件ずつ確認しながら置換したいときに使います。",
  },
  "replace-all": {
    category: "search",
    label: "すべて置換",
    minimalMode: "label",
    standard: "一致するすべての箇所を一度に置換します",
    detailed: "検索条件に一致する文書内のすべての箇所を、確認なしで一度に置換後の文字列へ置き換えます。取り消したい場合はCtrl+Zで元に戻せます。",
  },

  // ---- 設定画面 ----
  // 識別子はdocs/設定項目一覧.mdの設定キーをそのまま使う(src/settings.js側の各field*
  // ヘルパーが、生成する<label>にdata-tip="設定キー"を付けている)。ここに無いキーは
  // settings.js側でラベル・説明文から自動で組み立てたフォールバック文言を使う
  // (settings.js FIELD_TOOLTIP_FALLBACK / applySettingsTooltips参照)。
  // なお設定画面の項目はminimal段階では一律に出さない(ラベル自体で用途が分かるため。
  // settings.js側で判定するため、ここのminimalModeは実質使わないが記録として残す)。
  tooltipDetail: {
    category: "settings",
    minimalMode: "suppress",
    standard: "設定やボタンにカーソルを合わせたときに出る説明の詳しさです",
    detailed: "設定画面の各項目や、メニューバー・ステータスバーなどのボタンにマウスカーソルを合わせたときに出るツールチップの詳しさを選びます。「表示しない」「最低限(現在の状態のみ)」「標準(既定)」「詳しい(何ができてどうなるかを具体的に説明)」の4段階です。ここを変更すると、この設定画面を閉じなくても本文側のツールチップにすぐ反映されます。",
  },
  showStatusBar: {
    category: "settings",
    minimalMode: "suppress",
    standard: "画面下部のステータスバー(文字コード・行列位置等)を表示するかどうかです",
    detailed: "編集モード・カーソル位置・文字コード・改行コード・折り返し・文字数・拡大率をまとめた、画面いちばん下のステータスバーの表示/非表示を切り替えます。非表示にすると本文エリアがその分広くなります。",
  },
  quitOnLastWindowClosed: {
    category: "settings",
    minimalMode: "suppress",
    standard: "最後のウィンドウを閉じたあと、Paneを常駐させたままにするかどうかです",
    detailed: "オンにすると、開いているすべてのウィンドウを閉じてもPane自体は終了せずバックグラウンドに常駐し続け、次に新しいウィンドウを開くときの起動が速くなります。オフにすると、最後のウィンドウを閉じた時点でPaneごと終了します(従来の動作)。下の「PCの起動時からあらかじめ常駐しておく」とは独立した設定です。",
  },
  preloadOnStartup: {
    category: "settings",
    minimalMode: "suppress",
    standard: "PCを起動した直後から、Paneをあらかじめ常駐させておくかどうかです",
    detailed: "オンにすると、PCにサインインした直後からPaneがバックグラウンドで自動的に起動・常駐し、実際にファイルを開いたりウィンドウを開いたりする時点での起動が速くなります。上の「最後のウィンドウを閉じても常駐させる」とは独立して動作します(こちらは「PCの起動直後から」、上は「ウィンドウを閉じたときに」常駐するかの設定です)。",
  },
  autoSaveEnabled: {
    category: "settings",
    minimalMode: "suppress",
    standard: "編集中の内容を、一定間隔で自動的にファイルへ保存するかどうかです",
    detailed: "オンにすると、下の「自動保存の間隔」で指定した秒数ごとに、編集中の内容を自動的に上書き保存します。Ctrl+Sでの手動保存は自動保存の有無に関わらずいつでも行えます。",
  },
  defaultEncoding: {
    category: "settings",
    minimalMode: "suppress",
    standard: "新規文書を保存するときに、既定で使う文字コードです",
    detailed: "「無題」の新規文書を初めて保存するときに使う文字コードの既定値です。既存ファイルを開いた場合はそのファイル自身の文字コードが優先され、この設定の影響は受けません(ステータスバーの文字コード表示から個別に変更できます)。",
  },
  defaultLineEnding: {
    category: "settings",
    minimalMode: "suppress",
    standard: "新規文書を保存するときに、既定で使う改行コードです",
    detailed: "「無題」の新規文書を初めて保存するときに使う改行コード(CRLF/LF)の既定値です。既存ファイルを開いた場合はそのファイル自身の改行コードが優先され、この設定の影響は受けません(ステータスバーの改行コード表示から個別に変更できます)。",
  },
  spellCheckEnabled: {
    category: "settings",
    minimalMode: "suppress",
    standard: "本文でOS標準のスペルチェック(赤い波線)を有効にするかどうかです",
    detailed: "オンにすると、本文編集エリアでWindows標準のスペルチェックが働き、綴りが疑わしい単語に赤い波線が表示されます。判定・辞書はWindows側の機能をそのまま使うため、日本語文中の英単語など判定精度はOSの設定に依存します。",
  },
  autoPairing: {
    category: "settings",
    minimalMode: "suppress",
    standard: "括弧や引用符を入力したとき、対になる記号を自動的に補うかどうかです",
    detailed: "オンにすると、( や \" 、[ などを入力した瞬間に、閉じ側の ) や \" 、] を自動的に追加します。選択範囲がある状態で入力すると、選択していた文字列を両側から挟む形になります。",
  },
  strictMode: {
    category: "settings",
    minimalMode: "suppress",
    standard: "見出し・リスト等のMarkdown記法を、厳密な書式でだけ認識するかどうかです",
    detailed: "オフ(既定)では多少崩れた書き方(例: #の後にスペースが無い見出し)もある程度は見出し等として認識しますが、オンにすると標準のMarkdown仕様どおり厳密に書かれたものだけを記法として認識し、それ以外は素のテキストとして扱います。",
  },
  spellCheckAutoCorrect: {
    category: "settings",
    minimalMode: "suppress",
    standard: "スペルチェックの自動修正を使うかどうかです(WebView2の制約により現状は無効)",
    detailed: "本来はスペルチェックで検出した誤りを自動的に修正候補へ置き換える設定ですが、WebView2(このアプリの表示基盤)の制約によりこの項目からは制御できず、実際の挙動はWindows側の入力設定にそのまま従います。",
  },
  highlightEnabled: {
    category: "settings",
    minimalMode: "suppress",
    standard: "==で囲んだ文字をハイライト表示する記法を使えるようにするかどうかです",
    detailed: "オンにすると、本文中の==ハイライト==のように二重イコールで囲んだ部分を、蛍光ペンで塗ったような強調表示として解釈します。オフにすると==はただの文字として扱われます。",
  },
  calloutsEnabled: {
    category: "settings",
    minimalMode: "suppress",
    standard: "> [!NOTE]のような注釈枠(Callouts)の記法を使えるようにするかどうかです",
    detailed: "オンにすると、引用の先頭に[!NOTE]や[!WARNING]などを書くことで、種類ごとに色分けされた注釈枠(Callouts)として表示します。オフにすると通常の引用として表示されます。",
  },
  superSubscriptEnabled: {
    category: "settings",
    minimalMode: "suppress",
    standard: "上付き文字・下付き文字の記法を使えるようにするかどうかです",
    detailed: "オンにすると、x^2^のようなキャレット2つでの上付き、H~2~Oのようなチルダ2つでの下付き記法を解釈して、実際に上付き/下付き文字として表示します。",
  },
  inlineMathEnabled: {
    category: "settings",
    minimalMode: "suppress",
    standard: "$…$で囲んだインライン数式を、数式として表示するかどうかです",
    detailed: "オンにすると、本文中の$E=mc^2$のようにドル記号1つで囲んだ部分をLaTeX形式の数式として解釈し、その場でレンダリング表示します。ブロック単位の数式(コードブロックとして書く形式)は別の設定(コードブロック内の数式記法)で切り替えます。",
  },
  codeBlockLineNumbers: {
    category: "settings",
    minimalMode: "suppress",
    standard: "フェンス付きコードブロックの左に行番号を表示するかどうかです",
    detailed: "オンにすると、```で囲んだコードブロックの各行の左端に行番号を表示します。コピーした内容には行番号は含まれません。",
  },
  showWordCount: {
    category: "settings",
    minimalMode: "suppress",
    standard: "ステータスバーに文字数を常に表示するかどうかです",
    detailed: "オンにすると、ステータスバーに文書全体の文字数(選択中は選択範囲の文字数も)を常に表示します。オフにすると、ステータスバーからこの項目自体が消えます(クリックで開ける文字数の詳細ポップアップも使えなくなります)。",
  },
  theme: {
    category: "settings",
    minimalMode: "suppress",
    standard: "画面をライトテーマ・ダークテーマ・システムの設定のどれに従わせるかです",
    detailed: "「ライト」「ダーク」を選ぶとその配色で固定され、「システムの設定に従う」を選ぶとOS(Windows)のライト/ダーク設定に自動で追従します。メニューバーのテーマ切替ボタンで手動切り替えした場合、その選択がこの設定より優先されます。",
  },
  useSeparateThemeInDarkMode: {
    category: "settings",
    minimalMode: "suppress",
    standard: "ダークモードのときだけ、ライトモードとは別のテーマプリセットを使うかどうかです",
    detailed: "オンにすると、ライトモード用・ダークモード用でそれぞれ別のテーマプリセット(下の「ライトテーマ」「ダークテーマ」)を使い分けます。オフにすると、ダークモードでも「ライトテーマ」で選んだプリセットをそのまま使います(配色自体はダーク基調のまま、装飾のプリセットだけライト用を流用する形です)。",
  },
  showHiddenFilesInTree: {
    category: "settings",
    minimalMode: "suppress",
    standard: "サイドバーのファイルツリーに、隠しファイル・隠しフォルダも表示するかどうかです",
    detailed: "オンにすると、ファイル名が.(ドット)で始まるファイル・フォルダや、Windows上で「隠しファイル」属性が付いたものもファイルツリーに表示します。オフ(既定)では通常のファイル・フォルダだけを表示します。",
  },
  "settings-modal-close": {
    category: "settings",
    label: "閉じる",
    minimalMode: "label",
    standard: "設定画面を閉じます(未保存の変更があれば確認します)",
    detailed: "設定画面を閉じます。保存していない変更がある場合は、破棄してよいか確認するダイアログを挟みます。保存済みの内容までは変わりません。",
    shortcut: "Esc",
  },
  "settings-cancel": {
    category: "settings",
    label: "キャンセル",
    minimalMode: "label",
    standard: "変更を保存せずに設定画面を閉じます",
    detailed: "この画面で変更した内容を保存せずに閉じます。保存していない変更がある場合は、破棄してよいか確認するダイアログを挟みます。テーマやツールチップの詳しさなど、保存前にプレビュー表示していた項目も開いたときの状態へ戻ります。",
  },
  "settings-save": {
    category: "settings",
    label: "保存",
    minimalMode: "label",
    standard: "この画面で変更した内容を保存します",
    detailed: "この画面で変更したすべての項目をsettings.jsonへ書き込み、開いているウィンドウへ反映します。ファイルの関連付けなど一部の項目は、Windows側で他アプリが既定に設定されている場合に反映されないことがあり、その場合は保存後にこの画面へ警告が表示されます。",
  },
  "settings-search": {
    category: "settings",
    minimalMode: "suppress",
    standard: "設定項目をキーワードで絞り込みます",
    detailed: "入力した語を各設定項目の名前や説明文と照合し、一致するカテゴリだけを左側のナビゲーションに残して絞り込みます。項目名の一部だけを入力しても一致します(例: 「文字コード」で「既定の文字コード」がヒット)。",
  },
  addToPath: {
    category: "settings",
    minimalMode: "suppress",
    standard: "コマンドラインからPaneの実行ファイルを直接呼び出せるようにするかどうかです",
    detailed: "オンにすると、Paneの実行ファイルがあるフォルダをユーザー環境変数PATHへ追加し、コマンドプロンプトやPowerShellからフォルダを指定せずに起動できるようにします。管理者権限は不要です。オフにすると、追加したPATHの登録を解除します。",
  },

  // ---- カラーピッカー ----
  "cp-eyedropper": {
    category: "colorPicker",
    label: "スポイト",
    minimalMode: "label",
    standard: "画面上の色を拾って設定します",
    detailed: "スポイトツールを起動し、画面上(このウィンドウの外側も含む)の任意の位置をクリックすると、その位置の色をそのままこの色として設定します。ブラウザ/OSがこの機能(EyeDropper API)に対応していない環境ではボタン自体が表示されません。",
  },
};

function shortcutSuffix(entry) {
  return entry && entry.shortcut ? ` (${entry.shortcut})` : "";
}

// idと現在の段階から、実際にtitleへ入れる文字列を作る。
//   state:    minimalMode:"state"のときに使う「現在の状態」文字列(呼び出し側が渡す)。
//   fallback: TOOLTIPSに無いidのときに使う { standard, detailed, minimal }。
//             渡さなければnullを返す(=「呼び出し側の既存titleをそのまま使う」という合図。
//             文言テーブルに無い要素はこの規則でtitle属性を変更しない)。
export function resolveTooltip(id, level, { state, fallback } = {}) {
  if (!level || level === "none") return "";
  const entry = TOOLTIPS[id];
  if (!entry) {
    if (!fallback) return null;
    if (level === "minimal") return fallback.minimal ?? fallback.standard ?? "";
    if (level === "detailed") return fallback.detailed ?? fallback.standard ?? "";
    return fallback.standard ?? "";
  }
  const suffix = shortcutSuffix(entry);
  if (level === "minimal") {
    if (entry.minimalMode === "suppress") return "";
    if (entry.minimalMode === "state") return (state != null && state !== "" ? state : (entry.label ?? entry.standard ?? "")) + suffix;
    return (entry.label ?? entry.standard ?? "") + suffix;
  }
  if (level === "detailed") return (entry.detailed ?? entry.standard ?? entry.label ?? "") + suffix;
  return (entry.standard ?? entry.label ?? "") + suffix;
}

// 要素1つぶんのtitleを、現在の段階に合わせて更新する。
// 識別子は data-tip属性を優先し、無ければid属性を使う(index.htmlの変更を最小にするため、
// idを持つ要素はdata-tipを付けずにそのままidで引けるようにしてある)。
// TOOLTIPSに無い要素は、初回に読んだ既存のtitle属性を「標準/詳しい」両方のフォールバックとして
// 使い回す(=文言が無い要素は元のtitleのまま。noneのときだけ空にする)。
const fallbackCache = new WeakMap();
export function applyTooltip(el, level, { state } = {}) {
  if (!el) return;
  const id = el.dataset.tip || el.id;
  if (!id) return;
  let fallback = fallbackCache.get(el);
  if (fallback === undefined) {
    const original = el.getAttribute("title") || "";
    fallback = original ? { standard: original, detailed: original, minimal: original } : null;
    fallbackCache.set(el, fallback);
  }
  const text = resolveTooltip(id, level, { state, fallback });
  if (text !== null) el.title = text;
}

// root配下の[data-tip]・[id]要素をまとめて再適用する(段階切替時の一括更新用)。
// 動的な状態(文字コードの現在値等)を持つ要素は、この一括更新だけでは正しい値にならない
// (呼び出し時点のtextContent等をstateとして渡していないため)。呼び出し側が個別に
// applyTooltip(el, level, { state })で上書きすること(main.js側の各update関数を参照)。
export function applyTooltipsIn(root, level) {
  if (!root) return;
  for (const el of root.querySelectorAll("[data-tip], [id]")) applyTooltip(el, level);
}
