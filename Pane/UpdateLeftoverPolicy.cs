namespace Pane;

/// <summary>
/// 前回の更新で退避したファイル(<c>Pane.exe.pane-old</c> / <c>dist.pane-old</c>)を、
/// 次回起動時に消してよいかどうかの判定。
///
/// 【なぜ必要か】
/// 更新の入れ替え(<see cref="UpdateService.ApplyUpdate"/>)は、実行中のexeを退避してから
/// 新しいexeとdistを順にコピーする(exe→distの順)。distは多数のファイルをコピーするため、
/// この途中で電源断・強制終了が起きると、exeは新版で完全なのにdistだけが欠けた状態になる。
///
/// 従来の<see cref="UpdateService.CleanupLeftovers"/>は、退避ファイルが在ればそれだけを見て
/// 無条件に削除していた。これだと上のように入れ替えが完了しないまま終わった直後の初回起動で、
/// 「欠けたdistを直す唯一の材料(dist.pane-old)」まで消えてしまい、二度と復旧できなくなる
/// (docs/調査記録/点検-機能と動作.md「余裕があれば直すもの」参照)。
///
/// 完了マーカー(<see cref="CompletionMarkerFileName"/>)は、ApplyUpdateが新しいexe/distの
/// コピーを最後までやり遂げたときにだけ書く。次回起動時にこのマーカーが無ければ
/// 「入れ替えが途中で終わった」とみなし、退避ファイルは消さずに残す(消してしまうと
/// 直す手立てが無くなるため、消さないことが安全側)。
///
/// 通信・ファイル・時刻に一切触れない判定だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class UpdateLeftoverPolicy
{
    /// <summary>
    /// 入れ替えが最後まで完了したことを示す目印ファイルの名前。インストール先フォルダ直下に
    /// <see cref="UpdateService.ApplyUpdate"/>が書き、<see cref="UpdateService.CleanupLeftovers"/>が
    /// 読んで消す。中身は無くてよい(存在自体が完了の証)。
    /// </summary>
    internal const string CompletionMarkerFileName = "pane-update.ok";

    /// <summary>次回起動時に実際にとるべき行動。</summary>
    internal enum Action
    {
        /// <summary>退避ファイルが無い(通常の起動、または既に片付いている)。何もしない。</summary>
        None,

        /// <summary>前回の更新は完了している。退避ファイル・完了マーカーを削除してよい。</summary>
        DeleteBackups,

        /// <summary>前回の更新は完了しないまま終わった形跡がある。退避ファイルは消さずに残す。</summary>
        KeepBackups,
    }

    /// <summary>
    /// 退避ファイル・完了マーカーの有無から、とるべき行動を決める。
    /// </summary>
    /// <param name="exeBackupExists">Pane.exe.pane-old が存在するか。</param>
    /// <param name="distBackupExists">dist.pane-old が存在するか。</param>
    /// <param name="markerExists">完了マーカー(<see cref="CompletionMarkerFileName"/>)が存在するか。</param>
    internal static Action Decide(bool exeBackupExists, bool distBackupExists, bool markerExists)
    {
        if (!exeBackupExists && !distBackupExists)
        {
            // 退避ファイルが無ければ、マーカーだけ残っていても実害は無いが片付けの対象にはなる。
            // (CleanupLeftovers側でマーカー単独の削除は別途行う。)
            return Action.None;
        }

        return markerExists ? Action.DeleteBackups : Action.KeepBackups;
    }
}
