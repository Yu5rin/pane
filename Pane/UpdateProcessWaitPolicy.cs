namespace Pane;

/// <summary>
/// 更新直後の起動で、「同じ場所で動いている別のPane」を古いプロセスとみなして
/// 終了を待つべきかどうかの判定。
///
/// 【実機で起きたこと】
/// <see cref="UpdateService.WaitForPreviousProcessExitAfterUpdate"/>は、退避ファイルが
/// 残っている間(更新から<c>JustUpdatedWindow</c>=5分以内)、「同じフォルダで動いている
/// 自分以外のPane.exe」を無条件に古いプロセスとみなして最大15秒待っていた。
///
/// ところがこの判定はMutex(多重起動の確認)より<b>前</b>に行われる。Paneはファイルを開くたびに
/// 新しいプロセスが起動して常駐プロセスへ引き渡す造りのため、更新から5分のあいだに
/// 2枚目・3枚目のウィンドウを開くと、その相手は「入れ替えられた古いプロセス」ではなく
/// 「たった今も働いている現役の常駐プロセス」である。実機ログでは、ファイルを開くたびに
/// 15秒待たされ(その間ウィンドウが出ない)、さらに待っているあいだに
/// AllowSetForegroundWindowの委譲権が失効して既存ウィンドウの前面化まで失敗していた。
///
/// 【どう直すか】
/// 入れ替えが起きた時刻(退避ファイルの時刻)より<b>前</b>から動いているプロセスだけを
/// 「入れ替えられた古いプロセス」とみなす。入れ替えより後に起動したプロセスは、新しい
/// exeから起きた現役なので待たない。
///
/// 境界は「待たない」側へ倒す。誤って待った場合の害(毎回15秒の足止め・前面化の失敗)は
/// 実機で毎回起きるのに対し、誤って待たなかった場合の害(更新直後の1回だけWebView2の
/// 初期化が詰まりうる)は限定的なため。
///
/// 時刻・プロセスに触れない判定だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class UpdateProcessWaitPolicy
{
    /// <summary>
    /// 相手のプロセスの終了を待つべきか。
    /// </summary>
    /// <param name="replacementTimeUtc">入れ替えが起きた時刻(退避ファイルの時刻)。</param>
    /// <param name="otherStartTimeUtc">相手のプロセスが起動した時刻。読めなければnull。</param>
    internal static bool ShouldWait(DateTime replacementTimeUtc, DateTime? otherStartTimeUtc)
    {
        // 起動時刻が読めない相手は、従来どおり安全側(待つ)に倒す。権限等で
        // Process.StartTimeが読めない場合であり、通常は起こらない。
        if (otherStartTimeUtc is null) return true;

        // 入れ替えより後に起きたプロセス = 新しいexeから起動した現役。待たない。
        // 同時刻ちょうども「待たない」側に含める(上記のとおり境界はこちらへ倒す)。
        return otherStartTimeUtc.Value < replacementTimeUtc;
    }
}
