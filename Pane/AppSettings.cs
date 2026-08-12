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
}
