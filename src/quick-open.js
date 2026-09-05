// クイックオープン(Ctrl+P、仕様書 第2.8節・F-05)。
// 読み込み済みフォルダ内のファイルを、入力文字のあいまい一致で絞り込んで開く。
// 見た目・操作(オーバーレイ・入力欄・上下キー選択・Enter/Escape)はコマンドパレット
// (commands.js の initCommandPalette)に合わせ、同じCSSクラス
// (.palette-overlay / .palette / #palette-input / #palette-list)をそのまま再利用する。

const RESULT_LIMIT = 50; // 一度に描画する候補数の上限(コマンドパレットと同じ考え方で軽く保つ)

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// relativePath(区切りは'/')から親フォルダ部分だけを取り出す。トップレベルなら空文字。
function parentDirOf(relativePath) {
  const idx = relativePath.lastIndexOf("/");
  return idx === -1 ? "" : relativePath.slice(0, idx);
}

// 入力文字(query)が、順序を保ったまま対象文字列(text)に(連続していなくてよいので)
// 現れるかを判定するあいまい一致。一致すれば各文字の一致位置(<mark>強調に使う)の配列を、
// 一致しなければnullを返す。大文字小文字は区別しない。
function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions = [];
  let searchFrom = 0;
  for (let i = 0; i < q.length; i++) {
    const idx = t.indexOf(q[i], searchFrom);
    if (idx === -1) return null;
    positions.push(idx);
    searchFrom = idx + 1;
  }
  return positions;
}

// 一致文字位置(positions)を基に、一致した文字だけ<mark>で囲んだHTML断片を組み立てる。
// ファイル名はファイルシステム由来の文字列のため、先にHTMLエスケープしてから組み立てる。
function highlight(text, positions) {
  const posSet = new Set(positions);
  let html = "";
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    html += posSet.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return html;
}

// createQuickOpen(ctx)
// ctx.getFolder(): main.js側で保持している直近読み込み成功分のフォルダデータ
//   ({ rootPath, rootName, entries, truncated } または未読み込みならnull)を返す関数。
// ctx.actions.openFileByPath(path): 選択したファイルを開く。
export function createQuickOpen(ctx) {
  let overlay = null;

  function close() {
    overlay?.remove();
    overlay = null;
  }

  function buildRow(entry, namePositions) {
    return {
      entry,
      nameHtml: namePositions ? highlight(entry.name, namePositions) : escapeHtml(entry.name),
      dir: parentDirOf(entry.relativePath),
    };
  }

  function open() {
    if (overlay) { close(); return; } // コマンドパレットと同様、開いている状態での再呼び出しはトグルとして閉じる

    overlay = document.createElement("div");
    overlay.className = "palette-overlay";
    overlay.innerHTML = '<div class="palette"><input id="palette-input" placeholder="ファイルを検索…" autocomplete="off"><ul id="palette-list"></ul></div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector("#palette-input");
    const list = overlay.querySelector("#palette-list");
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    const folder = ctx.getFolder();
    const files = folder && !folder.error ? folder.entries.filter((e) => !e.isDirectory) : null;

    if (!files) {
      // フォルダ未読み込み(仕様どおり文言のみ表示。絞り込み対象が無いためinputは無効化しない
      // が、Escapeでは閉じられるようにしておく)。
      const li = document.createElement("li");
      li.className = "palette-empty";
      li.textContent = "フォルダが読み込まれていません";
      list.appendChild(li);
      input.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      input.focus();
      return;
    }

    let sel = 0;
    let filtered = [];

    // UI点検第2弾 指摘9の修正: 絞り込み結果が0件のとき、以前は入力欄の下が
    // 空白のリストになり、「一致なし」なのか「読み込み中(まだ絞り込み処理が
    // 終わっていない)」なのか区別が付かなかった。フォルダ未読み込み時の案内
    // (.palette-empty、上のopen()内)と同じ見た目・クラスで「一致なし」を明示する。
    function render() {
      list.innerHTML = "";
      if (filtered.length === 0) {
        const li = document.createElement("li");
        li.className = "palette-empty";
        li.textContent = "一致するファイルがありません";
        list.appendChild(li);
        return;
      }
      filtered.forEach((row, i) => {
        const li = document.createElement("li");
        li.className = i === sel ? "sel" : "";
        li.innerHTML = `<span>${row.nameHtml}</span>` + (row.dir ? `<span class="palette-shortcut">${escapeHtml(row.dir)}</span>` : "");
        li.addEventListener("mousedown", (e) => { e.preventDefault(); close(); ctx.actions.openFileByPath(row.entry.path); });
        list.appendChild(li);
      });
    }

    function filter() {
      const q = input.value.trim();
      if (!q) {
        filtered = files.slice(0, RESULT_LIMIT).map((entry) => buildRow(entry, null));
      } else {
        // ファイル名でマッチしたものを優先し、名前でマッチしない場合のみ相対パス
        // (フォルダ部分)でのマッチも許す(仕様: 名前/相対パスのどちらかで一致すればよい)。
        const matched = [];
        for (const entry of files) {
          const namePositions = fuzzyMatch(q, entry.name);
          if (namePositions) { matched.push({ entry, namePositions, byName: true }); continue; }
          if (fuzzyMatch(q, entry.relativePath)) matched.push({ entry, namePositions: null, byName: false });
        }
        matched.sort((a, b) => {
          if (a.byName !== b.byName) return a.byName ? -1 : 1;
          return a.entry.name.localeCompare(b.entry.name, "ja");
        });
        filtered = matched.slice(0, RESULT_LIMIT).map(({ entry, namePositions }) => buildRow(entry, namePositions));
      }
      sel = 0;
      render();
    }

    input.addEventListener("input", filter);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); render(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); render(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = filtered[sel];
        if (row) { close(); ctx.actions.openFileByPath(row.entry.path); }
        return;
      }
    });
    filter();
    input.focus();
  }

  return { open, close };
}
