// コマンドレジストリ・メニューバー・コマンドパレット(仕様書 第2章・第10.1節・第10.4節)。
// 「メニューバーと機能を重複させ、どちらか一方だけでも全操作に到達できる状態にする」
// という設計方針(第10.1節)に沿い、メニュー項目とコマンドパレット項目は同じ配列
// (buildCommands の戻り値)を参照する。
//
// ctx の形:
//   {
//     editor,                 // createEditor()の戻り値
//     bridge,                 // window.chrome.webview または null
//     getState(),             // { mode, isReadOnly, pandocAvailable, wordWrap } を返す
//     actions: { ... },       // main.js側のファイル操作・ダイアログ等のオーケストレーション
//   }

// Paneは仕様書上Windows専用(WinForms + WebView2)のため、修飾キーはCtrl固定でよい。
const MOD = "Ctrl";

// メニュー配下の項目定義。grayed(ctx)がtrueを返す項目は無効表示にする
// (仕様書: フォルダ機能に依存する項目はPhase 6まで準備中)。
export function buildCommands(ctx) {
  const editor = () => ctx.editor;
  const app = (fn) => () => fn(ctx);

  return [
    // ---- File(第2.1節) ----
    { id: "file.new", menu: "File", label: "新規作成", shortcut: `${MOD}+N`, run: app((c) => c.actions.newDocument()) },
    { id: "file.newWindow", menu: "File", label: "新しいウィンドウ", shortcut: `${MOD}+Shift+N`, run: app((c) => c.actions.newWindow()) },
    { id: "file.newTab", menu: "File", label: "新しいタブ", grayed: () => true, note: "準備中(Phase 8)" },
    { id: "file.open", menu: "File", label: "開く", shortcut: `${MOD}+O`, run: app((c) => c.actions.openFile()) },
    { id: "file.openFolder", menu: "File", label: "フォルダを開く", grayed: () => true, note: "準備中(Phase 6)" },
    { id: "file.quickOpen", menu: "File", label: "クイックオープン", shortcut: `${MOD}+P`, grayed: () => true, note: "準備中(Phase 6)" },
    { id: "file.reopenClosed", menu: "File", label: "閉じたファイルを再度開く", shortcut: `${MOD}+Shift+T`, run: app((c) => c.actions.reopenClosed()), enabled: () => ctx.getState().hasClosedFile },
    {
      id: "file.recentFiles", menu: "File", label: "最近使ったファイル",
      submenu: () => {
        const files = ctx.getState().recentFiles ?? [];
        if (!files.length) return [{ label: "(なし)", disabled: true }];
        return files.map((p) => ({ label: p, run: () => ctx.actions.openRecentFile(p) }));
      },
      separatorAfter: true,
    },
    { id: "file.save", menu: "File", label: "保存", shortcut: `${MOD}+S`, run: app((c) => c.actions.save()) },
    { id: "file.saveAs", menu: "File", label: "名前を付けて保存", shortcut: `${MOD}+Shift+S`, run: app((c) => c.actions.saveAs()), separatorAfter: true },
    { id: "file.exportPdf", menu: "File", label: "エクスポート: PDF", run: app((c) => c.actions.exportAs("pdf")) },
    { id: "file.exportHtml", menu: "File", label: "エクスポート: HTML", run: app((c) => c.actions.exportAs("html")) },
    { id: "file.exportHtmlPlain", menu: "File", label: "エクスポート: HTML(スタイルなし)", run: app((c) => c.actions.exportAs("html-plain")) },
    { id: "file.exportWord", menu: "File", label: "エクスポート: Word", run: app((c) => c.actions.exportAs("docx")), enabled: () => ctx.getState().pandocAvailable, note: "Pandoc未導入" },
    { id: "file.exportEpub", menu: "File", label: "エクスポート: EPUB", run: app((c) => c.actions.exportAs("epub")), enabled: () => ctx.getState().pandocAvailable, note: "Pandoc未導入", separatorAfter: true },
    { id: "file.print", menu: "File", label: "印刷", shortcut: `${MOD}+Alt+P`, run: app((c) => c.actions.print()), separatorAfter: true },
    { id: "file.settings", menu: "File", label: "設定", shortcut: `${MOD}+,`, run: app((c) => c.actions.openSettings()), separatorAfter: true },
    { id: "file.close", menu: "File", label: "閉じる", shortcut: `${MOD}+W`, run: app((c) => c.actions.closeWindow()) },

    // ---- Edit(第2.2節) ----
    { id: "edit.copyMarkdown", menu: "Edit", label: "マークダウンとしてコピー", shortcut: `${MOD}+Shift+C`, run: app((c) => c.actions.copyAsMarkdown()) },
    { id: "edit.copyHtml", menu: "Edit", label: "HTMLとしてコピー", run: app((c) => c.actions.copyAsHtml()) },
    { id: "edit.pastePlain", menu: "Edit", label: "プレーンテキストとして貼り付け", shortcut: `${MOD}+Shift+V`, run: app((c) => c.actions.pasteAsPlainText()), separatorAfter: true },
    { id: "edit.selectLine", menu: "Edit", label: "行/文を選択", shortcut: `${MOD}+L`, run: () => editor().applyAction("selectLine") },
    { id: "edit.selectStyleRange", menu: "Edit", label: "スタイル範囲を選択", shortcut: `${MOD}+E`, run: () => editor().applyAction("selectStyleRange") },
    { id: "edit.selectWord", menu: "Edit", label: "単語を選択", shortcut: `${MOD}+D`, run: () => editor().applyAction("selectWord") },
    { id: "edit.deleteWord", menu: "Edit", label: "単語を削除", shortcut: `${MOD}+Shift+D`, run: () => editor().applyAction("deleteWord") },
    { id: "edit.deleteTableRow", menu: "Edit", label: "表の行を削除", shortcut: `${MOD}+Shift+Backspace`, run: () => editor().applyAction("deleteTableRow"), separatorAfter: true },
    { id: "edit.jumpToSelection", menu: "Edit", label: "選択箇所へジャンプ", shortcut: `${MOD}+J`, run: () => editor().applyAction("scrollToSelection"), separatorAfter: true },
    { id: "edit.find", menu: "Edit", label: "検索", shortcut: `${MOD}+F`, run: app((c) => c.actions.openSearch()) },
    { id: "edit.findNext", menu: "Edit", label: "次を検索", shortcut: "F3", run: () => editor().findNext() },
    { id: "edit.findPrev", menu: "Edit", label: "前を検索", shortcut: "Shift+F3", run: () => editor().findPrevious() },
    { id: "edit.replace", menu: "Edit", label: "置換", shortcut: `${MOD}+H`, run: app((c) => c.actions.openReplace()) },

    // ---- Paragraph(第2.3節) ----
    { id: "para.h1", menu: "Paragraph", label: "見出し1", shortcut: `${MOD}+1`, run: () => editor().applyAction("h1") },
    { id: "para.h2", menu: "Paragraph", label: "見出し2", shortcut: `${MOD}+2`, run: () => editor().applyAction("h2") },
    { id: "para.h3", menu: "Paragraph", label: "見出し3", shortcut: `${MOD}+3`, run: () => editor().applyAction("h3") },
    { id: "para.h4", menu: "Paragraph", label: "見出し4", shortcut: `${MOD}+4`, run: () => editor().applyAction("h4") },
    { id: "para.h5", menu: "Paragraph", label: "見出し5", shortcut: `${MOD}+5`, run: () => editor().applyAction("h5") },
    { id: "para.h6", menu: "Paragraph", label: "見出し6", shortcut: `${MOD}+6`, run: () => editor().applyAction("h6") },
    { id: "para.p", menu: "Paragraph", label: "段落(見出し解除)", shortcut: `${MOD}+0`, run: () => editor().applyAction("h0") },
    { id: "para.headingUp", menu: "Paragraph", label: "見出しレベルを上げる", shortcut: `${MOD}+=`, run: () => editor().applyAction("headingUp") },
    { id: "para.headingDown", menu: "Paragraph", label: "見出しレベルを下げる", shortcut: `${MOD}+-`, run: () => editor().applyAction("headingDown"), separatorAfter: true },
    { id: "para.table", menu: "Paragraph", label: "表を挿入", shortcut: `${MOD}+T`, run: () => editor().applyAction("table") },
    { id: "para.codeblock", menu: "Paragraph", label: "コードブロックを挿入", shortcut: `${MOD}+Shift+K`, run: () => editor().applyAction("codeblock") },
    { id: "para.mathBlock", menu: "Paragraph", label: "数式ブロックを挿入", shortcut: `${MOD}+Shift+M`, run: () => editor().applyAction("mathBlock") },
    { id: "para.quote", menu: "Paragraph", label: "引用", shortcut: `${MOD}+Shift+Q`, run: () => editor().applyAction("quote") },
    { id: "para.olist", menu: "Paragraph", label: "番号付きリスト", shortcut: `${MOD}+Shift+[`, run: () => editor().applyAction("olist") },
    { id: "para.list", menu: "Paragraph", label: "箇条書きリスト", shortcut: `${MOD}+Shift+]`, run: () => editor().applyAction("list") },
    { id: "para.indent", menu: "Paragraph", label: "インデント", shortcut: `${MOD}+[`, run: () => editor().applyAction("indent") },
    { id: "para.outdent", menu: "Paragraph", label: "アウトデント", shortcut: `${MOD}+]`, run: () => editor().applyAction("outdent"), separatorAfter: true },
    { id: "para.listBullet", menu: "Paragraph", label: "箇条書きに変換", contextOnly: true, run: () => editor().applyAction("listBullet") },
    { id: "para.listOrdered", menu: "Paragraph", label: "番号付きリストに変換", contextOnly: true, run: () => editor().applyAction("listOrdered") },
    { id: "para.listCheck", menu: "Paragraph", label: "タスクリストに変換", contextOnly: true, run: () => editor().applyAction("listCheck"), separatorAfter: true },
    { id: "para.frontMatter", menu: "Paragraph", label: "YAML Front Matterを挿入", run: () => editor().applyAction("frontMatter") },

    // ---- Format(第2.4節) ----
    { id: "format.bold", menu: "Format", label: "太字", shortcut: `${MOD}+B`, run: () => editor().applyAction("bold") },
    { id: "format.italic", menu: "Format", label: "斜体", shortcut: `${MOD}+I`, run: () => editor().applyAction("italic") },
    { id: "format.underline", menu: "Format", label: "下線", shortcut: `${MOD}+U`, run: () => editor().applyAction("underline") },
    { id: "format.code", menu: "Format", label: "インラインコード", shortcut: "Ctrl+Shift+`", run: () => editor().applyAction("code") },
    { id: "format.strike", menu: "Format", label: "打消し線", shortcut: "Alt+Shift+5", run: () => editor().applyAction("strike") },
    { id: "format.highlight", menu: "Format", label: "ハイライト", run: () => editor().applyAction("highlight") },
    { id: "format.superscript", menu: "Format", label: "上付き文字", run: () => editor().applyAction("superscript") },
    { id: "format.subscript", menu: "Format", label: "下付き文字", run: () => editor().applyAction("subscript"), separatorAfter: true },
    { id: "format.link", menu: "Format", label: "ハイパーリンク", shortcut: `${MOD}+K`, run: () => editor().applyAction("link") },
    { id: "format.image", menu: "Format", label: "画像", shortcut: `${MOD}+Shift+I`, run: app((c) => c.actions.insertImageFlow()), separatorAfter: true },
    { id: "format.eraseFormat", menu: "Format", label: "書式を消去", shortcut: `${MOD}+\\`, run: () => editor().applyAction("eraseFormat") },

    // ---- View(第2.5節) ----
    { id: "view.sidebar", menu: "View", label: "サイドバーの表示切替", shortcut: `${MOD}+Shift+L`, grayed: () => true, note: "準備中(Phase 6)" },
    { id: "view.outline", menu: "View", label: "アウトラインパネル", shortcut: `${MOD}+Shift+1`, grayed: () => true, note: "準備中(Phase 6)" },
    { id: "view.articleList", menu: "View", label: "記事リスト", shortcut: `${MOD}+Shift+2`, grayed: () => true, note: "準備中(Phase 6)" },
    { id: "view.fileTree", menu: "View", label: "ファイルツリー", shortcut: `${MOD}+Shift+3`, grayed: () => true, note: "準備中(Phase 6)", separatorAfter: true },
    { id: "view.modeMarkdown", menu: "View", label: "Markdownモード", run: app((c) => c.actions.setMode("markdown")), checked: () => ctx.getState().mode === "markdown" },
    { id: "view.modePlain", menu: "View", label: "プレーンテキストモード", run: app((c) => c.actions.setMode("plain")), checked: () => ctx.getState().mode === "plain" },
    { id: "view.modeCode", menu: "View", label: "コードモード", run: app((c) => c.actions.setMode("code")), checked: () => ctx.getState().mode === "code", separatorAfter: true },
    { id: "view.wordWrap", menu: "View", label: "折り返し表示", run: app((c) => c.actions.toggleWordWrap()), checked: () => ctx.getState().wordWrap },
    { id: "view.gotoLine", menu: "View", label: "指定行へジャンプ", shortcut: `${MOD}+G`, run: app((c) => c.actions.gotoLineFlow()), separatorAfter: true },
    { id: "view.devtools", menu: "View", label: "開発者ツール", shortcut: "Shift+F12", run: app((c) => c.actions.openDevTools()), enabled: () => !!ctx.bridge },
  ];
}

// ---- メニューバー(仕様書 第10.1節・第10.4節) ----
// 既定は表示。Altキーで表示・非表示をトグルする(表示中はショートカット一覧としても機能する)。
// 内部の分類キー(コマンド定義の menu プロパティ、File/Edit/Paragraph/Format/View)は
// 既存コード全体の判定に使われているため英語のまま維持し、表示ラベルだけ日本語化する
// (多言語対応は将来別途行う予定のため、ここでは決め打ちの日本語のみとする)。
const MENU_LABELS = { File: "ファイル", Edit: "編集", Paragraph: "段落", Format: "書式", View: "表示" };
export function initMenuBar(container, commands, ctx) {
  const menus = ["File", "Edit", "Paragraph", "Format", "View"];
  // コンテナ末尾には右端寄せ用のスペーサーとテーマ切替ボタンが静的HTML側で既に置かれているため、
  // それらは残したまま、メニュー項目だけをその手前に挿入する。
  const anchor = container.firstChild;
  container.querySelectorAll(".menu-top").forEach((el) => el.remove());
  container.setAttribute("role", "menubar");
  let openMenu = null;

  function closeAll() {
    container.querySelectorAll(".menu-dropdown").forEach((el) => el.remove());
    container.querySelectorAll(".menu-top.open").forEach((el) => el.classList.remove("open"));
    openMenu = null;
    document.removeEventListener("mousedown", onOutsideClick, true);
    document.removeEventListener("keydown", onMenuKeydown, true);
  }
  function onOutsideClick(e) {
    if (!container.contains(e.target)) closeAll();
  }
  function onMenuKeydown(e) {
    if (e.key === "Escape") { closeAll(); return; }
  }

  // サブメニュー(最近使ったファイル等)を親項目の右側に表示する。動的リストなので
  // 開くたびに item.submenu(ctx) を呼び直す。
  function renderSubmenu(entries, anchorRow) {
    const rect = anchorRow.getBoundingClientRect();
    const sub = document.createElement("div");
    sub.className = "menu-dropdown";
    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "menu-item" + (entry.disabled ? " disabled" : "");
      row.innerHTML = `<span class="menu-item-check"></span><span class="menu-item-label">${entry.label}</span><span class="menu-item-shortcut"></span>`;
      if (entry.disabled) row.disabled = true;
      else row.addEventListener("click", () => { closeAll(); entry.run(); });
      sub.appendChild(row);
    }
    sub.style.left = rect.right + "px";
    sub.style.top = rect.top + "px";
    container.appendChild(sub);
    return sub;
  }

  function renderDropdown(menuName, anchorEl) {
    const items = commands.filter((c) => c.menu === menuName && !c.contextOnly);
    const dd = document.createElement("div");
    dd.className = "menu-dropdown";
    for (const item of items) {
      const grayed = item.grayed?.(ctx) ?? false;
      const enabled = !grayed && (item.enabled ? item.enabled(ctx) : true);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "menu-item" + (enabled ? "" : " disabled");
      const checked = item.checked?.(ctx);
      row.innerHTML = `<span class="menu-item-check">${checked ? "✓" : ""}</span>` +
        `<span class="menu-item-label">${item.label}</span>` +
        `<span class="menu-item-shortcut">${item.submenu ? "▶" : item.shortcut ? item.shortcut : (item.note ?? "")}</span>`;
      if (item.submenu) {
        let subEl = null;
        row.addEventListener("mouseenter", () => {
          subEl?.remove();
          subEl = renderSubmenu(item.submenu(ctx), row);
        });
        row.addEventListener("mouseleave", (e) => {
          if (subEl && !subEl.contains(e.relatedTarget)) { subEl.remove(); subEl = null; }
        });
      } else if (enabled) {
        row.addEventListener("click", () => { closeAll(); item.run(); });
      } else {
        row.disabled = true;
        if (item.note) row.title = item.note;
      }
      dd.appendChild(row);
      if (item.separatorAfter) {
        const sep = document.createElement("div");
        sep.className = "menu-separator";
        dd.appendChild(sep);
      }
    }
    const rect = anchorEl.getBoundingClientRect();
    dd.style.left = rect.left + "px";
    dd.style.top = rect.bottom + "px";
    container.appendChild(dd);
    return dd;
  }

  for (const menuName of menus) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-top";
    btn.textContent = MENU_LABELS[menuName] ?? menuName;
    btn.addEventListener("click", () => {
      if (openMenu === menuName) { closeAll(); return; }
      closeAll();
      openMenu = menuName;
      btn.classList.add("open");
      renderDropdown(menuName, btn);
      document.addEventListener("mousedown", onOutsideClick, true);
      document.addEventListener("keydown", onMenuKeydown, true);
    });
    btn.addEventListener("mouseenter", () => {
      if (openMenu && openMenu !== menuName) {
        closeAll();
        openMenu = menuName;
        btn.classList.add("open");
        renderDropdown(menuName, btn);
        document.addEventListener("mousedown", onOutsideClick, true);
        document.addEventListener("keydown", onMenuKeydown, true);
      }
    });
    container.insertBefore(btn, anchor);
  }

  // Altキーでの表示・非表示トグル(仕様書 第10.1節・第10.4節)。
  // 単押しのAltのみを対象とし、Alt+他キーの組み合わせ(OS標準ショートカット等)は無視する。
  let altArmed = false;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && !e.repeat) altArmed = true;
    else if (e.key !== "Alt") altArmed = false;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && altArmed) {
      altArmed = false;
      container.classList.toggle("hidden");
      closeAll();
    }
  });

  return { closeAll };
}

// ---- コマンドパレット(Ctrl+Shift+P、仕様書 第10.1節) ----
export function initCommandPalette(root, commands, ctx) {
  let overlay = null;
  function close() {
    overlay?.remove();
    overlay = null;
  }
  function open() {
    if (overlay) { close(); return; }
    const available = commands.filter((c) => !c.contextOnly && !(c.grayed?.(ctx) ?? false) && (c.enabled ? c.enabled(ctx) : true));
    overlay = document.createElement("div");
    overlay.className = "palette-overlay";
    overlay.innerHTML = `<div class="palette"><input id="palette-input" placeholder="コマンドを検索…" autocomplete="off"><ul id="palette-list"></ul></div>`;
    root.appendChild(overlay);
    const input = overlay.querySelector("#palette-input");
    const list = overlay.querySelector("#palette-list");
    let sel = 0;
    let filtered = available;
    function render() {
      list.innerHTML = "";
      filtered.forEach((cmd, i) => {
        const li = document.createElement("li");
        li.className = i === sel ? "sel" : "";
        const menuLabel = cmd.menu ? (MENU_LABELS[cmd.menu] ?? cmd.menu) : "";
        li.innerHTML = `<span>${menuLabel ? menuLabel + ": " : ""}${cmd.label}</span>` + (cmd.shortcut ? `<span class="palette-shortcut">${cmd.shortcut}</span>` : "");
        li.addEventListener("mousedown", (e) => { e.preventDefault(); close(); cmd.run(); });
        list.appendChild(li);
      });
    }
    function filter() {
      const q = input.value.trim().toLowerCase();
      filtered = !q ? available : available.filter((c) => c.label.toLowerCase().includes(q) || (c.menu ?? "").toLowerCase().includes(q));
      sel = 0;
      render();
    }
    input.addEventListener("input", filter);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); render(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); render(); return; }
      if (e.key === "Enter") { e.preventDefault(); const cmd = filtered[sel]; if (cmd) { close(); cmd.run(); } return; }
    });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    filter();
    input.focus();
  }
  return { open, close };
}

// ---- 右クリックコンテキストメニュー(仕様書 第10.1節「右クリックからも呼び出せる」) ----
export function initContextMenu(hostEl, commands, ctx, resolveContextCommandIds) {
  let menuEl = null;
  function close() { menuEl?.remove(); menuEl = null; }
  hostEl.addEventListener("contextmenu", (e) => {
    const ids = resolveContextCommandIds(ctx, e);
    if (!ids || !ids.length) return; // 既定のブラウザメニューに任せる(未対応箇所)
    e.preventDefault();
    close();
    menuEl = document.createElement("div");
    menuEl.className = "menu-dropdown";
    menuEl.style.left = e.clientX + "px";
    menuEl.style.top = e.clientY + "px";
    for (const id of ids) {
      const cmd = commands.find((c) => c.id === id);
      if (!cmd) continue;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "menu-item";
      row.innerHTML = `<span class="menu-item-check"></span><span class="menu-item-label">${cmd.label}</span><span class="menu-item-shortcut">${cmd.shortcut ?? ""}</span>`;
      row.addEventListener("click", () => { close(); cmd.run(); });
      menuEl.appendChild(row);
    }
    document.body.appendChild(menuEl);
    const onOutside = (ev) => { if (!menuEl.contains(ev.target)) { close(); document.removeEventListener("mousedown", onOutside, true); } };
    document.addEventListener("mousedown", onOutside, true);
  });
  return { close };
}

// ---- ショートカット・ディスパッチ ----
// メニューバーが非表示でもショートカットキー自体は常に有効(第10.4節: 表示中は一覧としても機能する、
// であって非表示中は無効になるわけではない)。
//
// 全ショートカットをwindowのcaptureフェーズ(第3引数true)で1本にまとめて待ち受ける。
// captureフェーズはターゲット(CodeMirrorのcontentDOM・検索ボックスのinput等)へ
// イベントが届く前に発火するため、(1)CodeMirror既定のキーマップ(Ctrl+I/U/[/]等)より
// 確実に先着でき、(2)検索ボックス等どのDOM要素にフォーカスがあっても素通りしない。
// 割り当てているショートカットはすべてCtrl修飾または機能キーのみ(通常の文字入力と
// 衝突しない)ため、入力欄にフォーカスがあってもここで奪って問題ない。
function isShortcutEnabled(cmd, ctx) {
  const grayed = cmd.grayed?.(ctx) ?? false;
  return !grayed && (cmd.enabled ? cmd.enabled(ctx) : true);
}
export function bindShortcuts(commands, ctx) {
  const scoped = commands.filter((c) => c.shortcut).map((c) => ({ cmd: c, combo: parseShortcut(c.shortcut) }));
  window.addEventListener("keydown", (e) => {
    for (const { cmd, combo } of scoped) {
      if (!matchesShortcut(e, combo)) continue;
      if (!isShortcutEnabled(cmd, ctx)) {
        console.log(`[shortcut] ${cmd.shortcut} は一致したが無効(grayed/enabled=false): ${cmd.id}`);
        continue;
      }
      e.preventDefault();
      e.stopPropagation();
      console.log(`[shortcut] ${cmd.shortcut} -> ${cmd.id}`);
      cmd.run();
      return;
    }
  }, true);
}
function parseShortcut(s) {
  const parts = s.split("+");
  const key = parts.pop();
  return {
    key: key.toLowerCase(),
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}
// 記号キーはShift併用時にe.keyが別の文字になる(例: Shift+` → "~")ため、
// 物理キー(e.code)で判定する。それ以外は論理キー(e.key)で判定する。
const SYMBOL_CODE_MAP = { "`": "Backquote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal" };
function matchesShortcut(e, combo) {
  if (SYMBOL_CODE_MAP[combo.key]) {
    if (e.code !== SYMBOL_CODE_MAP[combo.key]) return false;
  } else if (e.key.toLowerCase() !== combo.key) {
    return false;
  }
  if ((e.ctrlKey || e.metaKey) !== combo.ctrl) return false;
  if (e.shiftKey !== combo.shift) return false;
  if (e.altKey !== combo.alt) return false;
  return true;
}
