namespace Pane;

/// <summary>
/// アプリ全体の設定。%LOCALAPPDATA%\Pane\settings.json に永続化する(仕様書 第7.1節)。
/// ウィンドウの位置・サイズは「アプリ全体で1つ」を記憶し、ファイルごとには持たない
/// (Phase 3スコープ: 複数ウィンドウのカスケード配置の基準として使う)。
/// </summary>
internal sealed class AppSettings
{
    public int? WindowX { get; set; }
    public int? WindowY { get; set; }
    public int? WindowWidth { get; set; }
    public int? WindowHeight { get; set; }

    /// <summary>"window" | "tab"。実際のタブUIはPhase 8で実装するため、ここでは値の保持のみ。</summary>
    public string DisplayMode { get; set; } = "window";

    /// <summary>"restoreSession" | "blank"。仕様書 N-07。</summary>
    public string StartupBehavior { get; set; } = "blank";

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

    /// <summary>PCログオン時にPaneを"--preload"付きで常駐起動し、初回のファイルオープンを
    /// 高速化するか(StartupServiceでHKCU\...\Run に登録)。</summary>
    public bool PreloadOnStartup { get; set; }

    // ---- マークダウン記法拡張のON/OFF(仕様書 第2.10節 C-01) ----
    // 既存のライブプレビュー挙動を変えないため、既存機能(Callouts以外は元々常時有効だった
    // ハイライト・上付き下付き)の既定値はすべてtrueにする。数式(第9項)はTypora準拠で
    // インライン数式・自動採番とも既定OFF。

    /// <summary>Callouts / GitHub式アラート(M-13)。</summary>
    public bool CalloutsEnabled { get; set; } = true;

    /// <summary>上付き文字・下付き文字(M-24・M-25)。</summary>
    public bool SuperSubscriptEnabled { get; set; } = true;

    /// <summary>ハイライト `==text==`(M-26)。</summary>
    public bool HighlightEnabled { get; set; } = true;

    /// <summary>インライン数式 `$...$`(M-23)。Typora準拠で既定OFF。</summary>
    public bool InlineMathEnabled { get; set; }

    /// <summary>数式の自動採番(C-04)。既定OFF。</summary>
    public bool MathAutoNumberEnabled { get; set; }

    /// <summary>"markdown" | "html"。既定のコピー形式(仕様書 第2.9.3節)。</summary>
    public string DefaultCopyFormat { get; set; } = "markdown";

    /// <summary>最近使ったファイル(仕様書 F-09)。先頭が最新。最大件数はRecentFilesService側で制御する。</summary>
    public List<string> RecentFiles { get; set; } = new();

    /// <summary>"system" | "light" | "dark"。手動でテーマを切り替えた場合に永続化する(仕様書 第10.2節)。</summary>
    public string Theme { get; set; } = "system";

    /// <summary>本文の文字サイズ(px)。Ctrl+マウスホイールでの変更を永続化する。</summary>
    public int EditorFontSize { get; set; } = 15;

    /// <summary>
    /// 最後に読み込んでいたフォルダのパス(仕様書 第2.8節、サイドバー用のセッション復元)。
    /// 実際に起動時へ反映する処理は後続ステップで実装する。ここではプロパティの保持のみ。
    /// </summary>
    public string? LastFolderPath { get; set; }

    // ---- 設定(Preferences)の残りの項目(仕様書 第2.10節 C-01〜C-14)。 ----
    // HTML製の設定画面(後続作業)からJSブリッジ経由で読み書きするための入れ物として、
    // ここではプロパティの保持のみを行う。実際の適用(エディタ描画への反映等)はJS側の担当。

    /// <summary>厳格モード。見出し・リスト記号の記法を制限する(仕様書 C-02)。既定OFF。</summary>
    public bool StrictMode { get; set; }

    /// <summary>コードブロックの行番号表示(仕様書 C-03)。既定ON。</summary>
    public bool CodeBlockLineNumbers { get; set; } = true;

    /// <summary>括弧・引用符の自動ペアリング(仕様書 C-05)。既定ON。</summary>
    public bool AutoPairing { get; set; } = true;

    /// <summary>ライトモード時に使うテーマ名(仕様書 C-06)。既定"default"。</summary>
    public string LightTheme { get; set; } = "default";

    /// <summary>ダークモード時に使うテーマ名(仕様書 C-06)。既定"default"。</summary>
    public string DarkTheme { get; set; } = "default";

    /// <summary>カスタムCSSファイルのパス(仕様書 C-07)。既定null(未指定)。</summary>
    public string? CustomCssPath { get; set; }

    /// <summary>本文フォント(仕様書 C-08)。既定null(テーマ既定のフォントを使う)。</summary>
    public string? EditorFontFamily { get; set; }

    /// <summary>文字数カウントの常時表示(仕様書 C-09)。既定ON。</summary>
    public bool ShowWordCount { get; set; } = true;

    /// <summary>
    /// コマンドID→ショートカット文字列のキーバインド上書き(仕様書 C-10)。
    /// 既定は空(=すべて既定のショートカットのまま)。
    /// </summary>
    public Dictionary<string, string> KeyBindings { get; set; } = new();

    /// <summary>既定の文字コード(仕様書 C-12)。既定"utf8"。</summary>
    public string DefaultEncoding { get; set; } = "utf8";

    /// <summary>既定の改行コード(仕様書 C-12)。既定"crlf"。</summary>
    public string DefaultLineEnding { get; set; } = "crlf";

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
}
