using System.Diagnostics;
using System.Text;

namespace Pane;

/// <summary>
/// カスタムCSS(仕様書 第2.10節 C-07、設定キー <see cref="AppSettings.CustomCssPath"/>)の
/// 既定の置き場(%LOCALAPPDATA%\Pane\themes\)を用意するサービス。
///
/// 「何もない状態からカスタムCSSを書くのは難しい」というユーザー要望に応え、
/// このフォルダに参考用のサンプルCSS(sample.css)を書き出しておく。
/// 設定画面の「カスタムCSS」の「参照…」ボタンはこのフォルダを初期位置として開き
/// (<see cref="SettingsBridge.HandleBrowsePathRequest"/>)、「サンプルのあるフォルダを開く」
/// ボタンはこのフォルダをエクスプローラーで開く(<see cref="OpenInExplorer"/>)。
/// </summary>
internal static class ThemeFolderService
{
    /// <summary>カスタムCSSの既定フォルダのパス。%LOCALAPPDATA%\Pane\themes</summary>
    public static string FolderPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Pane", "themes");

    /// <summary>
    /// フォルダが無ければ作成し、サンプルCSS(sample.css)が無ければ書き出す。
    /// 既に sample.css が存在する場合は上書きしない(ユーザーが編集して育てている可能性が
    /// あるため)。アプリ起動のたび(MainForm初期化時)に呼ばれる想定だが、File.Exists判定
    /// により実質的に初回のみファイルを書き出す。失敗しても起動を妨げないよう例外は
    /// ここで握りつぶし、Loggerへ記録するだけにする。
    /// </summary>
    public static void EnsureSampleCss()
    {
        try
        {
            Directory.CreateDirectory(FolderPath);
            string samplePath = Path.Combine(FolderPath, "sample.css");
            if (File.Exists(samplePath))
            {
                return;
            }
            // BOM無しUTF-8で書き出す(Pane本体のCSS読み込み(MainForm.ReadCustomCss)は
            // File.ReadAllTextを使っており、BOM有無どちらでも読めるが、他エディタでの
            // 扱いやすさのためBOM無しに揃える)。
            File.WriteAllText(samplePath, SampleCssContent, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            Logger.Write($"ThemeFolderService: サンプルCSSを書き出した: {samplePath}");
        }
        catch (Exception ex)
        {
            Logger.WriteException("ThemeFolderService.EnsureSampleCss失敗", ex);
        }
    }

    /// <summary>このフォルダをエクスプローラーで開く。フォルダが無ければ先に作成する。</summary>
    public static void OpenInExplorer()
    {
        try
        {
            Directory.CreateDirectory(FolderPath);
            using var proc = Process.Start(new ProcessStartInfo("explorer.exe", $"\"{FolderPath}\"") { UseShellExecute = true });
            Logger.Write($"open-theme-folder: エクスプローラーでテーマフォルダを開いた: {FolderPath}");
        }
        catch (Exception ex)
        {
            Logger.WriteException("ThemeFolderService.OpenInExplorer失敗", ex);
        }
    }

    /// <summary>
    /// サンプルCSSの中身。Paneが実際に使っているCSSカスタムプロパティ(src/style.cssの
    /// :root定義を参照。日付: このファイル作成時点で実在するもののみ抜粋)を上書きする例と、
    /// 見出し・コードブロックの見た目を変える例を、日本語コメント付きで示す。
    /// 危険な上書き(display/position/overflow等のレイアウト系プロパティの変更)には
    /// 注意書きを添える。既定はすべてコメントアウトしてあり、そのまま保存しても
    /// 見た目は変わらない(コピーして必要な行だけコメントを外して使う想定)。
    /// </summary>
    private const string SampleCssContent = """
        /* ==============================================================
           Pane カスタムCSS サンプル
           ==============================================================
           設定 > 外観 > カスタムCSS の「参照…」でこのファイルを選ぶと読み込まれます。
           このまま使うと見た目は変わりません(すべてコメントアウトしてあります)。
           このファイルをコピーして必要な行のコメント( /* ... * / )を外し、
           値を書き換えてから読み込んでください。
           ============================================================== */

        /* ---- Paneが使っている主なCSS変数(このファイルで扱っているもののみ抜粋) ----
           --paper        本文の背景色
           --ink           本文の文字色
           --ink-mute      控えめな文字色(コメント表示・キャプション等)
           --ink-sub       補助的な文字色(引用の縦線の色等)
           --line / --rule 罫線・区切り線の色
           --accent        アクセントカラー(リンク・強調・チェック等)
           --accent-hover  アクセントのホバー色
           --accent-soft   アクセントの淡色(選択範囲の背景等)
           --code-bg       インラインコード・表の背景
           --pre-bg        コードブロックの背景
           --pre-ink       コードブロックの文字色
           --font-heading  見出しの書体
           --font-body     本文の書体
           --font-mono     コード・等幅の書体
           ここに無い変数(--danger, --status-* 等)は警告・状態表示専用のため、
           テーマ目的での上書きはおすすめしません。 */

        :root {
          /* 例1: アクセントカラーを変える(リンク・強調・チェックボックス等に反映されます) */
          /* --accent: #7C5CE0; */
          /* --accent-hover: #6647C4; */
          /* --accent-soft: #EFEAFB; */

          /* 例2: 見出しの書体を変える(インストール済みのフォント名をそのまま指定できます) */
          /* --font-heading: "游明朝", "Yu Mincho", serif; */

          /* 例3: コードブロックの配色を変える */
          /* --pre-bg: #1B1F3B; */
          /* --pre-ink: #E5E9FF; */
        }

        /* ダークモード時だけ別の値にしたい場合はこちらへ(Pane本体のテーマ定義と同じ書き方)。
           ライトモード用の値は上の :root に、ダークモード用はここに書く。 */
        html[data-theme="dark"] {
          /* --accent: #A996F0; */
        }

        /* ---- 見出しの見た目を変える例(編集中のライブレンダリング表示に効きます) ---- */
        /*
        .cm-line.cm-heading-1 {
          color: var(--accent);
          border-bottom: 2px solid var(--line);
        }
        */

        /* ---- コードブロックの見た目を変える例 ---- */
        /*
        .cm-line.cm-codeblock-line {
          background: var(--pre-bg);
          color: var(--pre-ink);
        }
        */

        /* ==============================================================
           注意: 上書きすると表示が壊れる可能性がある指定
           ==============================================================
           ・display / position / overflow など、レイアウトに関わるプロパティは
             変更しないでください。編集領域(#cm-host, .cm-content, .cm-scroller等)や
             サイドバー・メニューバーの構造が崩れ、最悪の場合カーソル位置が正しく
             表示されない・操作しづらくなることがあります。
           ・#cm-host 等の編集領域に width / height を直接指定するのも避けてください。
             ウィンドウサイズの変更に追従できなくなります。
           ・!important を多用すると、Pane本体側の折り返し・選択範囲などの表示制御と
             衝突することがあります。色・書体・余白など見た目のプロパティに留めるのが
             安全です。
           ============================================================== */

        """;
}
