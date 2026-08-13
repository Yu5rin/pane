// 文字数カウントの詳細ポップアップ(仕様書 第2.7節 W-02)。
// #status-countのクリックで開閉する。文字数(空白含む/含まない)・単語数・行数・段落数・
// 読了時間を表示し、選択範囲がある場合はその値も併記する(W-03)。
//
// 重い集計(単語数・段落数)は editor.getDetailedStats() 呼び出し時にだけ実行される
// (性能要件、search-ui.js/sidebar.js等と同様の生成パターンでモジュール化)。

const ROWS = [
  { label: "文字数(空白を含む)", doc: (s) => s.charsWithSpace, sel: (s) => s.charsWithSpace },
  { label: "文字数(空白を除く)", doc: (s) => s.charsWithoutSpace, sel: (s) => s.charsWithoutSpace },
  { label: "単語数", doc: (s) => s.words, sel: (s) => s.words },
  { label: "行数", doc: (s) => s.lines, sel: (s) => s.lines },
  { label: "段落数", doc: (s) => s.paragraphs, sel: (s) => s.paragraphs },
  { label: "読了時間", doc: (s) => s.readingTime, sel: (s) => s.readingTime },
];

export function createWordCountPopup(editor, container) {
  let pop = null;
  let anchor = null;

  function onOutsideClick(e) {
    // アンカー(ステータスバーの文字数ボタン)自身のクリックはトグル処理側(main.js)に任せる。
    // ここで閉じてしまうと、開いている状態でボタンを押した時に「即座に閉じて再度開く」
    // 挙動になり、ボタンで閉じられなくなる。
    if (pop && !pop.contains(e.target) && !(anchor && anchor.contains(e.target))) close();
  }
  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  function close() {
    pop?.remove();
    pop = null;
    anchor = null;
    document.removeEventListener("mousedown", onOutsideClick, true);
    document.removeEventListener("keydown", onKeydown, true);
  }

  function renderRow(label, docVal, selVal) {
    return `<div class="wc-row"><span class="wc-label">${label}</span><span class="wc-val">${docVal}</span>` +
      (selVal != null ? `<span class="wc-val wc-sel">${selVal}</span>` : "") + `</div>`;
  }

  function open(anchorEl) {
    if (pop) { close(); return; }
    anchor = anchorEl;
    const { doc, selection } = editor.getDetailedStats(); // 開いた瞬間にだけ重い集計を実行
    pop = document.createElement("div");
    pop.className = "menu-dropdown wc-pop";
    pop.innerHTML = (selection ? `<div class="wc-row wc-head"><span class="wc-label"></span><span class="wc-val">全体</span><span class="wc-val wc-sel">選択範囲</span></div>` : "") +
      ROWS.map((r) => renderRow(r.label, r.doc(doc), selection ? r.sel(selection) : null)).join("");
    container.appendChild(pop);
    // ステータスバーは画面下端にあるため、下方向ではなく上方向(bottom基準)に開く。
    const rect = anchorEl.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 280)) + "px";
    pop.style.bottom = (window.innerHeight - rect.top + 4) + "px";
    document.addEventListener("mousedown", onOutsideClick, true);
    document.addEventListener("keydown", onKeydown, true);
  }

  function toggle(anchorEl) {
    if (pop) close(); else open(anchorEl);
  }

  return { open, close, toggle, isOpen: () => !!pop };
}
