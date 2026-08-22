using System.Diagnostics;
using System.Text;

namespace Pane;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // 実機での不具合調査用ログ(%LOCALAPPDATA%\Pane\logs\)。ハンドルされない例外を
        // JITデバッグダイアログだけでなくログにも残し、後から原因を追いやすくする。
        // Logger.Errorは書き込みを後回しにせずその場で出し切るため、直後にプロセスが
        // 落ちても記録が残る(Logger参照)。
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            Logger.Error($"未処理例外(AppDomain): {e.ExceptionObject}");
            Logger.Shutdown();
        };
        Application.ThreadException += (_, e) =>
            Logger.WriteException("未処理例外(UIスレッド)", e.Exception);
        // 自分の起動行を書く前に、前回の起動で警告・エラーが出ていなかったかを読み返す
        // (書いた後だと集計範囲が自分自身になってしまう。StartupLogReview参照)。
        StartupLogReview.ReviewPreviousRun();
        Logger.Write($"=== Pane起動 args=[{string.Join(",", args)}] ===");
        LogProcessStartToMainElapsed();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        // Shift_JIS(コードページ932)等のANSI系エンコーディングを使えるようにする。
        // .NET (Core以降) は既定でこれらのコードページを同梱していないため必須。
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        ApplyWebView2DefaultBackgroundColorEnvironmentVariable();
        ApplyVerboseLoggingSetting();

        // コマンドライン引数でのファイル・フォルダ指定(仕様書 N-25 / F-14):
        // Pane.exe <file> / Pane.exe <folder> 。フォルダかどうかの判定は実際に開く段階
        // (PaneApplicationContext.OpenWindow)でDirectory.Existsにより行うため、ここでは
        // ファイルパスかフォルダパスかを区別せずそのまま渡す。
        // "--preload"(B-1: スタートアップ登録から起動されるプリロード常駐フラグ)は
        // ファイルパスではなくフラグとして別扱いにし、それ以外の最初の引数をファイル/フォルダの
        // パスとして扱う。
        bool preload = false;
        string? initialPath = null;
        foreach (string arg in args)
        {
            if (string.Equals(arg, "--preload", StringComparison.OrdinalIgnoreCase))
            {
                preload = true;
            }
            else if (initialPath is null)
            {
                initialPath = arg;
            }
        }

        // 多重起動制御(仕様書 第8.1節): 名前付きMutexで既存プロセスの有無を判定する。
        // 既に起動中なら、名前付きパイプでファイルパスを渡して新規ウィンドウを頼み、
        // 自分自身はWebView2を含むUIを一切起動せずに即終了する
        // (第8.4節「既存プロセスへのファイルオープン: 300ms以内」・「WebView2プロセスを増やさない」)。
        using var mutex = new Mutex(initiallyOwned: true, SingleInstance.MutexName, out bool createdNew);
        if (!createdNew)
        {
            if (preload)
            {
                // 既に他プロセスが起動済み(ユーザーが手動で起動済み、または既にpreload常駐中)
                // なら、ログオン時のスタートアップ起動としてこれ以上何もする必要は無い。
                // パイプ経由で新規ウィンドウを頼んでしまうと、ユーザーが見ていないログオン
                // 直後に空のウィンドウが出てしまうため、何も送らずに終了する。
                Logger.Write("--preload起動だが既存プロセスが起動済みのため、何もせず終了する");
                return;
            }
            if (SingleInstance.TrySendToExistingInstance(initialPath))
            {
                return;
            }
            // 既存プロセスが応答しなかった(クラッシュ後の残留Mutex等)場合は、
            // 自プロセスとして通常どおり起動を続行する。
        }

        ApplicationConfiguration.Initialize();

        // preload起動時はPaneApplicationContextがウィンドウを1枚も作らないまま待機し続けるため、
        // フォーム生成をトリガーに自動インストールされるWindowsFormsSynchronizationContextが
        // いつまで経ってもインストールされない可能性がある。SingleInstanceServerがUIスレッドへ
        // 安全にPostできるよう、フォームの有無に関わらずここで明示的にインストールしておく
        // (通常起動時に先に済ませておいても副作用は無い)。
        // WindowsFormsSynchronizationContext.InstallIfNeeded()相当はassembly内部限定公開のため
        // 直接呼べず、同じ効果をSetSynchronizationContextで自前実装する。
        if (SynchronizationContext.Current is not WindowsFormsSynchronizationContext)
        {
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
        }

        // 前回の更新で退避した古いファイル(Pane.exe.pane-old / dist.pane-old)を片付ける。
        // 起動時間に影響させないためバックグラウンドで行う(dist.pane-oldの再帰削除は
        // 数十MB分になることがある)。失敗しても次回の起動でまた試す(UpdateService参照)。
        Task.Run(UpdateService.CleanupLeftovers);

        var context = new PaneApplicationContext(initialPath, preload);

        var server = new SingleInstanceServer(SynchronizationContext.Current!);
        server.FileRequested += path => context.OpenWindowFromPipeRequest(path);
        server.Start();

        Application.Run(context);

        server.Stop();

        // 書き残しを出し切ってから終わる(Loggerのワーカーはバックグラウンドスレッドのため、
        // これが無いと終了直前の数百ms分のログが失われる)。
        Logger.Shutdown();
    }

    /// <summary>
    /// 設定「詳細ログを記録する」をLoggerへ反映する。
    ///
    /// 設定ファイルの読み込みより前に出るログ(=このメソッドより上の行)は必ずInfo以上のため、
    /// ここより前の記録が詳細ログ設定によって欠けることはない。
    /// </summary>
    private static void ApplyVerboseLoggingSetting()
    {
        try
        {
            Logger.SetVerbose(SettingsService.Load().VerboseLogging);
        }
        catch (Exception ex)
        {
            // 設定が読めなくても既定(Info以上)のまま起動を続ける。
            Logger.WriteException("詳細ログ設定の読み込みに失敗", ex);
        }
    }

    /// <summary>
    /// [計測] OSがこのプロセスを起こした時刻(<see cref="Process.StartTime"/>)から
    /// <see cref="Main"/>の先頭に到達するまでの経過時間をログへ残す。
    ///
    /// 実機で「初回起動だけ、MainForm生成からWebView2生成までの間に約8.7秒かかる」現象を
    /// 追うために追加した(同じプロセス内の2枚目のウィンドウでは同区間が0msのため、
    /// コードではなくプロセス初回だけの外的コストと分かっている)。この区間は今まで
    /// まったく計測されておらず、単一ファイル(single-file)の展開・.NETランタイムの起動・
    /// アセンブリの読み込みにどれだけかかっているのかが実機ログから分からなかった。
    ///
    /// ここが大きければ原因は起動時の展開・ランタイム側、小さければ原因はMain到達後
    /// (=MainForm構築中の[計測]行を見る)と切り分けられる。取得に失敗しても起動は続行する。
    /// </summary>
    private static void LogProcessStartToMainElapsed()
    {
        try
        {
            using Process process = Process.GetCurrentProcess();
            DateTime startTime = process.StartTime;
            double elapsedMs = (DateTime.Now - startTime).TotalMilliseconds;
            Logger.Write($"[計測] プロセス開始→Main到達: {elapsedMs:F0}ms (プロセス開始={startTime:HH:mm:ss.fff})");
        }
        catch (Exception ex)
        {
            // StartTimeは権限やプロセスの状態によっては取得できないことがある。
            // 計測できないだけで起動には影響しないため、記録して続行する。
            Logger.WriteException("[計測] プロセス開始時刻を取得できなかった", ex);
        }
    }

    /// <summary>
    /// 起動時の白フラッシュ対策(公式ドキュメントが既知不具合として挙げている回避策)。
    ///
    /// CoreWebView2Controller.DefaultBackgroundColorの公式ドキュメントには
    /// 「There is a known issue with background color where just setting the color by property can
    /// still leave the app with a white flicker before the DefaultBackgroundColor property takes
    /// effect. Setting the color via environment variable solves this issue.」と明記されている。
    /// すなわちプロパティ設定(MainForm.ApplyInitialWebViewBackground等)だけでは白のちらつきが
    /// 残りうるため、環境変数WEBVIEW2_DEFAULT_BACKGROUND_COLORでも同じ色を渡す。
    ///
    /// 呼ぶ位置: CoreWebView2Environment.CreateAsync(MainForm.EnsureEnvironmentAsync)より前で
    /// なければ効かないため、Main冒頭のここで設定する。
    ///
    /// 値の形式: 0xAARRGGBB。公式ドキュメントの「The value must be a hex value that can optionally
    /// prepend a 0x. The value must account for the alpha value which is represented by the first
    /// 2 digits.」に従い、先頭2桁のアルファ(不透明=FF)を必ず含める。
    /// 色そのものはMainForm.ResolveInitialThemeBackgroundColor(=ResolveThemeBackgroundColor)から
    /// 取るため、WinForms側のBackColor/DefaultBackgroundColorと必ず同じ色になる(色の値をここに
    /// 書き写さない。二重管理を避けるため)。
    ///
    /// 重要(方針): 既存の「WebView2をVisible=falseで生成し、JSからのinitial-render-ready受信または
    /// フォールバックタイマーで表示する」機構(MainForm/SettingsWindow/HelpWindow)は撤去しない。
    /// あちらは実機で白フラッシュが直らなかった末に採用された機構であり、いま実機で効いている
    /// 可能性がある。環境変数と同時に外すと、白フラッシュが再発したときにどちらが原因か切り分け
    /// できなくなるため、この環境変数は「足すだけ」にとどめる。
    ///
    /// 起動後のテーマ切替については、公式ドキュメントのとおり環境変数は一度設定したら以降は
    /// プロパティ側で変更する必要がある。Paneではテーマ変更時のDefaultBackgroundColor設定が
    /// 既にその役目を担っているため、ここでの追加対応は不要(起動時の1回だけ効けばよい)。
    /// </summary>
    private static void ApplyWebView2DefaultBackgroundColorEnvironmentVariable()
    {
        try
        {
            Color background = MainForm.ResolveInitialThemeBackgroundColor(out bool isDark);
            string value = $"0xFF{background.R:X2}{background.G:X2}{background.B:X2}";
            Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", value);
            Logger.Write($"WEBVIEW2_DEFAULT_BACKGROUND_COLOR={value} (isDark={isDark})");
        }
        catch (Exception ex)
        {
            // 設定ファイルが壊れている等でテーマを解決できなくても、起動自体は続行する
            // (白フラッシュ対策が1層減るだけで、既存の非表示+タイマー機構は効いている)。
            Logger.WriteException("WEBVIEW2_DEFAULT_BACKGROUND_COLORの設定に失敗", ex);
        }
    }
}
