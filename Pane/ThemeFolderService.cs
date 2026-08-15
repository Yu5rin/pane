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
    /// :root定義。このファイル更新時点(色関係の変数が18個→58個超に増えたタイミング)で
    /// 実在するものを役割ごとにグループ分けし、既定のライト/ダーク値と日本語の短い説明を
    /// 添えて全件掲載する。値はコメントアウトせず実際に有効な形で書いておき(既定と
    /// 同じ値のため読み込んでも見た目は変わらない)、コピーしてそのまま数値・色コードを
    /// 書き換えれば自作テーマになる構成にする。
    /// 見出し・コードブロックの見た目そのものを変える例、危険な上書き(display/position/
    /// overflow等のレイアウト系プロパティの変更)への注意書きも添える。
    /// テーマプリセット選択時のCSS詳細度(specificity)の落とし穴についても、テーマ作者
    /// 向けにかみ砕いて説明する。
    /// カラーピッカーのプレビュー用変数(--cp-color等)・折りたたみインジケータ等、
    /// JS側が要素ごとにインラインで書き込む一時的な変数、およびサイドバー幅等の
    /// レイアウト状態変数(--sidebar-w等)は、テーマ設定の対象ではないため掲載しない。
    /// </summary>
    private const string SampleCssContent = """
        /* ==============================================================
           Pane カスタムCSS サンプル
           ==============================================================
           設定 > 外観 > カスタムCSS の「参照…」でこのファイルを選ぶと読み込まれます。
           下の :root / html[data-theme="dark"] ブロックには、Paneの既定(ライト/
           ダーク)テーマと同じ値をあらかじめ書いてあります。そのまま保存しても
           見た目は変わりません(プリセットテーマを選んでいる場合も、後述の
           詳細度の理由によりプリセット側の値が優先されるため見た目は変わりません)。
           値を書き換えると、その項目だけテーマが変わります。コピーして数値・
           色コードを書き換えるだけで自作テーマが作れる形にしてあります。

           ここに書いていない名前の変数を新しく作ることはできません(Pane本体の
           CSSがその名前を実際に参照している変数だけが意味を持ちます)。

           外部通信について: Pane本体は「外部通信を一切行わない」方針のアプリです。
           このファイルにWebフォントの @import・外部画像のURL・フォントCDN等を
           書いても読み込まれません(通信そのものが行われません)。フォントは
           OSにインストール済みのフォント名を指定する形だけがサポートされます。
           ============================================================== */

        /* ==============================================================
           ライト/ダークの書き分け方
           ==============================================================
           ・ライト用の値は下の `:root { ... }` に書きます。
           ・ダークモードのときだけ別の値にしたい変数は
             `html[data-theme="dark"] { ... }` の方に書きます。
             (ダーク用ブロックに書かなかった変数は :root の値をそのまま引き継ぎます。
             「ライトと同じ色でよい」変数はダーク側に書く必要はありません。)

           【重要: CSSの詳細度(specificity)の話】
           設定 > 外観 でPane組み込みのテーマプリセット(sepia / github / nord /
           dracula 等)を選んでいる場合、Pane本体はプリセットの配色を

             html[data-theme="dark"][data-dark-theme="nord"] { --paper: ...; }

           のように、data-theme に加えてプリセットID(data-light-theme /
           data-dark-theme)も条件にしたセレクタで定義しています。このセレクタは
           このファイルで使う素の `html[data-theme="dark"]` よりCSSの詳細度が
           高いため、カスタムCSSは読み込み順が一番最後であっても、プリセット側の
           値に負けてしまいます(CSSでは詳細度が読み込み順より優先されるためです)。

           ・カスタムCSSの内容を確実に反映させたいときは、設定 > 外観 の
             テーマプリセットを「既定」のままにしてください。
           ・プリセットを選んだ状態でもカスタムCSSを勝たせたい場合は、
             data-dark-theme 属性の「有無」だけを条件にする(値までは指定しない)
             等、プリセット側と同じかそれ以上に詳細度を上げたセレクタで書いて
             ください。例:
               html[data-theme="dark"][data-dark-theme] { --accent: #A996F0; }
           ============================================================== */

        /* ==============================================================
           省略したときにどうなるか
           ==============================================================
           ・このファイルに書かなかった変数は、現在選んでいるテーマ(既定または
             プリセット)の値がそのまま使われます。一部だけ書いても壊れません。
           ・次の変数は既定で「他の変数の値をそのまま使う」形になっているため、
             元になっている方を変えるだけで自動的に追従します(両方書く必要は
             ありません):
               --sidebar-bg     省略時は --surface と同じ
               --titlebar-fg    省略時は --ink と同じ
               --menu-hover-fg  省略時は --accent と同じ
               --code-op        省略時は --ink と同じ
               --frontmatter-bg 省略時は --panel-bg と同じ
           ============================================================== */

        :root {
          /* ---- 本文エリア(基本の配色) ---- */
          --paper: #FBFBFA;        /* 本文の背景色 */
          --ink: #1F2428;           /* 本文の文字色 */
          --ink-sub: #66707A;       /* 補助的な文字色(引用の縦線・文字数表示等) */
          --ink-mute: #6B7378;      /* さらに控えめな文字色(Markdown記号・アウトライン下位階層等) */
          --line: #DCE2E0;          /* 罫線・枠線の色(ボタンの枠・区切り線等) */
          --rule: #E4E7E6;          /* メニューバー/タイトルバー/サイドバー周りの区切り線の色。コードモードのインデントガイド(縦線)にも使う */
          --fold-guide-hover: var(--accent); /* 折りたたみマーカー(+/-)にマウスを乗せている間、その範囲のインデントガイドを塗る色。省略すると--accentに追従する */
          --accent: #2F6F68;        /* アクセントカラー(リンク・強調・チェック・現在選択中の項目等) */
          --accent-hover: #0A5A56;  /* アクセントのホバー時の色(ボタンのホバー等) */
          --accent-soft: #E1EFED;   /* アクセントの淡色(ホバー背景・選択範囲の背景等) */

          /* ---- サイドバー・パネル・入力欄 ---- */
          --surface: #FFFFFF;       /* カード・ダイアログ・ドロップダウン等、本文の上に浮く面の背景色 */
          --sidebar-bg: var(--surface); /* サイドバーの背景色(省略時は --surface と同じ) */
          --panel-bg: color-mix(in srgb, var(--ink) 6%, var(--paper)); /* 表のヘッダー行・生テキスト表示中の表の行など、本文よりわずかに沈んだ帯の背景色 */
          --frontmatter-bg: var(--panel-bg); /* Front Matter(先頭の ---で囲むメタ情報)の背景色(省略時は --panel-bg と同じ) */
          --input-bg: #FAFBFB;      /* ダイアログ・カラーピッカー等、入力欄(input)の背景色 */

          /* ---- メニューバー・タイトルバー・ヘッダー ---- */
          --chrome-bg: #EFF1F0;     /* メニューバー(Altキーで表示/非表示)の背景色 */
          --titlebar-bg: #EFF1F0;   /* ウィンドウのタイトルバーの背景色(OS側のタイトルバーにも反映されます) */
          --titlebar-fg: var(--ink); /* タイトルバーの文字・アイコンの色(省略時は --ink と同じ) */
          --menu-hover-fg: var(--accent); /* メニュー項目をホバー/選択したときの文字色(省略時は --accent と同じ) */
          --topbar: #0F6E69;        /* 濃色ヘッダーバーの背景色 */
          --topbar-ink: #EAF4F3;    /* 濃色ヘッダーバーの文字色 */

          /* ---- コードブロック ---- */
          --code-bg: #EEF1F3;       /* インラインコード・表の中身の背景色 */
          --pre-bg: #262C31;        /* フェンスコードブロック(```で囲む部分)の背景色 */
          --pre-ink: #E8EAED;       /* フェンスコードブロックの文字色(色分けされないプレーンな文字) */

          /* ---- コードの色分け(シンタックスハイライト) ----
             「本文と同じ色だと種類が見分けられない」ときに使う11個の変数です。
             全部同じ色に揃えれば単色のコードブロックに、役割ごとに変えれば
             種類が一目でわかるようになります(VS Codeの配色テーマと同じ考え方)。 */
          --code-kw: #0000FF;       /* キーワード全般(const/let/function等の宣言・修飾キーワード)の色 */
          --code-kw2: #0000FF;      /* 制御構文キーワード(if/for/return等)の色。書き分けない場合は --code-kw と同じ値でよい */
          --code-var: #001080;      /* 変数の参照・宣言(document, sum等)の色 */
          --code-fn: #795E26;       /* 関数・メソッド名(getElementById等)の色 */
          --code-str: #A31515;      /* 文字列の色 */
          --code-num: #098658;      /* 数値・真偽値の色 */
          --code-cmt: #008000;      /* コメントの色 */
          --code-type: #267F99;     /* 型名・クラス名の色 */
          --code-prop: #001080;     /* オブジェクト/JSONのキー・HTML/CSS属性名の色 */
          --code-op: var(--ink);    /* 演算子・括弧・カンマ等の記号の色(省略時は --ink と同じ) */
          --code-regex: #811F3F;    /* 正規表現リテラルの色 */

          /* ---- Callout(GitHub式アラート: `> [!NOTE]` のような引用ブロック) ----
             NOTE/TIP/IMPORTANT/WARNING/CAUTION の5種類。それぞれ「左罫線・アイコン
             の色」と「背景色」の2つずつ、計10個の変数があります。 */
          --callout-note: var(--accent);                                                /* NOTE の左罫線・アイコンの色 */
          --callout-note-bg: color-mix(in srgb, var(--accent) 8%, var(--paper));        /* NOTE の背景色 */
          --callout-tip: color-mix(in srgb, var(--accent) 70%, var(--ink-mute) 30%);    /* TIP の左罫線・アイコンの色 */
          --callout-tip-bg: color-mix(in srgb, var(--accent) 6%, var(--paper));         /* TIP の背景色 */
          --callout-important: color-mix(in srgb, var(--accent) 55%, var(--ink) 45%);   /* IMPORTANT の左罫線・アイコンの色 */
          --callout-important-bg: color-mix(in srgb, var(--accent) 10%, var(--paper));  /* IMPORTANT の背景色 */
          --callout-warning: color-mix(in srgb, var(--ink-mute) 55%, var(--accent) 45%); /* WARNING の左罫線・アイコンの色 */
          --callout-warning-bg: color-mix(in srgb, var(--ink-mute) 10%, var(--paper));   /* WARNING の背景色 */
          --callout-caution: color-mix(in srgb, var(--ink) 55%, var(--ink-mute) 45%);    /* CAUTION の左罫線・アイコンの色 */
          --callout-caution-bg: color-mix(in srgb, var(--ink-mute) 14%, var(--paper));   /* CAUTION の背景色 */

          /* ---- 状態表示・警告色 ---- */
          --danger: #B03A2E;        /* 削除・エラー等、警告を表す文字色 */
          --danger-soft: #F9ECEA;   /* 警告の背景色(危険な操作の確認バナー等) */
          --pending: #B7791F;       /* 保存待ち(自動保存が終わるまでの間)のステータス表示の文字色 */
          --status-ok: #8FDAD2;     /* 状態インジケータ「正常」を表す色 */
          --status-off: #AFC4C0;    /* 状態インジケータ「オフ/無効」を表す色 */
          --status-pend: #F2C368;   /* 状態インジケータ「保留」を表す色(--pendingとは別の変数) */

          /* ---- カラーピッカー ---- */
          --cp-checker: color-mix(in srgb, var(--ink) 16%, transparent); /* 半透明の色をプレビューするときに敷く市松模様の色 */

          /* ---- フォント ---- */
          --font-heading: "Source Serif 4", "Noto Serif JP", serif;    /* 見出しの書体 */
          --font-body: "Inter", "Noto Sans JP", system-ui, sans-serif; /* 本文の書体 */
          --font-mono: "JetBrains Mono", "BIZ UDゴシック", ui-monospace, monospace; /* コード・等幅表示の書体 */

          /* ---- 影・角丸・寸法(色ではない変数) ---- */
          --radius: 10px;           /* ボタン等の角丸の半径 */
          --shadow-card: 0 1px 2px rgba(16,24,32,.05), 0 10px 30px rgba(16,24,32,.08); /* カード状の要素に付ける影 */
          --shadow-pop: 0 6px 24px rgba(16,24,32,.14); /* ダイアログ・ドロップダウン等、浮いた要素に付ける影 */
          --bar-h: 48px;             /* モバイル用キーボード上部ツールバーの高さ */

          /* ---- 本文の余白・行間・編集領域だけのフォント(色ではない変数) ----
             設定 > 編集 の対応する項目(本文の余白・行の高さ・本文/等幅フォント)を
             指定している間は、その値がJS側から直接書き込まれるため、ここで指定
             してもそちらが優先されます。設定側を既定のまま(未指定)にしている
             ときだけ、ここに書いた値が有効になります。 */
          --editor-padding-left: 32px;   /* 本文エリアの左余白(Markdownモード) */
          --editor-padding-right: 32px;  /* 本文エリアの右余白(Markdownモード) */
          --editor-line-height: 1.95;    /* 本文の行の高さ */
          --editor-max-width: none;      /* 本文エリアの最大幅(Markdownモードのみ有効。既定は無制限) */
          --editor-font-body: var(--font-body); /* 編集領域(地の文)だけ別フォントにしたいとき。既定は --font-body と同じ */
          --editor-font-mono: var(--font-mono); /* コードブロック・行番号だけ別フォントにしたいとき。既定は --font-mono と同じ */
        }

        /* ダーク既定: ここに書いた変数だけがライトの値から上書きされます。
           (--radius や --font-*、--callout-*、--status-* 等、ここに出てこない
           変数はライトと同じ値がそのまま使われます) */
        html[data-theme="dark"] {
          /* ---- 本文エリア ---- */
          --paper: #14171A;
          --ink: #E4E7E5;
          --ink-sub: #93A0A8;
          --ink-mute: #8A9296;
          --line: #2C343A;
          --rule: #242A2E;
          --accent: #6FB3A8;
          --accent-hover: #4CC5BC;
          --accent-soft: #1E2C2B;

          /* ---- サイドバー・パネル・入力欄 ---- */
          --surface: #1C2226;
          --input-bg: #171C20;

          /* ---- メニューバー・タイトルバー・ヘッダー ---- */
          --chrome-bg: #0E1012;
          --titlebar-bg: #0E1012;
          --topbar: #0C2A27;
          --topbar-ink: #D9EAE7;

          /* ---- コードブロック ---- */
          --code-bg: #0B0D0F;
          --pre-bg: #10151A;
          --pre-ink: #DDE3E7;

          /* ---- コードの色分け(シンタックスハイライト) ---- */
          --code-kw: #569CD6;
          --code-kw2: #C586C0;
          --code-var: #9CDCFE;
          --code-fn: #DCDCAA;
          --code-str: #CE9178;
          --code-num: #B5CEA8;
          --code-cmt: #6A9955;
          --code-type: #4EC9B0;
          --code-prop: #9CDCFE;
          --code-regex: #D16969;

          /* ---- 状態表示・警告色 ---- */
          --danger: #E07B6E;
          --danger-soft: #3A2320;
          --pending: #D9A24A;

          /* ---- 影(ダークは黒の不透明度を上げた別の値を使用) ---- */
          --shadow-card: 0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.35);
          --shadow-pop: 0 6px 24px rgba(0,0,0,.5);
        }

        /* ==============================================================
           見出し・コードブロックの見た目そのものを変える例
           ============================================================== */

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
