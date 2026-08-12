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

    /// <summary>自動保存スナップショットの識別子。ウィンドウごとに一意。</summary>
    public Guid WindowId { get; } = Guid.NewGuid();

    public string? CurrentPath => _currentPath;

    public bool IsDirty => _isDirty;

    public MainForm(string? initialPath, AutoSaveSnapshot? recoverFrom = null)
    {
        _initialPath = initialPath;
        _recoverFrom = recoverFrom;

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
        Controls.Add(_webView);

        _autoSaveTimer = new System.Windows.Forms.Timer { Interval = AutoSaveIntervalMs };
        _autoSaveTimer.Tick += (_, _) => RequestAutoSaveSnapshot();

        _externalChangeDebounceTimer = new System.Windows.Forms.Timer { Interval = ExternalChangeDebounceMs };
        _externalChangeDebounceTimer.Tick += OnExternalChangeDebounceElapsed;

        Load += OnLoadAsync;
        FormClosed += (_, _) =>
        {
            _autoSaveTimer.Stop();
            _watcher?.Dispose();
        };
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        string userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Pane", "WebView2");

        CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
        await _webView.EnsureCoreWebView2Async(env);

        // Formのドラッグ&ドロップ(コマンドライン引数・D&Dと同じOpenFile経路)を使うため、
        // WebView2自身にドロップを処理させない。
        _webView.AllowExternalDrop = false;
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        string distPath = ResolveDistPath();
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            VirtualHostName, distPath, CoreWebView2HostResourceAccessKind.Allow);
        _webView.CoreWebView2.Navigate($"https://{VirtualHostName}/index.html");
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
        // リリース時: exeと同階層のdist/(仕様書 第7章)
        return Path.Combine(AppContext.BaseDirectory, "dist");
#endif
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
        JsonElement root = doc.RootElement;
        string type = root.TryGetProperty("type", out JsonElement typeProp) ? typeProp.GetString() ?? "" : "";

        switch (type)
        {
            case "ready":
                if (_recoverFrom is not null) RestoreFromSnapshot(_recoverFrom);
                else if (_initialPath is not null) OpenFile(_initialPath);
                else OpenNewDocument();
                _autoSaveTimer.Start();
                break;
            case "open":
                HandleOpenRequest();
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
        }
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
            PostToWeb(new { type = "save-result", ok = false, error = ex.Message });
        }
    }

    /// <summary>
    /// ファイルダイアログ・コマンドライン引数・D&amp;D の3経路がすべてここを呼ぶ。
    /// </summary>
    public void OpenFile(string path)
    {
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
        e.Effect = e.Data?.GetDataPresent(DataFormats.FileDrop) == true
            ? DragDropEffects.Copy
            : DragDropEffects.None;
    }

    private void OnDragDrop(object? sender, DragEventArgs e)
    {
        if (e.Data?.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } paths)
        {
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
        SettingsService.Save(settings);
    }
}
