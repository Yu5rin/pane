using System.Text.RegularExpressions;

namespace Pane;

/// <summary>グローバル検索の1ヒット。
/// Columnは元の行における列番号(1始まり)。将来ステータスバー等で使う可能性があるため
/// 情報として残すが、LineText中の強調位置には使わない(LineTextはTruncateLineで
/// 切り詰められており、Columnとインデックス基準がずれるため)。
/// LineText中での強調にはMatchOffset/MatchLengthを使うこと。</summary>
internal sealed record SearchHit(
    string Path,
    string Name,
    string RelativePath,
    int Line,
    int Column,
    string LineText,
    int MatchOffset,
    int MatchLength);

/// <summary>検索条件。</summary>
internal sealed record SearchQuery(string Text, bool CaseSensitive, bool Regexp, bool WholeWord);

/// <summary>
/// フォルダ横断の全文検索(仕様書 第2.6節・第8.3節)。
/// 対象ファイルの決定(拡張子・除外フォルダ)は<see cref="FolderService"/>に委譲し、
/// ここでは走査結果のファイルに対して本文検索だけを行う。
/// </summary>
internal static class SearchService
{
    /// <summary>総ヒット数の上限。巨大フォルダ・巨大ファイル群で検索が終わらなくなるのを防ぐ安全弁。
    /// 呼び出し元(MainForm)が「打ち切られたか」をヒット総数から判定できるようinternalで公開する
    /// (SearchAsyncの戻り値をTaskのままにし、打ち切りフラグ専用の戻り値型を増やさないための割り切り)。</summary>
    internal const int MaxHits = 2000;

    /// <summary>1ファイルあたりの検索対象サイズ上限。仕様書 第8.3節がプレビュー無効化の基準とする
    /// 10MBに合わせ、それを超えるファイルは検索対象から除外する(巨大ファイルの読み込み・
    /// 正規表現走査でUIが固まって見えるのを避けるため)。</summary>
    private const long MaxFileSizeBytes = 10 * 1024 * 1024;

    /// <summary>この件数たまるごとにonBatchへ渡す(逐次返却)。</summary>
    private const int BatchSize = 50;

    /// <summary>この時間が経過したら、件数が閾値未満でもonBatchへ渡す(逐次返却)。</summary>
    private static readonly TimeSpan BatchInterval = TimeSpan.FromMilliseconds(200);

    /// <summary>
    /// rootPath配下を全文検索する。仕様書 第8.3節「グローバル検索はC#側の別スレッドで実行し、
    /// 結果を逐次返す」に基づき、Task.Runでバックグラウンドスレッド上で実行し、
    /// ヒットをためすぎずonBatchで随時呼び出し元(UIスレッドへの受け渡しは呼び出し元の責務)へ渡す。
    /// </summary>
    public static async Task SearchAsync(
        string rootPath,
        SearchQuery query,
        Func<IReadOnlyList<SearchHit>, Task> onBatch,
        CancellationToken ct)
    {
        Regex? regex = BuildRegex(query);
        if (regex is null)
        {
            // 不正な正規表現・空クエリはヒット0件として静かに終える
            // (ユーザーが入力途中の正規表現を送ってくるため、例外にはしない)。
            // 検索語そのものはログへ書かない(.review-security.md B対応。理由はMainForm.HandleGlobalSearchRequest参照)。
            Logger.Write($"SearchService.SearchAsync: 検索条件が不正なため中断: textLength={query.Text.Length}, regexp={query.Regexp}");
            return;
        }

        // 全文検索の対象範囲は本タスクの対象外(仕様書上も検索とツリー表示は別要件)のため、
        // 隠しファイル表示・除外パターンの設定は据え置き、従来どおりの既定(除外なし)で走査する。
        FolderScanResult scan = await FolderService.ScanAsync(rootPath, ct: ct);
        ct.ThrowIfCancellationRequested();

        var files = scan.Entries.Where(entry => !entry.IsDirectory).ToList();
        Logger.Write($"SearchService.SearchAsync: 対象ファイル数={files.Count} (root={rootPath})");

        await Task.Run(async () =>
        {
            var pending = new List<SearchHit>(BatchSize);
            DateTime lastFlush = DateTime.UtcNow;
            int totalHits = 0;
            bool truncated = scan.Truncated;

            async Task FlushAsync(bool force)
            {
                if (pending.Count == 0) return;
                if (!force && pending.Count < BatchSize && DateTime.UtcNow - lastFlush < BatchInterval) return;

                var batch = pending.ToList();
                pending.Clear();
                lastFlush = DateTime.UtcNow;
                await onBatch(batch);
            }

            foreach (FolderEntry file in files)
            {
                ct.ThrowIfCancellationRequested();

                if (totalHits >= MaxHits)
                {
                    truncated = true;
                    break;
                }

                foreach (SearchHit hit in SearchInFile(file, regex))
                {
                    pending.Add(hit);
                    totalHits++;
                    if (totalHits >= MaxHits) break;
                }

                await FlushAsync(force: false);
                if (totalHits >= MaxHits)
                {
                    truncated = true;
                    break;
                }
            }

            await FlushAsync(force: true);
            Logger.Write($"SearchService.SearchAsync完了: 総ヒット数={totalHits}, truncated={truncated}");
        }, ct);
    }

    /// <summary>クエリからRegexを組み立てる。不正な正規表現・空文字はnullを返す。</summary>
    private static Regex? BuildRegex(SearchQuery query)
    {
        if (string.IsNullOrEmpty(query.Text)) return null;

        string pattern = query.Regexp ? query.Text : Regex.Escape(query.Text);
        if (query.WholeWord)
        {
            pattern = $@"\b(?:{pattern})\b";
        }

        RegexOptions options = RegexOptions.Compiled | RegexOptions.CultureInvariant;
        if (!query.CaseSensitive) options |= RegexOptions.IgnoreCase;

        try
        {
            // 入力途中の正規表現(閉じ括弧が無い等)を送ってくることがあるため、
            // ここで一度組み立てを試み、失敗したら以降の処理へは進ませない。
            return new Regex(pattern, options, TimeSpan.FromSeconds(1));
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    /// <summary>1ファイルを検索する。読み込み・正規表現エラーは呼び出し元を止めず、そのファイルだけスキップする。</summary>
    private static IEnumerable<SearchHit> SearchInFile(FolderEntry file, Regex regex)
    {
        string text;
        try
        {
            var info = new FileInfo(file.Path);
            if (!info.Exists || info.Length > MaxFileSizeBytes)
            {
                yield break;
            }

            byte[] bytes = File.ReadAllBytes(file.Path);
            text = TextFileService.LoadBytes(bytes).Text; // 改行は"\n"に正規化済み
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 読み込めないファイル(他プロセスがロック中等)はスキップして検索全体は継続する
            Logger.Write($"SearchService.SearchInFile: 読み込み不可のためスキップ: {file.Path} ({ex.GetType().Name})");
            yield break;
        }

        string[] lines = text.Split('\n');
        for (int lineIndex = 0; lineIndex < lines.Length; lineIndex++)
        {
            string line = lines[lineIndex];
            MatchCollection matches;
            try
            {
                matches = regex.Matches(line);
            }
            catch (RegexMatchTimeoutException)
            {
                // 破滅的バックトラック等でタイムアウトした場合はこの行を諦めて次へ進む
                Logger.Write($"SearchService.SearchInFile: 正規表現タイムアウトのため行をスキップ: {file.Path}:{lineIndex + 1}");
                continue;
            }

            foreach (Match match in matches)
            {
                (string lineText, int matchOffset) = TruncateLine(line, match.Index);
                yield return new SearchHit(
                    file.Path,
                    file.Name,
                    file.RelativePath,
                    lineIndex + 1,
                    match.Index + 1,
                    lineText,
                    matchOffset,
                    match.Length);
            }
        }
    }

    /// <summary>長すぎる行はヒット位置を中心に前後を切り詰める(UI表示が壊れないようにするため)。
    /// 切り詰め後の文字列(LineText)だけでなく、その中でのヒット開始位置(0始まり)も
    /// あわせて返す。JS側はcolumn(元の行の列番号)ではなく、この位置を使って強調する
    /// 必要があるため(切り詰めで先頭が削られるとcolumnとインデックスがずれるため)。</summary>
    private static (string LineText, int MatchOffset) TruncateLine(string line, int hitIndex)
    {
        const int contextChars = 100; // ヒット位置の前後それぞれの最大文字数(合計で概ね200文字程度)
        if (line.Length <= contextChars * 2) return (line, hitIndex);

        int start = Math.Max(0, hitIndex - contextChars);
        int end = Math.Min(line.Length, hitIndex + contextChars);
        string snippet = line[start..end];

        string prefix = start > 0 ? "…" : string.Empty;
        string suffix = end < line.Length ? "…" : string.Empty;

        // ヒット開始位置(hitIndex)はstartを起点にsnippet内へ写像し、prefixの分だけ
        // オフセットを加える(prefixが付くのはstart > 0のとき、つまりstartが切り詰め
        // 起点そのものなので、hitIndex - startがそのままsnippet内オフセットになる)。
        int matchOffset = prefix.Length + (hitIndex - start);
        return (prefix + snippet + suffix, matchOffset);
    }
}
