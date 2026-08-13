namespace Pane;

/// <summary>
/// 画像挿入(仕様書 docs/設定項目一覧.md「画像」節)の実処理。
/// メニューの「画像を挿入」・本文へのドラッグ&amp;ドロップ・クリップボードからの貼り付けの
/// 3経路すべてが、最終的にこのクラスの<see cref="InsertLocalImage"/>を通る。
///
/// 設計方針(タスク指示どおり): 副作用(実ファイルコピー)を持つ部分と、
/// パス文字列を組み立てるだけの純粋な部分を分離する。後者(<see cref="PlanDestination"/>・
/// <see cref="BuildMarkdownPath"/>・<see cref="ResolveCustomFolder"/>・<see cref="EscapePath"/>)は
/// ファイルI/Oを一切行わないため、単体で(このプロジェクトの外からでも)検証しやすい。
/// </summary>
internal static class ImageInsertService
{
    /// <summary>
    /// コピー先フォルダの算出結果。
    /// </summary>
    /// <param name="ShouldCopy">コピーを行うべきか。falseなら元のパスをそのまま参照する("none"、
    /// またはコピー先を決められない事情がある)。</param>
    /// <param name="DestinationDir">ShouldCopyがtrueのときのコピー先フォルダ(未作成の場合あり)。</param>
    /// <param name="SkipReason">コピーを行わない/行えない理由(ログ用)。理由が無ければnull。</param>
    internal readonly record struct PlanResult(bool ShouldCopy, string? DestinationDir, string? SkipReason);

    /// <summary>
    /// 画像挿入1件の結果。
    /// </summary>
    /// <param name="Ok">処理が成功したか。falseならUI側でエラー表示する。</param>
    /// <param name="MarkdownPath">Markdownへ書き込むパス文字列(Okがtrueのときのみ有効)。</param>
    /// <param name="ErrorMessage">Okがfalseのときのユーザー向け説明。</param>
    internal readonly record struct InsertResult(bool Ok, string MarkdownPath, string? ErrorMessage)
    {
        internal static InsertResult Success(string markdownPath) => new(true, markdownPath, null);
        internal static InsertResult Fail(string message) => new(false, "", message);
    }

    // ================= 副作用を持つ部分 =================

    /// <summary>
    /// ローカル画像1件を挿入する(オンライン画像=http(s)は<see cref="InsertOnlineImage"/>を使う)。
    /// </summary>
    /// <param name="sourcePath">実ファイルが既にディスク上にある場合の絶対パス
    /// (メニューの「画像を挿入」でOpenFileDialogから選んだ場合のみ非null)。</param>
    /// <param name="bytes">クリップボード貼り付け・ドラッグ&amp;ドロップ由来のバイト列
    /// (WebView2の標準DOM File APIでは実パスが取れないため、この経路では常にこちらになる)。</param>
    /// <param name="suggestedFileName">コピー先でのファイル名の候補(拡張子込み)。</param>
    internal static InsertResult InsertLocalImage(
        string? sourcePath,
        byte[]? bytes,
        string suggestedFileName,
        AppSettings settings,
        string? currentDocumentPath,
        Action<string> log)
    {
        bool hasSourcePath = sourcePath is not null;

        // imageApplyToLocalがfalseの場合、実ファイルが既にある(=コピーしなくても参照できる)ときに限り
        // 「何もしない」を選べる。バイト列のみ(貼り付け/D&D)はどのみちどこかへ書き出さない限り
        // Markdownから参照できないため、この設定では免除されない(下のmustCopyで扱う)。
        if (!settings.ImageApplyToLocal && hasSourcePath)
        {
            log("imageApplyToLocal=false のため、コピーは行わず元のパスをそのまま使用します");
            return InsertResult.Success(BuildMarkdownPath(sourcePath!, settings, currentDocumentPath));
        }

        PlanResult plan = PlanDestination(settings, currentDocumentPath);
        bool mustCopy = !hasSourcePath; // バイト列のみの場合はコピーせざるを得ない

        if (!plan.ShouldCopy && !mustCopy)
        {
            // imageInsertAction="none"(または未保存でnone相当): 何もせず元のパスを参照する。
            if (plan.SkipReason is not null) log(plan.SkipReason);
            return InsertResult.Success(BuildMarkdownPath(sourcePath!, settings, currentDocumentPath));
        }

        string destDir;
        if (plan.ShouldCopy)
        {
            destDir = plan.DestinationDir!;
        }
        else
        {
            // mustCopy && !plan.ShouldCopy: バイト列のみの画像で、設定上はコピー不要(none)か
            // 未保存で判定できない場合。バイト列は他に参照する術が無いため、文書と同じフォルダへの
            // 保存を既定のフォールバックとする(編集中のファイルが未保存ならそれも出来ないため、
            // 呼び出し元にエラーとして返す)。
            if (currentDocumentPath is null)
            {
                return InsertResult.Fail(
                    "編集中のファイルが未保存のため、貼り付け/ドロップされた画像を保存できません。先にファイルを保存してください。");
            }
            destDir = Path.GetDirectoryName(Path.GetFullPath(currentDocumentPath))!;
            log($"{(plan.SkipReason ?? "imageInsertAction=noneのため")}、貼り付け/ドロップされた画像は文書と同じフォルダへ保存します: {destDir}");
        }

        string destPath = CopyWithUniqueName(destDir, suggestedFileName, sourcePath, bytes);
        return InsertResult.Success(BuildMarkdownPath(destPath, settings, currentDocumentPath));
    }

    /// <summary>
    /// オンライン画像(http/https)の挿入。仕様書の指示どおり、外部通信(ダウンロード)は行わない。
    /// imageApplyToOnlineがtrueでも、その旨をログへ残すのみで元のURLをそのまま使う。
    /// </summary>
    internal static InsertResult InsertOnlineImage(string url, AppSettings settings, Action<string> log)
    {
        if (settings.ImageApplyToOnline)
        {
            log("imageApplyToOnline=trueですが、外部通信を行わない方針のためオンライン画像はコピー・加工しません");
        }
        return InsertResult.Success(url);
    }

    /// <summary>実際にファイルをコピー(またはバイト列を書き出し)する。同名ファイルがあれば
    /// 上書きせず"名前-1.ext"のように連番を付ける。</summary>
    internal static string CopyWithUniqueName(string destDir, string suggestedFileName, string? sourcePath, byte[]? bytes)
    {
        Directory.CreateDirectory(destDir);
        string destPath = UniqueDestinationPath(destDir, suggestedFileName);
        if (sourcePath is not null)
        {
            File.Copy(sourcePath, destPath);
        }
        else
        {
            File.WriteAllBytes(destPath, bytes ?? Array.Empty<byte>());
        }
        return destPath;
    }

    // ================= 純粋な部分(ファイルI/Oを行わない) =================

    /// <summary>
    /// imageInsertAction・編集中ファイルの保存状態から、コピー先フォルダを決める。
    /// ファイルI/Oは行わない(実際にフォルダが存在するかどうかは見ない)。
    /// </summary>
    internal static PlanResult PlanDestination(AppSettings settings, string? currentDocumentPath)
    {
        if (settings.ImageInsertAction == "none")
        {
            return new PlanResult(false, null, null);
        }

        if (currentDocumentPath is null)
        {
            // 仕様: 編集中のファイルが未保存の場合はコピーできない。noneと同じ扱いにする。
            return new PlanResult(false, null, "編集中のファイルが未保存のため、画像はコピーできません(imageInsertAction=noneとして扱います)");
        }

        string docDir = Path.GetDirectoryName(Path.GetFullPath(currentDocumentPath))!;
        string fileNameNoExt = Path.GetFileNameWithoutExtension(currentDocumentPath);

        string destDir = settings.ImageInsertAction switch
        {
            "currentFolder" => docDir,
            "assets" => Path.Combine(docDir, "assets"),
            "filenameAssets" => Path.Combine(docDir, $"{fileNameNoExt}.assets"),
            "custom" => ResolveCustomFolder(settings.ImageCustomFolder, docDir, fileNameNoExt),
            _ => docDir,
        };
        return new PlanResult(true, destDir, null);
    }

    /// <summary>
    /// imageCustomFolderを解決する。`./` `../` 始まりは編集中ファイルのフォルダ基準の相対パス、
    /// それ以外(ドライブレター等で始まる)は絶対パスとして扱う。`${filename}` は編集中ファイル名
    /// (拡張子なし)へ展開する。
    /// </summary>
    internal static string ResolveCustomFolder(string customFolder, string docDir, string fileNameNoExt)
    {
        string expanded = customFolder.Replace("${filename}", fileNameNoExt);
        if (expanded.Length == 0) return docDir; // 未設定時は文書と同じフォルダへフォールバック
        if (Path.IsPathRooted(expanded)) return Path.GetFullPath(expanded);
        return Path.GetFullPath(Path.Combine(docDir, expanded));
    }

    /// <summary>コピー先が既存の場合、上書きせず"名前-1.ext"のように連番を付けた空きパスを返す。</summary>
    internal static string UniqueDestinationPath(string dir, string fileName)
    {
        string name = Path.GetFileNameWithoutExtension(fileName);
        string ext = Path.GetExtension(fileName);
        if (name.Length == 0) name = "image"; // 拡張子だけ・空文字のファイル名対策
        string candidate = Path.Combine(dir, name + ext);
        for (int i = 1; File.Exists(candidate); i++)
        {
            candidate = Path.Combine(dir, $"{name}-{i}{ext}");
        }
        return candidate;
    }

    /// <summary>
    /// Markdownへ書き込む最終的なパス文字列を組み立てる(仕様書「パスの書き方」節)。
    /// imagePreferRelativePath・imageAddDotSlash・imageAutoEscapeUrlは、imageInsertActionの値
    /// (コピーする/しない)に関わらず常に適用する(節が独立しているため)。
    /// </summary>
    internal static string BuildMarkdownPath(string imagePath, AppSettings settings, string? currentDocumentPath)
    {
        string result;
        string? relative = settings.ImagePreferRelativePath && currentDocumentPath is not null
            ? TryGetRelativePath(Path.GetDirectoryName(Path.GetFullPath(currentDocumentPath))!, imagePath)
            : null;

        if (relative is not null)
        {
            result = NormalizeSlashes(relative);
            if (settings.ImageAddDotSlash && !result.StartsWith("../", StringComparison.Ordinal))
            {
                result = "./" + result;
            }
        }
        else
        {
            // 相対パスにできない(ドライブが違う等)、またはimagePreferRelativePath=false: 絶対パス。
            result = NormalizeSlashes(Path.GetFullPath(imagePath));
        }

        return settings.ImageAutoEscapeUrl ? EscapePath(result) : result;
    }

    /// <summary>basePath基準の相対パスを試みる。ドライブが異なる等で相対にできない場合はnull。</summary>
    private static string? TryGetRelativePath(string basePath, string targetPath)
    {
        try
        {
            string rel = Path.GetRelativePath(basePath, Path.GetFullPath(targetPath));
            // GetRelativePathは相対化できない場合、targetPathの絶対パスをそのまま返す仕様のため、
            // 結果がルート付き(=絶対パスのまま)なら失敗とみなす。
            return Path.IsPathRooted(rel) ? null : rel;
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    /// <summary>WindowsのバックスラッシュをMarkdown/URLで一般的なスラッシュへ統一する。</summary>
    private static string NormalizeSlashes(string path) => path.Replace('\\', '/');

    /// <summary>パスの各セグメント(`/`区切り)ごとにURLエスケープする(imageAutoEscapeUrl=true)。
    /// スキームやドライブのコロン・セグメント区切りの"/"自体は壊さないよう、セグメント単位で行う。
    /// ドライブレター("C:")の扱い: セグメント自体に":"が含まれる場合(例 "C:")はUri.EscapeDataStringが
    /// コロンもエスケープしてしまうため、先頭セグメントが1文字+コロンの形(ドライブレター)なら
    /// そのまま残す。</summary>
    private static string EscapePath(string path)
    {
        string[] segments = path.Split('/');
        for (int i = 0; i < segments.Length; i++)
        {
            string seg = segments[i];
            if (i == 0 && seg.Length == 2 && seg[1] == ':')
            {
                continue; // 例: "C:" (Windowsの絶対パス先頭) はそのまま
            }
            segments[i] = Uri.EscapeDataString(seg);
        }
        return string.Join("/", segments);
    }
}
