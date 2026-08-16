using System.Drawing.Text;

namespace Pane;

/// <summary>
/// PCにインストールされているフォントファミリの列挙(設定画面のフォント選択ドロップダウン用)。
/// フォント数が多い環境では等幅判定の計測(ファミリごとにテキスト幅を測る)にコストがかかるため、
/// プロセス内で一度だけ計算し、以後は静的にキャッシュした結果を返す。
///
/// このプロジェクトはnet8.0-windows向けだが、Windows以外の環境で実行された場合や
/// GDI+呼び出しが失敗する環境でも、例外を外へ投げずに空リストへフォールバックする
/// (フォント列挙の失敗でアプリ全体が落ちてはならない)。
/// </summary>
internal static class FontService
{
    private static readonly Lazy<(List<string> All, List<string> Monospace)> Cache = new(Compute);

    /// <summary>インストール済みの全フォントファミリ名(名前順)。列挙に失敗した場合は空リスト。</summary>
    public static IReadOnlyList<string> AllFamilies => Cache.Value.All;

    /// <summary>インストール済みのうち等幅とみなせるフォントファミリ名(名前順)。列挙に失敗した場合は空リスト。</summary>
    public static IReadOnlyList<string> MonospaceFamilies => Cache.Value.Monospace;

    private static (List<string> All, List<string> Monospace) Compute()
    {
        var all = new List<string>();
        var mono = new List<string>();
        try
        {
            using var collection = new InstalledFontCollection();
            foreach (FontFamily family in collection.Families)
            {
                string name = family.Name;
                if (string.IsNullOrWhiteSpace(name)) continue;
                all.Add(name);
                if (IsMonospace(family)) mono.Add(name);
            }
        }
        catch (Exception ex)
        {
            // InstalledFontCollectionの生成・列挙自体に失敗した場合(Windows以外の実行環境等)は
            // アプリを落とさず空リストにフォールバックする。
            Logger.WriteException("FontService: フォント列挙に失敗したため空リストにフォールバック", ex);
            return (new List<string>(), new List<string>());
        }

        all.Sort(StringComparer.OrdinalIgnoreCase);
        mono.Sort(StringComparer.OrdinalIgnoreCase);
        return (all, mono);
    }

    /// <summary>
    /// "i"(細い文字)と"W"(太い文字)の描画幅がほぼ同じなら等幅とみなす。
    /// 判定できない(計測結果が0以下など異常)場合や例外発生時は、黙って非等幅側(false)に倒す
    /// (等幅リストに誤って混入させないため)。
    /// </summary>
    private static bool IsMonospace(FontFamily family)
    {
        try
        {
            if (!family.IsStyleAvailable(FontStyle.Regular)) return false;

            using Font font = new(family, 16f, FontStyle.Regular, GraphicsUnit.Pixel);
            using Bitmap bitmap = new(1, 1);
            using Graphics graphics = Graphics.FromImage(bitmap);

            SizeF narrow = graphics.MeasureString("i", font);
            SizeF wide = graphics.MeasureString("W", font);

            if (narrow.Width <= 0f || wide.Width <= 0f) return false;

            // MeasureStringはピクセル未満の誤差を含むため、厳密一致ではなく僅かな差を許容する。
            return Math.Abs(narrow.Width - wide.Width) <= 1f;
        }
        catch (Exception ex)
        {
            Logger.WriteException($"FontService: フォント'{family.Name}'の等幅判定に失敗したため非等幅として扱う", ex);
            return false;
        }
    }
}
