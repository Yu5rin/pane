using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pane;

/// <summary>
/// 設定画面専用の独立ウィンドウ。
///
/// これまで設定画面は本文と同じWebView2の中にHTMLのモーダルとして表示していたため、
/// 本体ウィンドウより大きく表示できなかった(ウィンドウを小さくして使っていると
/// 項目が見えない・スクロールが見にくい、という問題があった)。このクラスは
/// 本体ウィンドウ(<see cref="MainForm"/>)とは独立したWebView2を1つ持ち、
/// dist/settings-window.html(src/settings-entry.js)を読み込むことで、
/// 本体ウィンドウの大きさに関係なく設定画面を十分な大きさで表示できるようにする。
///
/// ブリッジのメッセージ(get-settings / save-settings / browse-path 等)は
/// <see cref="MainForm"/>と全く同じ内容を扱うため、実処理は<see cref="SettingsBridge"/>へ
/// 切り出してあり、ここでは受け口(WebMessageReceivedの振り分け)だけを持つ。
///
/// ライフサイクル: <see cref="PaneApplicationContext"/>が「同時に1つしか開かない」ことを
/// 保証する(既に開いていれば前面に出すだけ)。このウィンドウは
/// <see cref="PaneApplicationContext"/>のウィンドウ数の勘定(本体ウィンドウの終了判定)には
/// 含めない。そのため、
///   ・設定画面だけが開いている状態でも、それだけを理由にアプリが起動し続けることはない
///     (最後の本体ウィンドウが閉じてquitOnLastWindowClosed=trueなら、ExitThread前に
///     このウィンドウも明示的に閉じる。PaneApplicationContext.OnWindowClosed参照)。
///   ・quitOnLastWindowClosed=false またはプリロード常駐時に本体ウィンドウをすべて閉じても、
///     設定画面は取り残されず、そのまま開いた状態を維持する(アプリ自体がまだ生きているため)。
/// </summary>
internal sealed class SettingsWindow : Form
{
    private const string VirtualHostName = "pane.local";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly WebView2 _webView = new();
    /// <summary>設定の保存後、開いているすべての本体ウィンドウへ再配信するためのコールバック
    /// (<see cref="PaneApplicationContext.BroadcastSettingsChanged"/>)。MainFormの
    /// _requestBroadcastSettingsと同じ役割。</summary>
    private readonly Action _broadcastSettingsChanged;

    public SettingsWindow(Form owner, Action broadcastSettingsChanged)
    {
        _broadcastSettingsChanged = broadcastSettingsChanged;

        Text = "Pane の設定";
        MinimumSize = new Size(640, 480);
        Size = ComputeInitialSize(owner);
        StartPosition = FormStartPosition.Manual;
        Location = ComputeCenteredLocation(owner, Size);
        // 既定でリサイズ可能(FormBorderStyle.Sizableが既定値のため明示設定は不要)。
        try
        {
            Icon = new Icon(Path.Combine(AppContext.BaseDirectory, "Assets", "Pane.ico"));
        }
        catch
        {
            // 仮アイコンが見つからなくても起動は継続する(実行ファイル埋め込みアイコンが使われる)
        }

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);

        Load += OnLoadAsync;
        FormClosed += (_, _) => Logger.Write("SettingsWindow.FormClosed");
    }

    /// <summary>既定サイズ960x760。呼び出し元(owner)が表示されている画面より大きい場合は
    /// その画面の作業領域に収める。</summary>
    private static Size ComputeInitialSize(Form owner)
    {
        const int defaultWidth = 960;
        const int defaultHeight = 760;
        Rectangle area = ResolveWorkingArea(owner);
        int width = Math.Min(defaultWidth, area.Width);
        int height = Math.Min(defaultHeight, area.Height);
        return new Size(width, height);
    }

    /// <summary>呼び出し元ウィンドウの中央に配置する位置を求める。画面外にはみ出す場合は
    /// 画面の作業領域内に収める。ownerがまだハンドルを持たない(表示前)の場合は
    /// 画面中央にフォールバックする。</summary>
    private static Point ComputeCenteredLocation(Form owner, Size size)
    {
        Rectangle area = ResolveWorkingArea(owner);
        int centerX = owner.IsHandleCreated ? owner.Bounds.Left + owner.Bounds.Width / 2 : area.Left + area.Width / 2;
        int centerY = owner.IsHandleCreated ? owner.Bounds.Top + owner.Bounds.Height / 2 : area.Top + area.Height / 2;
        int x = centerX - size.Width / 2;
        int y = centerY - size.Height / 2;
        x = Math.Max(area.Left, Math.Min(x, area.Right - size.Width));
        y = Math.Max(area.Top, Math.Min(y, area.Bottom - size.Height));
        return new Point(x, y);
    }

    private static Rectangle ResolveWorkingArea(Form owner)
    {
        Screen screen = owner.IsHandleCreated ? Screen.FromControl(owner) : Screen.PrimaryScreen ?? Screen.AllScreens[0];
        return screen.WorkingArea;
    }

    /// <summary>
    /// ウィンドウのネイティブハンドルが生成された直後、ネイティブタイトルバーの配色を
    /// 現在の設定(テーマ)に合わせて塗る。MainForm.OnHandleCreatedと同じ作法。
    /// </summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        AppSettings settings = SettingsService.Load();
        bool isDark = MainForm.ResolveIsDarkTheme(settings.Theme);
        WindowChrome.ApplyTheme(Handle, isDark);
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        Logger.Write("SettingsWindow.OnLoadAsync開始");

        // WebView2環境はMainForm側で生成・キャッシュされたものを再利用する(プロセス全体で1つ)。
        CoreWebView2Environment env = await MainForm.EnsureEnvironmentAsync();
        await _webView.EnsureCoreWebView2Async(env);

        // ブラウザ既定のアクセラレータキー・ページズームの無効化はMainFormと同じ設定に揃える。
        // AreDefaultContextMenusEnabledはMainForm同様に触らない(既定のtrueのまま)。
        _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        string distPath = MainForm.ResolveDistPath();
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            VirtualHostName, distPath, CoreWebView2HostResourceAccessKind.Allow);
        _webView.CoreWebView2.Navigate($"https://{VirtualHostName}/settings-window.html");
        Logger.Write("SettingsWindow: Navigate呼び出し完了");
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
        JsonElement root = doc.RootElement;
        string type = root.TryGetProperty("type", out JsonElement typeProp) ? typeProp.GetString() ?? "" : "";
        Logger.Write($"[設定ウィンドウ] JSからのメッセージ受信: type={type}");

        switch (type)
        {
            case "get-settings":
                SettingsBridge.PostSettingsSnapshot(PostToWeb);
                break;
            case "save-settings":
                SettingsBridge.HandleSaveSettingsRequest(root, PostToWeb, _broadcastSettingsChanged);
                break;
            case "browse-path":
                SettingsBridge.HandleBrowsePathRequest(root, this, PostToWeb);
                break;
            case "open-settings-file":
                SettingsBridge.OpenSettingsFileInExplorer();
                break;
            case "reset-settings":
                SettingsBridge.HandleResetSettingsRequest(PostToWeb, _broadcastSettingsChanged);
                break;
            case "clear-recent-files":
                SettingsBridge.HandleClearRecentFilesRequest(_broadcastSettingsChanged);
                break;
            case "clear-per-file-modes":
                SettingsBridge.HandleClearPerFileModesRequest(_broadcastSettingsChanged);
                break;
            case "open-default-apps-settings":
                SettingsBridge.OpenDefaultAppsSettings();
                break;
            case "open-with-dialog":
                SettingsBridge.HandleOpenWithDialog(root, this);
                break;
            case "close-settings-window":
                // JS側(settings.js、page表示モード)がキャンセル・保存完了・Escape等で
                // 「閉じる」操作をしたときの受け口。このウィンドウ自身を閉じるだけで、
                // 本体ウィンドウ・アプリ全体には影響しない。
                Close();
                break;
            case "log":
                string level = root.TryGetProperty("level", out JsonElement levelProp) ? levelProp.GetString() ?? "log" : "log";
                string logMessage = root.TryGetProperty("message", out JsonElement msgProp) ? msgProp.GetString() ?? "" : "";
                Logger.Write($"[設定ウィンドウ JS:{level}] {logMessage}");
                break;
        }
    }

    private void PostToWeb(object message)
    {
        if (_webView.CoreWebView2 is null) return;
        string json = JsonSerializer.Serialize(message, JsonOptions);
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }
}
