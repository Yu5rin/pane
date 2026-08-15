namespace Pane;

/// <summary>
/// アプリ全体の設定。%LOCALAPPDATA%\Pane\settings.json に永続化する(仕様書 第7.1節)。
/// ウィンドウの位置・サイズは「アプリ全体で1つ」を記憶し、ファイルごとには持たない
/// (Phase 3スコープ: 複数ウィンドウのカスケード配置の基準として使う)。
///
/// キー名・型・取りうる値・既定値の一次資料は docs/設定項目一覧.md。列挙値のプロパティは
/// すべてbacking field + カスタムsetterで「一覧に無い値は既定値へ倒す」形にし、数値は
/// 資料に範囲が明記されているものだけクランプする。設定ファイルが手で壊されても
/// (あるいは旧バージョンの設定ファイルを読み込んでも)アプリが変な状態にならないようにするため。
/// </summary>
internal sealed class AppSettings
{
    // ---- 列挙値・範囲付き数値の検証ヘルパー ----

    /// <summary>allowedValuesに無い値は既定値へ倒す。</summary>
    private static string ValidateEnum(string? value, string defaultValue, params string[] allowedValues) =>
        value is not null && Array.IndexOf(allowedValues, value) >= 0 ? value : defaultValue;

    /// <summary>allowedに無い値は既定値へ倒す(離散的な選択肢のint、例: インデント幅2|4|8)。</summary>
    private static int ValidateIntSet(int value, int defaultValue, params int[] allowed) =>
        Array.IndexOf(allowed, value) >= 0 ? value : defaultValue;

    // ウィンドウ位置・サイズの検証。設定ファイルが手で(あるいは何らかの事故で)壊れていた場合、
    // 極端な座標や幅0・負の高さのままPaneApplicationContext側の復元処理に渡ると、画面外や
    // 幅0のウィンドウが開き、再起動しても同じ壊れた値を読み直すため自己修復しない
    // (実際に画面内へ収まっているかはモニタ構成に依存するため、その厳密な判定は
    // PaneApplicationContext.OpenWindow側で行う。ここでは「そもそもあり得ない値」を
    // 弾く最低限の検証だけを行う。他の数値設定(EditorFontSize等)と同じ方針)。

    /// <summary>座標としてありうる範囲のおおまかな上限(絶対値)。マルチモニタ環境では主画面から
    /// 数千px離れた位置に副モニタが配置されることも普通にあるため、その程度は正常値として通しつつ、
    /// 設定ファイル破損時に起こりうる桁違いの異常値(int.MaxValue付近等)だけを弾く目的の値。</summary>
    private const int MaxWindowCoordinate = 100_000;

    /// <summary>ウィンドウ幅の下限(px)。タイトルバー・サイドバー・最低限の本文が表示できる目安。
    /// SettingsWindow(640x480)より小さくてよいため、より控えめな値にした。</summary>
    private const int MinWindowWidth = 400;

    /// <summary>ウィンドウ高さの下限(px)。上記と同じ考え方。</summary>
    private const int MinWindowHeight = 300;

    private int? _windowX;

    public int? WindowX
    {
        get => _windowX;
        set => _windowX = value is int v ? Math.Clamp(v, -MaxWindowCoordinate, MaxWindowCoordinate) : null;
    }

    private int? _windowY;

    public int? WindowY
    {
        get => _windowY;
        set => _windowY = value is int v ? Math.Clamp(v, -MaxWindowCoordinate, MaxWindowCoordinate) : null;
    }

    private int? _windowWidth;

    /// <summary>下限のみならずMaxWindowCoordinateも上限として使う(int.MaxValue級の異常値が
    /// そのままRectangle計算(x + width等)に渡ってオーバーフローするのを避けるため)。</summary>
    public int? WindowWidth
    {
        get => _windowWidth;
        set => _windowWidth = value is int v ? Math.Clamp(v, MinWindowWidth, MaxWindowCoordinate) : null;
    }

    private int? _windowHeight;

    public int? WindowHeight
    {
        get => _windowHeight;
        set => _windowHeight = value is int v ? Math.Clamp(v, MinWindowHeight, MaxWindowCoordinate) : null;
    }

    // ================= 一般 (general) =================

    private string _displayMode = "window";

    /// <summary>"window" | "tab"。実際のタブUIはPhase 8で実装するため、ここでは値の保持のみ。</summary>
    public string DisplayMode
    {
        get => _displayMode;
        set => _displayMode = ValidateEnum(value, "window", "window", "tab");
    }

    private string _startupBehavior = "blank";

    /// <summary>"blank" | "restoreSession" | "customFolder"。仕様書 N-07。</summary>
    public string StartupBehavior
    {
        get => _startupBehavior;
        set => _startupBehavior = ValidateEnum(value, "blank", "blank", "restoreSession", "customFolder");
    }

    /// <summary>StartupBehaviorが"customFolder"のとき起動時に読み込むフォルダのパス。既定null(未指定)。</summary>
    public string? StartupFolderPath { get; set; }

    /// <summary>最後のウィンドウを閉じたときにアプリごと終了するか。falseならウィンドウ0枚のまま常駐する
    /// (preload起動時と同じ扱い)。既定true。</summary>
    public bool QuitOnLastWindowClosed { get; set; } = true;

    /// <summary>直近に開いていたファイルパス一覧(セッション復元用)。スクロール位置等は含めない。</summary>
    public List<string> OpenFilePaths { get; set; } = new();

    /// <summary>既定のMarkdownエディタとしてファイル関連付け登録済みか(仕様書 N-09 / 第7.1節)。
    /// 互換のため残す。実際に登録対象となる拡張子は<see cref="AssociatedExtensions"/>を参照。</summary>
    public bool FileAssociationEnabled { get; set; }

    /// <summary>
    /// ファイル関連付けの対象拡張子(ドット無し・小文字。仕様書 第2.10節 C-13)。
    /// 設定画面のチェックボックスで任意の拡張子(約50言語・200拡張子)を選べるようにするための
    /// 可変リスト。<see cref="FileAssociationService.Apply"/> の desired/previous として使う。
    /// </summary>
    public List<string> AssociatedExtensions { get; set; } = new();

    /// <summary>
    /// 実際に関連付け対象とみなす拡張子集合を返す。
    /// 移行措置: この改修より前のバージョンでは対象拡張子が .md/.markdown/.mdown に固定
    /// されており、AssociatedExtensionsという概念自体が無かった。そのためFileAssociationEnabled
    /// がtrueなのにAssociatedExtensionsが空(=旧バージョンの設定ファイルをそのまま読み込んだ)場合は、
    /// 従来どおりこの3つが対象だったとみなして返す。そうしないと、アップグレード直後に
    /// 「関連付け有効のはずなのに対象拡張子が0件」という矛盾した状態になってしまう。
    /// </summary>
    public IReadOnlyCollection<string> GetEffectiveAssociatedExtensions()
    {
        if (FileAssociationEnabled && AssociatedExtensions.Count == 0)
        {
            return FileAssociationService.LegacyDefaultExtensions;
        }
        return AssociatedExtensions;
    }

    /// <summary>エクスプローラーの右クリック→「新規作成」にMarkdownファイルを追加するか
    /// (`HKCU\Software\Classes\.md\ShellNew`)。既定false。<see cref="ShellNewService"/>。</summary>
    public bool ExplorerNewMenuEnabled { get; set; }

    /// <summary>PCログオン時にPaneを"--preload"付きで常駐起動し、初回のファイルオープンを
    /// 高速化するか(StartupServiceでHKCU\...\Run に登録)。</summary>
    public bool PreloadOnStartup { get; set; }

    /// <summary>ステータスバーの表示(仕様書外・一般的なテキストエディタ相当)。既定true。JS側で効かせる。</summary>
    public bool ShowStatusBar { get; set; } = true;

    /// <summary>アウトライン(見出し一覧)パネルを既定で開いておくか。既定false。JS側で効かせる。</summary>
    public bool ShowOutlineByDefault { get; set; }

    /// <summary>アウトラインの各項目を折りたたみ可能にするか。既定true。JS側で効かせる。</summary>
    public bool CollapsibleOutline { get; set; } = true;

    private int _sidebarWidthPx = 240;

    /// <summary>サイドバーの幅(px、ドラッグでのリサイズ結果を永続化。仕様書外・ユーザー要望)。
    /// 180〜600の範囲でクランプする(180未満はファイルツリーの階層が潰れて読めなくなり、
    /// 600超は本文エリアを圧迫するため)。ウィンドウ幅の50%を超えないという制約はウィンドウ
    /// サイズ依存のためここでは扱わず、JS側(sidebar.js)がドラッグ・ウィンドウリサイズの
    /// たびに動的にクランプする。既定240(元の固定幅と同じ)。設定画面のUIには出さない
    /// (ドラッグで直接変えられるため、設定画面にも置くと二重になる)。</summary>
    public int SidebarWidthPx
    {
        get => _sidebarWidthPx;
        set => _sidebarWidthPx = Math.Clamp(value, 180, 600);
    }

    /// <summary>最近使ったファイルを記録するか。falseなら<see cref="RecentFiles"/>への追記を止める。既定true。</summary>
    public bool RecordRecentFiles { get; set; } = true;

    /// <summary>Ctrl+マウスホイールで本文の文字サイズを変更できるようにするか。既定true。JS側で効かせる。</summary>
    public bool ZoomWithCtrlWheel { get; set; } = true;

    private string _tooltipDetail = "standard";

    /// <summary>マウスカーソルを合わせたときに出るツールチップの詳しさ(依頼2)。
    /// "none"(表示しない) | "minimal"(最低限。現在の状態を示す情報のみ) |
    /// "standard"(既定。ネットリテラシーのある人が見て分かる程度) |
    /// "detailed"(詳しい。何ができてどうなるかを具体的に説明)。
    /// 文言そのものはC#側では持たず、JS側(src/tooltips.js)に集約する。既定"standard"。</summary>
    public string TooltipDetail
    {
        get => _tooltipDetail;
        set => _tooltipDetail = ValidateEnum(value, "standard", "none", "minimal", "standard", "detailed");
    }

    // ================= 保存と復元 (save) =================

    /// <summary>自動保存を行うか。既定true。<see cref="AutoSaveService"/>・MainFormの自動保存タイマー。</summary>
    public bool AutoSaveEnabled { get; set; } = true;

    private int _autoSaveIntervalSeconds = 30;

    /// <summary>自動保存の間隔(秒)。5〜600の範囲でクランプする。既定30。</summary>
    public int AutoSaveIntervalSeconds
    {
        get => _autoSaveIntervalSeconds;
        set => _autoSaveIntervalSeconds = Math.Clamp(value, 5, 600);
    }

    /// <summary>異常終了時のスナップショットから復元するか確認するか。falseなら確認せずスナップショットを
    /// 破棄する(<see cref="PaneApplicationContext.RunRecoveryAndInitialOpen"/>)。既定true。</summary>
    public bool RecoverUnsavedDrafts { get; set; } = true;

    /// <summary>サイドバーからのファイル切替時、確認せずに保存するか。既定false。JS側で効かせる。</summary>
    public bool SaveWithoutAskingOnSwitch { get; set; }

    private string _defaultEncoding = "utf8";

    /// <summary>既定の文字コード(仕様書 C-12)。既定"utf8"。</summary>
    public string DefaultEncoding
    {
        get => _defaultEncoding;
        set => _defaultEncoding = ValidateEnum(value, "utf8", "utf8", "utf8bom", "shiftjis", "utf16le");
    }

    private string _defaultLineEnding = "crlf";

    /// <summary>既定の改行コード(仕様書 C-12)。既定"crlf"。</summary>
    public string DefaultLineEnding
    {
        get => _defaultLineEnding;
        set => _defaultLineEnding = ValidateEnum(value, "crlf", "crlf", "lf");
    }

    private string _defaultFileExtension = "md";

    /// <summary>「名前を付けて保存」の既定拡張子(ドット無し)。既定"md"。
    /// 先頭のドット・前後の空白は保存時に取り除き、空になった場合は既定値へ倒す。</summary>
    public string DefaultFileExtension
    {
        get => _defaultFileExtension;
        set
        {
            string trimmed = (value ?? "").Trim().TrimStart('.');
            _defaultFileExtension = trimmed.Length > 0 ? trimmed : "md";
        }
    }

    // ================= 編集 (editor) =================

    private int _indentSizeOnSave = 4;

    /// <summary>引用・リストのインデント幅。2|4|8のいずれか。既定4。JS `editor.js`。</summary>
    public int IndentSizeOnSave
    {
        get => _indentSizeOnSave;
        set => _indentSizeOnSave = ValidateIntSet(value, 4, 2, 4, 8);
    }

    private int _codeIndentSize = 4;

    /// <summary>
    /// Tabキーで新規挿入するスペースの数、およびタブ文字の表示幅。2|4|8のいずれか。既定4。
    /// JS `editor.js`(indentUnit・EditorState.tabSizeの両方に反映)。
    /// 注意: 既にスペースで書かれているインデントの見た目の幅は変わらない(文字そのものなので)。
    /// </summary>
    public int CodeIndentSize
    {
        get => _codeIndentSize;
        set => _codeIndentSize = ValidateIntSet(value, 4, 2, 4, 8);
    }

    /// <summary>コードモードでの折りたたみ(関数・オブジェクト・配列等)を有効にするか。既定true。JS `editor.js`。</summary>
    public bool CodeFoldingEnabled { get; set; } = true;

    /// <summary>コードブロック内の長い行を折り返すか。既定true。JS `editor.js`。</summary>
    public bool CodeAutoWrap { get; set; } = true;

    /// <summary>Shift+Tabで行頭のインデントを自動的に減らすか。既定false。JS `editor.js`。</summary>
    public bool ShiftTabAutoIndent { get; set; }

    /// <summary>括弧・引用符の自動ペアリング(仕様書 C-05)。既定ON。</summary>
    public bool AutoPairing { get; set; } = true;

    /// <summary>`**` `_` などMarkdown記法の自動ペアリング。既定true。JS `editor.js`。</summary>
    public bool AutoPairMarkdown { get; set; } = true;

    private string _emojiAutocomplete = "auto";

    /// <summary>絵文字補完。"off" | "esc" | "auto"。既定"auto"。JS `editor.js`。</summary>
    public string EmojiAutocomplete
    {
        get => _emojiAutocomplete;
        set => _emojiAutocomplete = ValidateEnum(value, "auto", "off", "esc", "auto");
    }

    /// <summary>カーソル行の記法を生表示するか(ライブレンダリング)。既定true。JS `editor.js`。</summary>
    public bool LiveRenderingShowSourceOnFocus { get; set; } = true;

    private string _defaultCopyFormat = "markdown";

    /// <summary>"markdown" | "html"。既定のコピー形式(仕様書 第2.9.3節)。</summary>
    public string DefaultCopyFormat
    {
        get => _defaultCopyFormat;
        set => _defaultCopyFormat = ValidateEnum(value, "markdown", "markdown", "html");
    }

    /// <summary>選択範囲が無い状態でのコピーで、カーソル行全体をコピーするか。既定true。JS `editor.js`。</summary>
    public bool CopyWholeLineWhenNoSelection { get; set; } = true;

    /// <summary>タイプライターモードでカーソル行を画面中央に保つか。既定true。JS `editor.js`。</summary>
    public bool TypewriterKeepCaretCentered { get; set; } = true;

    /// <summary>WebView2のスペルチェックを有効化するか。既定false。JS `editor.js`。</summary>
    public bool SpellCheckEnabled { get; set; }

    /// <summary>スペルチェックの自動修正を有効化するか。既定false。JS `editor.js`。</summary>
    public bool SpellCheckAutoCorrect { get; set; }

    /// <summary>コード中の色リテラル(#ff6600 等)に色見本と文字色を付けるか。既定true。
    /// JS `editor.js` / `color-picker.js`(docs/カラープレビュー仕様.md)。</summary>
    public bool ColorPreviewInCode { get; set; } = true;

    private int _readingSpeedWpm;

    /// <summary>読了時間計算用の読書速度(wpm)。0=自動。負値は0へ倒す。既定0。JS `text-stats.js`。</summary>
    public int ReadingSpeedWpm
    {
        get => _readingSpeedWpm;
        set => _readingSpeedWpm = Math.Max(0, value);
    }

    private string _autoDetectMode = "standard";

    /// <summary>
    /// 編集モードの自動判定設定。"off" | "suggest" | "standard" | "aggressive" の4値。
    /// これ以外の値(設定ファイルの破損・旧バージョンとの非互換等)は"standard"として扱う。
    /// setterで正規化するため、JSONからの読み込み時(System.Text.Jsonはpublicなsetterを
    /// 経由してデシリアライズする)・save-settings受信時のいずれで代入されても正規化される。
    /// </summary>
    public string AutoDetectMode
    {
        get => _autoDetectMode;
        set => _autoDetectMode = ValidateEnum(value, "standard", "off", "suggest", "standard", "aggressive");
    }

    /// <summary>
    /// 拡張子ごとの既定モード上書き(ドット無し・小文字 → "markdown"|"code"|"plain")。
    /// resolveFileMode(拡張子判定)より優先されるが、PerFileModes(ファイル単位の手動記憶)よりは弱い。
    /// </summary>
    public Dictionary<string, string> FileModeOverrides { get; set; } = new();

    /// <summary>
    /// ファイルのフルパス → 手動で選んだモード("markdown"|"code"|"plain")。
    /// 表示メニューでモードを手動切替した際にだけ記憶する(自動判定と一致する場合は記憶しない)。
    /// 最大100件、超過分は古いものから捨てる(MainForm側で挿入順を保って管理する)。
    /// </summary>
    public Dictionary<string, string> PerFileModes { get; set; } = new();

    // ================= Markdown (markdown) - 記法サポート =================

    /// <summary>インライン数式 `$...$`(M-23)。Typora準拠で既定OFF。</summary>
    public bool InlineMathEnabled { get; set; }

    /// <summary>コードブロック内数式記法。既定false。JS `math.js`。</summary>
    public bool CodeBlockMathEnabled { get; set; }

    /// <summary>上付き文字・下付き文字(M-24・M-25)。</summary>
    public bool SuperSubscriptEnabled { get; set; } = true;

    /// <summary>ハイライト `==text==`(M-26)。</summary>
    public bool HighlightEnabled { get; set; } = true;

    /// <summary>Mermaid等の図表記法。既定true。JS `mermaid-render.js`。</summary>
    public bool DiagramsEnabled { get; set; } = true;

    /// <summary>URLの自動リンク化。既定true。JS `markdown-extras.js`。</summary>
    public bool AutoLinksEnabled { get; set; } = true;

    /// <summary>Callouts / GitHub式アラート(M-13)。</summary>
    public bool CalloutsEnabled { get; set; } = true;

    // ================= Markdown (markdown) - 記法の書き方 =================

    /// <summary>厳格モード。見出し・リスト記号の記法を制限する(仕様書 C-02)。既定OFF。</summary>
    public bool StrictMode { get; set; }

    private string _headingStyle = "atx";

    /// <summary>見出しの書き方。"atx"(`#`) | "setext"(`===`/`---`)。既定"atx"。JS `commands.js`。</summary>
    public string HeadingStyle
    {
        get => _headingStyle;
        set => _headingStyle = ValidateEnum(value, "atx", "atx", "setext");
    }

    private string _unorderedListMarker = "-";

    /// <summary>箇条書きの記号。"-" | "*" | "+"。既定"-"。JS `commands.js`。</summary>
    public string UnorderedListMarker
    {
        get => _unorderedListMarker;
        set => _unorderedListMarker = ValidateEnum(value, "-", "-", "*", "+");
    }

    private string _orderedListMarker = ".";

    /// <summary>番号付きリストの区切り。"." | ")"。既定"."。JS `commands.js`。</summary>
    public string OrderedListMarker
    {
        get => _orderedListMarker;
        set => _orderedListMarker = ValidateEnum(value, ".", ".", ")");
    }

    /// <summary>コードブロックの行番号表示(仕様書 C-03)。既定ON。</summary>
    public bool CodeBlockLineNumbers { get; set; } = true;

    /// <summary>
    /// 数式の自動採番(旧・仕様書 C-04)。既定OFF。
    /// [廃止予定] 3値の<see cref="MathAutoNumber"/>に置き換えられた。旧設定ファイルからの
    /// 移行のためだけに残す。読み書きは<see cref="GetEffectiveMathAutoNumber"/>経由で行うこと。
    /// </summary>
    public bool MathAutoNumberEnabled { get; set; }

    private string _mathAutoNumber = "off";

    /// <summary>数式の自動採番。"off" | "ams" | "all"。既定"off"。
    /// 旧バージョンからの移行は<see cref="GetEffectiveMathAutoNumber"/>を参照。</summary>
    public string MathAutoNumber
    {
        get => _mathAutoNumber;
        set => _mathAutoNumber = ValidateEnum(value, "off", "off", "ams", "all");
    }

    /// <summary>
    /// 実際に使う数式自動採番の値を返す。
    /// 移行措置: この改修より前のバージョンでは<see cref="MathAutoNumberEnabled"/>(bool)しか
    /// 存在しなかった。そのためMathAutoNumberEnabledがtrueなのにMathAutoNumberが既定値"off"の
    /// まま(=新しいキーがまだ一度も書き込まれていない、旧バージョンの設定ファイルをそのまま
    /// 読み込んだ状態)の場合は、旧設定で「自動採番ON」だったとみなして"all"を返す
    /// (<see cref="GetEffectiveAssociatedExtensions"/>と同じ考え方)。
    /// </summary>
    public string GetEffectiveMathAutoNumber()
    {
        if (MathAutoNumberEnabled && MathAutoNumber == "off")
        {
            return "all";
        }
        return MathAutoNumber;
    }

    private int _chapterLevelInOutline = 6;

    /// <summary>アウトラインに表示する見出しレベルの上限。1〜6の範囲でクランプする。既定6。</summary>
    public int ChapterLevelInOutline
    {
        get => _chapterLevelInOutline;
        set => _chapterLevelInOutline = Math.Clamp(value, 1, 6);
    }

    /// <summary>コードブロック作成時の既定言語ID。空=なし。既定""。JS `commands.js`。</summary>
    public string DefaultCodeLanguage { get; set; } = "";

    private string _defaultCodeLanguageApplyWhen = "menubar";

    /// <summary>既定言語をどこに適用するか。"markdown" | "menubar" | "both"。既定"menubar"。</summary>
    public string DefaultCodeLanguageApplyWhen
    {
        get => _defaultCodeLanguageApplyWhen;
        set => _defaultCodeLanguageApplyWhen = ValidateEnum(value, "menubar", "markdown", "menubar", "both");
    }

    // ================= Markdown (markdown) - 空白と改行 =================

    private string _whitespaceWhenWriting = "preserve";

    /// <summary>編集時の連続空白の扱い。"preserve" | "ignore"。既定"preserve"。JS `editor.js`。</summary>
    public string WhitespaceWhenWriting
    {
        get => _whitespaceWhenWriting;
        set => _whitespaceWhenWriting = ValidateEnum(value, "preserve", "preserve", "ignore");
    }

    private string _whitespaceOnExport = "ignore";

    /// <summary>エクスポート時の連続空白の扱い。"preserve" | "ignore"。既定"ignore"。JS `editor.js`。</summary>
    public string WhitespaceOnExport
    {
        get => _whitespaceOnExport;
        set => _whitespaceOnExport = ValidateEnum(value, "ignore", "preserve", "ignore");
    }

    // ================= Markdown (markdown) - スマート置換 =================

    private string _smartQuotes = "off";

    /// <summary>引用符の自動置換。"off" | "input" | "render"。既定"off"。JS `editor.js`。</summary>
    public string SmartQuotes
    {
        get => _smartQuotes;
        set => _smartQuotes = ValidateEnum(value, "off", "off", "input", "render");
    }

    private string _smartDashes = "off";

    /// <summary>ダッシュの自動置換。"off" | "endash" | "emdash"。既定"off"。JS `editor.js`。</summary>
    public string SmartDashes
    {
        get => _smartDashes;
        set => _smartDashes = ValidateEnum(value, "off", "off", "endash", "emdash");
    }

    /// <summary>Unicodeの句読点入力を認識するか。既定false。JS `editor.js`。</summary>
    public bool RecognizeUnicodePunctuation { get; set; }

    // ================= 画像 (image) =================

    private string _imageInsertAction = "none";

    /// <summary>画像挿入時の保存先。"none"|"currentFolder"|"assets"|"filenameAssets"|"custom"。既定"none"。</summary>
    public string ImageInsertAction
    {
        get => _imageInsertAction;
        set => _imageInsertAction = ValidateEnum(value, "none", "none", "currentFolder", "assets", "filenameAssets", "custom");
    }

    /// <summary>ImageInsertActionが"custom"のときの保存先。`./` `../` で始まる相対パスか絶対パス。
    /// `${filename}` は現在のファイル名(拡張子なし)に展開する。既定""。</summary>
    public string ImageCustomFolder { get; set; } = "";

    /// <summary>ローカル画像の挿入にも上記の設定を適用するか。既定true。</summary>
    public bool ImageApplyToLocal { get; set; } = true;

    /// <summary>オンライン画像(URL)の挿入にも上記の設定を適用するか。既定false。</summary>
    public bool ImageApplyToOnline { get; set; }

    /// <summary>可能な場合は相対パスを優先するか。既定true。</summary>
    public bool ImagePreferRelativePath { get; set; } = true;

    /// <summary>相対パスの先頭に`./`を付けるか。既定false。</summary>
    public bool ImageAddDotSlash { get; set; }

    /// <summary>画像パスのURLエスケープを自動で行うか。既定true。</summary>
    public bool ImageAutoEscapeUrl { get; set; } = true;

    // ================= エクスポート・印刷 (export) =================

    private string _exportPaperSize = "a4";

    /// <summary>用紙サイズ。既定"a4"。</summary>
    public string ExportPaperSize
    {
        get => _exportPaperSize;
        set => _exportPaperSize = ValidateEnum(value, "a4", "a4", "a3", "b5", "letter", "legal", "tabloid", "custom");
    }

    public int ExportCustomWidthMm { get; set; } = 210;
    public int ExportCustomHeightMm { get; set; } = 297;

    private string _exportOrientation = "portrait";

    /// <summary>用紙の向き。"portrait" | "landscape"。既定"portrait"。</summary>
    public string ExportOrientation
    {
        get => _exportOrientation;
        set => _exportOrientation = ValidateEnum(value, "portrait", "portrait", "landscape");
    }

    public int ExportMarginTopMm { get; set; } = 20;
    public int ExportMarginBottomMm { get; set; } = 20;
    public int ExportMarginLeftMm { get; set; } = 20;
    public int ExportMarginRightMm { get; set; } = 20;

    /// <summary>ヘッダー文字列。`{title}` `{page}` `{pages}` `{date}` `{time}` `{path}` が使える。既定""。</summary>
    public string ExportHeaderText { get; set; } = "";

    /// <summary>フッター文字列。既定""。</summary>
    public string ExportFooterText { get; set; } = "";

    /// <summary>トップレベル見出しの前で改ページするか。既定false。</summary>
    public bool ExportPageBreakBetweenTopHeadings { get; set; }

    /// <summary>エクスポート結果にアウトラインを含めるか。既定false。</summary>
    public bool ExportIncludeOutline { get; set; }

    public int ExportOutlineWidthPx { get; set; } = 260;

    /// <summary>エクスポートするHTML等の`<head>`へ追加するテキスト。既定""。</summary>
    public string ExportAppendHead { get; set; } = "";

    /// <summary>エクスポートするHTML等の`<body>`へ追加するテキスト。既定""。</summary>
    public string ExportAppendBody { get; set; } = "";

    private string _exportDefaultFolder = "sameAsFile";

    /// <summary>エクスポート先フォルダの既定。"sameAsFile" | "custom"。既定"sameAsFile"。</summary>
    public string ExportDefaultFolder
    {
        get => _exportDefaultFolder;
        set => _exportDefaultFolder = ValidateEnum(value, "sameAsFile", "sameAsFile", "custom");
    }

    /// <summary>ExportDefaultFolderが"custom"のときの保存先。既定""。</summary>
    public string ExportCustomFolder { get; set; } = "";

    private string _exportAfter = "none";

    /// <summary>エクスポート後の動作。"none" | "openFile" | "openFolder"。既定"none"。</summary>
    public string ExportAfter
    {
        get => _exportAfter;
        set => _exportAfter = ValidateEnum(value, "none", "none", "openFile", "openFolder");
    }

    /// <summary>エクスポート時に保存ダイアログを表示するか。既定true。</summary>
    public bool ExportShowSaveDialog { get; set; } = true;

    private string _exportMathAs = "svg";

    /// <summary>数式のエクスポート形式。"svg" | "latex"。既定"svg"。</summary>
    public string ExportMathAs
    {
        get => _exportMathAs;
        set => _exportMathAs = ValidateEnum(value, "svg", "svg", "latex");
    }

    /// <summary>エクスポート時にYAML Front Matterを読み取るか。既定true。</summary>
    public bool ExportReadYamlFrontMatter { get; set; } = true;

    // ================= 外観 (appearance) =================

    private string _theme = "system";

    /// <summary>"system" | "light" | "dark"。手動でテーマを切り替えた場合に永続化する(仕様書 第10.2節)。</summary>
    public string Theme
    {
        get => _theme;
        set => _theme = ValidateEnum(value, "system", "light", "dark", "system");
    }

    private string _lightTheme = "default";

    /// <summary>ライトモード時に使うテーマ名(仕様書 C-06)。既定"default"。</summary>
    public string LightTheme
    {
        get => _lightTheme;
        set => _lightTheme = ValidateEnum(value, "default", "default", "sepia", "github", "solarized-light");
    }

    private string _darkTheme = "default";

    /// <summary>ダークモード時に使うテーマ名(仕様書 C-06)。既定"default"。
    /// 移行措置: 実機フィードバックによりプリセットid "typora-night" を "night" へ
    /// 改称した(ラベルも「Typora Night」→「Night」)。既に"typora-night"で保存済みの
    /// 利用者の設定ファイルをそのままValidateEnumに通すと一覧に無い値として既定値
    /// "default"へ倒れてしまい、選んでいたテーマが失われるため、setterの入口で
    /// "typora-night"だけ"night"へ読み替えてから検証する。</summary>
    public string DarkTheme
    {
        get => _darkTheme;
        set => _darkTheme = ValidateEnum(value == "typora-night" ? "night" : value, "default", "default", "nord", "dracula", "solarized-dark", "night");
    }

    /// <summary>ダークモード時に(ライトモードとは)別のテーマを使うか。既定true。</summary>
    public bool UseSeparateThemeInDarkMode { get; set; } = true;

    /// <summary>カスタムCSSファイルのパス(仕様書 C-07)。既定null(未指定)。</summary>
    public string? CustomCssPath { get; set; }

    /// <summary>本文フォント(仕様書 C-08)。既定null(テーマ既定のフォントを使う)。</summary>
    public string? EditorFontFamily { get; set; }

    /// <summary>等幅/コード用フォント(本文フォントとは別枠)。既定null(未指定)。</summary>
    public string? EditorMonospaceFontFamily { get; set; }

    private int _editorFontSize = 15;

    /// <summary>本文の文字サイズ(px)。8〜72の範囲でクランプする。Ctrl+マウスホイールでの変更を永続化する。</summary>
    public int EditorFontSize
    {
        get => _editorFontSize;
        set => _editorFontSize = Math.Clamp(value, 8, 72);
    }

    private double _editorLineHeight = 1.95;

    /// <summary>本文の行間(倍率)。1.0〜3.0の範囲でクランプする。既定1.95
    /// (仕様書 第10.3節: 日本語のため現行の1.85から広げる)。</summary>
    public double EditorLineHeight
    {
        get => _editorLineHeight;
        set => _editorLineHeight = Math.Clamp(value, 1.0, 3.0);
    }

    // 仕様書 第10.3節「本文の最大幅は42文字相当」。全角文字はおおよそ正方形(幅=フォントサイズの
    // 1em)とみなせるため、全角42文字分の幅を「既定フォントサイズ(EditorFontSize既定15px) × 42」で
    // 算出する(630px)。src/settings.js側にも同じ計算式・同じ既定値をコメント付きで置く
    // (両者は独立した既定値なので、フォントサイズの既定を変える場合はここも合わせて見直すこと)。
    private int _editorMaxWidthPx = 15 * 42;

    /// <summary>本文の最大幅(px)。0=無制限。負値は0へ倒す。既定630(全角42文字相当、Markdownモードにのみ適用。
    /// JS側でモードごとの出し分けを行う)。</summary>
    public int EditorMaxWidthPx
    {
        get => _editorMaxWidthPx;
        set => _editorMaxWidthPx = Math.Max(0, value);
    }

    /// <summary>
    /// 本文の左右の余白(旧・仕様書 editorPaddingX)。
    /// [廃止予定] 左右を個別に指定できる<see cref="EditorPaddingLeft"/>/<see cref="EditorPaddingRight"/>に
    /// 置き換えられた(ユーザー要望: 左右で余白を変えたい)。旧設定ファイルからの移行のためだけに
    /// 残す(このプロパティ自体は以後どこからも新規に書き込まれない)。読み書きは
    /// <see cref="GetEffectiveEditorPaddingLeft"/>/<see cref="GetEffectiveEditorPaddingRight"/>経由で
    /// 行うこと。
    /// </summary>
    private int _editorPaddingX = 32;
    public int EditorPaddingX
    {
        get => _editorPaddingX;
        set => _editorPaddingX = Math.Clamp(value, 0, 200);
    }

    private int _editorPaddingLeft = 32;

    /// <summary>本文の左余白(px)。0〜200の範囲でクランプする。既定32。
    /// CSS変数 --editor-padding-left として src/style.css の #cm-host .cm-content へ反映される
    /// (実際にCSS変数へ設定する処理はJS側main.jsが担当。ここでは値の保持と検証のみ)。
    /// 旧バージョンからの移行は<see cref="GetEffectiveEditorPaddingLeft"/>を参照。</summary>
    public int EditorPaddingLeft
    {
        get => _editorPaddingLeft;
        set => _editorPaddingLeft = Math.Clamp(value, 0, 200);
    }

    private int _editorPaddingRight = 32;

    /// <summary>本文の右余白(px)。0〜200の範囲でクランプする。既定32。
    /// CSS変数 --editor-padding-right として src/style.css の #cm-host .cm-content へ反映される。
    /// 旧バージョンからの移行は<see cref="GetEffectiveEditorPaddingRight"/>を参照。</summary>
    public int EditorPaddingRight
    {
        get => _editorPaddingRight;
        set => _editorPaddingRight = Math.Clamp(value, 0, 200);
    }

    /// <summary>
    /// 実際に使う本文の左余白を返す。
    /// 移行措置: この改修より前のバージョンでは<see cref="EditorPaddingX"/>(左右共通の1値)しか
    /// 存在しなかった。EditorPaddingXが既定値(32)以外に設定済みで、かつEditorPaddingLeft/Rightが
    /// どちらもまだ既定値(32)のまま(=新しいキーがまだ一度も書き込まれていない、旧バージョンの
    /// 設定ファイルをそのまま読み込んだ状態)であれば、旧設定の値を左右どちらにも適用する
    /// (<see cref="GetEffectiveMathAutoNumber"/>と同じ考え方)。どちらか一方でも既定値以外へ
    /// 明示的に変更されていれば(=新しい設定画面で一度でも保存されていれば)、以後はこの
    /// 移行判定を行わず、EditorPaddingLeft/Rightをそのまま使う。
    /// </summary>
    public int GetEffectiveEditorPaddingLeft()
    {
        if (EditorPaddingX != 32 && EditorPaddingLeft == 32 && EditorPaddingRight == 32) return EditorPaddingX;
        return EditorPaddingLeft;
    }

    /// <summary>実際に使う本文の右余白を返す。移行の考え方は<see cref="GetEffectiveEditorPaddingLeft"/>と同じ。</summary>
    public int GetEffectiveEditorPaddingRight()
    {
        if (EditorPaddingX != 32 && EditorPaddingLeft == 32 && EditorPaddingRight == 32) return EditorPaddingX;
        return EditorPaddingRight;
    }

    /// <summary>文字数カウントの常時表示(仕様書 C-09)。既定ON。</summary>
    public bool ShowWordCount { get; set; } = true;

    // ================= キーボード (keyboard) =================

    /// <summary>
    /// コマンドID→ショートカット文字列のキーバインド上書き(仕様書 C-10)。
    /// 既定は空(=すべて既定のショートカットのまま)。
    /// </summary>
    public Dictionary<string, string> KeyBindings { get; set; } = new();

    // ================= 詳細 (advanced) =================

    /// <summary>開発者ツール(DevTools)を開けるようにするか。既定false。
    /// 開発ビルド(DEBUG)では設定値に関わらず常に許可する(MainForm側で判定)。</summary>
    public bool EnableDebug { get; set; }

    /// <summary>ファイルツリーに隠しファイルを表示するか。既定false。</summary>
    public bool ShowHiddenFilesInTree { get; set; }

    /// <summary>ファイルツリーの表示フィルタ(glob。`!`始まりで除外)。既定空。</summary>
    public List<string> FileTreePatterns { get; set; } = new();

    /// <summary>
    /// exeのあるフォルダをユーザー環境変数PATH(<c>HKCU\Environment</c>)へ追加するか(仕様書 F-14)。
    /// インストーラを使わない方針のため管理者権限が要らないユーザー環境変数側にのみ登録する。
    /// 既定false。実際の登録・解除は<see cref="PathEnvironmentService"/>が行う。
    /// </summary>
    public bool AddToPath { get; set; }

    // ================= その他(仕様書外の付随情報) =================

    /// <summary>最近使ったファイル(仕様書 F-09)。先頭が最新。最大件数はRecentFilesService側で制御する。</summary>
    public List<string> RecentFiles { get; set; } = new();

    /// <summary>
    /// 最後に読み込んでいたフォルダのパス(仕様書 第2.8節、サイドバー用のセッション復元)。
    /// 実際に起動時へ反映する処理は後続ステップで実装する。ここではプロパティの保持のみ。
    /// </summary>
    public string? LastFolderPath { get; set; }
}
