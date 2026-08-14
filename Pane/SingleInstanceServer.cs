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

                string? line = await reader.ReadLineAsync(token).ConfigureAwait(false);
                string? path = string.IsNullOrEmpty(line) ? null : line;

                _uiContext.Post(_ => FileRequested?.Invoke(path), null);

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
