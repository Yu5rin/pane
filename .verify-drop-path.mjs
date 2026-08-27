// D&Dフルパス取得の第1経路(postMessageWithAdditionalObjects)の検証。
// この環境のPlaywright(素のChromium)にはchrome.webviewが無いため、実際のWebView2の
// AdditionalObjects受け渡しは動かせない。ここではブリッジをモックして、
//   (1) postMessageWithAdditionalObjectsがある場合に第1経路が選ばれ、
//       メッセージ本体(type/name/size)とFileList(e.dataTransfer.filesそのまま)が渡ること
//   (2) モックから関数を消すと第2経路(open-dropped-file-by-name)に倒れること
//   (3) 第2経路でC#役がrequest-dropped-file-fallbackを返すと、従来どおり
//       open-dropped-file(バイト列)が送られること(保険経路の維持確認)
// を確認する。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));

// WebView2ブリッジをモックしてから読み込む(送信メッセージを記録し、C#役として応答する)
await page.addInitScript(() => {
  const listeners = [];
  window.__sent = [];
  window.__sentWithObjects = []; // postMessageWithAdditionalObjects呼び出しの記録
  window.chrome = {
    webview: {
      postMessage: (m) => { window.__sent.push(m); },
      // 実物と同じシグネチャ: (message, arrayLikeOfFiles)
      postMessageWithAdditionalObjects: (m, objects) => {
        window.__sentWithObjects.push({
          message: m,
          // FileListはそのまま保持しつつ、後でevaluateから読める形の要約も残す
          objectsLength: objects?.length ?? -1,
          isFileList: typeof FileList !== "undefined" && objects instanceof FileList,
          firstName: objects?.[0]?.name ?? null,
          firstSize: objects?.[0]?.size ?? null,
        });
      },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
});
await page.goto("http://localhost:8130/index.html");
await page.waitForTimeout(800);
const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

ok("起動時にreadyを送信", await page.evaluate(() => window.__sent.some((m) => m.type === "ready")));

// dropイベントを合成発火するヘルパー(window宛て。src/main.jsはcaptureフェーズで
// windowに登録しているため、windowへのdispatchで届く)
const dispatchDrop = (name, content) => page.evaluate(([n, c]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([c], n, { type: "text/markdown" }));
  const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
}, [name, content]);

// ---- (1) 第1経路: postMessageWithAdditionalObjectsが選ばれる ----
await dispatchDrop("メモ帳テスト.md", "hello drop");
await page.waitForTimeout(400);
const first = await page.evaluate(() => window.__sentWithObjects[0] ?? null);
ok("第1経路: postMessageWithAdditionalObjectsが1回呼ばれる",
  await page.evaluate(() => window.__sentWithObjects.length === 1));
ok(`第1経路: メッセージ本体がopen-dropped-file-with-path (${JSON.stringify(first?.message)})`,
  first?.message?.type === "open-dropped-file-with-path");
ok(`第1経路: メッセージ本体にname/sizeが載る (name=${first?.message?.name}, size=${first?.message?.size})`,
  first?.message?.name === "メモ帳テスト.md" && first?.message?.size === new Blob(["hello drop"]).size);
ok(`第1経路: 第2引数にFileListがそのまま渡る (isFileList=${first?.isFileList}, len=${first?.objectsLength}, [0].name=${first?.firstName})`,
  first?.isFileList === true && first?.objectsLength === 1 && first?.firstName === "メモ帳テスト.md" && first?.firstSize === first?.message?.size);
ok("第1経路: open-dropped-file-by-nameは送らない",
  await page.evaluate(() => !window.__sent.some((m) => m.type === "open-dropped-file-by-name")));

// ---- (2) 第2経路: 関数が無い(古いランタイム)とopen-dropped-file-by-nameに倒れる ----
await page.evaluate(() => { delete window.chrome.webview.postMessageWithAdditionalObjects; });
await dispatchDrop("旧ランタイム.md", "fallback body");
await page.waitForTimeout(400);
const byName = await page.evaluate(() => window.__sent.filter((m) => m.type === "open-dropped-file-by-name"));
ok(`第2経路: open-dropped-file-by-nameが送られる (${JSON.stringify(byName)})`,
  byName.length === 1 && byName[0].name === "旧ランタイム.md" && byName[0].size === new Blob(["fallback body"]).size);
ok("第2経路: postMessageWithAdditionalObjectsの呼び出し回数は増えない",
  await page.evaluate(() => window.__sentWithObjects.length === 1));

// ---- (3) 保険経路の維持: C#役が照合失敗を返すとバイト列フォールバックが届く ----
await page.evaluate(() => window.__reply({ type: "request-dropped-file-fallback" }));
await page.waitForTimeout(600);
const fallback = await page.evaluate(() => window.__sent.filter((m) => m.type === "open-dropped-file"));
ok(`保険経路: request-dropped-file-fallbackを受けてopen-dropped-file(バイト列)を送る (name=${fallback[0]?.name})`,
  fallback.length === 1 && fallback[0].name === "旧ランタイム.md" && typeof fallback[0].dataBase64 === "string" && fallback[0].dataBase64.length > 0);

console.log("--- ページエラー:", JSON.stringify(errors));
await browser.close();
