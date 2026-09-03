namespace Pane;

/// <summary>
/// settings.jsonが壊れていた場合に退避するバックアップファイルの名前決め。
/// 通信・ファイル・現在時刻の取得そのものには触れず、「渡された時刻からどんな名前を
/// 組み立てるか」だけを扱う純粋な部分をここへ切り出してある(Pane.Tests側で固定)。
/// 実際のバックアップ書き込み・警告ログ・既定値での復旧という「外の世界に触れる」処理は
/// <see cref="SettingsService"/> 側に残す。
/// </summary>
internal static class SettingsRecoveryLogic
{
    /// <summary>
    /// 壊れたsettings.jsonの退避先ファイル名を組み立てる("settings.json.broken-20260903-120000.json"のような形)。
    /// 秒単位のタイムスタンプを含めるのは、同じ壊れた内容を握りつぶさず、
    /// いつ発生した破損かを名前だけで追えるようにするため。
    /// </summary>
    internal static string BuildBrokenBackupFileName(DateTime timestampUtc) =>
        $"settings.json.broken-{timestampUtc:yyyyMMdd-HHmmss}.json";
}
