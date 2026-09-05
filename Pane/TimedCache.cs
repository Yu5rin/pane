namespace Pane;

/// <summary>
/// 値を一定時間だけ覚えておく、プロセス内の小さなキャッシュ。
///
/// 【何のために作ったか】
/// 実機ログ(2026-09-05)で、ファイルを1つ開くたびに親フォルダ(ダウンロードフォルダ、約1万件)の
/// 走査に791〜1169msかかっていた。Paneはファイルを開くたびに新しいプロセスが起動して常駐
/// プロセスへ引き渡す造りのため、同じフォルダの中のファイルを続けて開くと、まったく同じ
/// 走査を何度も繰り返すことになる。
///
/// 短い時間だけ結果を使い回せば、この繰り返しを消せる。古い一覧を返しうるのが引き換えだが、
/// 使い回すのは「ファイルを開いた副作用での自動読み込み」だけに限る
/// (<see cref="FolderService.ScanAsync"/>のuseCache参照)。
///
/// 時刻の取得を差し替えられるようにしてあり、テストでは時間を進めた状態を作れる。
/// </summary>
internal sealed class TimedCache<TKey, TValue> where TKey : notnull
{
    private readonly TimeSpan _lifetime;
    private readonly Func<DateTime> _nowUtc;
    private readonly Dictionary<TKey, (DateTime StoredAtUtc, TValue Value)> _entries;
    private readonly object _gate = new();

    /// <param name="lifetime">覚えておく時間。これを過ぎた項目は無いものとして扱う。</param>
    /// <param name="comparer">キーの比較方法(パスを扱う場合は大小文字を区別しないものを渡す)。</param>
    /// <param name="nowUtc">現在時刻の取得。省略時は<see cref="DateTime.UtcNow"/>。</param>
    internal TimedCache(TimeSpan lifetime, IEqualityComparer<TKey>? comparer = null, Func<DateTime>? nowUtc = null)
    {
        _lifetime = lifetime;
        _nowUtc = nowUtc ?? (() => DateTime.UtcNow);
        _entries = new Dictionary<TKey, (DateTime, TValue)>(comparer);
    }

    /// <summary>まだ生きている値があれば取り出す。期限切れの項目はその場で捨てる。</summary>
    internal bool TryGet(TKey key, out TValue value)
    {
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var entry))
            {
                if (_nowUtc() - entry.StoredAtUtc < _lifetime)
                {
                    value = entry.Value;
                    return true;
                }
                _entries.Remove(key);
            }
        }
        value = default!;
        return false;
    }

    /// <summary>値を覚える(同じキーの古い値は置き換える)。</summary>
    internal void Set(TKey key, TValue value)
    {
        lock (_gate)
        {
            _entries[key] = (_nowUtc(), value);
        }
    }

    /// <summary>覚えている内容をすべて捨てる。</summary>
    internal void Clear()
    {
        lock (_gate)
        {
            _entries.Clear();
        }
    }
}
