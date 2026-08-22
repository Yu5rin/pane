using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;

namespace Pane;

/// <summary>更新の確認結果。</summary>
/// <param name="Status">"latest"(最新) / "available"(新しい版がある) / "error"(確認できなかった)</param>
/// <param name="CurrentVersion">いま動いているPaneのバージョン。</param>
/// <param name="LatestVersion">配布元にある最新のバージョン。確認できなければ空。</param>
/// <param name="DownloadUrl">配布物(Zip)のURL。</param>
/// <param name="Sha256">配布物のSHA256(配布元が提供していれば)。空なら照合を省く。</param>
/// <param name="SizeBytes">配布物のバイト数。進捗表示に使う。</param>
/// <param name="ReleaseUrl">リリースページのURL。手動更新へ誘導するときに使う。</param>
/// <param name="Message">利用者に見せる説明。</param>
internal sealed record UpdateCheckResult(
    string Status,
    string CurrentVersion,
    string LatestVersion,
    string DownloadUrl,
    string Sha256,
    long SizeBytes,
    string ReleaseUrl,
    string Message);

/// <summary>
/// 更新の確認・ダウンロード・入れ替え(仕様書 U-01〜U-04)。
///
/// 【方針】Paneは自分から外部へ通信しない。この機能が動くのは、利用者が設定画面の
/// 「更新を確認」を押したときだけ。起動時や定期的な問い合わせは一切行わない
/// (仕様書 第4.2節・取扱説明書「外部通信について」)。
///
/// 問い合わせ先は設定ファイルの updateCheckUrl に持たせてあり、コードに直書きしていない。
/// どこへ通信するのかを利用者がいつでも確認でき、配布場所を移したときも設定だけで追随できる。
/// </summary>
internal static class UpdateService
{
    /// <summary>通信のタイムアウト。確認は軽い問い合わせなので短くてよい。</summary>
    private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(15);

    /// <summary>ダウンロードのタイムアウト。配布物は70MB超あるため長めに取る。</summary>
    private static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(30);

    /// <summary>
    /// ダウンロードするバイト数の上限。配布元がサイズを知らせてこない場合に使う。
    /// 際限なく受け取ると空き容量を使い切ってしまうため、常に上限を設けておく。
    /// </summary>
    private const long MaxDownloadBytes = 500L * 1024 * 1024;

    /// <summary>
    /// 入れ替え時に退避する古いファイルに付ける拡張子。次回起動時に掃除する
    /// (<see cref="CleanupLeftovers"/>)。
    /// </summary>
    private const string BackupSuffix = ".pane-old";

    /// <summary>
    /// HttpClientはプロセスで1つだけ作って使い回す(都度newするとソケットを使い果たす)。
    /// GitHubのAPIはUser-Agentが無いと400を返すため必ず付ける。
    /// </summary>
    private static readonly HttpClient Http = CreateHttpClient();

    private static HttpClient CreateHttpClient()
    {
        var client = new HttpClient();
        client.DefaultRequestHeaders.Add("User-Agent", "Pane-Updater");
        client.DefaultRequestHeaders.Add("Accept", "application/vnd.github+json");
        return client;
    }

    /// <summary>
    /// 配布元へ問い合わせて、新しい版があるかを調べる。
    ///
    /// 通信に失敗しても例外は投げず、status="error" として理由を添えて返す。
    /// 更新の確認ができないことでアプリの動作を妨げてはいけないため。
    /// </summary>
    public static async Task<UpdateCheckResult> CheckAsync(AppSettings settings)
    {
        string currentVersionText = SettingsBridge.DetectAppVersion();
        string url = settings.UpdateCheckUrl?.Trim() ?? "";

        if (string.IsNullOrEmpty(url))
        {
            return Error(currentVersionText, "更新の確認先が設定されていません(設定ファイルの updateCheckUrl)。");
        }
        if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            // 平文の通信は許可しない。通信内容の差し替えを防ぐため。
            Logger.Warn($"更新の確認: httpsではないURLは使わない: {url}");
            return Error(currentVersionText, "更新の確認先が https で始まっていないため中止しました。");
        }

        try
        {
            using var _ = PerfWatch.Start("更新の確認(問い合わせ)", 5000);
            Logger.Write($"更新の確認: 問い合わせ先={url}");

            using var cts = new CancellationTokenSource(CheckTimeout);
            string json = await Http.GetStringAsync(url, cts.Token);

            using JsonDocument doc = JsonDocument.Parse(json);
            JsonElement root = doc.RootElement;

            string tag = root.TryGetProperty("tag_name", out JsonElement tagProp) ? tagProp.GetString() ?? "" : "";
            string releaseUrl = root.TryGetProperty("html_url", out JsonElement pageProp) ? pageProp.GetString() ?? "" : "";
            (string assetUrl, string sha256, long size) = FindZipAsset(root);

            Version? latest = FileAssociationService.ParseVersion(StripVersionPrefix(tag));
            Version? current = FileAssociationService.ParseVersion(currentVersionText);
            if (latest is null)
            {
                Logger.Warn($"更新の確認: 配布元のバージョン表記を読み取れなかった: \"{tag}\"");
                return Error(currentVersionText, "配布元のバージョン表記を読み取れませんでした。");
            }
            if (current is null)
            {
                Logger.Warn($"更新の確認: 自分のバージョンを読み取れなかった: \"{currentVersionText}\"");
                return Error(currentVersionText, "いま動いているPaneのバージョンを判別できませんでした。");
            }

            // 比較は必ずVersionで行う。文字列比較だと "1.0.10" < "1.0.9" と誤判定する。
            if (latest <= current)
            {
                Logger.Write($"更新の確認: 最新版だった(現在={currentVersionText}, 配布元={tag})");
                return new UpdateCheckResult("latest", currentVersionText, tag, "", "", 0, releaseUrl,
                    "お使いのPaneは最新版です。");
            }

            Logger.Write($"更新の確認: 新しい版がある(現在={currentVersionText}, 配布元={tag}, サイズ={size}バイト, SHA256={(string.IsNullOrEmpty(sha256) ? "(提供なし)" : "あり")})");
            if (string.IsNullOrEmpty(assetUrl))
            {
                // 新しい版はあるが、自動で入れ替えられる配布物が見つからない。
                return new UpdateCheckResult("available", currentVersionText, tag, "", "", 0, releaseUrl,
                    $"新しい版 {tag} がありますが、自動で入れ替えられる配布物が見つかりませんでした。リリースページから手動で更新してください。");
            }
            return new UpdateCheckResult("available", currentVersionText, tag, assetUrl, sha256, size, releaseUrl,
                $"新しい版 {tag} があります。");
        }
        catch (OperationCanceledException)
        {
            Logger.Warn("更新の確認: 時間内に応答がなかった");
            return Error(currentVersionText, "配布元から時間内に応答がありませんでした。ネットワークの状態を確認してください。");
        }
        catch (Exception ex)
        {
            Logger.WriteException("更新の確認に失敗", ex);
            return Error(currentVersionText, $"更新を確認できませんでした({ex.GetType().Name})。");
        }
    }

    private static UpdateCheckResult Error(string currentVersion, string message)
        => new("error", currentVersion, "", "", "", 0, "", message);

    /// <summary>
    /// タグ名の先頭の "v" を落とす("v1.0.4" → "1.0.4")。
    ///
    /// Gitのタグは慣例的に "v" を付けるが(このリポジトリも v1.0.4 の形)、
    /// <see cref="Version.TryParse"/> は "v" が付いていると読み取れない。
    /// 画面に出す表記はタグのまま("v1.0.5 があります")にしたいので、
    /// ここでは比較用の値を作るときだけ落とす。
    /// </summary>
    private static string StripVersionPrefix(string tag)
    {
        string t = tag.Trim();
        return t.Length > 1 && (t[0] == 'v' || t[0] == 'V') ? t[1..] : t;
    }

    /// <summary>
    /// リリースのアセットから、入れ替えに使うZipを1つ選ぶ。
    /// 配布物は "Pane-vX.Y.Z-win-x64.zip" の1つだけなので、拡張子が .zip のものを採用する。
    /// GitHubがアセットに digest("sha256:...") を付けている場合はそれも取り出す。
    /// </summary>
    private static (string Url, string Sha256, long Size) FindZipAsset(JsonElement root)
    {
        if (!root.TryGetProperty("assets", out JsonElement assets) || assets.ValueKind != JsonValueKind.Array)
        {
            return ("", "", 0);
        }
        foreach (JsonElement asset in assets.EnumerateArray())
        {
            string name = asset.TryGetProperty("name", out JsonElement n) ? n.GetString() ?? "" : "";
            if (!name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) continue;

            string url = asset.TryGetProperty("browser_download_url", out JsonElement u) ? u.GetString() ?? "" : "";
            // 問い合わせ先(updateCheckUrl)と同じく、ダウンロード先もhttpsに限る。こちらは
            // 設定ではなく配布元の応答から来る値のため、応答が差し替えられていた場合に
            // 平文や別のスキームへ誘導されないよう、使う前にここで弾く。
            if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                Logger.Warn($"更新の確認: httpsではない配布物のURLは使わない: {url}");
                return ("", "", 0);
            }
            long size = asset.TryGetProperty("size", out JsonElement s) && s.TryGetInt64(out long parsed) ? parsed : 0;

            string sha = "";
            if (asset.TryGetProperty("digest", out JsonElement d) && d.GetString() is string digest
                && digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
            {
                sha = digest["sha256:".Length..];
            }
            return (url, sha, size);
        }
        return ("", "", 0);
    }

    /// <summary>
    /// 配布物をダウンロードして一時フォルダへ保存する。SHA256が分かっていれば照合し、
    /// 一致しなければ削除して例外を投げる(改ざんや破損したものを展開しないため)。
    /// </summary>
    /// <param name="progress">0〜100の進捗。サイズ不明のときは呼ばれない。</param>
    public static async Task<string> DownloadAsync(
        UpdateCheckResult info, IProgress<int>? progress, CancellationToken ct)
    {
        string directory = Path.Combine(Path.GetTempPath(), $"pane-update-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        string zipPath = Path.Combine(directory, "Pane-update.zip");

        Logger.Write($"更新のダウンロード開始: {info.DownloadUrl}");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(DownloadTimeout);

        try
        {
            using HttpResponseMessage response = await Http.GetAsync(
                info.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            response.EnsureSuccessStatusCode();

            long total = response.Content.Headers.ContentLength ?? info.SizeBytes;
            // 実際に受け取ってよいバイト数。サイズが分かっているならその少し上まで、
            // 分からないなら固定の上限まで(配布元の応答をそのまま信じて際限なく書き込まない)。
            long limit = total > 0 ? Math.Min(total + (1024 * 1024), MaxDownloadBytes) : MaxDownloadBytes;
            using (Stream source = await response.Content.ReadAsStreamAsync(cts.Token))
            using (var destination = new FileStream(zipPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[81920];
                long received = 0;
                int lastPercent = -1;
                int read;
                while ((read = await source.ReadAsync(buffer, cts.Token)) > 0)
                {
                    await destination.WriteAsync(buffer.AsMemory(0, read), cts.Token);
                    received += read;
                    if (received > limit)
                    {
                        throw new InvalidDataException(
                            $"配布物が想定より大きいためダウンロードを中止しました({received}バイト受信、上限{limit}バイト)。");
                    }
                    if (total <= 0 || progress is null) continue;
                    int percent = (int)(received * 100 / total);
                    // 同じ値を何度も通知しない(1%刻み)。
                    if (percent == lastPercent) continue;
                    lastPercent = percent;
                    progress.Report(percent);
                }
            }

            VerifyHash(zipPath, info.Sha256);
            Logger.Write($"更新のダウンロード完了: {zipPath} ({new FileInfo(zipPath).Length}バイト)");
            return zipPath;
        }
        catch
        {
            TryDeleteDirectory(directory);
            throw;
        }
    }

    /// <summary>
    /// ダウンロードしたファイルのSHA256を照合する。期待値が空の場合は照合を省く
    /// (配布元がハッシュを提供していないケース。HTTPSで取得しているため通信路は保護されている)。
    /// </summary>
    private static void VerifyHash(string zipPath, string expected)
    {
        if (string.IsNullOrWhiteSpace(expected))
        {
            Logger.Write("更新の検証: 配布元がSHA256を提供していないため照合を省いた");
            return;
        }
        using FileStream stream = File.OpenRead(zipPath);
        string actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (!actual.Equals(expected.Trim().ToLowerInvariant(), StringComparison.Ordinal))
        {
            Logger.Error($"更新の検証: SHA256が一致しない(期待={expected}, 実際={actual})");
            throw new InvalidDataException("ダウンロードしたファイルが壊れているか、配布元のものと一致しませんでした。");
        }
        Logger.Write("更新の検証: SHA256が一致した");
    }

    /// <summary>
    /// いまのPaneが置かれている場所へ書き込めるかを調べる。
    /// Program Files のような管理者権限が要る場所に置かれている場合、入れ替えは行えない。
    /// </summary>
    public static bool CanWriteToInstallFolder(out string folder)
    {
        folder = Path.GetDirectoryName(Environment.ProcessPath ?? "") ?? "";
        if (string.IsNullOrEmpty(folder)) return false;
        try
        {
            string probe = Path.Combine(folder, $".pane-write-test-{Guid.NewGuid():N}");
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return true;
        }
        catch (Exception ex)
        {
            Logger.Write($"更新: インストール先へ書き込めない({folder}): {ex.GetType().Name}");
            return false;
        }
    }

    /// <summary>
    /// ダウンロードしたZipで、いまのexeとdistを入れ替える。
    ///
    /// 実行中のexeは上書きも削除もできないが、リネームはできる。これを利用して
    /// 「古いものを退避 → 新しいものを配置」の順で置き換える(Chrome等と同じ考え方)。
    /// 退避したファイルは次回起動時に削除する(<see cref="CleanupLeftovers"/>)。
    ///
    /// 途中で失敗した場合は、退避したものを必ず元へ戻す。ここで中途半端に終わると
    /// Paneが起動しなくなるため、ロールバックは省略できない。
    /// </summary>
    /// <returns>入れ替えた新しいexeのパス。</returns>
    public static string ApplyUpdate(string zipPath)
    {
        string? installFolder = Path.GetDirectoryName(Environment.ProcessPath ?? "");
        if (string.IsNullOrEmpty(installFolder))
        {
            throw new InvalidOperationException("Paneが置かれている場所を特定できませんでした。");
        }

        string extractRoot = Path.Combine(Path.GetDirectoryName(zipPath)!, "extracted");
        Directory.CreateDirectory(extractRoot);
        ZipFile.ExtractToDirectory(zipPath, extractRoot, overwriteFiles: true);

        // 配布Zipは「Pane-vX.Y.Z-win-x64/」という1階層を挟む(scripts/release.ps1参照)。
        // その中にexeとdistがある。将来この構造が変わっても動くよう、Pane.exeを実際に探す。
        string? newExe = Directory.EnumerateFiles(extractRoot, "Pane.exe", SearchOption.AllDirectories).FirstOrDefault();
        if (newExe is null)
        {
            throw new InvalidDataException("ダウンロードした配布物の中に Pane.exe が見つかりませんでした。");
        }
        string newRoot = Path.GetDirectoryName(newExe)!;
        string newDist = Path.Combine(newRoot, "dist");
        if (!Directory.Exists(newDist))
        {
            throw new InvalidDataException("ダウンロードした配布物の中に dist フォルダが見つかりませんでした。");
        }

        string currentExe = Environment.ProcessPath!;
        string currentDist = Path.Combine(installFolder, "dist");
        string exeBackup = currentExe + BackupSuffix;
        string distBackup = currentDist + BackupSuffix;

        // 前回の残骸があると邪魔になるので先に片付ける。
        TryDelete(exeBackup);
        TryDeleteDirectory(distBackup);

        bool exeMoved = false;
        bool distMoved = false;
        try
        {
            Logger.Write($"更新の適用: {installFolder} を入れ替える");

            File.Move(currentExe, exeBackup);
            exeMoved = true;
            // 退避した時刻を「今」にしておく。リネームは元の更新時刻(=その版をビルドした
            // 日時)を引き継ぐため、そのままだと次の起動で「たった今更新された」と
            // 判断できない(LooksLikeJustUpdated参照)。
            TrySetJustMovedTimestamp(exeBackup, isDirectory: false);

            if (Directory.Exists(currentDist))
            {
                Directory.Move(currentDist, distBackup);
                distMoved = true;
                TrySetJustMovedTimestamp(distBackup, isDirectory: true);
            }

            File.Copy(newExe, currentExe);
            CopyDirectory(newDist, currentDist);

            Logger.Write("更新の適用: 入れ替えが完了した");
            return currentExe;
        }
        catch (Exception ex)
        {
            Logger.WriteException("更新の適用に失敗したため元に戻す", ex);
            // ロールバック。新しく置いたものを消してから、退避したものを戻す。
            TryDelete(currentExe);
            TryDeleteDirectory(currentDist);
            if (exeMoved) TryMove(exeBackup, currentExe);
            if (distMoved) TryMoveDirectory(distBackup, currentDist);
            throw;
        }
    }

    /// <summary>
    /// 新しいexeを起動する。呼び出し元は、この後すみやかに自分を終了させること
    /// (古いexeが動いたままだと、退避したファイルを次回起動時に消せない)。
    /// </summary>
    public static void StartNewVersion(string exePath)
    {
        // 自分のプロセスIDを渡し、新しい側にはこれが終わるまで待ってもらう
        // (--after-update。Program.Main参照)。
        //
        // これが無いと、古い側の終了と新しい側の起動が重なる。実機のログでは
        // Process.Startから実際に新プロセスが動き出すまで2.1秒かかっており、
        // ちょうど古い側が終了処理に入った瞬間と重なって、新しい側のWebView2の
        // 初期化が返ってこなくなった(ウィンドウが出ないまま止まる)。
        // 名前付きMutex(多重起動制御)の解放も古い側のプロセス終了時のため、
        // 待たせておかないと新しい側が「既に起動中」と誤判定しうる。
        string arguments = $"--after-update {Environment.ProcessId}";
        Logger.Write($"更新: 新しいPaneを起動する: {exePath} {arguments}");

        using Process? started = Process.Start(new ProcessStartInfo
        {
            FileName = exePath,
            Arguments = arguments,
            UseShellExecute = true,
            WorkingDirectory = Path.GetDirectoryName(exePath) ?? "",
        });

        // 新しい側のウィンドウが前面に出られるようにする。これを呼ばないと、
        // 起動したのが自分(前面にいるプロセス)であってもWindowsは新プロセスへ
        // フォアグラウンド権を渡さず、ウィンドウが背面のままになる
        // (実機ログの「TrySetForegroundWindow: 失敗」)。
        if (started is not null)
        {
            try { AllowSetForegroundWindow(started.Id); }
            catch (Exception ex) { Logger.Debug($"更新: フォアグラウンド権の譲渡に失敗: {ex.GetType().Name}"); }
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(int dwProcessId);

    /// <summary>
    /// 更新で置き換えられた古いプロセスが終わるのを待つ(--after-update)。
    ///
    /// 待つのはWebView2の初期化より前、多重起動のMutexを取るより前。古い側の
    /// WebView2の子プロセス群とMutexが残っているうちに先へ進むと、初期化が返って
    /// こなくなったり「既に起動中」と誤判定したりする(<see cref="StartNewVersion"/>)。
    ///
    /// 相手が既に終わっていれば即座に戻る。何らかの理由で終わらない場合も、
    /// 起動できないままになるよりは進んだほうがよいので、上限を設けて打ち切る。
    /// </summary>
    public static void WaitForPreviousProcessExit(int processId)
    {
        const int TimeoutMs = 15000;
        try
        {
            using Process previous = Process.GetProcessById(processId);
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            if (previous.WaitForExit(TimeoutMs))
            {
                Logger.Write($"更新: 前のPane(PID={processId})の終了を確認した({stopwatch.ElapsedMilliseconds}ms)");
            }
            else
            {
                Logger.Warn($"更新: 前のPane(PID={processId})が{TimeoutMs}ms待っても終わらないため、待たずに続行する");
            }
        }
        catch (ArgumentException)
        {
            // 既に終了している(GetProcessByIdが見つけられない)。待つ必要は無い。
            Logger.Write($"更新: 前のPane(PID={processId})は既に終了していた");
        }
        catch (Exception ex)
        {
            Logger.WriteException($"更新: 前のPane(PID={processId})の終了待ちに失敗(続行する)", ex);
        }
    }

    /// <summary>
    /// 「たった今更新された」とみなす猶予。これを過ぎた退避ファイルは、消しそこねた
    /// 古い残骸として扱う(下の<see cref="LooksLikeJustUpdated"/>参照)。
    /// </summary>
    private static readonly TimeSpan JustUpdatedWindow = TimeSpan.FromMinutes(5);

    /// <summary>
    /// 直前に更新が行われた形跡があるかどうか(退避ファイルが残っているか)。
    ///
    /// <see cref="ApplyUpdate"/>が退避したファイルは、次の起動で
    /// <see cref="CleanupLeftovers"/>が消すまで残る。つまり起動時にこれが在るということは、
    /// 「更新のあと初めての起動」だと判断できる。
    ///
    /// ただし、何らかの理由で削除が失敗し続けると残骸がずっと居座ることになる。それを
    /// 「更新直後」と見なしてしまうと、通常の多重起動(2枚目のウィンドウを開く等)のたびに
    /// 他プロセスの終了を待って何秒も足止めしてしまう。そうならないよう、置かれてから
    /// <see cref="JustUpdatedWindow"/>以内のものだけを対象にする。
    /// </summary>
    private static bool LooksLikeJustUpdated(string folder)
    {
        DateTime threshold = DateTime.UtcNow - JustUpdatedWindow;

        // 退避ファイルの時刻。退避する側(ApplyUpdate)が「今」に直しているのが前提だが、
        // その処理が無い版(v1.0.6以前)から更新された場合は元のビルド日時のままになる。
        // そのため、これだけに頼らず下の判定も併せて見る。
        string exeBackup = Path.Combine(folder, "Pane.exe" + BackupSuffix);
        bool exeBackupExists = File.Exists(exeBackup);
        if (exeBackupExists && File.GetLastWriteTimeUtc(exeBackup) > threshold) return true;

        string distBackup = Path.Combine(folder, "dist" + BackupSuffix);
        bool distBackupExists = Directory.Exists(distBackup);
        if (distBackupExists && Directory.GetLastWriteTimeUtc(distBackup) > threshold) return true;

        // 退避ファイルが在るのに時刻が古い場合の受け皿。いま動いている自分自身が、
        // ついさっき置かれたファイルかどうかを見る。入れ替えはFile.Copyで新しく作るため、
        // 更新直後であれば作成時刻が「今」になっている。
        if (!exeBackupExists && !distBackupExists) return false;
        try
        {
            string? self = Environment.ProcessPath;
            return self is not null && File.GetCreationTimeUtc(self) > threshold;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 更新直後の起動で、入れ替えられた古いPaneがまだ動いていれば、その終了を待つ。
    ///
    /// <see cref="StartNewVersion"/>は起動する側が新しい側へPIDを伝える仕組み(--after-update)
    /// だが、それが効くのは「更新を実行する側」にこの仕組みが入っている場合だけ。
    /// v1.0.5からv1.0.6へ更新したときのように、古い側にまだ無い版から起動されると
    /// 引数は渡ってこない。実機ではそれで新しい側のWebView2の初期化が返らなくなった。
    ///
    /// そこで、引数に頼らず自分で気づけるようにしておく。判断材料は2つ。
    ///   ・退避ファイルが残っている(=更新のあと初めての起動)
    ///   ・同じ場所のPane.exeで動いている別のプロセスがいる
    /// 両方そろったときだけ待つ。通常の多重起動(2枚目のウィンドウを開く等)では
    /// 退避ファイルが無いので、ここで待たされることはない。
    /// </summary>
    public static void WaitForPreviousProcessExitAfterUpdate()
    {
        try
        {
            string? folder = Path.GetDirectoryName(Environment.ProcessPath ?? "");
            if (string.IsNullOrEmpty(folder) || !LooksLikeJustUpdated(folder)) return;

            int selfId = Environment.ProcessId;
            Process[] candidates = Process.GetProcessesByName("Pane");
            try
            {
                foreach (Process other in candidates)
                {
                    if (other.Id == selfId) continue;
                    // 別の場所に置かれたPaneは無関係なので、実行ファイルの場所で絞る。
                    // MainModuleは権限等で読めないことがあるため、読めなければ対象外にする。
                    string? otherPath = TryGetProcessPath(other);
                    if (otherPath is null) continue;
                    if (!string.Equals(Path.GetDirectoryName(otherPath), folder, StringComparison.OrdinalIgnoreCase)) continue;

                    Logger.Write($"更新直後の起動: 同じ場所の古いPane(PID={other.Id})がまだ動いているので終了を待つ");
                    WaitForPreviousProcessExit(other.Id);
                }
            }
            finally
            {
                foreach (Process p in candidates) p.Dispose();
            }
        }
        catch (Exception ex)
        {
            // 待てなくても起動は続ける(待つのはあくまで安全側の措置)。
            Logger.WriteException("更新直後の起動: 古いPaneの確認に失敗(続行する)", ex);
        }
    }

    /// <summary>退避したファイル・フォルダの最終更新時刻を「今」にする。失敗しても
    /// 待機の判断材料が1つ減るだけなので、入れ替え自体は続ける。</summary>
    private static void TrySetJustMovedTimestamp(string path, bool isDirectory)
    {
        try
        {
            if (isDirectory) Directory.SetLastWriteTimeUtc(path, DateTime.UtcNow);
            else File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
        }
        catch (Exception ex)
        {
            Logger.Debug($"更新の適用: 退避先の時刻を更新できなかった({path}): {ex.GetType().Name}");
        }
    }

    private static string? TryGetProcessPath(Process process)
    {
        try { return process.MainModule?.FileName; }
        catch { return null; }
    }

    /// <summary>
    /// 起動時の更新確認(仕様書 U-06)。条件を満たすときだけ問い合わせ、新しい版が
    /// 見つかった場合にかぎり結果を返す。それ以外(設定オフ・今日は確認済み・最新だった・
    /// 確認できなかった)はnullを返し、画面には何も出さない。
    ///
    /// 「確認できなかった」を黙って捨てるのは、起動のたびに通信の失敗を利用者へ見せても
    /// できることが無いため(手動の「更新を確認」なら理由を表示する)。ログには残す。
    ///
    /// 確認したという記録(<see cref="AppSettings.LastUpdateCheckedOn"/>)は、結果に
    /// かかわらず問い合わせを試みた時点で残す。配布元へ繋がらない状態が続いたときに、
    /// 起動のたびに何度も試してしまうのを防ぐため。
    /// </summary>
    public static async Task<UpdateCheckResult?> CheckOnStartupAsync()
    {
        AppSettings settings = SettingsService.Load();
        if (!settings.CheckUpdateOnStartup)
        {
            Logger.Debug("起動時の更新確認: 設定がオフのため行わない");
            return null;
        }

        string today = DateTime.Now.ToString("yyyy-MM-dd");
        if (string.Equals(settings.LastUpdateCheckedOn, today, StringComparison.Ordinal))
        {
            Logger.Debug($"起動時の更新確認: 今日({today})は確認済みのため行わない");
            return null;
        }

        Logger.Write($"起動時の更新確認: 前回={(string.IsNullOrEmpty(settings.LastUpdateCheckedOn) ? "なし" : settings.LastUpdateCheckedOn)}, 今日={today}");
        SettingsService.Update(s => s.LastUpdateCheckedOn = today);

        UpdateCheckResult result = await CheckAsync(settings);
        if (result.Status != "available")
        {
            // 最新だった/確認できなかった。どちらも画面には出さない。
            return null;
        }
        return result;
    }

    /// <summary>
    /// 前回の更新で退避したファイルを削除する。起動時に一度だけ呼ぶ。
    ///
    /// 更新直後の起動では、まだ古いプロセスが終了しきっていないことがある。その場合は
    /// 削除に失敗するが、次の起動でまた試すので放置してよい(エラーとして騒がない)。
    /// </summary>
    public static void CleanupLeftovers()
    {
        try
        {
            string? folder = Path.GetDirectoryName(Environment.ProcessPath ?? "");
            if (string.IsNullOrEmpty(folder)) return;

            string exeBackup = Path.Combine(folder, "Pane.exe" + BackupSuffix);
            string distBackup = Path.Combine(folder, "dist" + BackupSuffix);
            bool removed = false;

            if (File.Exists(exeBackup)) { removed |= TryDelete(exeBackup); }
            if (Directory.Exists(distBackup)) { removed |= TryDeleteDirectory(distBackup); }
            if (removed) Logger.Write("更新: 前回の更新で退避した古いファイルを削除した");
        }
        catch (Exception ex)
        {
            Logger.Debug($"更新: 退避ファイルの掃除に失敗(次回また試す): {ex.GetType().Name}");
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(dir.Replace(source, destination));
        }
        foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            File.Copy(file, file.Replace(source, destination), overwrite: true);
        }
    }

    private static bool TryDelete(string path)
    {
        try { if (File.Exists(path)) { File.Delete(path); return true; } }
        catch { /* 掴まれている等。次回に持ち越す */ }
        return false;
    }

    private static bool TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) { Directory.Delete(path, recursive: true); return true; } }
        catch { /* 同上 */ }
        return false;
    }

    private static void TryMove(string from, string to)
    {
        try { if (File.Exists(from)) File.Move(from, to); }
        catch (Exception ex) { Logger.WriteException($"更新のロールバックに失敗: {from} → {to}", ex); }
    }

    private static void TryMoveDirectory(string from, string to)
    {
        try { if (Directory.Exists(from)) Directory.Move(from, to); }
        catch (Exception ex) { Logger.WriteException($"更新のロールバックに失敗: {from} → {to}", ex); }
    }
}
