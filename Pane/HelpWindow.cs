using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pane;

/// <summary>
/// 取扱説明書(F1)専用の独立ウィンドウ。
///
/// 作りは<see cref="SettingsWindow"/>を踏襲する(体感速度対策で同じ問題を再発させないため)。
/// WebView2で dist/help-window.html(src/help-entry.js)を表示する独立ウィンドウで、
/// 事前生成(<see cref="Prewarm"/>)による高速表示・<see cref="Reveal"/>での表示・3秒の
/// フォールバックタイマーという仕組みはSettingsWindowと全く同じ理由でここにも要る。
/// 特に<see cref="Prewarm"/>のコメントにある「CreateControl()だけではForm.Loadが発火せず、
/// 事前生成が名前だけになっていた」不具合と、<see cref="EnsureWebViewInitializedAsync"/>を
/// Prewarm/OnLoadAsync/Revealの3経路から共有している理由は、SettingsWindow.csの該当コメントを
/// そのまま踏襲している。
///
/// ただし設定画面と違い「読むだけ」のウィンドウのため、設定の保存・get-settings/save-settingsの
/// ようなブリッジ往復は一切持たない。C#→JSは開いた時点のテーマ("theme"メッセージ)を
/// 一度渡すだけで、JS→C#はinitial-render-ready・close-help-window・log・説明書内の外部リンクを
/// 既定ブラウザで開くopen-in-default-appの4種類のみを受け取る(設定画面のような右クリックの
/// 独自メニュー(NativeMenu連携)・入力欄のブリッジも持たない。読むだけのウィンドウで
/// 右クリックメニューを一切出さない代わりに、Ctrl+Cでの選択テキストのコピーは
/// ブラウザ既定の機能としてそのまま使える)。
///
/// ライフサイクルも<see cref="SettingsWindow"/>と同じ: <see cref="PaneApplicationContext"/>が
/// 同時に1つしか開かないことを保証し(既に開いていれば<see cref="WindowChrome.ForceActivate"/>で
/// 前面に出すだけ)、このウィンドウはPaneApplicationContextのウィンドウ数の勘定には含めない。
/// 閉じる操作(Escape・×ボタン)ではインスタンスを破棄せず非表示にするだけにし、次に開く時も
/// 同じインスタンス・同じWebView2を使い回す。アプリを本当に終了する時だけ
/// <see cref="CloseForReal"/>で破棄する。
/// </summary>
internal sealed class HelpWindow : Form
{
    private const string VirtualHostName = "pane.local";
    /// <summary>起動時の白フラッシュ対策(新方式)のフォールバック猶予。SettingsWindow/MainFormと
    /// 同じ値・同じ考え方。</summary>
    private const int WebViewRevealFallbackMs = 6000;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly WebView2 _webView = new();
    /// <summary>起動時の白フラッシュ対策(新方式)のフォールバックタイマー。SettingsWindowと同じ役割。</summary>
    private readonly System.Windows.Forms.Timer _webViewRevealFallbackTimer;
    private bool _webViewRevealed;
    /// <summary>各段階の所要時間をログに残すための計測開始点(このインスタンスが生成された瞬間)。</summary>
    private readonly Stopwatch _stopwatch = Stopwatch.StartNew();
    /// <summary>trueの間だけ<see cref="Close"/>が実際にウィンドウを破棄する。既定はfalseで、
    /// その間の「閉じる」操作は<see cref="OnFormClosing"/>が非表示化に読み替える
    /// (インスタンス再利用のため)。アプリ終了時は<see cref="CloseForReal"/>がこれをtrueにしてから
    /// Closeを呼ぶ。</summary>
    private bool _realCloseAllowed;

    /// <summary>WebView2環境の取得〜Navigate呼び出しまでを行う<see cref="InitializeWebViewCoreAsync"/>の
    /// Task。<see cref="Prewarm"/>・<see cref="OnLoadAsync"/>・<see cref="Reveal"/>のいずれから
    /// 呼ばれても、最初の呼び出しでこのフィールドにTaskを確定させ(<see cref="EnsureWebViewInitializedAsync"/>)、
    /// 以後の呼び出しは同じTaskを返すだけにして二重実行を防ぐ(SettingsWindowと同じ理由)。</summary>
    private Task? _initializeWebViewTask;
    private bool _webViewInitialized;

    /// <summary>初期描画(initial-render-ready受信 or フォールバック)が完了済みかどうか。
    /// <see cref="PaneApplicationContext.OpenHelpWindow"/>が事前生成の間に合い具合をログに残すために参照する。</summary>
    public bool IsRevealed => _webViewRevealed;

    public HelpWindow(Form? owner)
    {
        Logger.Write("HelpWindow: 生成開始");

        Text = "Pane 取扱説明書";
        MinimumSize = new Size(640, 480);
        Size = ComputeInitialSize(owner);
        StartPosition = FormStartPosition.Manual;
        Location = ComputeCenteredLocation(owner, Size);
        Icon? icon = AppIcon.Create();
        if (icon is not null) Icon = icon;

        // 起動時の白フラッシュ対策(SettingsWindowと同じ理由・同じ新方式)。
        AppSettings initialSettings = SettingsService.Load();
        bool initialIsDark = MainForm.ResolveIsDarkTheme(initialSettings.Theme);
        Color initialBackground = MainForm.ResolveThemeBackgroundColor(initialIsDark);
        BackColor = initialBackground;
        _webView.DefaultBackgroundColor = initialBackground;

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);

        // WebView2コントロール自体を"initial-render-ready"が届くまで非表示にする(SettingsWindowと同じ新方式)。
        _webView.Visible = false;
        Logger.Write("HelpWindow: WebView2を非表示で生成(initial-render-ready受信まで表示しない)");
        _webViewRevealFallbackTimer = new System.Windows.Forms.Timer { Interval = WebViewRevealFallbackMs };
        _webViewRevealFallbackTimer.Tick += (_, _) => RevealWebView(viaFallback: true);

        Load += OnLoadAsync;
        // 「閉じる」操作(Escape・×ボタン、JS側からのclose-help-windowメッセージ経由でCloseが
        // 呼ばれる、または×ボタン直接)ではインスタンスを破棄せず非表示にするだけにする
        // (体感速度対策: 次に開く時に同じWebView2・同じ読み込み済みページを使い回すため)。
        FormClosing += OnFormClosing;
        FormClosed += (_, _) =>
        {
            Logger.Write("HelpWindow.FormClosed(実破棄)");
            _webViewRevealFallbackTimer.Stop();
            _webViewRevealFallbackTimer.Dispose();
        };
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_realCloseAllowed) return; // アプリ終了時: 本当に閉じる(FormClosedまで進める)
        e.Cancel = true;
        Hide();
        Logger.Write("HelpWindow: 閉じる操作 -> 非表示化のみ(インスタンスは再利用のため破棄しない)");
    }

    /// <summary>アプリ終了時(<see cref="PaneApplicationContext.OnWindowClosed"/>)専用。
    /// 通常の<see cref="Close"/>は<see cref="OnFormClosing"/>が非表示化に読み替えてしまうため、
    /// 本当に破棄したい場合はこちらを呼ぶ。</summary>
    public void CloseForReal()
    {
        _realCloseAllowed = true;
        Close();
    }

    /// <summary>事前生成(裏読み込み)用。Show()を呼ばずにWebView2の初期化(環境取得〜Navigateまで)を
    /// 直接始める。<see cref="SettingsWindow.Prewarm"/>と全く同じ理由: CreateControl()だけでは
    /// Form.LoadイベントはShow()(正確にはSetVisibleCore経由の初回表示)でしか発火しないため、
    /// Loadイベントに頼らずここから直接<see cref="EnsureWebViewInitializedAsync"/>を呼ぶ。</summary>
    public void Prewarm()
    {
        Logger.Write("HelpWindow: 事前生成(Prewarm)開始 - Show()を待たずに初期化を始める");
        CreateControl(); // WebView2の初期化にはネイティブハンドルが必要なため、Show()を呼ばずに先に作る
        Logger.Write("HelpWindow: 事前生成で初期化を開始した");
        _ = EnsureWebViewInitializedAsync().ContinueWith(t =>
        {
            if (t.IsFaulted)
            {
                Logger.WriteException("HelpWindow: 事前生成での初期化に失敗(次にユーザーがF1を押した際、Reveal経由の保険が再試行する)", t.Exception!);
            }
            else
            {
                Logger.Write($"HelpWindow: 事前生成での初期化が完了した({_stopwatch.ElapsedMilliseconds}ms)");
            }
        });
    }

    /// <summary>ユーザーが実際にF1(または「?」ボタン・コマンドパレット)で取扱説明書を開いた時に呼ぶ。
    /// 既に表示中(前面へ出すだけのケース)ではActivateのみ(<see cref="SettingsWindow.Reveal"/>と同じ)。
    /// 実際に非表示状態から見せ直す場合だけ、呼び出し元(owner)に合わせて位置・サイズを計算し直し、
    /// その時点のテーマを送り直す(隠れている間に他ウィンドウでテーマが変わっている可能性があるため)。</summary>
    public void Reveal(Form? owner)
    {
        bool wasHidden = !Visible;
        if (wasHidden)
        {
            Size = ComputeInitialSize(owner);
            Location = ComputeCenteredLocation(owner, Size);
            if (_webView.CoreWebView2 is not null) PostCurrentTheme();
        }
        bool wasInitialized = _webViewInitialized;
        _ = EnsureWebViewInitializedAsync();
        Logger.Write($"HelpWindow: Reveal時点で初期化{(wasInitialized ? "済みだった" : "まだだった")}");

        if (!_webViewRevealed) _webViewRevealFallbackTimer.Start();

        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        // 既に開いていた場合に再度F1を押したときも、確実に前面へ出す(不具合修正: フォアグラウンド権を
        // 持たない状態からのActivate()だけでは前面化に失敗しうるため、Pane/WindowChrome.csの
        // 共通ヘルパーで確実な前面化を行う)。
        WindowChrome.ForceActivate(this);
        Logger.Write($"HelpWindow: Reveal (既存インスタンスを表示, wasHidden={wasHidden}, 読み込み完了済み={_webViewRevealed})");
    }

    /// <summary>MainForm.RevealWebView/SettingsWindow.RevealWebViewと同じ役割・同じ二重防御。</summary>
    private void RevealWebView(bool viaFallback)
    {
        if (_webViewRevealed) return;
        _webViewRevealed = true;
        _webViewRevealFallbackTimer.Stop();
        _webView.Visible = true;
        Logger.Write(viaFallback
            ? $"HelpWindow: WebView2を表示(フォールバック: {WebViewRevealFallbackMs}ms以内にinitial-render-readyが届かなかったため強制表示, 経過={_stopwatch.ElapsedMilliseconds}ms)"
            : "HelpWindow: WebView2を表示(JS側からinitial-render-ready受信)");
        Logger.Write($"HelpWindow: 表示 (合計 {_stopwatch.ElapsedMilliseconds}ms)");
    }

    /// <summary>既定サイズ960x760(設定ウィンドウと同じ)。呼び出し元(owner)が表示されている画面より
    /// 大きい場合はその画面の作業領域に収める。ownerがnullならプライマリスクリーンを基準にする。</summary>
    private static Size ComputeInitialSize(Form? owner)
    {
        const int defaultWidth = 960;
        const int defaultHeight = 760;
        Rectangle area = ResolveWorkingArea(owner);
        int width = Math.Min(defaultWidth, area.Width);
        int height = Math.Min(defaultHeight, area.Height);
        return new Size(width, height);
    }

    private static Point ComputeCenteredLocation(Form? owner, Size size)
    {
        Rectangle area = ResolveWorkingArea(owner);
        int centerX = owner is { IsHandleCreated: true } o1 ? o1.Bounds.Left + o1.Bounds.Width / 2 : area.Left + area.Width / 2;
        int centerY = owner is { IsHandleCreated: true } o2 ? o2.Bounds.Top + o2.Bounds.Height / 2 : area.Top + area.Height / 2;
        int x = centerX - size.Width / 2;
        int y = centerY - size.Height / 2;
        x = Math.Max(area.Left, Math.Min(x, area.Right - size.Width));
        y = Math.Max(area.Top, Math.Min(y, area.Bottom - size.Height));
        return new Point(x, y);
    }

    private static Rectangle ResolveWorkingArea(Form? owner)
    {
        Screen screen = owner is { IsHandleCreated: true } o ? Screen.FromControl(o) : Screen.PrimaryScreen ?? Screen.AllScreens[0];
        return screen.WorkingArea;
    }

    /// <summary>ウィンドウのネイティブハンドルが生成された直後、ネイティブタイトルバーの配色を
    /// 現在の設定(テーマ)に合わせて塗る。MainForm/SettingsWindowと同じ作法。</summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        AppSettings settings = SettingsService.Load();
        bool isDark = MainForm.ResolveIsDarkTheme(settings.Theme);
        WindowChrome.ApplyTheme(this, isDark);
    }

    private void OnLoadAsync(object? sender, EventArgs e)
    {
        bool alreadyStarted = _initializeWebViewTask is not null;
        Logger.Write($"HelpWindow.OnLoadAsync開始 (事前生成{(alreadyStarted ? "が先に初期化を始めていた" : "はまだ始まっていなかった → ここから初期化する")})");
        _ = EnsureWebViewInitializedAsync().ContinueWith(
            t => Logger.WriteException("HelpWindow: OnLoadAsync経由の初期化に失敗", t.Exception!),
            TaskContinuationOptions.OnlyOnFaulted);
    }

    private Task EnsureWebViewInitializedAsync() => _initializeWebViewTask ??= InitializeWebViewCoreAsync();

    /// <summary>WebView2環境の取得〜Navigate呼び出しまでの本体。SettingsWindow.InitializeWebViewCoreAsyncと
    /// 同じ構成。直接は呼ばず、必ず<see cref="EnsureWebViewInitializedAsync"/>経由で呼ぶこと。</summary>
    private async Task InitializeWebViewCoreAsync()
    {
        // WebView2環境はMainForm側で生成・キャッシュされたものを再利用する(プロセス全体で1つ)。
        CoreWebView2Environment env = await MainForm.EnsureEnvironmentAsync();
        await _webView.EnsureCoreWebView2Async(env);
        Logger.Write($"HelpWindow: WebView2初期化完了 ({_stopwatch.ElapsedMilliseconds}ms)");

        // ブラウザ既定のアクセラレータキー・ページズームの無効化はMainForm/SettingsWindowと同じ設定に揃える
        // (F1自体もブラウザ既定のアクセラレータキー扱いのため、これでブラウザ既定のヘルプ動作は起きない)。
        _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
        // ブラウザ既定の右クリックメニューを一切表示しない(docs/コンテキストメニュー仕様.md 大原則1)。
        // 読むだけのウィンドウのため独自メニューは実装しない(JS側でcontextmenuをpreventDefaultするのみ)。
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        // ブラウザ標準のスクリプトダイアログ(alert/confirm/prompt/beforeunload)を出さない。
        // Paneのデザインと無関係な標準ダイアログが出るのを防ぐ(MainFormと同じ理由)。
        _webView.CoreWebView2.Settings.AreDefaultScriptDialogsEnabled = false;
        // タッチ/プレシジョンタッチパッドの2本指ピンチズームを無効化する。IsZoomControlEnabled=false
        // だけでは塞がらず(公式に「has no effect on the existing browser zoom properties」と明記)、
        // 説明書本文がクリップされてスクロールバーでも到達できない領域が生まれるため。
        _webView.CoreWebView2.Settings.IsPinchZoomEnabled = false;
        // リンクにマウスを乗せたときのChromium標準のURLチップ(左下)を出さない。このウィンドウは
        // 本文に実際の<a href>を多数含むため、特に目立つ。
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        // Chromium標準のオートフィル候補を出さない(読むだけのウィンドウだが、設定を3ウィンドウで
        // 揃えておく。入力内容をブラウザプロファイルへ保存しない方針も同じ)。
        _webView.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        // 外部リンクをPane内のポップアップで開かせず、OSの既定ブラウザへ委譲する
        // (処理の中身と判断の理由は3ウィンドウ共通のExternalLinkServiceを参照)。
        // このウィンドウは本文に実際の<a href>を多数含む。左クリックはJS側(src/help-entry.js
        // wireArticleLinks)がpreventDefaultして"open-in-default-app"で送ってくるが、
        // 中クリック・Ctrl+クリックはJS側を経由せずWebView2がそのまま新しいウィンドウを
        // 開こうとするため、C#側のこの受け口が無いとPane内にポップアップが開いてしまう。
        _webView.CoreWebView2.NewWindowRequested += (_, e) =>
            ExternalLinkService.HandleNewWindowRequested(e, "[取扱説明書ウィンドウ] ");

        // 起動時の白フラッシュ対策の3層目(MainForm/SettingsWindowと同じ、多層防御のうちの1つ)。
        AppSettings navigateSettings = SettingsService.Load();
        bool navigateIsDark = MainForm.ResolveIsDarkTheme(navigateSettings.Theme);
        string initialThemeAttr = navigateIsDark ? "dark" : "light";
        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
            $"document.documentElement.dataset.theme = '{initialThemeAttr}';");

        string distPath = MainForm.ResolveDistPath();
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            VirtualHostName, distPath, CoreWebView2HostResourceAccessKind.Allow);
        _webView.CoreWebView2.Navigate($"https://{VirtualHostName}/help-window.html");
        Logger.Write($"HelpWindow: Navigate呼び出し ({_stopwatch.ElapsedMilliseconds}ms)");

        _webViewInitialized = true;
    }

    /// <summary>現在の設定からテーマを解決してJSへ送る。get-settings/save-settingsのような往復は無く、
    /// C#側から一方的に渡すだけ(このウィンドウは「読むだけ」で設定を変更しないため)。</summary>
    private void PostCurrentTheme()
    {
        AppSettings settings = SettingsService.Load();
        PostToWeb(new
        {
            type = "theme",
            theme = settings.Theme,
            lightTheme = settings.LightTheme,
            darkTheme = settings.DarkTheme,
        });
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
        JsonElement root = doc.RootElement;
        string type = root.TryGetProperty("type", out JsonElement typeProp) ? typeProp.GetString() ?? "" : "";
        // "log" は内容が直後に別の行として出るため、タイプ名の記録は完全に重複する。
        if (type == "log") Logger.Debug($"[取扱説明書ウィンドウ] JSからのメッセージ受信: type={type}");
        else Logger.Write($"[取扱説明書ウィンドウ] JSからのメッセージ受信: type={type}");

        switch (type)
        {
            case "initial-render-ready":
                // 起動時の白フラッシュ対策(新方式)の本体。JS側(src/help-entry.js)が説明書の
                // 読み込み・変換・初期描画を終えた時点で送ってくる。このタイミングで初めて
                // 現在のテーマを送る(Navigate直後のscript注入で仮のdata-theme属性は
                // 付いているが、lightTheme/darkThemeプリセットの反映はこの往復で行う)。
                Logger.Write($"HelpWindow: initial-render-ready受信 ({_stopwatch.ElapsedMilliseconds}ms)");
                PostCurrentTheme();
                RevealWebView(viaFallback: false);
                break;
            case "open-in-default-app":
                // 説明書本文中の外部リンク(http/https)をOSの既定ブラウザで開く。
                // 右クリックメニュー「画像を開く」等と同じ経路(FolderService.OpenInDefaultApp、
                // Process.Start+UseShellExecute=trueのためURLでも開ける)を再利用する。
                if (TryGetString(root, "path", out string openDefaultPath))
                {
                    FolderService.OpenInDefaultApp(openDefaultPath);
                }
                break;
            case "close-help-window":
                // JS側(help-entry.js)がEscape等で「閉じる」操作をしたときの受け口。
                // このウィンドウ自身を閉じるだけで、本体ウィンドウ・アプリ全体には影響しない。
                Close();
                break;
            case "log":
                string level = root.TryGetProperty("level", out JsonElement levelProp) ? levelProp.GetString() ?? "log" : "log";
                string logMessage = root.TryGetProperty("message", out JsonElement msgProp) ? msgProp.GetString() ?? "" : "";
                Logger.WriteFromWeb("取扱説明書ウィンドウ JS", level, logMessage);
                break;
        }
    }

    private static bool TryGetString(JsonElement root, string propertyName, out string value)
    {
        if (root.TryGetProperty(propertyName, out JsonElement prop) && prop.ValueKind == JsonValueKind.String)
        {
            value = prop.GetString() ?? "";
            return true;
        }
        value = "";
        return false;
    }

    private void PostToWeb(object message)
    {
        if (_webView.CoreWebView2 is null) return;
        string json = JsonSerializer.Serialize(message, JsonOptions);
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }
}
