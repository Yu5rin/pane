using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using static Pane.JsonMessageHelpers;

namespace Pane;

/// <summary>
/// HTML製の設定画面(<c>src/settings.js</c>)とのブリッジメッセージのうち、
/// 本体ウィンドウ(<see cref="MainForm"/>)と設定専用ウィンドウ(<see cref="SettingsWindow"/>)の
/// 両方から同じ内容で応答すべきものをここへ集約する(重複実装の防止)。
/// 扱うメッセージ: get-settings / save-settings / browse-path / open-settings-file /
/// reset-settings / clear-recent-files / clear-per-file-modes / open-default-apps-settings。
///
/// 呼び出し元固有の事情(ダイアログの親ウィンドウ、応答の送り先、保存後に他ウィンドウへ
/// 再配信する手段)は呼び出し元から delegate として受け取る。設定はアプリ全体で共有されるため、
/// 保存・消去・リセット系はすべて末尾で broadcastSettingsChanged を呼び、開いている
/// すべての本体ウィンドウへ反映させる。
/// </summary>
internal static class SettingsBridge
{
    /// <summary>
    /// { type: "get-settings" } への応答。設定画面(HTML製)が全項目を読み込むための経路。
    /// apply-settingsが「JS側の描画に必要な項目」だけを送るのに対し、こちらは
    /// docs/設定項目一覧.md に載っている全項目を1つのオブジェクトにまとめて返す。
    /// あわせて installedFonts / monospaceFonts / pandocAvailable / settingsFilePath を含める
    /// (「送受信の約束」)。
    /// </summary>
    public static void PostSettingsSnapshot(Action<object> postToWeb)
    {
        AppSettings settings = SettingsService.Load();
        postToWeb(new
        {
            type = "settings",

            // ---- 一般 ----
            startupBehavior = settings.StartupBehavior,
            startupFolderPath = settings.StartupFolderPath,
            quitOnLastWindowClosed = settings.QuitOnLastWindowClosed,
            preloadOnStartup = settings.PreloadOnStartup,
            showStatusBar = settings.ShowStatusBar,
            showOutlineByDefault = settings.ShowOutlineByDefault,
            collapsibleOutline = settings.CollapsibleOutline,
            sidebarWidthPx = settings.SidebarWidthPx,
            recordRecentFiles = settings.RecordRecentFiles,
            zoomWithCtrlWheel = settings.ZoomWithCtrlWheel,
            displayMode = settings.DisplayMode,

            // ---- 保存と復元 ----
            autoSaveEnabled = settings.AutoSaveEnabled,
            autoSaveIntervalSeconds = settings.AutoSaveIntervalSeconds,
            recoverUnsavedDrafts = settings.RecoverUnsavedDrafts,
            saveWithoutAskingOnSwitch = settings.SaveWithoutAskingOnSwitch,
            defaultEncoding = settings.DefaultEncoding,
            defaultLineEnding = settings.DefaultLineEnding,
            defaultFileExtension = settings.DefaultFileExtension,

            // ---- 編集 ----
            indentSizeOnSave = settings.IndentSizeOnSave,
            codeIndentSize = settings.CodeIndentSize,
            codeAutoWrap = settings.CodeAutoWrap,
            shiftTabAutoIndent = settings.ShiftTabAutoIndent,
            autoPairing = settings.AutoPairing,
            autoPairMarkdown = settings.AutoPairMarkdown,
            emojiAutocomplete = settings.EmojiAutocomplete,
            liveRenderingShowSourceOnFocus = settings.LiveRenderingShowSourceOnFocus,
            defaultCopyFormat = settings.DefaultCopyFormat,
            copyWholeLineWhenNoSelection = settings.CopyWholeLineWhenNoSelection,
            typewriterKeepCaretCentered = settings.TypewriterKeepCaretCentered,
            spellCheckEnabled = settings.SpellCheckEnabled,
            spellCheckAutoCorrect = settings.SpellCheckAutoCorrect,
            colorPreviewInCode = settings.ColorPreviewInCode,
            readingSpeedWpm = settings.ReadingSpeedWpm,
            autoDetectMode = settings.AutoDetectMode,
            fileModeOverrides = settings.FileModeOverrides,
            perFileModes = settings.PerFileModes,

            // ---- Markdown: 記法サポート ----
            inlineMathEnabled = settings.InlineMathEnabled,
            codeBlockMathEnabled = settings.CodeBlockMathEnabled,
            superSubscriptEnabled = settings.SuperSubscriptEnabled,
            highlightEnabled = settings.HighlightEnabled,
            diagramsEnabled = settings.DiagramsEnabled,
            autoLinksEnabled = settings.AutoLinksEnabled,
            calloutsEnabled = settings.CalloutsEnabled,

            // ---- Markdown: 記法の書き方 ----
            strictMode = settings.StrictMode,
            headingStyle = settings.HeadingStyle,
            unorderedListMarker = settings.UnorderedListMarker,
            orderedListMarker = settings.OrderedListMarker,
            codeBlockLineNumbers = settings.CodeBlockLineNumbers,
            mathAutoNumber = settings.GetEffectiveMathAutoNumber(),
            chapterLevelInOutline = settings.ChapterLevelInOutline,
            defaultCodeLanguage = settings.DefaultCodeLanguage,
            defaultCodeLanguageApplyWhen = settings.DefaultCodeLanguageApplyWhen,

            // ---- Markdown: 空白と改行 ----
            whitespaceWhenWriting = settings.WhitespaceWhenWriting,
            whitespaceOnExport = settings.WhitespaceOnExport,

            // ---- Markdown: スマート置換 ----
            smartQuotes = settings.SmartQuotes,
            smartDashes = settings.SmartDashes,
            recognizeUnicodePunctuation = settings.RecognizeUnicodePunctuation,

            // ---- 画像 ----
            imageInsertAction = settings.ImageInsertAction,
            imageCustomFolder = settings.ImageCustomFolder,
            imageApplyToLocal = settings.ImageApplyToLocal,
            imageApplyToOnline = settings.ImageApplyToOnline,
            imagePreferRelativePath = settings.ImagePreferRelativePath,
            imageAddDotSlash = settings.ImageAddDotSlash,
            imageAutoEscapeUrl = settings.ImageAutoEscapeUrl,

            // ---- エクスポート・印刷 ----
            exportPaperSize = settings.ExportPaperSize,
            exportCustomWidthMm = settings.ExportCustomWidthMm,
            exportCustomHeightMm = settings.ExportCustomHeightMm,
            exportOrientation = settings.ExportOrientation,
            exportMarginTopMm = settings.ExportMarginTopMm,
            exportMarginBottomMm = settings.ExportMarginBottomMm,
            exportMarginLeftMm = settings.ExportMarginLeftMm,
            exportMarginRightMm = settings.ExportMarginRightMm,
            exportHeaderText = settings.ExportHeaderText,
            exportFooterText = settings.ExportFooterText,
            exportPageBreakBetweenTopHeadings = settings.ExportPageBreakBetweenTopHeadings,
            exportIncludeOutline = settings.ExportIncludeOutline,
            exportOutlineWidthPx = settings.ExportOutlineWidthPx,
            exportAppendHead = settings.ExportAppendHead,
            exportAppendBody = settings.ExportAppendBody,
            exportDefaultFolder = settings.ExportDefaultFolder,
            exportCustomFolder = settings.ExportCustomFolder,
            exportAfter = settings.ExportAfter,
            exportShowSaveDialog = settings.ExportShowSaveDialog,
            exportMathAs = settings.ExportMathAs,
            exportReadYamlFrontMatter = settings.ExportReadYamlFrontMatter,

            // ---- 外観 ----
            theme = settings.Theme,
            lightTheme = settings.LightTheme,
            darkTheme = settings.DarkTheme,
            useSeparateThemeInDarkMode = settings.UseSeparateThemeInDarkMode,
            customCssPath = settings.CustomCssPath,
            editorFontFamily = settings.EditorFontFamily,
            editorMonospaceFontFamily = settings.EditorMonospaceFontFamily,
            editorFontSize = settings.EditorFontSize,
            editorLineHeight = settings.EditorLineHeight,
            editorMaxWidthPx = settings.EditorMaxWidthPx,
            editorPaddingX = settings.EditorPaddingX,
            showWordCount = settings.ShowWordCount,

            // ---- ファイルの関連付け ----
            associatedExtensions = settings.AssociatedExtensions,
            fileAssociationEnabled = settings.FileAssociationEnabled,
            explorerNewMenuEnabled = settings.ExplorerNewMenuEnabled,

            // ---- キーボード ----
            keyBindings = settings.KeyBindings,

            // ---- 詳細 ----
            enableDebug = settings.EnableDebug,
            showHiddenFilesInTree = settings.ShowHiddenFilesInTree,
            fileTreePatterns = settings.FileTreePatterns,
            addToPath = settings.AddToPath,

            // ---- 送受信の約束: settingsにのみ含める一覧系・環境情報 ----
            installedFonts = FontService.AllFamilies,
            monospaceFonts = FontService.MonospaceFamilies,
            pandocAvailable = DetectPandocAvailable(),
            settingsFilePath = SettingsService.SettingsFilePath,

            // ---- 設定画面「バージョン情報」カテゴリ用の環境情報 ----
            appVersion = DetectAppVersion(),
            webView2Version = DetectWebView2Version(),
            dotNetVersion = Environment.Version.ToString(),
            logFolderPath = Path.GetDirectoryName(Logger.FilePath) ?? "",
            themeFolderPath = ThemeFolderService.FolderPath,
            licenses = Licenses,
        });
    }

    /// <summary>
    /// 「バージョン情報」カテゴリのライセンス一覧(Pane本体 + 主要な同梱OSS)。
    /// 各OSSのライセンス種別は node_modules/&lt;パッケージ&gt;/package.json の license
    /// フィールドを実際に確認して転記したもの(推測で書かない)。配布物には含まれない
    /// devDependencies(esbuild等、ビルド時のみ使用)はここに含めない。
    /// </summary>
    private static readonly object[] Licenses =
    {
        new { name = "Pane 本体", license = "プロプライエタリ(未公開。package.jsonのlicenseは\"UNLICENSED\")" },
        new { name = "CodeMirror 6 (@codemirror/*)", license = "MIT License" },
        new { name = "Lezer (@lezer/*)", license = "MIT License" },
        new { name = "MathJax (mathjax-full)", license = "Apache License 2.0" },
        new { name = "Mermaid", license = "MIT License" },
    };

    /// <summary>
    /// 設定の「バージョン情報」に表示するバージョンを "x.y.z" 形式で返す。取得できなければ「不明」。
    ///
    /// AssemblyName.Versionは.NETの仕様上どうしても4桁(Major.Minor.Build.Revision)になり、
    /// そのままToString()すると "1.0.0.0" と出てしまう。利用者に見せる表記は3桁が一般的なため、
    /// csprojの&lt;Version&gt;から作られるInformationalVersion("1.0.0")を優先して使う。
    /// </summary>
    private static string DetectAppVersion()
    {
        string? informational = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            // ビルド環境によっては "1.0.0+<コミットハッシュ>" の形になるため、"+"以降は落とす。
            int plus = informational.IndexOf('+');
            return plus >= 0 ? informational[..plus] : informational;
        }
        // InformationalVersionが取れない場合は4桁から先頭3つだけを使う。
        Version? v = Assembly.GetExecutingAssembly().GetName().Version;
        return v is null ? "不明" : v.ToString(3);
    }

    /// <summary>WebView2ランタイムのバージョン。未導入等で取得できない場合は「不明」。</summary>
    private static string DetectWebView2Version()
    {
        try
        {
            return CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (Exception ex)
        {
            Logger.WriteException("WebView2バージョンの取得に失敗", ex);
            return "不明";
        }
    }

    /// <summary>
    /// { type: "save-settings", settings: {...} } を受け取り、含まれている項目だけを
    /// AppSettingsへ反映して保存する。JS側の設定画面は段階的に実装される想定のため、
    /// 一部項目しか送られてこなくても他の項目を壊さないよう「含まれていれば上書き」とする。
    /// 知らないキーは無視し、不正な値(列挙値・数値範囲)はAppSettings側のsetterが既定値へ倒す。
    /// 保存後、ファイル関連付け・スタートアップ登録・エクスプローラー新規作成メニューの差分適用と、
    /// broadcastSettingsChanged(全ウィンドウへの再配信)を行う。
    /// </summary>
    public static void HandleSaveSettingsRequest(JsonElement root, Action<object> postToWeb, Action broadcastSettingsChanged)
    {
        if (!root.TryGetProperty("settings", out JsonElement s) || s.ValueKind != JsonValueKind.Object)
        {
            Logger.Write("save-settings受信: settingsプロパティが無いため無視");
            return;
        }

        // 例外はここで握りつぶさずログへ残し、JS側へも結果を通知する(呼び出し元がエラー表示できるように)。
        string? errorMessage = null;

        // Windowsの「既定のアプリ」(UserChoice)で他アプリが選ばれている拡張子。設定画面へ案内する。
        IReadOnlyList<string> blockedExtensions = Array.Empty<string>();

        // Lost Update対策(SettingsService.Update参照)。previousExtensions等の「変更前の値」は
        // ここで読み直す最新の設定(settings、Update内でLoad()される)から取るため、
        // このメソッドが呼ばれてから実際に書き込むまでの間に他所で設定が変わっていても、
        // その変更を正しく前提にできる(呼び出し開始時点の古いスナップショットは使わない)。
        SettingsService.Update(settings =>
        {
            IReadOnlyCollection<string> previousExtensions = settings.GetEffectiveAssociatedExtensions();
            bool previousPreload = settings.PreloadOnStartup;
            bool previousExplorerNewMenuEnabled = settings.ExplorerNewMenuEnabled;
            bool previousAddToPath = settings.AddToPath;

            // ---- 一般 ----
            if (TryGetString(s, "startupBehavior", out string startupBehavior)) settings.StartupBehavior = startupBehavior;
            if (s.TryGetProperty("startupFolderPath", out JsonElement startupFolderProp))
            {
                settings.StartupFolderPath = startupFolderProp.ValueKind == JsonValueKind.String ? startupFolderProp.GetString() : null;
            }
            if (TryGetBool(s, "quitOnLastWindowClosed", out bool quitOnLastWindowClosed)) settings.QuitOnLastWindowClosed = quitOnLastWindowClosed;
            if (TryGetBool(s, "preloadOnStartup", out bool preloadOnStartup)) settings.PreloadOnStartup = preloadOnStartup;
            if (TryGetBool(s, "showStatusBar", out bool showStatusBar)) settings.ShowStatusBar = showStatusBar;
            if (TryGetBool(s, "showOutlineByDefault", out bool showOutlineByDefault)) settings.ShowOutlineByDefault = showOutlineByDefault;
            if (TryGetBool(s, "collapsibleOutline", out bool collapsibleOutline)) settings.CollapsibleOutline = collapsibleOutline;
            // sidebarWidthPxは設定画面のUIから送られてくることは無いが、displayModeと同じ理由
            // (設定ファイルを直接編集された場合でもdraftが保持・保存できるように)で受け口は残す。
            // 実際の永続化は主に"set-sidebar-width"専用メッセージ(MainForm.cs)経由で行われる。
            if (TryGetInt(s, "sidebarWidthPx", out int sidebarWidthPx)) settings.SidebarWidthPx = sidebarWidthPx;
            if (TryGetBool(s, "recordRecentFiles", out bool recordRecentFiles)) settings.RecordRecentFiles = recordRecentFiles;
            if (TryGetBool(s, "zoomWithCtrlWheel", out bool zoomWithCtrlWheel)) settings.ZoomWithCtrlWheel = zoomWithCtrlWheel;
            if (TryGetString(s, "displayMode", out string displayMode)) settings.DisplayMode = displayMode;

            // ---- 保存と復元 ----
            if (TryGetBool(s, "autoSaveEnabled", out bool autoSaveEnabled)) settings.AutoSaveEnabled = autoSaveEnabled;
            if (TryGetInt(s, "autoSaveIntervalSeconds", out int autoSaveIntervalSeconds)) settings.AutoSaveIntervalSeconds = autoSaveIntervalSeconds;
            if (TryGetBool(s, "recoverUnsavedDrafts", out bool recoverUnsavedDrafts)) settings.RecoverUnsavedDrafts = recoverUnsavedDrafts;
            if (TryGetBool(s, "saveWithoutAskingOnSwitch", out bool saveWithoutAskingOnSwitch)) settings.SaveWithoutAskingOnSwitch = saveWithoutAskingOnSwitch;
            if (TryGetString(s, "defaultEncoding", out string defaultEncoding)) settings.DefaultEncoding = defaultEncoding;
            if (TryGetString(s, "defaultLineEnding", out string defaultLineEnding)) settings.DefaultLineEnding = defaultLineEnding;
            if (TryGetString(s, "defaultFileExtension", out string defaultFileExtension)) settings.DefaultFileExtension = defaultFileExtension;

            // ---- 編集 ----
            if (TryGetInt(s, "indentSizeOnSave", out int indentSizeOnSave)) settings.IndentSizeOnSave = indentSizeOnSave;
            if (TryGetInt(s, "codeIndentSize", out int codeIndentSize)) settings.CodeIndentSize = codeIndentSize;
            if (TryGetBool(s, "codeAutoWrap", out bool codeAutoWrap)) settings.CodeAutoWrap = codeAutoWrap;
            if (TryGetBool(s, "shiftTabAutoIndent", out bool shiftTabAutoIndent)) settings.ShiftTabAutoIndent = shiftTabAutoIndent;
            if (TryGetBool(s, "autoPairing", out bool autoPairing)) settings.AutoPairing = autoPairing;
            if (TryGetBool(s, "autoPairMarkdown", out bool autoPairMarkdown)) settings.AutoPairMarkdown = autoPairMarkdown;
            if (TryGetString(s, "emojiAutocomplete", out string emojiAutocomplete)) settings.EmojiAutocomplete = emojiAutocomplete;
            if (TryGetBool(s, "liveRenderingShowSourceOnFocus", out bool liveRenderingShowSourceOnFocus)) settings.LiveRenderingShowSourceOnFocus = liveRenderingShowSourceOnFocus;
            if (TryGetString(s, "defaultCopyFormat", out string defaultCopyFormat)) settings.DefaultCopyFormat = defaultCopyFormat;
            if (TryGetBool(s, "copyWholeLineWhenNoSelection", out bool copyWholeLineWhenNoSelection)) settings.CopyWholeLineWhenNoSelection = copyWholeLineWhenNoSelection;
            if (TryGetBool(s, "typewriterKeepCaretCentered", out bool typewriterKeepCaretCentered)) settings.TypewriterKeepCaretCentered = typewriterKeepCaretCentered;
            if (TryGetBool(s, "spellCheckEnabled", out bool spellCheckEnabled)) settings.SpellCheckEnabled = spellCheckEnabled;
            if (TryGetBool(s, "spellCheckAutoCorrect", out bool spellCheckAutoCorrect)) settings.SpellCheckAutoCorrect = spellCheckAutoCorrect;
            if (TryGetBool(s, "colorPreviewInCode", out bool colorPreviewInCode)) settings.ColorPreviewInCode = colorPreviewInCode;
            if (TryGetInt(s, "readingSpeedWpm", out int readingSpeedWpm)) settings.ReadingSpeedWpm = readingSpeedWpm;
            // AppSettingsの各setterが不正値を既定値へ正規化するため、ここでは受け取った値をそのまま代入すればよい。
            if (TryGetString(s, "autoDetectMode", out string autoDetectMode)) settings.AutoDetectMode = autoDetectMode;
            if (s.TryGetProperty("fileModeOverrides", out JsonElement fileModeOverridesProp) && fileModeOverridesProp.ValueKind == JsonValueKind.Object)
            {
                // キー(拡張子)は先頭ドットを除いて小文字へ正規化し、値が3種以外のものは捨てる。
                var overrides = new Dictionary<string, string>();
                foreach (JsonProperty prop in fileModeOverridesProp.EnumerateObject())
                {
                    if (prop.Value.ValueKind != JsonValueKind.String) continue;
                    string mode = prop.Value.GetString() ?? "";
                    if (mode is not ("markdown" or "code" or "plain")) continue;
                    string ext = prop.Name.TrimStart('.').ToLowerInvariant();
                    if (ext.Length == 0) continue;
                    overrides[ext] = mode;
                }
                settings.FileModeOverrides = overrides;
            }
            // perFileModesは設定画面のUIには出さない(remember-file-modeメッセージ経由でのみ更新する)ため、
            // save-settingsからは受け取っても意図的に無視する(資料の「JS main.js(UIには出さない)」に対応)。

            // ---- Markdown: 記法サポート ----
            if (TryGetBool(s, "inlineMathEnabled", out bool inlineMathEnabled)) settings.InlineMathEnabled = inlineMathEnabled;
            if (TryGetBool(s, "codeBlockMathEnabled", out bool codeBlockMathEnabled)) settings.CodeBlockMathEnabled = codeBlockMathEnabled;
            if (TryGetBool(s, "superSubscriptEnabled", out bool superSub)) settings.SuperSubscriptEnabled = superSub;
            if (TryGetBool(s, "highlightEnabled", out bool highlightEnabled)) settings.HighlightEnabled = highlightEnabled;
            if (TryGetBool(s, "diagramsEnabled", out bool diagramsEnabled)) settings.DiagramsEnabled = diagramsEnabled;
            if (TryGetBool(s, "autoLinksEnabled", out bool autoLinksEnabled)) settings.AutoLinksEnabled = autoLinksEnabled;
            if (TryGetBool(s, "calloutsEnabled", out bool calloutsEnabled)) settings.CalloutsEnabled = calloutsEnabled;

            // ---- Markdown: 記法の書き方 ----
            if (TryGetBool(s, "strictMode", out bool strictMode)) settings.StrictMode = strictMode;
            if (TryGetString(s, "headingStyle", out string headingStyle)) settings.HeadingStyle = headingStyle;
            if (TryGetString(s, "unorderedListMarker", out string unorderedListMarker)) settings.UnorderedListMarker = unorderedListMarker;
            if (TryGetString(s, "orderedListMarker", out string orderedListMarker)) settings.OrderedListMarker = orderedListMarker;
            if (TryGetBool(s, "codeBlockLineNumbers", out bool codeBlockLineNumbers)) settings.CodeBlockLineNumbers = codeBlockLineNumbers;
            if (TryGetString(s, "mathAutoNumber", out string mathAutoNumber))
            {
                settings.MathAutoNumber = mathAutoNumber;
                // 旧・単一bool設定(MathAutoNumberEnabled)を新しい値と食い違わないよう同期しておく。
                settings.MathAutoNumberEnabled = settings.MathAutoNumber != "off";
            }
            if (TryGetInt(s, "chapterLevelInOutline", out int chapterLevelInOutline)) settings.ChapterLevelInOutline = chapterLevelInOutline;
            if (TryGetString(s, "defaultCodeLanguage", out string defaultCodeLanguage)) settings.DefaultCodeLanguage = defaultCodeLanguage;
            if (TryGetString(s, "defaultCodeLanguageApplyWhen", out string defaultCodeLanguageApplyWhen)) settings.DefaultCodeLanguageApplyWhen = defaultCodeLanguageApplyWhen;

            // ---- Markdown: 空白と改行 ----
            if (TryGetString(s, "whitespaceWhenWriting", out string whitespaceWhenWriting)) settings.WhitespaceWhenWriting = whitespaceWhenWriting;
            if (TryGetString(s, "whitespaceOnExport", out string whitespaceOnExport)) settings.WhitespaceOnExport = whitespaceOnExport;

            // ---- Markdown: スマート置換 ----
            if (TryGetString(s, "smartQuotes", out string smartQuotes)) settings.SmartQuotes = smartQuotes;
            if (TryGetString(s, "smartDashes", out string smartDashes)) settings.SmartDashes = smartDashes;
            if (TryGetBool(s, "recognizeUnicodePunctuation", out bool recognizeUnicodePunctuation)) settings.RecognizeUnicodePunctuation = recognizeUnicodePunctuation;

            // ---- 画像 ----
            if (TryGetString(s, "imageInsertAction", out string imageInsertAction)) settings.ImageInsertAction = imageInsertAction;
            if (TryGetString(s, "imageCustomFolder", out string imageCustomFolder)) settings.ImageCustomFolder = imageCustomFolder;
            if (TryGetBool(s, "imageApplyToLocal", out bool imageApplyToLocal)) settings.ImageApplyToLocal = imageApplyToLocal;
            if (TryGetBool(s, "imageApplyToOnline", out bool imageApplyToOnline)) settings.ImageApplyToOnline = imageApplyToOnline;
            if (TryGetBool(s, "imagePreferRelativePath", out bool imagePreferRelativePath)) settings.ImagePreferRelativePath = imagePreferRelativePath;
            if (TryGetBool(s, "imageAddDotSlash", out bool imageAddDotSlash)) settings.ImageAddDotSlash = imageAddDotSlash;
            if (TryGetBool(s, "imageAutoEscapeUrl", out bool imageAutoEscapeUrl)) settings.ImageAutoEscapeUrl = imageAutoEscapeUrl;

            // ---- エクスポート・印刷 ----
            if (TryGetString(s, "exportPaperSize", out string exportPaperSize)) settings.ExportPaperSize = exportPaperSize;
            if (TryGetInt(s, "exportCustomWidthMm", out int exportCustomWidthMm)) settings.ExportCustomWidthMm = exportCustomWidthMm;
            if (TryGetInt(s, "exportCustomHeightMm", out int exportCustomHeightMm)) settings.ExportCustomHeightMm = exportCustomHeightMm;
            if (TryGetString(s, "exportOrientation", out string exportOrientation)) settings.ExportOrientation = exportOrientation;
            if (TryGetInt(s, "exportMarginTopMm", out int exportMarginTopMm)) settings.ExportMarginTopMm = exportMarginTopMm;
            if (TryGetInt(s, "exportMarginBottomMm", out int exportMarginBottomMm)) settings.ExportMarginBottomMm = exportMarginBottomMm;
            if (TryGetInt(s, "exportMarginLeftMm", out int exportMarginLeftMm)) settings.ExportMarginLeftMm = exportMarginLeftMm;
            if (TryGetInt(s, "exportMarginRightMm", out int exportMarginRightMm)) settings.ExportMarginRightMm = exportMarginRightMm;
            if (TryGetString(s, "exportHeaderText", out string exportHeaderText)) settings.ExportHeaderText = exportHeaderText;
            if (TryGetString(s, "exportFooterText", out string exportFooterText)) settings.ExportFooterText = exportFooterText;
            if (TryGetBool(s, "exportPageBreakBetweenTopHeadings", out bool exportPageBreak)) settings.ExportPageBreakBetweenTopHeadings = exportPageBreak;
            if (TryGetBool(s, "exportIncludeOutline", out bool exportIncludeOutline)) settings.ExportIncludeOutline = exportIncludeOutline;
            if (TryGetInt(s, "exportOutlineWidthPx", out int exportOutlineWidthPx)) settings.ExportOutlineWidthPx = exportOutlineWidthPx;
            if (TryGetString(s, "exportAppendHead", out string exportAppendHead)) settings.ExportAppendHead = exportAppendHead;
            if (TryGetString(s, "exportAppendBody", out string exportAppendBody)) settings.ExportAppendBody = exportAppendBody;
            if (TryGetString(s, "exportDefaultFolder", out string exportDefaultFolder)) settings.ExportDefaultFolder = exportDefaultFolder;
            if (TryGetString(s, "exportCustomFolder", out string exportCustomFolder)) settings.ExportCustomFolder = exportCustomFolder;
            if (TryGetString(s, "exportAfter", out string exportAfter)) settings.ExportAfter = exportAfter;
            if (TryGetBool(s, "exportShowSaveDialog", out bool exportShowSaveDialog)) settings.ExportShowSaveDialog = exportShowSaveDialog;
            if (TryGetString(s, "exportMathAs", out string exportMathAs)) settings.ExportMathAs = exportMathAs;
            if (TryGetBool(s, "exportReadYamlFrontMatter", out bool exportReadYamlFrontMatter)) settings.ExportReadYamlFrontMatter = exportReadYamlFrontMatter;

            // ---- 外観 ----
            if (TryGetString(s, "theme", out string theme)) settings.Theme = theme;
            if (TryGetString(s, "lightTheme", out string lightTheme)) settings.LightTheme = lightTheme;
            if (TryGetString(s, "darkTheme", out string darkTheme)) settings.DarkTheme = darkTheme;
            if (TryGetBool(s, "useSeparateThemeInDarkMode", out bool useSeparateThemeInDarkMode)) settings.UseSeparateThemeInDarkMode = useSeparateThemeInDarkMode;
            if (s.TryGetProperty("customCssPath", out JsonElement cssProp))
            {
                settings.CustomCssPath = cssProp.ValueKind == JsonValueKind.String ? cssProp.GetString() : null;
            }
            if (s.TryGetProperty("editorFontFamily", out JsonElement fontFamilyProp))
            {
                settings.EditorFontFamily = fontFamilyProp.ValueKind == JsonValueKind.String ? fontFamilyProp.GetString() : null;
            }
            if (s.TryGetProperty("editorMonospaceFontFamily", out JsonElement monoFontFamilyProp))
            {
                settings.EditorMonospaceFontFamily = monoFontFamilyProp.ValueKind == JsonValueKind.String ? monoFontFamilyProp.GetString() : null;
            }
            if (TryGetInt(s, "editorFontSize", out int editorFontSize)) settings.EditorFontSize = editorFontSize;
            if (TryGetDouble(s, "editorLineHeight", out double editorLineHeight)) settings.EditorLineHeight = editorLineHeight;
            if (TryGetInt(s, "editorMaxWidthPx", out int editorMaxWidthPx)) settings.EditorMaxWidthPx = editorMaxWidthPx;
            if (TryGetInt(s, "editorPaddingX", out int editorPaddingX)) settings.EditorPaddingX = editorPaddingX;
            if (TryGetBool(s, "showWordCount", out bool showWordCount)) settings.ShowWordCount = showWordCount;

            // ---- キーボード ----
            if (s.TryGetProperty("keyBindings", out JsonElement keyBindingsProp) && keyBindingsProp.ValueKind == JsonValueKind.Object)
            {
                var keyBindings = new Dictionary<string, string>();
                foreach (JsonProperty prop in keyBindingsProp.EnumerateObject())
                {
                    if (prop.Value.ValueKind == JsonValueKind.String) keyBindings[prop.Name] = prop.Value.GetString() ?? "";
                }
                settings.KeyBindings = keyBindings;
            }

            // ---- 詳細 ----
            if (TryGetBool(s, "enableDebug", out bool enableDebug)) settings.EnableDebug = enableDebug;
            if (TryGetBool(s, "showHiddenFilesInTree", out bool showHiddenFilesInTree)) settings.ShowHiddenFilesInTree = showHiddenFilesInTree;
            List<string>? fileTreePatterns = TryGetStringList(s, "fileTreePatterns");
            if (fileTreePatterns is not null) settings.FileTreePatterns = fileTreePatterns;
            if (TryGetBool(s, "addToPath", out bool addToPath)) settings.AddToPath = addToPath;

            // ---- ファイルの関連付け ----
            List<string>? desiredExtensions = TryGetStringList(s, "associatedExtensions");
            bool? desiredExplorerNewMenuEnabled = TryGetBool(s, "explorerNewMenuEnabled", out bool explorerNewMenuEnabled)
                ? explorerNewMenuEnabled
                : null;

            if (desiredExtensions is not null)
            {
                try
                {
                    FileAssociationService.Apply(desiredExtensions, previousExtensions);
                    settings.AssociatedExtensions = desiredExtensions;
                    settings.FileAssociationEnabled = desiredExtensions.Count > 0;
                    blockedExtensions = FileAssociationService.FindExtensionsBlockedByUserChoice(desiredExtensions);
                }
                catch (Exception ex)
                {
                    errorMessage = $"ファイルの関連付け設定を変更できませんでした。{ex.Message}";
                }
            }

            if (desiredExplorerNewMenuEnabled is bool wantsExplorerNewMenu)
            {
                settings.ExplorerNewMenuEnabled = wantsExplorerNewMenu;
            }
            if (settings.ExplorerNewMenuEnabled != previousExplorerNewMenuEnabled)
            {
                try
                {
                    ShellNewService.Apply(settings.ExplorerNewMenuEnabled);
                }
                catch (Exception ex)
                {
                    // ShellNewService側で既にLogger.WriteException済み。
                    errorMessage = errorMessage is null
                        ? $"エクスプローラーの「新規作成」メニューを変更できませんでした。{ex.Message}"
                        : $"{errorMessage}\nエクスプローラーの「新規作成」メニューを変更できませんでした。{ex.Message}";
                }
            }

            if (previousPreload != settings.PreloadOnStartup)
            {
                try
                {
                    if (settings.PreloadOnStartup) StartupService.Register();
                    else StartupService.Unregister();
                }
                catch (Exception ex)
                {
                    // StartupService側で既にLogger.WriteException済み。
                    errorMessage = errorMessage is null
                        ? $"スタートアップ登録を変更できませんでした。{ex.Message}"
                        : $"{errorMessage}\nスタートアップ登録を変更できませんでした。{ex.Message}";
                }
            }

            if (previousAddToPath != settings.AddToPath)
            {
                try
                {
                    if (settings.AddToPath) PathEnvironmentService.Register();
                    else PathEnvironmentService.Unregister();
                }
                catch (Exception ex)
                {
                    // PathEnvironmentService側で既にLogger.WriteException済み。
                    errorMessage = errorMessage is null
                        ? $"PATHへの登録を変更できませんでした。{ex.Message}"
                        : $"{errorMessage}\nPATHへの登録を変更できませんでした。{ex.Message}";
                }
            }

        }); // SettingsService.Update終わり(この時点でLoad→上の変更適用→アトミック保存まで完了している)

        postToWeb(new
        {
            type = "save-settings-result",
            ok = errorMessage is null,
            error = errorMessage,
            blockedExtensions,
        });

        // 設定はアプリ全体で共有されるため、自分のウィンドウだけでなく他のウィンドウにも反映する。
        broadcastSettingsChanged();
    }

    /// <summary>{ type: "clear-recent-files" } を受け取り、最近使ったファイルの履歴を消去する。</summary>
    public static void HandleClearRecentFilesRequest(Action broadcastSettingsChanged)
    {
        // Lost Update対策(SettingsService.Update参照)。
        SettingsService.Update(settings => settings.RecentFiles.Clear());
        Logger.Write("clear-recent-files: 最近使ったファイルの履歴を消去した");
        broadcastSettingsChanged();
    }

    /// <summary>{ type: "clear-per-file-modes" } を受け取り、ファイル単位の編集モード記憶を消去する。</summary>
    public static void HandleClearPerFileModesRequest(Action broadcastSettingsChanged)
    {
        // Lost Update対策(SettingsService.Update参照)。
        SettingsService.Update(settings => settings.PerFileModes = new Dictionary<string, string>());
        Logger.Write("clear-per-file-modes: ファイル単位の編集モード記憶を消去した");
        broadcastSettingsChanged();
    }

    /// <summary>{ type: "open-settings-file" } を受け取り、設定ファイルをエクスプローラーで
    /// 選択状態にして開く。</summary>
    public static void OpenSettingsFileInExplorer()
    {
        try
        {
            string path = SettingsService.SettingsFilePath;
            using var proc = Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            Logger.Write($"open-settings-file: エクスプローラーで設定ファイルを選択表示した: {path}");
        }
        catch (Exception ex)
        {
            Logger.WriteException("open-settings-file失敗", ex);
        }
    }

    /// <summary>{ type: "open-log-folder" } を受け取り、ログフォルダ(<see cref="Logger.FilePath"/>の
    /// 親フォルダ)をエクスプローラーで開く(設定画面「バージョン情報」カテゴリ)。</summary>
    public static void OpenLogFolderInExplorer()
    {
        try
        {
            string dir = Path.GetDirectoryName(Logger.FilePath) ?? "";
            if (dir.Length == 0) return;
            Directory.CreateDirectory(dir);
            using var proc = Process.Start(new ProcessStartInfo("explorer.exe", $"\"{dir}\"") { UseShellExecute = true });
            Logger.Write($"open-log-folder: エクスプローラーでログフォルダを開いた: {dir}");
        }
        catch (Exception ex)
        {
            Logger.WriteException("open-log-folder失敗", ex);
        }
    }

    /// <summary>{ type: "open-today-log" } を受け取り、今日のログファイルを既定のアプリ
    /// (通常はメモ帳)で開く(設定画面「バージョン情報」カテゴリ)。まだ何も書き込まれておらず
    /// ファイルが存在しない場合は、開けるように空ファイルを作ってから開く。</summary>
    public static void OpenTodayLogFile()
    {
        try
        {
            string path = Logger.FilePath;
            if (!File.Exists(path))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path) ?? ".");
                File.WriteAllText(path, "");
            }
            using var proc = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            Logger.Write($"open-today-log: 今日のログファイルを開いた: {path}");
        }
        catch (Exception ex)
        {
            Logger.WriteException("open-today-log失敗", ex);
        }
    }

    /// <summary>{ type: "open-theme-folder" } を受け取り、カスタムCSSの既定の置き場
    /// (<see cref="ThemeFolderService.FolderPath"/>、サンプルCSSの置き場でもある)を
    /// エクスプローラーで開く(設定画面「外観」「バージョン情報」カテゴリ)。</summary>
    public static void OpenThemeFolderInExplorer() => ThemeFolderService.OpenInExplorer();

    /// <summary>
    /// { type: "reset-settings" } を受け取り、AppSettingsを新規インスタンス(=すべて既定値)で
    /// 置き換えて保存する。ウィンドウ位置・サイズと開いていたファイルパス(OpenFilePaths)は
    /// ユーザーが今開いているものを壊さないよう保持する。保存後、全ウィンドウへ再配信し、
    /// この要求元には設定画面用のsettingsスナップショットも改めて送る。
    /// </summary>
    public static void HandleResetSettingsRequest(Action<object> postToWeb, Action broadcastSettingsChanged)
    {
        // Lost Update対策(SettingsService.Update参照)。Update内で読み直した最新(current)を
        // 起点に「ウィンドウ位置・サイズ・OpenFilePathsだけ保持した既定値」を作り、
        // currentへ丸ごと上書きコピーする。Update.modifyはAction<AppSettings>(参照を差し替えられない)
        // のため、newしたfreshをそのままSaveに渡すことはできない。SettingsService.CopyAllProperties
        // (リフレクションで全プロパティをコピー)を使うことで、AppSettingsに項目が増えても
        // ここを直し忘れる心配がない。
        SettingsService.Update(current =>
        {
            var fresh = new AppSettings
            {
                WindowX = current.WindowX,
                WindowY = current.WindowY,
                WindowWidth = current.WindowWidth,
                WindowHeight = current.WindowHeight,
                OpenFilePaths = current.OpenFilePaths,
            };
            SettingsService.CopyAllProperties(fresh, current);
        });
        Logger.Write("reset-settings: 設定を既定値へ戻した(ウィンドウ位置・サイズとOpenFilePathsは保持)");

        broadcastSettingsChanged();
        PostSettingsSnapshot(postToWeb);
    }

    /// <summary>
    /// Windowsの「既定のアプリ」設定画面を開く(設定画面の「ファイルの関連付け」カテゴリの補助)。
    /// UserChoiceで他アプリが既定になっている拡張子は、アプリ側からは変更できず
    /// ユーザーがここで手動選択するしかないため、設定画面から誘導できるようにする。
    /// </summary>
    public static void OpenDefaultAppsSettings() => DefaultAppsHelper.OpenDefaultAppsSettings();

    /// <summary>
    /// { type: "open-with-dialog", extension } を受けて、その拡張子について
    /// Windows標準の「このファイルを開く方法を選んでください」ダイアログを出す。
    /// ユーザーがPaneを選べばその拡張子の既定になる。
    /// アプリ側からUserChoiceを直接書き換えることはWindowsが禁止しているため、
    /// 既定のアプリを実際に変えられる正規の経路はこれになる(DefaultAppsHelper参照)。
    /// </summary>
    public static void HandleOpenWithDialog(JsonElement root, Form owner)
    {
        if (!root.TryGetProperty("extension", out JsonElement extProp) || extProp.ValueKind != JsonValueKind.String)
        {
            Logger.Write("open-with-dialog受信: extensionが無いため無視");
            return;
        }
        string ext = extProp.GetString() ?? "";
        if (ext.Length == 0) return;
        DefaultAppsHelper.OpenWithDialog(owner.IsHandleCreated ? owner.Handle : IntPtr.Zero, ext);
    }

    /// <summary>
    /// { type: "browse-path", field, kind } を受け取り、kind("folder"|"file")に応じた
    /// ダイアログを owner を親に表示する。選ばれた場合のみ { type: "browse-path-result", field, path }
    /// を返す(キャンセル時は何も返さない。settings.js側はbrowse-path-resultが来ないだけで
    /// 何も崩れない作りになっている)。
    /// </summary>
    public static void HandleBrowsePathRequest(JsonElement root, Form owner, Action<object> postToWeb)
    {
        // field/kindの型が違っていても(想定外の入力)例外を投げず既定値""へ倒す(JsonMessageHelpers参照)。
        TryGetString(root, "field", out string field);
        TryGetString(root, "kind", out string kind);
        if (field.Length == 0)
        {
            Logger.Write("browse-path受信: fieldが無いため無視");
            return;
        }

        string? selectedPath = null;
        if (kind == "folder")
        {
            using var dialog = new FolderBrowserDialog();
            if (dialog.ShowDialog(owner) == DialogResult.OK) selectedPath = dialog.SelectedPath;
        }
        else
        {
            // 現状"file"種別はカスタムCSS(customCssPath)のみ。フィールドに応じてフィルタを絞る。
            string filter = field == "customCssPath"
                ? "CSSファイル (*.css)|*.css|すべてのファイル (*.*)|*.*"
                : "すべてのファイル (*.*)|*.*";
            using var dialog = new OpenFileDialog { Filter = filter };
            // カスタムCSSは「何もない状態から書くのは無理」なため、参考にできるサンプルCSSを
            // 置いてある既定フォルダ(ThemeFolderService.FolderPath)を初期位置にする。
            // 存在しなくてもOpenFileDialog側が無視してユーザーフォルダ等へフォールバックするだけなので、
            // ここで事前にフォルダの存在確認・作成はしない。
            if (field == "customCssPath") dialog.InitialDirectory = ThemeFolderService.FolderPath;
            if (dialog.ShowDialog(owner) == DialogResult.OK) selectedPath = dialog.FileName;
        }

        if (selectedPath is null)
        {
            Logger.Write($"browse-path: キャンセルされた (field={field}, kind={kind})");
            return;
        }
        postToWeb(new { type = "browse-path-result", field, path = selectedPath });
    }

    // ---- save-settings用のJSON読み取りヘルパーは Pane/JsonMessageHelpers.cs へ移した ----
    // (MainForm.cs側のOnWebMessageReceivedでも同種のValueKind未確認の不具合があったため、
    // 両方から使える共有ヘルパーへ切り出した。呼び出し方はusing staticにより従来と同じ)。

    private static bool? _pandocAvailableCache;

    /// <summary>Pandocの導入有無を検出する(Word/EPUBエクスポートに必要)。プロセス起動1回のみでキャッシュする。</summary>
    public static bool DetectPandocAvailable()
    {
        if (_pandocAvailableCache is bool cached) return cached;
        bool available;
        try
        {
            using var proc = Process.Start(new ProcessStartInfo("pandoc", "--version")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            });
            available = proc is not null && proc.WaitForExit(3000) && proc.ExitCode == 0;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException)
        {
            available = false; // Pandoc未導入(PATHに無い)
        }
        _pandocAvailableCache = available;
        return available;
    }
}
