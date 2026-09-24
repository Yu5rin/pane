using System.Diagnostics;

namespace Pane;

/// <summary>
/// 起動時に dist の欠けを見つけたら、最新版をダウンロードして置き直す(利用者要望)。
///
/// 【画面をWebではなくWindows標準のもので作っている理由】
/// 欠けやすいのはまさに見た目の定義(style.css)で、設定画面(「更新する」ボタンのある画面)も
/// 同じ style.css で描いている。欠けた状態では設定画面も崩れるため、そこへ誘導しても
/// 直せない。確認・進み具合・失敗の知らせは、すべて PaneDialog と
/// <see cref="RepairProgressForm"/>(WinForms)で行う。
///
/// 【勝手に通信しない】Paneは利用者の操作なしに外部へ通信しない方針(UpdateService冒頭)。
/// 欠けを見つけても、まず尋ね、「はい」が押されてから初めて配布元へ問い合わせる。
///
/// 判定と文面は <see cref="DistIntegrity"/>、取りに行ってよい版の判断は
/// UpdateCheckLogic.IsOfferable に切り出してテストで固定してある。
/// </summary>
internal static class DistRepairFlow
{
    /// <summary>このプロセスで確認済みか。ウィンドウを開くたびに尋ねないよう、1回だけにする。</summary>
    private static bool _checkedThisProcess;

    /// <summary>ログに並べる欠けたファイル名の上限(残りは件数だけ)。</summary>
    private const int MaxLoggedNames = 20;

    /// <summary>
    /// dist を確かめ、欠けていればウィンドウが見えたあとで修復を尋ねる。欠けていなければ何もしない。
    ///
    /// 確かめるのは一覧(DistIntegrity.FileListName、約6KB)の読み込みと、約210個の File.Exists。
    /// 起動の妨げにならないよう、UIスレッドではなく裏のスレッドで行う(仕様書 第8.4節の
    /// 起動時間の目標)。起動直後は dist を先読みしている(StartWarmingUpDist)ので、実際には数msで終わる。
    /// </summary>
    /// <remarks>
    /// async void なのは、起動処理(MainForm.OnLoadAsync)をこの確認で待たせないため。
    /// そのかわり中の例外は呼び出し元へ届かず、放っておくとアプリごと落ちうるので、
    /// 全体を try で囲って必ずここで受け止める(確かめられないこと自体で起動を止めない)。
    /// </remarks>
    public static async void CheckOnce(Form owner, string distPath, Func<bool> hasUnsavedDocuments, Action shutdownForUpdate)
    {
        if (_checkedThisProcess) return;
        _checkedThisProcess = true;

        try
        {
            IReadOnlyList<string> missing = await Task.Run(() => FindMissingOnDisk(distPath));
            if (missing.Count == 0) return;

            // 何が欠けていたかを必ず残す。今回の件は、画面が崩れているのにログには何も無く、
            // 利用者の手元でPowerShellを実行してもらうまで原因が分からなかった。
            string names = string.Join(", ", missing.Take(MaxLoggedNames))
                         + (missing.Count > MaxLoggedNames ? $" ほか{missing.Count - MaxLoggedNames}件" : "");
            Logger.Error($"distのファイルが欠けている({missing.Count}件): {names} (distPath={distPath})");
            if (owner.IsDisposed) return;

            // ウィンドウが見える前に尋ねると、何の話か分からないうえ、オーナーの中央にも出せない。
            // 確かめている間にウィンドウが見えていれば、すぐ尋ねる。
            void Start()
            {
                if (owner.IsDisposed) return;
                owner.BeginInvoke(new MethodInvoker(() => _ = RunAsync(owner, missing, hasUnsavedDocuments, shutdownForUpdate)));
            }
            if (owner.Visible)
            {
                Start();
            }
            else
            {
                void OnShown(object? sender, EventArgs e)
                {
                    owner.Shown -= OnShown;
                    try { Start(); }
                    catch (Exception ex) { Logger.WriteException("distの修復: 確認を出せなかった", ex); }
                }
                owner.Shown += OnShown;
            }
        }
        catch (Exception ex)
        {
            Logger.WriteException("distの確認に失敗(続行する)", ex);
        }
    }

    /// <summary>一覧を読み、dist の中を実際に確かめる(裏のスレッドで呼ぶ)。</summary>
    private static IReadOnlyList<string> FindMissingOnDisk(string distPath)
    {
        string listPath = Path.Combine(distPath, DistIntegrity.FileListName);
        string? listJson = File.Exists(listPath) ? File.ReadAllText(listPath) : null;
        return DistIntegrity.FindMissing(listJson,
            name => File.Exists(Path.Combine(distPath, name.Replace('/', Path.DirectorySeparatorChar))));
    }

    private static async Task RunAsync(Form owner, IReadOnlyList<string> missing, Func<bool> hasUnsavedDocuments, Action shutdownForUpdate)
    {
        try
        {
            if (owner.IsDisposed) return;
            DialogResult choice = PaneDialog.Show(
                owner, DistIntegrity.BuildRepairPrompt(missing), "Pane", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (choice != DialogResult.Yes)
            {
                Logger.Write("distの修復: 利用者が見送った");
                return;
            }

            if (hasUnsavedDocuments())
            {
                ShowManualRepair(owner, "保存されていない変更があります。直すにはPaneの再起動が必要なので、先に保存してからPaneを起動し直してください。", "");
                return;
            }
            if (!UpdateService.CanWriteToInstallFolder(out string folder))
            {
                ShowManualRepair(owner, $"Paneが置かれている場所({folder})へ書き込めないため、自動では直せません。", "");
                return;
            }
            if (!UpdateService.TryBeginApply())
            {
                Logger.Write("distの修復: 更新の処理が既に進行中のため行わない");
                return;
            }

            try
            {
                await RepairAsync(owner, shutdownForUpdate);
            }
            finally
            {
                UpdateService.EndApply();
            }
        }
        catch (Exception ex)
        {
            Logger.WriteException("distの修復で想定外の失敗", ex);
        }
    }

    private static async Task RepairAsync(Form owner, Action shutdownForUpdate)
    {
        using var progress = new RepairProgressForm(owner);
        progress.Show(owner);
        string releaseUrl = "";
        try
        {
            progress.SetStatus("最新版を確認しています…");
            UpdateCheckResult info = await UpdateService.CheckAsync(SettingsService.Load(), forRepair: true);
            releaseUrl = info.ReleaseUrl;
            if (string.IsNullOrEmpty(info.DownloadUrl))
            {
                progress.Close();
                ShowManualRepair(owner, info.Message, releaseUrl);
                return;
            }

            progress.SetStatus($"{info.LatestVersion} をダウンロードしています…", 0);
            var downloadProgress = new Progress<int>(p => progress.SetStatus($"{info.LatestVersion} をダウンロードしています… {p}%", p));
            string zipPath = await UpdateService.DownloadAsync(info, downloadProgress, CancellationToken.None);

            progress.SetStatus("ファイルを置き直しています…");
            string newExe = UpdateService.ApplyUpdate(zipPath);

            progress.SetStatus("直しました。Paneを再起動します。", 100);
            Logger.Write($"distの修復: 完了({info.LatestVersion})。再起動する");
            UpdateService.StartNewVersion(newExe);
            shutdownForUpdate();
        }
        catch (Exception ex)
        {
            // 詳細はログへ。利用者には例外の型名や英語の文言を見せない(ExceptionMessages.Describe)。
            Logger.WriteException("distの修復に失敗", ex);
            if (!progress.IsDisposed) progress.Close();
            ShowManualRepair(owner, $"直せませんでした。{ExceptionMessages.Describe(ex)}", releaseUrl);
        }
    }

    /// <summary>
    /// 自動で直せなかったとき。理由と手で直す手順を示し、「はい」ならリリースページを開く。
    /// </summary>
    private static void ShowManualRepair(Form owner, string reason, string releaseUrl)
    {
        Logger.Write($"distの修復: 手で直す手順を案内する(理由: {reason})");
        if (owner.IsDisposed) return;
        DialogResult choice = PaneDialog.Show(
            owner, DistIntegrity.BuildManualRepairMessage(reason), "Pane", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (choice != DialogResult.Yes) return;

        string url = releaseUrl;
        if (string.IsNullOrEmpty(url))
        {
            string? atomUrl = UpdateCheckLogic.TryBuildAtomUrl(SettingsService.Load().UpdateCheckUrl?.Trim() ?? "");
            url = atomUrl is null ? "" : UpdateCheckLogic.BuildLatestReleasePageUrl(atomUrl);
        }
        // 開くのはhttpsのURLだけ(SettingsBridge.OpenReleasePageと同じ用心)。
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            Logger.Warn($"distの修復: 開けるリリースページが無い(値=\"{url}\")");
            return;
        }
        try
        {
            using var proc = Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            Logger.Write($"distの修復: リリースページを開いた: {uri.AbsoluteUri}");
        }
        catch (Exception ex)
        {
            Logger.WriteException("distの修復: リリースページを開けなかった", ex);
        }
    }

    /// <summary>
    /// 進み具合を見せる小さな窓。閉じるボタンは持たせない(ダウンロードや置き直しの途中で
    /// 閉じられても、処理そのものは止まらず、何が起きているか分からなくなるため)。
    /// 配色は本体・PaneDialogと同じ手順(テーマの既定色 + WindowChrome.ApplyTheme)で塗る。
    /// </summary>
    private sealed class RepairProgressForm : Form
    {
        private readonly Form _owner;
        private readonly bool _isDark;
        private readonly Label _status;
        private readonly ProgressBar _bar;

        public RepairProgressForm(Form owner)
        {
            _owner = owner;
            _isDark = MainForm.ResolveIsDarkTheme(SettingsService.Load().Theme);
            string? backgroundHex = (owner as MainForm)?.TitlebarBackgroundOverride;
            string? foregroundHex = (owner as MainForm)?.TitlebarForegroundOverride;
            Color background = ParseColor(backgroundHex, _isDark ? WindowChrome.DefaultDarkBackground : WindowChrome.DefaultLightBackground);
            Color foreground = ParseColor(foregroundHex, _isDark ? WindowChrome.DefaultDarkForeground : WindowChrome.DefaultLightForeground);

            Text = "Pane";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            ControlBox = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Font = SystemFonts.MessageBoxFont ?? Font;
            BackColor = background;
            ForeColor = foreground;
            ClientSize = new Size(360, 96);
            Icon? windowIcon = AppIcon.Create();
            if (windowIcon is not null) Icon = windowIcon;

            _status = new Label
            {
                AutoSize = false,
                Location = new Point(20, 20),
                Size = new Size(320, 24),
                ForeColor = foreground,
                BackColor = Color.Transparent,
            };
            _bar = new ProgressBar
            {
                Location = new Point(20, 56),
                Size = new Size(320, 16),
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 30,
            };
            Controls.Add(_status);
            Controls.Add(_bar);

            // 96DPI基準で組んだ配置を実際のDPIへ合わせる(PaneDialogと同じ考え方)。
            double scale = owner.IsHandleCreated ? owner.DeviceDpi / 96.0 : 1.0;
            if (Math.Abs(scale - 1.0) > 0.01) Scale(new SizeF((float)scale, (float)scale));
        }

        /// <summary>状況の文言と、分かれば進み具合(0〜100)を出す。分からないときは流れる表示にする。</summary>
        public void SetStatus(string text, int percent = -1)
        {
            if (IsDisposed) return;
            _status.Text = text;
            if (percent < 0)
            {
                _bar.Style = ProgressBarStyle.Marquee;
            }
            else
            {
                _bar.Style = ProgressBarStyle.Continuous;
                _bar.Value = Math.Clamp(percent, 0, 100);
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            WindowChrome.ApplyTheme(this, _isDark, (_owner as MainForm)?.TitlebarBackgroundOverride, (_owner as MainForm)?.TitlebarForegroundOverride);
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            // オーナーの中央へ。はみ出すときは作業領域の中に収める。
            Rectangle area = Screen.FromControl(_owner).WorkingArea;
            int x = _owner.Bounds.Left + (_owner.Bounds.Width - Width) / 2;
            int y = _owner.Bounds.Top + (_owner.Bounds.Height - Height) / 2;
            Location = new Point(
                Math.Clamp(x, area.Left, Math.Max(area.Left, area.Right - Width)),
                Math.Clamp(y, area.Top, Math.Max(area.Top, area.Bottom - Height)));
        }

        private static Color ParseColor(string? hex, string fallbackHex)
        {
            try { if (!string.IsNullOrWhiteSpace(hex)) return ColorTranslator.FromHtml(hex); }
            catch { /* 読めなければ既定色へ */ }
            return ColorTranslator.FromHtml(fallbackHex);
        }
    }
}
