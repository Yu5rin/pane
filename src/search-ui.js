// 検索・置換パネル(仕様書 E-17〜E-19)。マッチの検出・ハイライトは
// @codemirror/search の SearchQuery / search() 拡張(editor.js側)に委ねる。
import { EditorView } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";

// F3/Shift+F3 等のグローバルショートカット(commands.js)経由のnext/prevは、この
// パネル内のボタンクリックを経由しないため updateCount() が呼ばれない(不具合2)。
// アプリ内で検索パネルは常に1つしか作られない前提で、直近に作られたインスタンスの
// 「件数表示を更新する」関数だけを覚えておき、commands.js側から呼べるようにする。
let activeRefresh = null;
export function refreshOpenSearchCount() {
  activeRefresh?.();
}

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

  // 不具合3: 検索パネルを開いたまま本文を編集しても、検索欄への再入力やnext/prevボタンを
  // 押すまで件数表示が古いままだった。CodeMirrorのEditorView.updateListenerを
  // StateEffect.appendConfigで既存の拡張構成に追加し、本文の変更(update.docChanged)を
  // 監視して件数表示を追従させる。editor.js側の拡張一覧を直接いじらずに済むよう、
  // このファイル単体で完結させている。
  // 1万行規模の文書ではgetSearchMatchInfo()(全文書を走査してマッチを数え直す)が
  // 軽くないため、キー入力のたびに毎回呼ぶと重くなる。デバウンス(150ms)して、
  // 入力が止まってから1回だけ再計算する。
  const DOC_CHANGE_DEBOUNCE_MS = 150;
  let debounceTimer = null;
  function cancelDebouncedUpdate() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
  // タブ形式(仕様書 第2.10節 C-14、既定オフの隠し機能)のタブ切替はeditor.js内で
  // view.setState()によりEditorStateをまるごと差し替える(createFreshState()には
  // このappendConfigは含まれない)ため、そのタイミングでこのリスナーが失われ得る。
  // stateのconfigは通常のdispatch(doc編集等)では使い回されるが、setState/reconfigure
  // されると新しいconfigに変わる性質を利用し、「いまのconfigに付け済みか」をWeakSetで
  // 覚えておいて、未付与なら付け直す。既に付いていれば何もしない(多重登録を防ぐ)。
  const configsWithListener = new WeakSet();
  function ensureDocChangeListener() {
    if (configsWithListener.has(editor.view.state.config)) return;
    editor.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || panel.hidden) return;
          cancelDebouncedUpdate();
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (!panel.hidden) updateCount();
          }, DOC_CHANGE_DEBOUNCE_MS);
        })
      ),
    });
    configsWithListener.add(editor.view.state.config);
  }
  ensureDocChangeListener();

  els.query.addEventListener("input", applyQuery);
  els.replaceQuery.addEventListener("input", applyQuery);
  els.caseBox.addEventListener("change", applyQuery);
  els.wordBox.addEventListener("change", applyQuery);
  els.regexBox.addEventListener("change", applyQuery);

  // 不具合1: 「すべて置換」「置換」「次を検索」「前を検索」を押した直後、フォーカスが
  // ボタン(<button>)に残ったままだとCodeMirrorのundoキーマップにCtrl+Zが届かず、
  // 「アンドゥが壊れた」ように見える。ここでeditor.focus()を呼んで本文へフォーカスを
  // 戻すが、これは「検索欄で入力中のフォーカスを奪う」ことにはならない。button要素の
  // クリックはブラウザの既定動作として即座にフォーカスをそのボタンへ移すため、この
  // ハンドラが呼ばれた時点で既にフォーカスは検索欄(input)を離れている。つまり
  // editor.focus()は「ボタン→本文」の付け替えであり、「検索欄→本文」を奪うケースは
  // 発生しない。
  panel.querySelector("#search-next").addEventListener("click", () => { editor.findNext(); updateCount(); editor.focus(); });
  panel.querySelector("#search-prev").addEventListener("click", () => { editor.findPrevious(); updateCount(); editor.focus(); });
  panel.querySelector("#replace-one").addEventListener("click", () => { editor.replaceNext(); updateCount(); editor.focus(); });
  panel.querySelector("#replace-all").addEventListener("click", () => { editor.replaceAllMatches(); updateCount(); editor.focus(); });
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
    // タブ切替(隠し機能)でパネルが閉じている間にEditorStateがまるごと差し替わっている
    // 可能性があるため、開くたびに件数更新リスナーが付いているか確認しておく(上記参照)。
    ensureDocChangeListener();
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
    cancelDebouncedUpdate();
    editor.setSearchQuery({ search: "" });
    editor.focus();
  }

  // commands.js(F3/Shift+F3等のグローバルショートカット)から呼べるよう、直近に
  // 作られたこのインスタンスの更新関数を登録しておく(不具合2、ファイル先頭のコメント参照)。
  activeRefresh = () => { if (!panel.hidden) updateCount(); };

  return { open, close, isOpen: () => !panel.hidden };
}
