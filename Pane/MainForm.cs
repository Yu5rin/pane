using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pane;

/// <summary>
/// Paneのウィンドウ。WebView2でPhase 1のエディタ(dist/index.html)を表示し、
/// postMessageのJSONブリッジでファイルの開閉・保存を仲介する。
/// ファイルの実体はこのクラス(C#側)だけが触り、JS側へは本文文字列とモード情報のみを渡す。
///
/// Phase 3: 1ウィンドウ=1ファイルを基本とし、複数ウィンドウ管理は
/// <see cref="PaneApplicationContext"/> が担う。このクラス自身は自分のウィンドウの
/// ファイルI/O・自動保存・外部変更検知・読み取り専用検知のみに責務を持つ。
/// </summary>
internal sealed class MainForm : Form
{
    private const string VirtualHostName = "pane.local";
    private const int AutoSaveIntervalMs = 30_000;
    private const int ExternalChangeDebounceMs = 300;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly WebView2 _webView = new();
    private readonly string? _initialPath;
    private readonly AutoSaveSnapshot? _recoverFrom;
    private readonly Action<string?>? _requestNewWindow;
    private readonly System.Windows.Forms.Timer _autoSaveTimer;
    private readonly System.Windows.Forms.Timer _externalChangeDebounceTimer;

    private FileSystemWatcher? _watcher;
    private bool _suppressWatcher;
    private bool _externalChangePending;

    private string? _currentPath;
    private FileEncodingKind _currentEncoding = FileEncodingKind.Utf8;
    private LineEndingKind _currentLineEnding = LineEndingKind.Crlf;
    private bool _hasTrailingNewline = true;
    private bool _isDirty;
    private bool _isReadOnly;

    /// <summary>ConfirmDiscardDirtyAsyncの「保存する」選択時、JS側の保存完了(save-result)を待つための待機口。</summary>
    private TaskCompletionSource<bool>? _saveCompletionSource;
    /// <summary>ConfirmDiscardDirtyAsyncを通過した後、確認を再表示せずにClose()を通すためのフラグ。</summary>
    private bool _forceClose;

    /// <summary>自動保存スナップショットの識別子。ウィンドウごとに一意。</summary>
    public Guid WindowId { get; } = Guid.NewGuid();

    public string? CurrentPath => _currentPath;

    public bool IsDirty => _isDirty;

    public MainForm(string? initialPath, AutoSaveSnapshot? recoverFrom = null, Action<string?>? requestNewWindow = null)
    {
        _initialPath = initialPath;
        _recoverFrom = recoverFrom;
        _requestNewWindow = requestNewWindow;
        Logger.Write($"MainForm生成: initialPath={initialPath ?? "(なし)"}, recoverFrom={(recoverFrom is null ? "なし" : recoverFrom.OriginalPath ?? "無題")}");

        Text = "Pane";
        Width = 960;
        Height = 720;
        StartPosition = FormStartPosition.WindowsDefaultLocation;
        try
        {
            Icon = new Icon(Path.Combine(AppContext.BaseDirectory, "Assets", "Pane.ico"));
        }
        catch
        {
            // 仮アイコンが見つからなくても起動は継続する(実行ファイル埋め込みアイコンが使われる)
        }

        AllowDrop = true;
        DragEnter += OnDragEnter;
        DragDrop += OnDragDrop;

        _webView.Dock = DockStyle.Fill;
        // WebView2はDock=Fillでクライアント領域全体を覆うため、実際のドラッグ&ドロップ通知は
        // (Formではなく)このコントロール自身のHWNDが受け取る。WebView2.AllowDropは読み取り専用
        // (AllowExternalDrop=false設定時にコントロール自身が自動でOLEドロップターゲット登録する)
        // ため、こちらから明示的にAllowDrop=trueへは出来ないが、DragEnter/DragDropイベント自体は
        // Formと同じハンドラをそのまま登録できる。AllowExternalDropはネイティブのWebView2
        // コントローラー生成(EnsureCoreWebView2Async)より前に設定しないと、生成時点の既定値
        // (true)でOLEドロップターゲット登録が確定してしまい、後から変更しても反映されない
        // 可能性があるため、コントローラー生成前のこの時点で設定する。
        _webView.AllowExternalDrop = false;
        _webView.DragEnter += OnDragEnter;
        _webView.DragDrop += OnDragDrop;
        Controls.Add(_webView);

        // 起動直後・ウィンドウ切替後の初回キー入力がWebView2内のコンテンツへ届かない
        // (フォーカスがネイティブのフォーム側に留まる)ことがあるため、明示的にフォーカスを移す。
        Shown += (_, _) => { Logger.Write("Form.Shown: _webView.Focus()"); _webView.Focus(); };
        Activated += (_, _) => { Logger.Write("Form.Activated: _webView.Focus()"); _webView.Focus(); };

        _autoSaveTimer = new System.Windows.Forms.Timer { Interval = AutoSaveIntervalMs };
        _autoSaveTimer.Tick += (_, _) => RequestAutoSaveSnapshot();

        _externalChangeDebounceTimer = new System.Windows.Forms.Timer { Interval = ExternalChangeDebounceMs };
        _externalChangeDebounceTimer.Tick += OnExternalChangeDebounceElapsed;

        Load += OnLoadAsync;
        // ウィンドウを閉じる操作(Xボタン・Alt+F4・File>閉じる)すべてがここを通る。
        // 未保存の変更があれば保存するか確認してから閉じる(仕様書: 編集中のファイルを
        // 閉じるときに保存を確認する)。
        FormClosing += OnFormClosingAsync;
        FormClosed += (_, _) =>
        {
            Logger.Write("Form.FormClosed");
            _autoSaveTimer.Stop();
            _watcher?.Dispose();
        };
    }

    /// <summary>
    /// 未保存の変更がある場合、閉じる・新規作成・別のファイルを開く等、現在の文書を
    /// 置き換えるあらゆる操作の前に呼ぶ。保存する/しない/キャンセルを確認し、「保存する」が
    /// 選ばれた場合はJS側に保存を依頼してその完了(save-result)を待つ。
    /// 戻り値がtrueなら呼び出し元の操作を続行してよい。falseなら中止する。
    /// </summary>
    private async Task<bool> ConfirmDiscardDirtyAsync()
    {
        if (!_isDirty) return true;

        DialogResult choice = MessageBox.Show(
            this,
            "保存されていない変更があります。保存しますか?",
            "Pane",
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Warning);
        Logger.Write($"ConfirmDiscardDirtyAsync: 選択={choice}");

        if (choice == DialogResult.Cancel) return false;
        if (choice == DialogResult.No) return true;

        // 保存する: 本文はJS(CodeMirror)側にしか無いため、保存を要求して完了を待つ。
        _saveCompletionSource = new TaskCompletionSource<bool>();
        PostToWeb(new { type = "request-save" });
        bool saved = await _saveCompletionSource.Task;
        Logger.Write($"ConfirmDiscardDirtyAsync: 保存結果={saved}");
        return saved;
    }

    private async void OnFormClosingAsync(object? sender, FormClosingEventArgs e)
    {
        if (_forceClose) return;
        Logger.Write($"FormClosing: isDirty={_isDirty}");
        e.Cancel = true; // 非同期の確認・保存が終わるまでいったん保留する
        if (!await ConfirmDiscardDirtyAsync()) return;
        _forceClose = true;
        Close();
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        Logger.Write("OnLoadAsync開始");
        string userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Pane", "WebView2");

        CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
        await _webView.EnsureCoreWebView2Async(env);
        Logger.Write($"WebView2初期化完了: バージョン={_webView.CoreWebView2.Environment.BrowserVersionString}");

        // AllowExternalDropはコントローラー生成前(コンストラクタ)で既に設定済み。
        // ブラウザ既定のアクセラレータキー(Ctrl+U=ソース表示、Ctrl+F=検索、Ctrl+P=印刷、
        // F3=検索、F12=DevTools等)を無効化する。無効化しないとPane独自のショートカット
        // (仕様書 第2章のCtrl+U下線・Ctrl+F検索・Ctrl+Alt+P印刷等)より先にWebView2側の
        // 既定動作が奪ってしまい、JS側のkeydownハンドラに届かない。開発者ツールは
        // Viewメニュー(Shift+F12、独自ハンドラ)から明示的に開けるようにしている。
        _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        string distPath = ResolveDistPath();
        Logger.Write($"distPath={distPath} (存在={Directory.Exists(distPath)}, index.html存在={File.Exists(Path.Combine(distPath, "index.html"))})");
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            VirtualHostName, distPath, CoreWebView2HostResourceAccessKind.Allow);
        _webView.CoreWebView2.Navigate($"https://{VirtualHostName}/index.html");
        Logger.Write("Navigate呼び出し完了");
    }

    private static string ResolveDistPath()
    {
#if DEBUG
        // 開発時: リポジトリ直下の dist/(`npm run build` の成果物)をプロジェクトツリーを
        // 遡って探す。bin出力のフォルダ階層に依存しないようにするための探索。
        string? dir = AppContext.BaseDirectory;
        for (int i = 0; i < 8 && !string.IsNullOrEmpty(dir); i++)
        {
            string candidate = Path.Combine(dir, "dist");
            if (File.Exists(Path.Combine(candidate, "index.html")))
            {
                return candidate;
            }
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar));
        }
        throw new DirectoryNotFoundException(
            "開発ビルド用のdist/が見つかりません。リポジトリ直下で `npm run build` を実行してください。");
#else
        // リリース時: exeと同階層のdist/(仕様書 第7章)。
        // 単一ファイル発行(PublishSingleFile + IncludeAllContentForSelfExtract)では、
        // AppContext.BaseDirectoryは実行のたびに自己展開される一時フォルダ
        // (%TEMP%\.net\Pane\...)を指してしまい、exeの隣に置いたdist/には辿り着けない。
        // 実際にexeが置かれている場所はEnvironment.ProcessPathから取得する。
        string? exeDir = Path.GetDirectoryName(Environment.ProcessPath);
        return Path.Combine(exeDir ?? AppContext.BaseDirectory, "dist");
#endif
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
        JsonElement root = doc.RootElement;
        string type = root.TryGetProperty("type", out JsonElement typeProp) ? typeProp.GetString() ?? "" : "";
        // "dirty"は入力のたびに飛んでくるため、ログが埋もれないよう対象外にする。
        if (type != "dirty") Logger.Write($"JSからのメッセージ受信: type={type}");

        switch (type)
        {
            case "ready":
                PostCapabilities();
                if (_recoverFrom is not null) RestoreFromSnapshot(_recoverFrom);
                else if (_initialPath is not null) OpenFile(_initialPath);
                else OpenNewDocument();
                _autoSaveTimer.Start();
                break;
            case "open":
                _ = HandleOpenRequestAsync();
                break;
            case "open-path":
                if (root.TryGetProperty("path", out JsonElement openPathProp))
                {
                    _ = HandleOpenPathRequestAsync(openPathProp.GetString() ?? "");
                }
                break;
            case "save":
                HandleSaveRequest(root);
                break;
            case "dirty":
                if (root.TryGetProperty("value", out JsonElement dirtyProp))
                {
                    SetDirty(dirtyProp.GetBoolean());
                }
                break;
            case "text-response":
                if (root.TryGetProperty("text", out JsonElement textProp))
                {
                    WriteAutoSaveSnapshot(textProp.GetString() ?? "");
                }
                break;
            case "open-settings":
                ShowSettingsDialog();
                break;
            case "new":
                _ = HandleNewRequestAsync();
                break;
            case "new-window":
                _requestNewWindow?.Invoke(null);
                break;
            case "close":
                Close();
                break;
            case "print":
                _ = HandlePrintRequestAsync();
                break;
            case "open-devtools":
                _webView.CoreWebView2.OpenDevToolsWindow();
                break;
            case "export":
                _ = HandleExportRequestAsync(root);
                break;
            case "insert-image":
                HandleInsertImageRequest(root);
                break;
            case "log":
                // JS側の不具合調査ログ(main.jsのlogToHost)をC#側と同じログファイルへ集約する。
                string level = root.TryGetProperty("level", out JsonElement levelProp) ? levelProp.GetString() ?? "log" : "log";
                string logMessage = root.TryGetProperty("message", out JsonElement msgProp) ? msgProp.GetString() ?? "" : "";
                Logger.Write($"[JS:{level}] {logMessage}");
                break;
            case "set-theme":
                if (root.TryGetProperty("theme", out JsonElement themeProp))
                {
                    SaveTheme(themeProp.GetString() ?? "system");
                }
                break;
        }
    }

    private async Task HandleNewRequestAsync()
    {
        if (!await ConfirmDiscardDirtyAsync()) return;
        OpenNewDocument();
    }

    private async Task HandleOpenRequestAsync()
    {
        if (!await ConfirmDiscardDirtyAsync()) return;
        HandleOpenRequest();
    }

    private async Task HandleOpenPathRequestAsync(string path)
    {
        if (!await ConfirmDiscardDirtyAsync()) return;
        OpenFile(path);
    }

    private void HandleOpenRequest()
    {
        using var dialog = new OpenFileDialog
        {
            Filter = "Markdown / テキスト (*.md;*.markdown;*.mdown;*.txt)|*.md;*.markdown;*.mdown;*.txt|すべてのファイル (*.*)|*.*",
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            OpenFile(dialog.FileName);
        }
    }

    private void HandleSaveRequest(JsonElement message)
    {
        string text = message.TryGetProperty("text", out JsonElement textProp) ? textProp.GetString() ?? "" : "";
        bool saveAs = message.TryGetProperty("saveAs", out JsonElement saveAsProp) && saveAsProp.GetBoolean();

        if (_isReadOnly && !saveAs)
        {
            DialogResult choice = MessageBox.Show(
                this,
                "このファイルは読み取り専用です。上書きできません。\n名前を付けて別のファイルとして保存しますか?",
                "Pane",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (choice != DialogResult.Yes)
            {
                CompleteSave(ok: false);
                PostToWeb(new { type = "save-result", ok = false, canceled = true });
                return;
            }
            saveAs = true;
        }

        string? targetPath = _currentPath;
        if (saveAs || targetPath is null)
        {
            using var dialog = new SaveFileDialog
            {
                Filter = "Markdown (*.md)|*.md|テキスト (*.txt)|*.txt|すべてのファイル (*.*)|*.*",
                FileName = _currentPath is null ? "無題.md" : Path.GetFileName(_currentPath),
            };
            if (_currentPath is not null)
            {
                dialog.InitialDirectory = Path.GetDirectoryName(_currentPath);
            }
            if (dialog.ShowDialog(this) != DialogResult.OK)
            {
                CompleteSave(ok: false);
                PostToWeb(new { type = "save-result", ok = false, canceled = true });
                return;
            }
            targetPath = dialog.FileName;
        }

        try
        {
            SuppressWatcherDuring(() =>
                TextFileService.SaveAtomic(targetPath, text, _currentEncoding, _currentLineEnding, _hasTrailingNewline));
            _currentPath = targetPath;
            _isReadOnly = false;
            SetDirty(false);
            AutoSaveService.DeleteSnapshot(WindowId);
            StartWatching(targetPath);
            Logger.Write($"保存成功: {targetPath}");
            CompleteSave(ok: true);
            PostToWeb(new
            {
                type = "save-result",
                ok = true,
                fileName = Path.GetFileName(targetPath),
                path = targetPath,
                encoding = TextFileService.EncodingLabel(_currentEncoding),
                lineEnding = TextFileService.LineEndingLabel(_currentLineEnding),
            });
        }
        catch (Exception ex)
        {
            Logger.WriteException($"保存失敗: {targetPath}", ex);
            CompleteSave(ok: false);
            PostToWeb(new { type = "save-result", ok = false, error = ex.Message });
        }
    }

    /// <summary>ConfirmDiscardDirtyAsyncが保存完了を待っていれば、その結果を通知する。</summary>
    private void CompleteSave(bool ok)
    {
        _saveCompletionSource?.TrySetResult(ok);
        _saveCompletionSource = null;
    }

    /// <summary>
    /// ファイルダイアログ・コマンドライン引数・D&amp;D の3経路がすべてここを呼ぶ。
    /// </summary>
    public void OpenFile(string path)
    {
        Logger.Write($"OpenFile: {path}");
        try
        {
            LoadResult result = TextFileService.Load(path);
            _currentPath = path;
            _currentEncoding = result.Encoding;
            _currentLineEnding = result.LineEnding;
            _hasTrailingNewline = result.HasTrailingNewline;
            _isReadOnly = IsFileReadOnly(path);
            SetDirty(false);
            StartWatching(path);
            AddRecentFile(path);
            PostToWeb(new
            {
                type = "file-opened",
                text = result.Text,
                fileName = Path.GetFileName(path),
                path,
                encoding = TextFileService.EncodingLabel(result.Encoding),
                lineEnding = TextFileService.LineEndingLabel(result.LineEnding),
                readOnly = _isReadOnly,
            });
        }
        catch (Exception ex)
        {
            Logger.WriteException($"ファイルを開けなかった: {path}", ex);
            MessageBox.Show(
                this,
                $"ファイルを開けませんでした。\n{ex.Message}",
                "Pane",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private void OpenNewDocument()
    {
        _currentPath = null;
        _currentEncoding = FileEncodingKind.Utf8; // 既定: UTF-8 BOMなし(仕様書 第6.1節)
        _currentLineEnding = LineEndingKind.Crlf;
        _hasTrailingNewline = true;
        _isReadOnly = false;
        StopWatching();
        SetDirty(false);
        PostToWeb(new { type = "new-document" });
    }

    /// <summary>
    /// 異常終了後の自動保存スナップショットから復元する(仕様書 N-06)。
    /// 元ファイルの内容ではなく未保存の編集内容を表示するため、ダーティ状態で開始する。
    /// </summary>
    private void RestoreFromSnapshot(AutoSaveSnapshot snapshot)
    {
        _currentPath = snapshot.OriginalPath;
        _currentEncoding = snapshot.Encoding;
        _currentLineEnding = snapshot.LineEnding;
        _hasTrailingNewline = snapshot.HasTrailingNewline;
        _isReadOnly = snapshot.OriginalPath is not null && IsFileReadOnly(snapshot.OriginalPath);
        if (snapshot.OriginalPath is not null)
        {
            StartWatching(snapshot.OriginalPath);
        }
        PostToWeb(new
        {
            type = "file-opened",
            text = snapshot.Text,
            fileName = snapshot.OriginalPath is null ? "無題" : Path.GetFileName(snapshot.OriginalPath),
            path = snapshot.OriginalPath,
            encoding = TextFileService.EncodingLabel(snapshot.Encoding),
            lineEnding = TextFileService.LineEndingLabel(snapshot.LineEnding),
            readOnly = _isReadOnly,
        });
        SetDirty(true);
    }

    private static bool IsFileReadOnly(string path)
    {
        try
        {
            return File.GetAttributes(path).HasFlag(FileAttributes.ReadOnly);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private void SetDirty(bool value)
    {
        _isDirty = value;
        UpdateTitle();
    }

    private void UpdateTitle()
    {
        string name = _currentPath is null ? "無題" : Path.GetFileName(_currentPath);
        string mark = _isDirty ? "● " : string.Empty;
        string readOnlyMark = _isReadOnly ? "[読み取り専用] " : string.Empty;
        Text = $"{mark}{readOnlyMark}{name} - Pane";
    }

    private void PostToWeb(object message)
    {
        if (_webView.CoreWebView2 is null) return;
        string json = JsonSerializer.Serialize(message, JsonOptions);
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }

    private void OnDragEnter(object? sender, DragEventArgs e)
    {
        bool hasFileDrop = e.Data?.GetDataPresent(DataFormats.FileDrop) == true;
        Logger.Write($"OnDragEnter (sender={sender?.GetType().Name}): hasFileDrop={hasFileDrop}");
        e.Effect = hasFileDrop ? DragDropEffects.Copy : DragDropEffects.None;
    }

    private async void OnDragDrop(object? sender, DragEventArgs e)
    {
        Logger.Write($"OnDragDrop (sender={sender?.GetType().Name}): dataPresent={e.Data?.GetDataPresent(DataFormats.FileDrop)}");
        if (e.Data?.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } paths)
        {
            Logger.Write($"OnDragDrop: paths=[{string.Join(",", paths)}]");
            if (!await ConfirmDiscardDirtyAsync()) return;
            // このウィンドウには先頭の1件を開く。複数ファイルは呼び出し元(D&D)が
            // 別ウィンドウとして開くかどうかを判断する(Phase 3のカスケード配置)。
            OpenFile(paths[0]);
        }
    }

    // ---- 自動保存(仕様書 N-06) ----

    private void RequestAutoSaveSnapshot()
    {
        if (!_isDirty) return;
        // 本文はJS(CodeMirror)側にしかないため、都度取得を依頼する。
        // 頻繁なキー入力のたびには送らず、タイマー間隔(既定30秒)でのみ発生させる。
        PostToWeb(new { type = "request-text" });
    }

    private void WriteAutoSaveSnapshot(string text)
    {
        var snapshot = new AutoSaveSnapshot(
            _currentPath, text, _currentEncoding, _currentLineEnding, _hasTrailingNewline, DateTime.UtcNow);
        AutoSaveService.WriteSnapshot(WindowId, snapshot);
    }

    // ---- 外部変更検知・読み取り専用検知(仕様書 N-11・N-12) ----

    private void StartWatching(string path)
    {
        StopWatching();
        try
        {
            string? dir = Path.GetDirectoryName(Path.GetFullPath(path));
            if (dir is null) return;

            _watcher = new FileSystemWatcher(dir, Path.GetFileName(path))
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.Attributes,
            };
            _watcher.Changed += OnFileChangedExternally;
            _watcher.EnableRaisingEvents = true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // 監視できなくても編集自体は継続できるようにする(ベストエフォート)。
            _watcher = null;
        }
    }

    private void StopWatching()
    {
        _watcher?.Dispose();
        _watcher = null;
    }

    private void SuppressWatcherDuring(Action action)
    {
        _suppressWatcher = true;
        if (_watcher is not null) _watcher.EnableRaisingEvents = false;
        try
        {
            action();
        }
        finally
        {
            _suppressWatcher = false;
            if (_watcher is not null) _watcher.EnableRaisingEvents = true;
        }
    }

    private void OnFileChangedExternally(object sender, FileSystemEventArgs e)
    {
        if (_suppressWatcher) return;

        // 保存操作1回でも複数のファイルシステムイベントが飛んでくることがあるため、
        // UIスレッドで短時間デバウンスしてからまとめて1回だけ確認する。
        BeginInvoke(new MethodInvoker(() =>
        {
            _externalChangePending = true;
            _externalChangeDebounceTimer.Stop();
            _externalChangeDebounceTimer.Start();
        }));
    }

    private void OnExternalChangeDebounceElapsed(object? sender, EventArgs e)
    {
        _externalChangeDebounceTimer.Stop();
        if (!_externalChangePending || _currentPath is null) return;
        _externalChangePending = false;

        string unsavedWarning = _isDirty
            ? "\n(このウィンドウには未保存の変更があります。再読み込みすると失われます。)"
            : string.Empty;

        DialogResult choice = MessageBox.Show(
            this,
            $"このファイルは他のアプリケーションによって変更されました。再読み込みしますか?{unsavedWarning}",
            "Pane",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning);

        if (choice == DialogResult.Yes)
        {
            OpenFile(_currentPath);
        }
        // いいえの場合は現在の編集内容を保持したまま、次の変更検知まで何もしない
        // (仕様書どおり、無断で上書き・自動再読み込みはしない)。
    }

    // ---- 設定(仕様書 N-07・N-09、Phase 3時点は最小ダイアログ) ----

    private void ShowSettingsDialog()
    {
        AppSettings settings = SettingsService.Load();
        using var dialog = new SettingsForm(settings);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        bool wantsAssociation = dialog.FileAssociationEnabled;
        if (wantsAssociation != settings.FileAssociationEnabled)
        {
            try
            {
                if (wantsAssociation) FileAssociationService.Register();
                else FileAssociationService.Unregister();
                settings.FileAssociationEnabled = wantsAssociation;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    this,
                    $"ファイルの関連付け設定を変更できませんでした。\n{ex.Message}",
                    "Pane",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        settings.StartupBehavior = dialog.RestoreSessionOnStartup ? "restoreSession" : "blank";
        settings.CalloutsEnabled = dialog.CalloutsEnabled;
        settings.SuperSubscriptEnabled = dialog.SuperSubscriptEnabled;
        settings.HighlightEnabled = dialog.HighlightEnabled;
        settings.InlineMathEnabled = dialog.InlineMathEnabled;
        settings.MathAutoNumberEnabled = dialog.MathAutoNumberEnabled;
        settings.DefaultCopyFormat = dialog.DefaultCopyFormat;
        SettingsService.Save(settings);
        PostCapabilities();
    }

    /// <summary>
    /// マークダウン記法拡張のON/OFF(仕様書 第2.10節 C-01)・最近使ったファイル(F-09)・
    /// Pandoc導入状況・既定コピー形式をJS側へ伝える。起動時("ready"受信直後)、設定画面でOKが
    /// 押されるたび、最近使ったファイルが更新されるたびに送る。
    /// </summary>
    private void PostCapabilities()
    {
        AppSettings settings = SettingsService.Load();
        PostToWeb(new
        {
            type = "apply-settings",
            calloutsEnabled = settings.CalloutsEnabled,
            superSubEnabled = settings.SuperSubscriptEnabled,
            highlightEnabled = settings.HighlightEnabled,
            inlineMathEnabled = settings.InlineMathEnabled,
            mathAutoNumberEnabled = settings.MathAutoNumberEnabled,
            defaultCopyFormat = settings.DefaultCopyFormat,
            recentFiles = settings.RecentFiles,
            pandocAvailable = DetectPandocAvailable(),
            theme = settings.Theme,
        });
    }

    /// <summary>テーマ切替(仕様書 第10.2節)の手動選択を永続化する。"system"ならOS設定に追従したまま何もしない。</summary>
    private static void SaveTheme(string theme)
    {
        if (theme != "light" && theme != "dark" && theme != "system") return;
        AppSettings settings = SettingsService.Load();
        settings.Theme = theme;
        SettingsService.Save(settings);
    }

    /// <summary>最近使ったファイル一覧(仕様書 F-09)を更新する。先頭が最新、重複除去、最大10件。</summary>
    private static void AddRecentFile(string path)
    {
        AppSettings settings = SettingsService.Load();
        settings.RecentFiles.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        settings.RecentFiles.Insert(0, path);
        if (settings.RecentFiles.Count > 10)
        {
            settings.RecentFiles.RemoveRange(10, settings.RecentFiles.Count - 10);
        }
        SettingsService.Save(settings);
    }

    private static bool? _pandocAvailableCache;

    /// <summary>Pandocの導入有無を検出する(仕様書: Word/EPUBエクスポートに必要)。プロセス起動1回のみでキャッシュする。</summary>
    private static bool DetectPandocAvailable()
    {
        if (_pandocAvailableCache is bool cached) return cached;
        bool available;
        try
        {
            using var proc = Process.Start(new ProcessStartInfo("pandoc", "--version")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            });
            available = proc is not null && proc.WaitForExit(3000) && proc.ExitCode == 0;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException)
        {
            available = false; // Pandoc未導入(PATHに無い)
        }
        _pandocAvailableCache = available;
        return available;
    }

    // ---- 印刷(仕様書 File項目「印刷」)。WebView2既定の印刷ダイアログを開く。 ----
    private Task HandlePrintRequestAsync()
    {
        try
        {
            _webView.CoreWebView2.ShowPrintUI(CoreWebView2PrintDialogKind.Browser);
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException)
        {
            // 印刷ダイアログを開けない環境ではベストエフォートで諦める
        }
        return Task.CompletedTask;
    }

    // ---- エクスポート(仕様書 F-XX)。PDFはWebView2のネイティブ機能、HTMLは
    // JS側で組み立て済みのHTML文字列をそのまま保存、Word/EPUBはPandocに委譲する。
    // PDFはJS側が"export"送信前にメニューバー等を隠し文書全体をレイアウトへ展開している
    // (enterExportLayout)ため、このメソッドを抜ける経路(保存キャンセルを含む)すべてで
    // 必ず"export-done"を返し、JS側の表示を元に戻せるようにする。 ----
    private async Task HandleExportRequestAsync(JsonElement message)
    {
        string format = message.TryGetProperty("format", out JsonElement fmtProp) ? fmtProp.GetString() ?? "" : "";
        string text = message.TryGetProperty("text", out JsonElement textProp) ? textProp.GetString() ?? "" : "";
        string baseName = _currentPath is null ? "無題" : Path.GetFileNameWithoutExtension(_currentPath);

        (string filter, string ext) = format switch
        {
            "pdf" => ("PDF (*.pdf)|*.pdf", ".pdf"),
            "html" or "html-plain" => ("HTML (*.html)|*.html", ".html"),
            "docx" => ("Word文書 (*.docx)|*.docx", ".docx"),
            "epub" => ("EPUB (*.epub)|*.epub", ".epub"),
            _ => ("すべてのファイル (*.*)|*.*", ""),
        };
        try
        {
            using var dialog = new SaveFileDialog { Filter = filter, FileName = baseName + ext };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            string targetPath = dialog.FileName;

            switch (format)
            {
                case "pdf":
                    await _webView.CoreWebView2.PrintToPdfAsync(targetPath);
                    break;
                case "html":
                case "html-plain":
                    await File.WriteAllTextAsync(targetPath, text, new UTF8Encoding(false));
                    break;
                case "docx":
                case "epub":
                    await ExportViaPandocAsync(text, targetPath);
                    break;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"エクスポートに失敗しました。\n{ex.Message}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            PostToWeb(new { type = "export-done" });
        }
    }

    private static async Task ExportViaPandocAsync(string markdownText, string targetPath)
    {
        string tempMd = Path.Combine(Path.GetTempPath(), $"pane-export-{Guid.NewGuid():N}.md");
        try
        {
            await File.WriteAllTextAsync(tempMd, markdownText, new UTF8Encoding(false));
            var psi = new ProcessStartInfo("pandoc")
            {
                UseShellExecute = false,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add(tempMd);
            psi.ArgumentList.Add("-o");
            psi.ArgumentList.Add(targetPath);
            using var proc = Process.Start(psi);
            if (proc is null) throw new InvalidOperationException("Pandocを起動できませんでした。");
            string stderr = await proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();
            if (proc.ExitCode != 0) throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? "Pandocの変換に失敗しました。" : stderr);
        }
        finally
        {
            try { File.Delete(tempMd); } catch (IOException) { /* ベストエフォート */ }
        }
    }

    // ---- 画像挿入(仕様書 R-07)。文書と同じフォルダの images/ 配下へコピーし、相対パスを返す。 ----
    private void HandleInsertImageRequest(JsonElement message)
    {
        if (_currentPath is null)
        {
            MessageBox.Show(this, "画像を挿入する前に、文書を一度保存してください。", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        string docDir = Path.GetDirectoryName(Path.GetFullPath(_currentPath))!;
        string imagesDir = Path.Combine(docDir, "images");

        string? sourcePath = null;
        byte[]? bytes = null;
        string suggestedName = "image.png";

        if (message.TryGetProperty("dataBase64", out JsonElement dataProp) && dataProp.ValueKind == JsonValueKind.String)
        {
            bytes = Convert.FromBase64String(dataProp.GetString() ?? "");
            if (message.TryGetProperty("name", out JsonElement nameProp) && nameProp.GetString() is string n && n.Length > 0)
            {
                suggestedName = n;
            }
        }
        else
        {
            using var dialog = new OpenFileDialog
            {
                Filter = "画像ファイル (*.png;*.jpg;*.jpeg;*.gif;*.svg;*.webp)|*.png;*.jpg;*.jpeg;*.gif;*.svg;*.webp",
            };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            sourcePath = dialog.FileName;
            suggestedName = Path.GetFileName(sourcePath);
        }

        try
        {
            Directory.CreateDirectory(imagesDir);
            string destPath = UniqueDestinationPath(imagesDir, suggestedName);
            if (sourcePath is not null) File.Copy(sourcePath, destPath);
            else File.WriteAllBytes(destPath, bytes!);

            string relative = Path.GetRelativePath(docDir, destPath).Replace(Path.DirectorySeparatorChar, '/');
            PostToWeb(new { type = "image-inserted", alt = Path.GetFileNameWithoutExtension(destPath), path = relative });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"画像を挿入できませんでした。\n{ex.Message}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string UniqueDestinationPath(string dir, string fileName)
    {
        string name = Path.GetFileNameWithoutExtension(fileName);
        string ext = Path.GetExtension(fileName);
        string candidate = Path.Combine(dir, fileName);
        for (int i = 1; File.Exists(candidate); i++)
        {
            candidate = Path.Combine(dir, $"{name}-{i}{ext}");
        }
        return candidate;
    }
}
