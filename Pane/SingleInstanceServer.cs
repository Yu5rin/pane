using System.IO.Pipes;

namespace Pane;

/// <summary>
/// 名前付きパイプでの多重起動通知を受け取るサーバー側。
/// 別プロセスから接続があるたびにファイルパス(空文字ならアクティブ化のみ)を読み取り、
/// UIスレッドの SynchronizationContext 経由で <see cref="FileRequested"/> を発火する。
/// 仕様書 第8.1節: 2重起動時は新しいウィンドウを同一プロセス内に作る。
/// </summary>
internal sealed class SingleInstanceServer
{
    /// <summary>
    /// 不具合修正: 「エクスプローラからファイルを開いたとき、Paneのウィンドウが前面に来ない
    /// ことがある」対策の続き。UIスレッド側で<see cref="FileRequested"/>の処理
    /// (ウィンドウを開いて前面化する)が完了するのを待ってからACKを返すための上限(ミリ秒)。
    /// <see cref="SingleInstance.TimeoutMilliseconds"/>(クライアント側のパイプ接続タイムアウト、
    /// 2000ms)より十分小さい値にし、ACKがクライアントのタイムアウトに間に合うようにする。
    /// --preload常駐からの初回表示では異常終了からの復元確認ダイアログ(PaneDialog.Show)が
    /// 出ることがあり、その場合はユーザーが応答するまでUIスレッドが返ってこないため、
    /// 待ちきれない場合でも必ずこの上限であきらめてACKを返す(二重起動を避けるため)。
    /// </summary>
    private const int ActivationWaitTimeoutMs = 1200;

    private readonly SynchronizationContext _uiContext;
    private readonly CancellationTokenSource _cts = new();

    /// <summary>UIスレッド上で発火する。引数は開くべきファイルパス(nullなら新規ウィンドウ)。</summary>
    public event Action<string?>? FileRequested;

    public SingleInstanceServer(SynchronizationContext uiContext)
    {
        _uiContext = uiContext;
    }

    public void Start()
    {
        _ = RunLoopAsync(_cts.Token);
    }

    public void Stop() => _cts.Cancel();

    private async Task RunLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(
                    SingleInstance.PipeName,
                    PipeDirection.InOut,
                    maxNumberOfServerInstances: 1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                await server.WaitForConnectionAsync(token).ConfigureAwait(false);

                using var reader = new StreamReader(server, leaveOpen: true);
                using var writer = new StreamWriter(server, leaveOpen: true) { AutoFlush = true };

                // 不具合修正: 前面化のためクライアント側でAllowSetForegroundWindowを呼べるよう、
                // 接続を受理したらまず自分自身のPIDを1行送る(SingleInstance.csのプロトコルと対)。
                await writer.WriteLineAsync(Environment.ProcessId.ToString()).ConfigureAwait(false);

                string? line = await reader.ReadLineAsync(token).ConfigureAwait(false);
                string? path = string.IsNullOrEmpty(line) ? null : line;

                // 不具合修正: 従来はPost直後にACKを返していたため、UIスレッドがまだ
                // FileRequestedを処理してウィンドウを開く/前面化する前に、クライアント
                // (フォアグラウンド権の譲渡元)がACKを受けて即終了してしまい、
                // SetForegroundWindowが呼ばれる前にフォアグラウンド権の持ち主が
                // いなくなる(=譲渡の効果が出ない)という不具合があった。
                // PostしたデリゲータがFileRequested呼び出しを終えたらTrySetResultするのを
                // 最大ActivationWaitTimeoutMsだけ待ってからACKを返す。
                // RunContinuationsAsynchronously: TrySetResultを呼ぶUIスレッド側で
                // このTaskの継続(WhenAny側の再開)まで同期的に実行させない
                // (UIスレッドをこちらの後続処理でブロックしないため)。
                var activationCompleted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                _uiContext.Post(_ =>
                {
                    try
                    {
                        FileRequested?.Invoke(path);
                    }
                    catch (Exception ex)
                    {
                        // UIスレッド側の処理が例外を投げても、ACK待ちのクライアントを
                        // 待たせ続けないようfinallyで必ずTrySetResultする。
                        Logger.WriteException("SingleInstanceServer: FileRequested処理中の例外", ex);
                    }
                    finally
                    {
                        activationCompleted.TrySetResult();
                    }
                }, null);

                Task completed = await Task.WhenAny(
                    activationCompleted.Task,
                    Task.Delay(ActivationWaitTimeoutMs)).ConfigureAwait(false);
                if (completed != activationCompleted.Task)
                {
                    // タイムアウトしてもACKは必ず返す(重要): ACKを返さないと
                    // SingleInstance.TrySendToExistingInstanceがfalseを返し、Program.csが
                    // 「既存プロセスが応答しなかった」と判断して新プロセスが自プロセスとして
                    // 通常起動してしまい、二重起動になる。復元確認ダイアログ(PaneDialog.Show)が
                    // 表示中でユーザー応答待ちのとき等にここへ来る。前面化の完了確認は
                    // あきらめるが、UIスレッド側の処理自体は継続しており(Postしたデリゲートは
                    // 生き続ける)、ダイアログ操作後に通常どおりウィンドウが開いて前面化される。
                    Logger.Write($"SingleInstanceServer: ウィンドウ表示/前面化の完了を{ActivationWaitTimeoutMs}ms以内に確認できなかった" +
                        "(復元確認ダイアログ表示中等でUIスレッドがブロックされている可能性)。前面化の完了確認はあきらめ、二重起動を避けるためACKは返す");
                }

                await writer.WriteLineAsync("OK").ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Stop() による正常終了
                break;
            }
            catch (IOException ex)
            {
                // クライアント切断等。次の接続待ちへ戻る。
                Logger.Write($"SingleInstanceServer: IOExceptionを無視して待受を継続する: {ex.Message}");
            }
            catch (Exception ex)
            {
                // 不具合修正: 従来はOperationCanceledException/IOException以外を一切
                // 捕捉していなかったため、想定外の例外が1回でも起きるとRunLoopAsyncが
                // 静かに終了し、以後は二重起動の検知が永久に止まる(ログにも残らない)という
                // 不具合があった。ここで受け止めてログに残し、ループを継続する。
                // ただしtokenが既にキャンセル済み(Stop()呼び出し後)であれば、正常な終了
                // シーケンス中なのでこれ以上ループを続けず終了する。
                Logger.WriteException("SingleInstanceServer: 想定外の例外", ex);
                if (token.IsCancellationRequested)
                {
                    break;
                }
            }
        }
    }
}
