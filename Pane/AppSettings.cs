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

    /// <summary>既定のMarkdownエディタとしてファイル関連付け登録済みか(仕様書 N-09 / 第7.1節)。</summary>
    public bool FileAssociationEnabled { get; set; }

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
}
