using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Pane;

/// <summary>
/// ネイティブのタイトルバー(DWMのキャプション部分)の配色をアプリのテーマへ連動させる。
/// dwmapi.dll の DwmSetWindowAttribute を直接P/Invokeで呼び出す。
///
/// この関数は仕様上、未対応の属性・未対応のOSバージョンで呼んでも例外を投げず、
/// HRESULTでエラーを返すだけ(戻り値はint、失敗時は非0)。ただしdwmapi.dll自体が
/// 存在しない環境(非Windows実行等)では呼び出し自体がDllNotFoundException等を
/// 投げ得るため、すべての呼び出し箇所をtry-catchで包み、失敗してもアプリが
/// 落ちないようにしている。各呼び出しの成否はLoggerに記録するのみで、
/// 呼び出し元(MainForm)には例外を伝播させない。
/// </summary>
internal static class WindowChrome
{
    // ---- DwmSetWindowAttribute の属性値 ----

    /// <summary>タイトルバーをダーク配色にする(0=ライト/1=ダーク)。Windows 10 1809(Build 17763)以降で有効。
    /// Windows 10 1809〜1903の間は値が19だった経緯があり、20で失敗する場合は19で再試行する。</summary>
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

    /// <summary>DWMWA_USE_IMMERSIVE_DARK_MODEの旧値(Windows 10 1809〜1903向け)。</summary>
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;

    /// <summary>ウィンドウ枠の色(COLORREF)。Windows 11(Build 22000)以降のみ有効。</summary>
    private const int DWMWA_BORDER_COLOR = 34;

    /// <summary>タイトルバー背景色(COLORREF)。Windows 11(Build 22000)以降のみ有効。</summary>
    private const int DWMWA_CAPTION_COLOR = 35;

    /// <summary>タイトルバー文字色(COLORREF)。Windows 11(Build 22000)以降のみ有効。</summary>
    private const int DWMWA_TEXT_COLOR = 36;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    // ---- 案B: アプリ既定の代表色 ----
    // src/style.css の --paper(背景)・--ink(文字)の実際の値に合わせる。
    // style.cssは:rootブロックを複数回定義しており(仕様書改訂の経緯)、CSSは同じ特異度なら
    // 後勝ちのため、実際に効いているのは後方(第10.2節・第10.3節のトークン定義)の値:
    //   ライト: --paper #FBFBFA / --ink #1F2428
    //   ダーク: --paper #14171A / --ink #E4E7E5
    // (先頭側の :root / html[data-theme="dark"] の値はこの後方定義で上書きされるため使わない)

    /// <summary>ライトテーマの既定タイトルバー背景色(src/style.css --paper 実値)。</summary>
    public const string DefaultLightBackground = "#FBFBFA";

    /// <summary>ライトテーマの既定タイトルバー文字色(src/style.css --ink 実値)。</summary>
    public const string DefaultLightForeground = "#1F2428";

    /// <summary>ダークテーマの既定タイトルバー背景色(src/style.css --paper 実値・ダーク側)。</summary>
    public const string DefaultDarkBackground = "#14171A";

    /// <summary>ダークテーマの既定タイトルバー文字色(src/style.css --ink 実値・ダーク側)。</summary>
    public const string DefaultDarkForeground = "#E4E7E5";

    /// <summary>ライトテーマのウィンドウ枠色(src/style.css --line 実値)。背景よりわずかに濃くして輪郭を出す。</summary>
    public const string DefaultLightBorder = "#DCE2E0";

    /// <summary>ダークテーマのウィンドウ枠色(src/style.css --line 実値・ダーク側)。背景より明るくして輪郭を出す。</summary>
    public const string DefaultDarkBorder = "#2C343A";

    /// <summary>
    /// 直前にそのウィンドウへ実際に適用したタイトルバー配色。
    ///
    /// 不具合修正(自己駆動ループ): 実機で「ログファイルをPaneで開いている間、0.37秒ごとに
    /// ApplyThemeが呼ばれ続け、そのたびにDWMのAPI呼び出しとログ4行の書き込みが走る」現象が
    /// 観測された。ログファイルを開いている状態でログを書くこと自体が次の呼び出しを誘発しうる
    /// ため、同じ値での再適用はDWM呼び出しもログ出力も丸ごと省く必要がある。
    ///
    /// 状態は必ず「ウィンドウごと」に持つ(staticな単一の変数にすると、2枚目のウィンドウが
    /// 1枚目と同じ色を適用しようとした際に「変化なし」と誤判定され、タイトルバーが塗られない
    /// まま残ってしまう)。キーにはウィンドウハンドル(IntPtr)ではなくFormインスタンスを使う。
    /// ハンドル値はウィンドウを閉じるとOSに再利用されうるため、閉じたウィンドウの状態が
    /// たまたま同じ値のハンドルを得た別ウィンドウへ誤適用される危険があるが、Form参照なら
    /// その取り違えが起きない。<see cref="ConditionalWeakTable{TKey,TValue}"/>なので
    /// ウィンドウが破棄・GCされればエントリも自動的に消える(明示的な後始末は不要)。
    /// </summary>
    private sealed class AppliedTheme
    {
        /// <summary>適用したときのウィンドウハンドル。ハンドルが再作成された場合は
        /// 新しいハンドルに対して塗り直す必要があるため、比較対象に含める。</summary>
        public IntPtr Handle;
        public bool IsDark;
        public string Background = string.Empty;
        public string Foreground = string.Empty;
        public string Border = string.Empty;
        /// <summary>実際に適用した最後の時刻(Environment.TickCount64)。抑止ログへ周期を出すために使う。</summary>
        public long LastAppliedTick;
        /// <summary>前回の適用以降、同じ値だったために抑止した回数。</summary>
        public long SkipCount;
    }

    private static readonly ConditionalWeakTable<Form, AppliedTheme> AppliedThemes = new();

    /// <summary>抑止ログを出す間隔(抑止回数)。ログ出力自体が次の呼び出しを誘発しうる構造なので、
    /// 抑止の1回目と、それ以降はこの回数ごとに1行だけ残す。0.37秒周期なら約74秒に1行。</summary>
    private const long SkipLogInterval = 200;

    /// <summary>
    /// タイトルバーの配色を適用する。isDarkに応じてDWMWA_USE_IMMERSIVE_DARK_MODEを設定したうえで、
    /// 背景・文字・枠の色を設定する。backgroundHex/foregroundHexが指定されていればそれを使い
    /// (案A: JS側からの実描画色)、未指定(null/空)ならisDarkに応じた既定色(案B)を使う。
    /// 呼び出し自体は例外を投げない(内部のTrySetAttributeが全例外を握りつぶす)。
    ///
    /// 前回このウィンドウへ適用した内容(<see cref="AppliedTheme"/>)と完全に同じ場合は、
    /// DWMの呼び出しもログ出力も一切行わずに戻る。これにより、呼び出し元が高頻度で
    /// 呼んでしまっている場合でも、ログ書き込みが次の呼び出しを誘発する自己駆動ループには
    /// ならない。呼び出し元の情報(<paramref name="callerMember"/>等)はコンパイラが自動で
    /// 埋めるため、呼び出し側の記述は変わらない。実機ログでは
    /// 「どこから呼ばれてこの頻度になっているのか」の特定に使う。
    /// </summary>
    public static void ApplyTheme(
        Form form,
        bool isDark,
        string? backgroundHex = null,
        string? foregroundHex = null,
        [CallerMemberName] string callerMember = "",
        [CallerFilePath] string callerFile = "",
        [CallerLineNumber] int callerLine = 0)
    {
        if (form.IsDisposed)
        {
            Logger.Write($"WindowChrome.ApplyTheme: ウィンドウが破棄済みのため何もしない (呼出元={DescribeCaller(callerMember, callerFile, callerLine)})");
            return;
        }
        if (!form.IsHandleCreated)
        {
            // ここでform.Handleに触るとハンドルを新規生成してしまうため、触らずに戻る
            // (ハンドル生成直後にOnHandleCreated側から改めて呼ばれる)。
            Logger.Write($"WindowChrome.ApplyTheme: ハンドル未生成のため何もしない (呼出元={DescribeCaller(callerMember, callerFile, callerLine)})");
            return;
        }

        IntPtr handle = form.Handle;
        string bg = !string.IsNullOrWhiteSpace(backgroundHex)
            ? backgroundHex!
            : (isDark ? DefaultDarkBackground : DefaultLightBackground);
        string fg = !string.IsNullOrWhiteSpace(foregroundHex)
            ? foregroundHex!
            : (isDark ? DefaultDarkForeground : DefaultLightForeground);
        // 枠は背景と別の色にして細い輪郭を出す。背景と同色にしていたときは、特にダークテーマで
        // ウィンドウを重ねるとどこまでが手前のウィンドウか分からなくなっていた。
        string border = isDark ? DefaultDarkBorder : DefaultLightBorder;

        AppliedTheme state = AppliedThemes.GetOrCreateValue(form);
        string? reason = ResolveApplyReason(state, handle, isDark, bg, fg, border);
        if (reason is null)
        {
            // 前回とまったく同じ内容。DWMもログも触らない(=自己駆動ループを断つ)。
            // ただし「呼ばれ続けていること」自体は調査に必要なので、ごく低頻度で1行だけ残す。
            state.SkipCount++;
            if (state.SkipCount == 1 || state.SkipCount % SkipLogInterval == 0)
            {
                Logger.Write(
                    $"WindowChrome: 前回と同じ配色のため再適用を抑止 (呼出元={DescribeCaller(callerMember, callerFile, callerLine)}, " +
                    $"hwnd=0x{handle.ToInt64():X}, 抑止={state.SkipCount}回目, 前回適用から={Environment.TickCount64 - state.LastAppliedTick}ms)");
            }
            return;
        }

        long sinceLastMs = state.LastAppliedTick == 0 ? -1 : Environment.TickCount64 - state.LastAppliedTick;
        string darkResult = SetImmersiveDarkMode(handle, isDark);
        int captionHr = TrySetAttribute(handle, DWMWA_CAPTION_COLOR, unchecked((int)ToColorRef(bg)));
        int textHr = TrySetAttribute(handle, DWMWA_TEXT_COLOR, unchecked((int)ToColorRef(fg)));
        int borderHr = TrySetAttribute(handle, DWMWA_BORDER_COLOR, unchecked((int)ToColorRef(border)));

        // 従来は属性ごとに1行ずつ(合計4行)出していたが、内容は変えずに1行へまとめる。
        // 情報量は落とさず(各属性のHRESULTはそのまま含める)、ログ量だけを1/4にする。
        // 色関連の属性(CAPTION/TEXT/BORDER)はWindows 11 Build 22000以降でのみ有効で、
        // それ未満のOSではhrが非0になるが、それは異常ではない。
        Logger.Write(
            $"WindowChrome: タイトルバー配色を適用 (理由={reason}, 呼出元={DescribeCaller(callerMember, callerFile, callerLine)}, " +
            $"hwnd=0x{handle.ToInt64():X}, isDark={isDark}, darkMode={darkResult}, " +
            $"caption({bg})=0x{captionHr:X8}, text({fg})=0x{textHr:X8}, border({border})=0x{borderHr:X8}, " +
            $"前回適用から={(sinceLastMs < 0 ? "初回" : sinceLastMs + "ms")}, 直前までの抑止={state.SkipCount}回)");

        state.Handle = handle;
        state.IsDark = isDark;
        state.Background = bg;
        state.Foreground = fg;
        state.Border = border;
        state.LastAppliedTick = Environment.TickCount64;
        state.SkipCount = 0;
    }

    /// <summary>今回の呼び出しで実際にDWMを叩く必要があるかを判定する。必要ならその理由
    /// (ログに出す文字列)を、不要(前回と完全に同じ)ならnullを返す。
    /// ハンドルの違いを理由に含めているのは、「同じFormのまま何らかの理由でウィンドウ
    /// ハンドルが再作成された」場合に塗り直しが必要なため。実機で0.37秒周期の呼び出しが
    /// 続く原因がハンドル再作成であれば、この理由がログに出て一目で分かる。</summary>
    private static string? ResolveApplyReason(AppliedTheme state, IntPtr handle, bool isDark, string bg, string fg, string border)
    {
        if (state.Handle == IntPtr.Zero) return "初回";
        if (state.Handle != handle) return $"ウィンドウハンドルが再作成された(旧=0x{state.Handle.ToInt64():X})";
        if (state.IsDark != isDark) return $"ダーク判定が変化({state.IsDark}→{isDark})";
        if (!string.Equals(state.Background, bg, StringComparison.OrdinalIgnoreCase)) return $"背景色が変化({state.Background}→{bg})";
        if (!string.Equals(state.Foreground, fg, StringComparison.OrdinalIgnoreCase)) return $"文字色が変化({state.Foreground}→{fg})";
        if (!string.Equals(state.Border, border, StringComparison.OrdinalIgnoreCase)) return $"枠色が変化({state.Border}→{border})";
        return null;
    }

    /// <summary>呼び出し元を「ファイル名:メソッド名(行番号)」の形で表す。実機ログから
    /// 「ApplyThemeがどの経路で呼ばれているか」を追うためだけに使う。</summary>
    private static string DescribeCaller(string callerMember, string callerFile, int callerLine)
    {
        string file = string.IsNullOrEmpty(callerFile) ? "?" : Path.GetFileName(callerFile);
        // callerLine=0は「呼び出し元が中継メソッド越しに自分で名前を渡してきた」ケース
        // (MainForm.ApplyTitleBarTheme参照)。その場合の行番号は中継メソッド自身の位置を
        // 指してしまい誤解のもとなので出さない。
        return callerLine > 0 ? $"{file}:{callerMember}({callerLine})" : $"{file}:{callerMember}";
    }

    /// <summary>DWMWA_USE_IMMERSIVE_DARK_MODEを設定する。値20(Windows 10 1903以降・Windows 11)で
    /// まず試し、失敗したら値19(Windows 10 1809〜1903)で再試行する。両方失敗しても無視する
    /// (それより古いWindowsや非対応環境ではタイトルバーが既定色のままになるだけ)。
    /// 戻り値は結果をログ1行へ埋め込むための短い文字列(呼び出し元がまとめて出力する)。</summary>
    private static string SetImmersiveDarkMode(IntPtr handle, bool isDark)
    {
        int value = isDark ? 1 : 0;
        int hr = TrySetAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE, value);
        if (hr == 0) return "成功(20)";

        int hrOld = TrySetAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, value);
        return hrOld == 0
            ? $"20は失敗(0x{hr:X8})→19で成功"
            : $"20/19とも失敗(0x{hr:X8}/0x{hrOld:X8}・Windows 10 1809未満または非対応環境の可能性。無視して続行)";
    }

    /// <summary>
    /// DwmSetWindowAttributeを1回呼び出す。関数自体は未対応環境ではHRESULTを返すだけだが、
    /// dwmapi.dllが存在しない環境(非Windows実行等)ではDllNotFoundException等を投げ得るため、
    /// ここで丸ごとtry-catchして例外を外へ伝播させない。戻り値は成功時0(S_OK)、
    /// 失敗時は非0のHRESULT相当値(呼び出し自体が例外だった場合は便宜上-1)。
    /// </summary>
    private static int TrySetAttribute(IntPtr handle, int attribute, int value)
    {
        try
        {
            return DwmSetWindowAttribute(handle, attribute, ref value, sizeof(int));
        }
        catch (Exception ex)
        {
            Logger.WriteException($"WindowChrome.TrySetAttribute(attribute={attribute})", ex);
            return -1;
        }
    }

    /// <summary>
    /// "#RRGGBB"形式の16進色文字列をCOLORREF形式(0x00BBGGRR)へ変換する。
    /// 形式が不正な場合は例外を投げず、黒(0)にフォールバックしてログに残す。
    /// </summary>
    private static uint ToColorRef(string hex)
    {
        try
        {
            string h = hex.TrimStart('#');
            if (h.Length != 6)
            {
                throw new FormatException($"6桁の16進RGBではありません: '{hex}'");
            }
            byte r = Convert.ToByte(h.Substring(0, 2), 16);
            byte g = Convert.ToByte(h.Substring(2, 2), 16);
            byte b = Convert.ToByte(h.Substring(4, 2), 16);
            return (uint)((b << 16) | (g << 8) | r);
        }
        catch (Exception ex)
        {
            Logger.WriteException($"WindowChrome.ToColorRef('{hex}')", ex);
            return 0;
        }
    }

    /// <summary>
    /// 不具合修正: 「エクスプローラからファイルを開いたとき、Paneのウィンドウが前面に来ない
    /// ことがある」対策。名前付きパイプ経由でウィンドウを開く/切り替えるすべての経路
    /// (<see cref="PaneApplicationContext.OpenWindowFromPipeRequest"/>・
    /// <see cref="PaneApplicationContext"/>内のタブ追加・新規ウィンドウ作成・Ctrl+Tab切替)が
    /// ここを通ることで、確実な前面化を1箇所にまとめる。
    /// 1. 非表示ならShow()する
    /// 2. 最小化されていればWindowState=Normalで復元する
    /// 3. Activate()する(内部でForm.Activate→SetForegroundWindowを試みるが、
    ///    受信側プロセスにフォアグラウンド権が無いと失敗し得る)
    /// 4. SetForegroundWindowを明示的にもう一度呼ぶ(SingleInstance側のAllowSetForegroundWindow
    ///    による権限譲渡と対になっており、こちらは譲渡が効いていれば成功する)
    /// TopMostを一時的にtrueへ切り替えて戻すようなハックは使わない(ちらつき・
    /// 「常に手前に表示」設定(MainForm.ToggleAlwaysOnTop)との競合を避けるため)。
    /// </summary>
    public static void ForceActivate(Form form)
    {
        if (form.IsDisposed) return;

        if (!form.Visible)
        {
            form.Show();
        }
        if (form.WindowState == FormWindowState.Minimized)
        {
            form.WindowState = FormWindowState.Normal;
        }
        form.Activate();

        if (form.IsHandleCreated)
        {
            TrySetForegroundWindow(form.Handle);
        }
    }

    /// <summary>SetForegroundWindowを1回呼び出す。Windows以外の環境ではuser32.dll自体が
    /// 存在せず呼び出しがDllNotFoundException等になり得るため、丸ごとtry-catchして
    /// 呼び出し元(ForceActivate)へは例外を伝播させない。失敗してもログに残すのみ。</summary>
    private static void TrySetForegroundWindow(IntPtr handle)
    {
        try
        {
            if (!SetForegroundWindow(handle))
            {
                Logger.Write($"WindowChrome.TrySetForegroundWindow: 失敗(GetLastError=0x{Marshal.GetLastWin32Error():X8})。フォアグラウンド権が譲渡されていない可能性がある");
            }
        }
        catch (Exception ex)
        {
            Logger.WriteException("WindowChrome.TrySetForegroundWindow", ex);
        }
    }

    /// <summary>
    /// Windowsのアプリ配色設定(設定 > 個人用設定 > 色 > 既定のアプリモード)がダークかどうかを
    /// レジストリ HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize の
    /// AppsUseLightTheme から判定する。値が1(または未取得)ならライト、0ならダーク。
    /// キー自体が無い・読み取りに失敗した場合はライト扱いにする(仕様どおり)。
    /// </summary>
    public static bool IsSystemDarkTheme()
    {
        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            object? value = key?.GetValue("AppsUseLightTheme");
            if (value is int intValue)
            {
                return intValue == 0;
            }
            return false; // キー/値が無い場合はライト扱い
        }
        catch (Exception ex)
        {
            Logger.WriteException("WindowChrome.IsSystemDarkTheme", ex);
            return false; // 読み取り失敗時もライト扱い
        }
    }
}
