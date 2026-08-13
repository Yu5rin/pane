// 設定画面(仕様書 第2.10節 C-01〜C-14)。
// 製品相当のサイドバー形式(左: カテゴリ一覧、右: 設定項目)のモーダルオーバーレイを
// HTML側だけで組み立てる。C#側のブリッジは実装済みで、使うメッセージは以下の4つだけ:
//   送信 { type: "get-settings" }                         → 受信 { type: "settings", ...全項目... }
//   送信 { type: "save-settings", settings: {...全項目...} } → 受信 { type: "save-settings-result", ok, error }
// 上記2つの受信メッセージはmain.js側のhandleHostMessageから
// handleSettingsLoaded(msg) / handleSaveResult(msg) として本モジュールへ渡してもらう想定。
//
// createSettings(ctx) の戻り値: { open(category), close(), isOpen(), handleSettingsLoaded, handleSaveResult }
// ctxに期待するもの:
//   bridge      window.chrome.webview または null(無ければ「保存」できないが、画面自体は開ける)
//   commands    buildCommands(ctx)の戻り値(キーバインドタブの一覧に使う)
//   shortcutsSuppressed  真偽値の書き込み用フラグ。キーバインド再設定中はtrueにして、
//                        commands.js側の全域ショートカット発火を止めてもらう(bindShortcuts参照)。
import { FILE_TYPES, CATEGORIES } from "./file-types.js";
import { MENU_LABELS, isAssignableShortcut } from "./commands.js";
import { DEFAULT_FONT_SIZE } from "./editor.js";

// ---- アイコン(仕様書の絵文字禁止・アイコン規約: viewBox 0 0 24 24, stroke=currentColor) ----
const ICON_ATTRS = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const ICON_CLOSE = `<svg ${ICON_ATTRS}><path d="M6 6l12 12M18 6 6 18"/></svg>`;
const ICON_GENERAL = `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.5 7.5 0 0 0 0-2l1.9-1.4-2-3.4-2.2.6a7.6 7.6 0 0 0-1.7-1L14.9 3.5h-4l-.5 2.3a7.6 7.6 0 0 0-1.7 1l-2.2-.6-2 3.4L6.4 11a7.5 7.5 0 0 0 0 2l-1.9 1.4 2 3.4 2.2-.6a7.6 7.6 0 0 0 1.7 1l.5 2.3h4l.5-2.3a7.6 7.6 0 0 0 1.7-1l2.2.6 2-3.4z"/></svg>`;
const ICON_EDIT = `<svg ${ICON_ATTRS}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const ICON_MARKDOWN = `<svg ${ICON_ATTRS}><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>`;
const ICON_APPEARANCE = `<svg ${ICON_ATTRS}><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2s-.4-1.5-.9-2-.2-2 1-2H16a4 4 0 0 0 4-4c0-4.4-3.6-8-8-8Z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15" cy="8" r="1"/><circle cx="16.5" cy="12" r="1"/></svg>`;
const ICON_FILETYPES = `<svg ${ICON_ATTRS}><path d="M9 15l6-6"/><path d="M10 6l.7-.7a4 4 0 1 1 5.7 5.7l-.7.7"/><path d="M14 18l-.7.7a4 4 0 1 1-5.7-5.7l.7-.7"/></svg>`;
const ICON_KEYBOARD = `<svg ${ICON_ATTRS}><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12"/></svg>`;
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

// 編集モードの自動判定(仕様: C#側AppSettings.AutoDetectModeと同じ4値、既定はstandard)。
const AUTO_DETECT_MODES = ["off", "suggest", "standard", "aggressive"];

const NAV_ITEMS = [
  { id: "general", label: "一般", icon: ICON_GENERAL },
  { id: "edit", label: "編集", icon: ICON_EDIT },
  { id: "markdown", label: "マークダウン", icon: ICON_MARKDOWN },
  { id: "appearance", label: "外観", icon: ICON_APPEARANCE },
  { id: "fileTypes", label: "ファイルの関連付け", icon: ICON_FILETYPES },
  { id: "keybindings", label: "キーボード", icon: ICON_KEYBOARD },
];

// ブリッジが無い(ブラウザ単体)場合や、get-settingsの応答が届く前に使う初期値。
// C#側AppSettingsの既定値(Pane/SettingsService.cs)とおおむね揃えている。
const DEFAULTS = {
  displayMode: "window",
  startupBehavior: "restoreSession",
  associatedExtensions: [],
  preloadOnStartup: false,
  calloutsEnabled: true,
  superSubscriptEnabled: true,
  highlightEnabled: true,
  inlineMathEnabled: true,
  mathAutoNumberEnabled: false,
  defaultCopyFormat: "markdown",
  theme: "system",
  lightTheme: "default",
  darkTheme: "default",
  editorFontSize: DEFAULT_FONT_SIZE,
  strictMode: false,
  codeBlockLineNumbers: true,
  autoPairing: true,
  customCssPath: "",
  editorFontFamily: "",
  editorMonospaceFontFamily: "",
  autoDetectMode: "standard",
  showWordCount: true,
  keyBindings: {},
  defaultEncoding: "utf8",
  defaultLineEnding: "crlf",
  pandocAvailable: false,
  fileModeOverrides: {},
};

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

// ---- ファイルの関連付け(3階層チェックボックス)用の下ごしらえ ----
// FILE_TYPES/CATEGORIESは静的なので、カテゴリ→言語の対応づけは一度だけ計算しておく。
const CATEGORY_ORDER = Object.keys(CATEGORIES);
const TYPES_BY_CATEGORY = new Map(CATEGORY_ORDER.map((key) => [key, FILE_TYPES.filter((t) => t.category === key)]));
const ALL_EXTENSIONS = FILE_TYPES.flatMap((t) => t.extensions);
const MARKDOWN_EXTENSIONS = FILE_TYPES.find((t) => t.id === "markdown").extensions;

// ---- キーバインド捕捉時の組み合わせ文字列化 ----
// commands.jsのparseShortcut/matchesShortcutが解釈できる形("Ctrl+Shift+K"のように"+"区切り、
// 修飾子はCtrl/Shift/Alt)に合わせる。記号キーはcommands.js側もe.code(物理キー)で判定して
// いるため、ここでも同じ7キーだけはe.codeから逆引きし、Shift併用時にe.keyが別文字になる
// 問題(例: Shift+` は e.key が "~")を避ける。
const SYMBOL_CODE_REVERSE = { Backquote: "`", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Digit0: "0" };
function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const key = SYMBOL_CODE_REVERSE[e.code] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}

export function createSettings(ctx) {
  let overlay = null;
  let navEl = null;
  let contentEl = null;
  let msgEl = null;
  let saveBtn = null;

  let draft = null; // 編集中の値。get-settingsの応答(またはDEFAULTS)から作る作業コピー
  let dirty = false; // 未保存の変更があるか(閉じる際の確認に使う)
  let activeCategory = "general";

  // ファイルの関連付けタブの状態。draftが差し替わるたび(handleSettingsLoaded/open)に
  // selectedExtensionsだけ作り直す。開閉状態(expanded*)はタブを行き来しても保持したいので
  // draftとは別に、このモジュールが生きている間ずっと保持する。
  let selectedExtensions = new Set();
  const expandedCategories = new Set(CATEGORY_ORDER); // 既定: カテゴリは展開
  const expandedLanguages = new Set(); // 既定: 言語行は折りたたみ
  let extInputs = new Map();
  let langInputs = new Map();
  let catInputs = new Map();

  // 拡張子ごとの編集モード上書き(fileModeOverrides)タブの状態。
  // 行は入力途中(拡張子が空・重複)も許すため、draft.fileModeOverridesとは別に
  // {id, ext, mode}の配列で持ち、保存直前にbuildFileModeOverrides()で正規化する。
  let fmRows = [];
  let fmRowIdSeq = 0;
  let fmRowEls = new Map(); // id -> {rowEl, extInput, modeSelect, warnEl}(入力中の全行再描画を避けるため)

  // キーバインドタブの状態。
  let capturingCommandId = null;
  let activeCaptureCleanup = null; // タブ切替・保存・閉じる際に捕捉を強制終了させるための解除関数
  let captureRejectMessage = null; // 割り当て不可なキーを押した際、捕捉を続けたまま表示する案内文

  function isOpen() {
    return !!overlay;
  }

  function setMessage(text, isError) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.classList.toggle("error", !!isError);
  }

  function markDirty() {
    dirty = true;
    setMessage("", false);
  }

  function cancelActiveCapture() {
    if (activeCaptureCleanup) activeCaptureCleanup();
  }

  // ---- 開閉 ----
  function buildShell() {
    overlay = document.createElement("div");
    overlay.className = "settings-modal-overlay";
    overlay.innerHTML = `
      <div class="settings-modal" role="dialog" aria-modal="true" aria-label="設定">
        <div class="settings-modal-head">
          <div class="settings-modal-title">設定</div>
          <button type="button" class="settings-modal-close" aria-label="閉じる">${ICON_CLOSE}</button>
        </div>
        <div class="settings-modal-body">
          <nav class="settings-nav"></nav>
          <div class="settings-content"></div>
        </div>
        <div class="settings-modal-foot">
          <div class="settings-modal-msg"></div>
          <div class="settings-modal-actions">
            <button type="button" class="btn" data-act="cancel">キャンセル</button>
            <button type="button" class="btn primary" data-act="save">保存</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    navEl = overlay.querySelector(".settings-nav");
    contentEl = overlay.querySelector(".settings-content");
    msgEl = overlay.querySelector(".settings-modal-msg");
    saveBtn = overlay.querySelector('[data-act="save"]');
    overlay.querySelector(".settings-modal-close").addEventListener("click", requestClose);
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", requestClose);
    saveBtn.addEventListener("click", save);
    // 背景(オーバーレイ自身)をクリックした場合も閉じる(仕様書内の他オーバーレイと同様の慣習)。
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) requestClose(); });
    document.addEventListener("keydown", onDocumentKeydown, true);
  }

  function destroy() {
    cancelActiveCapture();
    document.removeEventListener("keydown", onDocumentKeydown, true);
    overlay?.remove();
    overlay = null;
    navEl = contentEl = msgEl = saveBtn = null;
    draft = null;
    dirty = false;
  }

  // Escapeで閉じる(仕様書)。キーバインド捕捉中はそちらを優先させ(行側のリスナーが処理する)、
  // ここでは何もしない。捕捉中かどうかはonKeydown側がcapturingCommandIdより先にリスナー登録
  // されているとは限らないため、ここで明示的に判定する。
  function onDocumentKeydown(e) {
    if (capturingCommandId) return;
    if (e.key === "Escape") { e.preventDefault(); requestClose(); }
  }

  function requestClose() {
    cancelActiveCapture();
    if (dirty && !window.confirm("保存されていない変更があります。閉じてもよろしいですか?")) return;
    destroy();
  }

  function open(category) {
    if (overlay) {
      if (category) { activeCategory = category; renderNav(); renderContent(); }
      return;
    }
    activeCategory = category || activeCategory || "general";
    dirty = false;
    buildShell();
    renderNav(); // カテゴリ一覧自体はdraft(get-settingsの応答)を待たずに出せる
    if (ctx.bridge) {
      draft = null;
      contentEl.innerHTML = '<div class="settings-loading">読み込んでいます…</div>';
      ctx.bridge.postMessage({ type: "get-settings" });
    } else {
      draft = clone(DEFAULTS);
      selectedExtensions = new Set(draft.associatedExtensions);
      fmRows = buildFmRows(draft.fileModeOverrides);
      renderContent();
    }
  }

  // main.jsのhandleHostMessageから"settings"受信時に呼ばれる。
  function handleSettingsLoaded(msg) {
    if (!overlay || draft) return; // 開いていない/既に読み込み済みなら無視(二重適用を避ける)
    draft = {
      displayMode: msg.displayMode ?? DEFAULTS.displayMode,
      startupBehavior: msg.startupBehavior ?? DEFAULTS.startupBehavior,
      preloadOnStartup: !!msg.preloadOnStartup,
      calloutsEnabled: msg.calloutsEnabled ?? DEFAULTS.calloutsEnabled,
      superSubscriptEnabled: msg.superSubscriptEnabled ?? DEFAULTS.superSubscriptEnabled,
      highlightEnabled: msg.highlightEnabled ?? DEFAULTS.highlightEnabled,
      inlineMathEnabled: msg.inlineMathEnabled ?? DEFAULTS.inlineMathEnabled,
      mathAutoNumberEnabled: msg.mathAutoNumberEnabled ?? DEFAULTS.mathAutoNumberEnabled,
      defaultCopyFormat: msg.defaultCopyFormat ?? DEFAULTS.defaultCopyFormat,
      theme: msg.theme ?? DEFAULTS.theme,
      lightTheme: msg.lightTheme ?? DEFAULTS.lightTheme,
      darkTheme: msg.darkTheme ?? DEFAULTS.darkTheme,
      editorFontSize: Number.isFinite(msg.editorFontSize) ? msg.editorFontSize : DEFAULTS.editorFontSize,
      strictMode: !!msg.strictMode,
      codeBlockLineNumbers: msg.codeBlockLineNumbers ?? DEFAULTS.codeBlockLineNumbers,
      autoPairing: msg.autoPairing ?? DEFAULTS.autoPairing,
      customCssPath: msg.customCssPath ?? "",
      editorFontFamily: msg.editorFontFamily ?? "",
      editorMonospaceFontFamily: msg.editorMonospaceFontFamily ?? "",
      autoDetectMode: AUTO_DETECT_MODES.includes(msg.autoDetectMode) ? msg.autoDetectMode : DEFAULTS.autoDetectMode,
      showWordCount: msg.showWordCount ?? DEFAULTS.showWordCount,
      keyBindings: msg.keyBindings ? { ...msg.keyBindings } : {},
      defaultEncoding: msg.defaultEncoding ?? DEFAULTS.defaultEncoding,
      defaultLineEnding: msg.defaultLineEnding ?? DEFAULTS.defaultLineEnding,
      associatedExtensions: Array.isArray(msg.associatedExtensions) ? msg.associatedExtensions.slice() : [],
      pandocAvailable: !!msg.pandocAvailable,
      fileModeOverrides: msg.fileModeOverrides && typeof msg.fileModeOverrides === "object" ? { ...msg.fileModeOverrides } : {},
      // 保存対象ではない(表示にのみ使う)。C#側から届かない/空の場合はフォント選択欄が
      // テキスト入力にフォールバックする(renderFontField参照)。
      installedFonts: Array.isArray(msg.installedFonts) ? msg.installedFonts.slice() : [],
      monospaceFonts: Array.isArray(msg.monospaceFonts) ? msg.monospaceFonts.slice() : [],
    };
    selectedExtensions = new Set(draft.associatedExtensions);
    fmRows = buildFmRows(draft.fileModeOverrides);
    dirty = false;
    renderNav();
    renderContent();
  }

  // fileModeOverrides({拡張子: モード})→ 編集用の行配列に変換する。
  function buildFmRows(overrides) {
    return Object.entries(overrides ?? {}).map(([ext, mode]) => ({ id: ++fmRowIdSeq, ext, mode: mode || "markdown" }));
  }

  function buildSavePayload() {
    return {
      displayMode: draft.displayMode,
      startupBehavior: draft.startupBehavior,
      preloadOnStartup: draft.preloadOnStartup,
      calloutsEnabled: draft.calloutsEnabled,
      superSubscriptEnabled: draft.superSubscriptEnabled,
      highlightEnabled: draft.highlightEnabled,
      inlineMathEnabled: draft.inlineMathEnabled,
      mathAutoNumberEnabled: draft.mathAutoNumberEnabled,
      defaultCopyFormat: draft.defaultCopyFormat,
      theme: draft.theme,
      lightTheme: draft.lightTheme,
      darkTheme: draft.darkTheme,
      editorFontSize: draft.editorFontSize,
      strictMode: draft.strictMode,
      codeBlockLineNumbers: draft.codeBlockLineNumbers,
      autoPairing: draft.autoPairing,
      customCssPath: draft.customCssPath ? draft.customCssPath : null,
      editorFontFamily: draft.editorFontFamily ? draft.editorFontFamily : null,
      editorMonospaceFontFamily: draft.editorMonospaceFontFamily ? draft.editorMonospaceFontFamily : null,
      autoDetectMode: draft.autoDetectMode,
      showWordCount: draft.showWordCount,
      keyBindings: draft.keyBindings,
      defaultEncoding: draft.defaultEncoding,
      defaultLineEnding: draft.defaultLineEnding,
      associatedExtensions: Array.from(selectedExtensions),
      fileModeOverrides: buildFileModeOverrides(),
    };
  }

  // fmRows(入力途中の状態を含む行配列)→ 保存用の{拡張子: モード}に正規化する。
  // 拡張子が空の行は捨て、先頭ドットを除去して小文字化する。重複時は後勝ち。
  function normalizeExtKey(text) {
    return String(text ?? "").trim().replace(/^\./, "").toLowerCase();
  }
  function buildFileModeOverrides() {
    const result = {};
    for (const row of fmRows) {
      const key = normalizeExtKey(row.ext);
      if (!key) continue;
      result[key] = row.mode;
    }
    return result;
  }

  function save() {
    cancelActiveCapture();
    if (!ctx.bridge) {
      // ブリッジが無いブラウザ単体動作では永続化先(C#側AppSettings)が無いため保存できない。
      // 画面自体は最後まで操作できるようにしておき、保存時にのみ案内する(仕様書の指示どおり)。
      window.alert("設定の保存はデスクトップアプリ版でのみ利用できます。");
      return;
    }
    if (!draft) return;
    saveBtn.disabled = true;
    setMessage("保存しています…", false);
    ctx.bridge.postMessage({ type: "save-settings", settings: buildSavePayload() });
  }

  // main.jsのhandleHostMessageから"save-settings-result"受信時に呼ばれる。
  function handleSaveResult(msg) {
    if (!overlay) return;
    if (saveBtn) saveBtn.disabled = false;
    if (msg.ok) {
      dirty = false;
      destroy();
    } else {
      setMessage(msg.error || "設定を保存できませんでした。", true);
    }
  }

  // ---- ナビゲーション(左のカテゴリ一覧) ----
  function renderNav() {
    navEl.innerHTML = NAV_ITEMS.map((item) =>
      `<button type="button" class="settings-nav-item${item.id === activeCategory ? " active" : ""}" data-cat="${item.id}">${item.icon}<span>${item.label}</span></button>`
    ).join("");
    for (const btn of navEl.querySelectorAll("[data-cat]")) {
      btn.addEventListener("click", () => {
        if (btn.dataset.cat === activeCategory) return;
        activeCategory = btn.dataset.cat;
        renderNav();
        renderContent();
      });
    }
  }

  // ---- 右側(設定項目)の共通ヘルパー ----
  // ラジオ(name属性でグループ化。nameがそのままdraftのキー)・チェックボックス・セレクト・
  // テキスト/数値入力のうち、data-field(またはラジオはname)属性が付いた要素をまとめて
  // draftへ双方向で結びつける。「一般」「編集」「マークダウン」「外観」の4カテゴリはこれだけで
  // 済むため、カテゴリごとの個別配線コードを持たずに済ませる。
  function wireCommonFields(container) {
    const radioNames = new Set(Array.from(container.querySelectorAll('input[type="radio"][name]')).map((r) => r.name));
    for (const name of radioNames) {
      for (const r of container.querySelectorAll(`input[type="radio"][name="${name}"]`)) {
        r.checked = draft[name] === r.value;
        r.addEventListener("change", () => { if (r.checked) { draft[name] = r.value; markDirty(); } });
      }
    }
    for (const cb of container.querySelectorAll('input[type="checkbox"][data-field]')) {
      const key = cb.dataset.field;
      cb.checked = !!draft[key];
      cb.addEventListener("change", () => { draft[key] = cb.checked; markDirty(); });
    }
    for (const sel of container.querySelectorAll("select[data-field]")) {
      const key = sel.dataset.field;
      sel.value = draft[key];
      sel.addEventListener("change", () => { draft[key] = sel.value; markDirty(); });
    }
    for (const inp of container.querySelectorAll('input[type="text"][data-field]')) {
      const key = inp.dataset.field;
      inp.value = draft[key] ?? "";
      inp.addEventListener("input", () => { draft[key] = inp.value; markDirty(); });
    }
    // 数値入力(文字サイズ)は打鍵のたびではなく確定時(change=blur/Enter)にだけ範囲を丸める
    // (入力途中の値をその都度clampすると桁を打っている最中に値が飛んで打ちにくくなるため)。
    for (const inp of container.querySelectorAll('input[type="number"][data-field]')) {
      const key = inp.dataset.field;
      inp.value = draft[key] ?? "";
      inp.addEventListener("change", () => {
        let n = Math.round(Number(inp.value));
        if (!Number.isFinite(n)) n = DEFAULTS[key];
        const min = Number(inp.min), max = Number(inp.max);
        if (Number.isFinite(min)) n = Math.max(min, n);
        if (Number.isFinite(max)) n = Math.min(max, n);
        inp.value = n;
        draft[key] = n;
        markDirty();
      });
    }
  }

  // ---- 各カテゴリの描画 ----
  function renderGeneral(el) {
    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-title">起動時の動作</div>
        <label class="settings-radio"><input type="radio" name="startupBehavior" value="restoreSession"><span>前回開いていたファイルを復元する</span></label>
        <label class="settings-radio"><input type="radio" name="startupBehavior" value="blank"><span>何も開かない</span></label>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">表示形式</div>
        <label class="settings-radio"><input type="radio" name="displayMode" value="window"><span>ウィンドウ形式</span></label>
        <label class="settings-radio settings-radio-disabled"><input type="radio" name="displayMode" value="tab" disabled><span>タブ形式<span class="settings-badge">準備中</span></span></label>
      </div>
      <div class="settings-group">
        <label class="settings-checkbox-row"><input type="checkbox" data-field="preloadOnStartup"><span class="settings-checkbox-title">PCの起動時に常駐して起動を速くする</span></label>
      </div>`;
    wireCommonFields(el);
  }

  function renderEdit(el) {
    el.innerHTML = `
      <div class="settings-group">
        <label class="settings-checkbox-row"><input type="checkbox" data-field="autoPairing"><span class="settings-checkbox-title">自動ペアリング<span class="settings-field-desc">括弧・引用符を入力すると自動的に閉じます</span></span></label>
        <label class="settings-checkbox-row"><input type="checkbox" data-field="strictMode"><span class="settings-checkbox-title">厳格モード<span class="settings-field-desc">見出しやリスト記号の記法を厳密に解釈します</span></span></label>
      </div>
      <div class="settings-group">
        <label class="settings-select-row">既定の文字コード
          <select data-field="defaultEncoding">
            <option value="utf8">UTF-8</option>
            <option value="utf8bom">UTF-8 (BOM付き)</option>
            <option value="utf16le">UTF-16 LE</option>
            <option value="utf16be">UTF-16 BE</option>
            <option value="shiftjis">Shift_JIS</option>
          </select>
        </label>
        <label class="settings-select-row">既定の改行コード
          <select data-field="defaultLineEnding">
            <option value="crlf">CRLF</option>
            <option value="lf">LF</option>
            <option value="cr">CR</option>
          </select>
        </label>
        <label class="settings-select-row">コピー形式
          <select data-field="defaultCopyFormat">
            <option value="markdown">マークダウン</option>
            <option value="html">HTML</option>
          </select>
          <span class="settings-field-desc">他アプリへ貼り付けるときに書式を保つか</span>
        </label>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">編集モードの自動判定</div>
        <p class="settings-intro">通常は拡張子から編集モードを判断します。無題の新規文書では、内容からも判断できます。</p>
        <label class="settings-radio"><input type="radio" name="autoDetectMode" value="off"><span>オフ<span class="settings-field-desc">内容からは判断しません</span></span></label>
        <label class="settings-radio"><input type="radio" name="autoDetectMode" value="suggest"><span>控えめ<span class="settings-field-desc">切り替えず、ステータスバーで提案だけします</span></span></label>
        <label class="settings-radio"><input type="radio" name="autoDetectMode" value="standard"><span>標準(推奨)<span class="settings-field-desc">無題の新規文書のみ自動で切り替えます。切り替え後に取り消せます</span></span></label>
        <label class="settings-radio"><input type="radio" name="autoDetectMode" value="aggressive"><span>積極的<span class="settings-field-desc">拡張子のあるファイルでも、内容と食い違う場合は提案します</span></span></label>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">拡張子ごとの編集モード</div>
        <p class="settings-intro">通常は拡張子から自動で判断します。ここに登録した拡張子だけ、指定したモードで開きます。</p>
        <div class="fm-list"></div>
        <button type="button" class="btn tiny fm-add">+ 追加</button>
      </div>`;
    wireCommonFields(el);
    renderFmRows(el.querySelector(".fm-list"));
    el.querySelector(".fm-add").addEventListener("click", () => {
      fmRows.push({ id: ++fmRowIdSeq, ext: "", mode: "markdown" });
      renderFmRows(el.querySelector(".fm-list"));
      markDirty();
      el.querySelector(".fm-row:last-child .fm-ext")?.focus();
    });
  }

  // ---- 拡張子ごとの編集モード上書き(fileModeOverrides)の行描画 ----
  // 1文字入力するたびに全行を再構築するとフォーカス・キャレット位置が飛ぶため、
  // 行の増減(追加・削除)時だけDOMを作り直し、入力自体は既存要素へ直接反映する。
  function renderFmRows(listEl) {
    listEl.innerHTML = fmRows.map((row) => `
      <div class="fm-row" data-row-id="${row.id}">
        <input type="text" class="fm-ext" placeholder=".js">
        <select class="fm-mode">
          <option value="markdown">Markdown</option>
          <option value="code">コード</option>
          <option value="plain">プレーンテキスト</option>
        </select>
        <button type="button" class="icon-btn fm-remove" aria-label="削除">${ICON_CLOSE}</button>
        <span class="kb-cell-warn fm-warn"></span>
      </div>`).join("");
    fmRowEls = new Map();
    for (const row of fmRows) {
      const rowEl = listEl.querySelector(`[data-row-id="${row.id}"]`);
      const extInput = rowEl.querySelector(".fm-ext");
      const modeSelect = rowEl.querySelector(".fm-mode");
      const warnEl = rowEl.querySelector(".fm-warn");
      extInput.value = row.ext;
      modeSelect.value = row.mode;
      fmRowEls.set(row.id, { rowEl, extInput, modeSelect, warnEl });
      extInput.addEventListener("input", () => {
        row.ext = extInput.value;
        updateFmWarnings();
        markDirty();
      });
      modeSelect.addEventListener("change", () => {
        row.mode = modeSelect.value;
        markDirty();
      });
      rowEl.querySelector(".fm-remove").addEventListener("click", () => {
        fmRows = fmRows.filter((r) => r.id !== row.id);
        renderFmRows(listEl);
        markDirty();
      });
    }
    updateFmWarnings();
  }

  // 正規化後の拡張子キーが重複している行に警告を出す(保存自体は後勝ちで許可)。
  function updateFmWarnings() {
    const counts = new Map();
    for (const row of fmRows) {
      const key = normalizeExtKey(row.ext);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const row of fmRows) {
      const els = fmRowEls.get(row.id);
      if (!els) continue;
      const key = normalizeExtKey(row.ext);
      const dup = !!key && counts.get(key) > 1;
      els.warnEl.textContent = dup ? "拡張子が重複しています" : "";
      els.rowEl.classList.toggle("fm-row-dup", dup);
    }
  }

  function renderMarkdownCategory(el) {
    el.innerHTML = `
      <div class="settings-group">
        <label class="settings-checkbox-row"><input type="checkbox" data-field="calloutsEnabled"><span class="settings-checkbox-title">Callouts<span class="settings-field-desc">例: <code>&gt; [!NOTE]</code></span></span></label>
        <label class="settings-checkbox-row"><input type="checkbox" data-field="superSubscriptEnabled"><span class="settings-checkbox-title">上付き・下付き<span class="settings-field-desc">例: <code>x^2^</code>、<code>H~2~O</code></span></span></label>
        <label class="settings-checkbox-row"><input type="checkbox" data-field="highlightEnabled"><span class="settings-checkbox-title">ハイライト<span class="settings-field-desc">例: <code>==ハイライト==</code></span></span></label>
        <label class="settings-checkbox-row"><input type="checkbox" data-field="inlineMathEnabled"><span class="settings-checkbox-title">インライン数式<span class="settings-field-desc">例: <code>$E=mc^2$</code></span></span></label>
        <label class="settings-checkbox-row"><input type="checkbox" data-field="mathAutoNumberEnabled"><span class="settings-checkbox-title">数式の自動採番<span class="settings-field-desc">数式ブロック(<code>$$...$$</code>)に通し番号を振ります</span></span></label>
        <label class="settings-checkbox-row"><input type="checkbox" data-field="codeBlockLineNumbers"><span class="settings-checkbox-title">コードブロックの行番号<span class="settings-field-desc">フェンス付きコードブロックの左に行番号を表示します</span></span></label>
      </div>`;
    wireCommonFields(el);
  }

  // ---- フォント選択欄(本文/等幅)----
  // installedFonts/monospaceFontsが届いている場合はドロップダウン、届かない/空の場合は
  // 従来どおりのテキスト入力にフォールバックする。どちらの場合もdata-field/data-font-preview
  // 属性を付けておき、wireCommonFields(既存の汎用配線)とwireFontPreviews(プレビュー反映)の
  // 両方から同じ要素を扱えるようにする。
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fontOptionHtml(name, selected) {
    const label = escapeHtml(name);
    // CSS文字列(font-family: '...')としてのエスケープ→HTML属性としてのエスケープの順で行う
    // (フォント名に ' や \ が含まれていても壊れないように)。
    const cssName = String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const styleAttr = escapeHtml(`font-family: '${cssName}'`);
    return `<option value="${label}" style="${styleAttr}"${selected ? " selected" : ""}>${label}</option>`;
  }
  function renderFontField(key, list, labelText, placeholder) {
    const current = draft[key] || "";
    if (!Array.isArray(list) || !list.length) {
      // フォールバック: 従来どおりのテキスト入力(ブラウザ単体・C#側が未対応の場合)。
      return `<label class="settings-text-row">${labelText}
          <input type="text" data-field="${key}" data-font-preview placeholder="${escapeHtml(placeholder)}">
        </label>`;
    }
    // 保存済みの値が一覧に無くても選択状態を保つため、先頭付近(既定の直後)に追加しておく。
    const options = list.slice();
    if (current && !options.includes(current)) options.unshift(current);
    const optionsHtml = options.map((f) => fontOptionHtml(f, f === current)).join("");
    return `<label class="settings-select-row">${labelText}
        <select data-field="${key}" data-font-preview>
          <option value=""${current === "" ? " selected" : ""}>(既定)</option>
          ${optionsHtml}
        </select>
      </label>`;
  }
  // data-font-preview付きの入力/セレクトの現在値を、対応するdata-font-preview-target要素の
  // font-familyへ即時反映する。style属性の文字列組み立てではなくstyle.fontFamilyへの代入で
  // 行うため、フォント名のエスケープを気にする必要がない。
  function wireFontPreviews(container) {
    for (const field of container.querySelectorAll("[data-font-preview]")) {
      const key = field.dataset.field;
      const target = container.querySelector(`[data-font-preview-target="${key}"]`);
      if (!target) continue;
      const apply = () => { target.style.fontFamily = field.value ? `'${field.value}'` : ""; };
      apply();
      field.addEventListener(field.tagName === "SELECT" ? "change" : "input", apply);
    }
  }

  function renderAppearance(el) {
    el.innerHTML = `
      <div class="settings-group">
        <label class="settings-select-row">テーマ
          <select data-field="theme">
            <option value="system">システムに合わせる</option>
            <option value="light">ライト</option>
            <option value="dark">ダーク</option>
          </select>
        </label>
        ${renderFontField("editorFontFamily", draft.installedFonts, "本文フォント", "(既定のフォントを使用)")}
        <div class="settings-field-desc">プレビュー: <span data-font-preview-target="editorFontFamily" style="font-size: 15px;">あア亜 Aa Bb Cc 0123</span></div>
        ${renderFontField("editorMonospaceFontFamily", draft.monospaceFonts, "等幅フォント", "(既定のフォントを使用)")}
        <div class="settings-field-desc">プレビュー: <span data-font-preview-target="editorMonospaceFontFamily" style="font-size: 15px;">あア亜 Aa Bb Cc 0123</span></div>
        <label class="settings-text-row">文字サイズ
          <input type="number" data-field="editorFontSize" min="8" max="40" step="1">
        </label>
        <label class="settings-text-row">カスタムCSS
          <input type="text" data-field="customCssPath" placeholder="(未設定)">
          <span class="settings-field-desc">指定したCSSファイルを本文に追加で適用します</span>
        </label>
      </div>
      <div class="settings-group">
        <label class="settings-select-row">ライトテーマ
          <select data-field="lightTheme">
            <option value="default">標準</option>
            <option value="sepia">セピア</option>
            <option value="github">GitHub風</option>
            <option value="solarized-light">Solarized Light</option>
          </select>
        </label>
        <label class="settings-select-row">ダークテーマ
          <select data-field="darkTheme">
            <option value="default">標準</option>
            <option value="nord">Nord</option>
            <option value="dracula">Dracula</option>
            <option value="solarized-dark">Solarized Dark</option>
          </select>
        </label>
      </div>
      <div class="settings-group">
        <label class="settings-checkbox-row"><input type="checkbox" data-field="showWordCount"><span class="settings-checkbox-title">文字数カウントを常に表示</span></label>
      </div>`;
    wireCommonFields(el);
    wireFontPreviews(el);
  }

  // ---- ファイルの関連付け(3階層チェックボックス、仕様書 C-13) ----
  // カテゴリ→言語→拡張子の3階層。カテゴリ・言語のチェックは配下すべての一括ON/OFFとし、
  // 配下が一部だけONならindeterminate(中間状態)にする。DOM自体は開くたびに1回だけ組み立て、
  // チェック状態の同期(syncFileTypeTree)はinput要素のcheckedプロパティを直接書き換えるだけに
  // 留めることで、145拡張子分のチェックのたびにinnerHTMLを再構築してスクロール位置や
  // 開閉状態が失われるのを避ける。
  function renderFileTypes(el) {
    const catBlocks = CATEGORY_ORDER.map((catKey) => {
      const types = TYPES_BY_CATEGORY.get(catKey);
      if (!types.length) return "";
      const catExpanded = expandedCategories.has(catKey);
      const langRows = types.map((type) => {
        const langExpanded = expandedLanguages.has(type.id);
        const extRows = type.extensions.map((ext) =>
          `<label class="ft-row ft-row-ext"><input type="checkbox" data-ext="${ext}"><span>.${ext}</span></label>`
        ).join("");
        return `
          <div class="ft-lang">
            <div class="ft-row ft-row-lang">
              <button type="button" class="ft-chevron${langExpanded ? " expanded" : ""}" data-toggle-lang="${type.id}" aria-label="展開・折りたたみ">${ICON_CHEVRON}</button>
              <label class="ft-row-label"><input type="checkbox" data-lang="${type.id}"><span>${type.label} <span class="ft-ext-hint">(${type.extensions.map((e) => "." + e).join(" ")})</span></span></label>
            </div>
            <div class="ft-ext-list" data-lang-body="${type.id}"${langExpanded ? "" : " hidden"}>${extRows}</div>
          </div>`;
      }).join("");
      return `
        <div class="ft-category">
          <div class="ft-row ft-row-category">
            <button type="button" class="ft-chevron${catExpanded ? " expanded" : ""}" data-toggle-cat="${catKey}" aria-label="展開・折りたたみ">${ICON_CHEVRON}</button>
            <label class="ft-row-label"><input type="checkbox" data-cat="${catKey}"><span>${CATEGORIES[catKey]}</span></label>
          </div>
          <div class="ft-lang-list" data-cat-body="${catKey}"${catExpanded ? "" : " hidden"}>${langRows}</div>
        </div>`;
    }).join("");

    el.innerHTML = `
      <p class="settings-intro">チェックした拡張子のファイルを、エクスプローラーからダブルクリックしたときにPaneで開くようにします。</p>
      <div class="ft-quickrow">
        <button type="button" class="btn tiny" data-quick="markdown">マークダウンのみ</button>
        <button type="button" class="btn tiny" data-quick="all">すべて選択</button>
        <button type="button" class="btn tiny" data-quick="none">すべて解除</button>
        <span class="ft-count"></span>
      </div>
      <div class="ft-tree">${catBlocks}</div>`;

    extInputs = new Map(Array.from(el.querySelectorAll("input[data-ext]")).map((inp) => [inp.dataset.ext, inp]));
    langInputs = new Map(Array.from(el.querySelectorAll("input[data-lang]")).map((inp) => [inp.dataset.lang, inp]));
    catInputs = new Map(Array.from(el.querySelectorAll("input[data-cat]")).map((inp) => [inp.dataset.cat, inp]));

    for (const btn of el.querySelectorAll("[data-toggle-cat]")) {
      btn.addEventListener("click", () => {
        const key = btn.dataset.toggleCat;
        const body = el.querySelector(`[data-cat-body="${key}"]`);
        const expand = body.hidden;
        body.hidden = !expand;
        btn.classList.toggle("expanded", expand);
        if (expand) expandedCategories.add(key); else expandedCategories.delete(key);
      });
    }
    for (const btn of el.querySelectorAll("[data-toggle-lang]")) {
      btn.addEventListener("click", () => {
        const key = btn.dataset.toggleLang;
        const body = el.querySelector(`[data-lang-body="${key}"]`);
        const expand = body.hidden;
        body.hidden = !expand;
        btn.classList.toggle("expanded", expand);
        if (expand) expandedLanguages.add(key); else expandedLanguages.delete(key);
      });
    }

    for (const [ext, inp] of extInputs) {
      inp.addEventListener("change", () => {
        if (inp.checked) selectedExtensions.add(ext); else selectedExtensions.delete(ext);
        syncFileTypeTree();
        markDirty();
      });
    }
    for (const [id, inp] of langInputs) {
      const type = FILE_TYPES.find((t) => t.id === id);
      inp.addEventListener("change", () => {
        for (const ext of type.extensions) { if (inp.checked) selectedExtensions.add(ext); else selectedExtensions.delete(ext); }
        syncFileTypeTree();
        markDirty();
      });
    }
    for (const [catKey, inp] of catInputs) {
      const types = TYPES_BY_CATEGORY.get(catKey);
      inp.addEventListener("change", () => {
        for (const type of types) for (const ext of type.extensions) { if (inp.checked) selectedExtensions.add(ext); else selectedExtensions.delete(ext); }
        syncFileTypeTree();
        markDirty();
      });
    }
    el.querySelector('[data-quick="markdown"]').addEventListener("click", () => { selectedExtensions = new Set(MARKDOWN_EXTENSIONS); syncFileTypeTree(); markDirty(); });
    el.querySelector('[data-quick="all"]').addEventListener("click", () => { selectedExtensions = new Set(ALL_EXTENSIONS); syncFileTypeTree(); markDirty(); });
    el.querySelector('[data-quick="none"]').addEventListener("click", () => { selectedExtensions = new Set(); syncFileTypeTree(); markDirty(); });

    syncFileTypeTree();
  }

  function syncFileTypeTree() {
    let total = 0;
    for (const catKey of CATEGORY_ORDER) {
      const types = TYPES_BY_CATEGORY.get(catKey);
      let catExtCount = 0, catCheckedCount = 0;
      for (const type of types) {
        let langCheckedCount = 0;
        for (const ext of type.extensions) {
          const checked = selectedExtensions.has(ext);
          if (checked) { langCheckedCount++; catCheckedCount++; total++; }
          catExtCount++;
          const extInput = extInputs.get(ext);
          if (extInput) extInput.checked = checked;
        }
        const langInput = langInputs.get(type.id);
        if (langInput) {
          langInput.checked = type.extensions.length > 0 && langCheckedCount === type.extensions.length;
          langInput.indeterminate = langCheckedCount > 0 && langCheckedCount < type.extensions.length;
        }
      }
      const catInput = catInputs.get(catKey);
      if (catInput) {
        catInput.checked = catExtCount > 0 && catCheckedCount === catExtCount;
        catInput.indeterminate = catCheckedCount > 0 && catCheckedCount < catExtCount;
      }
    }
    const countEl = contentEl?.querySelector(".ft-count");
    if (countEl) countEl.textContent = `現在 ${total} 個の拡張子が選択されています`;
  }

  // ---- キーボード(キーバインド一覧、仕様書 C-10) ----
  function effectiveShortcut(cmd) {
    return draft.keyBindings[cmd.id] || cmd.defaultShortcut || "";
  }

  function renderKeybindings(el) {
    const commands = (ctx.commands ?? []).filter((c) => typeof c.run === "function");
    el.innerHTML = `
      <p class="settings-intro">行をクリックしたあと、割り当てたいキーを押してください。Escapeで取り消し、Deleteで既定に戻せます。</p>
      <div class="kb-table"></div>`;
    renderKeybindingRows(el.querySelector(".kb-table"), commands);
  }

  function renderKeybindingRows(table, commands) {
    // 重複検出(仕様書: 既に使われている組み合わせなら赤系で警告。保存自体は許可する)。
    const byShortcut = new Map();
    for (const cmd of commands) {
      const sc = effectiveShortcut(cmd);
      if (!sc) continue;
      if (!byShortcut.has(sc)) byShortcut.set(sc, []);
      byShortcut.get(sc).push(cmd);
    }
    table.innerHTML = commands.map((cmd) => {
      const sc = effectiveShortcut(cmd);
      const conflictWith = sc && byShortcut.get(sc).length > 1 ? byShortcut.get(sc).filter((c) => c.id !== cmd.id) : [];
      const capturing = capturingCommandId === cmd.id;
      const menuLabel = cmd.menu ? (MENU_LABELS[cmd.menu] ?? cmd.menu) : "";
      // 捕捉中に割り当て不可なキーが押された場合は、重複警告と同じ見た目(kb-cell-warn)で
      // 理由を案内する。捕捉状態は続行するため、キー入力欄の表示("キーを押してください…")は変えない。
      const warnText = capturing && captureRejectMessage ? captureRejectMessage
        : (conflictWith.length && !capturing ? `${conflictWith.map((c) => c.label).join("・")} と重複` : "");
      return `
        <button type="button" class="kb-row${capturing ? " capturing" : ""}${conflictWith.length ? " conflict" : ""}" data-cmd="${cmd.id}">
          <span class="kb-cell-label">${menuLabel ? menuLabel + ": " : ""}${cmd.label}</span>
          <span class="kb-cell-shortcut">${capturing ? "キーを押してください…" : (sc ? `<kbd>${sc}</kbd>` : "(なし)")}</span>
          ${warnText ? `<span class="kb-cell-warn">${warnText}</span>` : ""}
        </button>`;
    }).join("");
    for (const row of table.querySelectorAll(".kb-row")) {
      row.addEventListener("click", () => startCapture(row.dataset.cmd, table, commands));
    }
  }

  function startCapture(cmdId, table, commands) {
    cancelActiveCapture(); // 別の行を続けてクリックした場合、前の捕捉待ちを終わらせる
    capturingCommandId = cmdId;
    captureRejectMessage = null;
    ctx.shortcutsSuppressed = true; // 既存のショートカット発火を止める(commands.js側で参照)
    renderKeybindingRows(table, commands);

    function onKeydown(e) {
      e.preventDefault();
      e.stopPropagation();
      // Escapeは常に「捕捉の取り消し」。設定画面自体を閉じる操作と揃え、修飾キーの
      // 有無によらず割り当て対象にはしない(閉じる操作としての一貫性を優先する)。
      if (e.key === "Escape") { finishCapture(); return; }
      // Delete/Backspaceは無modifierのときだけ「既定に戻す」の意味を持たせる。
      // Ctrl/Altを伴う場合(例: Ctrl+Backspace)は通常の割り当て候補として下へ処理を続ける。
      const noModifier = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if ((e.key === "Delete" || e.key === "Backspace") && noModifier) {
        delete draft.keyBindings[cmdId];
        markDirty();
        finishCapture();
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return; // 修飾キー単体はまだ待つ(押している途中)
      const combo = comboFromEvent(e);
      if (!combo) return;
      // 実害防止のための本体チェック: Ctrl/Altを伴わない文字キー単独などを割り当てて
      // しまうと、bindShortcutsがcaptureフェーズでpreventDefaultするためエディタで
      // その文字が二度と入力できなくなる(設定画面からの再割り当てでしか復旧できない)。
      // commands.js側(保存済み設定のサニタイズ)と同じ判定関数を使い、基準を一元化している。
      if (!isAssignableShortcut(combo)) {
        captureRejectMessage = "Ctrl または Alt との組み合わせか、ファンクションキーを指定してください";
        renderKeybindingRows(table, commands); // 捕捉状態は継続し、理由だけ表示して待ち続ける
        return;
      }
      draft.keyBindings[cmdId] = combo;
      markDirty();
      finishCapture();
    }
    function finishCapture() {
      document.removeEventListener("keydown", onKeydown, true);
      ctx.shortcutsSuppressed = false;
      capturingCommandId = null;
      captureRejectMessage = null;
      activeCaptureCleanup = null;
      renderKeybindingRows(table, commands);
    }
    activeCaptureCleanup = finishCapture;
    document.addEventListener("keydown", onKeydown, true);
  }

  // ---- カテゴリ切替のディスパッチ ----
  function renderContent() {
    if (!contentEl || !draft) return;
    cancelActiveCapture(); // タブを離れる際はキーバインド捕捉待ちを残さない
    switch (activeCategory) {
      case "edit": renderEdit(contentEl); break;
      case "markdown": renderMarkdownCategory(contentEl); break;
      case "appearance": renderAppearance(contentEl); break;
      case "fileTypes": renderFileTypes(contentEl); break;
      case "keybindings": renderKeybindings(contentEl); break;
      default: renderGeneral(contentEl); break;
    }
  }

  return { open, close: requestClose, isOpen, handleSettingsLoaded, handleSaveResult };
}
