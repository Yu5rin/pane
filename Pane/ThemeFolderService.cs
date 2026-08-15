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
           目次(ここから下: 「見た目を直接変える」実例集)
           ==============================================================
           ここまでのCSS変数だけでは調整できない、Paneの画面を構成する要素を
           直接スタイリングする実例です。すべてCSSのコメントとして無効化した
           状態で置いてあるので、そのまま保存しても見た目は変わりません。変えたい
           項目を見つけたら、その前後のコメント記号を外して値を書き換えてください。
           セレクタはすべて、この更新時点でPane本体(src/style.css・src/editor.js・
           src/index.html)が実際に使っているクラス名/idだけを載せています。

             1. 本文の書式(見出し・リンク・強調・打ち消し線・ハイライト)
             2. リスト・チェックボックス
             3. 引用
             4. コードブロックとインラインコード
             5. 表
             6. Callout(GitHub式アラート)
             7. 水平線・脚注・目次・Front Matter
             8. コードモードの要素(行番号ガター・インデントガイド・折りたたみ・
                括弧の対応表示・検索のヒット表示)
             9. アプリのUI(メニューバー・タイトルバー・サイドバー・タブバー・
                ステータスバー・検索パネル・設定画面・コンテキストメニュー・ダイアログ)
            10. 注意: 上書きすると表示が壊れる可能性がある指定
            11. 元に戻す方法
           ============================================================== */

        /* ==============================================================
           1. 本文の書式
           ============================================================== */

        /* ---- 見出し(# 〜 ######)。編集中のライブレンダリング表示に効きます ----
           Paneが個別のクラスで装飾する見出しはh1〜h4まで(.tok-h1〜.tok-h4)です。
           h5・h6には専用のクラスが無く、本文と同じ見た目のまま表示されます
           (現状の仕様。将来h5/h6用のクラスが増えたらこの節に追記します)。 */
        /*
        .tok-h1 { color: var(--accent); border-bottom: 2px solid var(--line); }
        .tok-h2 { color: var(--accent); }
        */
        /* この2行のコメントを外すと、h1の文字がアクセントカラーになり下線が付きます。
           h2は文字色だけアクセントカラーに変わります(下線は付きません)。 */

        /* ---- 段落について ----
           Paneの本文は1行=CodeMirrorの1行としてそのまま描画され、他のエディタに
           あるような段落(<p>)単位のセレクタは存在しません。段落・行の間隔は
           上の変数一覧の --editor-line-height でのみ調整できます。 */

        /* ---- リンク ---- */
        /*
        .tok-link { color: var(--danger); text-decoration: none; }
        */
        /* この行のコメントを外すと、リンクの下線が消え、色が警告色(--danger)に変わります。 */

        /* ---- 強調(**太字**)・斜体(*イタリック*) ---- */
        /*
        .tok-bold { color: var(--accent); }
        .tok-italic { color: var(--ink-sub); }
        */
        /* 太字はアクセントカラーに、斜体は控えめな色(--ink-sub)に変わります。 */

        /* ---- 打ち消し線(~~text~~) ---- */
        /*
        .tok-strike { color: var(--ink-mute); }
        */
        /* 打ち消し線が引かれた文字の色が薄くなります(線自体の色はtext-decoration-color:
           currentColor指定のため文字色に連動し、個別には変えられません)。 */

        /* ---- ハイライト(==text==) ---- 既定は変数化されていない固定の黄色です。 */
        /*
        .tok-mark { background: var(--accent-soft); color: var(--accent); }
        */
        /* この行のコメントを外すと、ハイライトの黄色い背景がアクセントカラーの
           淡色(--accent-soft)に変わります。 */

        /* ==============================================================
           2. リスト・チェックボックス
           ============================================================== */

        /* ---- 箇条書きの記号(-や* を「•」に置き換えて表示しているウィジェット) ---- */
        /*
        .cm-bullet { color: var(--danger); font-weight: 700; }
        */
        /* 「•」の色が変わり太字になります(記号自体を別の文字に変えることはできません。
           表示専用のウィジェットで中身の文字は固定です)。 */

        /* ---- 番号付きリスト(1. 2. 3. …)について ----
           数字自体は専用のクラスを持たず、本文の地の文としてそのまま描画されます。
           そのため数字だけを個別に色付けするセレクタはありません
           (色を変えたい場合は本文の文字色である --ink を変えることになります)。 */

        /* ---- チェックボックス(- [ ] / - [x]) ---- */
        /*
        .cm-checkbox { accent-color: var(--danger); width: 18px; height: 18px; }
        */
        /* チェックボックスの色が変わり、既定の16pxより一回り大きくなります。 */

        /* ---- チェック済み項目の文字 ---- */
        /*
        .tok-done { color: var(--accent); }
        */
        /* チェックを入れた項目の文字色が、既定の薄い色からアクセントカラーに変わります
           (打ち消し線はそのまま残ります)。 */

        /* ==============================================================
           3. 引用(> text)
           ============================================================== */
        /* 既定は左の縦線だけで背景はありません。background を足せばTypora風の
           「背景付き引用」にもできます。 */
        /*
        .tok-quote {
          border-left-width: 4px;
          border-left-color: var(--accent);
          background: var(--accent-soft);
          padding: 2px 10px;
        }
        */
        /* この行のコメントを外すと、引用の左線が太くなりアクセントカラーになった上、
           行全体に淡い背景色が付きます。なお2段以上ネストした引用(>>)の2段目以降は
           JS側が計算したbox-shadowで線を描いているため、このプロパティでは変わりません。 */

        /* ==============================================================
           4. コードブロックとインラインコード
           ============================================================== */

        /* ---- インラインコード(`code`) ---- */
        /*
        .tok-code { background: var(--accent-soft); color: var(--accent); border-radius: 3px; }
        */
        /* 地の文中の `コード` の背景色・文字色・角丸が変わります。 */

        /* ---- フェンスコードブロック(```で囲む部分)本体 ---- */
        /*
        .cm-line.cm-codeblock-line { background: var(--pre-bg); color: var(--pre-ink); }
        .cm-line.cm-cb-first { border-radius: 4px 4px 0 0; }
        .cm-line.cm-cb-last { border-radius: 0 0 4px 4px; }
        */
        /* コードブロックの背景・文字色が変わり、角丸の半径も既定の8pxから4pxになります。 */

        /* ---- コードブロック内のフォントサイズ ---- */
        /*
        .tok-codeblock { font-size: 1em; }
        */
        /* 既定は本文の0.88倍(.88em)ですが、これを外すと本文と同じ大きさになります。 */

        /* ---- コードブロックの行番号(設定 > 編集 > コードブロックの行番号 を有効にしたとき) ---- */
        /*
        .cm-code-linenum { color: var(--danger); border-right-color: var(--danger); }
        */
        /* 行番号の文字色と、コード本体との区切り線の色が変わります。 */

        /* ---- コードブロック右上のコピー用ボタン ---- */
        /*
        .cm-code-copy { border-color: var(--accent); }
        .cm-code-copy.done { color: var(--danger); }
        */
        /* ボタンの枠がアクセントカラーになり、コピー完了直後に出るチェックアイコンの
           色が既定のアクセントカラーから警告色に変わります。 */

        /* ==============================================================
           5. 表
           ============================================================== */

        /* ---- セルの罫線・余白 ---- */
        /*
        .cm-table th, .cm-table td { border-color: var(--accent); padding: 6px 12px; }
        */
        /* 罫線がアクセントカラーになり、セルの余白が広がります。 */

        /* ---- ヘッダー行の背景(既定は--panel-bg。表だけ個別に変えたいときはこちら) ---- */
        /*
        .cm-table th { background: var(--accent-soft); }
        */

        /* ---- 1行おきの背景(既定は縞模様なし) ----
           表のtbody内の行(tr)を数えてnth-childで指定します。Paneの表自体が既に持っている
           要素(table > tbody > tr > td)だけを使ったセレクタで、専用のCSS変数はありません。 */
        /*
        .cm-table tbody tr:nth-child(even) td { background: var(--panel-bg); }
        */
        /* この行のコメントを外すと、偶数行にだけ淡い背景が付き、いわゆる「ゼブラ模様」の
           表になります。 */

        /* ==============================================================
           6. Callout(GitHub式アラート: `> [!NOTE]` のような引用ブロック)
           ============================================================== */
        /* 5種類の色は上の--callout-*変数(NOTE/TIP/IMPORTANT/WARNING/CAUTION)で
           まとめて変えられますが、種類ごとに個別調整したいとき・変数化されていない
           プロパティ(枠線の太さ等)を変えたいときはセレクタで直接上書きします。 */
        /*
        .cm-callout-warning { border-left-width: 6px; border-radius: 0; }
        */
        /* この行のコメントを外すと、WARNINGだけ左線が太くなり角丸が無くなります
           (NOTE/TIP/IMPORTANT/CAUTIONの4種類は変わりません)。 */

        /* ==============================================================
           7. 水平線・脚注・目次・Front Matter
           ============================================================== */

        /* ---- 水平線(---) ---- */
        /*
        .cm-hr { border-top-color: var(--accent); border-top-width: 3px; }
        */
        /* 水平線がアクセントカラーの太い線(既定2px→3px)になります。 */

        /* ---- 脚注番号・ホバーで出るポップアップ ---- */
        /*
        .cm-footnote-num { color: var(--danger); }
        .cm-footnote-popup { background: var(--surface); color: var(--ink); border: 1px solid var(--line); }
        */
        /* 脚注番号の文字色が警告色になり、ホバー時に出るポップアップが既定の黒背景から
           カード風(--surface背景・--line枠)の見た目に変わります。 */

        /* ---- 目次([toc]) ---- */
        /*
        .cm-toc { border-color: var(--accent); }
        .cm-toc-item:hover { color: var(--danger); }
        */
        /* 目次の外枠がアクセントカラーになり、項目をホバーしたときの文字色が変わります。 */

        /* ---- Front Matter(先頭の---で囲むメタ情報) ---- */
        /*
        .cm-line.cm-frontmatter { background: var(--accent-soft); }
        */
        /* Front Matterの背景色が変わります(上の変数一覧の--frontmatter-bgを直接
           書き換えても同じ効果です。こちらはFront Matterだけを個別に変えたい場合用)。 */

        /* ==============================================================
           8. コードモードの要素(設定 > 編集 でモードを「コード」にしたときの画面)
           ============================================================== */

        /* ---- 行番号ガター(画面左端) ---- */
        /*
        #cm-host .cm-gutters { background: var(--accent-soft); border-right-color: var(--accent); }
        #cm-host .cm-lineNumbers .cm-gutterElement { color: var(--accent); }
        */
        /* ガター全体の背景・右の区切り線と、行番号自体の文字色が変わります。 */

        /* ---- 現在行のハイライトについて ----
           Paneには、カーソルのある行を背景色で強調する機能が今のところありません
           (該当するクラス・実装が存在しません)。ここに書ける実例はありません。 */

        /* ---- インデントガイド(ネストの深さを示す縦線) ----
           注意: この線はCodeMirrorのEditorView.theme()という仕組みでJS側から動的に
           スタイルが注入されており、詳細度(CSSの優先順位)がやや高めです。単に
           `.cm-guide-line { ... }` とだけ書くと反映されないことがあるため、実在する
           id(#cm-host)を頭に付けて詳細度を上げてください(下の例のとおり)。 */
        /*
        #cm-host .cm-guide-line { background-color: var(--accent); }
        */
        /* インデントガイドの縦線がアクセントカラーになります。なお折りたたみマーカーに
           マウスを乗せている間だけ縦線を強調する色は、上の変数一覧の
           --fold-guide-hover で別途調整します(ここでは変わりません)。 */

        /* ---- 折りたたみマーカー(コードの左側に出る[+]/[-]の四角いボタン) ---- */
        /*
        #cm-host .cm-fold-marker2 { background-color: var(--accent); border-color: var(--accent); }
        */
        /* マーカーの塗り・枠がアクセントカラーになります(ホバー時の色は元々--accentを
           直接参照しているため、--accent変数を変えればホバー時にも同じ色が使われます)。 */

        /* ---- 括弧の対応表示(対応する { } ( ) [ ] を強調表示する機能) ---- */
        /*
        #cm-host .cm-matchingBracket { background: var(--accent); color: var(--surface); }
        */
        /* 対応する括弧の背景が、アクセントカラーの塗りつぶしに変わります。 */

        /* ---- 検索のヒット表示(Ctrl+F の検索・置換パネルで見つかった箇所) ----
           これはPane独自のクラスではなく、エディタ本体(CodeMirror/@codemirror/search)が
           標準で使うクラス名(.cm-searchMatch / .cm-searchMatch-selected)です。 */
        /*
        #cm-host .cm-searchMatch { background: var(--accent-soft); }
        #cm-host .cm-searchMatch-selected { background: var(--accent); color: var(--surface); }
        */
        /* 検索でヒットした箇所の背景色が変わり、∧∨ボタンで選んでいる現在のヒットは
           アクセントカラーの塗りつぶしになります。 */

        /* ==============================================================
           9. アプリのUI
           ============================================================== */

        /* ---- メニューバー(Altキーで表示/非表示) ---- */
        /*
        #menubar { background: var(--accent-soft); border-bottom-width: 2px; }
        .menu-item { border-radius: 2px; }
        */
        /* メニューバーの背景色が変わり下端の区切り線が太くなります。開いたメニューの
           項目の角丸も、既定の6pxから2pxに小さくなります。 */

        /* ---- タイトルバーについて ----
           ウィンドウのタイトルバーはOSネイティブの部品で、Pane独自のDOM要素・CSS
           クラスを持ちません(このファイルにセレクタで書ける対象がありません)。
           色を変えたい場合は、上の変数一覧の --titlebar-bg / --titlebar-fg を
           書き換えてください(このファイル冒頭の:rootブロックを参照)。 */

        /* ---- サイドバー(ファイルツリー・アウトライン共通の土台) ---- */
        /*
        #sidebar { border-right-width: 2px; border-right-color: var(--accent); }
        */
        /* サイドバーとエディタの境界線が太く、アクセントカラーになります。 */

        /* ---- ファイルツリーの項目 ---- */
        /*
        .tree-item.current { font-weight: 700; }
        */
        /* 現在開いているファイルの行が太字になります。 */

        /* ---- アウトラインの項目(見出しへのジャンプ一覧) ---- */
        /*
        .outline-item:hover { color: var(--danger); }
        */
        /* アウトライン項目をホバーしたときの文字色が変わります。 */

        /* ---- タブバー(隠し設定 displayMode:"tab" を有効にしたときだけ表示) ---- */
        /*
        #tabbar { border-bottom-color: var(--accent); }
        .tab-item.active { box-shadow: inset 0 -3px 0 var(--danger); }
        */
        /* タブバー下端の線がアクセントカラーになり、選択中タブの下線が既定の
           アクセントカラー・2px幅から、警告色・3px幅に変わります。 */

        /* ---- ステータスバー(画面下端の文字数・保存状態など) ----
           id="statusbar" の見た目は src/style.css ではなく src/index.html 内の
           <style>で定義されていますが、実在するセレクタです。 */
        /*
        #statusbar { background: var(--accent-soft); border-top-color: var(--accent); }
        */
        /* ステータスバーの背景色と、本文との境界線(上端)の色が変わります。 */

        /* ---- 検索・置換パネル(Ctrl+F、エディタ右上に浮くパネル) ---- */
        /*
        .search-panel { border-color: var(--accent); }
        .search-row input[type="text"] { border-color: var(--accent); }
        */
        /* パネルの外枠と、検索・置換の入力欄の枠がアクセントカラーになります。 */

        /* ---- 設定画面 ---- */
        /*
        .settings-modal { border-radius: 6px; }
        .settings-nav-item.active { border-radius: 4px; }
        */
        /* 設定画面全体の角丸が既定の14pxより小さくなり、選択中のカテゴリの角丸も
           小さくなります。 */

        /* ---- 右クリックのコンテキストメニュー ---- */
        /*
        .ctx-menu { border-color: var(--accent); border-radius: 4px; }
        */
        /* 右クリックメニューの枠がアクセントカラーになり、角丸が既定の10pxより
           小さくなります。 */

        /* ---- 確認・入力ダイアログ(削除確認・名前入力などpaneConfirm/paneAlert/paneInput) ---- */
        /*
        .pane-dialog-box { border-color: var(--accent); }
        .pane-dialog-title { color: var(--accent); }
        */
        /* ダイアログの外枠と、タイトルの文字色がアクセントカラーになります。 */

        /* ==============================================================
           10. 注意: 上書きすると表示が壊れる可能性がある指定
           ==============================================================
           display / position / overflow / z-index など、レイアウトの土台になっている
           プロパティは変更しないでください。「壊れる」とは具体的にどういうことか、
           実際に起きる不具合を挙げます(以下はコメントのまま試さないでください)。

           ・悪い例1(サイドバーのリサイズハンドルが迷子になる):
             #sidebar は position: relative が指定されていて、右端のドラッグ用ハンドル
             (.sidebar-resize-handle、position: absolute)はこの#sidebarを基準にして
             右端へ配置されています。#sidebarのpositionをstaticに変えると、ハンドルは
             代わりにウィンドウ全体を基準にした位置(画面の隅など)へ飛んでしまい、
             ドラッグでのサイドバー幅変更が使えなくなります。
               #sidebar { position: static; }  ← このような指定はしないでください

           ・悪い例2(3カラムのレイアウトが崩れる):
             .layout は display: grid でサイドバー・リサイズハンドル・エディタの3列を
             横に並べています。displayをblockのような別の値に変えると、この3つの要素が
             横に並ばず縦に積み重なった、意図しない表示になります。
               .layout { display: block; }  ← このような指定はしないでください

           ・悪い例3(エディタのスクロールが壊れる):
             #cm-host は overflow: hidden で、実際のスクロールは内部の.cm-scrollerが
             担当しています。#cm-hostのoverflowをvisibleのような別の値に変えると、
             文書全体が画面の外まではみ出して描画されようとし、ウィンドウのレイアウト
             自体が崩れます(印刷・PDF書き出し時だけ意図的にこれを行う仕組み
             (body.export-layout)がPane側に別途ありますが、通常の編集画面でこれをやると
             壊れます)。
               #cm-host { overflow: visible; }  ← このような指定はしないでください

           ・悪い例4(ダイアログやメニューの重なり順が崩れる):
             Paneはメニュー(.menu-dropdown: z-index 70)・設定画面
             (.settings-modal-overlay: 80)・確認ダイアログ(.pane-dialog-overlay: 95)の
             ように、後から開く画面ほどz-indexを大きくして正しく手前に出るように
             しています。特定のクラスのz-indexだけを大きく(または小さく)書き換えると、
             本来手前にあるべきダイアログがメニューの下に隠れてクリックできなくなる、
             といった不具合が起こります。

           ・#cm-host 等の編集領域に width / height を直接指定するのも避けてください。
             ウィンドウサイズの変更に追従できなくなります。
           ・!important を多用すると、Pane本体側の折り返し・選択範囲などの表示制御と
             衝突することがあります。色・書体・余白など見た目のプロパティに留めるのが
             安全です。
           ============================================================== */

        /* ==============================================================
           11. 元に戻す方法
           ==============================================================
           ・いちばん簡単な方法: 設定 > 外観 > カスタムCSS の指定を外す(空にする)。
             これだけでPaneは既定の見た目に戻ります。sample.css自体は削除しなくて
             構いません(単に読み込まれなくなるだけです)。
           ・sample.cssファイルそのものを削除する方法もあります。Paneは起動のたびに
             このファイルの有無を確認し、無ければ既定値だけのsample.cssを同じ場所へ
             自動的に書き直します(ThemeFolderService.EnsureSampleCss。あなたが今読んで
             いるこの内容と同じものが再び書き出されます)。再生成される内容はPaneの
             既定値そのものなので、見た目への影響はありません。
           ・一部の項目だけ元に戻したい場合は、その行を削除するか、この節の他の例と
             同じようにCSSコメントとして無効化してください。書かなかった項目は
             自動的に既定(またはプリセットテーマ)の値に戻ります。
           ============================================================== */
        """;
}
