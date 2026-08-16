// フォルダ横断検索(グローバル検索、仕様書 第2.6節 G-01/G-02・第2.8節 S-04)。
// サイドバー上端の検索欄(sidebar.js)から呼ばれる状態管理・結果描画を担う。
// C#とのメッセージ往復にリクエストIDが無いプロトコルのため、「新しい検索を送る前に
// 必ずcancel-searchを送る」という仕様書の指示どおりに振る舞う(それ以上の凝った
// 排他制御はプロトコル上できないため行わない)。

// ツールチップの詳しさ(依頼2)。ヒット行ごとにファイルパス:行番号をtitleとして出しており、
// 件数が多く個別に識別子を振れないため、sidebar.jsのsetDynamicTitleと同じく
// 「noneのときだけ出さない」というルールだけをここで直接守る。
import { getCurrentLevel } from "./tooltips.js";

// 入力のたびにフォルダ全体を検索させないためのデバウンス幅(仕様書の指示どおり300ms)。
const DEBOUNCE_MS = 300;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// lineText([offset, offset+len)の範囲)をHTMLエスケープしたうえで<mark>で囲む。
// offset/lenはC#側のSearchHit.MatchOffset/MatchLength(切り詰め後のlineTextに対する
// 0始まり位置と実際のマッチ文字数)を渡すこと。column(元の行の列番号、1始まり)や
// 入力欄の文字列長は使わない。lineTextはC#側で前後100文字に切り詰め済みのことがあり、
// columnとはインデックス基準がずれ、正規表現検索では入力欄の文字列長とマッチ長も
// 一致しないため(バグ修正時のメモ)。offset/lenが無ければ強調せずそのまま表示する。
function highlightLine(lineText, offset, len) {
  const text = lineText ?? "";
  if (offset == null || len == null) return escapeHtml(text);
  const start = Math.max(0, Math.min(text.length, offset));
  const end = Math.max(start, Math.min(text.length, start + Math.max(0, len)));
  const before = escapeHtml(text.slice(0, start));
  const hit = start < end ? `<mark>${escapeHtml(text.slice(start, end))}</mark>` : "";
  const after = escapeHtml(text.slice(end));
  return before + hit + after;
}

// createGlobalSearch(ctx): ctx.bridge経由でC#とやり取りする状態機械。
// sidebar.jsはDOM(検索欄・トグル・結果表示先)を持ち、こちらは検索語・結果・
// 進行状態(検索中/完了/エラー)だけを持つ。
export function createGlobalSearch(ctx) {
  let query = ""; // 現在の検索欄の内容(空文字なら「検索していない」状態)
  let hits = [];
  let status = "idle"; // "idle" | "searching" | "done"
  let truncated = false;
  let error = null;
  let debounceTimer = null;
  let onUpdate = null; // 結果が変化するたびに呼ぶ再描画コールバック(sidebar.js側で設定)

  function notify() { onUpdate?.(); }

  function send(type, extra) {
    ctx.bridge?.postMessage({ type, ...extra });
  }

  // 新しい検索を開始する。cancel-searchを先に送ってから、蓄積していた結果を破棄する。
  function startSearch(text, options) {
    send("cancel-search");
    hits = [];
    status = "searching";
    truncated = false;
    error = null;
    notify();
    send("global-search", {
      query: text,
      caseSensitive: !!options.caseSensitive,
      regexp: !!options.regexp,
      wholeWord: !!options.wholeWord,
    });
  }

  // 検索欄の入力・トグル変更のたびに呼ぶ。
  // immediate=trueの場合はデバウンスせず即座に検索する(Ctrl+Shift+Fでの初期検索・
  // トグル変更時に使う。1文字ごとの入力ではfalseにしてデバウンスする)。
  function setQuery(text, options, immediate) {
    query = text;
    clearTimeout(debounceTimer);
    if (!text) {
      // 検索欄を空にした = 検索をやめて元のパネル表示へ戻る合図。
      send("cancel-search");
      hits = [];
      status = "idle";
      truncated = false;
      error = null;
      notify();
      return;
    }
    if (immediate) startSearch(text, options);
    else debounceTimer = setTimeout(() => startSearch(text, options), DEBOUNCE_MS);
  }

  // C#から逐次届くヒットを蓄積する(handleHostMessageの"search-results")。
  function handleResults(newHits) {
    if (status !== "searching") return; // 既に打ち切り・空になった後に届いた分は無視
    hits = hits.concat(newHits);
    notify();
  }

  // 検索完了通知(handleHostMessageの"search-done")。
  function handleDone(msg) {
    if (status !== "searching") return;
    status = "done";
    truncated = !!msg.truncated;
    error = msg.error ?? null;
    notify();
  }

  function cancel() {
    clearTimeout(debounceTimer);
    send("cancel-search");
  }

  function hasQuery() { return query.length > 0; }
  function setOnUpdate(fn) { onUpdate = fn; }

  function renderMessage(bodyEl, message) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = message;
    bodyEl.appendChild(empty);
  }

  // 検索結果をbodyElへ描画する。openHit(path, line)はヒット行クリック時に呼ぶ。
  function render(bodyEl, openHit) {
    bodyEl.innerHTML = "";
    if (error) { renderMessage(bodyEl, error); return; }
    if (!hits.length) {
      renderMessage(bodyEl, status === "searching" ? "検索中…" : "一致する項目がありません");
      return;
    }

    // ファイルごとにグループ化(G-02: 同じファイルの複数ヒットが並ぶと見づらいため)。
    // Map挿入順=ヒット到着順を保つことで、C#側の走査順(≒ツリー順)がそのまま出る。
    const groups = new Map();
    for (const hit of hits) {
      if (!groups.has(hit.path)) groups.set(hit.path, []);
      groups.get(hit.path).push(hit);
    }

    for (const [path, groupHits] of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "search-result-group";

      const header = document.createElement("div");
      header.className = "search-result-file";
      const nameEl = document.createElement("span");
      nameEl.className = "search-result-file-name";
      nameEl.textContent = groupHits[0].name;
      const pathEl = document.createElement("span");
      pathEl.className = "search-result-file-path";
      pathEl.textContent = groupHits[0].relativePath;
      const countEl = document.createElement("span");
      countEl.className = "search-result-file-count";
      countEl.textContent = String(groupHits.length);
      header.append(nameEl, pathEl, countEl);
      groupEl.appendChild(header);

      for (const hit of groupHits) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "search-result-hit";
        row.title = getCurrentLevel() === "none" ? "" : `${hit.relativePath}:${hit.line}`;
        const lineEl = document.createElement("span");
        lineEl.className = "search-result-line";
        lineEl.textContent = String(hit.line);
        const textEl = document.createElement("span");
        textEl.className = "search-result-text";
        // ヒット箇所の強調(先にエスケープしてから<mark>を差し込む。ファイル内容を
        // そのままinnerHTMLへ入れるとXSS・表示崩れの原因になるため)。
        textEl.innerHTML = highlightLine(hit.lineText, hit.matchOffset, hit.matchLength);
        row.append(lineEl, textEl);
        row.addEventListener("click", () => openHit(path, hit.line));
        groupEl.appendChild(row);
      }
      bodyEl.appendChild(groupEl);
    }

    if (status === "searching") {
      renderNotice(bodyEl, "検索中…");
    } else if (truncated) {
      renderNotice(bodyEl, "件数が多いため一部のみ表示しています");
    }
  }

  function renderNotice(bodyEl, message) {
    const notice = document.createElement("div");
    notice.className = "sidebar-notice";
    notice.textContent = message;
    bodyEl.appendChild(notice);
  }

  return { setQuery, handleResults, handleDone, hasQuery, setOnUpdate, render, cancel };
}
