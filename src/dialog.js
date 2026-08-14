// Paneの見た目に揃えた独自ダイアログ(docs/コンテキストメニュー仕様.md 冒頭「大原則」と同じ考え方:
// ブラウザ標準UIを一切使わない)。WebView2ではブラウザ標準の確認・入力・警告ダイアログを
// 呼ぶと「pane.local の内容」といったブラウザ由来の見た目のダイアログが出てしまうため、
// これらは全廃し、必ずこのモジュール経由で確認・入力・警告を行う。
//
// 見た目は src/editor.js の confirmOpenExternal(外部リンクを開く前の確認)をお手本にし、
// スタイルは src/style.css の .extlink-* に揃えた .pane-dialog-* を使う。
//
// 本体ウィンドウ(main.js)・設定ウィンドウ(settings.js、settings-window.html)の両方から
// 読み込まれるため、他のPaneモジュールに依存しない独立したファイルにする。
//
// 公開API:
//   paneConfirm({ title, message, okLabel, cancelLabel, danger }) -> Promise<boolean>
//   paneAlert({ title, message, okLabel })                        -> Promise<void>
//   paneInput({ title, message, value, placeholder, okLabel, cancelLabel, validate }) -> Promise<string|null>

// Tabキーでのフォーカス閉じ込め・開閉時のフォーカス退避復帰は、設定画面(settings.js)や
// コマンドパレット(commands.js)と全く同じロジックのため、共通モジュールへ切り出したものを使う
// (このファイル自身が「他のPaneモジュールに依存しない独立したファイル」という上の方針とは、
// focus-trap.jsがDOM操作のみの純粋なユーティリティで循環依存を生まないため両立する)。
import { trapTabKey, focusModal } from "./focus-trap.js";

// 同時に開けるダイアログは1つだけ。閉じる関数をここに置き、次のダイアログを開く前に
// 残っていれば片付ける(通常は呼び出し側がPromiseを待ってから次を開くため、多重に開くことは
// 無いはずだが、保険として持っておく)。
let closeCurrent = null;

function createOverlayAndBox() {
  const overlay = document.createElement("div");
  overlay.className = "pane-dialog-overlay";
  const box = document.createElement("div");
  box.className = "pane-dialog-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  overlay.appendChild(box);
  return { overlay, box };
}

function appendTitle(box, title) {
  if (!title) return;
  const el = document.createElement("div");
  el.className = "pane-dialog-title";
  el.textContent = title;
  box.appendChild(el);
}

// メッセージはtextContentで入れる(HTMLとして解釈させない。confirmOpenExternalと同じ理由)。
function appendMessage(box, message) {
  if (!message) return;
  const el = document.createElement("div");
  el.className = "pane-dialog-message";
  el.textContent = message;
  box.appendChild(el);
}

function createButton(label, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = extraClass ? `pane-dialog-btn ${extraClass}` : "pane-dialog-btn";
  btn.textContent = label;
  return btn;
}

// ダイアログの骨組み(表示・破棄・Esc・オーバーレイクリック・Tabフォーカストラップ)を配線する。
// 呼び出し側は onEscape() / onEnter() で「Escapeが押された/Enterが押された」ときの意味
// (キャンセルするか、OKを試みるか等)を決める。戻り値は破棄用の関数。
function mountDialog({ overlay, box, onEscape, onEnter, initialFocusEl }) {
  closeCurrent?.(); // 前のダイアログが残っていれば先に畳む(多重オープンの保険)

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key === "Enter") {
      if (e.isComposing) return; // IME変換確定のEnterは無視する
      e.preventDefault();
      e.stopPropagation();
      onEnter();
      return;
    }
    trapTabKey(e, box); // ダイアログの外へフォーカスが出ないようループさせる(focus-trap.js)。
  }

  function onOverlayMousedown(e) {
    if (e.target === overlay) onEscape();
  }

  let restoreFocus;
  function destroy() {
    document.removeEventListener("keydown", onKeydown, true);
    overlay.removeEventListener("mousedown", onOverlayMousedown);
    overlay.remove();
    if (closeCurrent === destroy) closeCurrent = null;
    restoreFocus?.(); // 開く前にフォーカスがあった要素(呼び出し元のボタン等)へ戻す。
  }

  overlay.addEventListener("mousedown", onOverlayMousedown);
  document.addEventListener("keydown", onKeydown, true);
  document.body.appendChild(overlay);
  restoreFocus = focusModal(initialFocusEl ?? box.querySelector(".pane-dialog-btn"));

  closeCurrent = destroy;
  return destroy;
}

// ブラウザ標準の確認ダイアログの置き換え。danger:true で「削除」等の破壊的操作用にOKボタンを警告色にする。
export function paneConfirm({ title = "確認", message = "", okLabel = "OK", cancelLabel = "キャンセル", danger = false } = {}) {
  return new Promise((resolve) => {
    const { overlay, box } = createOverlayAndBox();
    appendTitle(box, title);
    appendMessage(box, message);

    const actions = document.createElement("div");
    actions.className = "pane-dialog-actions";
    const cancelBtn = createButton(cancelLabel);
    const okBtn = createButton(okLabel, danger ? "pane-dialog-btn-danger" : "pane-dialog-btn-primary");
    actions.append(cancelBtn, okBtn);
    box.appendChild(actions);

    let destroy;
    function finish(value) {
      destroy();
      resolve(value);
    }
    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));

    // 既定はOK(confirmOpenExternalと同じくEnterでそのまま確定できるようにする)。
    // ただしdanger(破壊的操作の確認)のときは初期フォーカスをキャンセル側に置く。
    // 「保存せずに閉じる」「新規文書を開く」「ごみ箱へ移動」等はうっかりEnterを押すと
    // データが失われる操作のため、OK側を既定にしてしまうと誤操作の入口になる。
    // なおEnterキー自体の意味(onEnter=OKを試みる)は変えない。キーボード操作でOKを選ぶ
    // 場合は、Tabで一度OKボタンへ移動してから押す一手間が必要になる、という安全側の設計。
    destroy = mountDialog({ overlay, box, onEscape: () => finish(false), onEnter: () => finish(true), initialFocusEl: danger ? cancelBtn : okBtn });
  });
}

// ブラウザ標準の警告ダイアログの置き換え。ボタンは1つ(OK)のみで、Escape・オーバーレイクリックもOKと同じ扱いにする
// (キャンセルという概念が無いため)。
export function paneAlert({ title = "", message = "", okLabel = "OK" } = {}) {
  return new Promise((resolve) => {
    const { overlay, box } = createOverlayAndBox();
    appendTitle(box, title);
    appendMessage(box, message);

    const actions = document.createElement("div");
    actions.className = "pane-dialog-actions";
    const okBtn = createButton(okLabel, "pane-dialog-btn-primary");
    actions.append(okBtn);
    box.appendChild(actions);

    let destroy;
    function finish() {
      destroy();
      resolve();
    }
    okBtn.addEventListener("click", finish);
    destroy = mountDialog({ overlay, box, onEscape: finish, onEnter: finish, initialFocusEl: okBtn });
  });
}

// ブラウザ標準の入力ダイアログの置き換え。キャンセル時はnullを返す(従来の約束を踏襲)。
// validate(value)を渡すと、入力の変化のたびに呼ばれる。エラー文字列を返している間はOKを無効化し、
// そのメッセージを表示する。nullを返せばエラー無し。
export function paneInput({ title = "", message = "", value = "", placeholder = "", okLabel = "OK", cancelLabel = "キャンセル", validate } = {}) {
  return new Promise((resolve) => {
    const { overlay, box } = createOverlayAndBox();
    appendTitle(box, title);
    appendMessage(box, message);

    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "pane-dialog-input";
    inputEl.value = value ?? "";
    if (placeholder) inputEl.placeholder = placeholder;
    box.appendChild(inputEl);

    const errorEl = document.createElement("div");
    errorEl.className = "pane-dialog-error";
    errorEl.hidden = true;
    box.appendChild(errorEl);

    const actions = document.createElement("div");
    actions.className = "pane-dialog-actions";
    const cancelBtn = createButton(cancelLabel);
    const okBtn = createButton(okLabel, "pane-dialog-btn-primary");
    actions.append(cancelBtn, okBtn);
    box.appendChild(actions);

    function updateValidity() {
      const err = validate ? validate(inputEl.value) : null;
      if (err) {
        errorEl.textContent = err;
        errorEl.hidden = false;
        okBtn.disabled = true;
      } else {
        errorEl.hidden = true;
        okBtn.disabled = false;
      }
    }
    updateValidity();
    inputEl.addEventListener("input", updateValidity);

    let destroy;
    function finish(v) {
      destroy();
      resolve(v);
    }
    function tryOk() {
      if (okBtn.disabled) return;
      finish(inputEl.value);
    }
    cancelBtn.addEventListener("click", () => finish(null));
    okBtn.addEventListener("click", tryOk);

    // 入力欄があるときは入力欄へ既定フォーカス、Enterは入力中でもOKを試みる。
    destroy = mountDialog({ overlay, box, onEscape: () => finish(null), onEnter: tryOk, initialFocusEl: inputEl });
    inputEl.select();
  });
}
