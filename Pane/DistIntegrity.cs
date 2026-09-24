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
/// ファイルシステムにも Windows専用のAPIにも触れない判定だけをここへ切り出して、
/// テストで固定する(Pane.Tests へソースごと取り込むため)。
/// </summary>
internal static class DistIntegrity
{
    /// <summary>
    /// dist に必ず置かれるファイル。scripts/build.js が置くものと一致させる
    /// (ずれたら Pane.Tests の DistIntegrityTests が落ちる)。
    /// 名前にハッシュが付く分割ファイル(Mermaid等、200個ほど)は、欠けても該当する機能が
    /// 動かないだけで画面全体は崩れないうえ、版ごとに名前が変わるため対象にしない。
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

    /// <summary>欠けているファイルを <see cref="RequiredFiles"/> の順で返す。</summary>
    /// <param name="exists">dist 内の相対名(例: "style.css")を受け取り、実在すればtrueを返す。</param>
    public static IReadOnlyList<string> FindMissing(Func<string, bool> exists)
        => RequiredFiles.Where(name => !exists(name)).ToList();

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
