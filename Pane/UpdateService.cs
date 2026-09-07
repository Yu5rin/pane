using System.Diagnostics;
using System.IO.Compression;
using System.Net;
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
    /// <summary>1回の問い合わせのタイムアウト。確認は軽い問い合わせなので短くてよい。</summary>
    private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(15);

    /// <summary>
    /// 確認全体のタイムアウト。Atomフィードとリリース情報の2回を問い合わせるため、
    /// それぞれに <see cref="CheckTimeout"/> を掛けると最悪30秒待たされる。
    ///
    /// 設定画面の「更新を確認」を押した人はその間ずっと待つことになるし、
    /// ネットワークが繋がっていない場所ではその30秒がまるごと無駄になる。
    /// 全体としてここで打ち切る。
    /// </summary>
    private static readonly TimeSpan TotalCheckTimeout = TimeSpan.FromSeconds(20);

    /// <summary>
    /// Atomフィード1回ぶんのタイムアウト。フィードは数KBの軽い応答なので、これを超えて
    /// 待つ意味は薄い。早めに見切って、残り時間をリリース情報の問い合わせへ回す。
    /// </summary>
    private static readonly TimeSpan AtomTimeout = TimeSpan.FromSeconds(8);

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
        // Acceptは要求ごとに付ける。以前はここで "application/vnd.github+json" を
        // 既定にしていたため、Zipを取りに行く要求にまで「JSONをください」と言っていた。
        // GitHub自体は無視するが、中身とヘッダの不一致を見る経路(会社のプロキシ等)を
        // 通るときに弾かれる余地を残す必要は無い。
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

        Version? current = UpdateCheckLogic.ParseVersion(currentVersionText);
        if (current is null)
        {
            Logger.Warn($"更新の確認: 自分のバージョンを読み取れなかった: \"{currentVersionText}\"");
            return Error(currentVersionText, "いま動いているPaneのバージョンを判別できませんでした。");
        }

        // Atomで「新しい版がある」と分かった場合の控え。このあとAPIへ詳細を取りに行くが、
        // そちらが上限や障害で失敗しても、分かっているところまでは利用者へ伝えたい
        // (「新しい版がある」ことと、リリースページの場所)。
        string? knownNewerTag = null;
        string knownReleaseUrl = "";

        // 確認全体の制限時間。Atomとリリース情報の2回ぶんをまとめてここで打ち切る
        // (TotalCheckTimeoutのコメント参照)。
        using var totalCts = new CancellationTokenSource(TotalCheckTimeout);

        try
        {
            using var _ = PerfWatch.Start("更新の確認(問い合わせ)", 5000);

            // まずAtomフィードで最新のタグだけを見る。GitHubのAPIには1時間60回(未認証)の
            // 上限があり、これは端末ごとではなくIPアドレスごとに数えられる。会社などの
            // 共有回線では他の通信で先に使い切られてしまい、実機のログでは更新の確認が
            // 5回とも403(rate limit exceeded)で失敗していた。Atomフィードはその上限とは
            // 別枠のため、普段の確認をこちらに寄せる。
            //
            // 新しい版が見つかったときだけAPIを呼び、SHA256とダウンロードURLを取りに行く。
            // 呼ぶ頻度が「更新があったとき」だけになるので、上限に当たる見込みはまず無い。
            //
            // 既知の非対称: Atomフィードはプレリリースも載せるが、APIの releases/latest は
            // 安定版だけを返す。プレリリースが最新の間は「Atomでは新しい・APIでは最新版」と
            // なって毎回APIまで進む(節約が効かない)し、APIが上限で失敗すると下の
            // NewerButNoDetailsがプレリリースを案内してしまう。このリポジトリは
            // プレリリースを使わない運用なので許容している。使い始めるならAtomの
            // entryを除外する条件が要る。
            string? atomUrl = UpdateCheckLogic.TryBuildAtomUrl(url);
            if (atomUrl is not null)
            {
                string? tagFromAtom = await TryReadLatestTagFromAtomAsync(atomUrl, totalCts.Token);
                if (tagFromAtom is not null)
                {
                    Version? latestFromAtom = UpdateCheckLogic.ParseVersion(tagFromAtom);
                    if (latestFromAtom is null)
                    {
                        Logger.Warn($"更新の確認: 配布元のバージョン表記を読み取れなかった: \"{tagFromAtom}\"");
                        return Error(currentVersionText, "配布元のバージョン表記を読み取れませんでした。");
                    }
                    if (latestFromAtom <= current)
                    {
                        Logger.Write($"更新の確認: 最新版だった(現在={currentVersionText}, 配布元={tagFromAtom}, 問い合わせ先=Atom)");
                        return new UpdateCheckResult("latest", currentVersionText, tagFromAtom, "", "", 0,
                            UpdateCheckLogic.BuildReleasePageUrl(atomUrl, tagFromAtom), "お使いのPaneは最新版です。");
                    }
                    Logger.Write($"更新の確認: 新しい版がある(現在={currentVersionText}, 配布元={tagFromAtom}, 問い合わせ先=Atom)。詳細をAPIへ問い合わせる");
                    knownNewerTag = tagFromAtom;
                    knownReleaseUrl = UpdateCheckLogic.BuildReleasePageUrl(atomUrl, tagFromAtom);
                }
            }

            Logger.Write($"更新の確認: 問い合わせ先={url}");
            // 1回ぶんの上限(CheckTimeout)と全体の上限(totalCts)の、早く来たほうで打ち切る。
            using var apiCts = CancellationTokenSource.CreateLinkedTokenSource(totalCts.Token);
            apiCts.CancelAfter(CheckTimeout);
            // GitHub APIへの要求。Acceptは要求ごとに付ける(CreateHttpClientのコメント参照)。
            using var apiRequest = new HttpRequestMessage(HttpMethod.Get, url);
            apiRequest.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
            using HttpResponseMessage apiResponse = await Http.SendAsync(apiRequest, apiCts.Token);
            apiResponse.EnsureSuccessStatusCode();
            string json = await apiResponse.Content.ReadAsStringAsync(apiCts.Token);

            using JsonDocument doc = JsonDocument.Parse(json);
            JsonElement root = doc.RootElement;

            string tag = root.TryGetProperty("tag_name", out JsonElement tagProp) ? tagProp.GetString() ?? "" : "";
            string releaseUrl = root.TryGetProperty("html_url", out JsonElement pageProp) ? pageProp.GetString() ?? "" : "";
            (string assetUrl, string sha256, long size) = FindZipAsset(root);

            Version? latest = UpdateCheckLogic.ParseVersion(tag);
            if (latest is null)
            {
                Logger.Warn($"更新の確認: 配布元のバージョン表記を読み取れなかった: \"{tag}\"");
                return Error(currentVersionText, "配布元のバージョン表記を読み取れませんでした。");
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
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.Forbidden)
        {
            // 問い合わせ回数の上限。何が起きたのかを利用者の言葉で伝える(「403」とだけ
            // 出しても、自分の操作が原因ではないことが分からない)。
            Logger.Warn("更新の確認: 問い合わせ回数の上限に達していた(403)");
            if (knownNewerTag is not null) return NewerButNoDetails(currentVersionText, knownNewerTag, knownReleaseUrl);
            return Error(currentVersionText,
                "配布元への問い合わせが、回数の上限に達していました。この上限は同じネットワークを使う人たちで共有されるため、" +
                "自分が何度も押していなくても起こります。しばらく時間をおくか、リリースページから直接ご確認ください。");
        }
        catch (Exception ex)
        {
            // 利用者に見せる文言から例外の型名を外す(総点検 指摘: 「更新を確認できません
            // でした(HttpRequestException)」等、型名が生で出ていて次に何をすればいいか
            // 伝わらなかった)。詳細はLogger.WriteExceptionが型名・メッセージ・スタック
            // トレースまで含めて残すので、調査に必要な情報は失われない。
            Logger.WriteException("更新の確認に失敗", ex);
            if (knownNewerTag is not null) return NewerButNoDetails(currentVersionText, knownNewerTag, knownReleaseUrl);
            return Error(currentVersionText, $"更新を確認できませんでした。{ExceptionMessages.Describe(ex)}");
        }
    }

    /// <summary>
    /// 「新しい版があることは分かったが、配布物の詳細までは取れなかった」ときの結果。
    ///
    /// ダウンロードURLが無いので自動での入れ替えはできない。画面では「更新する」ボタンを
    /// 出さず、リリースページへの導線だけを見せる(canApplyはDownloadUrlの有無で決まる)。
    /// 黙って「確認できませんでした」にしてしまうと、更新があること自体が伝わらない。
    /// </summary>
    private static UpdateCheckResult NewerButNoDetails(string currentVersion, string tag, string releaseUrl)
    {
        Logger.Write($"更新の確認: 新しい版({tag})はあるが、配布物の詳細を取れなかった。手動更新を案内する");
        return new UpdateCheckResult("available", currentVersion, tag, "", "", 0, releaseUrl,
            $"新しい版 {tag} があります。ただし配布元が混み合っていて、自動で入れ替えるための情報を取れませんでした。" +
            "リリースページからダウンロードしてください(しばらく待てば自動更新も使えるようになります)。");
    }

    /// <summary>
    /// Atomフィードから、いちばん新しいリリースのタグ名を読み取る。読めなければnullを返し、
    /// 呼び出し元はAPIへの問い合わせへ進む(こちらが使えなくても更新の確認そのものは
    /// できたほうがよいため、失敗を致命的に扱わない)。
    ///
    /// 前回と同じ内容なら本文を受け取らずに済ませる。フィードには前回受け取ったときの
    /// 目印(ETag)が付いており、それを添えて尋ねると、変わっていなければ配布元は
    /// 「304 変更なし」だけを返す。起動のたびに確認する作りなので、多くの場合はこちらになる。
    /// 数KBとはいえ毎回受け取る必要はなく、配布元にも自分の回線にも余計な負荷をかけない。
    /// </summary>
    /// <param name="outerToken">確認全体の制限時間。これとAtom個別の上限の早い方で打ち切る。</param>
    private static async Task<string?> TryReadLatestTagFromAtomAsync(string atomUrl, CancellationToken outerToken)
    {
        AppSettings settings = SettingsService.Load();
        string? knownETag = settings.UpdateFeedETag;
        string? knownTag = settings.UpdateFeedLatestTag;

        try
        {
            Logger.Debug($"更新の確認: Atomフィードへ問い合わせる: {atomUrl}");
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(outerToken);
            cts.CancelAfter(AtomTimeout);

            // 既定のAcceptヘッダ(GitHub APIのJSON)のままでは意図が合わないので、この要求にだけ
            // Atom用のAcceptを付ける。
            using var request = new HttpRequestMessage(HttpMethod.Get, atomUrl);
            request.Headers.Accept.Clear();
            request.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/atom+xml"));

            // 前回の目印と、そのとき読み取ったタグの両方が揃っているときだけ使う。
            // 目印だけあってタグが無いと、304が返ってきても答えようがない。
            bool canUseETag = !string.IsNullOrEmpty(knownETag) && !string.IsNullOrEmpty(knownTag);
            if (canUseETag)
            {
                request.Headers.TryAddWithoutValidation("If-None-Match", knownETag);
            }

            using HttpResponseMessage response = await Http.SendAsync(request, cts.Token);

            if (response.StatusCode == System.Net.HttpStatusCode.NotModified && canUseETag)
            {
                Logger.Write($"更新の確認: Atomフィードは前回から変わっていない(304)。前回のタグを使う({knownTag})");
                return knownTag;
            }

            response.EnsureSuccessStatusCode();
            string xml = await response.Content.ReadAsStringAsync(cts.Token);
            string? tag = UpdateCheckLogic.ExtractLatestTagFromAtom(xml);

            RememberFeedState(response.Headers.ETag?.Tag, tag);
            return tag;
        }
        catch (Exception ex)
        {
            // ここで失敗してもAPI側で確認できる。騒がずに次へ進む。
            Logger.Debug($"更新の確認: Atomフィードを読めなかった({ex.GetType().Name})。APIへ問い合わせる");
            return null;
        }
    }

    /// <summary>
    /// Atomフィードの目印(ETag)と、そのとき読み取ったタグを控える。次回の確認で
    /// 「前回から変わっていないか」を尋ねるために使う。
    /// どちらかが欠けていると次回に使えないため、両方揃ったときだけ保存する。
    /// </summary>
    private static void RememberFeedState(string? etag, string? tag)
    {
        if (string.IsNullOrEmpty(etag) || string.IsNullOrEmpty(tag)) return;
        try
        {
            SettingsService.Update(s =>
            {
                s.UpdateFeedETag = etag;
                s.UpdateFeedLatestTag = tag;
            });
        }
        catch (Exception ex)
        {
            // 控えられなくても、次回そのまま全部受け取るだけで支障はない。
            Logger.Debug($"更新の確認: フィードの目印を控えられなかった: {ex.GetType().Name}");
        }
    }

    private static UpdateCheckResult Error(string currentVersion, string message)
        => new("error", currentVersion, "", "", "", 0, "", message);

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
        LogNetworkEnvironmentOnce(info.DownloadUrl);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(DownloadTimeout);

        long receivedBytes = 0;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, info.DownloadUrl);
            // Zipを取りに行く要求なので、JSONではなくバイト列を要求する。
            request.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/octet-stream"));
            using HttpResponseMessage response = await Http.SendAsync(
                request, HttpCompletionOption.ResponseHeadersRead, cts.Token);

            // 【何のためのログか】会社のPCで「確認はできるがダウンロードだけ失敗する」
            // という報告があり、原因の切り分けにはここが要る
            // (docs/調査記録/修正-更新の失敗を追えるようにする.md)。
            //   ・最終URL … github.com は objects.githubusercontent.com へ転送される。
            //                転送先だけ許可されていない構成かどうかが分かる
            //   ・状態コード … 403(拒否)・407(プロキシ認証)の区別
            //   ・Content-Type … 中身がZipではなくプロキシのエラーページに
            //                    すり替わっていないか(text/html なら典型的にそれ)
            //   ・Via / X-Cache … 途中に中継が入っているか
            string finalUrl = response.RequestMessage?.RequestUri?.ToString() ?? "(不明)";
            string contentType = response.Content.Headers.ContentType?.ToString() ?? "(なし)";
            string via = response.Headers.TryGetValues("Via", out var viaValues) ? string.Join(",", viaValues) : "(なし)";
            Logger.Write($"更新のダウンロード: 応答 {(int)response.StatusCode} {response.StatusCode}, " +
                         $"Content-Type={contentType}, Content-Length={response.Content.Headers.ContentLength?.ToString() ?? "(なし)"}, " +
                         $"Via={via}");
            if (!string.Equals(finalUrl, info.DownloadUrl, StringComparison.Ordinal))
            {
                Logger.Write($"更新のダウンロード: 転送先={finalUrl}");
            }
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
                    receivedBytes = received;
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
        catch (Exception ex)
        {
            // ここで必ず記録する。以前は握らずthrowするだけで、呼び出し元(SettingsBridge)の
            // ログには「更新の適用に失敗」としか残らず、ダウンロードのどこで落ちたのか
            // (そもそも繋がらなかったのか、途中で切れたのか)が分からなかった。
            Logger.Error($"更新のダウンロードに失敗: {ExceptionDetail.Summarize(ex)} " +
                         $"(受信済み {receivedBytes}バイト / 想定 {info.SizeBytes}バイト)");
            TryDeleteDirectory(directory);
            throw;
        }
    }

    /// <summary>この起動で1回だけ、通信環境をログに残したか。</summary>
    private static bool _networkEnvironmentLogged;

    /// <summary>
    /// 通信がどの経路を通るのかをログに残す(この起動で1回だけ)。
    ///
    /// 会社のネットワークでは、Windowsの設定やPACファイルによってプロキシ経由になることが
    /// 多い。プロキシを通っているのかどうかが分かるだけで、切り分けの幅がかなり狭まる。
    /// アドレス自体は社内のホスト名なので、既定のログにはホストとポートだけを出す。
    /// </summary>
    private static void LogNetworkEnvironmentOnce(string url)
    {
        if (_networkEnvironmentLogged) return;
        _networkEnvironmentLogged = true;
        try
        {
            var target = new Uri(url);
            IWebProxy proxy = HttpClient.DefaultProxy;
            Uri? via = proxy.GetProxy(target);
            if (via is null)
            {
                Logger.Write($"更新の通信: プロキシを経由しない(宛先 {target.Host})");
            }
            else
            {
                Logger.Write($"更新の通信: プロキシを経由する({via.Host}:{via.Port}, 宛先 {target.Host}, " +
                             $"資格情報={(proxy.Credentials is null ? "なし" : "あり")})");
            }
        }
        catch (Exception ex)
        {
            Logger.Debug($"更新の通信: 経路を調べられなかった: {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// ダウンロードしたファイルのSHA256を照合する。期待値が空の場合は照合を省く
    /// (配布元がハッシュを提供していないケース。HTTPSで取得しているため通信路自体は保護されている)。
    ///
    /// 【この照合が防げるもの・防げないもの】(docs/調査記録/点検-セキュリティ.md C-2)
    /// ここで比較するハッシュ値(<see cref="FindZipAsset"/>が読む<c>digest</c>)は、Zip本体と
    /// 同じGitHub API・同じリリースから取得している。つまり「転送中に破損していないか」の
    /// 検出はできるが、GitHub上の配布元(リポジトリ・アカウント)そのものが乗っ取られて
    /// Zipが差し替えられた場合は、ハッシュ値も一緒に差し替わった値を返してくるため
    /// 検出できない。ファイルへの署名(コード署名)による検証も行っていない。
    /// README・取扱説明書には、この限界を含めて実際の保証範囲を明記してある。
    /// </summary>
    private static void VerifyHash(string zipPath, string expected)
    {
        if (string.IsNullOrWhiteSpace(expected))
        {
            // 過去のリリース(GitHubのdigest機能が付く前に作られたもの)や、updateCheckUrlを
            // 差し替えた別配布元ではdigestが無いことがある。照合を省いてそのまま展開まで
            // 進める(自動更新自体を止めない)判断は変えていないが、「無保証で展開している」
            // ことが後から追いにくいログにならないよう、Warnで残す(docs/調査記録/点検-セキュリティ.md C-2)。
            Logger.Warn("更新の検証: 配布元がSHA256(digest)を提供していないため照合を省いて続行する");
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
            // 判断できない(TryGetReplacementTimeUtc参照)。
            TrySetJustMovedTimestamp(exeBackup, isDirectory: false);

            if (Directory.Exists(currentDist))
            {
                Directory.Move(currentDist, distBackup);
                distMoved = true;
                TrySetJustMovedTimestamp(distBackup, isDirectory: true);
            }

            File.Copy(newExe, currentExe);
            CopyDirectory(newDist, currentDist);
            WarmUpDist(currentDist);

            // 入れ替えを最後までやり遂げた合図。ここより前(File.Copy/CopyDirectoryの途中)で
            // 電源断・強制終了が起きればこのマーカーは書かれず、次回起動のCleanupLeftoversは
            // 「入れ替えが未完了」と判断して退避ファイル(exeBackup/distBackup)を消さずに残す
            // (UpdateLeftoverPolicy参照。退避ファイルはdistが欠けた状態を直す唯一の材料のため、
            // 迷ったら消さない側に倒す)。
            WriteCompletionMarker(installFolder);

            Logger.Write("更新の適用: 入れ替えが完了した");

            // ダウンロードしたZipと展開した中身を片付ける。ここで消さないと、更新のたびに
            // 一時フォルダへ数百MB(Zip 75MB + 展開後のexe・dist)が残り続ける。
            // 加えて、更新直後は置いたばかりのファイルがウイルス対策の走査対象になるため、
            // 不要な分を先に減らしておくと新しいPaneの初回起動が軽くなる。
            TryDeleteDirectory(Path.GetDirectoryName(zipPath) ?? "");
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
    /// 古い残骸として扱う(下の<see cref="TryGetReplacementTimeUtc"/>参照)。
    /// </summary>
    private static readonly TimeSpan JustUpdatedWindow = TimeSpan.FromMinutes(5);

    /// <summary>
    /// 直前に更新が行われた形跡があれば、その入れ替えが起きた時刻を返す(無ければnull)。
    ///
    /// <see cref="ApplyUpdate"/>が退避したファイルは、次の起動で
    /// <see cref="CleanupLeftovers"/>が消すまで残る。つまり起動時にこれが在るということは、
    /// 「更新のあと初めての起動」だと判断できる。
    ///
    /// ただし、何らかの理由で削除が失敗し続けると残骸がずっと居座ることになる。それを
    /// 「更新直後」と見なしてしまうと、通常の多重起動(2枚目のウィンドウを開く等)のたびに
    /// 他プロセスの終了を待って何秒も足止めしてしまう。そうならないよう、置かれてから
    /// <see cref="JustUpdatedWindow"/>以内のものだけを対象にする。
    ///
    /// 戻り値の時刻は、待つ相手を絞り込むためにも使う
    /// (<see cref="UpdateProcessWaitPolicy"/>参照)。
    /// </summary>
    private static DateTime? TryGetReplacementTimeUtc(string folder)
    {
        DateTime threshold = DateTime.UtcNow - JustUpdatedWindow;

        // 退避ファイルの時刻。退避する側(ApplyUpdate)が「今」に直しているのが前提だが、
        // その処理が無い版(v1.0.6以前)から更新された場合は元のビルド日時のままになる。
        // そのため、これだけに頼らず下の判定も併せて見る。
        string exeBackup = Path.Combine(folder, "Pane.exe" + BackupSuffix);
        bool exeBackupExists = File.Exists(exeBackup);
        DateTime? newest = exeBackupExists ? File.GetLastWriteTimeUtc(exeBackup) : null;

        string distBackup = Path.Combine(folder, "dist" + BackupSuffix);
        bool distBackupExists = Directory.Exists(distBackup);
        if (distBackupExists)
        {
            DateTime distTime = Directory.GetLastWriteTimeUtc(distBackup);
            if (newest is null || distTime > newest.Value) newest = distTime;
        }

        if (newest is DateTime backupTime && backupTime > threshold) return backupTime;

        // 退避ファイルが在るのに時刻が古い場合の受け皿。いま動いている自分自身が、
        // ついさっき置かれたファイルかどうかを見る。入れ替えはFile.Copyで新しく作るため、
        // 更新直後であれば作成時刻が「今」になっている。
        if (!exeBackupExists && !distBackupExists) return null;
        try
        {
            string? self = Environment.ProcessPath;
            if (self is null) return null;
            DateTime created = File.GetCreationTimeUtc(self);
            return created > threshold ? created : null;
        }
        catch
        {
            return null;
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
            if (string.IsNullOrEmpty(folder)) return;
            if (TryGetReplacementTimeUtc(folder) is not DateTime replacedAtUtc) return;

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

                    // 入れ替えより後に起動した相手は現役の常駐プロセスであって、
                    // 入れ替えられた古いプロセスではない(UpdateProcessWaitPolicy参照)。
                    DateTime? otherStartUtc = TryGetProcessStartTimeUtc(other);
                    if (!UpdateProcessWaitPolicy.ShouldWait(replacedAtUtc, otherStartUtc))
                    {
                        Logger.Write($"更新直後の起動: 同じ場所のPane(PID={other.Id})は入れ替えより後に起動しているので待たない");
                        continue;
                    }

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

    /// <summary>プロセスの起動時刻(UTC)。権限等で読めなければnull。</summary>
    private static DateTime? TryGetProcessStartTimeUtc(Process process)
    {
        try { return process.StartTime.ToUniversalTime(); }
        catch { return null; }
    }

    /// <summary>
    /// 起動時の更新確認(仕様書 U-06)。設定が有効なら毎回の起動で問い合わせ、新しい版が
    /// 見つかった場合にかぎり結果を返す。それ以外(設定オフ・最新だった・確認できなかった)は
    /// nullを返し、画面には何も出さない。
    ///
    /// 「確認できなかった」を黙って捨てるのは、起動のたびに通信の失敗を利用者へ見せても
    /// できることが無いため(手動の「更新を確認」なら理由を表示する)。ログには残す。
    /// </summary>
    public static async Task<UpdateCheckResult?> CheckOnStartupAsync()
    {
        AppSettings settings = SettingsService.Load();
        if (!settings.CheckUpdateOnStartup)
        {
            Logger.Debug("起動時の更新確認: 設定がオフのため行わない");
            return null;
        }

        Logger.Write("起動時の更新確認: 開始");
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
    ///
    /// 削除してよいかどうかは<see cref="UpdateLeftoverPolicy"/>の判定に従う。完了マーカーが
    /// 無い(=前回の入れ替えがdistのコピー途中などで力尽きた)場合は、消してしまうと
    /// 復旧の材料が無くなるため、退避ファイルには一切触れない
    /// (docs/調査記録/点検-機能と動作.md「更新の入れ替え途中の電源断で復旧不能」)。
    /// </summary>
    public static void CleanupLeftovers()
    {
        try
        {
            string? folder = Path.GetDirectoryName(Environment.ProcessPath ?? "");
            if (string.IsNullOrEmpty(folder)) return;

            string exeBackup = Path.Combine(folder, "Pane.exe" + BackupSuffix);
            string distBackup = Path.Combine(folder, "dist" + BackupSuffix);
            string marker = Path.Combine(folder, UpdateLeftoverPolicy.CompletionMarkerFileName);

            bool exeBackupExists = File.Exists(exeBackup);
            bool distBackupExists = Directory.Exists(distBackup);
            bool markerExists = File.Exists(marker);

            // マーカーが無い場合の追加の手がかり(UpdateLeftoverPolicy.Decideの説明を参照)。
            DateTime? backupTimeUtc = TryGetBackupTimeUtc(exeBackup, exeBackupExists, distBackup, distBackupExists);
            TimeSpan? backupAge = backupTimeUtc is DateTime t ? DateTime.UtcNow - t : null;
            bool currentExeIsNewer = backupTimeUtc is DateTime bt && IsCurrentExeNewerThan(bt);

            switch (UpdateLeftoverPolicy.Decide(
                exeBackupExists, distBackupExists, markerExists, backupAge, currentExeIsNewer))
            {
                case UpdateLeftoverPolicy.Action.DeleteBackups:
                    bool removed = false;
                    if (exeBackupExists) removed |= TryDelete(exeBackup);
                    if (distBackupExists) removed |= TryDeleteDirectory(distBackup);
                    TryDelete(marker);
                    if (removed) Logger.Write("更新: 前回の更新で退避した古いファイルを削除した");
                    break;

                case UpdateLeftoverPolicy.Action.DeleteStaleBackups:
                    // 完了マーカーが無い版で更新した環境の残骸。入れ替えは実際には
                    // 終わっているので、警告を出さずに片付ける。
                    bool staleRemoved = false;
                    if (exeBackupExists) staleRemoved |= TryDelete(exeBackup);
                    if (distBackupExists) staleRemoved |= TryDeleteDirectory(distBackup);
                    if (staleRemoved) Logger.Write("更新: 古い版で更新したときの退避ファイルを削除した");
                    break;

                case UpdateLeftoverPolicy.Action.KeepBackups:
                    // 前回の入れ替えが完了しないまま終わっている。distが欠けている可能性が高いが、
                    // 退避ファイル(dist.pane-old等)さえ残っていれば手動で戻せるので、
                    // ここでは消さずに警告だけ残す(自動での戻し入れはしない: 実行中のexeを
                    // 自分自身で書き換える操作になり、かえって危険なため)。
                    Logger.Warn("更新: 前回の入れ替えが完了しないまま終了した形跡があるため、" +
                                "退避ファイル(*.pane-old)は削除せずに残す");
                    break;

                case UpdateLeftoverPolicy.Action.None:
                default:
                    // 退避ファイルは無いが、マーカーだけ残っていれば掃除しておく
                    // (通常は無いはずの組み合わせだが、念のため)。
                    if (markerExists) TryDelete(marker);
                    break;
            }

            CleanupTempFolders();
        }
        catch (Exception ex)
        {
            Logger.Debug($"更新: 退避ファイルの掃除に失敗(次回また試す): {ex.GetType().Name}");
        }
    }

    /// <summary>退避ファイルが置かれた時刻(UTC)。両方あれば新しいほう。読めなければnull。</summary>
    private static DateTime? TryGetBackupTimeUtc(string exeBackup, bool exeBackupExists, string distBackup, bool distBackupExists)
    {
        try
        {
            DateTime? newest = exeBackupExists ? File.GetLastWriteTimeUtc(exeBackup) : null;
            if (distBackupExists)
            {
                DateTime distTime = Directory.GetLastWriteTimeUtc(distBackup);
                if (newest is null || distTime > newest.Value) newest = distTime;
            }
            return newest;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>いま動いているexeが、指定時刻より後に置かれたものか。読めなければfalse(安全側)。</summary>
    private static bool IsCurrentExeNewerThan(DateTime timeUtc)
    {
        try
        {
            string? self = Environment.ProcessPath;
            return self is not null && File.GetCreationTimeUtc(self) > timeUtc;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 入れ替えを最後までやり遂げた合図を書く(<see cref="UpdateLeftoverPolicy"/>参照)。
    /// このファイル自体が書けなくても入れ替えそのものは完了しているため、失敗は無視する
    /// (最悪でも次回起動が「未完了」側に倒れて退避ファイルを消さないだけで、安全側)。
    /// </summary>
    private static void WriteCompletionMarker(string installFolder)
    {
        try
        {
            File.WriteAllText(
                Path.Combine(installFolder, UpdateLeftoverPolicy.CompletionMarkerFileName),
                DateTime.UtcNow.ToString("O"));
        }
        catch (Exception ex)
        {
            Logger.Debug($"更新: 完了マーカーの書き込みに失敗(次回起動時は退避ファイルを残す側になる): {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// 置いたばかりのdistを一度読み通しておく。
    ///
    /// 更新直後の初回起動が目に見えて遅くなる実測があった(実機ログでJS側の「バンドル評価」が
    /// 68ms→3255ms、WebView2コントロールの生成が280ms→2465ms)。置いたばかりのファイルは
    /// ウイルス対策の走査対象になり、初めて読むときにその完了を待たされるためと考えられる。
    ///
    /// ここで先に読み通しておくと、その待ちを「まだ画面を出していない今」に寄せられる。
    /// 新しいPaneが読む頃には走査が済んでいるので、初回起動の待ちが減る。
    /// 効果は実機ログの同じ2つの数字で確認できる。
    ///
    /// 失敗しても入れ替え自体には影響しないため、例外は握りつぶす。
    /// </summary>
    private static void WarmUpDist(string distFolder)
    {
        try
        {
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            long total = 0;
            int count = 0;
            var buffer = new byte[81920];
            foreach (string file in Directory.EnumerateFiles(distFolder, "*", SearchOption.AllDirectories))
            {
                try
                {
                    using FileStream stream = File.OpenRead(file);
                    while (stream.Read(buffer, 0, buffer.Length) > 0) { }
                    total += stream.Length;
                    count++;
                }
                catch { /* 1つ読めなくても続ける */ }
            }
            Logger.Write($"更新の適用: distを読み通した({count}ファイル, 約{total / (1024 * 1024)}MB, {stopwatch.ElapsedMilliseconds}ms)");
        }
        catch (Exception ex)
        {
            Logger.Debug($"更新の適用: distの読み通しに失敗(続行する): {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// 更新に使った一時フォルダ(<c>%TEMP%\pane-update-*</c>)のうち、残っているものを消す。
    ///
    /// 通常は入れ替えの直後に消えるが、その前に落ちた場合などは残る。1つあたり数百MBに
    /// なるので、起動のたびに拾って片付ける。今まさに別のPaneが使っている最中かもしれない
    /// ため、置かれてから1時間以上経ったものだけを対象にする。
    /// </summary>
    private static void CleanupTempFolders()
    {
        try
        {
            DateTime threshold = DateTime.UtcNow - TimeSpan.FromHours(1);
            int removed = 0;
            long freed = 0;
            foreach (string dir in Directory.EnumerateDirectories(Path.GetTempPath(), "pane-update-*"))
            {
                try
                {
                    if (Directory.GetCreationTimeUtc(dir) > threshold) continue;
                    long size = MeasureDirectorySize(dir);
                    if (!TryDeleteDirectory(dir)) continue;
                    removed++;
                    freed += size;
                }
                catch (Exception ex)
                {
                    Logger.Debug($"更新: 一時フォルダの削除に失敗({dir}): {ex.GetType().Name}");
                }
            }
            if (removed > 0)
            {
                Logger.Write($"更新: 残っていた一時フォルダを{removed}個削除した(約{freed / (1024 * 1024)}MB)");
            }
        }
        catch (Exception ex)
        {
            Logger.Debug($"更新: 一時フォルダの掃除に失敗(次回また試す): {ex.GetType().Name}");
        }
    }

    private static long MeasureDirectorySize(string dir)
    {
        try
        {
            long total = 0;
            foreach (string file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                try { total += new FileInfo(file).Length; } catch { /* 消えた等は数えない */ }
            }
            return total;
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>
    /// sourceの中身(サブフォルダ・ファイル)をdestinationへそのまま複製する。
    ///
    /// 不具合修正(docs/調査記録/点検-セキュリティ.md C-3): 以前は`path.Replace(source, destination)`で
    /// コピー先のパスを組み立てていたが、これは文字列置換であり「sourceという文字列が
    /// パスの途中にもう一度現れる」配置(例: source配下に同名のフォルダを含む
    /// "C:\pane-update-x\extracted\pane-update-x\..."のような入れ子)では、意図しない
    /// 箇所まで置換してしまい、コピー先のパスが壊れる。source・destinationとも
    /// %TEMP%配下にPane自身が作るGUID付きフォルダ名なので今のところ衝突は起きないが、
    /// パス文字列の一致に頼らず`Path.GetRelativePath`でsourceからの相対パスを
    /// 計算してからdestinationへ繋ぐのが定石であり、堅牢性の面で直しておく。
    /// </summary>
    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, dir)));
        }
        foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            File.Copy(file, Path.Combine(destination, Path.GetRelativePath(source, file)), overwrite: true);
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
