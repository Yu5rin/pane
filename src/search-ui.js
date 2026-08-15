// 検索・置換パネル(仕様書 E-17〜E-19)。マッチの検出・ハイライトは
// @codemirror/search の SearchQuery / search() 拡張(editor.js側)に委ねる。

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
      <label class="search-toggle" data-tip="search-case"><input id="search-case" type="checkbox">Aa</label>
      <label class="search-toggle" data-tip="search-word"><input id="search-word" type="checkbox">単語</label>
      <label class="search-toggle" data-tip="search-regex"><input id="search-regex" type="checkbox">.*</label>
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

  // 不具合3(初出)/バグ2(タブ切替での再発、ラウンド1)の修正: 検索パネルを開いたまま
  // 本文を編集しても、検索欄への再入力やnext/prevボタンを押すまで件数表示が古いままだった。
  // 本文の変更(docChanged)を監視して件数表示を追従させる。
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
  // 過去の実装は、EditorView.updateListenerをStateEffect.appendConfigでその時点の
  // state.configにだけ追加していた。タブ形式(仕様書 第2.10節 C-14、既定オフの隠し機能)の
  // タブ切替はeditor.js内でview.setState()によりEditorStateをまるごと(configごと)
  // 差し替えるため、appendConfigで足したリスナーはそこで失われる。当時、「いまのconfigに
  // 付け済みか」をWeakSetで追跡し、未付与なら付け直す防御(ensureDocChangeListener)を
  // 用意していたが、これはこの関数自体が呼ばれて初めて効く防御であり、呼び出し箇所は
  // createSearchUI()の初期化時とopen()の中の2箇所しかなかった。タブ切替(main.jsの
  // switchToTab→editor.setEditorState)はこのどちらも経由しないため、パネルを開いたまま
  // 裏でタブだけが切り替わるケース(バグ2の再現手順)ではWeakSetの判定自体が一度も
  // 実行されず、防御が「効かない」のではなく「そもそも呼ばれない」状態になっていた。
  // 対策として、config(=EditorState)側にリスナーをぶら下げるのをやめ、editor.js側に
  // 常設した購読機構(onDocChange。createEditor()のクロージャに属し、タブ切替をまたいで
  // 生き続ける)を使う。これにより「configの生死を追跡して付け直す」という設計自体が
  // 不要になり、タブ切替の呼び出し経路を気にしなくてよくなる。
  //
  // なお、ここでは単なるupdateCount()ではなくapplyQuery()(setSearchQuery再送+updateCount)を
  // 呼ぶ。@codemirror/searchのクエリ(searchState)はEditorStateのフィールドであり、タブごとに
  // 独立している(defaultQuery()はそのタブの選択範囲から作られるだけで、他タブの検索語を
  // 引き継がない)。そのため、b.mdで"hello"を検索した状態のままa.mdへ切り替えても、a.mdの
  // EditorStateには"hello"というクエリがまだ一度も適用されていない。updateCount()は現在の
  // クエリで数え直すだけなので、それだけでは切替先タブに検索語を適用し直せず「見つかりません」の
  // ままになってしまう。applyQuery()は検索欄(DOM、タブ間で共有)の現在値を「いま有効な
  // EditorView(=いま表示中のタブ)」へ改めて適用してから数えるため、doc変更(バグ2の再現手順の
  // 「a.mdへ本文を追記する」操作)をきっかけに、タブ切替後も正しい件数へ自己修復する。
  editor.onDocChange(() => {
    if (panel.hidden) return;
    cancelDebouncedUpdate();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!panel.hidden) applyQuery();
    }, DOC_CHANGE_DEBOUNCE_MS);
  });

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
