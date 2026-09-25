using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pane;

/// <summary>
/// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)の専用ウィンドウ。
/// WebView2で dist/css-editor-window.html(src/css-editor-entry.js)を表示する。
/// 設定画面の外観 > カスタムCSS の「CSSを作る…」から開く。
///
/// 作りは<see cref="HelpWindow"/>を踏襲する(WebView2環境の共有・白フラッシュ対策・
/// ブラウザ既定機能の無効化・評判チェックの停止・遷移の保険)。違いは次の2点。
///
/// ・事前生成しない。めったに開かない道具で、先に用意するとWebView2の描画プロセス1つ分
///   (実機で約90MB)を常に抱えることになるため(仕様書 第8.4節)。開いたときに作る。
/// ・閉じたら破棄する(非表示にして使い回さない)。同じ理由で、使い終わったら描画プロセスを
///   手放す。保存していない変更があるときは、閉じる前に画面側で確認する
///   (<see cref="OnFormClosing"/>)。
///
/// 保存の流れ: 画面側が "css-editor-save" でCSSを送る → 開いたときに決めた保存先
/// (<see cref="CssEditorSaveLogic"/>)へ書く → 設定のカスタムCSSにそのファイルを指定する →
/// <see cref="_onSaved"/>で開いている全ウィンドウへ反映し、設定画面の入力欄も合わせる。
/// </summary>
internal sealed class CssEditorWindow : Form
{
    private const string VirtualHostName = "pane.local";
    private const int WebViewRevealFallbackMs = 6000;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly WebView2 _webView = new();
    private readonly System.Windows.Forms.Timer _webViewRevealFallbackTimer;
    private readonly Stopwatch _stopwatch = Stopwatch.StartNew();
    /// <summary>保存したあとに呼ぶ(引数は保存したファイルのパス)。全ウィンドウへの反映と、
    /// 設定画面の入力欄の更新は呼び出し元(<see cref="PaneApplicationContext"/>)が行う。</summary>
    private readonly Action<string> _onSaved;
    private bool _webViewRevealed;
    /// <summary>画面側から届く「保存していない変更があるか」。閉じる前の確認に使う。</summary>
    private bool _dirty;
    /// <summary>画面側で「閉じてよい」と確かめたあとの Close。確認をもう一度出さないための印。</summary>
    private bool _closeConfirmed;
    /// <summary>開いたときに決めた保存先。保存のたびに決め直さない(開いている間に設定が
    /// 変わっても、画面に出している保存先へ書くため)。</summary>
    private string _targetPath = "";

    public CssEditorWindow(Form? owner, Action<string> onSaved)
    {
        Logger.Write("CssEditorWindow: 生成開始");
        _onSaved = onSaved;

        Text = "Pane - カスタムCSSを作る";
        MinimumSize = new Size(800, 520);
        Size = ComputeInitialSize(owner);
        StartPosition = FormStartPosition.Manual;
        Location = ComputeCenteredLocation(owner, Size);
        Icon? icon = AppIcon.Create();
        if (icon is not null) Icon = icon;

        AppSettings initialSettings = SettingsService.Load();
        bool initialIsDark = MainForm.ResolveIsDarkTheme(initialSettings.Theme);
        Color initialBackground = MainForm.ResolveThemeBackgroundColor(initialIsDark);
        BackColor = initialBackground;
        _webView.DefaultBackgroundColor = initialBackground;

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);
        _webView.Visible = false;
        _webViewRevealFallbackTimer = new System.Windows.Forms.Timer { Interval = WebViewRevealFallbackMs };
        _webViewRevealFallbackTimer.Tick += (_, _) => RevealWebView(viaFallback: true);

        Load += (_, _) => _ = InitializeWebViewAsync().ContinueWith(
            t => Logger.WriteException("CssEditorWindow: WebView2の初期化に失敗", t.Exception!),
            TaskContinuationOptions.OnlyOnFaulted);
        FormClosing += OnFormClosing;
        FormClosed += (_, _) =>
        {
            Logger.Write("CssEditorWindow.FormClosed");
            _webViewRevealFallbackTimer.Stop();
            _webViewRevealFallbackTimer.Dispose();
        };
    }

    /// <summary>表示する(既に開いていれば前面に出すだけ)。</summary>
    public void Reveal()
    {
        if (!_webViewRevealed) _webViewRevealFallbackTimer.Start();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        WindowChrome.ForceActivate(this);
    }

    /// <summary>保存していない変更があれば、閉じずに画面側へ確認を頼む。画面側が
    /// "close-css-editor-window" を送り返してきたら閉じる。アプリ終了・更新のための終了
    /// (<see cref="CloseReason.ApplicationExitCall"/>等)では確認しない。</summary>
    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_dirty || _closeConfirmed || e.CloseReason != CloseReason.UserClosing) return;
        if (_webView.CoreWebView2 is null) return;
        e.Cancel = true;
        PostToWeb(new { type = "confirm-close" });
        Logger.Write("CssEditorWindow: 保存していない変更があるため、閉じる前に画面側で確認する");
    }

    private void RevealWebView(bool viaFallback)
    {
        if (_webViewRevealed) return;
        _webViewRevealed = true;
        _webViewRevealFallbackTimer.Stop();
        _webView.Visible = true;
        Logger.Write(viaFallback
            ? $"CssEditorWindow: WebView2を表示(フォールバック, 経過={_stopwatch.ElapsedMilliseconds}ms)"
            : $"CssEditorWindow: WebView2を表示(initial-render-ready受信, 経過={_stopwatch.ElapsedMilliseconds}ms)");
    }

    /// <summary>既定サイズ1200x800。見本と編集欄を横に並べるため設定画面より広くとる。
    /// 画面より大きければ作業領域に収める。</summary>
    private static Size ComputeInitialSize(Form? owner)
    {
        Rectangle area = ResolveWorkingArea(owner);
        return new Size(Math.Min(1200, area.Width), Math.Min(800, area.Height));
    }

    private static Point ComputeCenteredLocation(Form? owner, Size size)
    {
        Rectangle area = ResolveWorkingArea(owner);
        int centerX = owner is { IsHandleCreated: true } o1 ? o1.Bounds.Left + o1.Bounds.Width / 2 : area.Left + area.Width / 2;
        int centerY = owner is { IsHandleCreated: true } o2 ? o2.Bounds.Top + o2.Bounds.Height / 2 : area.Top + area.Height / 2;
        int x = Math.Max(area.Left, Math.Min(centerX - size.Width / 2, area.Right - size.Width));
        int y = Math.Max(area.Top, Math.Min(centerY - size.Height / 2, area.Bottom - size.Height));
        return new Point(x, y);
    }

    private static Rectangle ResolveWorkingArea(Form? owner)
    {
        Screen screen = owner is { IsHandleCreated: true } o ? Screen.FromControl(o) : Screen.PrimaryScreen ?? Screen.AllScreens[0];
        return screen.WorkingArea;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        AppSettings settings = SettingsService.Load();
        WindowChrome.ApplyTheme(this, MainForm.ResolveIsDarkTheme(settings.Theme));
    }

    private async Task InitializeWebViewAsync()
    {
        // WebView2環境はプロセス全体で1つ(仕様書 第8.1節)。MainFormが作ったものを使う。
        CoreWebView2Environment env = await MainForm.EnsureEnvironmentAsync();
        await _webView.EnsureCoreWebView2Async(env);
        Logger.Write($"CssEditorWindow: WebView2初期化完了 ({_stopwatch.ElapsedMilliseconds}ms)");

        // ブラウザ既定の機能は、他の3ウィンドウと同じく止める(理由はHelpWindowの同じ箇所)。
        CoreWebView2Settings s = _webView.CoreWebView2.Settings;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsZoomControlEnabled = false;
        s.AreDefaultContextMenusEnabled = false;
        s.AreDefaultScriptDialogsEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        // SmartScreen(URLの評判チェック)を止める。1つのウィンドウでも漏らすと全体で有効に
        // 戻るため、ここも必ず呼ぶ(仕様書 第8.3節、理由はWebViewReputationCheck)。
        WebViewReputationCheck.Disable(_webView.CoreWebView2, "カスタムCSSの作成補助");
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        _webView.CoreWebView2.NewWindowRequested += (_, e) =>
            ExternalLinkService.HandleNewWindowRequested(e, "[カスタムCSSの作成補助] ");
        _webView.CoreWebView2.NavigationStarting += (_, e) =>
        {
            if (NavigationGuard.IsAllowedTopLevelNavigation(e.Uri, VirtualHostName)) return;
            e.Cancel = true;
            Logger.Write($"[カスタムCSSの作成補助] NavigationStarting: 想定外の遷移先のため中止: {PrivacyLogFormatter.ShortenUri(e.Uri)}");
        };

        AppSettings settings = SettingsService.Load();
        string initialThemeAttr = MainForm.ResolveIsDarkTheme(settings.Theme) ? "dark" : "light";
        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
            $"document.documentElement.dataset.theme = '{initialThemeAttr}';");

        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            VirtualHostName, MainForm.ResolveDistPath(), CoreWebView2HostResourceAccessKind.Allow);
        _webView.CoreWebView2.Navigate($"https://{VirtualHostName}/css-editor-window.html");
        Logger.Write($"CssEditorWindow: Navigate呼び出し ({_stopwatch.ElapsedMilliseconds}ms)");
    }

    /// <summary>編集を始める内容を画面へ送る。設定のカスタムCSSにファイルがあればその中身、
    /// 無ければ雛形(画面側が持つ)。保存先もここで決めて画面に見せる。</summary>
    private void PostInit()
    {
        AppSettings settings = SettingsService.Load();
        string? current = settings.CustomCssPath;
        string css = MainForm.ReadCustomCss(current);
        string source = string.IsNullOrWhiteSpace(current) || css.Length == 0
            ? "template"
            : CssEditorSaveLogic.IsSampleFile(current) ? "sample" : "file";
        _targetPath = CssEditorSaveLogic.DecideSavePath(current, ThemeFolderService.FolderPath, File.Exists);
        Logger.Write($"CssEditorWindow: 編集の開始(元={source}, 保存先={PrivacyLogFormatter.ShortenPath(_targetPath)})");
        PostToWeb(new
        {
            type = "css-editor-init",
            css,
            source,
            sourcePath = current ?? "",
            targetPath = _targetPath,
            targetExists = File.Exists(_targetPath),
            theme = settings.Theme,
            lightTheme = settings.LightTheme,
            darkTheme = settings.UseSeparateThemeInDarkMode ? settings.DarkTheme : settings.LightTheme,
        });
    }

    private void HandleSave(JsonElement root)
    {
        string css = root.TryGetProperty("css", out JsonElement cssProp) && cssProp.ValueKind == JsonValueKind.String
            ? cssProp.GetString() ?? ""
            : "";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_targetPath)!);
            // BOM無しUTF-8(sample.cssと同じ)。読み込み側(MainForm.ReadCustomCss)はどちらでも読める。
            File.WriteAllText(_targetPath, css, new UTF8Encoding(false));
            SettingsService.Update(s => s.CustomCssPath = _targetPath);
            Logger.Write($"CssEditorWindow: 保存した({css.Length}文字, {PrivacyLogFormatter.ShortenPath(_targetPath)})");
            _dirty = false;
            PostToWeb(new { type = "css-editor-saved", ok = true, targetPath = _targetPath });
            _onSaved(_targetPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Logger.WriteException($"CssEditorWindow: 保存に失敗: {PrivacyLogFormatter.ShortenPath(_targetPath)}", ex);
            PostToWeb(new { type = "css-editor-saved", ok = false, message = ExceptionMessages.Describe(ex) });
        }
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
        JsonElement root = doc.RootElement;
        string type = root.TryGetProperty("type", out JsonElement typeProp) ? typeProp.GetString() ?? "" : "";
        if (type == "log") Logger.Debug($"[カスタムCSSの作成補助] JSからのメッセージ受信: type={type}");
        else Logger.Write($"[カスタムCSSの作成補助] JSからのメッセージ受信: type={type}");

        switch (type)
        {
            case "initial-render-ready":
                PostInit();
                RevealWebView(viaFallback: false);
                break;
            case "css-editor-save":
                HandleSave(root);
                break;
            case "css-editor-dirty":
                _dirty = root.TryGetProperty("value", out JsonElement dirtyProp) && dirtyProp.ValueKind == JsonValueKind.True;
                break;
            case "open-theme-folder":
                SettingsBridge.OpenThemeFolderInExplorer();
                break;
            case "close-css-editor-window":
                // 画面側で確認を済ませた(または変更が無い)。確認をもう一度出さずに閉じる。
                _closeConfirmed = true;
                Close();
                break;
            case "open-context-menu":
                // 入力欄とCSSの編集欄の右クリックメニュー(切り取り・コピー・貼り付け等)。
                // ブラウザ既定のメニューは画面側で止めているため、代わりにこれを出す。
                HandleOpenContextMenuRequest(root);
                break;
            case "log":
                string level = root.TryGetProperty("level", out JsonElement levelProp) ? levelProp.GetString() ?? "log" : "log";
                string logMessage = root.TryGetProperty("message", out JsonElement msgProp) ? msgProp.GetString() ?? "" : "";
                Logger.WriteFromWeb("カスタムCSSの作成補助 JS", level, logMessage);
                break;
        }
    }

    /// <summary>{ type: "open-context-menu", x, y, items } を受け取り、クリック位置にネイティブの
    /// メニューを出す。座標変換・NativeMenuの使い方は<see cref="SettingsWindow"/>の同名メソッドと同じ。</summary>
    private void HandleOpenContextMenuRequest(JsonElement root)
    {
        double cssX = root.TryGetProperty("x", out JsonElement xProp) && xProp.ValueKind == JsonValueKind.Number ? xProp.GetDouble() : 0;
        double cssY = root.TryGetProperty("y", out JsonElement yProp) && yProp.ValueKind == JsonValueKind.Number ? yProp.GetDouble() : 0;
        List<NativeMenu.MenuItemData> items = root.TryGetProperty("items", out JsonElement itemsProp) && itemsProp.ValueKind == JsonValueKind.Array
            ? SettingsWindow.ParseMenuItems(itemsProp)
            : new List<NativeMenu.MenuItemData>();

        double dpiScale = DeviceDpi / 96.0;
        var clientPoint = new Point((int)Math.Round(cssX * dpiScale), (int)Math.Round(cssY * dpiScale));
        Point screenPoint = _webView.PointToScreen(clientPoint);

        AppSettings settings = SettingsService.Load();
        bool isDark = MainForm.ResolveIsDarkTheme(settings.Theme);
        string themeId = MainForm.ResolveThemeId(settings, isDark);
        NativeMenu.Show(
            screenPoint,
            isDark,
            themeId,
            items,
            onCommand: id => PostToWeb(new { type = "menu-command", id }),
            onClosed: () => PostToWeb(new { type = "menu-closed", menu = "__context__" }));
    }

    private void PostToWeb(object message)
    {
        if (_webView.CoreWebView2 is null) return;
        _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
    }
}
