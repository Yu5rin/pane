// 設定画面専用ウィンドウ(Pane/SettingsWindow.cs)のエントリポイント。
// dist/settings-window.htmlから読み込まれる。本文エディタ・メニューバー・
// ステータスバーは持たず、createSettings()をmode:"page"で使い、
// ウィンドウ全体に広がる形で設定画面だけを描画する。
//
// main.jsとは別のエントリだが、esbuildのsplitting(scripts/build.js)により
// settings.js/commands.js/file-types.js等の共通コードはチャンクとして共有される。
// editor.js(CodeMirror本体)は意図的に一切importしない(settings.js側もDEFAULT_FONT_SIZEを
// editor.jsから読まずローカル定数に持つよう変更済み)ため、このエントリのバンドルに
// CodeMirrorが巻き込まれることはない。
import { createSettings } from "./settings.js";
import { buildCommands, initContextMenu, routeNativeMenuCommand, routeNativeMenuClosed } from "./commands.js";

const bridge = window.chrome?.webview ?? null;

// ブラウザ既定の右クリックメニューを一切出さない(docs/コンテキストメニュー仕様.md 大原則1・第5節)。
// 設定ウィンドウはCodeMirror本体を持たないため、出すメニューは入力欄用の最小構成のみ
// (initContextMenu自身がinput/textareaかどうかを最優先判定する。それ以外の場所は
// resolveTreeにnullを返させ、何も表示しない)。
document.addEventListener("contextmenu", (e) => e.preventDefault(), true);

// 実機での不具合調査用ログ。main.jsのlogToHostと同じ作法でC#側のLoggerへ送る。
function logToHost(level, message) {
  console[level === "error" ? "error" : "log"](message);
  bridge?.postMessage({ type: "log", level, message: String(message) });
}
window.addEventListener("error", (e) => {
  logToHost("error", `JS未処理エラー: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  logToHost("error", `JS未処理のPromise拒否: ${e.reason}`);
});

// ---- 起動時の白フラッシュ対策(新方式) ----
// C#側(Pane/SettingsWindow.cs)はWebView2コントロール自体を"initial-render-ready"を受け取るまで
// 非表示にしている(main.js側の同名の仕組みと同じ考え方)。設定画面は"settings"応答
// (get-settingsの応答、下のbridgeリスナー参照)を受けてapplyTheme+handleSettingsLoadedで
// 初めてテーマ・内容を確定させるため、そこを「初期描画完了」の合図とする。
let initialRenderReadySent = false;
function signalInitialRenderReady() {
  if (initialRenderReadySent) return;
  initialRenderReadySent = true;
  // main.js側と同じ理由でrequestAnimationFrameを2回挟む(直前のDOM変更が確実に
  // 一度ペイントされてから通知する)。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      logToHost("log", "initial-render-ready送信(設定画面の初期描画完了)");
      bridge?.postMessage({ type: "initial-render-ready" });
    });
  });
}

// キーバインドタブ(「キーボード」カテゴリのコマンド一覧)専用の最小ctx。
// buildCommands()はコマンド配列を組み立てるだけで、run(実際の実行)はこのウィンドウからは
// 一度も呼ばれない(メニューバー・ショートカット待受けを持たないため)。
// getState().keyBindingsはbuildCommands内部の初回applyKeyBindings呼び出しにしか使われず、
// そこではcmd.defaultShortcutの初期化(=コマンド定義に書かれた既定値の記録)だけが意味を持つ。
// 実際に「今どのキーが割り当たっているか」の表示はsettings.js側がdraft.keyBindingsを
// 直接参照するため、ここを起動時の空オブジェクトのままにしても表示は正しくなる。
const commandsCtx = { bridge, getState: () => ({ keyBindings: {} }) };
const commands = buildCommands(commandsCtx);

const ctx = {
  bridge,
  commands,
  // 設定画面がキーバインド再設定中(「キーを押してください」状態)だけtrueにするフラグ。
  // main.js側ではcommands.jsのbindShortcutsがこれを見て全域ショートカットを止めるが、
  // この専用ウィンドウはbindShortcuts自体を使わないため、settings.js内部の整合性のためだけに
  // 保持する(参照する側が無くても書き込み先が無いとエラーになるため用意する)。
  shortcutsSuppressed: false,
};

const settingsUI = createSettings(ctx, { mode: "page" });

// 入力欄用の最小コンテキストメニュー(docs/コンテキストメニュー仕様.md 第5節)。
// このウィンドウにはCodeMirror本体が無いため、resolveTree自体は常にnull
// (initContextMenuが入力欄かどうかを自前で最優先判定するため、これで十分)。
initContextMenu(document, ctx, () => null);

// テーマ(仕様書 第10.2節・第2.10節 C-06)を"settings"応答の内容から適用する。
// index.html/main.js側の適用ロジックと同じ考え方: 手動選択(light/dark)があればそれを、
// "system"ならindex.html同様の起動時スクリプト(prefers-color-scheme)で決めた値のまま。
// プリセット(lightTheme/darkTheme)は常に反映する(未設定/不明値は"default"=上書き無し)。
function applyTheme(msg) {
  if (msg.theme === "light" || msg.theme === "dark") {
    document.documentElement.dataset.theme = msg.theme;
  }
  document.documentElement.dataset.lightTheme = msg.lightTheme || "default";
  document.documentElement.dataset.darkTheme = msg.darkTheme || "default";
}

// "settings"(get-settingsへの応答)と"save-settings-result"は、main.js相当のウィンドウでは
// handleHostMessageがsettingsUIへ振り分けている。この専用ウィンドウにはそのルーティング役が
// 無いため、ここで直接ブリッジを購読して振り分ける
// (settings.js自身は"browse-path-result"/"apply-settings"を独自に購読済みで、
// これらとは独立に共存できる)。
if (bridge) {
  bridge.addEventListener("message", (e) => {
    const msg = e && e.data;
    if (!msg) return;
    if (msg.type !== "settings") logToHost("log", `C#からのメッセージ受信: type=${msg.type}`);
    if (msg.type === "settings") {
      applyTheme(msg);
      settingsUI.handleSettingsLoaded(msg);
      // テーマ・設定画面の内容がここで確定する(=初期描画完了)。
      signalInitialRenderReady();
    } else if (msg.type === "save-settings-result") {
      settingsUI.handleSaveResult(msg);
    } else if (msg.type === "menu-command") {
      // 入力欄の右クリックメニュー(Pane/NativeMenu.cs)で項目が選ばれた。
      routeNativeMenuCommand(msg.id);
    } else if (msg.type === "menu-closed") {
      routeNativeMenuClosed(msg.menu);
    }
  });
}

// このウィンドウは画面全体が設定画面そのものなので、メニュー等からの明示操作を待たず
// 読み込み直後に表示する(get-settingsも内部でここから送信される)。
settingsUI.open();
