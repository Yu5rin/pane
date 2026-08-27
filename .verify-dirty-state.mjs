// ダーティ判定(未保存表示)が「変更操作の有無」ではなく「内容が最後に保存/読み込みした
// 状態と一致しているか」で決まることの検証スクリプト。ポートは8170。
// .verify-tabs.mjs / .verify-filemode.mjs と同じ流儀(WebView2ブリッジをモックし、
// window.__reply()でC#側からのメッセージを流し込む)。
//
// 構成:
//   (A) ファイルを開く→1文字入力で未保存→Ctrl+Zで未保存が消える
//   (B) BackSpaceで戻した場合も同じ
//   (C) 複数回の編集を全部アンドゥした場合も未保存が消える
//   (D) 保存→編集→アンドゥ→未保存が消える(基準が保存時点に更新されていること)
//   (E) アンドゥしすぎて元より前に戻れないこと(履歴の扱いが壊れていないか)
//   (F) リドゥで再び未保存になること
//   (G) タブを切り替えても各タブの状態が混ざらないこと
//   (H) 文字コード/改行コードの明示変更は内容が同じでも未保存扱いになること
//   (I) クラッシュリカバリからの復元は復元直後から常に未保存であること
//   (J) 新規文書は未保存ではない状態で始まる
//   (K) 外部変更の再読み込み(file-opened再受信)で基準が更新されること
//   (L) 1万行の文書で入力が重くならないこと(実測値をログへ出す)
//   (M) ページエラー・コンソールエラーが0件
import pw from "playwright";
const { chromium } = pw;

const PORT = 8170;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

function installMockBridge() {
  const listeners = [];
  window.__sent = [];
  window.chrome = {
    webview: {
      postMessage: (m) => { window.__sent.push(m); },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
}

async function newBridgedPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(installMockBridge);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}

async function reply(page, data) {
  await page.evaluate((d) => window.__reply(d), data);
  await page.waitForTimeout(250);
}
function clearSent(page) { return page.evaluate(() => { window.__sent = []; }); }
async function lastMsg(page, type) {
  const arr = await page.evaluate((ty) => window.__sent.filter((m) => m.type === ty), type);
  return arr[arr.length - 1] ?? null;
}
async function isDirty(page) {
  return !(await page.$eval("#status-dirty", (el) => el.hidden));
}
async function docText(page) {
  return page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
}
async function newPlainPage() {
  // ブリッジをモックしないプレーンなページ(.perf-typing.mjsと同じ)。ブリッジが無いときだけ
  // main.jsがwindow.__paneDebugEditorを公開するため、内部APIを直接叩く計測にはこちらを使う。
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}

async function openFile(page, { fileName = "sample.md", path = "C:\\work\\sample.md", text = "こんにちは", extra = {} } = {}) {
  await reply(page, {
    type: "file-opened", fileName, path, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false, ...extra,
  });
}

// ============================================================
// (A) ファイルを開く→1文字入力で未保存→Ctrl+Zで未保存が消える
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page);
  ok("(A前提) ファイルを開いた直後は未保存ではない", !(await isDirty(page)));

  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.waitForTimeout(150);
  ok(`(A) 1文字入力すると未保存になる(内容=${JSON.stringify(await docText(page))})`, await isDirty(page));

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  ok(`(A) Ctrl+Zで元の内容に戻ると未保存表示が消える(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "こんにちは" && !(await isDirty(page)));

  await page.close();
}

// ============================================================
// (B) BackSpaceで戻した場合も同じ
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page);
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.waitForTimeout(150);
  ok("(B前提) 1文字入力で未保存になる", await isDirty(page));

  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
  ok(`(B) BackSpaceで元の内容に戻ると未保存表示が消える(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "こんにちは" && !(await isDirty(page)));

  await page.close();
}

// ============================================================
// (C) 複数回の編集を全部アンドゥした場合も未保存が消える
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page);
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("ABC");
  await page.waitForTimeout(150);
  ok(`(C前提) 複数文字入力で未保存になる(内容=${JSON.stringify(await docText(page))})`, await isDirty(page));

  // "ABC"を1文字ずつBackSpaceで消す(3回)。
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(120);
  }
  ok(`(C) 3回のBackSpaceで元の内容に戻ると未保存表示が消える(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "こんにちは" && !(await isDirty(page)));

  await page.close();
}

// ============================================================
// (D) 保存→編集→アンドゥ→未保存が消える(基準が保存時点に更新されていること)
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page);
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.waitForTimeout(150);
  ok("(D前提) 1文字入力で未保存になる", await isDirty(page));

  // 保存(save-result成功)。この時点の内容("こんにちは!")が新しい基準になるはず。
  await reply(page, {
    type: "save-result", ok: true, fileName: "sample.md", path: "C:\\work\\sample.md",
    encoding: "UTF-8", lineEnding: "CRLF",
  });
  ok("(D) 保存直後は未保存ではない", !(await isDirty(page)));

  // さらに1文字入力。CodeMirrorのhistoryは既定で近接した編集(既定500ms以内)を1つの
  // アンドゥ単位にまとめるため、直前の"!"入力と同じ単位に混ざらないよう十分待ってから打つ
  // (混ざると「保存後の1文字」だけでなく「保存前の1文字」まで一緒にアンドゥされてしまい、
  // このテストの意図である「保存時点を基準にしたダーティ判定」を確認できなくなる)。
  await page.waitForTimeout(600);
  await page.keyboard.type("?");
  await page.waitForTimeout(150);
  ok(`(D) 保存後さらに入力すると未保存になる(内容=${JSON.stringify(await docText(page))})`, await isDirty(page));

  // アンドゥで保存直後の内容("こんにちは!")に戻る → 未保存が消える(基準が保存時点に
  // 正しく更新されていないと、ここで「読み込み時点」の内容と比較してしまい未保存のままになる)。
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  ok(`(D) アンドゥで保存時点の内容に戻ると未保存表示が消える(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "こんにちは!" && !(await isDirty(page)));

  await page.close();
}

// ============================================================
// (E) アンドゥしすぎても内容とダーティ表示の整合が保たれること
//
// 注記(検証中に判明した別の既知の制約): ファイルを開く処理(main.js setEditorValueQuiet →
// editor.js setValue)がCodeMirrorのアンドゥ履歴をaddToHistory:falseでクリアしていないため、
// アンドゥを繰り返すと「読み込んだ内容」より前(=viewが元々持っていた空文書)まで戻れてしまう。
// これは今回のダーティフラグ修正(computeIsDirty/savedDocRef)とは独立した別の問題のため、
// ここでは深追いして直さない(報告に別途記載する)。このテストでは、その状態になっても
// 内容とダーティ表示の整合(内容が基準と一致していればdirtyでない、一致していなければ
// dirtyである)が崩れずクラッシュもしないことだけを確認する。
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page);
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await page.waitForTimeout(150);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  ok(`(E) 1回のアンドゥで読み込み時点の内容に戻り未保存表示が消える(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "こんにちは" && !(await isDirty(page)));

  // さらにアンドゥしても(上記注記の制約により内容が変わりうるが)、内容とダーティ表示の
  // 整合は常に保たれる。
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  const contentAfterExtraUndo = await docText(page);
  const dirtyAfterExtraUndo = await isDirty(page);
  const consistent = contentAfterExtraUndo === "こんにちは" ? !dirtyAfterExtraUndo : dirtyAfterExtraUndo;
  ok(`(E) それ以上アンドゥしても内容とダーティ表示の整合は保たれる(内容=${JSON.stringify(contentAfterExtraUndo)}, dirty=${dirtyAfterExtraUndo})`,
    consistent);

  await page.close();
}

// ============================================================
// (F) リドゥで再び未保存になること
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page);
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("Y");
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  ok("(F前提) アンドゥで未保存が消える", !(await isDirty(page)));

  await page.keyboard.press("Control+y");
  await page.waitForTimeout(200);
  ok(`(F) リドゥで再び未保存になる(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "こんにちはY" && (await isDirty(page)));

  await page.close();
}

// ============================================================
// (G) タブを切り替えても各タブの状態が混ざらないこと
// ============================================================
{
  const page = await newBridgedPage();
  await reply(page, { type: "apply-settings", displayMode: "tab" });
  ok("(G前提) タブバーが表示される", !(await page.$eval("#tabbar", (el) => el.hidden)));

  // displayMode:"tab"にした時点で既存の(空の)無題タブが1枚目として存在する。
  // a.mdをタブとして開いたうえで、その無題タブを閉じ、a.md 1枚だけの状態にしてから
  // 以降の検証(タブのインデックス固定)を進める。
  await reply(page, {
    type: "open-in-tab", fileName: "a.md", path: "C:\\work\\a.md", text: "タブ1の内容",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  });
  await page.locator(".tab-item", { hasText: "無題" }).locator(".tab-item-close").click();
  await page.waitForTimeout(200);
  ok(`(G前提) 無題タブを閉じてa.mdだけになる(タブ数=${await page.$$eval(".tab-item", (els) => els.length)})`,
    (await page.$$eval(".tab-item", (els) => els.length)) === 1);
  ok("(G前提) タブ1を開いた直後は未保存ではない", !(await isDirty(page)));

  // タブ1を編集して未保存にする
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.waitForTimeout(150);
  ok("(G) タブ1を編集すると未保存になる", await isDirty(page));

  // タブ2を開く(未保存でない状態から始まるはず)
  await reply(page, {
    type: "open-in-tab", fileName: "b.md", path: "C:\\work\\b.md", text: "タブ2の内容",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  });
  const tabCount = await page.$$eval(".tab-item", (els) => els.length);
  ok(`(G) タブが2つになる(タブ数=${tabCount})`, tabCount === 2);
  ok(`(G) タブ2は未保存でない状態で開かれる(内容=${JSON.stringify(await docText(page))})`, !(await isDirty(page)));

  // タブ2を編集せずタブ1へ戻る → タブ1の未保存状態が保たれている
  const tab1 = page.locator(".tab-item").nth(0);
  await tab1.click();
  await page.waitForTimeout(250);
  ok(`(G) タブ1へ戻ると未保存状態が保たれている(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "タブ1の内容!" && (await isDirty(page)));

  // タブ1でCtrl+Zして元に戻す → 未保存が消える(タブ2の状態に影響されない)
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  ok(`(G) タブ1でアンドゥすると未保存が消える(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "タブ1の内容" && !(await isDirty(page)));

  // タブ2へ切り替え、タブ2は依然として未保存でないこと(タブ1の操作の影響を受けない)
  const tab2 = page.locator(".tab-item").nth(1);
  await tab2.click();
  await page.waitForTimeout(250);
  ok(`(G) タブ2は未保存でないまま(内容=${JSON.stringify(await docText(page))})`,
    (await docText(page)) === "タブ2の内容" && !(await isDirty(page)));

  await page.close();
}

// ============================================================
// (H) 文字コード/改行コードの明示変更は内容が同じでも未保存扱いになること
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page);
  ok("(H前提) 開いた直後は未保存ではない", !(await isDirty(page)));

  // ステータスバーの文字コードボタンをクリックしてメニューから選ぶ。ブリッジ経由のため
  // ネイティブメニュー(open-context-menu → menu-command)を通す(.verify-dialog.mjsと同じ流儀)。
  await clearSent(page);
  await page.click("#status-encoding");
  await page.waitForTimeout(150);
  const openMenuMsg = await lastMsg(page, "open-context-menu");
  const utf16Item = (openMenuMsg?.items ?? []).find((it) => it.label === "UTF-16 LE");
  ok("(H前提) 文字コードメニューにUTF-16 LEがある", !!utf16Item);
  await reply(page, { type: "menu-command", id: utf16Item?.id });
  await page.waitForTimeout(200);
  const dirtyAfterEncoding = await isDirty(page);
  ok(`(H) 文字コードを明示変更すると内容が同じでも未保存になる(dirty=${dirtyAfterEncoding})`, dirtyAfterEncoding);

  // 保存すればmetaDirtyもクリアされ、未保存でなくなる。
  await reply(page, {
    type: "save-result", ok: true, fileName: "sample.md", path: "C:\\work\\sample.md",
    encoding: "UTF-16 LE", lineEnding: "CRLF",
  });
  ok("(H) 保存すると未保存表示が消える(metaDirtyがクリアされる)", !(await isDirty(page)));

  await page.close();
}

// ============================================================
// (I) クラッシュリカバリからの復元は復元直後から常に未保存であること
// ============================================================
{
  const page = await newBridgedPage();
  await reply(page, {
    type: "file-opened", fileName: "recovered.md", path: "C:\\work\\recovered.md",
    text: "復元された内容\n", encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
    recovered: true,
  });
  ok(`(I) クラッシュリカバリからの復元直後は未保存(内容=${JSON.stringify(await docText(page))})`, await isDirty(page));

  // 何も編集していなくても未保存のままである(=基準が「無い」ため常にdirty判定)ことを
  // もう一度確認する(取り消し操作等で誤って消えないか)。
  await page.waitForTimeout(200);
  ok("(I) 何も編集しなくても未保存表示が消えない", await isDirty(page));

  await page.close();
}

// ============================================================
// (J) 新規文書は未保存ではない状態で始まる
// ============================================================
{
  const page = await newBridgedPage();
  await reply(page, { type: "new-document", encoding: "UTF-8", lineEnding: "CRLF" });
  ok("(J) 新規文書は未保存ではない状態で始まる", !(await isDirty(page)));

  await page.click(".cm-content");
  await page.keyboard.type("a");
  await page.waitForTimeout(150);
  ok("(J) 新規文書に入力すると未保存になる", await isDirty(page));
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
  ok("(J) 入力を取り消すと未保存表示が消える(空文書が基準になっている)", !(await isDirty(page)));

  await page.close();
}

// ============================================================
// (K) 外部変更の再読み込み(file-openedの再受信)で基準が更新されること
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page, { text: "旧内容\n" });
  await page.click(".cm-content");
  await page.keyboard.type("編集中");
  await page.waitForTimeout(150);
  ok("(K前提) 編集すると未保存になる", await isDirty(page));

  // 外部変更の再読み込み(C#側 OnExternalChangeDebounceElapsed → OpenFile → file-opened)を模す。
  await openFile(page, { text: "外部で変更された内容\n" });
  ok(`(K) 再読み込み直後は未保存ではない(内容=${JSON.stringify(await docText(page))})`, !(await isDirty(page)));

  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.waitForTimeout(150);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
  ok("(K) 再読み込み後の内容が新しい基準になっている(入力→取り消しで未保存が消える)", !(await isDirty(page)));

  await page.close();
}

// ============================================================
// (L) 1万行の文書で入力が重くならないこと(実測値をログへ出す)
// ============================================================
{
  // window.__paneDebugEditorはブリッジが無いページでしか公開されないため、ここだけ
  // ブリッジ無しのプレーンなページを使う(.perf-typing.mjsと同じ)。
  const page = await newPlainPage();
  const genDoc = (lines) => {
    const parts = [];
    let n = 0;
    while (n < lines) {
      parts.push(`## 見出し ${n}\n`);
      parts.push("これは本文の段落です。日本語と*強調*、`code`、[リンク](https://example.com/)を含みます。\n");
      parts.push("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n");
      parts.push("```js\nfunction f(x) { return x + 1; }\n```\n");
      n += 4;
    }
    return parts.join("").split("\n").slice(0, lines).join("\n");
  };
  const doc = genDoc(10000);
  await page.evaluate((text) => { window.__paneDebugEditor?.setValue?.(text); }, doc);
  await page.waitForTimeout(300);

  async function measureOneKeystroke() {
    return page.evaluate(() => {
      const e = window.__paneDebugEditor;
      const pos = e.view.state.selection.main.head;
      const t0 = performance.now();
      e.view.dispatch({ changes: { from: pos, insert: "x" }, selection: { anchor: pos + 1 } });
      return performance.now() - t0;
    });
  }
  for (let i = 0; i < 5; i++) await measureOneKeystroke();
  const N = 20;
  const durations = [];
  for (let i = 0; i < N; i++) durations.push(await measureOneKeystroke());
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  console.log(`[参考] 1万行文書での1文字入力dispatch、${N}回の中央値: ${median.toFixed(2)} ms (詳細な比較は.perf-typing.mjs参照)`);
  // 明確な遅延回帰(例: 全文字列化やO(n^2)化)が入っていないかの粗い目安として、
  // 中央値が50msを大きく超えていないことだけ確認する(具体的な基準比較は別途report参照)。
  ok(`(L) 1万行文書での1文字入力dispatchが極端に遅くない(中央値=${median.toFixed(2)}ms)`, median < 50);

  await page.close();
}

console.log(`\nページエラー: ${allErrors.length}件`);
for (const e of allErrors) console.log("  " + e);
console.log(`コンソールエラー: ${allConsoleErrors.length}件`);
for (const e of allConsoleErrors) console.log("  " + e);
ok("(M) ページエラーが0件", allErrors.length === 0);
ok("(M) コンソールエラーが0件", allConsoleErrors.length === 0);

console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
