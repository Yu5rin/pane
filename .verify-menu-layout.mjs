// メニューの並び(src/commands.js の MENU_LAYOUT)の検査。ポートは8224。
//
// 2026-11 の点検まで、メニューはコマンドの定義の順にそのまま並べており、「表示」に32項目、
// 「編集」に26項目が1列に並んでいた。まとまりごとに下の階層へ入れ、並びを1か所で決める形にした。
// 並びを別に持つと「コマンドは足したが、メニューに書き忘れた」が起きるので、ここで見つける。
//   (1) メニューに属するコマンドは、すべて配置に書かれている(右クリック専用のものを除く)
//   (2) 配置に書かれているidは、すべて実在する。同じidを2回書いていない
//   (3) 上の階層の項目数が、決めた上限に収まっている(また1列に伸びていかないように)
//   (4) 続けて入力を求める項目の名前は「…」で終わる
//   (5) ヘルプメニューがあり、そこから取扱説明書・ショートカット一覧・バージョン情報へ行ける
//   (6) タブ形式でないとき「新しいタブ」は並ばない
import pw from "playwright";
const { chromium } = pw;
const PORT = 8224;
const browser = await chromium.launch();
let ng = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${cond || detail === undefined ? "" : `\n     実際: ${JSON.stringify(detail)}`}`);
  if (!cond) ng++;
};
const errors = [];

// ---- ブリッジ無し: コマンドの一覧と配置を突き合わせる ----
{
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!window.__paneDebugCtx?.commands, null, { timeout: 15000 });
  const info = await page.evaluate(() => {
    const commands = window.__paneDebugCtx.commands;
    const layout = window.__paneDebugMenuLayout;
    const ids = [];
    const top = {};
    const labels = [];
    const walk = (entries) => {
      for (const e of entries) {
        if (e === "---") continue;
        if (typeof e === "string") ids.push(e);
        else if (Array.isArray(e)) { ids.push(e[0]); labels.push(e); }
        else walk(e.items);
      }
    };
    for (const [menu, entries] of Object.entries(layout)) {
      top[menu] = entries.filter((e) => e !== "---").length;
      walk(entries);
    }
    return {
      ids, top, labels,
      commands: commands.map((c) => ({ id: c.id, menu: c.menu ?? null, contextOnly: !!c.contextOnly, label: c.label })),
    };
  });
  const inLayout = new Set(info.ids);
  const missing = info.commands.filter((c) => c.menu && !c.contextOnly && !inLayout.has(c.id)).map((c) => c.id);
  ok("(1) メニューに属するコマンドは、すべて配置に書かれている", missing.length === 0, missing);
  const known = new Set(info.commands.map((c) => c.id));
  const unknown = info.ids.filter((id) => !known.has(id));
  ok("(2) 配置に書かれているidは、すべて実在する", unknown.length === 0, unknown);
  const dup = info.ids.filter((id, i) => info.ids.indexOf(id) !== i);
  ok("(2) 同じidを2回書いていない", dup.length === 0, dup);
  const limits = { File: 15, Edit: 17, View: 17, Paragraph: 24, Format: 12, Help: 6 };
  for (const [menu, max] of Object.entries(limits)) {
    ok(`(3) ${menu} の上の階層は${max}項目以内 (実際=${info.top[menu]})`, info.top[menu] <= max);
  }
  // ダイアログや一覧が開くもの。名前が「…」で終わっていること。
  const needsEllipsis = ["file.open", "file.openFolder", "file.quickOpen", "file.saveAs", "file.print", "file.settings",
    "edit.find", "edit.replace", "edit.globalSearch", "view.gotoLine", "format.link", "format.image",
    "help.shortcuts", "help.commandPalette", "help.about"];
  const noEllipsis = needsEllipsis.filter((id) => !(info.labels.find((l) => l[0] === id)?.[1] ?? "").endsWith("…"));
  ok("(4) 続けて入力を求める項目の名前は「…」で終わる", noEllipsis.length === 0, noEllipsis);
  await page.close();
}

// ---- ブリッジあり: 実際に開いたメニューの中身 ----
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.chrome = { webview: {
      postMessage: (m) => { window.__sent.push(m); },
      addEventListener: (_t, fn) => listeners.push(fn),
    } };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__sent.some((m) => m.type === "ready"), null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const openMenu = async (label, name) => {
    await page.evaluate(() => { window.__sent.length = 0; });
    await page.click(`#menubar .menu-top:text-is('${label}')`);
    await page.waitForFunction((n) => window.__sent.some((m) => m.type === "open-menu" && m.menu === n), name, { timeout: 3000 });
    const items = await page.evaluate((n) => window.__sent.find((m) => m.type === "open-menu" && m.menu === n).items, name);
    await page.click(`#menubar .menu-top:text-is('${label}')`); // 閉じる
    await page.waitForTimeout(150);
    return items;
  };
  const tops = await page.$$eval("#menubar .menu-top", (els) => els.map((e) => e.textContent));
  ok("(5) メニューバーは ファイル・編集・表示・段落・書式・ヘルプ の順", JSON.stringify(tops) === JSON.stringify(["ファイル", "編集", "表示", "段落", "書式", "ヘルプ"]), tops);
  const help = await openMenu("ヘルプ", "Help");
  ok("(5) ヘルプに 取扱説明書(F1)・ショートカット一覧・コマンドパレット・バージョン情報 がある",
    help.map((i) => i.id).join(",") === "help.manual,help.shortcuts,help.commandPalette,help.about" && help[0].shortcut === "F1", help.map((i) => [i.id, i.shortcut]));
  // ヘルプの項目を選ぶと、設定がその分類で開く。
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.click("#menubar .menu-top:text-is('ヘルプ')");
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__reply({ type: "menu-command", id: "help.shortcuts" }));
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => window.__sent.find((m) => m.type === "open-settings-window"));
  ok("(5) 「キーボードショートカットの一覧…」で、設定がキーボードの分類で開く", opened?.category === "keyboard", opened);

  const file = await openMenu("ファイル", "File");
  ok("(6) タブ形式でないとき「新しいタブ」は並ばない", !file.some((i) => i.id === "file.newTab"), file.map((i) => i.id));
  const exp = file.find((i) => i.label === "エクスポート");
  ok("(6) エクスポートは下の階層に8形式がまとまっている", exp?.submenu?.length === 8 && exp.submenu[0].label === "PDF…", exp?.submenu?.map((i) => i.label));
  ok("(6) 保存と名前を付けて保存が隣り合う", file.findIndex((i) => i.id === "file.saveAs") - file.findIndex((i) => i.id === "file.save") === 1);

  // コードの文書では、Markdown専用の項目が灰色になり、「折りたたみ」が使えるようになる。
  await page.evaluate(() => window.__reply({ type: "file-opened", text: "function a() {\n  return 1;\n}\n", fileName: "a.js", path: "C:\\a.js", encoding: "UTF-8", lineEnding: "LF" }));
  await page.waitForTimeout(800);
  const para = await openMenu("段落", "Paragraph");
  ok("(6) コードの文書では、段落メニューの見出し1が灰色になる", para.find((i) => i.id === "para.h1")?.enabled === false);
  ok("(6) コードの文書でも、インデントは使える", para.find((i) => i.id === "para.indent")?.enabled === true);
  await page.close();
}

ok("ページエラー0件", errors.length === 0, errors);
console.log(`--- 集計: NG=${ng}`);
await browser.close();
process.exit(ng === 0 ? 0 : 1);
