// モーダル系UI共通のフォーカス管理(フォーカストラップ + 開閉時のフォーカス退避・復帰)。
//
// src/dialog.js(確認・警告・入力ダイアログ)・src/settings.js(設定画面)・
// src/commands.js(コマンドパレット)の3つはいずれも「背後にメインウィンドウのメニューバー等が
// あるオーバーレイ」という同じ構造を持ち、Tabキーでのフォーカス閉じ込め・開いたときの初期
// フォーカス・閉じたときのフォーカス復帰もすべて同じロジックで済む。元々dialog.js内に
// 閉じ込め専用で実装されていたものをここへ切り出し、3箇所から共通に使う
// (同じロジックを3箇所に複製すると、直したつもりでも1箇所直し忘れて再びズレるため)。

// container配下の「実際にTabで移動できる」要素を、DOM順で返す。
// 非表示(offsetParentがnull)・disabled・tabindex=-1のものは対象外にする。
function focusableElements(container) {
  return Array.from(container.querySelectorAll("button, input, textarea, select, a[href], [tabindex]")).filter(
    (el) => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null
  );
}

// keydownイベントを受け取り、Tabキーであればcontainer配下でフォーカスがループするように
// 処理する(先頭でShift+Tab→末尾、末尾でTab→先頭、外にあれば先頭へ引き戻す)。
// Tab以外のキーは何もしない(Escape/Enter等は呼び出し側がそれぞれの意味で個別に処理する)。
export function trapTabKey(e, container) {
  if (e.key !== "Tab") return;
  const els = focusableElements(container);
  if (!els.length) return;
  const first = els[0];
  const last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  } else if (!els.includes(document.activeElement)) {
    // 何らかの理由でフォーカスがcontainerの外にある場合は先頭へ引き戻す。
    e.preventDefault();
    first.focus();
  }
}

// モーダルを開く直前に呼ぶ。呼び出し時点でフォーカスがあった要素(=閉じたときに戻す先)を
// 覚えたうえで initialFocusEl へフォーカスを移す。戻り値の関数を閉じるときに呼ぶと、
// 覚えておいた要素へフォーカスが戻る(その要素が既にDOMから消えていれば何もしない)。
export function focusModal(initialFocusEl) {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  initialFocusEl?.focus();
  return function restoreFocus() {
    if (previouslyFocused && document.body.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };
}
