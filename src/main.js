// Pane エントリポイント。
// WebView2(window.chrome.webview)が使える場合はpostMessageブリッジでC#側に
// ファイルの開閉・保存・エクスポート・印刷・画像挿入等を委譲する(仕様書 第7章)。
// 使えない場合(単体のブラウザで動作確認する場合)は File System Access API /
// File API による仮実装にフォールバックする(Phase 1からの経路をそのまま維持)。
import { createEditor, DEFAULT_FONT_SIZE } from "./editor.js";
import { buildCommands, initMenuBar, initCommandPalette, initContextMenu, routeNativeMenuCommand, routeNativeMenuClosed, routeNativeMenuArrowSwitch, bindShortcuts, applyKeyBindings, showContextMenu } from "./commands.js";
import { createSearchUI, refreshOpenSearchCount } from "./search-ui.js";
import { createSidebar } from "./sidebar.js";
import { createQuickOpen } from "./quick-open.js";
import { createWordCountPopup } from "./word-count.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { parseFrontMatterOverrides } from "./md-to-html.js";
import { resolveFileMode, codeLanguages } from "./languages.js";
import { FILE_TYPES } from "./file-types.js";
import { detectContentMode, detectCodeLanguage } from "./detect-mode.js";
import { setReadingSpeedWpm } from "./text-stats.js";
import { setOutlineMaxLevel } from "./markdown-extras.js";
import { paneConfirm, paneAlert, paneInput } from "./dialog.js";
import { applyTooltip, applyTooltipsIn, setCurrentLevel as setSharedTooltipLevel, TOOLTIP_LEVELS, DEFAULT_TOOLTIP_DETAIL } from "./tooltips.js";

const host = document.getElementById("cm-host");
const statusbarEl = document.getElementById("statusbar");
const menubarEl = document.getElementById("menubar");
const statusSidebarBtn = document.getElementById("status-sidebar");
const statusMode = document.getElementById("status-mode");
const statusPosition = document.getElementById("status-position");
const statusCount = document.getElementById("status-count");
const statusDirty = document.getElementById("status-dirty");
const statusZoom = document.getElementById("status-zoom");
const statusEncoding = document.getElementById("status-encoding");
const statusLineEnding = document.getElementById("status-line-ending");
const statusWrapBtn = document.getElementById("status-wrap");
const fileInput = document.getElementById("file-input");
const imageInput = document.getElementById("image-input");
// タブバー(仕様書 第2.10節 C-14、隠し設定)。displayMode==="tab"のときだけ表示する。
const tabbarEl = document.getElementById("tabbar");
const tabbarListEl = document.getElementById("tabbar-list");
const tabbarNewBtn = document.getElementById("tabbar-new");
// 内容からの編集モード自動判定(仕様書 第1章の拡張)の通知バナー。モーダルにはしない
// (常時ステータスバー付近に浮かべ、入力の邪魔をしない)。
const adBanner = document.getElementById("ad-banner");
const adBannerText = document.getElementById("ad-banner-text");
const adBannerAction = document.getElementById("ad-banner-action");
const adBannerClose = document.getElementById("ad-banner-close");

// 言語ID(src/file-types.js の FILE_TYPES[].id)→表示ラベルの対応。ステータスバーの
// 「コード (Python)」表示・言語ピッカーの両方で使う。
const LANGUAGE_LABELS = Object.fromEntries(FILE_TYPES.map((t) => [t.id, t.label]));

const bridge = window.chrome?.webview ?? null;

// ブラウザ既定の右クリックメニューを一切出さない(docs/コンテキストメニュー仕様.md 大原則1)。
// WebView2側でもAreDefaultContextMenusEnabled=falseを設定しているが(Pane/MainForm.cs)、
// 保険としてJS側でも最外周(捕捉フェーズ)で止める。独自メニューを出す/出さないの判断は
// このあと個別に登録するcontextmenuリスナー(initContextMenu、バブルフェーズ)側で行う。
document.addEventListener("contextmenu", (e) => e.preventDefault(), true);

// ---- 実機での不具合調査用ログ(仕様書外・デバッグ支援) ----
// C#側のLogger(%LOCALAPPDATA%\Pane\logs\)へJS側のログもまとめて送る。DevTools(Shift+F12)を
// 別途開かなくても、テキストファイル1つで両側の動きを追えるようにする。
function logToHost(level, message) {
  console[level === "error" ? "error" : "log"](message);
  bridge?.postMessage({ type: "log", level, message: String(message) });
}
// ---- 起動時間の内訳の計測(実機で起動が遅い件の調査用) ----
// C#側のログには「Navigate呼び出し完了」から「initial-render-ready受信」までの時間が
// 既に出ているが、その間(実測で全体の約8割)の中身がまったく見えていなかった。
// performance.now() はこのページの読み込み開始を 0 とするため、値そのものが
// Navigate からの経過msになる。区切りごとに時刻を控えておき、最後にまとめて1行で出す。
//
// 途中で1行ずつ出さないのは、ログの往復(postMessage)自体が計測対象の時間に混ざるのを
// 避けるため。マークを打つだけなら配列へ push するだけで済む。
const startupMarks = [];
function markStartup(label) {
  startupMarks.push([label, performance.now()]);
}
// ここに到達した時点で、importしたモジュール(CodeMirror本体・言語・拡張など)の
// 評価はすべて終わっている。バンドル全体の読み込みと評価にどれだけかかったかが分かる。
markStartup("バンドル評価");

function reportStartupMetrics() {
  try {
    const round = (v) => Math.round(v);
    const nav = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const findResource = (suffix) =>
      resources.find((r) => r.name.endsWith(suffix) || r.name.includes(`${suffix}?`));

    const parts = [];
    // index.html の取得完了までを最初の区間にする。ここが大きければWebView2の
    // 仮想ホストマッピング経由のファイル配信側が遅いということになる。
    let prev = 0;
    if (nav && nav.responseEnd > 0) {
      parts.push(`HTML取得=${round(nav.responseEnd)}ms`);
      prev = nav.responseEnd;
    }
    // 区間はマーク間の差分。最初のマーク(バンドル評価)だけはHTML取得の完了が起点。
    for (const [label, at] of startupMarks) {
      parts.push(`${label}=${round(at - prev)}ms`);
      prev = at;
    }

    // 参考値: 起動時に必ず読み込むファイルの取得時間とサイズ。バンドル評価の区間が
    // 大きかったとき、それがダウンロード待ちなのかJSの実行なのかを切り分ける。
    const detail = [];
    for (const [name, suffix] of [["main.js", "/main.js"], ["style.css", "/style.css"]]) {
      const r = findResource(suffix);
      if (!r) continue;
      const kb = r.encodedBodySize ? `${round(r.encodedBodySize / 1024)}KB` : "サイズ不明";
      detail.push(`${name}=${round(r.duration)}ms/${kb}`);
    }

    // 「バンドル評価」の区間が大きかったときの切り分け材料。この区間には、main.jsから
    // 芋づるに読み込まれるチャンクの取得と、JSを実際に走らせる時間の両方が入っている。
    // 取得がすべて終わった時刻を出しておけば、待たされていたのがディスク側なのか
    // JSの実行側なのかが後から分かる(更新直後の初回起動が遅い件の調査用。
    // 実機では通常68msのところが3255msになっていた)。
    const firstMarkAt = startupMarks.length ? startupMarks[0][1] : performance.now();
    const startupResources = resources.filter((r) => r.startTime < firstMarkAt && r.responseEnd > 0);
    if (startupResources.length) {
      const lastEnd = Math.max(...startupResources.map((r) => r.responseEnd));
      detail.push(`起動までに${startupResources.length}件取得(最後の完了=${round(lastEnd)}ms)`);

      // どのファイルで待たされたのかまで出す。実機のログでは main.js 自体は数msで取れて
      // いるのに全体で2秒かかっており、遅いのは別のファイルだと分かっている。名前が
      // 分かれば、分割の仕方を変えるべきか、環境側(ウイルス対策の走査など)の話なのかを
      // 判断できる。速いときは並べても意味がないので、目立つものがある場合だけ出す。
      const slowest = startupResources.slice().sort((a, b) => b.duration - a.duration).slice(0, 3);
      if (slowest.length && slowest[0].duration >= 100) {
        const names = slowest
          .filter((r) => r.duration >= 100)
          .map((r) => `${r.name.split("/").pop()}=${round(r.duration)}ms`);
        detail.push(`遅い順: ${names.join(", ")}`);
      }
    }

    logToHost(
      "info",
      `[計測:JS] 起動の内訳 合計=${round(performance.now())}ms | ${parts.join(", ")}` +
        (detail.length ? ` | 読み込み: ${detail.join(", ")}` : ""));
  } catch (e) {
    // 計測に失敗しても起動には影響しない。Performance APIが期待どおり揃っていない
    // 環境(素のブラウザでの検証など)でここが例外を投げても黙って諦める。
    logToHost("log", `[計測:JS] 起動の内訳を出せなかった: ${e}`);
  }
}

// ---- 未処理エラーの記録(同じものは打ち切る) ----
// 描画やイベント処理の中で起きたエラーは、原因が直らないかぎり同じものが何度でも発生する。
// 毎回そのまま記録するとログがそれだけで埋まり、他の手がかりが読めなくなる(実機で
// 「ログを開くとエラーがループする」不具合が実際に起きている)。同じ内容は上限まで記録し、
// 超えたら1度だけ打ち切りを知らせて以後は黙る。
const MAX_SAME_ERROR_REPORTS = 5;
const errorReportCounts = new Map();
function logErrorLimited(key, message) {
  const count = (errorReportCounts.get(key) ?? 0) + 1;
  errorReportCounts.set(key, count);
  if (count <= MAX_SAME_ERROR_REPORTS) {
    logToHost("error", message);
    return;
  }
  if (count === MAX_SAME_ERROR_REPORTS + 1) {
    logToHost("warn", `同じエラーが${MAX_SAME_ERROR_REPORTS}回を超えたため、以後は記録しない: ${key}`);
  }
}

window.addEventListener("error", (e) => {
  logErrorLimited(
    `${e.message}@${e.filename}:${e.lineno}`,
    `JS未処理エラー: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  logErrorLimited(`rejection:${e.reason}`, `JS未処理のPromise拒否: ${e.reason}`);
});

// ---- 画面が固まった時間の検知 ----
// 「たまに重い」「一瞬固まる」という不具合は、後からログを見ても何も残っていないため
// 追いようがなかった。一定間隔のタイマーが予定よりどれだけ遅れて発火したかを見ると、
// その間メインスレッドが何かに占有されていたことが分かる。閾値を超えたときだけ記録する。
//
// 記録を始めるのは起動が一段落してから(reportStartupMetricsの直後)。起動処理そのものは
// 重くて当たり前で、その内訳は別途[計測:JS]で出しているため、ここで二重に警告しない。
const STALL_CHECK_INTERVAL_MS = 1000;
const STALL_WARN_MS = 500;
// この長さを超える停止は、Paneがメインスレッドをずっと握っていたと考えるより、
// PCがスリープ・休止していた、または画面がロックされていたと考えるほうが自然。
// 実機のログで、13分間なにも記録が無いあとに41.8秒の停止が記録され、その15秒後に
// 利用者がウィンドウを閉じた、という並びが実際に出た(離席から戻ってきた形)。
// Paneに41秒もメインスレッドを占有する処理は無い。
const STALL_LIKELY_SUSPEND_MS = 20000;

function startStallWatch() {
  let previous = performance.now();
  // 停止していた区間にウィンドウが後ろに回っていたかどうかを、後から言えるようにする。
  // ロック・スリープではまずフォーカスを失うため、判断の材料になる。
  let lastBlurAt = -1;
  window.addEventListener("blur", () => { lastBlurAt = performance.now(); });

  setInterval(() => {
    const now = performance.now();
    const delay = now - previous - STALL_CHECK_INTERVAL_MS;
    const startedAt = previous;
    previous = now;
    // ウィンドウが非表示・最小化のときブラウザはタイマーの発火間隔を意図的に間引くため、
    // その遅れは不具合ではない。見えている間だけを対象にする。
    if (document.hidden) return;
    if (delay < STALL_WARN_MS) return;

    // 「本当にPaneが固まっていたのか」を後から切り分けられるだけの材料を添える。
    // ここで黙ってしまうと本物のフリーズを取り逃がすため、警告自体は必ず出す。
    const blurredDuringStall = lastBlurAt >= startedAt;
    const suspectSuspend = delay >= STALL_LIKELY_SUSPEND_MS || blurredDuringStall;
    const note = suspectSuspend
      ? "PCのスリープ・休止や画面ロックからの復帰でもこの記録は出る" +
        `(この間ウィンドウは${blurredDuringStall ? "後ろに回っていた" : "手前のままだった"})。` +
        "Pane側が固まっていたのなら、同じ時間帯に重い操作の記録が残っているはず"
      : "この間、何かの処理がメインスレッドを占有していた";
    logToHost("warn", `画面の応答が${Math.round(delay)}ms止まっていた(${note})`);
  }, STALL_CHECK_INTERVAL_MS);
}

// ---- 起動時の白フラッシュ対策(新方式) ----
// C#側(Pane/MainForm.cs)はWebView2コントロール自体を"initial-render-ready"を受け取るまで
// 非表示にしている(その間はフォームの背景色=テーマ色だけが見える)。ここでは
// 「テーマ・メニューバー・ステータスバー・本文エリアの初期描画が終わった」と判断できる
// 2つの条件——(1)最初のapply-settings(テーマ・フォント等ここまでで確定)と、
// (2)最初のfile-opened/new-document(本文エリアに内容が反映)——の両方が揃った時点で
// 一度だけ通知する。以後のapply-settings再送(設定変更等)・2件目以降のfile-openedでは
// 再送しない。C#側にも通知が来なかった場合のフォールバックタイマーがあるため、ここで
// 万一送れなくてもウィンドウが永久に白いままにはならない(が、その保険はJS側からは
// 検証できない。詳細はPane/MainForm.cs RevealWebView参照)。
let initialSettingsApplied = false;
let initialDocumentApplied = false;
let initialRenderReadySent = false;
function markInitialSettingsApplied() {
  // 2回目以降(設定変更による再送)は計測に混ぜない。
  if (!initialSettingsApplied) markStartup("設定反映(apply-settings)");
  initialSettingsApplied = true;
  trySignalInitialRenderReady();
}
function markInitialDocumentApplied() {
  if (!initialDocumentApplied) markStartup("本文反映(new-document/file-opened)");
  initialDocumentApplied = true;
  trySignalInitialRenderReady();
}
function trySignalInitialRenderReady() {
  if (initialRenderReadySent || !initialSettingsApplied || !initialDocumentApplied) return;
  initialRenderReadySent = true;
  // 【実バグ1の修正】以前はここでrequestAnimationFrameを2回挟んでから通知していた
  // (「直前までのDOM変更が実際にペイントされてから通知する」ため)。しかしC#側
  // (Pane/MainForm.cs)はこの通知を受け取るまでWebView2コントロール自体を非表示
  // (Visible=false)にしたままにしている設計のため、非表示の間はブラウザの描画
  // パイプラインが止まっており、requestAnimationFrameのコールバックが一切発火しない。
  // 結果として通知が送れないまま3秒のフォールバックタイマー(WebViewRevealFallbackMs)が
  // 先に発動して強制表示され、そこでようやくrAFが発火して通知が送られる——という
  // 「見えるまで通知しない」のに「通知するまで見せない」という自己矛盾した無限待ちに
  // なっており、白フラッシュ対策が実質機能していなかった(実機ログで2.5秒以上の
  // 遅延を確認済み)。
  //
  // 「ペイント完了を待ってから通知する」という当初の意図は、この
  // 非表示→通知→表示という順序そのものと両立しない。WebView2が非表示の間は
  // そもそも何もペイントされないため、ペイント完了を待つこと自体が無意味であり、
  // ここに来る時点でDOM変更(テーマ属性の付与・本文setValue等)は既に同期的に
  // 完了している。表示後の実際の初回ペイントはC#側がVisible=trueにした直後に
  // WebView2が行うため、JS側はrAFはおろかsetTimeoutの1tickすら待たず、条件が
  // 揃った瞬間に即座に通知する(非表示中でも確実に送られることをコード上で保証する:
  // requestAnimationFrame/setTimeoutを一切使わない同期呼び出しにした)。
  reportStartupMetrics();
  startStallWatch();
  logToHost("log", "initial-render-ready送信(テーマ・メニューバー・ステータスバー・本文エリアの初期描画完了)");
  bridge?.postMessage({ type: "initial-render-ready" });
}

let currentHandle = null; // File System Access API(ブラウザ単体時のみ使用)
let currentPath = null; // ブリッジ経由で開いた際のフルパス(最近使ったファイル・画像挿入・reopenClosedに使う)
let currentName = "無題";
// 不具合修正: 以前はnullで初期化しており、C#側からencoding/lineEndingが一度も届かない
// (ブラウザ単体検証・想定外の経路等)とステータスバーの文字コード・改行コードが
// 空欄のまま丸ごと消えていた。最終フォールバックのUTF-8/CRLFで初期化しておき、
// 実際の値はnew-document/file-opened等のメッセージで上書きされる。
let currentEncoding = "UTF-8";
let currentLineEnding = "CRLF";
// 設定(defaultEncoding/defaultLineEnding)から作った既定ラベル。C#側がencoding/lineEndingを
// 送ってこなかった場合(new-documentの旧経路・ブラウザ単体検証等)のフォールバックに使う。
// apply-settings受信のたびに最新化する(未受信の間は上のUTF-8/CRLFのまま)。
let defaultEncodingLabel = "UTF-8";
let defaultLineEndingLabel = "CRLF";
// ステータスバーから文字コード・改行コードを明示的に変更したかどうか(無題文書ごとに
// applyNewDocumentLocalでリセットされる)。trueの間は、設定変更(apply-settings)による
// 無題文書への既定値追従を止める。仕様書6.1「変更：ステータスバーから明示的に変更でき、
// その場合のみ再エンコードする」を踏まえ、ユーザー操作を設定変更より優先するための判断。
let encodingSetExplicitly = false;
let lineEndingSetExplicitly = false;
// AppSettings.DefaultEncoding/DefaultLineEndingのキー("utf8"等)を表示ラベル("UTF-8"等)へ
// 変換する。Pane/TextFileService.cs の EncodingLabel/ParseEncodingKey・LineEndingLabel/
// ParseLineEndingKeyと対応を揃えること(ここが崩れるとステータスバー表示と実際の
// 保存形式がずれる)。
function encodingKeyToLabel(key) {
  switch (key) {
    case "utf8bom": return "UTF-8 (BOM付き)";
    case "shiftjis": return "Shift_JIS";
    case "utf16le": return "UTF-16 LE";
    default: return "UTF-8";
  }
}
function lineEndingKeyToLabel(key) {
  return key === "lf" ? "LF" : "CRLF";
}
let wordWrapOn = true;
// ツールチップの詳しさ(仕様書 依頼2「マウスカーソルを合わした時に説明を出す」機能、
// 設定tooltipDetail、既定"standard")。文言そのものはsrc/tooltips.jsに集約してあり、
// ここでは現在の段階を保持して、状態を持つ要素(文字コード等)のtitleを都度更新するのに使う。
// apply-settingsで届くたび、および設定画面での即時プレビュー(未保存段階)でも更新する
// (setTooltipLevel/ctx.setTooltipLevel参照)。
let tooltipLevel = DEFAULT_TOOLTIP_DETAIL;
function setTooltipLevel(level) {
  tooltipLevel = TOOLTIP_LEVELS.includes(level) ? level : DEFAULT_TOOLTIP_DETAIL;
  // sidebar.js/global-search.jsのように、ファイルパス等をtitleとして出す動的な一覧行
  // (数が多く、個別にdata-tipを振るのは現実的でない箇所)が、ctxを介さず直接
  // 「今noneかどうか」だけを読めるよう、tooltips.js側にも複製しておく。
  setSharedTooltipLevel(tooltipLevel);
  refreshAllTooltips();
}
// ページ全体([id]・[data-tip]を持つ要素すべて)へ現在の段階を再適用する。段階そのものが
// 変わった時(setTooltipLevel)と起動直後の初期反映に使う。文字コード等の「状態」を持つ
// 要素は、テーブルに無い動的な値(現在の値)を渡し直す必要があるため、汎用の一括適用の後で
// 個別に上書きする(各updateXXX関数側でも同じ呼び出しを行い、値が変わるたびに追従させる)。
function refreshAllTooltips() {
  applyTooltipsIn(document.body, tooltipLevel);
  applyTooltip(statusMode, tooltipLevel, { state: statusMode.textContent });
  applyTooltip(statusPosition, tooltipLevel, { state: statusPosition.textContent });
  applyTooltip(statusEncoding, tooltipLevel, { state: currentEncoding });
  applyTooltip(statusLineEnding, tooltipLevel, { state: currentLineEnding });
  applyTooltip(statusWrapBtn, tooltipLevel, { state: wordWrapOn ? "折り返しあり" : "折り返しなし" });
  applyTooltip(statusCount, tooltipLevel, { state: statusCount.textContent });
  applyTooltip(statusZoom, tooltipLevel, { state: statusZoom.textContent });
}
let defaultCopyFormat = "markdown"; // "markdown" | "html"(仕様書 第2.9.3節、設定で切替)
let pandocAvailable = false;
let recentFiles = [];
// エクスポート・印刷の詳細設定(仕様書 docs/設定項目一覧.md「エクスポート・印刷」節)。
// JS側で使う項目だけをここに保持し、C#側専用の項目(exportDefaultFolder等)もそのまま
// 通過させてexport/printメッセージに乗せる(C#側で読む)。既定値はAppSettings.csと揃える。
let exportSettings = {
  exportPaperSize: "a4", exportCustomWidthMm: 210, exportCustomHeightMm: 297,
  exportOrientation: "portrait",
  exportMarginTopMm: 20, exportMarginBottomMm: 20, exportMarginLeftMm: 20, exportMarginRightMm: 20,
  exportHeaderText: "", exportFooterText: "",
  exportPageBreakBetweenTopHeadings: false,
  exportIncludeOutline: false, exportOutlineWidthPx: 260,
  exportAppendHead: "", exportAppendBody: "",
  exportDefaultFolder: "sameAsFile", exportCustomFolder: "",
  exportAfter: "none", exportShowSaveDialog: true,
  exportMathAs: "svg", exportReadYamlFrontMatter: true,
};
// 直近読み込みに成功したフォルダ(仕様書 第2.8節: ファイルを開くと親フォルダが自動読み込まれる)。
// { rootPath, rootName, entries, truncated } 。未読み込み・読み込み失敗時はnullのまま
// (失敗時のエラー表示はサイドバー側にだけ渡し、ここでは保持しない)。
let folderData = null;
// ダーティ・読み取り専用の表示はOSネイティブのウィンドウタイトルが兼ねる(C#側UpdateTitle)ため、
// HTML側は確認ダイアログの判定等に使う内部状態としてのみ保持する。
let isDirty = false;
let isReadOnly = false;
// ---- ダーティ判定の基準(実機不具合の修正) ----
// 以前は「変更操作があったか(onChangeが呼ばれたかどうか)」でdirtyを立てていたため、
// 文字を打ってからCtrl+Z・BackSpace等で読み込み時/保存時とまったく同じ内容に戻しても
// 「未保存」表示が消えなかった。VS Code・Typora・メモ帳など主要なエディタはいずれも
// 「内容が最後に保存(または読み込み)した状態と一致していればdirty表示を消す」ため、それに揃える。
// savedDocRef: 最後に保存/読み込みした時点のCodeMirrorのdoc(Text、markSaved()で更新)。
// nullは「基準が無い」ことを示す特殊値で、常にdirty扱いにしたい場合(クラッシュリカバリ
// からの復元直後など)にだけ使う。
let savedDocRef = null;
// 文字コード・改行コードをステータスバーから明示的に変更したことによる追加のダーティフラグ。
// 本文そのものは変わらないが、保存すると別の内容(別のバイト列)になるため、本文の一致とは
// 独立してdirty扱いにする(markSaved()でクリアする)。
let metaDirty = false;
const closedFiles = []; // 閉じたファイルを再度開く(このウィンドウ内での置き換え履歴、ブリッジ利用時のみ)
const CLOSED_FILES_CAP = 20;
// グローバル検索のヒット行クリック(仕様書 第2.6節 G-02)から「開いたら指定行へジャンプする」
// 保留状態。openFileByPath(path, line)で設定し、file-openedが届いたタイミングで
// applyFileOpened側が消費する。{ path, line } または未設定時はnull。
let pendingGotoLine = null;
// 文字数カウントの表示ON/OFF(仕様書 V-13)。C#側の設定受け口が未実装でも動作に支障が
// 出ないよう、既定値はON(従来どおり表示)にしておく。
let showWordCount = true;
// キーバインドのカスタマイズ(仕様書 第2.10節 C-10)。コマンドID→ショートカット文字列。
// apply-settingsで届くたびに更新し、commands.jsのapplyKeyBindings()で既存のcommands配列
// (メニューバー・コマンドパレット・ショートカット待受け・設定画面が共有する同一インスタンス)
// へ即座に反映する(再起動不要)。getState()にも公開し、起動直後のbuildCommands()呼び出し
// 自体もこの値を参照できるようにする。
let keyBindings = {};
// 編集モード決定(仕様書 第1章)の優先順位2・3を上書きする設定。いずれもapply-settingsで届く。
// fileModeOverrides: 拡張子(ドット無し・小文字)→モード名。perFileModes: フルパス→手動で選んだモード名
// (優先順位1。同一セッション内での即時反映用にローカルにもキャッシュし、setMode()で都度更新する)。
let fileModeOverrides = {};
let perFileModes = {};
// 内容からの編集モード自動判定(仕様書 第1章の拡張)。既定は"standard"。
// off: 何もしない / suggest: 提案のみ(切り替えない) / standard: 無題の新規文書のみ即座に
// 切り替え(取り消し可) / aggressive: standardに加え拡張子ファイルでも食い違えば提案する。
let autoDetectMode = "standard";
const AUTO_DETECT_MODES = new Set(["off", "suggest", "standard", "aggressive"]);
// 現在の文書に対する自動判定の状態。ファイルを開く/新規作成のたびリセットする(仕様書の
// 「文書ごと」の記憶)。
//   locked:    trueなら以後この文書には一切自動判定を行わない。手動でモードを選んだ・
//              「元に戻す」を押した・無題の文書が拡張子付きで保存された、のいずれかで立つ。
//   suggested: 一度でも提案を出したらtrue(同じ文書に再提案しない)。
let autoDetectState = { locked: false, suggested: false };
function resetAutoDetectState() {
  autoDetectState = { locked: false, suggested: false };
  hideAdBanner();
}
// editor.setValue()をプログラムによる内容差し替え(ファイルを開く・新規作成等)として
// 自動判定の対象から除外しつつ呼ぶ。setValue()が実質差分無し(例: 空文書→空文書)の場合は
// CodeMirrorのdocChangedが発火せずonChange側でフラグを消費できないことがあるため、
// 呼び出し後にも明示的にfalseへ戻して次の本物の変更に影響を残さないようにする。
function setEditorValueQuiet(text) {
  suppressNextAutoDetectChange = true;
  editor.setValue(text);
  suppressNextAutoDetectChange = false;
}
// ペースト直後(貼り付け文字数がAUTO_DETECT_PASTE_MIN_CHARS以上)と、入力が止まって
// AUTO_DETECT_IDLE_MSたった時の2箇所だけで判定を走らせる(仕様: 入力のたびには走らせない)。
let lastPasteLength = 0;
let idleDetectTimer = null;
// ファイルを開く等プログラムによる内容差し替え(editor.setValue())の直後のonChangeは、
// ユーザーの入力ではないため自動判定の対象から除外する(ペースト/入力停止のみが対象)。
let suppressNextAutoDetectChange = false;
const AUTO_DETECT_PASTE_MIN_CHARS = 80;
const AUTO_DETECT_IDLE_MS = 1500;
// バグチェック①の調査で0.55のままにした理由: detect-mode.jsのLANGUAGE_SCORE_THRESHOLD=3
// (言語判定が何か返すための最低点)と、confidenceの計算式 min(0.9, 0.3+score*0.09) から、
// 言語判定が非ゼロのconfidenceを返す時点で必ず0.57以上になる(0.3+3*0.09=0.57)。つまり
// 「コードとして言語が特定できた」場合は、この定数をどこに置いても実質この閾値では
// 弾けない(0.55を上げるなら0.57超まで上げないと無意味で、そこまで上げるとMarkdown側の
// 弱い判定(スコア3の下限で0.4+3*0.08=0.64)まで一緒に締め出してしまう)。今回の誤判定
// (JS 0.57 / CSS 0.66で発火)の真因は、フェンスの中身を言語判定に含めてしまっていたこと
// (上のdetectContentMode参照)であり、閾値の甘さではなかった。実際、その修正後は
// 同じ入力の言語スコアが0(判定なし)まで落ちることを確認済みのため、この定数自体は
// 変更しない。
const AUTO_DETECT_CONFIDENCE_MIN = 0.55;
// 全画面表示・常に手前に表示(仕様書 V-08/V-12)の状態。実際のトグルはC#側(WinForms)が
// 持っており、"window-state"で都度届く値をそのまま保持するだけ(第10.5節: JS側は表示専用)。
let windowState = { fullscreen: false, alwaysOnTop: false };
// 設定画面(仕様書 第2.10節)。実機(WebView2、bridgeあり)では常にC#側の専用ウィンドウ
// (Pane/SettingsWindow.cs)を開かせるため、ここのsettingsUI(settings.js製のHTMLモーダル)は
// ブリッジが無いブラウザ単体動作(開発確認用)のフォールバックとしてしか使われない。
// settings.js自体は90KB超あり(第8.4節、初期ロードJS)、本体では出番が無いことが多いため、
// ctx構築後(buildCommands()でctx.commandsが揃ってから)即座に生成せず、実際に必要になった
// 瞬間(=ブリッジ無しでopenSettings()が呼ばれた最初の1回)にだけ動的importする
// (math.js/mermaid-render.js/color-picker-panel.jsと同じ作法)。
let settingsUI = null;
let settingsUIPromise = null;
function ensureSettingsUI() {
  if (settingsUI) return Promise.resolve(settingsUI);
  if (!settingsUIPromise) {
    settingsUIPromise = import("./settings.js").then(({ createSettings }) => {
      settingsUI = createSettings(ctx);
      return settingsUI;
    }).catch((err) => {
      // 不具合3の修正: 読み込みに失敗したPromiseをsettingsUIPromiseへ入れたままにすると、
      // 「!settingsUIPromise」が常にfalseになり続け、以後ensureSettingsUI()を何度呼んでも
      // このreject済みPromiseが返るだけで二度と再試行されなくなる。ここで確実にnullへ
      // 戻し、次にopenSettings()が呼ばれた時にもう一度動的importを試みられるようにする。
      // 呼び出し側(openSettings)にも失敗を伝える必要があるので、rejectのまま投げ直す。
      settingsUIPromise = null;
      throw err;
    });
  }
  return settingsUIPromise;
}
// Ctrl+マウスホイールでの文字サイズ変更(仕様書 zoomWithCtrlWheel、既定true)。
let zoomWithCtrlWheelOn = true;
// サイドバーのファイル一覧・ツリーからの切替時、未保存の変更を確認せず保存してから
// 切り替えるか(仕様書 saveWithoutAskingOnSwitch、既定false)。
let saveWithoutAskingOnSwitch = false;
// 起動時アウトライン既定表示(仕様書 showOutlineByDefault)は最初のapply-settingsでのみ判定する。
// ユーザーが手でサイドバーを閉じた後、以後apply-settingsが再送されても勝手に開かないようにする。
let initialSidebarAutoOpenDone = false;
// switchFileFromSidebar()がbridge経由の保存完了("save-result")を待つためのresolve関数群。
let pendingSaveResolvers = [];

// HTMLエクスポート(画像のdata:埋め込み、Pane/MainForm.cs HandleReadLocalImageRequest参照)用の
// 「読み取り要求id → resolve関数」対応表。1回のエクスポートで複数の画像を並行して要求しうる
// (md-to-html.js substituteImagePlaceholdersがPromise.allでまとめて呼ぶ)ため、
// save-result等と違いFIFOでは対応が付けられず、要求ごとに採番したidで突き合わせる。
let localImageRequestSeq = 0;
const pendingLocalImageResolvers = new Map();

// ---- タブ形式(仕様書 第2.10節 C-14・第3章「表示形式」、隠し設定) ----
// 既定は"window"(無効)。apply-settingsのmsg.displayModeでのみ更新する。設定画面には
// 切替UIを一切置かない(ユーザー指示。docs/設定項目一覧.mdの隠し設定の注記を参照)。
// "window"のままなら以下のtabs配列・関連関数は一切使わず、既存のグローバル変数
// (currentPath等)だけで完結させる。これにより「ウィンドウ形式の挙動を一切変えない」
// (絶対条件)を保証する。
let displayMode = "window";
// タブの配列。displayMode==="tab"のときだけ使う。各要素:
//   { id(連番。DOM紐付け用), guid(C#側のAutoSaveService用の識別子文字列),
//     path, fileName, encoding, lineEnding, readOnly, dirty,
//     editorState(CodeMirrorのEditorState。doc・選択範囲・アンドゥ履歴を含む),
//     mode, codeLanguage, sourceMode(いずれもeditor.getModeSnapshot()相当),
//     scrollTop, scrollLeft }
// 「いま画面に出ている」内容(doc・選択・スクロール等)はアクティブタブの分だけ常にeditor側が
// 持っており、tabs配列側のeditorState/scrollTop等は「非アクティブになった時点のスナップショット」
// でしかない(タブ切替のたびsaveActiveTabSnapshotで同期する)。
let tabs = [];
let activeTabId = null;
let tabIdSeq = 1;
// 不具合4の修正: 「文書を開く」系の要求(applyFileOpened/applyNewDocumentLocal/applyOpenInTab)の
// 世代番号。これらはeditor.setFileMode(...)の完了をawaitしてから currentPath/doc/ステータス表示
// 等を書き換えるが、その待機中により新しい「開く」要求が届くと、後から解決した古い要求の
// 続きが新しい要求の結果を上書きしてしまう(ファイル名・パス・本文が古い方に巻き戻る)。
// 各関数は開始時にこれをインクリメントして自分の世代を取得し、awaitから戻った後に
// 「まだ自分が最新か」を確認してから状態を書き換える。
let fileOpenGen = 0;
// ドラッグ中のタブID(ドラッグ&ドロップ並べ替え用)。
let draggingTabId = null;
function makeTabGuid() {
  // crypto.randomUUID()はWebView2(Chromiumベース)・主要ブラウザいずれでも利用できるが、
  // 念のため未対応環境向けの簡易フォールバックを用意する(C#側はGuid.Parseできれば良いだけ
  // なので、ハイフン区切りの16進数であれば十分)。
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

// 日時の挿入(仕様書 第3章 N-14)・「.LOG」自動追記(N-15)で共通して使う書式。
// Windowsのメモ帳(日本語環境)に合わせ YYYY/MM/DD HH:mm とする。
function formatDateTimeStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// フォント名をCSSカスタムプロパティへ設定する(仕様書 C-08)。
// フォント名をそのまま素で入れると、Windowsの縦書き用フォント("@Yu Gothic"のように
// 先頭が@)や記号を含む名前でCSSとして不正になり、font-family全体が無効になって
// 何も反映されない。必ず引用符で囲み、中の " と \ をエスケープする。
// generic-family(sans-serif等)だけは引用符で囲むと意味が変わるためそのまま渡す。
const CSS_GENERIC_FONT_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
]);
function applyFontSetting(rootStyle, cssVar, rawName, label) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    rootStyle.removeProperty(cssVar);
    logToHost("log", `${label}: 未設定(テーマ既定に戻す)`);
    return;
  }
  const value = CSS_GENERIC_FONT_FAMILIES.has(name.toLowerCase())
    ? name
    : `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  rootStyle.setProperty(cssVar, value);
  logToHost("log", `${label}: ${value} を適用`);
}

// 本文の左右余白(仕様書 editorPaddingLeft/editorPaddingRight)用。数値として解釈できない
// (未設定・欠落)場合だけCSS変数を消して既定値(32px)に戻し、"0"は有効な値として
// そのまま反映する(不具合修正: 従来は数値が0以下かどうかで「未設定」を判定しており、
// 明示的に0を指定してもnullと区別できず既定の32pxのままになっていた)。
function applyEditorPaddingSetting(rootStyle, cssVar, rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    rootStyle.removeProperty(cssVar);
    return;
  }
  rootStyle.setProperty(cssVar, `${Math.max(0, value)}px`);
}

function setDirty(v) {
  isDirty = v;
  // 未保存であることはタイトルバー(C#側のUpdateTitle)とステータスバーの両方で示す。
  // タイトルバーはタスクバー上で幅が足りず削られることがあるため、常に見える
  // ステータスバー側にも出しておく。
  if (statusDirty) statusDirty.hidden = !v;
  bridge?.postMessage({ type: "dirty", value: v });
  // タブ形式(仕様書 第2.10節 C-14): アクティブタブの●インジケータ・C#側への通知も同期する。
  if (displayMode === "tab") {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab && tab.dirty !== v) {
      tab.dirty = v;
      renderTabs();
      notifyTabsChanged();
    }
  }
}
// 2つのdoc(CodeMirrorのText)が同じ内容かどうか。Textは長さが違えば即座にfalseを返すため
// 比較自体は比較的安価だが、1万行規模の文書で入力のたびに全比較するのは避けたいので、
// 呼び出し側(computeIsDirty)でまず参照そのものが同じでないか・長さが違わないかを見てから、
// 本当に必要な場合(長さが同じで中身を実際に見比べないと判定できない場合)だけTextのeq()に
// 委ねる。通常の1文字挿入・削除は長さが変わるため、ここでO(1)の判定になる。
function docsEqual(a, b) {
  if (a === b) return true; // 同一のTextインスタンス(未編集で参照が変わっていない)
  if (a.length !== b.length) return false;
  return a.eq(b);
}
// 現在の内容が「未保存かどうか」を、変更操作の有無ではなく内容そのものから判定する。
// metaDirty(文字コード・改行コードの明示変更)は本文の一致とは独立に常にdirty扱いにする。
// savedDocRefが無い(クラッシュリカバリ直後等)場合は、比較のしようが無いため常にdirty扱いにする。
function computeIsDirty() {
  if (metaDirty) return true;
  if (!savedDocRef) return true;
  return !docsEqual(editor.view.state.doc, savedDocRef);
}
// 内容変化のたびに呼ぶ。実際にdirtyの値が変わった時だけsetDirty()(DOM更新・C#側への
// postMessage・タブの●同期)を行うことで、dirty=trueのまま入力し続けている間の
// 無駄な通知(bridge.postMessage)の連打を避ける。
function refreshDirty() {
  const next = computeIsDirty();
  if (next !== isDirty) setDirty(next);
}
// 現在の内容を「保存済み/読み込み済みの基準」として確定する。ファイルを開く・保存する・
// 名前を付けて保存する・新規文書を作る・外部変更を再読み込みする、の各経路の最後に
// 必ず呼ぶこと(取りこぼすと「保存したのに未保存のままになる」等の不具合になる)。
// クラッシュリカバリからの復元(仕様書 N-06)は例外で、復元直後から意図的にdirty扱いに
// したいためこれを呼ばない(savedDocRefをnullのままにし、常にcomputeIsDirty()===trueにする)。
function markSaved() {
  savedDocRef = editor.view.state.doc;
  metaDirty = false;
}
function setName(name) {
  currentName = name;
}
// ---- ステータスバーの幅対応(実機で確認された不具合の修正) ----
// ウィンドウ幅を狭めると各項目が縮んでテキストが1〜2文字ずつ折り返し、height:24pxを
// 超えて縦に伸び、本文エリアに被ってしまう。index.html側でnowrap+flex:noneにして
// 「折り返んで縦に伸びる」こと自体は止めたが、それだけだと合計幅がstatusbarをはみ出す
// だけなので、収まりきらない分はVSCode/Typoraに倣い優先度の低い項目から順に
// 「ラベルを落とした短縮表示」→「非表示」の2段階で畳んでいく。サイドバー切替・編集モード・
// 未保存表示・設定ボタンはこの対象に含めない(狭くても「いま何が起きているか」と
// 「操作の入口」を失わせたくないため常に残す)。
const STATUS_FIT_ELS = {
  zoom: statusZoom,
  encoding: statusEncoding,
  lineEnding: statusLineEnding,
  wrap: statusWrapBtn,
  count: statusCount,
  position: statusPosition,
};
// 各項目のコンパクト表示(ラベルを落とした短い形)を、フルの文字列(既存のupdateXXX関数が
// これまで通り組み立てる)から作る関数。ユーザー指定の畳む順序(STATUS_FIT_STAGES参照)では
// 「コンパクト」段階を経由するのは文字コード・改行コードの2項目だけ(他の項目はfullから
// 直接hiddenへ畳む)なので、この2つだけを持つ。
const STATUS_FIT_COMPACT = {
  encoding: (full) => full.replace(/^文字コード: /, ""), // 「文字コード: UTF-8」→「UTF-8」
  lineEnding: (full) => full.replace(/^改行コード: /, ""), // 「改行コード: LF」→「LF」
};
// 幅が狭くなるにつれて畳んでいく順序(ユーザー指定)。各段階が前の段階を上書きする形で
// 積み上がっていく(statusFitModeAtが「level未満の段階を先頭から順に見て、同じkeyなら
// 後の段階のmodeで上書きする」実装のため、同じkeyを離れた位置に複数回書いてよい)。
//   1. 改行コードのラベル「改行コード: 」を省略(値のLF/CRLF等はまだ残す)
//   2. 文字コードのラベル「文字コード: 」を省略(値のUTF-8等はまだ残す)
//   3. 拡大率(100%)を非表示
//   4. 行・列(行 1, 列 1)を非表示
//   5. 文字数(0文字)を非表示
//   6以降はユーザー指定が無く、判断を委ねられた分: 折り返し→改行コード(値ごと非表示)→
//      文字コード(値ごと非表示)の順にした。折り返しは他の項目よりアイコン化されていて
//      場所を取らない一方、改行コード・文字コードは「値だけ」でもまだ場所を取るため、
//      折り返しを先に落としてから最後に改行コード・文字コードを完全に消す方が、
//      収まりが良くなる段階を細かく刻めると判断したため。
// モード表示(Markdown等)・未保存インジケータ(●)・サイドバー切替ボタンはこの配列に
// 含めない(=常に表示。「いま何を編集していて保存済みか」は幅が無くても必要な情報のため)。
// 以前はSTATUS_FIT_ORDER.flatMap()で「全項目のcompactを先にやってから全項目のhidden」
// という順序しか作れなかったため、要望の「項目ごとに畳む順序を指定する」を表現できるよう
// 明示的な配列に書き換えた。
const STATUS_FIT_STAGES = [
  { key: "lineEnding", mode: "compact" },
  { key: "encoding", mode: "compact" },
  { key: "zoom", mode: "hidden" },
  { key: "position", mode: "hidden" },
  { key: "count", mode: "hidden" },
  { key: "wrap", mode: "hidden" },
  { key: "lineEnding", mode: "hidden" },
  { key: "encoding", mode: "hidden" },
];
// fitStatusBar()の描画対象キー一覧(順序は描画結果に影響しない。各項目は独立に
// renderStatusFitItemされる。畳む順序自体はSTATUS_FIT_STAGES側で決まる)。
const STATUS_FIT_KEYS = Object.keys(STATUS_FIT_ELS);
let statusFitLevel = 0;
const statusFitFullText = {};

function statusFitModeAt(key, level) {
  let mode = "full";
  for (let i = 0; i < level && i < STATUS_FIT_STAGES.length; i++) {
    if (STATUS_FIT_STAGES[i].key === key) mode = STATUS_FIT_STAGES[i].mode;
  }
  return mode;
}
function renderStatusFitItem(key) {
  const el = STATUS_FIT_ELS[key];
  const full = statusFitFullText[key] ?? "";
  // 文字数(count)は「表示するかどうか」自体を設定(showWordCount)が別に持っている。
  // fit機構のhidden判定と衝突しないよう、まずそちらを優先する。
  if (key === "count" && !showWordCount) { el.hidden = true; return; }
  const mode = statusFitModeAt(key, statusFitLevel);
  if (mode === "hidden") { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = mode === "compact" ? STATUS_FIT_COMPACT[key](full) : full;
}
function applyStatusFitLevel(level) {
  statusFitLevel = level;
  for (const key of STATUS_FIT_KEYS) renderStatusFitItem(key);
}
// 現在のstatusbarの幅に収まるレベルを探して適用する。子要素はすべてwhite-space:nowrap+
// flex:noneのため、収まらないぶんは折り返さずscrollWidthへそのまま反映される
// (clientWidthとの比較だけで「はみ出しているか」を判定できる)。
function fitStatusBar() {
  let level = 0;
  applyStatusFitLevel(level);
  while (level < STATUS_FIT_STAGES.length && statusbarEl.scrollWidth > statusbarEl.clientWidth) {
    level++;
    applyStatusFitLevel(level);
  }
}
// keyの項目に「本来表示したいフルの文字列」を渡す。既存の各updateXXX関数の最後から呼ぶ
// ことで、値自体はこれまで通り計算しつつ、実際にDOMへ書き込む内容は現在の幅に収まる
// レベルに応じて出し分ける。
function setStatusFitText(key, fullText) {
  statusFitFullText[key] = fullText;
  fitStatusBar();
}
// 幅の変化(ウィンドウリサイズ・サイドバー開閉等、statusbar自身が使える幅が変わりうる
// あらゆる操作)を監視し、その都度収まるレベルへ再計算する。
new ResizeObserver(() => fitStatusBar()).observe(statusbarEl);

// 文字数(仕様書 W-01/W-03)。ステータスバーは軽い集計に留める(doc.lengthと選択範囲の
// from/to差だけ、いずれもO(1))。単語数・段落数等の重い集計はポップアップを開いた時にだけ行う。
function updateCount() {
  if (!showWordCount) { setStatusFitText("count", ""); return; }
  const total = editor.getDocLength();
  const selLen = editor.getSelectionLength();
  setStatusFitText("count", selLen > 0 ? `${total}文字(選択 ${selLen}文字)` : `${total}文字`);
  applyTooltip(statusCount, tooltipLevel, { state: statusCount.textContent });
}
// 行/列(仕様書 N-03)。カーソル位置から直接取れる軽量な情報なので、選択変更のたびに呼んでよい。
function updatePosition() {
  const { line, col } = editor.getCursorInfo();
  setStatusFitText("position", `行 ${line}, 列 ${col}`);
  applyTooltip(statusPosition, tooltipLevel, { state: statusPosition.textContent });
}
// ズーム率(仕様書 N-03)。既定サイズに対する本文フォントサイズの比率を表示する。
function updateZoom() {
  setStatusFitText("zoom", `${Math.round((editor.getFontSize() / DEFAULT_FONT_SIZE) * 100)}%`);
  applyTooltip(statusZoom, tooltipLevel, { state: statusZoom.textContent });
}
function updateWordCountVisibility() {
  // showWordCountの新しい値を見てhidden状態を更新し、表示/非表示の切り替えで空いた
  // (または埋まった)幅ぶんを再計算する。
  fitStatusBar();
  if (!showWordCount) wordCountPopup.close();
}
// カスタムCSS(仕様書 第2.10節 C-07)。<head>内に専用<style id="custom-css">を用意し、
// textContentとして反映する(信頼できないHTMLとして解釈されないようinnerHTMLは使わない)。
let customCssEl = null;
function applyCustomCss(css) {
  if (!customCssEl) {
    customCssEl = document.getElementById("custom-css");
    if (!customCssEl) {
      customCssEl = document.createElement("style");
      customCssEl.id = "custom-css";
      document.head.appendChild(customCssEl);
    }
  }
  customCssEl.textContent = css || "";
}

// ---- タイトルバーの配色を本文エリアに合わせる(ユーザー要望) ----
// ネイティブのタイトルバーはWinForms側(Pane/WindowChrome.cs)がDWMのAPIで塗るため、
// 「いまHTML側で実際に描画されている色」をJSから教えてやる必要がある。テーマ切替・
// テーマプリセット・カスタムCSSのどれで色が変わっても、CSS変数の定義を読むのではなく
// getComputedStyleで実際の描画色を読むことで、どの経路の変更にも同じ仕組みで追従できる。
// 受け口はPane/MainForm.csの case "titlebar-color"。
function rgbToHex(value) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value || "");
  if (!m) return null;
  const hex = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}
// 候補セレクタを順に見て、最初に「実際に塗られている」色を返す。
// 透明(rgba(0,0,0,0) / transparent)は「その要素では塗っていない」という意味のため次の候補へ送る。
function readPaintedColor(selectors, prop) {
  for (const sel of selectors) {
    const el = sel === "body" ? document.body : document.querySelector(sel);
    if (!el) continue;
    const value = getComputedStyle(el)[prop];
    if (!value || value === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(value)) continue;
    const hex = rgbToHex(value);
    if (hex) return hex;
  }
  return null;
}
// テーマプリセット(themes.css)が--titlebar-bg/--titlebar-fgを明示的に定義していれば、
// それを読む(ユーザー要望: タイトルバーだけ本文と別の色にしたい)。style.css側では
// この2つを定義しておらず、未指定のCSS変数のgetPropertyValueは空文字列を返すため、
// 「定義されているかどうか」をそのまま判定に使える。値がrgb()形式でもHEX直書きでも
// 両方送れるよう、rgb()ならHEXへ正規化し、それ以外(#RRGGBB等)はそのまま使う。
function readTitleBarOverride(varName) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return null;
  return rgbToHex(raw) ?? raw;
}
// 実バグ2の安全策: 背景・文字色のコントラスト比(WCAG方式)を計算する。タイトルバーが
// 読めなくなるのは致命的なので、値がおかしいときに素通りさせない仕組みとして使う。
function relativeLuminance(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || "");
  if (!m) return null;
  const chan = (h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(m[1]) + 0.7152 * chan(m[2]) + 0.0722 * chan(m[3]);
}
function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  if (lA === null || lB === null) return null;
  const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}
const TITLEBAR_MIN_CONTRAST = 4.5; // WCAG AA(通常テキスト)相当
let titleBarSyncTimer = null;
function syncTitleBarColor() {
  if (!bridge) return;
  clearTimeout(titleBarSyncTimer);
  // 【実バグ1・2の教訓】WebView2が非表示(Visible=false)の間はブラウザの描画パイプラインが
  // 止まっており、body要素のCSSトランジション(style.css: transition: background .2s,
  // color .2s)も実時間どおりには進行しない。従来はここで「トランジション時間ぶん待って
  // から読む」実装だったため、非表示中に読むと「遷移前(=一つ前のテーマ)の色のまま」の
  // getComputedStyleを拾ってしまうことがあった(実機バグ2: nightテーマなのに
  // foregroundがライト既定の#1F2428のまま送られた不具合)。
  // document.hidden(=WebView2非表示)の間はどのみち誰にも見えていないため、遷移を
  // 律儀に待つ意味が無い。bodyのtransitionを一時的に無効化し、強制リフローで
  // スタイルを即時確定させてから読む(読み終えたら即座に元へ戻すため、後で可視化
  // されたときの通常のテーマ切替アニメーションには影響しない)。
  // 可視状態(通常の設定変更・テーマ切替ボタン)では、この間だけの見た目のフェードを
  // 損なわないよう、従来どおり遷移完了を待ってから読む。
  if (document.hidden) {
    const prevTransition = document.body.style.transition;
    document.body.style.transition = "none";
    void document.body.offsetHeight; // 強制リフロー
    sendTitleBarColors();
    document.body.style.transition = prevTransition;
    return;
  }
  const durations = getComputedStyle(document.body).transitionDuration || "0s";
  const maxSeconds = durations.split(",").reduce((max, s) => Math.max(max, parseFloat(s) || 0), 0);
  titleBarSyncTimer = setTimeout(sendTitleBarColors, Math.round(maxSeconds * 1000) + 60);
}
function sendTitleBarColors() {
  // --titlebar-bg/--titlebar-fgが定義されていれば最優先で使う(9テーマすべてに
  // 実バグ2の修正で明示済み。CSS変数の直接参照なのでトランジションの影響を受けず、
  // 非表示中でも常に最終値が読める)。未定義(カスタムCSSでの独自上書き等)の場合のみ、
  // 従来どおり本文エリアの実描画色にフォールバックする。
  let background = readTitleBarOverride("--titlebar-bg") ?? readPaintedColor([".cm-editor", "#cm-host", "body"], "backgroundColor");
  let foreground = readTitleBarOverride("--titlebar-fg") ?? readPaintedColor([".cm-content", ".cm-editor", "body"], "color");
  if (!background && !foreground) return;
  // 安全策: コントラスト比が低すぎる(=文字が読めなくなる)組み合わせは、そのまま
  // C#側へ送らず、白/黒のうちコントラストが高い方へ文字色を補正する。背景色自体は
  // テーマの意図した色なので変えない。
  if (background && foreground) {
    const ratio = contrastRatio(background, foreground);
    if (ratio !== null && ratio < TITLEBAR_MIN_CONTRAST) {
      const bgLum = relativeLuminance(background);
      const corrected = bgLum !== null && bgLum > 0.5 ? "#000000" : "#FFFFFF";
      logToHost("error",
        `titlebar-color: コントラスト比が低すぎるため文字色を補正(background=${background}, foreground=${foreground}, 比=${ratio.toFixed(2)} → ${corrected}へ補正)`);
      foreground = corrected;
    }
  }
  console.log(`[titlebar] タイトルバーへ反映: background=${background}, foreground=${foreground}`);
  bridge.postMessage({ type: "titlebar-color", background, foreground });
}

function updateStatusMeta() {
  setStatusFitText("encoding", currentEncoding ? `文字コード: ${currentEncoding}` : "");
  setStatusFitText("lineEnding", currentLineEnding ? `改行コード: ${currentLineEnding}` : "");
  applyTooltip(statusEncoding, tooltipLevel, { state: currentEncoding });
  applyTooltip(statusLineEnding, tooltipLevel, { state: currentLineEnding });
}
// 文字コード・改行コードの選択肢(仕様書 第6.1/6.2節)。Pane/TextFileService.csの
// EncodingLabel/LineEndingLabelが返すラベル文字列とそのまま揃える(ParseEncodingLabel/
// ParseLineEndingLabelで逆変換できるようにするため)。
const ENCODING_OPTIONS = ["UTF-8", "UTF-8 (BOM付き)", "UTF-16 LE", "UTF-16 BE", "Shift_JIS"];
const LINE_ENDING_OPTIONS = ["CRLF", "LF", "CR"];

// ステータスバーから文字コード・改行コードを明示的に変更する(仕様書6.1「変更：ステータスバー
// から明示的に変更でき、その場合のみ再エンコードする」)。ここでは currentEncoding/
// currentLineEnding とタブの表示だけを更新し、ファイルへは一切書き込まない
// (未保存の変更として扱い、次回保存時にC#側がその文字コード・改行コードで書き出す。
// HandleSaveRequestは_currentEncoding/_currentLineEndingを使うため、set-encoding/
// set-line-endingメッセージでその場で更新しておけば保存時に自動的に反映される)。
// 改行コード「混在」からの統一操作(仕様書6.2)もこの経路がそのまま実現する: 読み込み時に
// C#側が本文を\nへ正規化済み(TextFileService.NormalizeToLf)なので、エディタの内容自体を
// 書き換える必要はなく、保存時に使う改行コードのラベルを差し替えるだけで全体が
// その改行コードへ統一される。
function setEncoding(label) {
  if (currentEncoding === label) return;
  currentEncoding = label;
  encodingSetExplicitly = true; // 明示操作を優先し、以後は設定変更(apply-settings)での自動追従を止める
  const tab = activeTab(); // タブ形式(displayMode==="tab")のときは表示中のタブにも書き戻す
  if (tab) tab.encoding = label; // (次のnotifyTabsChangedで古い値に巻き戻らないようにするため)
  updateStatusMeta();
  // 本文は変わらないが保存すると別の内容(別のバイト列)になるため、内容の一致とは
  // 独立してdirty扱いにする(metaDirty。computeIsDirty参照)。
  metaDirty = true;
  refreshDirty();
  bridge?.postMessage({ type: "set-encoding", encoding: label });
}
function setLineEnding(label) {
  if (currentLineEnding === label) return;
  currentLineEnding = label;
  lineEndingSetExplicitly = true; // 同上
  const tab = activeTab();
  if (tab) tab.lineEnding = label;
  updateStatusMeta();
  // 同上(setEncoding参照): 本文は変わらないが保存内容は変わるためmetaDirtyを立てる。
  metaDirty = true;
  refreshDirty();
  bridge?.postMessage({ type: "set-line-ending", lineEnding: label });
}
function buildEncodingMenuTree() {
  return ENCODING_OPTIONS.map((label) => ({ label, checked: currentEncoding === label, run: () => setEncoding(label) }));
}
function buildLineEndingMenuTree() {
  // 「混在」はcurrentLineEndingがそのまま入っているだけの状態(選択肢には含めない)なので、
  // どの項目にもcheckedは付かない。ここで何かを選ぶと仕様書6.2の「統一操作」になる。
  return LINE_ENDING_OPTIONS.map((label) => ({ label, checked: currentLineEnding === label, run: () => setLineEnding(label) }));
}
const MODE_LABELS = { markdown: "Markdown", code: "コード", plain: "プレーンテキスト" };
// モード表示ラベル(仕様書 第1章の拡張): コードモードのときは言語名も添える(例: "コード (Python)")。
function modeLabel(mode, language) {
  if (mode === "code" && language) return `コード (${LANGUAGE_LABELS[language] ?? language})`;
  return MODE_LABELS[mode] ?? mode;
}
function updateStatusMode() {
  const mode = editor.getMode();
  statusMode.textContent = modeLabel(mode, editor.getCodeLanguage());
  applyTooltip(statusMode, tooltipLevel, { state: statusMode.textContent });
  host.classList.toggle("mode-code", mode === "code");
  // 仕様書 第10.3節「本文の最大幅」はMarkdownモードのときだけ適用する(style.css側が
  // この属性で出し分ける)。コードモード・プレーンテキストモードで幅を制限すると横に長い
  // コード行やログが折り返されて読みにくくなるため、意図的に対象外にする(親側の判断)。
  document.documentElement.setAttribute("data-editor-mode", mode);
}

// ---- 自動判定の通知バナー(仕様書 第1章の拡張)。モーダルにせず、ステータスバー付近に
// 浮かべるだけの非侵襲的な表示にする。「切り替えた」通知は8秒程度で自動的に消えるが、
// 「提案」は(取りこぼさないよう)ユーザーが閉じる/選ぶまで残す。----
let adBannerHideTimer = null;
function hideAdBanner() {
  if (adBannerHideTimer) { clearTimeout(adBannerHideTimer); adBannerHideTimer = null; }
  adBanner.hidden = true;
  adBannerAction.hidden = true;
  adBannerAction.onclick = null;
}
function showAdBanner(text, { actionLabel, onAction, autoHideMs } = {}) {
  hideAdBanner();
  adBannerText.textContent = text;
  if (actionLabel) {
    adBannerAction.hidden = false;
    adBannerAction.textContent = actionLabel;
    adBannerAction.onclick = () => { hideAdBanner(); onAction?.(); };
  }
  adBanner.hidden = false;
  if (autoHideMs) adBannerHideTimer = setTimeout(hideAdBanner, autoHideMs);
}
adBannerClose.addEventListener("click", hideAdBanner);

// ---- 内容からの編集モード自動判定(仕様書 第1章の拡張)の適用ロジック ----
// 実際にモード/言語を切り替える(自動切り替え・提案の「切り替える」どちらからも呼ばれる)。
async function performAutoDetectSwitch(result) {
  if (result.mode === "code") await editor.setCodeLanguage(result.language);
  else await editor.setFileMode(currentPath ?? currentName, result.mode);
  updateStatusMode();
}
// 切り替え前の状態(prevMode/prevLanguage)を覚えておき、「元に戻す」で復元する。
function applyAutoDetectSwitch(result, prevMode, prevLanguage) {
  performAutoDetectSwitch(result);
  autoDetectState.suggested = true; // 直接切り替えた場合も、以後の重複提案は不要
  showAdBanner(`自動判定: ${modeLabel(result.mode, result.language)} に切り替えました`, {
    actionLabel: "元に戻す",
    autoHideMs: 8000,
    onAction: () => {
      performAutoDetectSwitch({ mode: prevMode, language: prevLanguage });
      // 「元に戻す」を押した文書には、以後この判定エンジンを一切働かせない(仕様書の指示)。
      autoDetectState.locked = true;
    },
  });
}
// 提案のみ表示する(切り替えない)。同じ文書には1回だけ。
function suggestAutoDetect(result) {
  if (autoDetectState.suggested) return;
  autoDetectState.suggested = true;
  const prevMode = editor.getMode();
  const prevLanguage = editor.getCodeLanguage();
  showAdBanner(`${modeLabel(result.mode, result.language)} として表示しますか?`, {
    actionLabel: "切り替える",
    onAction: () => applyAutoDetectSwitch(result, prevMode, prevLanguage),
  });
}
// 判定を実際に走らせて、autoDetectModeに応じて適用/提案/何もしないを振り分ける。
// 呼び出しはペースト直後・入力停止1.5秒後の2箇所のみ(仕様: 入力のたびには走らせない)。
function runAutoDetect() {
  if (autoDetectMode === "off" || autoDetectState.locked) return;
  const result = detectContentMode(editor.getValue());
  if (result.confidence < AUTO_DETECT_CONFIDENCE_MIN) return;
  if (result.mode === "plain") return; // plainへの自動遷移(切り替え・提案とも)は行わない
  if (result.mode === "code" && !result.language) return; // 言語不明なコード判定は適用しない

  const currentDocMode = editor.getMode();
  const currentDocLanguage = editor.getCodeLanguage();
  const alreadyApplied = result.mode === currentDocMode &&
    (result.mode !== "code" || result.language === currentDocLanguage);
  if (alreadyApplied) return; // 既に同じ表示なら切り替え・提案とも不要

  const isUntitled = !currentPath;
  if (isUntitled) {
    if (autoDetectMode === "suggest") { suggestAutoDetect(result); return; }
    applyAutoDetectSwitch(result, currentDocMode, currentDocLanguage); // standard / aggressive
    return;
  }
  // 拡張子のある(名前が付いた)文書: standardは何もしない。suggest/aggressiveは提案のみ。
  if (autoDetectMode === "standard") return;
  suggestAutoDetect(result);
}
function scheduleAutoDetectIdle() {
  if (idleDetectTimer) clearTimeout(idleDetectTimer);
  idleDetectTimer = setTimeout(() => { idleDetectTimer = null; runAutoDetect(); }, AUTO_DETECT_IDLE_MS);
}

// ---- コードモードで言語未設定のときの自動言語判定(実機報告の改善②) ----
// 「表示メニュー→コードモード」で手動切替すると、setMode()がautoDetectState.lockedを立てて
// 以後の内容からの自動判定(モードそのものの切り替え、上のrunAutoDetect)を止める。しかし
// これは「Markdown/コード/プレーンというモード自体はもう変えない」という意味であり、
// 「コードモードの中でどの言語として色付けするか」という、この関数が扱う話とは別物のため、
// ここではautoDetectState.locked/autoDetectMode設定のどちらも見ずに独立して動く
// (依頼: 手動切替でロックが立った直後でも、言語未設定ならその場で判定して設定する)。
//
// 「言語が決まったら、あるいはユーザーが言語ピッカーで明示的に選んだら、以後は再判定しない」
// は、editor.getCodeLanguage()が非nullになった時点でこの関数自体の入り口(下のguard節)が
// 素通りしなくなることで自然に実現される(専用のフラグを別途持つ必要が無い)。
async function maybeAutoDetectCodeLanguage() {
  if (editor.getMode() !== "code" || editor.getCodeLanguage()) return false; // コードモードかつ言語未設定の時だけ
  const result = detectCodeLanguage(editor.getValue());
  // 確信が持てない内容では言語を設定しない(誤判定による変な色付けを避ける。既存の
  // AUTO_DETECT_CONFIDENCE_MIN=0.55をそのまま流用し、判定機構全体で確度の基準を揃える)。
  if (!result.language || result.confidence < AUTO_DETECT_CONFIDENCE_MIN) return false;
  await editor.setCodeLanguage(result.language);
  return true;
}
// 言語未設定のコードモードで入力が続いている間、内容が変わるたびに再判定を続けるための
// デバウンス。新規文書のように最初は判定できなくても、書き進めるうちに判定できるように
// なるケースに対応する(依頼の確認項目)。runAutoDetectのidleDetectTimerとは別の独立した
// タイマーにする(1.5秒間隔・呼び出しタイミングの考え方はAUTO_DETECT_IDLE_MSを共有しつつ、
// on/offの条件・対象が完全に別物のため混ぜない)。
let codeLanguageIdleTimer = null;
function scheduleCodeLanguageIdle() {
  if (editor.getMode() !== "code" || editor.getCodeLanguage()) return; // 対象外ならタイマーも張らない
  if (codeLanguageIdleTimer) clearTimeout(codeLanguageIdleTimer);
  codeLanguageIdleTimer = setTimeout(() => {
    codeLanguageIdleTimer = null;
    maybeAutoDetectCodeLanguage().then((changed) => { if (changed) updateStatusMode(); });
  }, AUTO_DETECT_IDLE_MS);
}

// ---- 言語ピッカー(仕様書 第1章の拡張): #status-mode クリックでコードモードの言語を
// 選び直す。既存のコマンドパレット/クイックオープンと同じ.palette-overlayの仕組みを流用する。
let langPickerOverlay = null;
function closeLanguagePicker() { langPickerOverlay?.remove(); langPickerOverlay = null; }
// onChoose(languageId)を渡すと、選択時にコードモード全体の言語切替(既定の挙動)ではなく
// そちらを呼ぶ(右クリックメニュー「コードブロックの中」→「言語を選択…」、
// docs/コンテキストメニュー仕様.md 第2.6節が、コードモード全体ではなくフェンス1個の
// 情報文字列だけを書き換えたいために一覧UIだけを再利用する)。
function openLanguagePicker(onChoose) {
  if (langPickerOverlay) { closeLanguagePicker(); return; } // 開いている状態での再呼び出しはトグルで閉じる
  const items = codeLanguages
    .map((d) => ({ id: d.name, label: LANGUAGE_LABELS[d.name] ?? d.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "ja"));

  langPickerOverlay = document.createElement("div");
  langPickerOverlay.className = "palette-overlay";
  langPickerOverlay.innerHTML = '<div class="palette"><input id="palette-input" placeholder="言語を検索…" autocomplete="off"><ul id="palette-list"></ul></div>';
  document.body.appendChild(langPickerOverlay);
  const input = langPickerOverlay.querySelector("#palette-input");
  const list = langPickerOverlay.querySelector("#palette-list");
  langPickerOverlay.addEventListener("mousedown", (e) => { if (e.target === langPickerOverlay) closeLanguagePicker(); });

  let filtered = items;
  let sel = 0;
  function choose(item) {
    closeLanguagePicker();
    if (onChoose) { onChoose(item.id); return; }
    editor.setCodeLanguage(item.id).then(updateStatusMode);
    // 手動での言語選択(仕様書 第1章の拡張): 以後この文書には自動判定を行わない。
    autoDetectState.locked = true;
  }
  function render() {
    list.innerHTML = "";
    filtered.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = i === sel ? "sel" : "";
      li.textContent = item.label;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(item); });
      list.appendChild(li);
    });
  }
  function filter() {
    const q = input.value.trim().toLowerCase();
    filtered = !q ? items : items.filter((it) => it.label.toLowerCase().includes(q) || it.id.includes(q));
    sel = 0;
    render();
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeLanguagePicker(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); render(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); render(); return; }
    if (e.key === "Enter") { e.preventDefault(); const it = filtered[sel]; if (it) choose(it); return; }
  });
  input.addEventListener("input", filter);
  filter();
  input.focus();
}
statusMode.addEventListener("click", () => {
  if (editor.getMode() === "code") openLanguagePicker();
});
function updateWrapButton() {
  setStatusFitText("wrap", wordWrapOn ? "折り返し: あり" : "折り返し: なし");
  applyTooltip(statusWrapBtn, tooltipLevel, { state: wordWrapOn ? "折り返しあり" : "折り返しなし" });
}
function pushClosedFile(path) {
  if (!path) return;
  closedFiles.push(path);
  if (closedFiles.length > CLOSED_FILES_CAP) closedFiles.shift();
}
function setReadOnly(readOnly) {
  editor.setEditable(!readOnly);
  isReadOnly = !!readOnly;
}

// PDF/PNG/印刷では、メニューバー等のUI chromeを除外し、CodeMirrorの仮想化
// (画面内のvisibleRangesしかDOMに描画しない最適化)を一時的に解除して文書全体を
// レイアウトへ展開する(仕様書 File項目「エクスポート」「印刷」: 現在の画面だけでなく
// 文書全体が出力対象になるようにする)。CodeMirrorはスクロール領域の実測サイズを基に
// 描画範囲を決めるため、#cm-hostの高さを文書全体の高さまで広げるとCM側が自動的に
// 全行を描画する。
// ヘッダー・フッター文字列(exportHeaderText/exportFooterText)の置換文字列展開(仕様書)。
// {title} {date} {time} {path} はここでその場の値に展開する。{page} {pages}(ページ番号・総数)は
// 文書全体を印刷し終えるまで確定しないため展開せず、そのままC#側(MainForm)へ渡し、
// CSSのcounter(page)/counter(pages)を使って1ページごとに解決させる。
function expandHeaderFooterTemplate(template, fm) {
  if (!template) return "";
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const title = fm?.title ?? currentName;
  return template
    .split("{title}").join(title)
    .split("{date}").join(dateStr)
    .split("{time}").join(timeStr)
    .split("{path}").join(currentPath ?? "");
}
// エクスポート/PDF印刷のページ設定一式を組み立てる(仕様書「エクスポート・印刷」節)。
// exportReadYamlFrontMatterで読んだFront Matterの値(fm)があればexportSettingsより優先する。
function buildExportPageOptions(fm) {
  return {
    paperSize: fm.pageSize ?? exportSettings.exportPaperSize,
    orientation: fm.pageOrientation ?? exportSettings.exportOrientation,
    customWidthMm: fm.pageWidthMm ?? exportSettings.exportCustomWidthMm,
    customHeightMm: fm.pageHeightMm ?? exportSettings.exportCustomHeightMm,
    marginTopMm: fm.marginTopMm ?? exportSettings.exportMarginTopMm,
    marginBottomMm: fm.marginBottomMm ?? exportSettings.exportMarginBottomMm,
    marginLeftMm: fm.marginLeftMm ?? exportSettings.exportMarginLeftMm,
    marginRightMm: fm.marginRightMm ?? exportSettings.exportMarginRightMm,
    headerTemplate: expandHeaderFooterTemplate(fm.header ?? exportSettings.exportHeaderText, fm),
    footerTemplate: expandHeaderFooterTemplate(fm.footer ?? exportSettings.exportFooterText, fm),
    exportDefaultFolder: exportSettings.exportDefaultFolder,
    exportCustomFolder: exportSettings.exportCustomFolder,
    exportAfter: exportSettings.exportAfter,
    exportShowSaveDialog: exportSettings.exportShowSaveDialog,
  };
}
function enterExportLayout() {
  document.body.classList.add("export-layout");
  const h = Math.ceil(editor.view.contentHeight) + 40;
  host.style.height = h + "px";
  editor.view.requestMeasure();
  return h;
}
function exitExportLayout() {
  document.body.classList.remove("export-layout");
  host.style.height = "";
  editor.view.requestMeasure();
}
// 印刷ダイアログ(Ctrl+Alt+P)・PDFエクスポートはいずれもWebView2の印刷パイプラインを
// 経由するため、標準のbeforeprint/afterprintイベントで展開・復元のタイミングを取れる
// (C#側からの完了通知を待つ必要が無い)。
window.addEventListener("beforeprint", enterExportLayout);
window.addEventListener("afterprint", exitExportLayout);

const editor = createEditor(host, {
  onChange() {
    // 実機不具合の修正: 以前はここで無条件にsetDirty(true)していたため、入力してから
    // Ctrl+Z等で元の内容にぴったり戻しても「未保存」表示が残ったままだった。
    // 内容が保存/読み込み時の基準と一致しているかどうかで判定し直す(computeIsDirty参照)。
    refreshDirty();
    // サイドバー(アウトラインパネル)の更新はsidebar.js側で300msデバウンスし、
    // かつ閉じている間・アウトライン以外を見ている間は再計算しない(性能要件)。
    sidebar.refresh();
    // 内容からの編集モード自動判定(仕様書 第1章の拡張)。ファイルを開く等プログラムによる
    // 内容差し替えでは走らせない(suppressNextAutoDetectChange)。判定を走らせるのは
    // ペースト直後(貼り付け文字数が閾値以上)と入力停止1.5秒後の2箇所だけ。
    if (suppressNextAutoDetectChange) {
      suppressNextAutoDetectChange = false;
      lastPasteLength = 0;
      return;
    }
    const pastedChars = lastPasteLength;
    lastPasteLength = 0;
    if (pastedChars >= AUTO_DETECT_PASTE_MIN_CHARS) runAutoDetect();
    else scheduleAutoDetectIdle();
    // 改善②: 言語未設定のコードモードである間、内容が変わるたびに言語の再判定を続ける
    // (scheduleCodeLanguageIdle自身が対象外なら何もしないので、ここでは無条件に呼んでよい)。
    scheduleCodeLanguageIdle();
  },
  // 文字数・行列表示(仕様書 N-03、W-01)。doc変化・カーソル移動のどちらでも軽い集計だけ
  // 行う(重い単語数・段落数集計はW-02のポップアップを開いた時にだけ行う。性能要件)。
  onSelectionChange() {
    updateCount();
    updatePosition();
  },
  // スマートペースト(仕様書 第2.9.3節): クリップボードにHTMLがあればMarkdownへ変換して挿入する。
  // プレーンテキストのみの場合は既定の貼り付け(CM6の処理)に任せる。
  // 併せて貼り付け文字数を記録する(内容からの編集モード自動判定のトリガーに使う。上のonChange参照)。
  onPaste: (e) => {
    const html = e.clipboardData?.getData("text/html");
    const plain = e.clipboardData?.getData("text/plain") || "";
    const imageFile = findClipboardImage(e.clipboardData);
    // クリップボードに画像の実体があり、かつHTML側に文章が無い(実質<img>だけ)場合は、
    // HTMLより画像を優先する。ブラウザで画像を右クリックして「画像をコピー」すると、
    // 画像のバイト列と一緒に <img src="https://..."> というHTMLも載る。HTMLを先に見ると
    // URL参照のMarkdownになってしまい、せっかく手元にある画像の実体が捨てられて
    // オフラインでは表示できなくなる。ここで画像を優先することで、外部へ一切接続せずに
    // ローカルへ保存できる(Webページの文章と画像をまとめてコピーした場合はHTMLに文章が
    // あるため、従来どおりMarkdownへの変換に回る)。
    if (imageFile && !htmlHasText(html)) {
      insertImageFile(imageFile);
      return true;
    }
    if (html) {
      const md = htmlToMarkdown(html).trim();
      if (md) {
        lastPasteLength = md.length;
        editor.pasteText(md);
        return true;
      }
    }
    // HTMLが無い(または変換結果が空)場合。プレーンテキストより画像を優先する
    // (画像をコピーしたときにファイル名だけが貼られる、という取りこぼしを防ぐ)。
    // 仕様書 docs/設定項目一覧.md「画像」節: クリップボードからの貼り付けも画像挿入の経路の1つ。
    if (imageFile) {
      insertImageFile(imageFile);
      return true;
    }
    lastPasteLength = plain.length;
    return false;
  },
  // 既定のコピー形式(仕様書 第2.9.3節、設定でHTML同時コピーに切替可能)
  onCopy: (e) => {
    if (defaultCopyFormat !== "html") return false;
    const sel = editor.view.state.selection.main;
    if (sel.from === sel.to) return false;
    const md = editor.getMarkdownForClipboard();
    const html = editor.getHtmlForClipboard();
    e.clipboardData.setData("text/plain", md);
    e.clipboardData.setData("text/html", html);
    return true;
  },
});
// CodeMirrorのEditorView生成が終わった時点。ここまでが「エディタ本体の組み立て」。
markStartup("エディタ生成");
updateCount();
updatePosition();
updateStatusMeta();
updateStatusMode();
updateWrapButton();
updateZoom();

const searchUI = createSearchUI(editor, host);
// 文字数カウントの詳細ポップアップ(仕様書 W-02)。editorが必要なためここで生成する。
const wordCountPopup = createWordCountPopup(editor, document.body);

function getState() {
  return {
    mode: editor.getMode(),
    isReadOnly,
    pandocAvailable,
    wordWrap: wordWrapOn,
    hasClosedFile: closedFiles.length > 0,
    // Editメニューの「切り取り」「コピー」を、選択が無いときはグレーにするために使う
    // (メニューを開くたびに評価されるが、選択範囲が空かどうかを見るだけなので軽い)。
    hasSelection: !editor.view.state.selection.main.empty,
    recentFiles,
    sidebarOpen: sidebar.isOpen(),
    sidebarPanel: sidebar.currentPanel(),
    folderLoaded: !!folderData,
    sourceMode: editor.isSourceMode(),
    focusMode: editor.isFocusMode(),
    typewriterMode: editor.isTypewriterMode(),
    fullscreen: windowState.fullscreen,
    alwaysOnTop: windowState.alwaysOnTop,
    showWordCount,
    keyBindings,
    displayMode,
  };
}

const ctx = {
  editor,
  bridge,
  getState,
  getFolder: () => folderData, // quick-open.jsが絞り込み対象のファイル一覧を取るのに使う
  // 設定画面(settings.js)がキーバインド再設定中(「キーを押してください」状態)だけtrueにする。
  // commands.js側のbindShortcutsがこれを見て、既存のショートカット発火を一時的に止める。
  shortcutsSuppressed: false,
  actions: {
    // Editメニューの「貼り付け」。本文の右クリックメニューと同じ処理を通す
    // (クリップボードにHTMLがあればMarkdownへ変換し、画像があればローカルへ保存する)。
    pasteRich() { return pasteRichFromContextMenu(); },
    // 複製(仕様書 F-08)。いまの内容を引き継いだ未保存の文書を新しく開く。
    // 元のファイルには触れないため、元を残したまま別案を書きたいときに使える。
    // ブリッジ(C#側)が新しいウィンドウ/タブを作るため、ブラウザ単体では何もしない
    // (メニュー項目自体もcommands.js側でグレーになる)。
    duplicateDocument() {
      if (!bridge) return;
      bridge.postMessage({ type: "duplicate", name: currentName, text: editor.getValue() });
    },
    async newDocument() {
      if (bridge) { bridge.postMessage({ type: "new" }); return; }
      if (isDirty && !(await paneConfirm({ title: "新規文書を開きますか?", message: "保存されていない変更があります。新規文書を開くと失われますが、よろしいですか?", okLabel: "開く", danger: true }))) return;
      pushClosedFile(currentPath);
      await applyNewDocumentLocal();
    },
    newWindow() {
      if (bridge) bridge.postMessage({ type: "new-window" });
      else window.open(location.href, "_blank", "noopener");
    },
    // タブ形式(仕様書 第2.10節 C-14、隠し設定)。displayMode!=="tab"のときはcommands.js側の
    // grayedで無効表示になっているため、ここへ到達するのは有効時のみ。
    newTab,
    openFile,
    save: () => saveFile(false),
    saveAs: () => saveFile(true),
    reopenClosed() {
      if (!closedFiles.length || !bridge) return;
      const path = closedFiles.pop();
      bridge.postMessage({ type: "open-path", path });
    },
    openRecentFile(path) {
      bridge?.postMessage({ type: "open-path", path });
    },
    async exportAs(format) {
      if (!bridge) { await paneAlert({ title: "エクスポートできません", message: "エクスポートはデスクトップアプリ版でのみ利用できます。" }); return; }
      // exportReadYamlFrontMatter(仕様書): trueならFront Matterのページ設定等を読んで上書きする。
      // 読み取るキーの一覧はmd-to-html.jsのFRONT_MATTER_KEYSを参照(このファイルが正)。
      const fm = exportSettings.exportReadYamlFrontMatter ? parseFrontMatterOverrides(editor.getValue()) : {};
      let text;
      if (format === "html" || format === "html-plain") {
        // exportPageBreakBetweenTopHeadings/exportIncludeOutline/exportAppendHead/exportAppendBody/
        // exportMathAsはHTMLエクスポートにのみ適用する(PDF/印刷はライブプレビューのDOMをそのまま
        // 印刷するため、これらの構造的な変更はHTML生成側でしか意味を持たない)。
        text = await editor.getStandaloneHtml({
          title: fm.title ?? currentName,
          styled: format === "html",
          mathAs: exportSettings.exportMathAs,
          pageBreakBetweenTopHeadings: exportSettings.exportPageBreakBetweenTopHeadings,
          includeOutline: exportSettings.exportIncludeOutline,
          outlineWidthPx: exportSettings.exportOutlineWidthPx,
          appendHead: exportSettings.exportAppendHead,
          appendBody: exportSettings.exportAppendBody,
          rootUrl: fm.rootUrl ?? null,
          // エクスポートしたHTMLは単体のファイルとして開かれ、pane-file.localホスト
          // (実行中のPaneアプリ内でのみ有効)は使えないため、ローカル画像はここでdata:として
          // 埋め込む(md-to-html.js resolveLocalImageFsPath/substituteImagePlaceholders参照)。
          resolveLocalImage: requestLocalImageDataUri,
        });
      } else {
        text = editor.getValue(); // pdfは本文を使わない。docx/epubはMarkdown原文をPandocへ渡す。
      }
      // PDF/印刷はbeforeprint/afterprintで自動的にレイアウトを展開・復元する(enterExportLayout参照)。
      // pageOptionsは主にformat==="pdf"のときC#側(CoreWebView2PrintSettings)が使う。
      // それ以外の形式でもexportDefaultFolder等の出力先設定は共通で使う。
      bridge.postMessage({ type: "export", format, text, pageOptions: buildExportPageOptions(fm) });
    },
    print() {
      // 用紙サイズ・余白・ヘッダー/フッター等の詳細設定(仕様書「エクスポート・印刷」節)は、
      // この経路(File>印刷、Ctrl+Alt+P)には適用されない(PDFエクスポートにのみ適用される)。
      // 理由: C#側が使うShowPrintUI(ネイティブ印刷ダイアログを出すメソッド)には設定を渡す
      // 引数が無いため。設定を反映して印刷するAPI自体はCoreWebView2.PrintAsync(printSettings)
      // として存在するが、そちらは印刷ダイアログを出さずプリンタ指定も自前で行う必要があり、
      // プリンタ選択UIをPane側に用意することになるため、現状は使っていない。
      // 詳細はMainForm.HandlePrintRequestAsyncのコメントを参照。
      if (bridge) bridge.postMessage({ type: "print" });
      else window.print();
    },
    // 設定画面(仕様書 第2.10節 C-01〜C-14)。本体ウィンドウより大きく表示できるよう、
    // 独立した専用ウィンドウ(Pane/SettingsWindow.cs、src/settings-entry.js)をC#側に
    // 開かせる(同時に1つしか開かない。既に開いていればC#側が前面に出す)。
    // ブリッジが無いブラウザ単体動作(開発確認用)では専用ウィンドウを開かせようが無いため、
    // 従来どおりHTML製のモーダル(settings.js)を出すフォールバックを残す
    // (settings.js自体はここで初めて動的importする。ensureSettingsUI()参照)。
    openSettings(category) {
      if (bridge) { bridge.postMessage({ type: "open-settings-window" }); return; }
      // 不具合3の修正: .catchが無いとsettings.jsの動的import失敗がunhandled rejectionに
      // なり、ユーザーには「設定を開いたのに何も起きない」としか見えなかった。
      // ensureSettingsUI()側でsettingsUIPromiseは既にnullへ戻しているので、失敗を
      // 知らせた上でもう一度openSettings()を呼べば再試行できる。
      ensureSettingsUI().then((ui) => ui.open(category)).catch((err) => {
        console.error("設定画面の読み込みに失敗しました:", err);
        paneAlert({ title: "設定を開けません", message: "設定画面の読み込みに失敗しました。もう一度お試しください。" });
      });
    },
    // 取扱説明書(F1、仕様書 第10.1節相当のヘルプ)。設定画面(openSettings)と同じ考え方:
    // 独立した専用ウィンドウ(Pane/HelpWindow.cs、src/help-entry.js)をC#側に開かせる
    // (同時に1つしか開かない。既に開いていればC#側が前面に出す)。ブリッジが無いブラウザ単体
    // 動作(開発確認用)では専用ウィンドウを開かせようが無いため、help-window.htmlを別タブで開く。
    openHelp() {
      if (bridge) { bridge.postMessage({ type: "open-help-window" }); return; }
      window.open("help-window.html", "_blank", "noopener");
    },
    async closeWindow() {
      // 未保存の変更がある場合の保存確認はC#側(FormClosing)が一元的に行う
      // (ネイティブのXボタン・Alt+F4で閉じた場合と挙動を揃えるため)。
      if (bridge) { bridge.postMessage({ type: "close" }); return; }
      if (isDirty && !(await paneConfirm({ title: "閉じますか?", message: "保存されていない変更があります。閉じてもよろしいですか?", okLabel: "閉じる", danger: true }))) return;
      window.close();
    },
    async copyAsMarkdown() {
      try { await navigator.clipboard.writeText(editor.getMarkdownForClipboard()); } catch { /* クリップボード権限が無い環境ではベストエフォート */ }
    },
    async copyAsHtml() {
      const html = editor.getHtmlForClipboard();
      const md = editor.getMarkdownForClipboard();
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([md], { type: "text/plain" }),
          }),
        ]);
      } catch {
        try { await navigator.clipboard.writeText(md); } catch { /* ベストエフォート */ }
      }
    },
    async pasteAsPlainText() {
      try {
        const text = await navigator.clipboard.readText();
        editor.pasteText(text);
      } catch { /* クリップボード読み取り権限が無ければ何もしない */ }
    },
    // 右クリックメニュー「画像を開く」(docs/コンテキストメニュー仕様.md 2.4)。
    // 既定のビューアで開く操作自体はC#(WinForms)側の機能のため、ブリッジが無い
    // ブラウザ単体動作では提供できない。
    async openImageFile(rawSrc) {
      if (!bridge) { await paneAlert({ title: "開けません", message: "既定のビューアで開く機能はデスクトップアプリ版でのみ利用できます。" }); return; }
      const resolved = resolveImageFsPath(rawSrc);
      if (!resolved) return;
      bridge.postMessage({ type: "open-in-default-app", path: resolved });
    },
    openSearch() { searchUI.open(false); },
    openReplace() { searchUI.open(true); },
    insertImageFlow() {
      if (bridge) { bridge.postMessage({ type: "insert-image" }); return; }
      imageInput.click(); // ブラウザ単体時のフォールバック
    },
    async setMode(mode) {
      await editor.setFileMode(currentPath ?? currentName, mode);
      // 改善②(実機報告): 「表示メニュー→コードモード」でコードモードへ切り替えた直後、
      // 言語がまだ未設定ならその時点の内容から言語を判定して設定する。setFileMode(mode)
      // 自体は拡張子ベースの判定のみで言語までは決めないため、ここで改めて内容ベースの
      // 判定を試す(直後にautoDetectState.lockedを立てるが、その対象はモード自体の自動判定
      // であり、この言語判定とは別物なのでロックの影響を受けない。詳細は
      // maybeAutoDetectCodeLanguageのコメント参照)。updateStatusMode()より前に済ませ、
      // ステータスバーに反映した言語を1回で正しく出す。
      if (mode === "code") await maybeAutoDetectCodeLanguage();
      updateStatusMode();
      // 手動でモードを選んだ文書には、以後内容からの自動判定(仕様書 第1章の拡張)を行わない。
      autoDetectState.locked = true;
      // 手動切替の記憶(仕様書 第1章)。無題(パス無し)の場合はブリッジへ送らず、その場の変更のみ行う。
      if (!currentPath) return;
      if (mode === autoFileMode(currentName)) {
        // 自動判定と同じ選択に戻した場合は記憶自体を消す(設定ファイルが不要に太るのを防ぐ)。
        delete perFileModes[currentPath];
        bridge?.postMessage({ type: "remember-file-mode", path: currentPath, mode: null });
      } else {
        perFileModes[currentPath] = mode;
        bridge?.postMessage({ type: "remember-file-mode", path: currentPath, mode });
      }
    },
    toggleWordWrap() {
      wordWrapOn = !wordWrapOn;
      editor.setWordWrap(wordWrapOn);
      updateWrapButton();
    },
    async gotoLineFlow() {
      const total = editor.getValue().split("\n").length;
      const input = await paneInput({
        title: "指定行へジャンプ",
        message: `移動する行番号を入力してください(1〜${total})`,
        okLabel: "移動",
        validate: (v) => {
          if (v.trim() === "") return null; // 未入力時はOK無効化ではなく単にジャンプしない(空欄OKも許容)
          const n = parseInt(v, 10);
          if (!Number.isFinite(n) || String(n) !== v.trim() || n < 1 || n > total) return `1〜${total}の数値を入力してください`;
          return null;
        },
      });
      if (!input) return;
      const n = parseInt(input, 10);
      if (Number.isFinite(n)) editor.gotoLine(n);
    },
    // ソースコードモード(V-05)・フォーカスモード(V-06)・タイプライターモード(V-07)。
    // いずれもcompartment切替の実体はeditor.js側に持ち、ここは単純なトグルの橋渡し。
    toggleSourceMode() { editor.setSourceMode(!editor.isSourceMode()); },
    toggleFocusMode() { editor.setFocusMode(!editor.isFocusMode()); },
    toggleTypewriterMode() { editor.setTypewriterMode(!editor.isTypewriterMode()); },
    // 全画面表示(V-08)・開いている文書を切り替え(V-11)・常に手前に表示(V-12)は
    // いずれもC#側(WinForms)が実体を持つため、メッセージを送るだけ。実際の状態は
    // "window-state"メッセージで折り返し届く(handleHostMessage参照)。
    toggleFullscreen() { bridge?.postMessage({ type: "toggle-fullscreen" }); },
    toggleAlwaysOnTop() { bridge?.postMessage({ type: "toggle-always-on-top" }); },
    switchDocument() { bridge?.postMessage({ type: "switch-document" }); },
    // 文字サイズ(V-09/V-10)。既存のCtrl+マウスホイールと同じeditor.setFontSize()を使い、
    // 変更後はCtrl+ホイールと同じくset-font-sizeメッセージで永続化する(setFontSizeAndPersist参照)。
    zoomIn() { setFontSizeAndPersist(editor.getFontSize() + 1); },
    zoomOut() { setFontSizeAndPersist(editor.getFontSize() - 1); },
    zoomReset() { setFontSizeAndPersist(DEFAULT_FONT_SIZE); },
    // 文字数カウントの表示切替(V-13)。C#側に永続化の受け口がまだ無くても支障が無いよう、
    // 送るだけで応答は待たない({ type: "set-show-word-count" }、専用メッセージ)。
    toggleWordCount() {
      showWordCount = !showWordCount;
      updateWordCountVisibility();
      bridge?.postMessage({ type: "set-show-word-count", value: showWordCount });
    },
    openDevTools() { bridge?.postMessage({ type: "open-devtools" }); },
    async openFolder() {
      // フォルダ選択ダイアログ自体がC#側(WinForms)の機能のため、ブリッジが無い
      // ブラウザ単体動作では提供できない(仕様書 S-02/S-03はデスクトップアプリ前提)。
      if (!bridge) { await paneAlert({ title: "開けません", message: "フォルダを開く機能はデスクトップアプリ版でのみ利用できます。" }); return; }
      // 本文が空(新規ファイル等、失われる内容が無い)ならこのウィンドウでフォルダを開き、
      // 何か書かれていれば新しいウィンドウで開く(D&Dのopen-dropped-fileと同じ判定・同じ考え方)。
      const isEmptyDocument = editor.getValue().trim() === "";
      bridge.postMessage({ type: "open-folder", newWindow: !isEmptyDocument });
    },
    openFileByPath(path, line) {
      // lineが指定された場合(グローバル検索の結果クリック等)は、file-openedが届いて
      // 実際に開いたパスが一致した時点でその行へジャンプする(pendingGotoLine参照)。
      pendingGotoLine = line != null ? { path, line } : null;
      bridge?.postMessage({ type: "open-path", path });
    },
    // サイドバーのファイル一覧・ツリーからの切替専用(仕様書 saveWithoutAskingOnSwitch)。
    // 有効時は未保存の変更があっても確認せず保存してから切り替える。無効時(既定)は
    // 従来どおりopenFileByPathと同じ経路を通り、保存確認自体はC#側(ConfirmDiscardDirtyAsync)に
    // 任せる。グローバル検索結果・クイックオープンからの遷移は対象外(仕様書の範囲外のため、
    // 引き続きopenFileByPathを直接使う)。
    async switchFileFromSidebar(path) {
      if (saveWithoutAskingOnSwitch && isDirty) {
        if (bridge) await saveFileAndWait(false);
        else await saveFile(false); // bridgeが無い場合のsaveFileは同期的に完結する
      }
      ctx.actions.openFileByPath(path);
    },
    // グローバル検索(仕様書 第2.6節 G-01)。Ctrl+Shift+Fから呼ばれる。
    openGlobalSearch() { sidebar.openSearch(); },
    // 日時の挿入(仕様書 第3章 N-14、メモ帳のF5相当)。既存のpasteText(貼り付け相当の挿入)を
    // そのまま使い、editor.jsは変更しない。
    insertDateTime() { editor.pasteText(formatDateTimeStamp(new Date())); },
    // openQuickOpenはcreateQuickOpen(ctx)がctxを必要とする(sidebarと同じ循環依存)ため、
    // quickOpen生成後にctx.actionsへ追加する(下方参照)。
  },
};
// ツールチップの詳しさ(依頼2)。設定画面(settings.js)自身は本文ウィンドウと同じ文書に
// 重ねて表示される(モードモード。ブリッジ有りの実機では専用ウィンドウ側になるため、
// こちらは主にブラウザ単体動作・検証用の経路)ため、保存前でも「選んだ瞬間」に本文側の
// ツールチップへ反映できる。テーマのプレビュー(previewTheme)と同じ考え方で、
// ctx経由で直接この文書のsetTooltipLevel()を呼んでもらう。
ctx.setTooltipLevel = setTooltipLevel;

// サイドバー(仕様書 第2.8節・第10.4節)。ctxを引数に取るためctx構築後に生成し、
// 開閉・パネル切替のactionsはここでctx.actionsへ追加する
// (buildCommands等はctxへの参照を保持するだけで遅延評価するため、この順序で問題ない)。
const sidebar = createSidebar(editor, ctx);
ctx.actions.toggleSidebar = () => sidebar.toggle();
ctx.actions.showSidebarPanel = (panel) => sidebar.showPanel(panel);
statusSidebarBtn.addEventListener("click", () => ctx.actions.toggleSidebar());

// クイックオープン(仕様書 F-05)。sidebarと同様、ctxを必要とするためctx構築後に生成する。
const quickOpen = createQuickOpen(ctx);
ctx.actions.openQuickOpen = () => quickOpen.open();

const commands = buildCommands(ctx);
bindShortcuts(commands, ctx);
const menuBar = initMenuBar(menubarEl, commands, ctx);
const commandPalette = initCommandPalette(document.body, commands, ctx);
// 右クリック(コンテキスト)メニュー(docs/コンテキストメニュー仕様.md)。documentに1つだけ
// 登録し、入力欄(input/textarea)かどうかはinitContextMenu自身が最優先で判定する
// (検索ボックス・設定画面の入力欄など、どこにあっても同じ最小メニューになる、第5節)。
// それ以外は本文(CodeMirror)の上かどうかで判定する(サイドバーの行別メニューは
// sidebar.js自身がshowContextMenuを使って個別に配線しており、ここには含めない)。
initContextMenu(document, ctx, (c, e) => (host.contains(e.target) ? buildEditorContextMenuTree(c, e) : null));
// サイドバー・検索UI・コマンド・メニューバー・コマンドパレット・右クリックメニューまで
// 組み上がった時点。ここから先はC#側からのメッセージ待ちになる。
markStartup("UI初期化");

// ステータスバーの文字コード・改行コード(仕様書 第6.1/6.2節)。クリックでネイティブ
// ポップアップのメニューを出す(docs/コンテキストメニュー仕様.mdの作法どおりshowContextMenuを
// 使う。ブリッジが無い環境ではHTMLの.menu-dropdownへ自動的にフォールバックする)。
// 右クリックではなく通常クリックのため、クリック位置ではなくボタンの左下に出す。
statusEncoding.addEventListener("click", () => {
  const rect = statusEncoding.getBoundingClientRect();
  showContextMenu(ctx, rect.left, rect.bottom, buildEncodingMenuTree());
});
statusLineEnding.addEventListener("click", () => {
  const rect = statusLineEnding.getBoundingClientRect();
  showContextMenu(ctx, rect.left, rect.bottom, buildLineEndingMenuTree());
});

// 設定画面(仕様書 第2.10節)。キーバインドタブがコマンド一覧を必要とするため、
// buildCommands()の後でctx.commandsとして公開しておく(settings.js自体の読み込み・生成は
// ensureSettingsUI()により実際に必要になるまで遅延する。上のコメント参照)。
ctx.commands = commands;

// 検証用の入口。ブリッジが無いとき(=WebView2ではなく素のブラウザで開いたとき)だけ公開する。
// Pane本体(WebView2)では window.chrome.webview が必ず存在するため、この分岐は常に偽になり
// 製品の動作には一切影響しない。リポジトリの検証スクリプト(.verify-*.mjs)はブラウザ上で
// エディタ内部のAPI(エクスポートHTMLの生成など、画面操作だけでは到達できないもの)を
// 直接呼ぶ必要があるため、その足場として置いている。
if (!bridge) {
  window.__paneDebugEditor = editor;
  window.__paneDebugCtx = ctx;
}

// ---- 右クリックメニュー: 本文(CodeMirror)の上(docs/コンテキストメニュー仕様.md 第2章・第3章) ----
// commands配列(File/Edit/Paragraph/Format/View)の中から、右クリックメニューでも使う項目を
// そのまま拝借する小さなヘルパー。有効/チェック状態の評価もcommands配列の定義(grayed/enabled/
// checked)にそのまま従うため、メニューバー・コマンドパレットと表示が食い違わない。
function fromCommand(id, overrides) {
  const c = commands.find((cmd) => cmd.id === id);
  if (!c) return null;
  const grayed = c.grayed?.(ctx) ?? false;
  const enabled = !grayed && (c.enabled ? c.enabled(ctx) : true);
  return { label: c.label, shortcut: c.shortcut, enabled, checked: !!c.checked?.(ctx), run: c.run, ...overrides };
}
const clip = (text) => navigator.clipboard.writeText(text).catch(() => {}); // クリップボードコピーはベストエフォート

function buildEditorContextMenuTree(c, e) {
  const mode = editor.getMode();
  const info = editor.resolveContextMenu(e.clientX, e.clientY, e.target);
  if (!info) return null;
  const hasSelection = info.hasSelection;

  // カラープレビュー(docs/カラープレビュー仕様.md 第4章): 色リテラルの上で右クリックした
  // ときだけ、どのモード・どの文脈よりも先に「色を変更…」を出す。
  // ラベルには色番号そのものを添える。ネイティブメニュー(Pane/NativeMenu.cs)は項目の左に
  // 任意の色見本を描く仕組みを持たないため、代わりに文字で「どの色を編集するのか」が
  // 分かるようにしている(例: 色を変更… (#14599F))。
  const colorHead = info.color
    ? [{
        label: `色を変更… (${info.color.text})`,
        run: () => editor.openColorPicker(info.color.from, info.color.to, info.color.text),
        separatorAfter: true,
      }]
    : [];

  // ---- コード/プレーンテキストモード(第3章): マークダウン固有の項目は一切出さない ----
  if (mode !== "markdown") {
    const tree = [
      ...colorHead,
      { label: "切り取り", enabled: hasSelection, run: () => document.execCommand("cut") },
      { label: "コピー", enabled: hasSelection, run: () => document.execCommand("copy") },
      { label: "貼り付け", run: () => pasteRichFromContextMenu() },
      { label: "すべて選択", run: () => editor.applyAction("selectAll"), separatorAfter: true },
      { label: "元に戻す", run: () => editor.applyAction("undo") },
      { label: "やり直す", run: () => editor.applyAction("redo"), separatorAfter: true },
      fromCommand("edit.find"),
      { ...fromCommand("edit.replace"), separatorAfter: mode !== "code" },
    ];
    if (mode === "code") tree.push({ label: "言語を選択…", run: () => openLanguagePicker() });
    return tree;
  }

  // ---- Markdownモード(第2章) ----
  const tree = [...colorHead];

  // 2.3〜2.9: 文脈固有セクション(該当する場合のみ)
  if (info.kind === "link") {
    tree.push(
      { label: "リンクを開く", run: () => editor.openLink(info.href) },
      { label: "リンクのURLをコピー", run: () => clip(info.href) },
      { label: "リンクを編集…", run: () => editor.applyAction("linkEditUrl") },
      { label: "リンクを解除", run: () => editor.applyAction("linkUnlink"), separatorAfter: true },
    );
  } else if (info.kind === "image") {
    const isOnline = /^[a-zA-Z][\w+.-]*:/.test(info.src) || info.src.startsWith("//");
    if (isOnline) {
      tree.push({ label: "このURLをコピー", run: () => clip(info.src), separatorAfter: true });
    } else {
      tree.push(
        { label: "画像を開く", enabled: !!bridge, run: () => ctx.actions.openImageFile(info.src) },
        { label: "画像のパスをコピー", run: () => clip(info.src) },
        { label: "画像のパスを編集…", run: () => editor.applyAction("imageEditPath") },
        { label: "画像を削除", run: () => editor.applyAction("imageDelete"), separatorAfter: true },
      );
    }
  } else if (info.kind === "table") {
    tree.push(
      { label: "行を上に挿入", run: () => editor.applyAction("tableInsertRowAbove", info) },
      { label: "行を下に挿入", run: () => editor.applyAction("tableInsertRowBelow", info) },
      { label: "列を左に挿入", run: () => editor.applyAction("tableInsertColLeft", info) },
      { label: "列を右に挿入", run: () => editor.applyAction("tableInsertColRight", info), separatorAfter: true },
      { label: "行を削除", enabled: info.rowKind === "body", run: () => editor.applyAction("deleteTableRow") },
      { label: "列を削除", enabled: info.cols > 1, run: () => editor.applyAction("tableDeleteCol", info) },
      { label: "表を削除", run: () => editor.applyAction("tableDelete"), separatorAfter: true },
      {
        label: "列の配置",
        submenu: [
          { label: "左揃え", run: () => editor.applyAction("tableAlignLeft", info) },
          { label: "中央揃え", run: () => editor.applyAction("tableAlignCenter", info) },
          { label: "右揃え", run: () => editor.applyAction("tableAlignRight", info) },
          { label: "指定なし", run: () => editor.applyAction("tableAlignNone", info) },
        ],
        separatorAfter: true,
      },
    );
  } else if (info.kind === "codeblock") {
    tree.push(
      { label: "言語を選択…", run: () => openLanguagePicker((id) => editor.applyAction("codeblockSetLang", { lang: id })) },
      { label: "コードブロックの内容をコピー", run: () => clip(info.code) },
      { label: "コードブロックを削除", run: () => editor.applyAction("codeblockDelete"), separatorAfter: true },
    );
  } else if (info.kind === "heading") {
    const levels = [1, 2, 3, 4, 5, 6].map((lv) => ({ label: `見出し${lv}`, checked: info.level === lv, run: () => editor.applyAction(`h${lv}`) }));
    tree.push({ label: "見出しレベル", submenu: [...levels, { label: "段落(見出し解除)", run: () => editor.applyAction("h0") }], separatorAfter: true });
  } else if (info.kind === "list") {
    // 既存のpara.listBullet/listOrdered/listCheck(いずれもcontextOnly、commands.js)を
    // そのまま使う。checkedだけは現在の種別(info.listType)から上書きする
    // (これらのコマンド定義自体にはchecked判定を持たせていないため)。
    tree.push(
      fromCommand("para.listBullet", { checked: info.listType === "bullet" }),
      fromCommand("para.listOrdered", { checked: info.listType === "ordered" }),
      fromCommand("para.listCheck", { checked: info.listType === "check" }),
      fromCommand("para.indent"),
      { ...fromCommand("para.outdent"), separatorAfter: true },
    );
  } else if (info.kind === "math") {
    tree.push(
      { label: "数式を編集", run: () => editor.applyAction("mathEditSelect") },
      { label: "数式を削除", run: () => editor.applyAction("mathDelete"), separatorAfter: true },
    );
  }

  // 2.1: 編集セクション(常時)
  tree.push(
    { label: "切り取り", enabled: hasSelection, run: () => document.execCommand("cut") },
    { label: "コピー", enabled: hasSelection, run: () => document.execCommand("copy") },
    { label: "貼り付け", run: () => pasteRichFromContextMenu() },
    fromCommand("edit.pastePlain"),
    { label: "すべて選択", run: () => editor.applyAction("selectAll") },
    { ...fromCommand("edit.copyMarkdown"), enabled: hasSelection },
    { ...fromCommand("edit.copyHtml"), enabled: hasSelection, separatorAfter: true },
  );

  // 2.2: 書式サブメニュー(選択がある場合)
  if (hasSelection) {
    tree.push({
      label: "書式",
      submenu: [
        fromCommand("format.bold"), fromCommand("format.italic"), fromCommand("format.underline"),
        fromCommand("format.code"), fromCommand("format.strike"), fromCommand("format.highlight"),
        fromCommand("format.superscript"), { ...fromCommand("format.subscript"), separatorAfter: true },
        fromCommand("format.link"), fromCommand("format.eraseFormat"),
      ],
    });
  }

  // 2.11: 段落サブメニュー(選択も文脈も無い場合のみ)
  if (!hasSelection && info.kind === "paragraph") {
    tree.push({
      label: "段落",
      submenu: [
        fromCommand("para.h1"), fromCommand("para.h2"), fromCommand("para.h3"),
        fromCommand("para.h4"), fromCommand("para.h5"), { ...fromCommand("para.h6"), separatorAfter: true },
        fromCommand("para.p"), fromCommand("para.quote"), fromCommand("para.list"), fromCommand("para.olist"),
        { label: "タスクリスト", run: () => editor.applyAction("check"), separatorAfter: true },
        fromCommand("para.table"), fromCommand("para.codeblock"), fromCommand("para.mathBlock"),
        { label: "水平線", run: () => editor.applyAction("hr") },
      ],
    });
  }

  // 2.10: その他セクション(常時)
  tree.push({ label: "元に戻す", run: () => editor.applyAction("undo") });
  tree.push({ label: "やり直す", run: () => editor.applyAction("redo"), separatorAfter: true });
  tree.push({ label: "検索…", run: () => ctx.actions.openSearch() });
  if (hasSelection) tree.push({ label: "選択箇所を検索", run: () => ctx.actions.openSearch() });

  return tree;
}

// 貼り付け(仕様書 コンテキストメニュー仕様 2.1「常時 | 既存の貼り付け経路」)。
// 通常のキー操作(Ctrl+V)はcontentDOMへの本物のpasteイベント(main.jsのonPaste)で処理されるが、
// 右クリックメニューからは本物のpasteイベントを発生させられないため、非同期Clipboard API
// (navigator.clipboard.read())でHTML/画像/プレーンテキストを順に試す。onPasteと同じ優先順位
// (HTML→画像→プレーン)に揃える。read()自体が使えない/権限が無い環境ではプレーンテキスト
// 貼り付け(既存のpasteAsPlainText経路)へフォールバックする。
async function pasteRichFromContextMenu() {
  if (!navigator.clipboard?.read) { await ctx.actions.pasteAsPlainText(); return; }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (!item.types.includes("text/html")) continue;
      const html = await (await item.getType("text/html")).text();
      const md = htmlToMarkdown(html).trim();
      if (md) { editor.pasteText(md); return; }
    }
    for (const item of items) {
      const imgType = item.types.find((ty) => ty.startsWith("image/"));
      if (!imgType) continue;
      const blob = await item.getType(imgType);
      await insertImageFile(new File([blob], "clipboard." + imgType.split("/")[1], { type: imgType }));
      return;
    }
  } catch {
    // クリップボード読み取り権限が無い等はプレーンテキストへフォールバック
  }
  await ctx.actions.pasteAsPlainText();
}

// 失敗しても例外を投げず元の文字列を返すdecodeURIComponent(editor.js/md-to-html.jsの
// 同名関数と同じ理由。画像挿入時にURLエスケープされたパスを実ファイル名へ戻すため)。
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// 画像を既定のビューアで開く(docs/コンテキストメニュー仕様.md 2.4)。ライブプレビューの<img>の
// srcはWebView2内で表示するための解決(resolveImageSrc、pane-file.local経由)であって実際の
// ファイルシステム上のパスではないため、ここでは現在の文書のフォルダを基準に別途解決する
// (front matterのtypora-root-urlまでは追わない簡易実装)。
function resolveImageFsPath(rawSrc) {
  if (!rawSrc) return null;
  // Windows絶対パス(例: "C:\..." "C:/...")は、次の行の一般的なURIスキーム判定
  // (/^[a-zA-Z][\w+.-]*:/)にも「1文字のスキーム(c:)」として誤って一致してしまうため、
  // スキーム判定より先に見る(editor.js resolveImageSrcと同じ理由。これを怠ると
  // 絶対パスで画像挿入した文書の「既定のビューアで開く」がオンライン画像扱いされ失敗する)。
  if (/^[a-zA-Z]:[\\/]/.test(rawSrc) || rawSrc.startsWith("\\\\")) return rawSrc;
  if (/^[a-zA-Z][\w+.-]*:/.test(rawSrc) || rawSrc.startsWith("//")) return null; // オンライン画像等
  // 画像挿入(imageAutoEscapeUrl既定true、Pane/ImageInsertService.cs)でURLエスケープ済みの
  // ことがあるため、実ファイル名へ戻してから使う(手書きの普通のパスは変化しない)。
  const decoded = safeDecodeURIComponent(rawSrc);
  if (/^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith("\\\\")) return decoded; // 既に絶対パス(エスケープ済みだった場合)
  if (!currentPath) return null; // 無題文書では相対パスの基準が無い
  const dir = currentPath.replace(/[\\/][^\\/]*$/, "");
  return dir + "\\" + decoded.replace(/\//g, "\\");
}

// HTMLエクスポートでのローカル画像のdata:埋め込み(md-to-html.js substituteImagePlaceholders
// から呼ばれる)。C#(Pane/MainForm.cs HandleReadLocalImageRequest)へ絶対パスを渡し、
// 範囲チェック済みで読み込めたファイルだけbase64のdata:として返してもらう
// (任意のローカルファイルを読めてはいけないため、判定はC#側のResolveAllowedLocalFilePathに
// 一本化してあり、ここでは何も検証しない)。ブリッジが無い(ブラウザ単体動作)場合や
// 応答が無かった場合はnullを返し、呼び出し側は元のMarkdown記法のパスへフォールバックする。
function requestLocalImageDataUri(fsPath) {
  if (!bridge) return Promise.resolve(null);
  return new Promise((resolve) => {
    const requestId = ++localImageRequestSeq;
    pendingLocalImageResolvers.set(requestId, resolve);
    bridge.postMessage({ type: "read-local-image", requestId, path: fsPath });
  });
}

// コマンドパレット(Ctrl+Shift+P、仕様書 第10.1節)。5つのメニューのどれにも属さないため
// commands.jsの宣言的なショートカット一覧ではなく、ここで直接待ち受ける。
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    commandPalette.open();
  }
});
statusWrapBtn.addEventListener("click", () => ctx.actions.toggleWordWrap());
statusZoom.addEventListener("click", () => ctx.actions.zoomReset());
statusCount.addEventListener("click", () => { if (showWordCount) wordCountPopup.toggle(statusCount); });

// 本文の文字サイズを変更し、ズーム率表示を更新したうえでC#側へ永続化する(仕様書 V-09/V-10)。
// Ctrl+マウスホイール(下記)とView メニューの拡大/縮小/実際のサイズ(ctx.actions)の
// どちらから呼ばれても同じ経路を通る。
function setFontSizeAndPersist(size) {
  const applied = editor.setFontSize(size);
  updateZoom();
  bridge?.postMessage({ type: "set-font-size", size: applied });
}

// Ctrl+マウスホイールで本文の文字サイズを変更する。WebView2側のページズーム
// (IsZoomControlEnabled=falseで無効化済み)はメニューバー・ステータスバーまで
// 拡大してしまうため使わず、CodeMirrorのフォントサイズだけを変える。
window.addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !zoomWithCtrlWheelOn) return; // 仕様書 zoomWithCtrlWheel: falseなら何もしない
  e.preventDefault();
  setFontSizeAndPersist(editor.getFontSize() + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

// ---- WebView2ブリッジ(Phase 2) ----
if (bridge) {
  bridge.addEventListener("message", (e) => {
    if (e.data?.type !== "text-response") logToHost("log", `C#からのメッセージ受信: type=${e.data?.type}`);
    handleHostMessage(e.data);
  });
  bridge.postMessage({ type: "ready" });
}

// 拡張子既定(fileModeOverridesがあればそちらを優先)による自動判定。
// setMode()が「手動で選んだモードが自動判定と一致するか」を調べるのにも使う
// (この判定にはperFileModes自体は含めない。手動記憶を上書きするかどうかの判定のため)。
function autoFileMode(fileName) {
  const ext = fileName ? (fileName.split(".").pop() || "").toLowerCase() : null;
  if (ext && Object.prototype.hasOwnProperty.call(fileModeOverrides, ext)) {
    return fileModeOverrides[ext];
  }
  return resolveFileMode(fileName);
}
// 編集モード決定(仕様書 第1章)。優先順位: 1.そのファイルパスの手動記憶(perFileModes)
// 2.拡張子ごとの既定モード上書き(fileModeOverrides) 3.拡張子からの既定判定(resolveFileMode)。
function decideFileMode(path, fileName, fileNameIsReal = false) {
  if (path && Object.prototype.hasOwnProperty.call(perFileModes, path)) {
    return perFileModes[path];
  }
  // 保存先がまだ無い文書(新規作成、および異常終了からの復元で元ファイルのパスが無い場合)は、
  // 無題の新規文書と同じ扱いでMarkdownにする。C#側は表示名として"無題"を送ってくるため、
  // これをそのまま拡張子判定に掛けると「"無題"という拡張子」とみなされてプレーンテキストへ
  // 落ちてしまう(復元したMarkdown文書がプレーンテキストで開く不具合の原因だった)。
  if (!path) {
    // 保存先が無い文書は既定では無題の新規文書と同じ扱い(Markdown)にする。ただし
    // D&Dで開いた場合のように「保存先はまだ無いが、ファイル名は実在のファイルのもの」
    // という場合があり、そのときは拡張子どおりのモードで開くのが正しい
    // (実機報告: sw.jsをドロップしてもMarkdownで開いてしまっていた)。
    // C#側(MainForm.OpenDroppedContent)がfileNameIsReal:trueを付けて送ってくる。
    if (!fileNameIsReal) return autoFileMode(null);
    return autoFileMode(fileName);
  }
  return autoFileMode(fileName);
}

// ---- タブ形式(仕様書 第2.10節 C-14、隠し設定)本体 ----
// 単一のCodeMirrorインスタンス(editor)を使い回し、タブ切替のたびeditor.setEditorState()で
// EditorStateを丸ごと差し替える(タブごとにエディタを作らない。メモリと初期化コストのため)。
// 「いま画面に出ている」タブの状態は既存のグローバル変数(currentPath/currentName/
// currentEncoding/currentLineEnding/isDirty/isReadOnly)がそのまま兼ねる。これらは
// ウィンドウ形式でも使われている変数のため、タブ切替のたびにここへ書き戻すことで、
// ステータスバー・タイトルバー通知("dirty"等)・自動判定など既存のロジックを
// タブ形式かどうかに関わらずそのまま使い回せる。
function activeTab() {
  return tabs.find((t) => t.id === activeTabId) ?? null;
}
// 現在アクティブなタブへ、いま画面に出ている内容(doc・選択・履歴・スクロール位置・
// モード等)をスナップショットとして書き戻す。タブを切り替える/閉じる/自動保存へ返す前に
// 必ず呼ぶ。
function saveActiveTabSnapshot() {
  const tab = activeTab();
  if (!tab) return;
  tab.editorState = editor.getEditorState();
  Object.assign(tab, editor.getModeSnapshot());
  tab.scrollTop = editor.view.scrollDOM.scrollTop;
  tab.scrollLeft = editor.view.scrollDOM.scrollLeft;
  tab.path = currentPath;
  tab.fileName = currentName;
  tab.encoding = currentEncoding;
  tab.lineEnding = currentLineEnding;
  tab.readOnly = isReadOnly;
  tab.dirty = isDirty;
  // ダーティ判定の基準(computeIsDirty参照)もタブごとに独立させる。ここで書き戻して
  // おかないと、他のタブへ切り替えて戻ってきたときに「別のタブの基準」と比較してしまい、
  // 誤った未保存判定になる。
  tab.savedDoc = savedDocRef;
  tab.metaDirty = metaDirty;
}
// C#側(タイトル・自動保存対象・セッション復元用パスの追跡)へ、タブの一覧を送る。
// 頻度は「タブが増減した/切り替わった/dirty状態が変わった」時だけで、入力のたびには送らない。
function notifyTabsChanged() {
  if (!bridge || displayMode !== "tab") return;
  bridge.postMessage({
    type: "tabs-changed",
    activeGuid: activeTab()?.guid ?? null,
    tabs: tabs.map((t) => ({
      guid: t.guid, path: t.path, fileName: t.fileName, dirty: t.dirty,
      readOnly: t.readOnly, encoding: t.encoding, lineEnding: t.lineEnding,
    })),
  });
}
// タブバー(HTML)を丸ごと再描画する。タブ数は現実的に多くても数十件程度のため、
// 差分更新はせず毎回作り直す(既存のsidebar.js等の一覧描画と同じ簡潔さを優先する)。
function renderTabs() {
  if (!tabbarEl) return;
  tabbarEl.hidden = displayMode !== "tab";
  if (tabbarEl.hidden) return;
  tabbarListEl.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab-item" + (tab.id === activeTabId ? " active" : "");
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", tab.id === activeTabId ? "true" : "false");
    el.setAttribute("draggable", "true");
    el.dataset.tabId = String(tab.id);
    el.title = tab.path || tab.fileName;

    const nameEl = document.createElement("span");
    nameEl.className = "tab-item-name";
    nameEl.textContent = tab.fileName;
    el.appendChild(nameEl);

    const dirtyEl = document.createElement("span");
    dirtyEl.className = "tab-item-dirty";
    dirtyEl.textContent = tab.dirty ? "●" : "";
    el.appendChild(dirtyEl);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab-item-close";
    closeBtn.title = "閉じる";
    closeBtn.setAttribute("aria-label", "閉じる");
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(closeBtn);

    el.addEventListener("click", () => switchToTab(tab.id));
    // 中クリックで閉じる。auxclickではなくmousedown(button===1)で処理することで、
    // ブラウザ既定のオートスクロール開始より確実に先着させる。
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(ctx, e.clientX, e.clientY, buildTabContextMenu(tab));
    });

    // ドラッグ&ドロップでの並べ替え。
    el.addEventListener("dragstart", (e) => {
      draggingTabId = tab.id;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      // FirefoxやWebView2の一部実装ではsetDataを呼ばないとdragstart自体が成立しないことがあるため、
      // 実際には使わないダミー値を入れておく(タブの並べ替えはdraggingTabId経由で行う)。
      try { e.dataTransfer.setData("text/plain", String(tab.id)); } catch { /* 一部環境で例外時は無視 */ }
    });
    el.addEventListener("dragend", () => {
      draggingTabId = null;
      el.classList.remove("dragging");
      clearTabDragOverClasses();
    });
    el.addEventListener("dragover", (e) => {
      if (draggingTabId == null || draggingTabId === tab.id) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = e.clientX - rect.left < rect.width / 2;
      clearTabDragOverClasses();
      el.classList.add(before ? "drag-over-before" : "drag-over-after");
    });
    el.addEventListener("drop", (e) => {
      if (draggingTabId == null) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = e.clientX - rect.left < rect.width / 2;
      reorderTab(draggingTabId, tab.id, before);
      clearTabDragOverClasses();
    });

    tabbarListEl.appendChild(el);
  }
}
function clearTabDragOverClasses() {
  tabbarListEl.querySelectorAll(".drag-over-before, .drag-over-after")
    .forEach((el) => el.classList.remove("drag-over-before", "drag-over-after"));
}
function reorderTab(draggedId, targetId, before) {
  if (draggedId === targetId) return;
  const fromIdx = tabs.findIndex((t) => t.id === draggedId);
  if (fromIdx < 0) return;
  const [moved] = tabs.splice(fromIdx, 1);
  let toIdx = tabs.findIndex((t) => t.id === targetId);
  if (toIdx < 0) toIdx = tabs.length;
  if (!before) toIdx += 1;
  tabs.splice(toIdx, 0, moved);
  renderTabs();
  notifyTabsChanged();
}
// タブの右クリックメニュー(docs/コンテキストメニュー仕様.md の作法どおり、ネイティブポップアップ経由。
// showContextMenuはブリッジが無い環境ではHTMLフォールバックにもなる)。
function buildTabContextMenu(tab) {
  const hasBridge = !!bridge;
  return [
    { label: "閉じる", run: () => closeTab(tab.id) },
    { label: "他のタブを閉じる", enabled: tabs.length > 1, run: () => closeOtherTabs(tab.id) },
    { label: "右側のタブを閉じる", enabled: tabs.indexOf(tab) < tabs.length - 1, run: () => closeTabsToRight(tab.id), separatorAfter: true },
    { label: "フルパスをコピー", enabled: !!tab.path, run: () => navigator.clipboard.writeText(tab.path).catch(() => {}) },
    { label: "エクスプローラーで表示", enabled: hasBridge && !!tab.path, run: () => bridge.postMessage({ type: "reveal-in-explorer", path: tab.path }) },
  ];
}
async function closeOtherTabs(keepId) {
  for (const id of tabs.filter((t) => t.id !== keepId).map((t) => t.id)) await closeTab(id);
}
async function closeTabsToRight(fromId) {
  const idx = tabs.findIndex((t) => t.id === fromId);
  if (idx < 0) return;
  for (const id of tabs.slice(idx + 1).map((t) => t.id)) await closeTab(id);
}
// 新規タブ用の空のタブオブジェクトを作る(共通部分。newTab/openInNewTab/closeTabの補充から使う)。
function makeEmptyTab() {
  const freshState = editor.createFreshState("");
  return {
    id: tabIdSeq++,
    guid: makeTabGuid(),
    path: null,
    fileName: "無題",
    encoding: null,
    lineEnding: null,
    readOnly: false,
    dirty: false,
    // 空の新規タブの基準は「空文書」そのもの(まだ何も入力していないのでdirtyではない)。
    // editorStateと同じcreateFreshState("")の結果からdocを取ることで、生成を1回で済ませる。
    savedDoc: freshState.doc,
    metaDirty: false,
    editorState: freshState,
    mode: "markdown",
    codeLanguage: null,
    sourceMode: false,
    scrollTop: 0,
    scrollLeft: 0,
    // 不具合3の修正: このタブのmode/codeLanguageがまだ「本来あるべき値(拡張子等からの
    // 判定結果)」に確定していないことを示すフラグ。applyOpenInTabがsetFileMode()の
    // 完了を待っている間にタブが切り替わってしまい適用を見送った場合にtrueにする
    // (詳しくはresolveTabFileMode参照)。
    modePending: false,
  };
}
// 不具合3の修正: タブ(tab)のmode/codeLanguageを「本来あるべき値」に確定させる。
// applyOpenInTabの初回と、modePending中のタブが再びアクティブになった時の再試行の
// 両方から呼ぶ共通処理。
//
// editor.setFileMode()はいつでも「現在アクティブなview」に対して作用する(タブ専用の
// 引数を取らない)ため、このタブが呼び出し中に非アクティブになった場合、結果を
// view.dispatchしてはいけない(=別タブを誤って書き換えてしまう。不具合3そのもの)。
// editor.setFileMode自身がその場合false(適用しなかった)を返す。しかしこれでは
// 「この呼び出しが返ってきた後もこのタブがまだアクティブか」までは分からない
// (editor.setFileMode内部ではeditor.js側のタブ非依存の世代でしか判定していないため)。
// そこでfileOpenGen(main.js側の「開く要求」世代)とactiveTabId(今アクティブなタブそのもの)の
// 両方をここで確認し、どちらも一致する場合だけこのタブへ反映する。一致しない場合は
// modePendingをtrueのままにしておき、次にこのタブへ切り替わった時点で再試行する
// (何度切り替えを挟んでも、最終的にタブがアクティブなまま留まればそこで確定する)。
async function resolveTabFileMode(tab) {
  const myGen = ++fileOpenGen;
  tab.modePending = false;
  await editor.setFileMode(tab.fileName, decideFileMode(tab.path, tab.fileName));
  if (myGen !== fileOpenGen || activeTabId !== tab.id) {
    tab.modePending = true; // 割り込まれた・非アクティブになった → 未確定のまま次回に持ち越す
    return;
  }
  Object.assign(tab, editor.getModeSnapshot());
  updateStatusMode();
}
// タブ切替。skipSaveCurrent:trueは、閉じた直後の補充など「もう現在の内容を保存する意味がない」
// 場合に使う(閉じたタブの内容をうっかり別タブへ上書きしないようにするため)。
function switchToTab(id, { skipSaveCurrent = false } = {}) {
  if (id === activeTabId) return;
  const next = tabs.find((t) => t.id === id);
  if (!next) return;
  if (!skipSaveCurrent) saveActiveTabSnapshot();
  activeTabId = id;
  // ローカル画像の基準フォルダ(editor.js resolveImageSrc)は、setEditorState()による
  // ライブプレビュー再構築が起きる"前"に切り替える(タブごとに文書のフォルダが違うため。
  // 後で切り替えるとタブ切替直後の最初の描画が古いタブの基準フォルダを使ってしまう)。
  editor.setDocumentPath(next.path);
  editor.setEditorState(next.editorState);
  editor.applyModeSnapshot({ mode: next.mode, codeLanguage: next.codeLanguage, sourceMode: next.sourceMode });
  resetAutoDetectState(); // 文書が変わるので内容からの自動判定の状態もタブごとにリセットする
  currentPath = next.path;
  setName(next.fileName);
  currentEncoding = next.encoding;
  currentLineEnding = next.lineEnding;
  setReadOnly(next.readOnly);
  // ダーティ判定の基準(computeIsDirty参照)もタブごとに切り替える。next.dirtyは
  // saveActiveTabSnapshotで書き戻された時点の判定結果をそのまま使う(savedDoc/metaDirtyと
  // 揃って保存されているため、ここで改めてcomputeIsDirty()し直さなくても整合する)。
  savedDocRef = next.savedDoc ?? null;
  metaDirty = next.metaDirty ?? false;
  setDirty(next.dirty);
  const scrollTop = next.scrollTop, scrollLeft = next.scrollLeft;
  requestAnimationFrame(() => {
    editor.view.scrollDOM.scrollTop = scrollTop || 0;
    editor.view.scrollDOM.scrollLeft = scrollLeft || 0;
  });
  updateCount();
  // 【不具合2の修正】検索パネルの「n / 総数」表示(ステータスバーのupdateCount()とは別物)。
  // ここを呼び忘れていたため、タブを切り替えても前のタブでの検索件数が表示されたまま残り、
  // 実際のハイライト件数(0件になりうる)とズレていた。refreshOpenSearchCount()自身が
  // パネル非表示時は何もしない実装なので、無条件に呼んで問題ない(検索パネルを開いていない
  // 通常のタブ切替では何も起きない)。newTab()/closeTab()もこの関数を経由するため、
  // 「タブを閉じたとき・新しいタブを開いたとき」も合わせて直る。
  refreshOpenSearchCount();
  updateStatusMeta();
  updateStatusMode();
  sidebar.setCurrentPath(currentPath);
  renderTabs();
  notifyTabsChanged();
  // タブ見出し(ボタン)のクリックでフォーカスがそちらへ移ったままだと、キー入力や
  // Ctrl+Z等のショートカット(CodeMirrorのkeymapはcontentDOMへフォーカスがある時だけ働く)が
  // 効かなくなるため、切替のたび本文へフォーカスを戻す。
  editor.focus();
  // 不具合3の修正: 前回アクティブだった間にモード確定を最後まで待てなかったタブなら、
  // ここで再試行する(結果を待たずに次の操作へ進んでよいのでawaitしない)。
  if (next.modePending) resolveTabFileMode(next);
}
// 新しいタブ(File > 新しいタブ、"+"ボタン)。空のMarkdown文書を追加してそこへ切り替える。
async function newTab() {
  saveActiveTabSnapshot();
  const tab = makeEmptyTab();
  tabs.push(tab);
  switchToTab(tab.id, { skipSaveCurrent: true });
  editor.focus();
}
// タブを閉じる。未保存(dirty)なら確認する(ブラウザ標準ダイアログは使わず、必ずpaneConfirmを使う)。
// キャンセルすれば何もしない。最後の1タブを閉じようとした場合は、空の新規タブで補充する
// (タブ形式でも「タブが0枚」という状態は作らない。ウィンドウ自体を閉じたい場合は
// 従来どおりFile>閉じる/Ctrl+Wを使う)。
async function closeTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (id === activeTabId) saveActiveTabSnapshot();
  if (tab.dirty) {
    const ok = await paneConfirm({
      title: "閉じますか?",
      message: `「${tab.fileName}」には保存されていない変更があります。閉じてもよろしいですか?`,
      okLabel: "閉じる",
      danger: true,
    });
    if (!ok) return;
  }
  // 確認待ちの間にタブ自体が既に閉じられている(多重操作)可能性への保険。
  const idx = tabs.indexOf(tab);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (tabs.length === 0) tabs.push(makeEmptyTab());
  if (id === activeTabId) {
    const nextIdx = Math.min(idx, tabs.length - 1);
    switchToTab(tabs[nextIdx].id, { skipSaveCurrent: true });
  } else {
    renderTabs();
    notifyTabsChanged();
  }
}
// displayModeの反映(apply-settingsのたび呼ばれる)。タブ形式が初めて有効になった時点で、
// 現在ウィンドウ形式で表示していた文書をそのまま最初のタブへ移行する。既にタブ運用中に
// 再度apply-settingsが届いた場合(通常の設定変更等)はtabsを一切いじらない
// (再構築すると編集中の内容・カーソル位置等を失ってしまうため)。
function applyDisplayMode(next) {
  const wasTab = displayMode === "tab";
  displayMode = next === "tab" ? "tab" : "window";
  if (displayMode === "tab" && !wasTab) {
    const tab = {
      id: tabIdSeq++,
      guid: makeTabGuid(),
      path: currentPath,
      fileName: currentName,
      encoding: currentEncoding,
      lineEnding: currentLineEnding,
      readOnly: isReadOnly,
      dirty: isDirty,
      // 今まさに画面に出している内容の基準(computeIsDirty参照)をそのままタブへ引き継ぐ。
      savedDoc: savedDocRef,
      metaDirty,
      editorState: editor.getEditorState(),
      ...editor.getModeSnapshot(),
      scrollTop: editor.view.scrollDOM.scrollTop,
      scrollLeft: editor.view.scrollDOM.scrollLeft,
    };
    tabs = [tab];
    activeTabId = tab.id;
    notifyTabsChanged();
  }
  renderTabs();
}
// C#側からのタブ追加要求("open-in-tab": コマンドライン引数・D&D・多重起動時のパイプ・
// 「最近使ったファイル」・サイドバー・グローバル検索・クイックオープン等、ファイルを開く
// 要求全般。C#側がdisplayMode==="tab"のときだけこのメッセージ型を使う)。
async function applyOpenInTab(msg) {
  if (displayMode !== "tab") {
    // 通常は届かないはずだが、設定の反映タイミングのずれ等への保険として
    // 従来のfile-openedと同じ挙動にフォールバックする。
    await applyFileOpened(msg);
    return;
  }
  saveActiveTabSnapshot();
  const tab = makeEmptyTab();
  tab.editorState = editor.createFreshState(msg.text ?? "");
  tab.path = msg.path ?? null;
  tab.fileName = msg.fileName;
  tab.encoding = msg.encoding;
  tab.lineEnding = msg.lineEnding;
  tab.readOnly = !!msg.readOnly;
  tab.dirty = false;
  // makeEmptyTab()時点のsavedDocは「空文書」の基準のままなので、いま読み込んだ内容に
  // 合わせて更新する(ここを取りこぼすと、内容がある状態のタブなのに毎回dirty判定されてしまう)。
  tab.savedDoc = tab.editorState.doc;
  tab.metaDirty = false;
  // createFreshStateは常にMarkdown初期状態のため、拡張子・記憶に基づく実際のモードを
  // 改めて適用する必要がある(applyFileOpenedと同じ決定ロジック)。modePending:trueにしておくと、
  // これから行うswitchToTab(このタブへの切替)が自動的にresolveTabFileMode()を呼んで
  // くれる(不具合3の修正。詳しくはresolveTabFileMode/switchToTabのコメント参照)。
  tab.modePending = true;
  tabs.push(tab);
  switchToTab(tab.id, { skipSaveCurrent: true });
}
// 自動保存(仕様書 N-06)のタブ全件対応。C#側から"request-all-tabs-text"が届いたら、
// 全タブの本文をまとめて返す(request-text/text-responseの単一文書版と同じ役割)。
function respondAllTabsText() {
  saveActiveTabSnapshot();
  bridge.postMessage({
    type: "all-tabs-text-response",
    tabs: tabs.map((t) => ({
      guid: t.guid,
      path: t.path,
      dirty: t.dirty,
      text: t.id === activeTabId ? editor.getValue() : t.editorState.doc.toString(),
      encoding: t.encoding,
      lineEnding: t.lineEnding,
    })),
  });
}
tabbarNewBtn?.addEventListener("click", () => newTab());

async function applyFileOpened(msg) {
  const myGen = ++fileOpenGen; // 不具合4の修正: このapplyFileOpened呼び出し自身の世代を確保
  pushClosedFile(currentPath);
  resetAutoDetectState(); // 文書が変わるので内容からの自動判定の状態(仕様書 第1章の拡張)もリセット
  // 拡張子だけでなく、拡張子ごとの既定モード上書き・ファイル単位の手動記憶も考慮する(仕様書 第1章)。
  await editor.setFileMode(msg.fileName, decideFileMode(msg.path ?? null, msg.fileName, msg.fileNameIsReal === true));
  // 不具合4の修正: awaitで待っている間により新しい「開く」要求(file-opened/open-in-tab/
  // new-document)が届いていたら、この呼び出しの結果はもう古い。currentPath/本文/ステータス
  // 表示を書き換えると、新しい要求で既に表示している内容を後から上書きして消してしまう
  // (症状: 後着のファイルが一瞬正しく表示された後、先着していた方の内容に巻き戻る)。
  if (myGen !== fileOpenGen) return;
  // 「.LOG」の自動追記(仕様書 第3章 N-15、メモ帳互換): 1行目が".LOG"だけのファイルを
  // 開いた直後、末尾へ日時を追記してdirty状態にする。読み取り専用ファイルは対象外
  // (保存できないものをdirty扱いにしても混乱を招くだけのため)。
  const firstLine = (msg.text ?? "").split(/\r?\n/, 1)[0];
  const isLogFile = firstLine === ".LOG" && !msg.readOnly;
  // ローカル画像の基準フォルダ(editor.js resolveImageSrc)を、本文を差し替える前に
  // 同期させる(switchToTabと同じ理由。setEditorValueQuietによる装飾再構築が
  // 新しい文書の内容に対して行われる時点で、既に新しいパスを参照できるようにする)。
  editor.setDocumentPath(msg.path ?? null);
  setEditorValueQuiet(msg.text);
  setName(msg.fileName);
  currentPath = msg.path ?? null;
  currentEncoding = msg.encoding;
  currentLineEnding = msg.lineEnding;
  setReadOnly(msg.readOnly);
  // ダーティ判定の基準(computeIsDirty参照)を、いま読み込んだ内容に確定させる。
  // ただし異常終了後の自動保存スナップショットからの復元(msg.recovered、仕様書 N-06)は
  // 例外: 「元ファイルの内容ではなく未保存の編集内容を表示する」ため、復元直後から
  // 意図的にdirty扱いにしたい。savedDocRefをnullのままにしておくことでcomputeIsDirty()が
  // 常にtrueを返すようにする(markSaved()は呼ばない)。
  if (!msg.recovered) markSaved();
  if (isLogFile) {
    const stamp = formatDateTimeStamp(new Date());
    const endPos = editor.view.state.doc.length;
    const insertText = (endPos > 0 ? "\n" : "") + stamp;
    // ファイルを開いた直後のプログラムによる変更のため、内容からの自動判定(仕様書 第1章の拡張)は
    // 走らせない(setEditorValueQuietと同じ抑制の仕組みを使う)。
    suppressNextAutoDetectChange = true;
    editor.view.dispatch({ changes: { from: endPos, insert: insertText }, selection: { anchor: endPos + insertText.length } });
    suppressNextAutoDetectChange = false;
    setDirty(true); // 追記した時点で未保存状態にする(仕様書どおり)
  } else {
    setDirty(!!msg.recovered); // 復元時はtrue、通常の読み込みはfalse(基準と一致しているため)
  }
  updateCount();
  updateStatusMeta();
  updateStatusMode();
  sidebar.setCurrentPath(currentPath); // files/treeパネルの現在ファイルハイライトを更新
  // グローバル検索のヒット行クリックからの遷移なら、指定行へジャンプする。
  // 開いたパスが期待と違う場合(保存確認でユーザーがキャンセルした等でC#側が別のファイルを
  // 返した/開かなかった場合)は、一致しないので保留を捨てるだけにする。
  if (pendingGotoLine) {
    if (pendingGotoLine.path === currentPath) editor.gotoLine(pendingGotoLine.line);
    pendingGotoLine = null;
  }
}
async function applyNewDocumentLocal(msg) {
  // 不具合4の修正: 自分の世代を進めておく。これにより、先行して実行中の遅い
  // applyFileOpened等がawaitから戻ってきたときに「自分は割り込まれた(=もう最新ではない)」と
  // 正しく判定できる(この関数自体はdecideFileMode(null,null)が常にmarkdownを返すため
  // 実質的に待機は発生しないが、対称性のため同じ仕組みに乗せておく)。
  const myGen = ++fileOpenGen;
  resetAutoDetectState(); // 文書が変わるので内容からの自動判定の状態(仕様書 第1章の拡張)もリセット
  // 無題の新規文書はパス・ファイル名とも無いため、decideFileMode(null, null)は常にmarkdownを返す。
  await editor.setFileMode(null, decideFileMode(null, null));
  if (myGen !== fileOpenGen) return;
  editor.setDocumentPath(null); // 無題文書には基準フォルダが無い(相対パスの画像は解決できない)
  setEditorValueQuiet("");
  setName("無題");
  currentPath = null;
  // 不具合修正: C#側(OpenNewDocument)がencoding/lineEndingを送ってくればそれを使う。
  // 送ってこない場合(ブラウザ単体検証・想定外の古い経路等)は設定由来の既定ラベルへ
  // フォールバックし、ステータスバーの文字コード・改行コードが空欄にならないようにする。
  currentEncoding = msg?.encoding || defaultEncodingLabel;
  currentLineEnding = msg?.lineEnding || defaultLineEndingLabel;
  // 新しい無題文書なので、直前の文書での「ステータスバーから明示的に変更した」状態は
  // 引き継がない(この文書はまだユーザーが何も変更していないため)。
  encodingSetExplicitly = false;
  lineEndingSetExplicitly = false;
  setReadOnly(false);
  markSaved(); // ダーティ判定の基準を「空文書」に確定させる
  setDirty(false);
  updateCount();
  updateStatusMeta();
  updateStatusMode();
  sidebar.setCurrentPath(null); // 無題の新規文書には対応するファイルが無いのでハイライトを外す
}

async function handleHostMessage(msg) {
  switch (msg?.type) {
    case "file-opened":
      await applyFileOpened(msg);
      // 起動直後の最初の1件だけ、白フラッシュ対策の「本文エリア描画済み」条件を満たす
      // (2件目以降=ユーザーが別のファイルを開いた場合はtrySignalInitialRenderReady内で無視される)。
      markInitialDocumentApplied();
      break;
    case "new-document":
      pushClosedFile(currentPath);
      await applyNewDocumentLocal(msg);
      markInitialDocumentApplied();
      break;
    case "open-in-tab":
      // タブ形式(仕様書 第2.10節 C-14): コマンドライン引数・D&D・多重起動時のパイプ・
      // 「最近使ったファイル」等、C#側がdisplayMode==="tab"のときにファイルを開く要求を
      // 新規ウィンドウの代わりにここへ送ってくる。
      await applyOpenInTab(msg);
      break;
    case "request-all-tabs-text":
      // 自動保存(仕様書 N-06)のタブ全件対応。request-text/text-responseの複数タブ版。
      respondAllTabsText();
      break;
    case "save-result":
      if (msg.ok) {
        // 名前を付けて保存で拡張子が変わった場合はモードを再判定する(不具合修正: 従来は
        // setName()するだけでeditor.setFileMode()を呼んでおらず、モードが古いままだった)。
        const prevExt = (currentName.split(".").pop() || "").toLowerCase();
        const nextExt = (msg.fileName.split(".").pop() || "").toLowerCase();
        const wasUntitled = !currentPath;
        setName(msg.fileName);
        currentPath = msg.path ?? currentPath;
        // 無題の新規文書が拡張子付きで保存された時点で、以後の内容からの自動判定
        // (仕様書 第1章の拡張)は行わない(拡張子が優先されるべきため)。
        if (wasUntitled && currentPath) autoDetectState.locked = true;
        currentEncoding = msg.encoding;
        currentLineEnding = msg.lineEnding;
        setReadOnly(false);
        markSaved(); // ダーティ判定の基準を「いま保存した内容」に確定させる(名前を付けて保存も含む)
        setDirty(false);
        updateStatusMeta();
        if (nextExt !== prevExt) {
          await editor.setFileMode(currentName, decideFileMode(currentPath, currentName));
          updateStatusMode();
        }
      }
      // キャンセル・失敗時はダーティ状態を維持する(msg.errorがあれば将来トースト表示等に使う)
      // switchFileFromSidebar()がsaveFileAndWait()で待っている場合はここで解決する
      // (成功・失敗いずれの場合も、待機側を永久に止めないよう解決する)。
      if (pendingSaveResolvers.length) {
        const resolvers = pendingSaveResolvers;
        pendingSaveResolvers = [];
        for (const resolve of resolvers) resolve();
      }
      break;
    case "request-text":
      // 自動保存(仕様書 N-06): C#側は本文を持たないため、要求されたら都度返す。
      bridge?.postMessage({ type: "text-response", text: editor.getValue() });
      break;
    case "request-is-document-empty":
      // ネイティブD&D(不具合修正、C#側MainForm.OnDragDrop)が「現在のウィンドウで開くか、
      // 新しいウィンドウで開くか」を判断するために問い合わせてくる。本文はC#側に無いため、
      // openFolder()のisEmptyDocument判定と同じ基準(editor.getValue().trim() === "")を
      // request-text/text-responseと同じ考え方で返す。
      // requestIdはC#側が付ける通し番号。どの問い合わせへの応答かを区別するため、
      // 受け取った値をそのまま返す(C#側MainForm._isDocumentEmptyRequestId参照)。
      bridge?.postMessage({ type: "is-document-empty-response", isEmpty: editor.getValue().trim() === "", requestId: msg.requestId });
      break;
    case "request-save":
      // 未保存の変更を残したまま閉じる/新規作成する/別ファイルを開く前の保存確認
      // (C#側ConfirmDiscardDirtyAsync)から届く。通常のCtrl+Sと同じ保存フローを使う。
      saveFile(false);
      break;
    case "request-dropped-file-fallback":
      // ファイルD&D(C#側MainForm.HandleOpenDroppedFileByName)がDragEnterで得たフルパスとの
      // 照合に失敗した場合の保険。名前+バイト列だけの「無題」文書として開く従来経路へ倒す。
      await fallbackOpenDroppedFile();
      break;
    case "apply-settings":
      // マークダウン記法拡張のON/OFF(仕様書 第2.10節 C-01)・最近使ったファイル(F-09)・
      // Pandoc導入状況・既定コピー形式。起動時と設定変更時、最近使ったファイル更新時に届く。
      editor.setExtensionToggles({
        callouts: msg.calloutsEnabled,
        // 既存コードはmsg.superSubEnabledという存在しないキーを参照しており、C#側が実際に
        // 送るキー名(superSubscriptEnabled)と食い違っていたため、上付き・下付きの設定が
        // 常にundefinedになり反映されていなかった(このバグを機に修正する)。
        superSub: msg.superSubscriptEnabled,
        highlight: msg.highlightEnabled,
        inlineMath: msg.inlineMathEnabled,
        mathAutoNumber: msg.mathAutoNumber,
        // 記法サポートのON/OFF(仕様書「記法サポート」節)。diagrams/codeBlockMath/autoLinksは
        // いずれもextTogglesField経由でライブプレビュー側の描画を切り替える。
        diagrams: msg.diagramsEnabled,
        codeBlockMath: msg.codeBlockMathEnabled,
        autoLinks: msg.autoLinksEnabled,
        // 編集の挙動(仕様書「編集」節)。
        codeAutoWrap: msg.codeAutoWrap,
        liveRenderingShowSourceOnFocus: msg.liveRenderingShowSourceOnFocus,
        emojiAutocomplete: msg.emojiAutocomplete,
        copyWholeLineWhenNoSelection: msg.copyWholeLineWhenNoSelection,
        typewriterKeepCaretCentered: msg.typewriterKeepCaretCentered,
        shiftTabAutoIndent: msg.shiftTabAutoIndent,
        autoPairMarkdown: msg.autoPairMarkdown,
        // 記法の書き方(メニューバーから作るときの形。仕様書「記法の書き方」節)。
        strictMode: msg.strictMode,
        codeBlockLineNumbers: msg.codeBlockLineNumbers,
        headingStyle: msg.headingStyle,
        unorderedListMarker: msg.unorderedListMarker,
        orderedListMarker: msg.orderedListMarker,
        indentSizeOnSave: msg.indentSizeOnSave,
        defaultCodeLanguage: msg.defaultCodeLanguage,
        defaultCodeLanguageApplyWhen: msg.defaultCodeLanguageApplyWhen,
        // 空白と改行・スマート置換(仕様書「空白と改行」「スマート置換」節)。
        whitespaceWhenWriting: msg.whitespaceWhenWriting,
        whitespaceOnExport: msg.whitespaceOnExport,
        smartQuotes: msg.smartQuotes,
        smartDashes: msg.smartDashes,
        recognizeUnicodePunctuation: msg.recognizeUnicodePunctuation,
      });
      // コードブロックのインデント幅(仕様書 codeIndentSize)。CodeMirrorのindentUnit・tabSizeを
      // 切り替える(タブ幅にも連動。詳細はeditor.js側のコメント参照)。
      editor.setCodeIndentSize(msg.codeIndentSize);
      // コードモードの折りたたみ(仕様書 codeFoldingEnabled、既定true)。
      editor.setCodeFolding(msg.codeFoldingEnabled !== false);
      // 依頼③: インデントガイドの表示モード("none"|"fold"|"all"、既定"fold")。
      // 旧バージョンのC#(未対応)からはmsg.codeIndentGuidesがundefinedで届くため、その場合は
      // 既定の"fold"を保つ(setCodeIndentGuides側で不正値を"fold"へ倒す)。
      editor.setCodeIndentGuides(msg.codeIndentGuides);
      // 現在行の強調表示(仕様書 codeActiveLineHighlight、既定true。コードモード限定)。
      // C#側が未対応の版ではundefinedで届くため、その場合は既定のONを保つ(他の項目と同じ流儀)。
      editor.setCodeActiveLineHighlight(msg.codeActiveLineHighlight !== false);
      // 自動ペアリング(仕様書 第2.10節 C-05、括弧・引用符)。setAutoPairing自体は既に実装済みだが
      // ここからの配線が抜けていたため、他の設定と同じ流儀で追加する。
      editor.setAutoPairing(msg.autoPairing !== false);
      // スペルチェック(仕様書 spellCheckEnabled)。.cm-contentのspellcheck属性を切り替える。
      // spellCheckAutoCorrect(自動修正)はWebView2側の機能でJSからは制御できないため未実装。
      editor.setSpellCheck(!!msg.spellCheckEnabled);
      // コード中のカラープレビュー(docs/カラープレビュー仕様.md、既定true)。
      // C#側が未対応の版ではundefinedで届くため、その場合は既定のONを保つ。
      editor.setColorPreviewInCode(msg.colorPreviewInCode !== false);
      // アウトラインに出す見出しの最大レベル(仕様書 chapterLevelInOutline、既定6)。
      // sidebar.jsは編集不可のため、共有の既定値(markdown-extras.jsのoutlineMaxLevel)を
      // ここで更新することでアウトライン・[toc]記法双方の絞り込みに反映させる。
      setOutlineMaxLevel(msg.chapterLevelInOutline ?? 6);
      defaultCopyFormat = msg.defaultCopyFormat ?? "markdown";
      pandocAvailable = !!msg.pandocAvailable;
      recentFiles = msg.recentFiles ?? [];
      // 文字コード・改行コードの既定値(仕様書「保存と復元」defaultEncoding/defaultLineEnding)。
      // フォールバック用のラベルを更新したうえで、無題かつ未編集の文書には設定変更を追従させる
      // (まだ何もタイプしていない=中身が既定値と紐付いている状態とみなせるため)。ただし
      // ステータスバーから明示的に変更済みの項目は、その場でユーザーが選んだ値を優先し、
      // 設定変更で勝手に上書きしない(仕様書6.1の「明示的に変更でき」を尊重する判断)。
      defaultEncodingLabel = encodingKeyToLabel(msg.defaultEncoding);
      defaultLineEndingLabel = lineEndingKeyToLabel(msg.defaultLineEnding);
      if (currentPath === null && !isDirty) {
        let metaChanged = false;
        const tab = activeTab();
        if (!encodingSetExplicitly && currentEncoding !== defaultEncodingLabel) {
          currentEncoding = defaultEncodingLabel;
          if (tab) tab.encoding = currentEncoding;
          metaChanged = true;
        }
        if (!lineEndingSetExplicitly && currentLineEnding !== defaultLineEndingLabel) {
          currentLineEnding = defaultLineEndingLabel;
          if (tab) tab.lineEnding = currentLineEnding;
          metaChanged = true;
        }
        if (metaChanged) updateStatusMeta();
      }
      // 表示形式(仕様書 第2.10節 C-14、隠し設定)。設定画面には切替UIが無いため、
      // settings.jsonを直接編集した場合のみ"tab"になる。
      applyDisplayMode(msg.displayMode);
      // エクスポート・印刷の詳細設定(仕様書「エクスポート・印刷」節)。届いたキーだけ上書きし、
      // 未指定のキーは既定値(exportSettingsの初期値)を保つ。
      for (const key of Object.keys(exportSettings)) {
        if (msg[key] !== undefined) exportSettings[key] = msg[key];
      }
      // テーマ(仕様書 第10.2節): 手動で切り替えた選択を永続化している。"system"ならOS設定
      // (index.htmlの起動時スクリプトが既に反映済み)のままにする。
      if (msg.theme === "light" || msg.theme === "dark") {
        document.documentElement.dataset.theme = msg.theme;
      }
      // テーマプリセット(仕様書 第2.10節 C-06)。src/themes.css側の
      // :root[data-theme="light"][data-light-theme="..."] 等のセレクタで上書きされる。
      // 未設定/不明な値でも属性自体は付けておき、"default"相当(上書きなし)にフォールバックする。
      document.documentElement.dataset.lightTheme = msg.lightTheme || "default";
      // useSeparateThemeInDarkMode(既定true)がfalseのときは、ダークモードでも
      // darkThemeのプリセットを適用しない(=lightThemeの選択をそのまま使う)。themes.css側の
      // ダーク用プリセットは"nord"/"dracula"/"solarized-dark"のIDにしか反応しないため、
      // ここにlightThemeの値(例: "sepia")を入れると一致するセレクタが無くなり、結果として
      // ダーク既定色(style.cssの無地の配色)のまま=darkThemeによる上書きが効かなくなる。
      document.documentElement.dataset.darkTheme =
        (msg.useSeparateThemeInDarkMode === false ? msg.lightTheme : msg.darkTheme) || "default";
      // CodeMirror側(キャレット色・選択範囲色)はgetComputedStyleで一度だけ色を読むため、
      // ライト/ダーク切替・プリセット切替のいずれでも都度refreshThemeして反映させる。
      editor.refreshTheme();
      // 本文の文字サイズ(Ctrl+マウスホイールでの変更を永続化している)
      editor.setFontSize(msg.editorFontSize || DEFAULT_FONT_SIZE);
      updateZoom();
      // 文字数カウントの表示(仕様書 V-13)。C#側にまだ受け口が無い場合はmsg.showWordCountが
      // undefinedになるため、その場合は既定のON(showWordCountの初期値)を維持する。
      if (typeof msg.showWordCount === "boolean") {
        showWordCount = msg.showWordCount;
        updateWordCountVisibility();
      }
      // 本文フォントと等幅フォント(仕様書 第2.10節 C-08)。
      // インラインスタイルで#cm-hostへ直接当てると、コードブロック・インラインコード・
      // コードモードのように「本文とは別に等幅を当てたい」箇所まで継承で巻き込んでしまい、
      // 等幅フォントの設定がまったく効かなくなっていた。CSSカスタムプロパティを上書きする
      // 形にして、本文用(--editor-font-body)と等幅用(--editor-font-mono)を
      // それぞれの箇所で使い分けられるようにする。
      // 未設定なら変数自体を消して、style.cssの既定(--font-body / --font-mono)へ戻す。
      const rootStyle = document.documentElement.style;
      host.style.fontFamily = ""; // 旧実装のインラインスタイルが残っていたら外す
      applyFontSetting(rootStyle, "--editor-font-body", msg.editorFontFamily, "本文フォント");
      applyFontSetting(rootStyle, "--editor-font-mono", msg.editorMonospaceFontFamily, "等幅フォント");
      // 本文の最大幅(0=テーマ既定)と行の高さ(仕様書 C-08)。style.css側が
      // --editor-max-width / --editor-line-height を参照する。
      const maxWidth = Number(msg.editorMaxWidthPx);
      if (Number.isFinite(maxWidth) && maxWidth > 0) rootStyle.setProperty("--editor-max-width", `${maxWidth}px`);
      else rootStyle.removeProperty("--editor-max-width");
      const lineHeight = Number(msg.editorLineHeight);
      if (Number.isFinite(lineHeight) && lineHeight > 0) rootStyle.setProperty("--editor-line-height", String(lineHeight));
      else rootStyle.removeProperty("--editor-line-height");
      // 本文の左右余白(仕様書 editorPaddingLeft/editorPaddingRight、既定どちらも32)。
      // style.css側が var(--editor-padding-left, 32px) / var(--editor-padding-right, 32px) を
      // 参照する想定。未指定(値自体が届いていない・数値でない)なら変数を消してCSS既定(32px)に
      // 戻すが、"0"は有効な値として扱う(不具合修正: 従来はeditorPaddingXが0のときも
      // "0以下や未指定"とまとめて判定していたため、余白を0にする設定が効かず既定の32pxのまま
      // だった。設定画面では最小値0を選べるため、この2つは区別する必要がある。「未設定」は
      // 「値自体が届いていない/数値として解釈できない」ことで判定し、0という値そのものは
      // 未設定と見なさない)。
      applyEditorPaddingSetting(rootStyle, "--editor-padding-left", msg.editorPaddingLeft);
      applyEditorPaddingSetting(rootStyle, "--editor-padding-right", msg.editorPaddingRight);
      // カスタムCSS(仕様書 第2.10節 C-07)。C#側がファイル内容を読み込んで文字列として送ってくる
      // (file://は仮想ホスト配下から読めないため)。<head>内の専用<style>要素のtextContentへ
      // 反映する(innerHTMLは使わない)。要素が無ければここで生成する。
      applyCustomCss(msg.customCss ?? "");
      // ここまでで本文エリアの色が確定する(テーマ・プリセット・カスタムCSSのすべて)。
      // その実描画色をネイティブのタイトルバーへ反映する。
      syncTitleBarColor();
      // キーバインド(仕様書 C-10)。既存のcommands配列を直接書き換えるため、メニューバー・
      // コマンドパレット・ショートカット待受けはいずれも再起動なしに新しい割り当てを拾う。
      keyBindings = msg.keyBindings ?? {};
      applyKeyBindings(commands, keyBindings);
      // 編集モード決定(仕様書 第1章)の優先順位2・3を上書きする設定。ブリッジが無い
      // ブラウザ単体動作ではapply-settings自体が届かないため、その場合は既定の空のままになる。
      fileModeOverrides = msg.fileModeOverrides ?? {};
      perFileModes = msg.perFileModes ?? {};
      // 内容からの編集モード自動判定(仕様書 第1章の拡張)。未指定・不明値は"standard"として扱う。
      autoDetectMode = AUTO_DETECT_MODES.has(msg.autoDetectMode) ? msg.autoDetectMode : "standard";
      // ステータスバー表示(仕様書 showStatusBar、既定true)。非表示時は#main-areaがflex:1で
      // 自動的に本文エリアの高さを吸収する(index.html側のレイアウトはそのまま)。
      statusbarEl.style.display = msg.showStatusBar === false ? "none" : "";
      // Ctrl+マウスホイールでの文字サイズ変更(仕様書 zoomWithCtrlWheel、既定true)。
      zoomWithCtrlWheelOn = msg.zoomWithCtrlWheel !== false;
      // サイドバーからのファイル切替時の保存確認スキップ(仕様書 saveWithoutAskingOnSwitch、既定false)。
      saveWithoutAskingOnSwitch = !!msg.saveWithoutAskingOnSwitch;
      // 読了時間の計算に使う語/分(仕様書 readingSpeedWpm、0=自動)。text-stats.js側のモジュール
      // 状態を更新するだけで、word-count.jsの詳細ポップアップにも(editor.getDetailedStats()経由で)
      // 自動的に反映される。
      setReadingSpeedWpm(msg.readingSpeedWpm ?? 0);
      // アウトラインパネルの折りたたみ可否(仕様書 collapsibleOutline、既定true)。
      if (typeof msg.collapsibleOutline === "boolean") sidebar.setCollapsibleOutline(msg.collapsibleOutline);
      // サイドバー幅(ユーザー要望2、既定240)。ドラッグでの変更を次回起動時に復元する。
      // 未指定(旧バージョンのC#側等)なら既定値のまま(sidebar.js内のSIDEBAR_WIDTH_DEFAULT)にする。
      if (typeof msg.sidebarWidthPx === "number") sidebar.setWidth(msg.sidebarWidthPx);
      // 起動時にアウトラインを既定表示するか(仕様書 showOutlineByDefault、既定false)。
      // 「起動時1回だけ」のため、以後のapply-settings再送では判定自体を行わない
      // (ユーザーが手で閉じた後に勝手に再度開かないようにするため)。
      if (!initialSidebarAutoOpenDone) {
        initialSidebarAutoOpenDone = true;
        if (msg.showOutlineByDefault) sidebar.open("outline");
      }
      // ツールチップの詳しさ(依頼2、仕様書 tooltipDetail、既定"standard")。
      setTooltipLevel(msg.tooltipDetail);
      // ここまでで本文エリアの色・フォント等、テーマに関わる設定はすべて確定している。
      // 白フラッシュ対策の「テーマ適用済み」条件を満たす(2回目以降の再送では
      // trySignalInitialRenderReady内で無視される)。
      markInitialSettingsApplied();
      break;
    case "image-inserted":
      // 画像挿入(仕様書 R-07)。C#側でファイルコピー・相対パス解決を終えたものが届く。
      editor.applyAction("image", { alt: msg.alt ?? "", path: msg.path ?? "" });
      break;
    case "export-done":
      // PNGエクスポート完了(成功・失敗いずれでも届く)。enterExportLayout()での展開を復元する。
      exitExportLayout();
      break;
    case "read-local-image-result":
      // HTMLエクスポートでのローカル画像data:埋め込み(requestLocalImageDataUri参照)の応答。
      // requestIdで対応するPromiseだけを解決する(複数画像を並行して要求しうるため)。
      if (typeof msg.requestId === "number") {
        const resolve = pendingLocalImageResolvers.get(msg.requestId);
        pendingLocalImageResolvers.delete(msg.requestId);
        resolve?.(msg.dataUri ?? null);
      }
      break;
    case "folder-loaded":
      // フォルダ読み込み結果(仕様書 第2.8節 S-02/S-03)。"open-folder"/"load-folder"に加え、
      // ファイルを開いた際の親フォルダ自動読み込みでも明示操作なしに届く。
      if (msg.error) {
        // クイックオープン用のfolderData(直近の成功データ)はそのまま残し、
        // サイドバーの表示にだけ失敗した旨を伝える。
        sidebar.setFolder({ error: msg.error });
      } else {
        folderData = msg;
        sidebar.setFolder(msg);
        // フォルダの読み込みに成功したら、サイドバーを開いてファイルツリーのタブへ切り替える
        // (ユーザー要望3)。この経路は「フォルダを開く」ダイアログ・起動時のcustomFolder設定・
        // コマンドラインからのフォルダ渡しのすべてが通る(いずれもC#側からfolder-loadedとして
        // 届く)ため、入口を分けずここ1箇所の変更で全経路をカバーできる。
        // ただし、ファイルを開いた際の親フォルダ自動読み込みや、削除/名前変更/新規作成後・
        // 設定変更後の再走査もfolder-loadedを通るため、そちらまでサイドバーを強制的に
        // 開いてツリーへ切り替えると「ファイルを開いただけなのにアウトラインを見ていたはずが
        // ツリーへ切り替わる」といった意図しない挙動になる。C#側(MainForm.cs)が
        // autoLoaded:trueとして区別してくれるので、それがtrueの間は何もしない。
        if (!msg.autoLoaded) sidebar.showPanel("tree");
      }
      break;
    case "search-results":
      // グローバル検索(仕様書 第2.6節 G-01/G-02)のヒットが逐次届く。
      sidebar.handleSearchResults(msg.hits ?? []);
      break;
    case "search-done":
      // グローバル検索の完了通知(打ち切り・エラー時もこのtypeで届く)。
      sidebar.handleSearchDone(msg);
      break;
    case "settings":
      // 設定画面(settings.js)からのget-settings応答。画面を開いていない/既に読み込み済みの
      // 場合は内部でno-opになる。
      settingsUI?.handleSettingsLoaded(msg);
      break;
    case "save-settings-result":
      settingsUI?.handleSaveResult(msg);
      break;
    case "update-available":
      // 起動時の更新確認(仕様書 U-06)で新しい版が見つかった。ここでは知らせるだけで、
      // 更新そのものは利用者が設定画面で「更新する」を押したときにしか始まらない。
      // 自動では消さない(autoHideMsを渡さない)。見逃すと次に気づくのは翌日になるため。
      showAdBanner(msg.message || `新しい版 ${msg.latestVersion || ""} があります`, {
        actionLabel: "更新する",
        onAction: () => bridge?.postMessage({ type: "open-settings-window", category: "versionInfo" }),
      });
      break;
    case "window-state":
      // 全画面表示(V-08)・常に手前に表示(V-12)の実際の状態はC#側(WinForms)が持ち、
      // トグル操作のたび・起動直後に届く。ここは表示専用(メニューのcheckedに反映するだけ)。
      windowState = { fullscreen: !!msg.fullscreen, alwaysOnTop: !!msg.alwaysOnTop };
      break;
    case "menu-command":
      // ネイティブメニュー(Pane/NativeMenu.cs)で項目が選ばれた。メニューバー/右クリック
      // メニューのどちらから開いたかに応じて、最後に開いた側(commands.jsが覚えている)へ
      // ルーティングする(コマンドの実装はC#側に持たせない。commands.js参照)。
      routeNativeMenuCommand(msg.id);
      break;
    case "menu-closed":
      // ネイティブメニューが選択なしで閉じられた。見出しのハイライト解除・外側クリック監視の
      // 解除を、開いていた側(メニューバー or 右クリックメニュー)だけに委ねる。
      routeNativeMenuClosed(msg.menu);
      break;
    // メニューバーのホバー切り替えは、以前はC#側(ポップアップのMouseMove監視)からの
    // "menu-hover-switch"通知を受けてここでルーティングしていたが、実機でその通知自体が
    // 一度も届かないことが確認された。現在はcommands.js側がメニューバーの見出しボタン自体の
    // mouseenterでホバーを検知して直接切り替えるため、C#からのメッセージは経由しない
    // (詳細はcommands.js initMenuBarのコメント参照)。
    case "menu-arrow-switch":
      // メニューのキーボード操作(ユーザー報告)。ポップアップ表示中に←→キーが押されたことを
      // C#側(Pane/NativeMenu.cs)が検知して知らせてくる。どのメニュー名へ実際に切り替えるかは
      // メニューバーの並び順を知っているcommands.js側(ホバー切り替えのhandleMenuHoverSwitchと
      // 同じopenNativeMenu経路を再利用)に委ねる。
      routeNativeMenuArrowSwitch(msg.menu, msg.direction);
      break;
  }
}

async function openFile() {
  if (bridge) {
    bridge.postMessage({ type: "open" });
    return;
  }
  if (window.showOpenFilePicker) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        types: [{ description: "Markdown / テキスト", accept: { "text/plain": [".md", ".markdown", ".mdown", ".txt"] } }],
      });
    } catch {
      return; // ユーザーによるキャンセル
    }
    const [handle] = handles;
    const file = await handle.getFile();
    resetAutoDetectState();
    await editor.setFileMode(file.name);
    setEditorValueQuiet(await file.text());
    currentHandle = handle;
    setName(file.name);
    markSaved(); // ダーティ判定の基準を「いま読み込んだ内容」に確定させる
    setDirty(false);
    updateCount();
    updateStatusMode();
    return;
  }
  fileInput.click();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  resetAutoDetectState();
  await editor.setFileMode(file.name);
  setEditorValueQuiet(await file.text());
  currentHandle = null;
  setName(file.name);
  markSaved();
  setDirty(false);
  updateCount();
  updateStatusMode();
  fileInput.value = "";
});

// 画像挿入(仕様書 docs/設定項目一覧.md「画像」節)の共通経路。メニュー「画像を挿入」の
// ファイルダイアログ以外(ドラッグ&ドロップ・クリップボードからの貼り付け・ブラウザ単体時の
// <input type=file>フォールバック)はいずれもWebView2の標準DOM File APIでは実パスが
// 分からないため、ここでバイト列化してC#側(imageInsertAction等の設定を反映する
// ImageInsertService)へ渡す。ブリッジが無いブラウザ単体動作ではdata URIとして直接埋め込む
// (相対パス保存ができないための開発確認用フォールバック)。
async function insertImageFile(file) {
  if (bridge) {
    const buf = await file.arrayBuffer();
    bridge.postMessage({
      type: "insert-image",
      dataBase64: arrayBufferToBase64(buf),
      name: file.name || "image.png",
    });
    return;
  }
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  editor.applyAction("image", { alt: (file.name || "image").replace(/\.[^.]+$/, ""), path: dataUrl });
}
function isImageFile(file) {
  if (file.type && file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(file.name || "");
}
// クリップボードから画像の実体を取り出す。
// filesだけでは取りこぼす場合があるためitemsも見る(スクリーンショットのように
// ファイル名を持たないビットマップは、環境によってfilesに現れないことがある)。
function findClipboardImage(clipboardData) {
  if (!clipboardData) return null;
  const fromFiles = Array.from(clipboardData.files ?? []).find((f) => isImageFile(f));
  if (fromFiles) return fromFiles;
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file") continue;
    if (!item.type || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}
// クリップボードのHTMLに「文章」が含まれているかどうか。
// ブラウザで画像を右クリックして「画像をコピー」した場合のHTMLは実質<img>だけで、
// タグを取り除くと何も残らない。この判定で「画像のコピー」と「文章ごとのコピー」を見分ける。
function htmlHasText(html) {
  if (!html) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.textContent ?? "").trim().length > 0;
}
imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  if (!file) return;
  await insertImageFile(file);
  imageInput.value = "";
});

// ウィンドウへのファイルD&D。WebView2は本文エリアではWebページとしてドラッグ&ドロップを
// 扱うため、HTML5の標準どおりdragoverでpreventDefault()しないとブラウザが既定で
// ドロップを拒否し、禁止マークが出て何も起きない(C#側のOLEドラッグ&ドロップ設定とは
// 無関係)。この既定動作はブリッジの有無に関わらず働くため、dragenter/dragoverの
// preventDefault()はブリッジがある場合(実アプリ)でも省略できない
// (不具合修正の経緯: 一度はC#側でWebView2のAllowExternalDropをfalseにし、ここのdragenter/
// dragover/dropをすべて素通りさせる方式を試みたが、それだと本文エリア上へドラッグしている間
// ずっと禁止マークが出る副作用が実機で確認され撤回した。AllowExternalDropは既定のtrueへ戻して
// あるため、ここでも通常のブラウザと同じ既定動作阻止(preventDefault)が必要)。
//
// 不具合修正: 標準のDOM File APIはセキュリティ上実パスを返さないため、ブリッジがある場合
// (実アプリ)、dropイベントで分かるのはファイル名とサイズ、そしてFileオブジェクト経由の
// バイト列のみで、そのままでは拡張子に基づくコードモード判定・保存先の特定ができない
// 「無題」の文書としてしか開けない。そこでdropハンドラは次の優先順位でC#へ渡す:
//   第1経路: WebView2公式のpostMessageWithAdditionalObjectsでFileそのものを渡し、
//            C#側がCoreWebView2File.Pathからフルパスを直接取得する(dropハンドラ内コメント参照)。
//   第2経路(保険): 上記APIが無い古いランタイムでは、バイト列を送らずファイル名+サイズだけを
//            "open-dropped-file-by-name"として送り、C#側がOnDragEnterで先取りしたフルパス
//            (Pane/MainForm.cs _pendingDragFiles参照)と照合する。照合できればフルパス経由の
//            正規の経路(拡張子に基づくコードモード判定が効く)で開かれる。
// ブリッジが無いブラウザ単体動作(開発確認用、WebView2を介さないため上記の仕組みが
// 使えない)では、従来どおりここで処理する。
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function hasFileDrag(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}
// C#側(MainForm.HandleOpenDroppedFileByName)がDragEnterで得たフルパスとの照合に失敗した場合の
// フォールバック用。直近のdropイベントで受け取ったFileオブジェクトを1件だけ覚えておき、
// C#から"request-dropped-file-fallback"が届いたときだけ、その中身(バイト列)を送る
// (毎回バイト列を送らないことで、通常経路=照合成功時の変換・送信コストを避ける設計。
// 大きいファイルをドロップしたときにも影響しない)。次のドロップが来れば単純に上書きする。
let pendingDroppedFile = null;
// captureフェーズ(第3引数true)で登録する。CodeMirror自身がエディタ内テキストの
// ドラッグ移動用にdragover/drop相当を独自処理しており、bubbleフェーズで登録すると
// そちらが先に処理してこちらまで届かない(stopPropagation等で握りつぶされる)ことがある。
window.addEventListener("dragenter", (e) => {
  if (hasFileDrag(e)) e.preventDefault();
}, true);
window.addEventListener("dragover", (e) => {
  if (hasFileDrag(e)) e.preventDefault();
}, true);
window.addEventListener("drop", async (e) => {
  logToHost("log", `drop event: hasFileDrag=${hasFileDrag(e)}, filesCount=${e.dataTransfer?.files?.length ?? 0}`);
  if (!hasFileDrag(e) || !e.dataTransfer.files.length) return;
  e.preventDefault();
  e.stopPropagation();
  // 複数ファイルが同時にドロップされても、扱うのは先頭の1件のみ(C#側MainForm.OnDragDropと
  // 同じ判断)。
  const file = e.dataTransfer.files[0];
  if (bridge) {
    // 実アプリ: どの経路でもC#がフォールバック(request-dropped-file-fallback)を要求して
    // くる可能性があるため、先にFileを覚えておく。
    pendingDroppedFile = file;
    // 第1経路(正規): WebView2公式のpostMessageWithAdditionalObjects(SDK 1.0.1774.30以降)。
    // 第2引数にDOMのFileを含むArrayLike(e.dataTransfer.filesそのまま)を渡すと、C#側の
    // WebMessageReceivedのAdditionalObjectsへCoreWebView2Fileとして届き、Pathプロパティで
    // フルパスが取れる(WebView2Feedback specs/WebMessageObjects.mdに記載の公式ユースケース)。
    // メッセージ本体にも従来同様name/sizeを載せる(C#側でAdditionalObjectsが空だった場合に
    // 従来の名前+サイズ照合へ倒すための判断材料)。画像かどうかの判定はここでは行わず、
    // C#側(IsImageFileForDrop)で一元処理する(画像なら本文挿入に分岐する既存挙動を保つ)。
    if (typeof bridge.postMessageWithAdditionalObjects === "function") {
      logToHost("log", `open-dropped-file-with-pathを送信(AdditionalObjects付き): name=${file.name}, size=${file.size}`);
      bridge.postMessageWithAdditionalObjects(
        { type: "open-dropped-file-with-path", name: file.name, size: file.size },
        e.dataTransfer.files,
      );
      return;
    }
    // 第2経路(保険): postMessageWithAdditionalObjectsが未定義の古いランタイムでは、
    // 従来どおり名前+サイズだけを送ってC#側の照合(DragEnterで先取りしたパスとの
    // 名前+サイズ照合)に任せる。バイト列はC#が照合に失敗してフォールバックを
    // 要求してきたときだけ送る(下のhandleHostMessageの"request-dropped-file-fallback"参照)。
    logToHost("log", `open-dropped-file-by-nameを送信: name=${file.name}, size=${file.size}`);
    bridge.postMessage({ type: "open-dropped-file-by-name", name: file.name, size: file.size });
    return;
  }
  // 画像ファイルのドロップは「このファイルを開く」ではなく「本文へ画像を挿入する」として扱う
  // (仕様書 docs/設定項目一覧.md「画像」節: 画像挿入の3経路の1つ)。
  if (isImageFile(file)) {
    await insertImageFile(file);
    return;
  }
  // ブラウザ単体時は新規ウィンドウを作れないため、本文が空でなければ確認のうえこのウィンドウで開く。
  const isEmptyDocument = editor.getValue().trim() === "";
  if (!isEmptyDocument && !(await paneConfirm({ title: "ドロップしたファイルを開きますか?", message: "現在の内容を閉じて、ドロップしたファイルを開きますか?", okLabel: "開く", danger: true }))) return;
  resetAutoDetectState();
  await editor.setFileMode(file.name);
  setEditorValueQuiet(await file.text());
  currentHandle = null;
  currentPath = null;
  setName(file.name);
  markSaved();
  setDirty(false);
  updateCount();
  updateStatusMode();
}, true);

// C#側(MainForm.HandleOpenDroppedFileByName)がDragEnterで得たフルパスとの照合に失敗した場合の
// 保険。直近にドロップされたFile(pendingDroppedFile)の中身を使い、名前+バイト列だけの
// 「無題」文書として開く従来経路("open-dropped-file"、C#側HandleOpenDroppedFile)へ送り直す。
async function fallbackOpenDroppedFile() {
  const file = pendingDroppedFile;
  pendingDroppedFile = null;
  if (!file) {
    // 通常はここに来ないはず(dropの直後にC#から返ってくる応答のため)。中断されたドラッグの
    // 遅延応答等、想定外の状況への保険としてログだけ残して何もしない。
    logToHost("error", "request-dropped-file-fallback: 直近にドロップされたファイルが見当たらない");
    return;
  }
  // 画像ファイルのドロップは「このファイルを開く」ではなく「本文へ画像を挿入する」として扱う
  // (isImageFile/insertImageFileはbridgeの有無に関わらず動く。実アプリではinsertImageFileが
  // 内部でinsert-imageメッセージとしてC#へバイト列を送る)。
  if (isImageFile(file)) {
    await insertImageFile(file);
    return;
  }
  const isEmptyDocument = editor.getValue().trim() === "";
  const buf = await file.arrayBuffer();
  logToHost("log", `open-dropped-fileを送信(フォールバック): name=${file.name}, size=${buf.byteLength}, newWindow=${!isEmptyDocument}`);
  bridge.postMessage({
    type: "open-dropped-file",
    name: file.name,
    dataBase64: arrayBufferToBase64(buf),
    newWindow: !isEmptyDocument,
  });
}

// switchFileFromSidebar()専用: saveFile()を呼び出し、対応する"save-result"が届くまで待つ。
// saveFile()自体はpostMessageを送るだけで完了を待たない(結果は非同期にhandleHostMessageへ
// 届く)ため、ここでPromise化して待機できるようにする。
function saveFileAndWait(forcePicker) {
  return new Promise((resolve) => {
    pendingSaveResolvers.push(resolve);
    saveFile(forcePicker);
  });
}

async function saveFile(forcePicker) {
  const text = editor.getValue();
  if (bridge) {
    bridge.postMessage({ type: "save", text, saveAs: !!forcePicker });
    return;
  }
  if (window.showSaveFilePicker) {
    if (!currentHandle || forcePicker) {
      try {
        currentHandle = await window.showSaveFilePicker({
          suggestedName: currentName === "無題" ? "無題.md" : currentName,
          types: [{ description: "Markdown", accept: { "text/plain": [".md"] } }],
        });
      } catch {
        return; // ユーザーによるキャンセル
      }
    }
    const writable = await currentHandle.createWritable();
    await writable.write(text);
    await writable.close();
    setName(currentHandle.name);
    markSaved(); // ダーティ判定の基準を「いま保存した内容」に確定させる
    setDirty(false);
    return;
  }
  // File System Access API 非対応ブラウザ向けのダウンロード保存
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = currentName === "無題" ? "無題.md" : currentName;
  a.click();
  URL.revokeObjectURL(a.href);
  // ダウンロード保存(ブラウザ単体フォールバック)には元ファイルという概念が無いため、
  // ダウンロードした時点の内容を基準にする(実ファイルへの保存ではないが、他の保存経路と
  // 同じくdirty表示を消す既存挙動に合わせる)。
  markSaved();
  setDirty(false);
}

document.getElementById("btn-theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  editor.refreshTheme();
  // 手動選択を永続化する(仕様書 第10.2節)。次回起動時もOS設定に戻らないようにする。
  bridge?.postMessage({ type: "set-theme", theme: next });
  // タイトルバーも本文エリアと同じ色に切り替える。
  syncTitleBarColor();
});
// 不具合修正: ステータスバーの「設定」ボタン(#btn-settings)はユーザー要望により削除した。
// 設定を開く手段自体はメニューバー右側の歯車ボタン(#btn-menu-settings、commands.js
// initMenuBar参照)とFile > 設定(Ctrl+,、commands.jsのfile.settingsコマンド)に残っている
// ため、入口が失われるわけではない。

window.addEventListener("beforeunload", (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ツールチップの詳しさ(依頼2)の初期反映。ブリッジ経由でapply-settingsが届けば
// 上のcase "apply-settings"側で既定"standard"から改めて上書きされるが、ブリッジが無い
// ブラウザ単体動作ではapply-settings自体が届かないため、ここで一度だけ既定値
// (DEFAULT_TOOLTIP_DETAIL="standard")を明示的に適用しておく。
refreshAllTooltips();
