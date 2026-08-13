// 検索・置換パネル(仕様書 E-17〜E-19)。マッチの検出・ハイライトは
// @codemirror/search の SearchQuery / search() 拡張(editor.js側)に委ねる。
export function createSearchUI(editor, container) {
  const panel = document.createElement("div");
  panel.id = "search-panel";
  panel.className = "search-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="search-row">
      <input id="search-query" type="text" placeholder="検索" autocomplete="off">
      <span id="search-count" class="search-count"></span>
      <button id="search-prev" type="button" title="前を検索(Shift+F3)">&#x2191;</button>
      <button id="search-next" type="button" title="次を検索(F3)">&#x2193;</button>
      <label class="search-toggle"><input id="search-case" type="checkbox">Aa</label>
      <label class="search-toggle"><input id="search-word" type="checkbox">単語</label>
      <label class="search-toggle"><input id="search-regex" type="checkbox">.*</label>
      <button id="search-toggle-replace" type="button" title="置換を表示">置換</button>
      <button id="search-close" type="button" title="閉じる(Esc)">&#x2715;</button>
    </div>
    <div class="search-row" id="replace-row" hidden>
      <input id="replace-query" type="text" placeholder="置換後の文字列" autocomplete="off">
      <button id="replace-one" type="button">置換</button>
      <button id="replace-all" type="button">すべて置換</button>
    </div>`;
  container.appendChild(panel);

  const els = {
    query: panel.querySelector("#search-query"),
    replaceRow: panel.querySelector("#replace-row"),
    replaceQuery: panel.querySelector("#replace-query"),
    count: panel.querySelector("#search-count"),
    caseBox: panel.querySelector("#search-case"),
    wordBox: panel.querySelector("#search-word"),
    regexBox: panel.querySelector("#search-regex"),
  };

  function currentOptions() {
    return {
      search: els.query.value,
      replace: els.replaceQuery.value,
      caseSensitive: els.caseBox.checked,
      wholeWord: els.wordBox.checked,
      regexp: els.regexBox.checked,
    };
  }
  function applyQuery() {
    editor.setSearchQuery(currentOptions());
    updateCount();
  }
  function updateCount() {
    const { count, index } = editor.getSearchMatchInfo();
    els.count.textContent = els.query.value ? (count === 0 ? "見つかりません" : `${index + 1 >= 1 ? index + 1 : "-"} / ${count}`) : "";
  }

  els.query.addEventListener("input", applyQuery);
  els.replaceQuery.addEventListener("input", applyQuery);
  els.caseBox.addEventListener("change", applyQuery);
  els.wordBox.addEventListener("change", applyQuery);
  els.regexBox.addEventListener("change", applyQuery);

  panel.querySelector("#search-next").addEventListener("click", () => { editor.findNext(); updateCount(); });
  panel.querySelector("#search-prev").addEventListener("click", () => { editor.findPrevious(); updateCount(); });
  panel.querySelector("#replace-one").addEventListener("click", () => { editor.replaceNext(); updateCount(); });
  panel.querySelector("#replace-all").addEventListener("click", () => { editor.replaceAllMatches(); updateCount(); });
  panel.querySelector("#search-close").addEventListener("click", () => close());
  panel.querySelector("#search-toggle-replace").addEventListener("click", () => {
    els.replaceRow.hidden = !els.replaceRow.hidden;
    if (!els.replaceRow.hidden) els.replaceQuery.focus();
  });

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) editor.findPrevious(); else editor.findNext();
      updateCount();
    }
  });

  function open(withReplace) {
    panel.hidden = false;
    els.replaceRow.hidden = !withReplace;
    const view = editor.view;
    const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    if (sel && !sel.includes("\n")) els.query.value = sel;
    applyQuery();
    els.query.focus();
    els.query.select();
  }
  function close() {
    panel.hidden = true;
    editor.setSearchQuery({ search: "" });
    editor.focus();
  }

  return { open, close, isOpen: () => !panel.hidden };
}
