// 取扱説明書専用ウィンドウ(Pane/HelpWindow.cs)のエントリポイント。
// dist/help-window.htmlから読み込まれる。docs/取扱説明書.md(dist/manual.mdへコピー済み。
// scripts/build.js copyManualMarkdown参照)を読み込んでHTMLへ変換し、
// 「左に見出しの目次サイドバー・右に本文」の2ペインで表示する。
//
// Markdown→HTML変換は、HTMLエクスポート・クリップボードコピーが使っている
// renderMarkdownToHtml(src/md-to-html.js)をそのまま流用する(新しいMarkdownパーサを
// 追加しない方針)。この関数はCodeMirrorの構文木(syntaxTree(state))を辿るだけで、
// エディタ本体(@codemirror/view、EditorView)は必要としないため、ここでは
// EditorState(ドキュメント+言語拡張)だけを組み立てて渡す。settings-entry.jsが
// editor.js自体を一切importしないのと同じ考え方(バンドルにCodeMirrorのエディタ本体を
// 巻き込まない)。
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough, Table, Superscript, Subscript, Emoji, Autolink } from "@lezer/markdown";
import { renderMarkdownToHtml } from "./md-to-html.js";
import { extractHeadings } from "./markdown-extras.js";

const bridge = window.chrome?.webview ?? null;

// ブラウザ既定の右クリックメニューを一切出さない(docs/コンテキストメニュー仕様.md 大原則1)。
// このウィンドウは「読むだけ」で独自の右クリックメニューは持たない方針のため、右クリック
// そのものを常に無効化する(選択したテキストのコピーはCtrl+Cで行える。ブラウザの既定機能で
// AreDefaultContextMenusEnabled/AreBrowserAcceleratorKeysEnabledの影響を受けない)。
document.addEventListener("contextmenu", (e) => e.preventDefault(), true);

// 実機での不具合調査用ログ。main.js/settings-entry.jsと同じ作法でC#側のLoggerへ送る。
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

// ---- 起動時の白フラッシュ対策(新方式。settings-entry.jsと同じ考え方) ----
// C#側(Pane/HelpWindow.cs)はWebView2コントロール自体を"initial-render-ready"を受け取るまで
// 非表示にしている。説明書の読み込み・変換・初期描画が終わった時点をその合図とする。
let initialRenderReadySent = false;
function signalInitialRenderReady() {
  if (initialRenderReadySent) return;
  initialRenderReadySent = true;
  logToHost("log", "initial-render-ready送信(取扱説明書画面の初期描画完了)");
  bridge?.postMessage({ type: "initial-render-ready" });
}

// ---- DOM組み立て(settings.jsのpageモードと同様、HTML側は空でJSが全体を描画する) ----
const shell = document.createElement("div");
shell.className = "help-shell";
shell.innerHTML = `
  <div class="help-search-bar" id="help-search-bar" hidden>
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm7 3-3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
    <input id="help-search-input" placeholder="説明書内を検索…" autocomplete="off">
    <span id="help-search-count" class="help-search-count"></span>
    <button id="help-search-prev" class="help-search-nav-btn" title="前へ(Shift+Enter)" aria-label="前を検索">▲</button>
    <button id="help-search-next" class="help-search-nav-btn" title="次へ(Enter)" aria-label="次を検索">▼</button>
    <button id="help-search-close" class="help-search-nav-btn" title="閉じる(Esc)" aria-label="検索を閉じる">×</button>
  </div>
  <div class="help-body">
    <nav class="help-sidebar" id="help-toc" aria-label="目次"></nav>
    <main class="help-content" id="help-content">
      <article class="help-article" id="help-article" tabindex="-1"></article>
    </main>
  </div>
`;
document.body.appendChild(shell);

const tocEl = document.getElementById("help-toc");
const articleEl = document.getElementById("help-article");
const searchBar = document.getElementById("help-search-bar");
const searchInput = document.getElementById("help-search-input");
const searchCountEl = document.getElementById("help-search-count");

function markdownLanguageExt() {
  return markdown({ extensions: [Strikethrough, Table, Superscript, Subscript, Emoji, Autolink] });
}

// CodeMirrorの構文解析はインクリメンタル(遅延)で、通常はEditorViewが表示・スクロールに
// 応じてアイドル時間中に少しずつ解析を進める。このウィンドウはエディタ本体(EditorView)を
// 一切作らずEditorStateだけを組み立てているため、その背景解析が走らず、syntaxTree(state)は
// 生成直後だと文書の先頭付近(既定の初期ビューポート3000文字)しか解析されていない(不具合として
// 発覚: 取扱説明書の後半の章が一切表示されなかった)。
//
// さらに、ensureSyntaxTree()自体はLanguageStateの内部(ミュータブルなParseContext)の解析を
// 前進させるだけで、state.field(Language.state).tree(=syntaxTree(state)の戻り値そのもの)は
// 更新しない。CodeMirror本体のforceParsing()がview.dispatch({})で空のトランザクションを
// 流してLanguageState.apply()経由で同期させているのと同じ理由で、EditorViewが無いここでは
// 代わりにstate.update({})で空のトランザクションを自前で適用し、その結果のstateを返す
// (呼び出し側は戻り値のstateを使うこと。元のstateのままだとsyntaxTree()は依然として
// 未解析のままの部分木を返す)。
// 対処(上記の経緯を踏まえた最終形): 空トランザクションを流してstateごと作り直すのではなく、
// renderMarkdownToHtml・extractHeadingsの側で「ensureSyntaxTree()の戻り値の木をそのまま使う」
// ようにした(src/md-to-html.js・src/markdown-extras.js参照)。syntaxTree(state)を取り直さない
// 限りParseContextの前進がそのまま使えるため、ここで事前に何かする必要は無い。
// この関数を残していた頃は、ensureSyntaxTree()を呼んだあとに結局syntaxTree(state)を
// 読み直しており、解析結果が反映されないまま(実測で425行中11見出しまで)だった。

// GitHub風スラグの重複と完全に同じ規則で見出しへid属性を振るため、markdown-extras.jsの
// extractHeadings(既にサイドバーのアウトライン・目次リンク解決で使われているのと同じ関数)を
// そのまま使う。取扱説明書内の目次リンク([text](#slug))もこの規則でスラグを書いている前提
// (docs/取扱説明書.md自体はGitHub互換のスラグ規則で書かれる想定)。
function renderManual(markdownText) {
  const state = EditorState.create({ doc: markdownText, extensions: [markdownLanguageExt()] });
  const headings = extractHeadings(state, 6, { ensureFullParse: true });
  const headingIds = new Map(headings.map((h) => [h.from, h.slug]));
  const html = renderMarkdownToHtml(state, undefined, { headingIds });
  articleEl.innerHTML = html;
  buildToc(headings);
  wireArticleLinks();
  wireActiveHeadingTracking(headings);
}

// ---- サイドバー目次(設定ウィンドウのカテゴリ一覧 .settings-nav と同じ見た目に揃える。
// レベルに応じたインデントはsrc/style.cssの.pane-outline-lN(エクスポートのアウトライン)と
// 同じ考え方)。 ----
function buildToc(headings) {
  tocEl.innerHTML = "";
  for (const h of headings) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `help-toc-item help-toc-l${h.level}`;
    btn.dataset.slug = h.slug;
    btn.textContent = h.text;
    btn.addEventListener("click", () => scrollToSlug(h.slug, { pushHistory: true }));
    tocEl.appendChild(btn);
  }
}

function scrollToSlug(slug, { pushHistory = false } = {}) {
  const target = articleEl.querySelector(`#${CSS.escape(slug)}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  if (pushHistory) {
    try { history.replaceState(null, "", `#${slug}`); } catch { /* file://等では失敗しうるが無視してよい */ }
  }
  setActiveToc(slug);
}

function setActiveToc(slug) {
  tocEl.querySelectorAll(".help-toc-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.slug === slug);
  });
}

// 本文内の目次リンク・見出しへのアンカーリンク([text](#slug))をクリックしたときも
// サイドバー目次のクリックと同じ経路(スムーズスクロール+アクティブ強調更新)を通す。
// 外部リンク(http/https)はOSの既定ブラウザで開く(本文の閲覧を中断させないため)。
function wireArticleLinks() {
  articleEl.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) {
      e.preventDefault();
      scrollToSlug(decodeURIComponent(href.slice(1)), { pushHistory: true });
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      if (bridge) bridge.postMessage({ type: "open-in-default-app", path: href });
      else window.open(href, "_blank", "noopener");
    }
  });
}

// 現在読んでいる位置の見出しをサイドバーで強調する(IntersectionObserver。スクロール位置に
// 一番近い、画面上部に来た見出しをアクティブとみなす)。
function wireActiveHeadingTracking(headings) {
  if (!headings.length || typeof IntersectionObserver !== "function") return;
  const headingEls = headings
    .map((h) => articleEl.querySelector(`#${CSS.escape(h.slug)}`))
    .filter(Boolean);
  if (!headingEls.length) return;
  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      // 表示中の見出しのうち、文書内で最も先頭寄りのものをアクティブにする
      // (見出しが同時に複数見えている一般的なケースへの対応)。
      let top = null;
      for (const el of headingEls) {
        if (visible.has(el)) { top = el; break; }
      }
      if (top) setActiveToc(top.id);
    },
    { root: document.getElementById("help-content"), rootMargin: "0px 0px -70% 0px", threshold: 0 }
  );
  headingEls.forEach((el) => observer.observe(el));
}

// ---- Ctrl+F: 説明書内の検索(ブラウザ標準の検索はWebView2では効かないため独自実装) ----
let searchMatches = [];
let searchCurrentIndex = -1;

function openSearch() {
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}
function closeSearch() {
  searchBar.hidden = true;
  clearHighlights();
  articleEl.focus();
}
function clearHighlights() {
  articleEl.querySelectorAll("mark.help-search-hit").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
  searchMatches = [];
  searchCurrentIndex = -1;
  updateSearchCount();
}
function runSearch(query) {
  clearHighlights();
  const q = query.trim();
  if (!q) return;
  const lowerQ = q.toLowerCase();
  // DOM変更(replaceChild)をTreeWalkerの走査中に行うと巡回が壊れるため、対象テキストノードを
  // 先に配列へ集めてから、集め終わったあとにまとめて置き換える。
  const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  for (const textNode of textNodes) {
    const text = textNode.textContent;
    const lower = text.toLowerCase();
    if (!lower.includes(lowerQ)) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    let idx;
    while ((idx = lower.indexOf(lowerQ, pos)) !== -1) {
      if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement("mark");
      mark.className = "help-search-hit";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      searchMatches.push(mark);
      pos = idx + q.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
  searchCurrentIndex = searchMatches.length > 0 ? 0 : -1;
  highlightCurrentMatch();
}
function highlightCurrentMatch() {
  searchMatches.forEach((m, i) => m.classList.toggle("current", i === searchCurrentIndex));
  if (searchCurrentIndex >= 0) {
    searchMatches[searchCurrentIndex].scrollIntoView({ block: "center" });
  }
  updateSearchCount();
}
function updateSearchCount() {
  searchCountEl.textContent = searchMatches.length ? `${searchCurrentIndex + 1}/${searchMatches.length}` : "0/0";
}
function goToMatch(direction) {
  if (!searchMatches.length) return;
  searchCurrentIndex = (searchCurrentIndex + direction + searchMatches.length) % searchMatches.length;
  highlightCurrentMatch();
}

searchInput.addEventListener("input", () => runSearch(searchInput.value));
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); goToMatch(e.shiftKey ? -1 : 1); return; }
  if (e.key === "Escape") { e.preventDefault(); closeSearch(); return; }
});
document.getElementById("help-search-next").addEventListener("click", () => goToMatch(1));
document.getElementById("help-search-prev").addEventListener("click", () => goToMatch(-1));
document.getElementById("help-search-close").addEventListener("click", closeSearch);

// windowのcaptureフェーズで拾う(サイドバー・本文どちらにフォーカスがあっても効くように。
// commands.js bindShortcutsと同じ考え方)。
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.key === "Escape" && !searchBar.hidden) {
    e.preventDefault();
    closeSearch();
    return;
  }
  // 閉じているときのEscapeはウィンドウを閉じる(設定ウィンドウのEscapeでの「閉じる」と同じ考え方)。
  if (e.key === "Escape" && searchBar.hidden) {
    closeHelpWindow();
  }
}, true);

function closeHelpWindow() {
  if (bridge) bridge.postMessage({ type: "close-help-window" });
  else window.close();
}

// ---- テーマ(仕様書 第10.2節・第2.10節 C-06)。設定ウィンドウ(settings-entry.js)と
// 同じ適用ロジック: 手動選択(light/dark)があればそれを、"system"ならindex.html同様の
// 起動時スクリプト(prefers-color-scheme)で決めた値のまま。プリセットは常に反映する。 ----
function applyTheme(msg) {
  if (msg.theme === "light" || msg.theme === "dark") {
    document.documentElement.dataset.theme = msg.theme;
  }
  document.documentElement.dataset.lightTheme = msg.lightTheme || "default";
  document.documentElement.dataset.darkTheme = msg.darkTheme || "default";
}

// ---- ブリッジ受信 ----
if (bridge) {
  bridge.addEventListener("message", (e) => {
    const msg = e && e.data;
    if (!msg) return;
    logToHost("log", `C#からのメッセージ受信: type=${msg.type}`);
    if (msg.type === "theme") {
      applyTheme(msg);
    }
  });
}

// ---- 説明書の読み込み。dist/manual.md(scripts/build.js copyManualMarkdown参照)を
// 同一オリジンのvirtual host(pane.local)からfetchする。ブリッジの有無に関わらず同じ経路
// (静的ファイルなのでC#側の往復は不要)。 ----
async function loadManual() {
  try {
    const res = await fetch("manual.md");
    if (!res.ok) throw new Error(`manual.md の取得に失敗しました(HTTP ${res.status})`);
    const text = await res.text();
    renderManual(text);
    // #アンカー付きで開かれた場合(将来的な用途に備え)、初期スクロールしておく。
    const initialHash = decodeURIComponent(location.hash || "").replace(/^#/, "");
    if (initialHash) scrollToSlug(initialHash);
  } catch (err) {
    logToHost("error", `取扱説明書の読み込みに失敗しました: ${err}`);
    articleEl.innerHTML = `<p class="help-load-error">取扱説明書の読み込みに失敗しました。アプリを再インストールしてもなお発生する場合はお手数ですが開発者へご連絡ください。</p>`;
  } finally {
    // 読み込みに失敗した場合でも、白フラッシュ対策のフォールバックを待たせず即座に表示する。
    signalInitialRenderReady();
  }
}

loadManual();
