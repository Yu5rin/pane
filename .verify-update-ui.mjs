// 設定「バージョン情報」→「更新」(仕様書 U-01〜U-04)の検証。ポートは8214。
//
// 確認するのは「利用者がボタンを押したときにだけ通信すること」と、C#からの返信
// (update-check-result / update-progress)で画面が正しく変わること。実際の通信・
// ダウンロード・入れ替えはC#側(Pane/UpdateService.cs)の担当で、ここでは扱わない。
//
// 構成:
//   セッションA: 最新版だったとき / 新しい版があったとき / 各ボタンの送信メッセージ
//   セッションB: 「更新する」を押してからの進捗表示と失敗表示
//   セッションC: 画面を開いただけでは何も送らない(自動では通信しない)
const PORT = 8214;
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();

let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

const allErrors = [];
const allConsoleErrors = [];

const SETTINGS_REPLY = {
  type: "settings",
  theme: "light",
  appVersion: "1.0.4",
  webView2Version: "120.0.2210.144",
  dotNetVersion: "8.0.10",
  settingsFilePath: "C:\\Users\\test\\AppData\\Local\\Pane\\settings.json",
  logFolderPath: "C:\\Users\\test\\AppData\\Local\\Pane\\logs",
  themeFolderPath: "C:\\Users\\test\\AppData\\Local\\Pane\\themes",
  licenses: [{ name: "CodeMirror 6", license: "MIT License" }],
  updateCheckUrl: "https://api.github.com/repos/Yu5rin/pane/releases/latest",
  checkUpdateOnStartup: true,
};

async function newPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.chrome = {
      webview: {
        postMessage: (m) => { window.__sent.push(m); },
        addEventListener: (_t, fn) => listeners.push(fn),
      },
    };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(`http://localhost:${PORT}/settings-window.html`);
  await page.waitForTimeout(700);
  await page.evaluate((reply) => window.__reply(reply), SETTINGS_REPLY);
  await page.waitForTimeout(300);
  return page;
}

// 「バージョン情報」カテゴリを開く。
async function openVersionInfo(page) {
  const cats = await page.$$eval(".settings-nav-item", (els) => els.map((e) => e.textContent.trim()));
  const idx = cats.findIndex((c) => c === "バージョン情報");
  await page.click(`.settings-nav-item >> nth=${idx}`);
  await page.waitForTimeout(200);
  return idx >= 0;
}

const sentTypes = (page) => page.evaluate(() => window.__sent.map((m) => m.type));
const sectionText = (page) =>
  page.evaluate(() => document.querySelector("[data-update-section]")?.textContent ?? "");

// ============================================================
// (A) 確認の結果表示と、各ボタンの送信メッセージ
// ============================================================
{
  const page = await newPage();
  ok("(A) バージョン情報カテゴリがある", await openVersionInfo(page));
  ok("(A) 「更新」セクションがある", (await page.$("[data-update-section]")) !== null);
  ok("(A) 「更新を確認」ボタンがある", (await page.$('[data-update-action="check"]')) !== null);
  ok("(A) 押す前は「更新する」ボタンが出ていない", (await page.$('[data-update-action="apply"]')) === null);

  // 押すと check-update を送り、その間はボタンが押せなくなる。
  await page.click('[data-update-action="check"]');
  await page.waitForTimeout(150);
  ok("(A) 「更新を確認」でcheck-updateを送る", (await sentTypes(page)).includes("check-update"));
  ok("(A) 確認中はボタンが押せない",
    await page.$eval('[data-update-action="check"]', (b) => b.disabled));

  // 最新版だった場合。
  await page.evaluate(() => window.__reply({
    type: "update-check-result", status: "latest", currentVersion: "1.0.4", latestVersion: "v1.0.4",
    message: "お使いのPaneは最新版です。", releaseUrl: "https://github.com/Yu5rin/pane/releases/tag/v1.0.4",
    canApply: false, sizeBytes: 0,
  }));
  await page.waitForTimeout(200);
  ok(`(A) 最新版のときメッセージが出る "${await sectionText(page)}"`,
    (await sectionText(page)).includes("最新版です"));
  ok("(A) 最新版のときは「更新する」ボタンを出さない", (await page.$('[data-update-action="apply"]')) === null);
  ok("(A) 確認が終わればボタンがまた押せる",
    !(await page.$eval('[data-update-action="check"]', (b) => b.disabled)));

  // 新しい版があった場合。
  await page.evaluate(() => window.__reply({
    type: "update-check-result", status: "available", currentVersion: "1.0.4", latestVersion: "v1.0.5",
    message: "新しい版 v1.0.5 があります。", releaseUrl: "https://github.com/Yu5rin/pane/releases/tag/v1.0.5",
    canApply: true, sizeBytes: 75 * 1024 * 1024,
  }));
  await page.waitForTimeout(200);
  const availableText = await sectionText(page);
  ok(`(A) 新しい版があるとメッセージが出る "${availableText}"`, availableText.includes("v1.0.5"));
  ok("(A) 新しい版があると「更新する」ボタンが出る", (await page.$('[data-update-action="apply"]')) !== null);
  ok(`(A) おおよそのサイズが出る "${availableText}"`, availableText.includes("75MB"));
  ok("(A) 「リリースページを開く」ボタンが出る", (await page.$('[data-update-action="open-release"]')) !== null);

  await page.click('[data-update-action="open-release"]');
  await page.waitForTimeout(150);
  ok("(A) 「リリースページを開く」でopen-release-pageを送る",
    (await sentTypes(page)).includes("open-release-page"));
  // URLはJS側から渡さない(C#側が控えている値だけを開く)。
  const releaseMsg = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "open-release-page").pop());
  ok(`(A) open-release-pageにURLを載せない ${JSON.stringify(releaseMsg)}`,
    Object.keys(releaseMsg).length === 1);

  // 自動で入れ替えられる配布物が無い場合は「更新する」を出さない。
  await page.evaluate(() => window.__reply({
    type: "update-check-result", status: "available", currentVersion: "1.0.4", latestVersion: "v1.0.5",
    message: "新しい版 v1.0.5 がありますが、自動で入れ替えられる配布物が見つかりませんでした。",
    releaseUrl: "https://github.com/Yu5rin/pane/releases/tag/v1.0.5", canApply: false, sizeBytes: 0,
  }));
  await page.waitForTimeout(200);
  ok("(A) 配布物が無いときは「更新する」を出さず、リリースページだけ案内する",
    (await page.$('[data-update-action="apply"]')) === null
    && (await page.$('[data-update-action="open-release"]')) !== null);

  // 確認に失敗した場合。
  await page.evaluate(() => window.__reply({
    type: "update-check-result", status: "error", currentVersion: "1.0.4", latestVersion: "",
    message: "配布元から時間内に応答がありませんでした。", releaseUrl: "", canApply: false, sizeBytes: 0,
  }));
  await page.waitForTimeout(200);
  ok("(A) 確認に失敗すると理由がエラーとして出る",
    (await page.$(".settings-update-status.error")) !== null
    && (await sectionText(page)).includes("応答がありませんでした"));

  await page.close();
}

// ============================================================
// (B) 「更新する」の確認ダイアログ・進捗・失敗
// ============================================================
{
  const page = await newPage();
  await openVersionInfo(page);
  await page.click('[data-update-action="check"]');
  await page.evaluate(() => window.__reply({
    type: "update-check-result", status: "available", currentVersion: "1.0.4", latestVersion: "v1.0.5",
    message: "新しい版 v1.0.5 があります。", releaseUrl: "https://example.com/r",
    canApply: true, sizeBytes: 1024,
  }));
  await page.waitForTimeout(200);

  // 押すとまず確認ダイアログが出る(再起動を伴うため)。キャンセルしたら何も送らない。
  const sentBefore = (await sentTypes(page)).length;
  await page.click('[data-update-action="apply"]');
  await page.waitForTimeout(200);
  const dialog = await page.evaluate(() => {
    const overlay = document.querySelector(".pane-dialog-overlay");
    if (!overlay) return null;
    return {
      title: overlay.querySelector(".pane-dialog-title")?.textContent || "",
      message: overlay.querySelector(".pane-dialog-message")?.textContent || "",
      buttons: Array.from(overlay.querySelectorAll(".pane-dialog-btn")).map((x) => x.textContent.trim()),
    };
  });
  ok(`(B) 「更新する」でまず確認ダイアログが出る ${JSON.stringify(dialog)}`, dialog !== null);
  ok("(B) 再起動することを伝えている", (dialog?.message || "").includes("再起動"));
  ok(`(B) 新しい版のバージョンを伝えている ${JSON.stringify(dialog?.message)}`,
    (dialog?.message || "").includes("v1.0.5"));

  await page.click(".pane-dialog-actions .pane-dialog-btn >> nth=0"); // 先頭がキャンセル(dialog.js参照)
  await page.waitForTimeout(200);
  ok("(B) キャンセルするとapply-updateを送らない",
    !(await sentTypes(page)).slice(sentBefore).includes("apply-update"));

  // もう一度押してOKすると apply-update を送る。
  await page.click('[data-update-action="apply"]');
  await page.waitForTimeout(200);
  await page.click(".pane-dialog-btn-primary");
  await page.waitForTimeout(200);
  ok("(B) OKするとapply-updateを送る", (await sentTypes(page)).includes("apply-update"));

  // 進捗が届くと進捗バーが伸びる。
  await page.evaluate(() => window.__reply({
    type: "update-progress", stage: "downloading", message: "ダウンロード中… 45%", percent: 45,
  }));
  await page.waitForTimeout(200);
  const barWidth = await page.evaluate(() =>
    document.querySelector(".settings-update-bar > span")?.style.width ?? "");
  ok(`(B) 進捗バーが割合どおりに伸びる "${barWidth}"`, barWidth === "45%");
  ok("(B) 進捗の文言が出る", (await sectionText(page)).includes("45%"));

  // 割合の無い段階では進捗バーを出さない。
  await page.evaluate(() => window.__reply({
    type: "update-progress", stage: "applying", message: "入れ替えています…", percent: -1,
  }));
  await page.waitForTimeout(200);
  ok("(B) 割合の無い段階では進捗バーを出さない", (await page.$(".settings-update-bar")) === null);
  ok("(B) 段階の文言は出る", (await sectionText(page)).includes("入れ替えています"));

  // 失敗するとエラーとして出て、もう一度確認できるようになる。
  await page.evaluate(() => window.__reply({
    type: "update-progress", stage: "error",
    message: "保存されていない変更があります。更新には再起動が必要なので、先に保存してください。",
  }));
  await page.waitForTimeout(200);
  ok("(B) 失敗すると理由がエラーとして出る",
    (await page.$(".settings-update-status.error")) !== null
    && (await sectionText(page)).includes("先に保存してください"));
  ok("(B) 失敗後も「更新を確認」を押し直せる",
    !(await page.$eval('[data-update-action="check"]', (b) => b.disabled)));

  // 失敗したときこそ、手で入れ替えるための導線が要る。
  // 【なぜ固定するか】更新のダウンロードだけが通らないネットワーク(会社のプロキシ等)が
  // 実際にある。そこでは自動更新が何度やっても終わらないので、リリースページから
  // 自分で取ってくる道が残っていないと詰む。以前はここでボタンを出しておらず、
  // 失敗した人ほど導線を失っていた。
  ok("(B) 失敗しても「リリースページを開く」が出る",
    (await page.$('[data-update-action="open-release"]')) !== null);
  ok("(B) 失敗時に手で入れ替える方法を案内する",
    (await sectionText(page)).includes("Zipを取得"));
  await page.click('[data-update-action="open-release"]');
  await page.waitForTimeout(200);
  ok("(B) 失敗時のボタンからもリリースページを開ける",
    (await sentTypes(page)).includes("open-release-page"));

  // ---- 通信を確かめる(仕様書 U-08) ----
  //
  // 【なぜこの入口が要るか】会社のネットワークで、更新の確認は通るのに配布物の
  // ダウンロードだけが失敗する事例があった。原因を追うログを入れた版を配っても、
  // それを入れた時点で「最新版だから更新するものが無い」状態になり、ダウンロードを
  // 試す手段そのものが消える。最新版のままでも通信だけを試せる入口が要る。
  ok("(B) 「通信を確かめる」ボタンがある",
    (await page.$('[data-update-action="check-connection"]')) !== null);
  await page.click('[data-update-action="check-connection"]');
  await page.waitForTimeout(200);
  ok("(B) 押すとcheck-connectionを送る", (await sentTypes(page)).includes("check-connection"));
  ok("(B) 確認中はボタンを押せない",
    await page.$eval('[data-update-action="check-connection"]', (b) => b.disabled));

  await page.evaluate(() => window.__reply({
    type: "connection-check-result", ok: true,
    message: "配布物の置き場まで届きました（256KBを受け取って確認を終えました）。",
    logFolderPath: "C:\\Users\\Test\\AppData\\Local\\Pane\\logs",
  }));
  await page.waitForTimeout(200);
  ok("(B) 成功の結果が出る", (await sectionText(page)).includes("配布物の置き場まで届きました"));
  ok("(B) 成功はエラー表示にしない",
    (await page.$$(".settings-update-status.error")).length === 0
    || !(await page.$eval(".settings-update-status.error", (e) => e.textContent)).includes("届きました"));
  ok("(B) 結果のあとボタンを押し直せる",
    !(await page.$eval('[data-update-action="check-connection"]', (b) => b.disabled)));

  await page.evaluate(() => window.__reply({
    type: "connection-check-result", ok: false,
    message: "配布物の置き場から 403 が返りました。ネットワークの経路で止められている可能性があります。",
    logFolderPath: "",
  }));
  await page.waitForTimeout(200);
  ok("(B) 失敗の結果はエラーとして出る",
    (await page.$(".settings-update-status.error")) !== null
    && (await sectionText(page)).includes("403"));

  await page.close();
}

// ============================================================
// (C) 自動では通信しない(仕様書 U-01: 押したときだけ)
// ============================================================
{
  const page = await newPage();
  await openVersionInfo(page);
  await page.waitForTimeout(500);
  const types = await sentTypes(page);
  ok(`(C) 画面を開いただけではcheck-updateを送らない ${JSON.stringify(types)}`,
    !types.includes("check-update"));
  ok("(C) 画面を開いただけではapply-updateを送らない", !types.includes("apply-update"));
  await page.close();
}

// ============================================================
// (E) 起動時の更新確認の設定(U-06)と問い合わせ先の表示(U-02)
// ============================================================
{
  const page = await newPage();
  await openVersionInfo(page);

  const toggle = await page.$('input[data-field="checkUpdateOnStartup"]');
  ok("(E) 「起動時に新しい版があるか確認する」のチェックがある", toggle !== null);
  ok("(E) 設定の値が反映される(true→チェック済み)", await toggle.isChecked());

  ok(`(E) 問い合わせ先が画面に出る "${await sectionText(page)}"`,
    (await sectionText(page)).includes("api.github.com/repos/Yu5rin/pane"));

  // 外して保存すると checkUpdateOnStartup: false が送られる。
  await page.uncheck('input[data-field="checkUpdateOnStartup"]');
  await page.waitForTimeout(150);
  const before = (await sentTypes(page)).length;
  await page.click('[data-act="save"]');
  await page.waitForTimeout(300);
  const saved = await page.evaluate((n) =>
    window.__sent.slice(n).filter((m) => m.type === "save-settings").pop(), before);
  ok(`(E) チェックを外して保存するとfalseが送られる 実際=${JSON.stringify(saved?.settings?.checkUpdateOnStartup)}`,
    !!saved && saved.settings.checkUpdateOnStartup === false);

  // 更新セクションを描き直しても、チェックの状態は巻き込まれない
  // (チェックは動的に描き直す範囲の外に置いてある)。
  await page.evaluate(() => window.__reply({
    type: "update-check-result", status: "latest", currentVersion: "1.0.5", latestVersion: "v1.0.5",
    message: "お使いのPaneは最新版です。", releaseUrl: "", canApply: false, sizeBytes: 0,
  }));
  await page.waitForTimeout(200);
  ok("(E) 確認結果を描き直してもチェックの状態が保たれる",
    !(await page.$eval('input[data-field="checkUpdateOnStartup"]', (b) => b.checked)));

  await page.close();
}

// ============================================================
// (F) 更新の案内(U-06)の帯 — 本体ウィンドウ側
// ============================================================
{
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.chrome = {
      webview: {
        postMessage: (m) => { window.__sent.push(m); },
        addEventListener: (_t, fn) => listeners.push(fn),
      },
    };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(800);

  ok("(F) 何も無ければ帯は出ていない",
    await page.$eval("#ad-banner", (el) => el.hidden));

  await page.evaluate(() => window.__reply({
    type: "update-available", latestVersion: "v1.0.6", message: "新しい版 v1.0.6 があります。",
  }));
  await page.waitForTimeout(200);
  ok("(F) update-availableで帯が出る", !(await page.$eval("#ad-banner", (el) => el.hidden)));
  const bannerText = await page.$eval("#ad-banner-text", (el) => el.textContent);
  ok(`(F) 新しい版のバージョンが出る "${bannerText}"`, bannerText.includes("v1.0.6"));
  ok("(F) 「更新する」ボタンが出る",
    (await page.$eval("#ad-banner-action", (el) => el.textContent)) === "更新する");

  // 押すと設定画面の「バージョン情報」を開くよう頼む(勝手に更新は始めない)。
  await page.click("#ad-banner-action");
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "open-settings-window").pop());
  ok(`(F) 「更新する」で設定のバージョン情報を開く ${JSON.stringify(opened)}`,
    !!opened && opened.category === "versionInfo");
  ok("(F) 帯からapply-updateは送らない(勝手に更新を始めない)",
    !(await page.evaluate(() => window.__sent.some((m) => m.type === "apply-update"))));
  ok("(F) 押すと帯が閉じる", await page.$eval("#ad-banner", (el) => el.hidden));

  // 「閉じる」でも消える。
  await page.evaluate(() => window.__reply({
    type: "update-available", latestVersion: "v1.0.6", message: "新しい版 v1.0.6 があります。",
  }));
  await page.waitForTimeout(150);
  await page.click("#ad-banner-close");
  await page.waitForTimeout(150);
  ok("(F) 「閉じる」で帯が消える", await page.$eval("#ad-banner", (el) => el.hidden));

  await page.close();
}

// ============================================================
// (D) ページエラー・コンソールエラーが0件
// ============================================================
ok(`(D) ページエラー0件 ${JSON.stringify(allErrors)}`, allErrors.length === 0);
ok(`(D) コンソールエラー0件 ${JSON.stringify(allConsoleErrors)}`, allConsoleErrors.length === 0);

console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
