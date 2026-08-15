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
    /// タイトルバーの配色を適用する。isDarkに応じてDWMWA_USE_IMMERSIVE_DARK_MODEを設定したうえで、
    /// 背景・文字・枠の色を設定する。backgroundHex/foregroundHexが指定されていればそれを使い
    /// (案A: JS側からの実描画色)、未指定(null/空)ならisDarkに応じた既定色(案B)を使う。
    /// 呼び出し自体は例外を投げない(内部のTrySetAttributeが全例外を握りつぶす)。
    /// </summary>
    public static void ApplyTheme(IntPtr handle, bool isDark, string? backgroundHex = null, string? foregroundHex = null)
    {
        if (handle == IntPtr.Zero)
        {
            Logger.Write("WindowChrome.ApplyTheme: handleがIntPtr.Zeroのため何もしない");
            return;
        }

        SetImmersiveDarkMode(handle, isDark);

        string bg = !string.IsNullOrWhiteSpace(backgroundHex)
            ? backgroundHex!
            : (isDark ? DefaultDarkBackground : DefaultLightBackground);
        string fg = !string.IsNullOrWhiteSpace(foregroundHex)
            ? foregroundHex!
            : (isDark ? DefaultDarkForeground : DefaultLightForeground);

        SetCaptionColor(handle, bg);
        SetTextColor(handle, fg);
        // 枠は背景と別の色にして細い輪郭を出す。背景と同色にしていたときは、特にダークテーマで
        // ウィンドウを重ねるとどこまでが手前のウィンドウか分からなくなっていた。
        SetBorderColor(handle, isDark ? DefaultDarkBorder : DefaultLightBorder);
    }

    /// <summary>DWMWA_USE_IMMERSIVE_DARK_MODEを設定する。値20(Windows 10 1903以降・Windows 11)で
    /// まず試し、失敗したら値19(Windows 10 1809〜1903)で再試行する。両方失敗しても無視する
    /// (それより古いWindowsや非対応環境ではタイトルバーが既定色のままになるだけ)。</summary>
    private static void SetImmersiveDarkMode(IntPtr handle, bool isDark)
    {
        int value = isDark ? 1 : 0;
        int hr = TrySetAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE, value);
        if (hr == 0)
        {
            Logger.Write($"WindowChrome: DWMWA_USE_IMMERSIVE_DARK_MODE(20) isDark={isDark} 成功");
            return;
        }

        Logger.Write($"WindowChrome: DWMWA_USE_IMMERSIVE_DARK_MODE(20)失敗(hr=0x{hr:X8})。値19で再試行します(Windows 10 1809〜1903向け)");
        int hrOld = TrySetAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, value);
        Logger.Write(hrOld == 0
            ? "WindowChrome: DWMWA_USE_IMMERSIVE_DARK_MODE(19) 成功"
            : $"WindowChrome: DWMWA_USE_IMMERSIVE_DARK_MODE(19)も失敗(hr=0x{hrOld:X8})。Windows 10 1809未満、または非対応環境の可能性。無視して続行");
    }

    /// <summary>タイトルバー背景色を設定する(Windows 11 Build 22000以降のみ有効。
    /// それ未満のOSでは失敗するがログに残すのみで処理は継続する)。</summary>
    private static void SetCaptionColor(IntPtr handle, string hex)
    {
        int colorRef = unchecked((int)ToColorRef(hex));
        int hr = TrySetAttribute(handle, DWMWA_CAPTION_COLOR, colorRef);
        Logger.Write($"WindowChrome: DWMWA_CAPTION_COLOR({hex}) hr=0x{hr:X8} (Windows 11 Build 22000以降のみ有効)");
    }

    /// <summary>タイトルバー文字色を設定する(Windows 11 Build 22000以降のみ有効)。</summary>
    private static void SetTextColor(IntPtr handle, string hex)
    {
        int colorRef = unchecked((int)ToColorRef(hex));
        int hr = TrySetAttribute(handle, DWMWA_TEXT_COLOR, colorRef);
        Logger.Write($"WindowChrome: DWMWA_TEXT_COLOR({hex}) hr=0x{hr:X8} (Windows 11 Build 22000以降のみ有効)");
    }

    /// <summary>ウィンドウ枠の色を設定する(Windows 11 Build 22000以降のみ有効)。</summary>
    private static void SetBorderColor(IntPtr handle, string hex)
    {
        int colorRef = unchecked((int)ToColorRef(hex));
        int hr = TrySetAttribute(handle, DWMWA_BORDER_COLOR, colorRef);
        Logger.Write($"WindowChrome: DWMWA_BORDER_COLOR({hex}) hr=0x{hr:X8} (Windows 11 Build 22000以降のみ有効)");
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
