using System.Text.Json;

namespace Pane;

/// <summary>
/// 配布物の dist フォルダに、表示に欠かせないファイルが揃っているかの判定と、
/// 欠けていたときに利用者へ出す文面。
///
/// 【実際に起きたこと(2026-09-24)】ある1台のPCで、画面が崩れて表示された
/// (メニューやボタンが標準の四角いボタンになり、右上のアイコンが左に寄り、
/// コピーとチェックマーク・太陽と月が両方並んで出る)。調べると dist\style.css だけが
/// 無かった。index.html と main.js はあるため起動はし、ボタンも押せる。しかし見た目の
/// 定義が丸ごと無いので、崩れた画面のまま何も言わずに動き続けていた。
/// 起動時は index.html の有無しか確かめていなかったため、Pane自身は気づけなかった。
///
/// なぜ欠けたかは突き止められていない(確かめる前に直してしまった)。更新の適用
/// (UpdateService.ApplyUpdate)は全ファイルをコピーし、1つでも失敗すれば全体を元に戻す
/// 作りなので、1ファイルだけ黙って欠ける経路はコード上には無い。手で置いたときに
/// 抜けたか、置いた後に外から消された(ウイルス対策の隔離など)と見ている。
/// 経緯は docs/調査記録/修正-distの欠けを直せるようにする.md。
///
/// 【何と突き合わせるか】ビルドが dist の全ファイルを書き出した一覧(<see cref="FileListName"/>、
/// scripts/build.js)と、下の <see cref="RequiredFiles"/> の両方。一覧があれば分割ファイル
/// (Mermaid等、名前にハッシュが付く約200個)の欠けにも気づける(利用者要望)。
/// 一覧そのものが無い・読めないときは、それ自体を欠けとして扱ったうえで、
/// <see cref="RequiredFiles"/> だけは確かめる(一覧が無ければ全部を確かめる手段が無く、
/// 直せば一覧も戻るため)。
///
/// ファイルシステムにも Windows専用のAPIにも触れない判定だけをここへ切り出して、
/// テストで固定する(Pane.Tests へソースごと取り込むため)。
/// </summary>
internal static class DistIntegrity
{
    /// <summary>
    /// ビルドが書き出す、dist の全ファイルの一覧のファイル名(scripts/build.js の DIST_FILE_LIST)。
    /// 形: {"format":1,"files":["index.html", ...]}。区切りは "/"、一覧そのものは載らない。
    /// </summary>
    public const string FileListName = "dist-files.json";

    /// <summary>このPaneが読める一覧の形の版。</summary>
    internal const int SupportedFileListFormat = 1;

    /// <summary>
    /// dist に必ず置かれる、名前の変わらないファイル。scripts/build.js が置くものと一致させる
    /// (ずれたら Pane.Tests の DistIntegrityTests が落ちる)。
    /// 一覧(<see cref="FileListName"/>)が読めればそちらに全部載っているが、一覧が欠けたり
    /// 壊れたりしたときでも、画面を描くのに欠かせないこれらだけは確かめられるよう別に持つ。
    /// </summary>
    public static readonly IReadOnlyList<string> RequiredFiles = new[]
    {
        "index.html",
        "main.js",
        "style.css",
        "themes.css",
        "settings-window.html",
        "settings-entry.js",
        "help-window.html",
        "help-entry.js",
        "icon.svg",
        "manual.md",
    };

    /// <summary>文面に並べるファイル名の上限。これを超えた分は「ほかN件」とまとめる。</summary>
    internal const int MaxListedNames = 5;

    /// <summary>
    /// 欠けているファイルを返す。並びは <see cref="RequiredFiles"/> の順 → 一覧の順
    /// → (一覧が無い・読めないとき)一覧そのもの、の順。
    /// </summary>
    /// <param name="fileListJson">一覧の中身。一覧のファイルが無ければnull。</param>
    /// <param name="exists">dist 内の相対名("/"区切り。例: "style.css")を受け取り、実在すればtrueを返す。</param>
    public static IReadOnlyList<string> FindMissing(string? fileListJson, Func<string, bool> exists)
    {
        IReadOnlyList<string>? listed = fileListJson is null ? null : ParseFileList(fileListJson);

        var expected = new List<string>(RequiredFiles);
        var seen = new HashSet<string>(RequiredFiles, StringComparer.OrdinalIgnoreCase);
        if (listed is not null)
        {
            foreach (string name in listed)
            {
                if (seen.Add(name)) expected.Add(name);
            }
        }

        var missing = expected.Where(name => !exists(name)).ToList();
        // 一覧が無い・読めない: それ自体を欠けとして返す。直せば一覧も戻る。
        if (listed is null) missing.Add(FileListName);
        return missing;
    }

    /// <summary>
    /// 一覧の中身を読む。形が違う・知らない版・dist の外を指す名前が混じる、のいずれかなら
    /// null(壊れた一覧として扱う)。一部だけ読んで残りを信じる、ということはしない。
    /// </summary>
    internal static IReadOnlyList<string>? ParseFileList(string json)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(json);
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("format", out JsonElement format)
                || format.ValueKind != JsonValueKind.Number
                || !format.TryGetInt32(out int version)
                || version != SupportedFileListFormat)
            {
                return null;
            }
            if (!root.TryGetProperty("files", out JsonElement files) || files.ValueKind != JsonValueKind.Array) return null;

            var names = new List<string>();
            foreach (JsonElement item in files.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) return null;
                string name = item.GetString() ?? "";
                if (!IsSafeRelativeName(name)) return null;
                names.Add(name);
            }
            return names;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// dist の中を指す相対名か。一覧は dist の中のファイルで、書き換えられれば dist の外の
    /// 有無を調べさせられる(存在を確かめるだけで読みはしないが、余計なことはさせない)。
    /// </summary>
    internal static bool IsSafeRelativeName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        if (name.Contains('\\') || name.Contains(':')) return false;       // 区切りは "/" だけ。ドライブ指定も不可
        if (name.StartsWith('/')) return false;                            // 絶対パス
        foreach (string part in name.Split('/'))
        {
            if (part.Length == 0 || part == "." || part == "..") return false;
        }
        return true;
    }

    /// <summary>
    /// 修復してよいかを尋ねる文面。押した先で何が起きるか(通信する・大きさ・再起動する)を
    /// 先に書く。Paneは利用者の操作なしに外へ通信しない方針のため、「はい」がその操作になる。
    /// </summary>
    public static string BuildRepairPrompt(IReadOnlyList<string> missing)
        => "画面の表示に必要なファイルが欠けているため、正しく表示できません。\n"
         + FormatNames(missing) + "\n\n"
         + "最新版をダウンロードして直しますか?\n"
         + "(約75MBをダウンロードし、終わるとPaneを再起動します)";

    /// <summary>
    /// 自動で直せなかったときの文面。理由のあとに、手で直す手順を必ず添える
    /// (理由だけでは次に何をすればよいか分からない)。
    /// </summary>
    public static string BuildManualRepairMessage(string reason)
        => reason + "\n\n"
         + "手で直すには、リリースページから最新版のZipをダウンロードし、"
         + "Paneを終了してから dist フォルダを削除し、Zipの中の dist を置き直してください。\n\n"
         + "リリースページを開きますか?";

    /// <summary>欠けているファイル名を1行ずつ並べる。多すぎるときは先頭だけにする。</summary>
    internal static string FormatNames(IReadOnlyList<string> missing)
    {
        var lines = missing.Take(MaxListedNames).Select(name => "・" + name).ToList();
        int rest = missing.Count - MaxListedNames;
        if (rest > 0) lines.Add($"・ほか{rest}件");
        return string.Join("\n", lines);
    }
}
