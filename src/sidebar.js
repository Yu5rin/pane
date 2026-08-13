// サイドバー(仕様書 第2.8節・第10.4節)。
// 「アウトライン」「ファイルリスト(S-02)」「ファイルツリー(S-03)」の3パネルに加え、
// タブ列の直下に常時表示のグローバル検索欄(S-04、G-01/G-02)を持つ。
// 検索欄に文字列が入っている間は、3パネルの代わりに検索結果を本体領域(#sidebar-body)へ表示する。
import { extractHeadings } from "./markdown-extras.js";
import { createGlobalSearch } from "./global-search.js";

// 入力のたびに構文木を全走査(extractHeadings)しないためのデバウンス幅(仕様書 性能要件)。
// 第10.5節の「パネルとタブの切替:160ms」はCSSトランジションの値であり、これとは別。
const REFRESH_DEBOUNCE_MS = 300;

// ファイルリスト(files)の表示上限。DOM要素の数が数千を超えると描画・スクロールが
// 重くなるため、多量のファイルを持つフォルダでも一覧描画自体は軽く保つ。
// 全件から探したい場合はクイックオープン(Ctrl+P)を使ってもらう。
const FILE_LIST_LIMIT = 500;

// ツリー(tree)の各行で使うインラインSVG(仕様書の絵文字禁止・アイコン規約に準拠)。
// フォルダ行=シェブロン+フォルダアイコン、ファイル行=シェブロン幅のスペーサー+ファイルアイコン、
// とすることでアイコンの横位置を揃える。
const ICON_ATTRS = 'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const TREE_CHEVRON_SVG = `<svg class="tree-chevron" ${ICON_ATTRS}><path d="M9 6l6 6-6 6"/></svg>`;
const TREE_SPACER_HTML = '<span class="tree-spacer"></span>';
const TREE_FOLDER_SVG = `<svg class="tree-icon" ${ICON_ATTRS}><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>`;
const TREE_FILE_SVG = `<svg class="tree-icon" ${ICON_ATTRS}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>`;

// relativePath(区切りは'/')から親フォルダ部分だけを取り出す。トップレベルなら空文字。
function parentDirOf(relativePath) {
  const idx = relativePath.lastIndexOf("/");
  return idx === -1 ? "" : relativePath.slice(0, idx);
}

// createSidebar(editor, ctx)
// editor: createEditor()の戻り値(jumpToHeadingで見出し位置へジャンプする)
// ctx: main.js側のctx。ctx.actions.openFolder/openFileByPathを使う。
export function createSidebar(editor, ctx) {
  const sidebarEl = document.getElementById("sidebar");
  const bodyEl = document.getElementById("sidebar-body");
  const tabButtons = Array.from(sidebarEl.querySelectorAll(".sidebar-tab"));

  // グローバル検索欄(S-04)。タブ列(.sidebar-tabs)のすぐ下・本体領域(#sidebar-body)の
  // 直前にDOMを差し込む。index.html側は静的な骨組み(タブ・本体)だけを持つ構成のため、
  // 検索欄はここで動的に生成して挿入する。
  const searchBarEl = document.createElement("div");
  searchBarEl.className = "sidebar-search";
  searchBarEl.innerHTML = `
    <input id="sidebar-search-input" class="sidebar-search-input" type="text" placeholder="フォルダ内を検索" autocomplete="off">
    <label class="search-toggle" title="大文字・小文字を区別"><input id="sidebar-search-case" type="checkbox">Aa</label>
    <label class="search-toggle" title="単語単位"><input id="sidebar-search-word" type="checkbox">単語</label>
    <label class="search-toggle" title="正規表現"><input id="sidebar-search-regex" type="checkbox">.*</label>`;
  sidebarEl.insertBefore(searchBarEl, bodyEl);
  const searchInputEl = searchBarEl.querySelector("#sidebar-search-input");
  const searchCaseEl = searchBarEl.querySelector("#sidebar-search-case");
  const searchWordEl = searchBarEl.querySelector("#sidebar-search-word");
  const searchRegexEl = searchBarEl.querySelector("#sidebar-search-regex");

  let isOpenFlag = false; // 初期状態はindex.html側の.collapsedと一致させる
  let currentPanelName = "outline"; // 既定パネル(仕様書: アウトラインは左側にピン留めできる)
  let debounceTimer = null;

  // 読み込み済みフォルダのデータ。main.jsのhandleHostMessage("folder-loaded")から
  // setFolder()経由で渡される。{ rootPath, rootName, entries, truncated } または
  // 失敗時は { error }。未読み込みならnull。
  let folder = null;
  // 現在エディタで開いているファイルのフルパス。setCurrentPath()で更新し、
  // files/treeパネルのハイライト(.current)に使う。
  let openFilePath = null;
  // ツリーの開閉状態(ディレクトリのrelativePath集合)。
  // 「展開されたフォルダの中身だけをDOM化する」ことで巨大フォルダでも軽く保つため、
  // 開閉状態そのものはこのSetで保持し、パネルを切り替えても(=再描画しても)消えないようにする。
  const expandedDirs = new Set();

  // グローバル検索の状態機械(検索語・結果・進行状態)。DOM生成・イベント配線はここで、
  // C#とのメッセージ往復・結果描画は global-search.js に任せる。
  const globalSearch = createGlobalSearch(ctx);
  globalSearch.setOnUpdate(() => {
    // 検索結果が更新されるたびに呼ばれる。サイドバーが閉じている間は描画コストをかけない
    // (再度開いたときにrenderActivePanelNowが最新状態を描く)。
    if (isOpenFlag) renderActivePanelNow();
  });

  function currentSearchOptions() {
    return { caseSensitive: searchCaseEl.checked, wholeWord: searchWordEl.checked, regexp: searchRegexEl.checked };
  }
  // immediate=trueなら300msデバウンスせず即座に検索する(トグル変更時・Ctrl+Shift+Fでの
  // 初期検索用)。通常の入力(1文字ごと)はfalseでデバウンスする。
  function triggerSearch(immediate) {
    globalSearch.setQuery(searchInputEl.value, currentSearchOptions(), immediate);
  }
  searchInputEl.addEventListener("input", () => triggerSearch(false));
  for (const toggleEl of [searchCaseEl, searchWordEl, searchRegexEl]) {
    // トグルは検索語が入っているときだけ意味を持つので、空欄なら何もしない。
    toggleEl.addEventListener("change", () => { if (searchInputEl.value) triggerSearch(true); });
  }

  function setActiveTab() {
    for (const btn of tabButtons) btn.classList.toggle("active", btn.dataset.panel === currentPanelName);
  }

  function renderEmpty(message) {
    bodyEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = message;
    bodyEl.appendChild(empty);
  }

  // フォルダ未読み込み時の空状態。文言だけでなく「フォルダを開く」ボタンを置き、
  // files/treeパネルからそのままフォルダ機能の入口へ辿れるようにする。
  function renderFolderPrompt() {
    bodyEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "sidebar-empty";
    const msg = document.createElement("div");
    msg.textContent = "フォルダが読み込まれていません";
    wrap.appendChild(msg);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sidebar-open-folder-btn";
    btn.textContent = "フォルダを開く";
    btn.addEventListener("click", () => ctx.actions.openFolder());
    wrap.appendChild(btn);
    bodyEl.appendChild(wrap);
  }

  // truncated(10000件上限で打ち切り)の注意書き。files/tree共通で使う。
  function appendTruncatedNotice() {
    const notice = document.createElement("div");
    notice.className = "sidebar-notice";
    notice.textContent = "ファイルが多いため一部のみ表示しています";
    bodyEl.appendChild(notice);
  }

  // アウトラインパネル本体。extractHeadings()は構文木の全走査のため、呼び出し元
  // (scheduleRefresh/renderActivePanelNow)側でタイミングを制御する。
  function renderOutline() {
    const headings = extractHeadings(editor.view.state);
    if (!headings.length) {
      renderEmpty("見出しがありません");
      return;
    }
    bodyEl.innerHTML = "";
    for (const heading of headings) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "outline-item";
      item.dataset.level = String(heading.level);
      item.textContent = heading.text;
      item.title = heading.text;
      item.addEventListener("click", () => editor.jumpToHeading(heading));
      bodyEl.appendChild(item);
    }
  }

  // ファイルリストパネル(S-02): isDirectory===falseのエントリを平坦に一覧表示する。
  function renderFiles() {
    if (!folder) { renderFolderPrompt(); return; }
    if (folder.error) { renderEmpty(`フォルダの読み込みに失敗しました: ${folder.error}`); return; }

    const files = folder.entries.filter((e) => !e.isDirectory);
    bodyEl.innerHTML = "";
    if (folder.truncated) appendTruncatedNotice();
    if (!files.length) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "ファイルがありません";
      bodyEl.appendChild(empty);
      return;
    }

    const shown = files.slice(0, FILE_LIST_LIMIT);
    for (const entry of shown) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "file-item" + (entry.path === openFilePath ? " current" : "");
      item.title = entry.relativePath;
      const nameEl = document.createElement("span");
      nameEl.className = "file-item-name";
      nameEl.textContent = entry.name;
      item.appendChild(nameEl);
      const dir = parentDirOf(entry.relativePath);
      if (dir) {
        const dirEl = document.createElement("span");
        dirEl.className = "file-item-dir";
        dirEl.textContent = dir;
        item.appendChild(dirEl);
      }
      item.addEventListener("click", () => ctx.actions.openFileByPath(entry.path));
      bodyEl.appendChild(item);
    }
    if (files.length > FILE_LIST_LIMIT) {
      const more = document.createElement("div");
      more.className = "sidebar-notice";
      more.textContent = `他 ${files.length - FILE_LIST_LIMIT} 件(クイックオープン Ctrl+P で絞り込めます)`;
      bodyEl.appendChild(more);
    }
  }

  // folder.entries(フラット配列)からrelativePathを'/'で分割して階層ツリーを組み立てる。
  // ディレクトリのエントリはfolder.entries自身に含まれているため、全エントリ分の
  // ノードをまず作り、その後relativePathの親を辿って親ノードのchildrenへ繋ぐだけでよい
  // (どのディレクトリも自分自身のエントリが先に含まれていることが走査側で保証されている)。
  function buildTree() {
    const root = { isDirectory: true, children: [] };
    const nodes = new Map([["", root]]);
    for (const entry of folder.entries) {
      nodes.set(entry.relativePath, { entry, isDirectory: entry.isDirectory, children: entry.isDirectory ? [] : null });
    }
    for (const entry of folder.entries) {
      const parent = nodes.get(parentDirOf(entry.relativePath)) ?? root;
      parent.children.push(nodes.get(entry.relativePath));
    }
    // ディレクトリ優先→名前順(C#側FolderService.ScanAsyncのソート基準と揃える)。
    (function sortChildren(node) {
      if (!node.children) return;
      node.children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.entry.name.localeCompare(b.entry.name, "ja");
      });
      node.children.forEach(sortChildren);
    })(root);
    return root;
  }

  // ノードの子を再帰的にDOM化する。展開されていないフォルダは中身を描画しない
  // (=DOM化しない)ことで、巨大フォルダでもツリー全体を一度に組み立てずに済む。
  function renderTreeChildren(node, container) {
    for (const child of node.children) {
      if (child.isDirectory) {
        const wrapper = document.createElement("div");
        wrapper.className = "tree-folder";
        const expanded = expandedDirs.has(child.entry.relativePath);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-item tree-item-folder" + (expanded ? " expanded" : "");
        row.title = child.entry.relativePath;
        row.innerHTML = TREE_CHEVRON_SVG + TREE_FOLDER_SVG + '<span class="tree-item-name"></span>';
        row.querySelector(".tree-item-name").textContent = child.entry.name;
        row.addEventListener("click", () => {
          if (expanded) expandedDirs.delete(child.entry.relativePath);
          else expandedDirs.add(child.entry.relativePath);
          renderActivePanelNow();
        });
        wrapper.appendChild(row);
        if (expanded) {
          const childContainer = document.createElement("div");
          childContainer.className = "tree-children";
          renderTreeChildren(child, childContainer);
          wrapper.appendChild(childContainer);
        }
        container.appendChild(wrapper);
      } else {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-item tree-item-file" + (child.entry.path === openFilePath ? " current" : "");
        row.title = child.entry.relativePath;
        row.innerHTML = TREE_SPACER_HTML + TREE_FILE_SVG + '<span class="tree-item-name"></span>';
        row.querySelector(".tree-item-name").textContent = child.entry.name;
        row.addEventListener("click", () => ctx.actions.openFileByPath(child.entry.path));
        container.appendChild(row);
      }
    }
  }

  // ファイルツリーパネル(S-03): relativePathの階層で折りたたみ式ツリー表示する。
  function renderTree() {
    if (!folder) { renderFolderPrompt(); return; }
    if (folder.error) { renderEmpty(`フォルダの読み込みに失敗しました: ${folder.error}`); return; }

    bodyEl.innerHTML = "";
    if (folder.truncated) appendTruncatedNotice();
    const header = document.createElement("div");
    header.className = "tree-root-label";
    header.textContent = folder.rootName;
    header.title = folder.rootPath;
    bodyEl.appendChild(header);

    const root = buildTree();
    if (!root.children.length) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "ファイルがありません";
      bodyEl.appendChild(empty);
      return;
    }
    const container = document.createElement("div");
    container.className = "tree-children";
    renderTreeChildren(root, container);
    bodyEl.appendChild(container);
  }

  // 現在選択中のパネルを即座に描画する。ユーザーがサイドバーを開いた/パネルを切り替えた
  // 直後は、デバウンスせず最新の内容をすぐ見せる。
  // 検索欄に文字列が入っている間は、タブの選択状態はそのままに3パネルの代わりに
  // 検索結果を表示する(仕様書 S-04「パネル上端」の構成)。
  function renderActivePanelNow() {
    if (globalSearch.hasQuery()) {
      globalSearch.render(bodyEl, (path, line) => ctx.actions.openFileByPath(path, line));
      return;
    }
    if (currentPanelName === "outline") { renderOutline(); return; }
    if (currentPanelName === "files") { renderFiles(); return; }
    if (currentPanelName === "tree") { renderTree(); return; }
  }

  // 本文の変更通知(main.jsのonChangeから呼ばれる)を受けての再計算予約。
  // サイドバーが閉じている間・アウトラインパネルを見ていない間・検索結果表示中は、
  // 構文木の走査そのものを行わない(性能要件、および検索結果を上書きしないため)。
  function scheduleOutlineRefresh() {
    if (!isOpenFlag || currentPanelName !== "outline" || globalSearch.hasQuery()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderOutline, REFRESH_DEBOUNCE_MS);
  }

  // フォルダ読み込み結果を受け取る(main.jsのhandleHostMessage("folder-loaded")から)。
  // ルートフォルダが変わった場合のみ開閉状態を初期化し(既定でルート直下のみ開く)、
  // 同じフォルダの再読み込み(ファイルを開いた際の自動読み込み等)では開閉状態を保持する。
  function setFolder(data) {
    const isNewRoot = !folder || !data || data.error || folder.rootPath !== data.rootPath;
    folder = data;
    if (isNewRoot) {
      expandedDirs.clear();
      if (data && !data.error) {
        for (const entry of data.entries) {
          if (entry.isDirectory && !entry.relativePath.includes("/")) expandedDirs.add(entry.relativePath);
        }
      }
    }
    if (isOpenFlag && (currentPanelName === "files" || currentPanelName === "tree")) renderActivePanelNow();
  }

  // 現在編集中のファイルのフルパスを受け取り、files/treeパネルのハイライトに反映する。
  function setCurrentPath(path) {
    openFilePath = path;
    if (isOpenFlag && (currentPanelName === "files" || currentPanelName === "tree")) renderActivePanelNow();
  }

  function open(panel) {
    isOpenFlag = true;
    sidebarEl.classList.remove("collapsed");
    if (panel) currentPanelName = panel;
    setActiveTab();
    renderActivePanelNow();
  }

  function close() {
    isOpenFlag = false;
    sidebarEl.classList.add("collapsed");
    clearTimeout(debounceTimer);
  }

  function toggle() {
    if (isOpenFlag) close();
    else open();
  }

  function showPanel(panel) {
    currentPanelName = panel;
    if (!isOpenFlag) {
      open(panel);
      return;
    }
    setActiveTab();
    renderActivePanelNow();
  }

  // Ctrl+Shift+F(仕様書 G-01)。「サイドバーを開く → 検索欄にフォーカス → エディタで
  // 文字列を選択中ならそれを初期値に入れて即検索」という一連の流れをまとめる。
  function openSearchFlow() {
    open(); // 現在選択中のタブは変えない(仕様書: タブの選択状態は保持する)
    const view = editor.view;
    const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    if (sel && !sel.includes("\n")) {
      searchInputEl.value = sel;
      triggerSearch(true); // デバウンスせず即座に検索する
    }
    searchInputEl.focus();
    searchInputEl.select();
  }

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => showPanel(btn.dataset.panel));
  }
  setActiveTab();

  return {
    toggle,
    open,
    close,
    isOpen: () => isOpenFlag,
    showPanel,
    currentPanel: () => currentPanelName,
    refresh: scheduleOutlineRefresh,
    setFolder,
    setCurrentPath,
    openSearch: openSearchFlow,
    // main.jsのhandleHostMessageから"search-results"/"search-done"を渡す窓口。
    handleSearchResults: (hits) => globalSearch.handleResults(hits),
    handleSearchDone: (msg) => globalSearch.handleDone(msg),
  };
}
