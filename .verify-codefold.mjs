// コードモードの折りたたみ(fold widget/fold keymap)と、インデント幅(tabSize/indentUnit)の
// 検証スクリプト。ポートは8195。
//
// 背景(ユーザー報告、経緯):
//   1. 「コードモードのインデントが小さすぎる」「codeIndentSizeを2/4/8にしても表示が変わらない」
//      → tabSizeをcodeIndentSizeに連動させ、コードモード限定のインデントガイド(縦線)を追加。
//   2. 「Graftのようにコードを畳みたい」→ codeFolding/foldKeymapで実装。単体の折り畳み/展開は
//      Pane既存のParagraphショートカットとの衝突を避けAlt-[ / Alt-]に付け替え。
//   3. (前回) 折りたたみマーカーを、行番号ガターの右の専用ガター(.cm-foldGutter)に、
//      Graft風の「+」「−」四角枠+階層ごとの縦線・角(└)で描画。
//   4. (今回) ユーザーに図(承認済み。proposal.png/proposal.html)を見せて承認を得たうえで、
//      マーカー・縦線を「コードのすぐ左(そのコードの実際のインデント位置)」へ移設。
//      具体的には:
//        - マーカーをガター(.cm-foldGutter)から本文(.cm-content)側のwidget decorationへ
//          移し、行頭の空白の終端(=コードが始まる直前)に配置する。
//        - 折りたたみ範囲の縦線は新設せず、既存のインデントガイド(indentGuideMarks/
//          indentGuideTheme)をそのまま流用する(=線は最初から1本しか存在しない)。
//        - 終端の「└」は専用の角要素を作らず、閉じ行の実際のインデントが浅くなることで
//          その列の縦線が自然に途切れる、という既存のインデントガイドの挙動に委ねる。
//      詳細な設計判断(濃淡による強調を検討したが不採用にした理由等)はsrc/editor.jsの
//      該当コメント(FOLD_MARKER_SIZE定義部周辺)を参照。
//
// 検証項目(今回の書き直しに伴い、旧ガター前提の項目(L)(M)(P)(Q)(R)(S)(T)は
// 新しい本文側widgetの実装に合わせて全面的に作り直した。それ以外(A)〜(K)(N)(O)(U)は
// 引き続き有効な項目のため、セレクタ・ヘルパーだけ新実装に合わせて更新している):
//   (A) JS(関数・オブジェクト・配列)で折りたたみマーカーが出る
//   (B) クリックで畳まれ、内容が非表示になる。もう一度クリックで戻る
//   (C) 畳んだ状態でも文書の内容(view.state.doc)自体は変わらない(保存しても壊れない)
//   (D) 畳んだ状態での検索・置換が破綻しない
//   (E) キーボードショートカット: Alt-[/Alt-]/Ctrl-Alt-[/Ctrl-Alt-]で操作でき、
//       かつPane既存のCtrl+Shift+[ / Ctrl+Shift+](番号付き/箇条書きリスト)を奪っていない
//   (F) Markdownモードでライブプレビュー装飾が壊れていない。折りたたみマーカー・インデント
//       ガイドはコードモード限定のままであること
//   (G) インデント幅: tabSize/indentUnitの実測(変更前・変更後)
//   (H) 1万行のコードモードファイルでの入力遅延(dispatch中央値)の実測
//   (I) ページエラー・コンソールエラー0件(各節に分散)
//   (J) マーカーの見た目(展開−/畳み+・枠・クリックでの入れ替わり)
//   (K) 9テーマでのマーカーのコントラスト比(背景=var(--paper)、閾値3.0以上)
//   (L) 今回の依頼1: マーカーが本文(.cm-content)側にあり、旧ガター(.cm-foldGutter)が
//       もう存在しないこと
//   (M) 今回の依頼「本文の文字と重ならないこと」: マーカーの右端が実際のコード開始位置
//       (最初の非空白文字)を超えないことの実測。あわせて、コードモードの.cm-contentの
//       padding-left(12px !important)領域とマーカーがどう重なるか(依頼: 干渉の有無を
//       報告すること。余白設定自体は変更しない)を数値で記録する。
//   (N) インデントガイドが空行をまたいでも途切れないこと(既存機能、回帰確認)
//   (O) インデントガイドが行の境界で実際に(ピクセルレベルで)途切れていないことの実測
//       (既存機能、回帰確認。今回のマーカー移設が影響していないことも併せて確認する)
//   (P) 今回の依頼: マーカーの横位置が、旧実装(階層ごとに固定7px)ではなく、その行の実際の
//       インデント幅(文字数)に比例して決まることの実測。深いネスト(9段)でも、旧実装に
//       あった「一定の深さでクランプして重なる」問題が無くなっていることの確認。
//   (Q) 今回の依頼2: 折りたたみ範囲の縦線が「インデントガイドと同じ位置に重なった1本」に
//       なっていること。専用の縦線要素(旧cm-fold-vline等)がもう存在しないこと、
//       マーカーの右端(=コード開始位置)とインデントガイドの列が一致することを実測する。
//   (R) 【Windows実機フィードバックの訂正版】縦線を引く行の範囲がVS Codeと同じであること
//       (自分の範囲の開始行・終了行には線を引かず、内側の行にだけ引く。終了行の判定は
//       行番号ではなく実インデント列で行う)。L字(旧cm-guide-elbow)がもう存在しないことも
//       確認する。
//   (S) 複数の階層が重なる場合の、行ごとのマーカー個数(0個または1個。comboでも1個)の実測。
//   (T) 9テーマ・3〜4段ネストでもマーカーが背景に埋もれないこと(K節のネスト版)。
//   (U) 拡大スクリーンショット(3〜4段ネスト・折りたたんだ状態・9テーマ)を.shots/へ保存する。
//   (V) 折りたたんだ状態({…}表示)でもマーカーが同じ列(=正しい位置)に出ること。
//   (W) 1行に複数マーカーが並ぶ稀なケース(ワンライナー)でも、それぞれクリック可能な実寸を
//       持って重ならずに描画されること。
//   (X) 改善③: 言語未設定(表示メニュー→コードモードのまま、言語ピッカーで何も選ばない状態)の
//       コードモードでも、インデントの深さに基づいてマーカーが出る・クリックで畳める・
//       Alt-[/Alt-]/Ctrl-Alt-[/Ctrl-Alt-]で操作できる(foldServiceによる標準コマンドとの統合)こと。
//       言語ありコードモード・Markdownモードの既存挙動が変わっていないことも合わせて確認する。
import pw from "playwright";
import zlib from "node:zlib";
import fs from "node:fs";
const { chromium } = pw;

const PORT = 8195;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
let okCount = 0, ngCount = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

// =========================================================================
// 依存ライブラリ無しの最小限PNGデコーダ(非インターレース・8bit・RGB/RGBAのみ対応。
// Playwrightのpage.screenshot()が返すバッファはこの条件を満たす)。
// 「スクリーンショットを見た感じ大丈夫」ではなく、実際にブラウザが描画したピクセル値を
// 数値で裏取りするために使う。
// =========================================================================
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idatChunks = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8); colorType = data.readUInt8(9); interlace = data.readUInt8(12);
    } else if (type === "IDAT") idatChunks.push(data);
    else if (type === "IEND") break;
    offset += 8 + len + 4;
  }
  if (interlace !== 0) throw new Error("interlaced PNG未対応");
  if (bitDepth !== 8) throw new Error(`bitDepth=${bitDepth}未対応`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : (() => { throw new Error(`colorType=${colorType}未対応`); })();
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rawPos = 0;
  const prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawPos]; rawPos += 1;
    const rowIn = raw.subarray(rawPos, rawPos + stride); rawPos += stride;
    const rowOut = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rowOut[x - channels] : 0;
      const b = prevRow[x];
      const c = x >= channels ? prevRow[x - channels] : 0;
      let val = rowIn[x];
      switch (filterType) {
        case 0: break;
        case 1: val = (val + a) & 0xff; break;
        case 2: val = (val + b) & 0xff; break;
        case 3: val = (val + Math.floor((a + b) / 2)) & 0xff; break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); val = (val + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff; break; }
        default: throw new Error(`未知のfilterType=${filterType}`);
      }
      rowOut[x] = val;
    }
    prevRow.set(rowOut);
  }
  return {
    width, height,
    getPixel(x, y) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const i = y * stride + x * channels;
      return channels === 4 ? { r: out[i], g: out[i + 1], b: out[i + 2], a: out[i + 3] } : { r: out[i], g: out[i + 1], b: out[i + 2], a: 255 };
    },
  };
}
function colorDist(a, b) { return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2); }

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function relLum(rgbStr) {
  const m = rgbStr.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!m) return null;
  const [r, g, b] = [1, 2, 3].map((i) => {
    const v = parseFloat(m[i]) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
  const L1 = relLum(a), L2 = relLum(b);
  if (L1 == null || L2 == null) return null;
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}
// var(--x)をこのページ上で実測してrgbオブジェクトを返す((O)節の--rule実測と同じ手法。
// 決め打ちせず、実際にそのテーマで解決された値を使う)。
async function probeVar(page, varName) {
  return page.evaluate((varName) => {
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    probe.style.color = `var(${varName})`;
    const c = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(c);
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }, varName);
}

async function newPage() {
  const page = await browser.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
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
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(400);
  return { page, errors, consoleErrors };
}

async function openFile(page, fileName, text) {
  await page.evaluate(({ fileName, text }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, text });
  await page.waitForTimeout(400);
}
async function applySettings(page, extra) {
  await page.evaluate((extra) => window.__reply({ type: "apply-settings", ...extra }), extra);
  await page.waitForTimeout(200);
}
async function mode(page) { return page.textContent("#status-mode"); }
// 不具合(今回の実装で発覚): マーカーが旧実装(別ガター)から本文(.cm-content)側のwidget
// decorationへ移ったため、単純に.cm-content.innerTextを読むとマーカーの記号("−"/"+")が
// 文中に混ざってしまい、「畳んだ行の先頭が『function ... {…}』になっている」のような
// 行単位の文字列比較が崩れる。マーカー要素だけを一時的にdisplay:noneにしてからinnerTextを
// 読み、直後に元へ戻すことで、レイアウトに基づく(=CodeMirrorの行区切りを正しく反映した)
// テキストからマーカー記号だけを除いたものを得る。
async function contentText(page) {
  return page.evaluate(() => {
    const markers = [...document.querySelectorAll(".cm-fold-marker2")];
    const prevDisplay = markers.map((m) => m.style.display);
    markers.forEach((m) => { m.style.display = "none"; });
    const text = document.querySelector(".cm-content").innerText;
    markers.forEach((m, i) => { m.style.display = prevDisplay[i]; });
    return text;
  });
}

// 折りたたみマーカーのクリックヘルパー。今回(依頼: マーカーを本文側へ)、マーカーは
// .cm-content内のwidget decoration(.cm-fold-marker2)になったため、旧実装のような
// 「幅測定用の非表示spacerを除外する」絞り込みは不要(spacerに相当するものが無い実装の
// ため)。指定titleを持つ最初のマーカーをクリックする。見つかってクリックできればtrueを返す。
async function clickFirstMarker(page, wantTitle) {
  return page.evaluate((wantTitle) => {
    const span = document.querySelector(`.cm-fold-marker2[title="${wantTitle}"]`);
    if (span) { span.click(); return true; }
    return false;
  }, wantTitle);
}
// 最初に見えているマーカーの見た目情報(文字・title・枠線・色)を読む。
async function firstVisibleMarker(page) {
  return page.evaluate(() => {
    const span = document.querySelector(".cm-fold-marker2");
    if (!span) return null;
    const cs = getComputedStyle(span);
    return { text: span.textContent, title: span.title, borderWidth: cs.borderWidth, borderStyle: cs.borderStyle, color: cs.color, fontWeight: cs.fontWeight };
  });
}

const JS_DOC = [
  "function toast(msg) {",
  "  console.log(msg);",
  "  if (msg) {",
  "    return true;",
  "  }",
  "  return false;",
  "}",
  "",
  "const config = {",
  '  name: "pane",',
  "  options: {",
  "    debug: true,",
  "    retries: 3,",
  "  },",
  "};",
  "",
  "const list = [",
  "  1,",
  "  2,",
  "  3,",
  "];",
  "",
].join("\n");

// =========================================================================
// (A)(B)(C) 折りたたみマーカー・クリックでの開閉・文書内容の不変性
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, "sample.js", JS_DOC);
  const m = await mode(page);
  ok(`(A) sample.js がコードモードで開く(実際: ${m})`, m.startsWith("コード"));

  const markers = await page.evaluate(() => document.querySelectorAll(".cm-fold-marker2").length);
  // foldableな行: function(1) / if(1) / object(1) / options内オブジェクト(1) / array(1) = 5行以上
  ok(`(A) 折りたたみマーカーが関数・オブジェクト・配列の行に出る(検出数=${markers})`, markers >= 5);

  const beforeText = await contentText(page);

  // (B) 1番目のマーカー(function toastの行)をクリックして畳む
  await clickFirstMarker(page, "Fold line");
  await page.waitForTimeout(300);
  const afterFoldText = await contentText(page);
  ok("(B) クリックで畳まれ、関数の中身が画面から消える", afterFoldText.includes("function toast(msg) {") && !afterFoldText.includes("console.log(msg)"));
  ok("(B) 畳んだ行は「{…}」のような省略表示になる(マーカー記号を除いた本文で判定)", /function toast\(msg\) \{.*\}/.test(afterFoldText.split("\n")[0]));

  // もう一度クリックして展開 → 見た目が畳む前と完全一致(マーカー記号を除いた本文どうしの比較)
  await clickFirstMarker(page, "Unfold line");
  await page.waitForTimeout(300);
  const afterUnfoldText = await contentText(page);
  ok("(B) もう一度クリックで展開し、元の表示に戻る(完全一致)", afterUnfoldText.trim() === beforeText.trim());

  ok("(A-C) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(A-C) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (C再) 保存メッセージに乗る内容が、畳んだ状態でも完全な原文のままであること
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "sample2.js", JS_DOC);
  await clickFirstMarker(page, "Fold line");
  await page.waitForTimeout(300);
  await page.click(".cm-content");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => {
    const msgs = window.__sent || [];
    return msgs.find((m) => m && (m.type === "save-file" || m.type === "save"));
  });
  const savedText = saved?.text ?? saved?.content ?? null;
  ok(`(C) 保存時に送られる本文が畳む前の原文と完全一致する(保存メッセージ有無=${!!saved})`, savedText != null && savedText.replace(/\r\n/g, "\n") === JS_DOC.replace(/\r\n/g, "\n"));
  ok("(C-保存) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (D) 畳んだ状態での検索・置換
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, "sample3.js", JS_DOC);
  await clickFirstMarker(page, "Fold line");
  await page.waitForTimeout(300);

  await page.click(".cm-content");
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(200);
  await page.fill("#search-query", "retries");
  await page.waitForTimeout(200);
  const countText1 = await page.textContent("#search-count").catch(() => "");
  await page.click("#search-next").catch(() => {});
  await page.waitForTimeout(200);
  ok(`(D) 畳んだ状態でも折りたたんでいない範囲の検索がヒットする(件数表示=${countText1})`, /1/.test(countText1 || ""));

  await page.fill("#search-query", "console.log");
  await page.waitForTimeout(200);
  await page.click("#search-next").catch(() => {});
  await page.waitForTimeout(300);
  const revealed = await contentText(page);
  ok("(D) 畳んだ範囲の中身を検索すると自動的に展開されて表示される", revealed.includes("console.log(msg)"));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  await page.click(".cm-content");
  await page.keyboard.press("Control+h");
  await page.waitForTimeout(200);
  await page.fill("#search-query", "retries");
  await page.fill("#replace-query", "retryCount");
  await page.waitForTimeout(150);
  await page.click("#replace-all");
  await page.waitForTimeout(300);
  const afterReplace = await contentText(page);
  ok("(D) 置換が正しく反映される(retries→retryCount)", afterReplace.includes("retryCount") && !afterReplace.includes("retries:"));

  ok("(D) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(D) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (E) キーボードショートカット: 新規割り当てが機能し、既存ショートカットを奪っていない
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, "sample4.js", JS_DOC);
  await page.click(".cm-content");
  await page.keyboard.press("Control+Home");

  await page.keyboard.press("Alt+BracketLeft");
  await page.waitForTimeout(250);
  let text = await contentText(page);
  ok("(E) Alt+[ でカーソル行が畳まれる", !text.includes("console.log(msg)"));

  await page.keyboard.press("Alt+BracketRight");
  await page.waitForTimeout(250);
  text = await contentText(page);
  ok("(E) Alt+] で展開される", text.includes("console.log(msg)"));

  await page.keyboard.press("Control+Alt+BracketLeft");
  await page.waitForTimeout(300);
  text = await contentText(page);
  ok("(E) Ctrl+Alt+[ で全て折りたたまれる", !text.includes("console.log(msg)") && !text.includes("debug: true"));

  await page.keyboard.press("Control+Alt+BracketRight");
  await page.waitForTimeout(300);
  text = await contentText(page);
  ok("(E) Ctrl+Alt+] で全て展開される", text.includes("console.log(msg)") && text.includes("debug: true"));

  await page.keyboard.press("Control+Home");
  const beforeShift = await contentText(page);
  await page.keyboard.press("Control+Shift+BracketLeft");
  await page.waitForTimeout(250);
  const afterShift = await contentText(page);
  const foldedByShiftBracket = beforeShift.includes("console.log(msg)") && !afterShift.includes("console.log(msg)");
  ok("(E) Ctrl+Shift+[ は折りたたみを実行しない(Pane既存の番号付きリストのまま)", !foldedByShiftBracket);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);

  await page.keyboard.press("Control+Shift+BracketRight");
  await page.waitForTimeout(250);
  const afterShift2 = await contentText(page);
  const foldedByShiftBracket2 = beforeShift.includes("console.log(msg)") && !afterShift2.includes("console.log(msg)");
  ok("(E) Ctrl+Shift+] も折りたたみを実行しない(Pane既存の箇条書きリストのまま)", !foldedByShiftBracket2);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);

  ok("(E) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(E) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (F) Markdownモードのライブプレビュー装飾への影響なし。折りたたみマーカー・インデント
// ガイドはコードモード限定のままであること
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  const MD_DOC = [
    "# 見出し", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "",
    "```mermaid", "graph TD; A-->B;", "```", "", "$E = mc^2$", "",
    "```js", "function f() { return 1; }", "```", "",
  ].join("\n");
  await openFile(page, "sample.md", MD_DOC);
  await applySettings(page, {
    calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
    inlineMathEnabled: true, autoLinksEnabled: true, diagramsEnabled: true, codeBlockLineNumbers: true,
  });
  await page.waitForTimeout(1200);
  const m = await mode(page);
  ok(`(F) .md がMarkdownモードで開く(実際: ${m})`, m === "Markdown");

  const deco = await page.evaluate(() => ({
    table: !!document.querySelector(".cm-table"),
    mermaid: !!document.querySelector("[class*='mermaid'], svg"),
    math: !!document.querySelector(".cm-math, [class*='math']"),
    codeFence: !!document.querySelector(".cm-codeblock-line, .tok-codeblock"),
    foldMarkerAbsent: !document.querySelector(".cm-fold-marker2"),
    // 依頼②で"all"/"fold"の縦線を同じクラス名(.cm-guide-line)の1つの仕組みに統合した
    // ため、両モードとも同じセレクタ1つで不在確認できる(L字は撤去済みのためセレクタ自体
    // 不要になった)。
    guideLineAbsent: !document.querySelector(".cm-guide-line"),
  }));
  ok("(F) 表のライブプレビュー装飾(.cm-table)が効いている", deco.table);
  ok("(F) Mermaid図が描画されている(svgが存在)", deco.mermaid);
  ok("(F) 数式のライブプレビュー装飾が効いている", deco.math);
  ok("(F) コードフェンスの装飾(.cm-codeblock-line等)が効いている", deco.codeFence);
  ok("(F) Markdownモードには折りたたみマーカー(.cm-fold-marker2)を出していない(コードモード限定の判断)", deco.foldMarkerAbsent);
  ok("(F) Markdownモードにはインデントガイド(.cm-guide-line、all/foldどちらのモード用も)を出していない(コードモード限定の判断)", deco.guideLineAbsent);

  ok("(F) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(F) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (G) インデント幅: tabSize/indentUnitの実測
// =========================================================================
{
  const { page, errors } = await newPage();
  const TAB_DOC = "function toast(msg) {\n\tconsole.log(msg);\n}\n";
  const SPACE4_DOC = "function toast(msg) {\n    console.log(msg);\n}\n";

  async function measureLeadWidth(page, wordAfterIndent) {
    return page.evaluate((word) => {
      const lines = [...document.querySelectorAll(".cm-line")];
      const line2 = lines[1];
      const rect0 = line2.getBoundingClientRect();
      const walker = document.createTreeWalker(line2, NodeFilter.SHOW_TEXT);
      let node = null, offset = 0;
      while (walker.nextNode()) {
        const idx = walker.currentNode.data.indexOf(word);
        if (idx >= 0) { node = walker.currentNode; offset = idx; break; }
      }
      if (!node) return null;
      const r = document.createRange();
      r.setStart(node, offset); r.setEnd(node, offset + 1);
      return r.getBoundingClientRect().left - rect0.left;
    }, wordAfterIndent);
  }

  await openFile(page, "tab.js", TAB_DOC);
  const tabWidths = {};
  for (const size of [4, 2, 8]) {
    await applySettings(page, { codeIndentSize: size });
    tabWidths[size] = await measureLeadWidth(page, "console");
  }
  ok(`(G) codeIndentSize=2でタブ1個の表示幅が縮む(4のとき${tabWidths[4]?.toFixed(1)}px → 2のとき${tabWidths[2]?.toFixed(1)}px)`, tabWidths[2] < tabWidths[4]);
  ok(`(G) codeIndentSize=8でタブ1個の表示幅が広がる(4のとき${tabWidths[4]?.toFixed(1)}px → 8のとき${tabWidths[8]?.toFixed(1)}px)`, tabWidths[8] > tabWidths[4]);
  ok(`(G) codeIndentSize=8はcodeIndentSize=4のちょうど2倍の幅になる(比=${(tabWidths[8] / tabWidths[4]).toFixed(2)})`, Math.abs(tabWidths[8] / tabWidths[4] - 2) < 0.15);

  await openFile(page, "space4.js", SPACE4_DOC);
  const spaceWidths = {};
  for (const size of [4, 2, 8]) {
    await applySettings(page, { codeIndentSize: size });
    spaceWidths[size] = await measureLeadWidth(page, "console");
  }
  ok(`(G) 半角スペース4個で書かれたインデントは、codeIndentSizeを変えても表示幅が変わらない(CodeMirrorの仕様どおり。4→${spaceWidths[4]?.toFixed(1)}px, 2→${spaceWidths[2]?.toFixed(1)}px, 8→${spaceWidths[8]?.toFixed(1)}px)`,
    Math.abs(spaceWidths[4] - spaceWidths[2]) < 0.5 && Math.abs(spaceWidths[4] - spaceWidths[8]) < 0.5);

  // インデントガイドの既定が"fold"のため、全深さ一律表示を見るにはここで明示的に"all"へ
  // 切り替える。依頼②でCSS反復グラデーション方式(.cm-indent-guide)を廃止し、実DOM要素
  // (.cm-guide-line、fold/all共通の1つの仕組み)へ一本化したため、backgroundImage等の
  // CSS実測ではなく実際の要素の存在・実寸を見る。
  await applySettings(page, { codeIndentGuides: "all" });
  const guide = await page.evaluate(() => {
    const el = document.querySelector(".cm-guide-line");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, backgroundColor: getComputedStyle(el).backgroundColor };
  });
  ok(`(G) コードモードにインデントガイド(縦線、"all"モード、実DOM要素.cm-guide-line)が追加されている(実測=${JSON.stringify(guide)})`, !!guide && guide.width > 0 && guide.height > 0);

  ok("(G) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (H) 1万行のコードモードファイルでの入力遅延(退行していないことの実測)
// =========================================================================
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(300);

  const genJsDoc = (lines) => {
    const parts = [];
    let n = 0;
    while (n < lines) {
      parts.push(`function fn${n}(a, b) {\n  if (a > b) {\n    return a;\n  }\n  return b;\n}\n`);
      n += 6;
    }
    return parts.join("").split("\n").slice(0, lines).join("\n");
  };
  const doc = genJsDoc(10000);
  await page.evaluate((text) => window.__paneDebugEditor.setValue(text), doc);
  const fileModeOk = await page.evaluate(() => window.__paneDebugEditor.setFileMode("big.js"));
  ok("(H) 1万行のbig.jsをコードモードに切り替えられる(__paneDebugEditor経由)", fileModeOk === true);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const e = window.__paneDebugEditor;
    const mid = Math.floor(e.getValue().length / 2);
    e.view.dispatch({ selection: { anchor: mid } });
  });
  await page.waitForTimeout(200);

  async function measureOneKeystroke() {
    return page.evaluate(() => {
      const e = window.__paneDebugEditor;
      const pos = e.view.state.selection.main.head;
      const t0 = performance.now();
      e.view.dispatch({ changes: { from: pos, insert: "x" }, selection: { anchor: pos + 1 } });
      const t1 = performance.now();
      e.view.dispatch({ changes: { from: pos, to: pos + 1 } });
      return t1 - t0;
    });
  }
  async function measureMedian(label) {
    for (let i = 0; i < 5; i++) await measureOneKeystroke();
    const N = 25;
    const durations = [];
    for (let i = 0; i < N; i++) durations.push(await measureOneKeystroke());
    const med = median(durations);
    console.log(`  [実測] ${label}: 1文字入力(view.dispatchの同期処理のみ)の中央値 ${med.toFixed(2)} ms (${N}回試行、最小${Math.min(...durations).toFixed(2)}/最大${Math.max(...durations).toFixed(2)})`);
    return med;
  }

  const medOn = await measureMedian("1万行・コードモード・折りたたみ+インデントガイドON(既定)");
  ok(`(H) 1万行コードモードでの入力遅延が明らかな退行を起こしていない(実測中央値=${medOn.toFixed(2)}ms、直近基準7.00msの3倍=21ms未満)`, medOn < 21);

  await page.evaluate(() => { window.__paneDebugEditor.setCodeFolding(false); });
  await page.waitForTimeout(200);
  const medFoldOff = await measureMedian("1万行・コードモード・折りたたみOFF");
  await page.evaluate(() => { window.__paneDebugEditor.setCodeFolding(true); });
  await page.waitForTimeout(200);

  console.log(`  [差分] 折りたたみ+ガイド有効化によるコスト増分: ${(medOn - medFoldOff).toFixed(2)} ms`);
  ok(`(H) 折りたたみ/インデントガイドの有無による入力遅延の差が小さい(差=${(medOn - medFoldOff).toFixed(2)}ms、2ms未満)`, Math.abs(medOn - medFoldOff) < 2);

  // 依頼③: インデントガイドの3モード(none/fold/all)それぞれでの入力遅延を比較する。
  // foldモードは表示範囲の先頭で祖先チェーンを辿る処理(collectFoldChainAt/
  // indentFoldAncestorsAt)が追加されているため、allモード(反復グラデーションのみ)より
  // 多少コストが増える可能性があるが、いずれもview.viewportLineBlocks(表示範囲)だけを見る
  // 設計のため、1万行での文書全体スキャンは発生しないはず(=明らかな退行が無いことを確認する)。
  await page.evaluate(() => { window.__paneDebugEditor.setCodeIndentGuides("none"); });
  await page.waitForTimeout(200);
  const medGuideNone = await measureMedian("1万行・コードモード・codeIndentGuides=none");

  await page.evaluate(() => { window.__paneDebugEditor.setCodeIndentGuides("fold"); });
  await page.waitForTimeout(200);
  const medGuideFold = await measureMedian("1万行・コードモード・codeIndentGuides=fold(既定)");

  await page.evaluate(() => { window.__paneDebugEditor.setCodeIndentGuides("all"); });
  await page.waitForTimeout(200);
  const medGuideAll = await measureMedian("1万行・コードモード・codeIndentGuides=all");

  await page.evaluate(() => { window.__paneDebugEditor.setCodeIndentGuides("fold"); }); // 既定へ戻す
  await page.waitForTimeout(200);

  console.log(`  [まとめ] 1万行・1文字入力の中央値(ms): none=${medGuideNone.toFixed(2)} / fold(既定)=${medGuideFold.toFixed(2)} / all=${medGuideAll.toFixed(2)}`);
  ok(`(H) codeIndentGuides="fold"(新しい既定)でも1万行での入力遅延が明らかな退行を起こしていない(実測中央値=${medGuideFold.toFixed(2)}ms、直近基準7.00msの3倍=21ms未満)`, medGuideFold < 21);
  ok(`(H) "fold"と"none"の差が小さい(=表示範囲だけを見る設計どおり、祖先チェーンを辿る処理の追加コストが小さい。差=${(medGuideFold - medGuideNone).toFixed(2)}ms、3ms未満)`, Math.abs(medGuideFold - medGuideNone) < 3);
  ok(`(H) "fold"と"all"の差が小さい(=どちらのモードでも文書全体スキャンが発生していない。差=${Math.abs(medGuideFold - medGuideAll).toFixed(2)}ms、3ms未満)`, Math.abs(medGuideFold - medGuideAll) < 3);

  ok("(H) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (J) 折りたたみマーカーの見た目
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, "markershape.js", JS_DOC);

  const beforeFold = await firstVisibleMarker(page);
  ok(`(J) 展開中のマーカーは「−」(実際="${beforeFold?.text}")`, beforeFold?.text === "−");
  ok(`(J) 展開中のtitleは"Fold line"(実際="${beforeFold?.title}")`, beforeFold?.title === "Fold line");
  ok(`(J) マーカーが四角い枠(border)で囲まれている(実際: ${beforeFold?.borderWidth} ${beforeFold?.borderStyle})`,
    !!beforeFold && parseFloat(beforeFold.borderWidth) > 0 && beforeFold.borderStyle === "solid");

  await clickFirstMarker(page, "Fold line");
  await page.waitForTimeout(300);
  const afterFold = await firstVisibleMarker(page);
  ok(`(J) クリックで畳むとマーカーが「+」になる(実際="${afterFold?.text}")`, afterFold?.text === "+");
  ok(`(J) 畳んだ後のtitleは"Unfold line"(実際="${afterFold?.title}")`, afterFold?.title === "Unfold line");
  const foldedText = await contentText(page);
  ok("(J) クリックで実際に畳まれ、関数の中身が画面から消える", !foldedText.includes("console.log(msg)"));

  await clickFirstMarker(page, "Unfold line");
  await page.waitForTimeout(300);
  const afterUnfold = await firstVisibleMarker(page);
  ok(`(J) クリックで展開するとマーカーが「−」に戻る(実際="${afterUnfold?.text}")`, afterUnfold?.text === "−");
  const unfoldedText = await contentText(page);
  ok("(J) クリックで実際に展開され、関数の中身が画面に戻る", unfoldedText.includes("console.log(msg)"));

  ok("(J) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(J) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

const THEMES = [
  { label: "default-light", theme: "light", lightTheme: "default", darkTheme: "default" },
  { label: "default-dark", theme: "dark", lightTheme: "default", darkTheme: "default" },
  { label: "sepia", theme: "light", lightTheme: "sepia", darkTheme: "default" },
  { label: "github", theme: "light", lightTheme: "github", darkTheme: "default" },
  { label: "solarized-light", theme: "light", lightTheme: "solarized-light", darkTheme: "default" },
  { label: "nord", theme: "dark", lightTheme: "default", darkTheme: "nord" },
  { label: "dracula", theme: "dark", lightTheme: "default", darkTheme: "dracula" },
  { label: "solarized-dark", theme: "dark", lightTheme: "default", darkTheme: "solarized-dark" },
  { label: "night", theme: "dark", lightTheme: "default", darkTheme: "night" },
];

// =========================================================================
// (K) 9テーマすべてで折りたたみマーカーが背景に埋もれず見えること。
// マーカーは今回、本文(.cm-content)側のwidget decorationになったため、比較対象の背景は
// 「ガター背景」ではなく「マーカーが実際に乗っているコード本文の地」= var(--paper)にする
// (マーカー自身の文字色にもvar(--paper)を使っており、地と文字が同じ変数の組み合わせで
// 判定できる)。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "markertheme.js", JS_DOC);

  for (const th of THEMES) {
    await applySettings(page, { theme: th.theme, lightTheme: th.lightTheme, darkTheme: th.darkTheme });
    const colors = await page.evaluate(() => {
      const span = document.querySelector(".cm-fold-marker2");
      if (!span) return null;
      return { marker: getComputedStyle(span).color, fill: getComputedStyle(span).backgroundColor };
    });
    const paperRGB = await probeVar(page, "--paper");
    const paperStr = paperRGB ? `rgb(${paperRGB.r}, ${paperRGB.g}, ${paperRGB.b})` : null;
    const textRatio = colors ? contrastRatio(colors.marker, colors.fill) : null;
    const fillRatio = colors && paperStr ? contrastRatio(colors.fill, paperStr) : null;
    ok(`(K) ${th.label}: マーカーの文字色が、マーカー自身の地(塗り)に対しコントラスト比3.0以上(実測=${textRatio?.toFixed(2)}、text=${colors?.marker}, fill=${colors?.fill})`, !!textRatio && textRatio >= 3.0);
    ok(`(K) ${th.label}: マーカーの地(塗り)が、コード本文の地(--paper)に対しコントラスト比3.0以上(実測=${fillRatio?.toFixed(2)}、fill=${colors?.fill}, paper=${paperStr})`, !!fillRatio && fillRatio >= 3.0);
  }

  ok("(K) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (L)(M) マーカーが本文(.cm-content)側にあり、旧ガター(.cm-foldGutter)がもう存在しない
// こと。マーカーの右端が実際のコード開始位置(最初の非空白文字)を超えない(=本文の文字と
// 重ならない)こと。あわせて、コードモードの.cm-contentのpadding-leftとマーカーの位置関係を
// 数値で記録する。
//
// 依頼①でマーカーの位置を「本文エリアの左端から固定の隙間」に変更したことに伴い、
// padding-leftの値も改めた: 本文エリア左端→マーカー左端5px、マーカー本体15px
// (FOLD_MARKER_SIZE)、マーカー右端→コード開始位置5px(以前は0pxで近すぎるとの指摘)の
// 合計25px(src/style.css参照)。この節では、マーカーが本文の文字と重ならないこと・
// 本文エリアからはみ出さないことを実測で確認する(具体的な5px/5pxの数値は(AA)節で
// 詳しく確認する)。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "position.js", JS_DOC);

  const layout = await page.evaluate(() => {
    const oldGutter = document.querySelector(".cm-foldGutter");
    const content = document.querySelector(".cm-content");
    const gutters = document.querySelector(".cm-gutters");
    const marker = document.querySelector(".cm-fold-marker2");
    const inContent = marker ? content.contains(marker) : false;
    const inGutters = marker ? gutters.contains(marker) : false;
    const c = content.getBoundingClientRect();
    const m = marker ? marker.getBoundingClientRect() : null;
    return {
      oldGutterAbsent: !oldGutter,
      inContent, inGutters,
      contentLeft: c.left,
      contentPaddingLeft: getComputedStyle(content).paddingLeft,
      markerLeft: m?.left, markerRight: m?.right, markerWidth: m?.width, markerHeight: m?.height,
    };
  });

  ok("(L) 旧折りたたみガター(.cm-foldGutter)がもう存在しない(本文側へ移設済み)", layout.oldGutterAbsent);
  ok("(L) マーカーが本文(.cm-content)の子孫として描画されている", layout.inContent);
  ok("(L) マーカーがガター(.cm-gutters)の子孫ではない", !layout.inGutters);
  ok(`(L) マーカーが実寸を持って描画されている(幅=${layout.markerWidth}px 高さ=${layout.markerHeight}px)`, layout.markerWidth > 0 && layout.markerHeight > 0);
  // 依頼①: 5(左余白)+15(マーカー本体)+5(右余白)=25px(src/style.css参照。右側の
  // padding-rightは変更していない)。
  ok(`(M) 本文(.cm-content)のpadding-leftが25px(依頼①: 5+15+5の左右対称)である(実際=${layout.contentPaddingLeft})`, layout.contentPaddingLeft === "25px");

  // 依頼の核心: 各行のマーカー右端 と 実際のコード開始位置(その行最初の非空白文字の左端)を
  // Range APIで実測し、マーカーがコードの文字に重なっていないことを確認する
  // (=「本文の文字と重ならないこと」)。あわせて、行頭空白が無い行(depth0)を含む各深さで
  // マーカー左端と.cm-content左端(=padding-leftの外側、本文エリアの左端)の関係を実測する。
  const NEST_DOC = [
    "function outer(a) {",
    "  if (a > 0) {",
    "    for (let i = 0; i < a; i++) {",
    "      if (i % 2 === 0) {",
    "        return i;",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
  await openFile(page, "overlap.js", NEST_DOC);
  const overlap = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const content = document.querySelector(".cm-content");
    const contentLeft = content.getBoundingClientRect().left;
    return lines.map((line) => {
      const marker = line.querySelector(".cm-fold-marker2");
      if (!marker) return null;
      const mr = marker.getBoundingClientRect();
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = null, offset = -1;
      while (walker.nextNode()) {
        const t = walker.currentNode;
        if (marker.contains(t)) continue;
        const idx = t.data.search(/\S/);
        if (idx >= 0) { node = t; offset = idx; break; }
      }
      let textLeft = null;
      if (node) {
        const r = document.createRange();
        r.setStart(node, offset); r.setEnd(node, offset + 1);
        textLeft = r.getBoundingClientRect().left;
      }
      const indent = (line.textContent.match(/^[ \t]*/) || [""])[0].length;
      return { text: line.textContent.replace(/[−+]/g, "").trim().slice(0, 24), indent, markerLeft: mr.left, markerRight: mr.right, textLeft, contentLeft };
    }).filter(Boolean);
  });
  console.log(`  [実測] マーカー左右端・インデント段数・本文左端・コード開始位置の関係(行ごと):`);
  let noTextOverlap = true;
  let noContentOverflow = true;
  for (const row of overlap) {
    const gap = row.textLeft != null ? row.textLeft - row.markerRight : null;
    if (gap != null && gap < -0.5) noTextOverlap = false;
    // 不具合修正の核心: マーカー左端が本文(.cm-content)の左端(=paddingの外側)より
    // 内側(right側)にあること。0.5px未満の誤差はサブピクセル丸めとして許容する。
    const insideBy = row.markerLeft - row.contentLeft; // 正なら内側、負ならはみ出し
    if (insideBy < -0.5) noContentOverflow = false;
    console.log(`      indent=${row.indent} "${row.text}": マーカー左端=${row.markerLeft.toFixed(2)} 右端=${row.markerRight.toFixed(2)}`
      + ` / 本文左端=${row.contentLeft.toFixed(2)}(内側へ${insideBy.toFixed(2)}px) / コード開始=${row.textLeft?.toFixed(2)} / 文字との隙間=${gap?.toFixed(2)}px`);
  }
  ok("(M) すべての行でマーカーの右端が実際のコード開始位置を超えていない(本文の文字と重ならない)", noTextOverlap);
  ok("(M) すべての行でマーカーの左端が本文(.cm-content)の左端より内側にある(本文エリアからはみ出さない、実機バグの修正確認)", noContentOverflow);
  // インデント段数ごとに実測値を明示(依頼: depth1・depth2でも位置が正しいことの確認)。
  const byIndent = new Map();
  for (const row of overlap) if (!byIndent.has(row.indent)) byIndent.set(row.indent, row);
  for (const [indent, row] of [...byIndent.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  [記録] indent=${indent}: マーカー左端が本文左端より${(row.markerLeft - row.contentLeft).toFixed(2)}px内側`);
  }

  ok("(L-M) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (M2) 本文左余白を意図的に極端に狭く(1px)設定しても、マーカーが本文(.cm-content)の
// 左端からはみ出さないこと。依頼①でマーカー位置を「-実際のpadding-left + 5px」という
// 式(src/editor.js computeFixedMarkerLeftPx)に一本化したため、padding-leftの値に
// 関わらず常に本文左端から5px内側に来ることが構造的に保証される(以前のようにMath.maxで
// 個別にクランプする必要が無くなった。式そのものがpadding-leftをキャンセルする形になって
// いるため)。
// 注記: コードモードのpadding-leftはstyle.css側で25px固定(!important)のため、設定
// (editorPaddingLeft)では変更できない。この節はカスタムCSS経由でコードモードの
// padding-leftを一時的に上書きし、「余白がマーカー幅より狭くなっても壊れない」という
// 安全性を実測する。
// =========================================================================
{
  const { page, errors } = await newPage();
  await applySettings(page, { customCss: "#cm-host.mode-code .cm-content { padding-left: 1px !important; }" });
  await openFile(page, "tiny-padding.js", "function outer(a) {\n  return a;\n}\n");
  const clamped = await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const marker = document.querySelector(".cm-fold-marker2");
    const c = content.getBoundingClientRect();
    const m = marker.getBoundingClientRect();
    return { contentPaddingLeft: getComputedStyle(content).paddingLeft, contentLeft: c.left, markerLeft: m.left };
  });
  const insideBy = clamped.markerLeft - clamped.contentLeft;
  console.log(`  [実測] padding-leftを1pxまで狭めた場合: 本文左端=${clamped.contentLeft.toFixed(2)} マーカー左端=${clamped.markerLeft.toFixed(2)}`
    + `(内側へ${insideBy.toFixed(2)}px、padding-left実測=${clamped.contentPaddingLeft})`);
  ok("(M2) padding-leftを1pxまで極端に狭めても、クランプによりマーカーが本文左端からはみ出さない", insideBy >= -0.5);
  ok("(M2) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await applySettings(page, { customCss: "" }); // 後続の節へ影響しないよう戻す
  await page.close();
}

// =========================================================================
// (N)(O) インデントガイド(縦線)が空行をまたいでも・行の境界でも実際に(DOM要素の実寸で)
// 途切れていないこと。
//
// 【依頼②に伴う書き直し】 以前は"all"モードだけCSSの反復グラデーション(mark decoration +
// backgroundImage)で描いており、「本当に隙間なく繋がっているか」をピクセル単位で
// スクリーンショット解析する必要があった(inline要素の背景がline-height全体を塗らない、
// 等のCSSの癖にまつわる不具合が過去に複数回発生した経緯がある)。依頼②でCSS背景方式を
// 廃止し、"all"・"fold"どちらも実DOM要素(GuideLineWidget、位置はview.defaultLineHeightを
// 焼き込んだ実測pxで指定)の1つの仕組みに統一したため、継続性は「隣接する行のガイド要素の
// top/bottomが実際に接しているか」をgetBoundingClientRect()で直接測るだけで判定できる
// (スクリーンショットのピクセル解析はもう不要)。
// =========================================================================
{
  const { page, errors } = await newPage();
  const NEST_DOC = [
    "function outer(a) {", "    if (a > 0) {", "        for (let i = 0; i < a; i++) {", "",
    "            if (i % 2 === 0) {", "                console.log(i);", "",
    "                console.log('even');", "            } else {", "                console.log(-i);",
    "            }", "        }", "    }", "    return a;", "}",
  ].join("\n"); // codeIndentSize既定(4)に合わせて4スペース刻みでインデントする
  await openFile(page, "nested.js", NEST_DOC);
  await applySettings(page, { codeIndentGuides: "all" });

  // 各行の.cm-lineの実際の高さ範囲と、その行に乗っている.cm-guide-line(複数階層ぶん
  // 乗ることがある)のtop/bottomをすべて集める(L字は撤去済みのため、線は常に行の全高を
  // まっすぐ塗る。行の途中で止まる特別扱いは無い)。
  const geo = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    return lines.map((l) => {
      const r = l.getBoundingClientRect();
      const guides = [...l.querySelectorAll(".cm-guide-line")].map((g) => {
        const gr = g.getBoundingClientRect();
        return { left: gr.left, top: gr.top, bottom: gr.bottom };
      });
      return { text: l.textContent.slice(0, 20), top: r.top, bottom: r.bottom, guides };
    });
  });

  ok(`(N) 4行目(forブロック内の空行)にもインデントガイドが乗っている(本数=${geo[3]?.guides.length})`, (geo[3]?.guides.length ?? 0) > 0);
  ok(`(N) 7行目(ifブロック内の空行)にもインデントガイドが乗っている(本数=${geo[6]?.guides.length})`, (geo[6]?.guides.length ?? 0) > 0);
  ok(`(N) 空行の.cm-lineの高さが非空白行と同じ(=行間に余計な隙間ができていない。for行の高さ=${(geo[2]?.bottom - geo[2]?.top).toFixed(2)}, 4行目の高さ=${(geo[3]?.bottom - geo[3]?.top).toFixed(2)})`,
    Math.abs((geo[2].bottom - geo[2].top) - (geo[3].bottom - geo[3].top)) < 0.5);

  // (O) 行の境界で、同じx座標(=同じ深さ)の縦線どうしのtop/bottomが実際に接しているか
  // (隙間が無いか)を全行ペアで確認する。空行・ネストが変わる境界も含めてすべて対象。
  let allTouching = true;
  let checkedCount = 0;
  const reportLines = [];
  for (let i = 0; i < geo.length - 1; i++) {
    const cur = geo[i], next = geo[i + 1];
    for (const g of cur.guides) {
      // 次の行にある、同じx座標(誤差0.5px以内)の縦線を探す(同じ深さの継続)。
      const match = next.guides.find((ng) => Math.abs(ng.left - g.left) < 0.5);
      if (!match) continue; // 次の行でその深さが終わっている(=そこで途切れて見えるのが正しい)
      checkedCount++;
      const gap = Math.abs(match.top - g.bottom);
      const touching = gap < 0.6;
      reportLines.push(`      行${i}→${i + 1}(depth x=${g.left.toFixed(1)}, "${cur.text.trim().slice(0, 10)}"→"${next.text.trim().slice(0, 10)}"): 隙間=${gap.toFixed(2)}px ${touching ? "(繋がっている)" : "(途切れている!)"}`);
      if (!touching) allTouching = false;
    }
  }
  console.log(reportLines.join("\n"));
  ok(`(O) 同じ深さの縦線どうしは、行をまたいでも実際に隙間なく接している(判定対象=${checkedCount}件)`, allTouching && checkedCount > 0);

  // 折りたたんだ状態でも、畳んだ行の前後で残っている縦線が途切れていないこと。
  await page.locator(".cm-line", { hasText: "for (let i" }).first().click();
  await page.keyboard.press("Alt+BracketLeft");
  await page.waitForTimeout(300);
  const geoFolded = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    return lines.map((l) => {
      const guides = [...l.querySelectorAll(".cm-guide-line")].map((g) => {
        const gr = g.getBoundingClientRect();
        return { left: gr.left, top: gr.top, bottom: gr.bottom };
      });
      return { text: l.textContent.slice(0, 30), guides };
    });
  });
  const forIdx = geoFolded.findIndex((g) => g.text.includes("for ("));
  ok(`(O-2) forループを畳むと可視行が減る(可視行数=15→${geoFolded.length})`, forIdx >= 0 && geoFolded.length < 15);
  if (forIdx >= 0 && forIdx > 0) {
    const prevRow = geoFolded[forIdx - 1];
    const curRow = geoFolded[forIdx];
    let touchingAfterFold = true;
    for (const g of prevRow.guides) {
      const match = curRow.guides.find((ng) => Math.abs(ng.left - g.left) < 0.5);
      if (match && Math.abs(match.top - g.bottom) >= 0.6) touchingAfterFold = false;
    }
    ok("(O-2) 畳んだ行の前後でも縦線が途切れていない", touchingAfterFold);
  }
  await page.keyboard.press("Alt+BracketRight");
  await page.waitForTimeout(200);

  ok("(N)(O) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// 以降は今回の追加要件(マーカー・線をコードのすぐ左へ)の検証。共通の3〜4段ネストの文書を
// 使う((N)(O)節と同じ構造)。
const NEST_DOC3 = [
  "function outer(a) {",               // 0  depth0(マーカー)
  "  if (a > 0) {",                     // 1  depth1(マーカー)
  "    for (let i = 0; i < a; i++) {",  // 2  depth2(マーカー)
  "",                                    // 3  空行(depth0-2通過)
  "      if (i % 2 === 0) {",           // 4  depth3(マーカー)
  "        console.log(i);",            // 5  depth0-3通過(マーカー無し)
  "",                                     // 6  空行(depth0-3通過)
  "        console.log('even');",       // 7  depth0-3通過
  "      } else {",                      // 8  depth3終了+新しいdepth3開始(combo、マーカー1個)
  "        console.log(-i);",           // 9  depth0-3通過(elseの中)
  "      }",                             // 10 depth3(else)終了(マーカー無し)
  "    }",                               // 11 depth2(for)終了(マーカー無し)
  "  }",                                 // 12 depth1(if)終了(マーカー無し)
  "  return a;",                         // 13 depth0通過(マーカー無し)
  "}",                                    // 14 depth0(function)終了(マーカー無し)
].join("\n");

// =========================================================================
// (P) 依頼①: マーカーの横位置が、インデントの深さに関係なく常に固定であること
// (本文エリアの左端からFOLD_MARKER_GAP_LEFT=5px)。以前(2世代目の実装)はマーカーの
// 横位置がその行の実際のインデント幅に比例して動く設計だったが、この数日で複数の
// 不具合(タブ幅での位置ずれ・インデント幅変更時の未更新・インデントガイドとの二重線)を
// 生んだため、VS Codeと同じ「位置を固定する」方針に転換した(詳細はsrc/editor.jsの
// FOLD_MARKER_SIZE定義部コメント参照)。この節ではその固定位置を実測する。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "depth.js", NEST_DOC3);

  const markerGaps = await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const contentLeft = content.getBoundingClientRect().left;
    return [...document.querySelectorAll(".cm-fold-marker2")].map((m) => m.getBoundingClientRect().left - contentLeft);
  });
  console.log(`  [実測] 深さごとのマーカー左端(本文エリア左端からの距離、px、出現順、function→if→for→if(i%2)→else-combo): ${JSON.stringify(markerGaps)}`);
  ok(`(P) 5つのマーカー(function/if/for/if(i%2)/else-combo)が検出される(実測=${markerGaps.length})`, markerGaps.length === 5);
  ok(`(P) 深さに関係なく、すべてのマーカーが本文エリア左端から同じ距離(5px)にある(実測=${JSON.stringify(markerGaps.map((g) => g.toFixed(2)))})`,
    markerGaps.length === 5 && markerGaps.every((g) => Math.abs(g - 5) < 0.5));

  // 深いネスト(9段)でも同じく固定位置のままであること(旧実装で懸念されていた
  // 「一定の深さでクランプして重なる」問題は、そもそも横位置が動かないため構造的に
  // 発生し得ない)。
  const DEEP_DEPTH = 9;
  const DEEP_DOC = (() => {
    const lines = [];
    for (let i = 0; i < DEEP_DEPTH; i++) lines.push("  ".repeat(i) + `if (a${i}) {`);
    lines.push("  ".repeat(DEEP_DEPTH) + "return 1;");
    for (let i = DEEP_DEPTH - 1; i >= 0; i--) lines.push("  ".repeat(i) + "}");
    return lines.join("\n");
  })();
  await openFile(page, "deep.js", DEEP_DOC);
  const deepGaps = await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const contentLeft = content.getBoundingClientRect().left;
    return [...document.querySelectorAll(".cm-fold-marker2")].map((m) => m.getBoundingClientRect().left - contentLeft);
  });
  console.log(`  [実測] ${DEEP_DEPTH}段ネストでのマーカー左端(本文エリア左端からの距離、px): ${JSON.stringify(deepGaps.map((g) => g.toFixed(2)))}`);
  ok(`(P) ${DEEP_DEPTH}段ネストでも、すべてのマーカーが同じ固定位置(5px)のまま重ならない(段数=${deepGaps.length})`,
    deepGaps.length === DEEP_DEPTH && deepGaps.every((g) => Math.abs(g - 5) < 0.5));

  // マーカーが本文へ食い込む(=コード開始位置を超える)ことは無いはず(依頼①「マーカー右端
  // からコード開始位置までも5px空ける」の深いネストでの再確認。マーカーが固定位置なので、
  // インデントが深いほどコードとの隙間はむしろ広がる一方であり、食い込みは起こり得ない)。
  const overlapDeep = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    return lines.every((line) => {
      const marker = line.querySelector(".cm-fold-marker2");
      if (!marker) return true;
      const mr = marker.getBoundingClientRect();
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = null, offset = -1;
      while (walker.nextNode()) {
        const t = walker.currentNode;
        if (marker.contains(t)) continue;
        const idx = t.data.search(/\S/);
        if (idx >= 0) { node = t; offset = idx; break; }
      }
      if (!node) return true;
      const r = document.createRange();
      r.setStart(node, offset); r.setEnd(node, offset + 1);
      return r.getBoundingClientRect().left - mr.right >= -0.5;
    });
  });
  ok(`(P) ${DEEP_DEPTH}段ネストでもマーカーがコードの文字へ食い込まない`, overlapDeep);

  ok("(P) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (Q) 依頼②の実測: 縦線が実DOM要素(.cm-guide-line)の1つの仕組みに統一されていること。
// マーカーが固定位置になったことで(依頼①)、縦線はもうマーカーの
// 位置とは無関係になった(以前は「縦線はマーカーの中心を通る」という制約があったが、
// 今は縦線は実際のコードの列位置を、マーカーは本文エリアの左端を、それぞれ独立に
// 表現する)。専用の縦線要素(旧cm-fold-vline等、さらに前の世代の実装)がもう存在しない
// ことも併せて確認する。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "guideunify.js", NEST_DOC3);

  const noSeparateLine = await page.evaluate(() => ({
    vline: document.querySelectorAll(".cm-fold-vline").length,
    vlineLower: document.querySelectorAll(".cm-fold-vline-lower").length,
    elbow: document.querySelectorAll(".cm-fold-elbow").length,
    track: document.querySelectorAll(".cm-fold-track").length,
    foldGutter: document.querySelectorAll(".cm-foldGutter").length,
    indentGuideOld: document.querySelectorAll(".cm-indent-guide").length,
    foldGuideLineOld: document.querySelectorAll(".cm-fold-guide-line").length,
  }));
  ok(`(Q) 専用の折りたたみ縦線要素(旧cm-fold-vline)がもう存在しない(実測=${noSeparateLine.vline})`, noSeparateLine.vline === 0);
  ok(`(Q) 専用の折りたたみ縦線(下半分、旧cm-fold-vline-lower)がもう存在しない(実測=${noSeparateLine.vlineLower})`, noSeparateLine.vlineLower === 0);
  ok(`(Q) 専用の角要素(旧cm-fold-elbow)がもう存在しない(実測=${noSeparateLine.elbow})`, noSeparateLine.elbow === 0);
  ok(`(Q) 旧ガタートラック(cm-fold-track)がもう存在しない(実測=${noSeparateLine.track})`, noSeparateLine.track === 0);
  ok(`(Q) 旧折りたたみガター(cm-foldGutter)がもう存在しない(実測=${noSeparateLine.foldGutter})`, noSeparateLine.foldGutter === 0);
  ok(`(Q) 依頼②で廃止したCSS反復グラデーション方式(旧.cm-indent-guide)がもう存在しない(実測=${noSeparateLine.indentGuideOld})`, noSeparateLine.indentGuideOld === 0);
  ok(`(Q) 依頼②で統合前の旧クラス名(.cm-fold-guide-line)がもう存在しない(実測=${noSeparateLine.foldGuideLineOld})`, noSeparateLine.foldGuideLineOld === 0);

  // 縦線が実際にコードの列位置(行頭空白の終端)に来ていること。訂正版の依頼①どおり、
  // for自身が新たに開く範囲の線はfor行自身には引かれず、次の行(空行)から始まる。
  // そのため「for行自身のコード開始位置」という列の基準はfor行から測るが、実際に線が
  // その列に現れるかどうかはfor行の次の行(空行、NEST_DOC3の4行目)で確認する。
  const forInfo = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const forIdx = lines.findIndex((l) => l.textContent.includes("for (let"));
    const forLine = lines[forIdx];
    const nextLine = lines[forIdx + 1]; // for行の次の行(空行)
    const forLineGuides = [...forLine.querySelectorAll(".cm-guide-line")].map((g) => g.getBoundingClientRect().left);
    const nextLineGuides = [...nextLine.querySelectorAll(".cm-guide-line")].map((g) => g.getBoundingClientRect().left);
    const walker = document.createTreeWalker(forLine, NodeFilter.SHOW_TEXT);
    let node = null, offset = -1;
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (t.parentElement.closest(".cm-fold-marker2")) continue;
      const idx = t.data.search(/\S/);
      if (idx >= 0) { node = t; offset = idx; break; }
    }
    const r = document.createRange();
    r.setStart(node, offset); r.setEnd(node, offset + 1);
    const codeStart = r.getBoundingClientRect().left;
    return { forLineGuides, nextLineGuides, codeStart };
  });
  console.log(`  [実測] for行自身の縦線一覧(${forInfo.forLineGuides.length}本、outer/if分のみのはず)= ${forInfo.forLineGuides.map((v) => v.toFixed(2)).join(", ")}`);
  console.log(`  [実測] for行の次の行の縦線一覧(${forInfo.nextLineGuides.length}本、outer/if/for分)= ${forInfo.nextLineGuides.map((v) => v.toFixed(2)).join(", ")} / for行自身のコード開始位置=${forInfo.codeStart.toFixed(2)}`);
  const hasOwnOnFor = forInfo.forLineGuides.some((v) => Math.abs(v - forInfo.codeStart) < 0.6);
  ok(`(Q) 訂正版の依頼①: for行自身には、for自身が開く範囲の縦線が引かれない(実測: for行自身の列に一致する線=${hasOwnOnFor ? "あり(NG)" : "なし"})`, !hasOwnOnFor);
  const closestOnNext = forInfo.nextLineGuides.reduce((a, b) => Math.abs(b - forInfo.codeStart) < Math.abs(a - forInfo.codeStart) ? b : a, Infinity);
  ok(`(Q) for自身が開く範囲の縦線は、for行の次の行から、for行自身のコード開始位置(=行頭空白の終端)にちょうど揃って始まる(最も近いもの=${closestOnNext.toFixed(2)}, コード開始=${forInfo.codeStart.toFixed(2)})`,
    Math.abs(closestOnNext - forInfo.codeStart) < 0.6);

  ok("(Q) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (R) 【Windows実機フィードバックの訂正版】縦線を引く行の範囲がVS Codeと同じであること。
// NEST_DOC3(for範囲: 3行目"for (...) {"〜12行目"    }")を使い、fold・allどちらの
// モードでも:
//   - for自身が開く範囲の線は、for自身の開始行(3行目)には無い
//   - for自身が開く範囲の線は、for自身の終了行(12行目、閉じ括弧だけの行)にも無い
//   - for自身が開く範囲の線は、その内側の行(4行目〜11行目)にはある
//   - ネストしている場合、外側(outer/if)の線は、forの開始行・終了行にも引かれたままである
//     (それらはouter/ifから見れば内側の行のため)
// を実測する。あわせて、L字(旧.cm-guide-elbow)がもう存在しないことも確認する。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "fold-range.js", NEST_DOC3);

  const noElbow = await page.evaluate(() => document.querySelectorAll(".cm-guide-elbow, .cm-fold-elbow, .cm-fold-elbow-v, .cm-fold-elbow-h").length);
  ok(`(R) L字の要素(.cm-guide-elbow、旧世代の残骸も含む)がもう存在しない(実測=${noElbow})`, noElbow === 0);

  for (const guideMode of ["fold", "all"]) {
    await applySettings(page, { codeIndentGuides: guideMode });
    const info = await page.evaluate(() => {
      const lines = [...document.querySelectorAll(".cm-line")];
      function codeStartX(line) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = null, offset = -1;
        while (walker.nextNode()) {
          const t = walker.currentNode;
          if (t.parentElement.closest(".cm-fold-marker2")) continue;
          const idx = t.data.search(/\S/);
          if (idx >= 0) { node = t; offset = idx; break; }
        }
        if (!node) return null; // 空行(行頭空白すら無い)
        const r = document.createRange();
        r.setStart(node, offset); r.setEnd(node, offset + 1);
        return r.getBoundingClientRect().left;
      }
      function guideXs(line) { return [...line.querySelectorAll(".cm-guide-line")].map((g) => g.getBoundingClientRect().left); }
      return {
        outerCol: codeStartX(lines[0]),   // "function outer(a) {" → outerの階層の列
        ifCol: codeStartX(lines[1]),      // "  if (a > 0) {" → if(a>0)の階層の列
        forCol: codeStartX(lines[2]),     // "    for (...) {" → forの階層の列
        texts: lines.map((l) => l.textContent),
        guides: lines.map((l) => guideXs(l)),
      };
    });
    const near = (x, y) => x != null && y != null && Math.abs(x - y) < 0.6;
    const hasGuideAt = (lineIdx, col) => info.guides[lineIdx]?.some((g) => near(g, col));

    console.log(`  [実測] ${guideMode}モード: outer列=${info.outerCol?.toFixed(2)}, if列=${info.ifCol?.toFixed(2)}, for列=${info.forCol?.toFixed(2)}`);
    console.log(`  [実測] ${guideMode}モード: 各行の縦線本数= ${info.guides.map((g, i) => `${i}行目(${info.texts[i].trim().slice(0, 12) || "(空行)"})=${g.length}`).join(", ")}`);

    // for自身の開始行(index2)・終了行(index11 "    }")には、for自身(for列)の線が無い
    ok(`(R) ${guideMode}モード: forの開始行(3行目)にはfor自身の範囲の線が無い`, !hasGuideAt(2, info.forCol));
    ok(`(R) ${guideMode}モード: forの終了行(12行目、閉じ括弧だけの行)にもfor自身の範囲の線が無い`, !hasGuideAt(11, info.forCol));
    // for範囲の内側(4行目〜11行目、index3〜10)には、for自身の線がある
    let innerAllHave = true;
    for (let i = 3; i <= 10; i++) if (!hasGuideAt(i, info.forCol)) innerAllHave = false;
    ok(`(R) ${guideMode}モード: forの範囲の内側(4〜11行目)にはfor自身の範囲の線がある`, innerAllHave);

    // ネスト確認: 外側(outer・if)の線は、forの開始行・終了行にも引かれたままである
    // (それらはouter/ifから見れば内側の行のため)
    ok(`(R) ${guideMode}モード(ネスト確認): forの開始行にも、外側(outer)の線は引かれる`, hasGuideAt(2, info.outerCol));
    ok(`(R) ${guideMode}モード(ネスト確認): forの開始行にも、外側(if)の線は引かれる`, hasGuideAt(2, info.ifCol));
    ok(`(R) ${guideMode}モード(ネスト確認): forの終了行にも、外側(outer)の線は引かれる`, hasGuideAt(11, info.outerCol));
    ok(`(R) ${guideMode}モード(ネスト確認): forの終了行にも、外側(if)の線は引かれる`, hasGuideAt(11, info.ifCol));

    // outer自身の開始行(0行目)・終了行(14行目 "}")には、outer自身の線が無い
    ok(`(R) ${guideMode}モード: outerの開始行(1行目)にはouter自身の範囲の線が無い`, !hasGuideAt(0, info.outerCol));
    ok(`(R) ${guideMode}モード: outerの終了行(15行目)にもouter自身の範囲の線が無い`, !hasGuideAt(14, info.outerCol));
  }
  await applySettings(page, { codeIndentGuides: "fold" });

  ok("(R) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (S) 複数の階層が重なる場合の、行ごとのマーカー個数(0個または1個。comboでも1個)の実測。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "stack.js", NEST_DOC3);

  const counts = await page.evaluate(() => [...document.querySelectorAll(".cm-line")].map((l) => l.querySelectorAll(".cm-fold-marker2").length));
  console.log(`  [実測] 行ごとのマーカー個数: ${JSON.stringify(counts)}`);
  // 0(function),1(if),2(for),3(空行),4(if%2),5(通過),6(空行),7(通過),8(elseコンボ),
  // 9(通過),10(elseの}),11(forの}),12(ifの}),13(通過),14(functionの})
  const expected = [1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  ok(`(S) 行ごとのマーカー個数が期待どおり(開始行=1、combo行=1、それ以外=0)(実測=${JSON.stringify(counts)}, 期待=${JSON.stringify(expected)})`,
    JSON.stringify(counts) === JSON.stringify(expected));

  ok("(S) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (T) 9テーマ・3〜4段ネストでもマーカーが背景に埋もれないこと(K節のネスト版)。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "guidetheme.js", NEST_DOC3);

  for (const th of THEMES) {
    await applySettings(page, { theme: th.theme, lightTheme: th.lightTheme, darkTheme: th.darkTheme });
    const colors = await page.evaluate(() => {
      const markers = [...document.querySelectorAll(".cm-fold-marker2")];
      if (markers.length === 0) return null;
      // 最も深い(=最後の)マーカーで確認する(依頼2で懸念された「深いネストで埋もれる」を
      // 意識した選び方)。
      const span = markers[markers.length - 1];
      return { marker: getComputedStyle(span).color, fill: getComputedStyle(span).backgroundColor };
    });
    const paperRGB = await probeVar(page, "--paper");
    const paperStr = paperRGB ? `rgb(${paperRGB.r}, ${paperRGB.g}, ${paperRGB.b})` : null;
    const fillRatio = colors && paperStr ? contrastRatio(colors.fill, paperStr) : null;
    ok(`(T) ${th.label}: 深いネスト(4段目)のマーカーの地色が背景(--paper)に対しコントラスト比3.0以上(実測=${fillRatio?.toFixed(2)}、fill=${colors?.fill}, paper=${paperStr})`, !!fillRatio && fillRatio >= 3.0);
  }

  ok("(T) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (U) 拡大スクリーンショット(3〜4段ネスト・折りたたんだ状態・9テーマ)を.shots/へ保存する。
// =========================================================================
{
  const dpr = 3;
  const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 900, height: 760 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.chrome = { webview: { postMessage: (m) => { window.__sent.push(m); }, addEventListener: (_t, fn) => listeners.push(fn) } };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(400);
  await openFile(page, "screenshot.js", NEST_DOC3);
  fs.mkdirSync(".shots", { recursive: true });

  fs.writeFileSync(".shots/foldguide-final-unfolded.png", await page.screenshot({ fullPage: false }));

  await page.locator(".cm-line", { hasText: "for (let i" }).first().click();
  await page.keyboard.press("Alt+BracketLeft");
  await page.waitForTimeout(250);
  fs.writeFileSync(".shots/foldguide-final-folded.png", await page.screenshot({ fullPage: false }));
  await page.keyboard.press("Alt+BracketRight");
  await page.waitForTimeout(200);

  for (const th of THEMES) {
    await applySettings(page, { theme: th.theme, lightTheme: th.lightTheme, darkTheme: th.darkTheme });
    fs.writeFileSync(`.shots/foldguide-theme-${th.label}.png`, await page.screenshot({ fullPage: false }));
  }
  console.log(`  [記録] 拡大スクリーンショットを.shots/へ保存しました(foldguide-final-*.png、foldguide-theme-*.png×9)`);

  await page.close();
  await context.close();
}

// =========================================================================
// (V) 折りたたんだ状態({…}表示)でもマーカーが同じ列(=正しい位置)に出ること。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "foldedpos.js", NEST_DOC3);

  const beforeFoldLeft = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const forLine = lines.find((l) => l.textContent.includes("for (let"));
    return forLine?.querySelector(".cm-fold-marker2")?.getBoundingClientRect().left ?? null;
  });

  await page.locator(".cm-line", { hasText: "for (let i" }).first().click();
  await page.keyboard.press("Alt+BracketLeft");
  await page.waitForTimeout(300);

  const afterFold = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const forLine = lines.find((l) => l.textContent.includes("for (let"));
    const marker = forLine?.querySelector(".cm-fold-marker2");
    return { left: marker?.getBoundingClientRect().left ?? null, text: marker?.textContent, title: marker?.title, lineText: forLine?.textContent };
  });
  console.log(`  [実測] 折りたたみ前のfor行マーカーleft=${beforeFoldLeft?.toFixed(2)} / 折りたたみ後=${afterFold.left?.toFixed(2)} (行内容="${afterFold.lineText}")`);
  ok(`(V) 折りたたんだ状態でもマーカーが同じ列(=正しい位置)に出る(差=${Math.abs((beforeFoldLeft ?? 0) - (afterFold.left ?? 0)).toFixed(2)}px)`,
    beforeFoldLeft != null && afterFold.left != null && Math.abs(beforeFoldLeft - afterFold.left) < 0.5);
  ok(`(V) 折りたたみ後のマーカーは「+」・title="Unfold line"になる(実際="${afterFold.text}"/"${afterFold.title}")`, afterFold.text === "+" && afterFold.title === "Unfold line");
  ok(`(V) 折りたたみ後の行が「{…}」の省略表示になる(実際="${afterFold.lineText}")`, /for \(let i.*\{.*\}/.test((afterFold.lineText || "").replace(/^[−+]/, "")));

  await page.keyboard.press("Alt+BracketRight");
  await page.waitForTimeout(200);

  ok("(V) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (W) 依頼①「1行に出すマーカーは1つだけ」: 1行に複数階層の開き括弧が並ぶ稀なケース
// (ワンライナー)でも、マーカーは1個だけ(最も外側の範囲)しか出ないこと。クリックすると
// その最も外側の範囲が開閉されること(=中に入れ子の階層があっても丸ごと畳まれる)。
// =========================================================================
{
  const { page, errors } = await newPage();
  // 1行に3階層ぶんの開き括弧が並ぶワンライナー。
  const ONE_LINER = "function outer() { if (true) { for (let i = 0; i < 1; i++) {\n  return i;\n} } }\n";
  await openFile(page, "oneliner.js", ONE_LINER);

  const markers = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const line1 = lines[0];
    return [...line1.querySelectorAll(".cm-fold-marker2")].map((m) => {
      const r = m.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height, title: m.title };
    });
  });
  console.log(`  [実測] ワンライナー1行目のマーカー個数=${markers.length}: ${JSON.stringify(markers)}`);
  ok(`(W) 3階層が1行に同時に開いても、マーカーは1個だけ(最も外側の範囲)しか出ない(実測=${markers.length})`, markers.length === 1);
  ok("(W) マーカーが実寸(幅・高さ>0)を持つ", markers.length === 1 && markers[0].width > 0 && markers[0].height > 0);

  // クリックすると最も外側の範囲(function outer全体)が畳まれ、中の"if"・"for"も
  // まとめて非表示になることを確認する。
  const clicked = await page.evaluate(() => {
    const marker = document.querySelector(".cm-fold-marker2");
    if (!marker) return false;
    marker.click();
    return true;
  });
  await page.waitForTimeout(300);
  const afterClickText = await contentText(page);
  console.log(`  [実測] クリック後の本文: ${JSON.stringify(afterClickText)}`);
  ok(`(W) マーカーをクリックすると最も外側の範囲(function outer全体)が畳まれる(clicked=${clicked})`,
    !afterClickText.includes("return i;") && afterClickText.startsWith("function outer() {"));

  ok("(W) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (X) 改善③: 言語未設定のコードモードでのインデントベース折りたたみ
// =========================================================================
// 言語未選択のコードモードへ切り替えるヘルパー。__paneDebugEditorはブリッジ模擬時は
// 公開されないため(src/main.jsの`if (!bridge)`参照)、実機の操作手順どおり
// ネイティブメニュー相当の経路(見出しをクリック→menu-command)で切り替える
// (このファイル冒頭のCLAUDE.md記載の手順どおり)。
async function toCodeModeNoLanguage(page, text = "") {
  await page.evaluate((text) => window.__reply({
    type: "file-opened", fileName: null, path: null, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), text);
  await page.waitForTimeout(200);
  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__reply({ type: "menu-command", id: "view.modeCode" }));
  await page.waitForTimeout(300);
}
const NESTED_CODE = [
  "function outer() {",
  "  function inner() {",
  "    return 1;",
  "  }",
  "  return inner();",
  "}",
].join("\n");
{
  const { page, errors, consoleErrors } = await newPage();
  await toCodeModeNoLanguage(page);
  const m = await mode(page);
  ok(`(X) 言語未設定のままコードモードになる(実際: ${m})`, m === "コード");

  await page.click(".cm-content");
  await page.keyboard.type(NESTED_CODE, { delay: 2 });
  await page.waitForTimeout(300);
  const markerCount = await page.evaluate(() => document.querySelectorAll(".cm-fold-marker2").length);
  ok(`(X) 言語未設定でもインデントの深さでマーカーが出る(検出数=${markerCount}。修正前は実測0件だった)`, markerCount >= 2);

  const before = await contentText(page);
  await clickFirstMarker(page, "Fold line");
  await page.waitForTimeout(300);
  const afterFold = await contentText(page);
  ok("(X) クリックで畳まれ、内側の中身が消える", afterFold.includes("function outer() {") && !afterFold.includes("return inner();"));
  await clickFirstMarker(page, "Unfold line");
  await page.waitForTimeout(300);
  const afterUnfold = await contentText(page);
  ok("(X) もう一度クリックで展開し、元の表示に完全一致する", afterUnfold.trim() === before.trim());

  // キーボード操作(foldServiceとして登録しているため、標準のfoldCode/foldAll経由で
  // 同じ範囲がそのまま使える。マウスクリックと別経路で計算しているわけではないことの確認)。
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Alt+BracketLeft");
  await page.waitForTimeout(300);
  let text = await contentText(page);
  ok("(X) Alt-[ でカーソル行(outer)が畳まれる", !text.includes("return inner();"));
  await page.keyboard.press("Alt+BracketRight");
  await page.waitForTimeout(300);
  text = await contentText(page);
  ok("(X) Alt-] で展開される", text.includes("return inner();"));
  await page.keyboard.press("Control+Alt+BracketLeft");
  await page.waitForTimeout(300);
  text = await contentText(page);
  ok("(X) Ctrl-Alt-[ で全て(outer/innerとも)畳まれる", !text.includes("return inner();") && !text.includes("return 1;"));
  await page.keyboard.press("Control+Alt+BracketRight");
  await page.waitForTimeout(300);
  text = await contentText(page);
  ok("(X) Ctrl-Alt-] で全て展開される", text.includes("return inner();") && text.includes("return 1;"));

  ok("(X) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(X) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}
{
  // regression: 言語ありコードモードは従来どおり構文木ベース(foldNodeProp)のまま
  // (このフォールバックを追加したことで既存挙動を壊していないこと)。
  const { page, errors } = await newPage();
  await openFile(page, "sample5.js", JS_DOC);
  const markerCount = await page.evaluate(() => document.querySelectorAll(".cm-fold-marker2").length);
  ok(`(X-regression) 言語ありコードモードは従来どおりマーカーが出る(検出数=${markerCount})`, markerCount >= 5);
  ok("(X-regression) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}
{
  // regression: Markdownモードにはインデントフォールバックのマーカーが出ない
  // (codeModeExtrasComp経由でしか追加していないため、Markdownモードでは登録自体されない)。
  const { page, errors } = await newPage();
  await openFile(page, undefined, "# 見出し\n\n本文です。\n  さらにインデントされた行\n");
  const markerCount = await page.evaluate(() => document.querySelectorAll(".cm-fold-marker2").length);
  ok(`(X-regression) Markdownモードではインデントフォールバックのマーカーが出ない(検出数=${markerCount})`, markerCount === 0);
  ok("(X-regression) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (Y) 改善②: 言語未設定のコードモードで、内容から言語を自動判定する
// =========================================================================
// 実機報告: 「表示メニュー→コードモード」で言語未設定のまま使っていると、インデントの
// 無いコード(例: chrome拡張のコールバック登録)では折りたたみマーカーが出ず不便、という
// 指摘への対応。コードモードへ切り替えた直後・言語未設定のまま入力が続いている間、内容から
// 言語を推測して自動設定する(src/main.js maybeAutoDetectCodeLanguage/scheduleCodeLanguageIdle、
// src/detect-mode.js detectCodeLanguage参照)。
{
  const { page, errors, consoleErrors } = await newPage();
  await toCodeModeNoLanguage(page); // 新規文書 → 表示メニュー → コードモード(言語未設定)
  ok(`(Y) 切替直後は言語未設定の「コード」のまま(実際: ${await mode(page)})`, (await mode(page)) === "コード");

  // 依頼の確認方法どおり、実機報告の例(インデントの無いchrome拡張コールバック登録)を
  // 1文字ずつタイプする。
  await page.click(".cm-content");
  const CHROME_SNIPPET = "chrome.action.onClicked.addListener(async () => {\n});";
  await page.keyboard.type(CHROME_SNIPPET, { delay: 20 });
  // AUTO_DETECT_IDLE_MS(1.5秒)のデバウンス経路(scheduleCodeLanguageIdle)で判定されるため、
  // それより余裕を持って待つ。
  await page.waitForTimeout(2200);
  const yMode = await mode(page);
  ok(`(Y) 1文字ずつタイプしただけで「コード (JavaScript)」に自動設定される(実際: ${yMode})`, yMode === "コード (JavaScript)");

  const markerCount = await page.evaluate(() => document.querySelectorAll(".cm-fold-marker2").length);
  ok(`(Y) インデントが無くても(言語が決まり構文木ベースの折りたたみへ切り替わるため)マーカーが出る(検出数=${markerCount}。改善前は実測0件だった)`, markerCount >= 1);

  ok("(Y) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(Y) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}
{
  // (Y-regression) 判定できない内容(ただの日本語の文章)では言語が誤設定されず、
  // インデントベースのフォールバック(改善③、前回実装)が従来どおり働くことを確認する。
  const { page, errors } = await newPage();
  await toCodeModeNoLanguage(page);
  await page.click(".cm-content");
  const PROSE = "外側の説明:\n    内側の説明1\n    内側の説明2\nまとめ";
  await page.keyboard.type(PROSE, { delay: 10 });
  await page.waitForTimeout(2200);
  const yMode = await mode(page);
  ok(`(Y-regression) 判定できない内容(日本語の文章)では言語が設定されず「コード」のまま(実際: ${yMode})`, yMode === "コード");
  const markerCount = await page.evaluate(() => document.querySelectorAll(".cm-fold-marker2").length);
  ok(`(Y-regression) 言語が設定されなくても、インデントベースのフォールバックでマーカーは従来どおり出る(検出数=${markerCount})`, markerCount >= 1);
  ok("(Y-regression) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (Z1) 依頼①の実測: タブインデントでも、マーカーの位置(本文エリア左端から5px)が
// インデントの深さやタブ幅設定(codeIndentSize)に関わらず一定であること。
//
// 【注意、正しい理解】 マーカーは固定位置(本文エリア左端から5px)のため、
// 「マーカー右端→コード開始位置」の隙間は、インデントが無い行(depth0)でだけ
// 5px(=padding-leftの内訳どおり)になる。インデントが深い行では、その分だけ
// コード開始位置が右へ動くため、隙間は「5px + そのインデント幅」に自然に広がる
// (これは正しい挙動であり、以前の可変位置マーカーの不具合とは異なる)。
// 以前(2世代目の実装)の不具合「タブでインデントするとマーカーがコードから
// どんどん離れていく」は、マーカー自身がタブの列数計算を誤って動いてしまうことが
// 原因だった。今回はマーカーが最初から動かないため、この種の不具合はマーカー位置
// そのものには構造的に発生し得ない。この節では、(a) マーカー位置がタブ幅・深さに
// 関わらず5pxで一定であること、(b) コード開始位置までの隙間が深さに応じて実際の
// タブ幅ぶん正しく増えていく(=indentUnit/tabSizeの実測結果、(G)節と対応)ことの
// 両方を確認する。
// =========================================================================
{
  const { page, errors } = await newPage();
  const TAB_NEST_DOC = [
    "function outer(a) {",
    "\tif (a > 0) {",
    "\t\tfor (let i = 0; i < a; i++) {",
    "\t\t\tconsole.log(i);",
    "\t\t}",
    "\t}",
    "\treturn a;",
    "}",
  ].join("\n");
  await openFile(page, "tabnest.js", TAB_NEST_DOC);

  // 各行の(本文エリア左端→マーカー左端)・(マーカー右端→実際のコード開始位置)の隙間(px)。
  async function markerGaps(page) {
    return page.evaluate(() => {
      const content = document.querySelector(".cm-content");
      const contentLeft = content.getBoundingClientRect().left;
      const lines = [...document.querySelectorAll(".cm-line")];
      return lines.map((line) => {
        const marker = line.querySelector(".cm-fold-marker2");
        if (!marker) return null;
        const mr = marker.getBoundingClientRect();
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = null, offset = -1;
        while (walker.nextNode()) {
          const t = walker.currentNode;
          if (marker.contains(t)) continue;
          const idx = t.data.search(/\S/);
          if (idx >= 0) { node = t; offset = idx; break; }
        }
        if (!node) return null;
        const r = document.createRange();
        r.setStart(node, offset); r.setEnd(node, offset + 1);
        return { leftGap: mr.left - contentLeft, rightGap: r.getBoundingClientRect().left - mr.right };
      });
    });
  }

  for (const size of [4, 2, 8]) {
    await applySettings(page, { codeIndentSize: size });
    const gaps = (await markerGaps(page)).filter((g) => g != null);
    console.log(`  [実測] タブ幅=${size}: 本文エリア左端→マーカー左端(depth0→2の順)= ${gaps.map((g) => g.leftGap.toFixed(2)).join(", ")} / マーカー右端→コード開始位置= ${gaps.map((g) => g.rightGap.toFixed(2)).join(", ")}`);
    ok(`(Z1) タブ幅=${size}: 本文エリア左端→マーカー左端がどの深さでも5pxで一定(依頼①の核心。実測=${gaps.map((g) => g.leftGap.toFixed(2))})`,
      gaps.length === 3 && gaps.every((g) => Math.abs(g.leftGap - 5) < 0.5));
    ok(`(Z1) タブ幅=${size}: インデントの無い行(depth0)では、マーカー右端→コード開始位置がちょうど5px(実測=${gaps[0]?.rightGap.toFixed(2)})`,
      gaps.length === 3 && Math.abs(gaps[0].rightGap - 5) < 1.0);
    // タブ1個ぶんの表示幅(≒コード開始位置の増分)は、depth1→depth0の差から実測できる。
    // depth2はさらにタブもう1個ぶん増えるはずなので、増分がほぼ一定であることを確認する
    // (=タブ幅設定に比例して素直に増えており、累積してズレたり暴れたりしない)。
    const step1 = gaps[1].rightGap - gaps[0].rightGap;
    const step2 = gaps[2].rightGap - gaps[1].rightGap;
    ok(`(Z1) タブ幅=${size}: 深さが増えるごとの隙間の増分が、タブ1個ぶんの幅でほぼ一定(段差1=${step1.toFixed(2)}px, 段差2=${step2.toFixed(2)}px)`,
      Math.abs(step1 - step2) < 1.5 && step1 > 0);
  }

  ok("(Z1) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (Z2) 依頼②の追加実測(訂正版の依頼①を反映): foldモードで、複数の深さすべてにおいて
// 「その階層の縦線は、マーカーがある開始行自身には引かれず、次の行(内側の1行目)から、
// その開始行自身の実際のコード開始位置(=行頭空白の終端)に来ること」がdepth0〜3の
// どの段でも成立することを確認する(依頼①だけでなく、Windows実機フィードバックによる
// 訂正版も込みで、ネストのどの段でも同じ規則が成り立つことの確認)。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "z2.js", NEST_DOC3);

  // マーカーが存在する行(=新たに範囲が開く行)それぞれについて、
  //   (a) その行自身には、自分の階層の縦線が無い
  //   (b) 次の行には、その行自身のコード開始位置に一致する縦線がある
  // ことを確認する。ネストが深い行ほど、複数の範囲(外側〜自分自身)ぶんの.cm-guide-lineが
  // 同時に乗るため、比較は「自分自身のコード開始位置」ちょうどの列だけに絞る。
  const rows = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    function codeStartOf(line) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = null, offset = -1;
      while (walker.nextNode()) {
        const t = walker.currentNode;
        if (t.parentElement.closest(".cm-fold-marker2")) continue;
        const idx = t.data.search(/\S/);
        if (idx >= 0) { node = t; offset = idx; break; }
      }
      if (!node) return null;
      const r = document.createRange();
      r.setStart(node, offset); r.setEnd(node, offset + 1);
      return r.getBoundingClientRect().left;
    }
    return lines.map((line, i) => {
      const marker = line.querySelector(".cm-fold-marker2");
      if (!marker) return null;
      const codeStart = codeStartOf(line);
      if (codeStart == null) return null;
      const ownGuideOnSelf = [...line.querySelectorAll(".cm-guide-line")].some((g) => Math.abs(g.getBoundingClientRect().left - codeStart) < 0.6);
      const nextLine = lines[i + 1];
      const ownGuideOnNext = nextLine
        ? [...nextLine.querySelectorAll(".cm-guide-line")].some((g) => Math.abs(g.getBoundingClientRect().left - codeStart) < 0.6)
        : false;
      return { i, text: line.textContent.slice(0, 24), codeStart, ownGuideOnSelf, ownGuideOnNext };
    }).filter(Boolean);
  });
  console.log(`  [実測] foldモード、マーカーがある各行の判定: ${JSON.stringify(rows)}`);
  ok(`(Z2) foldモード: マーカーが存在するすべての行(${rows.length}行、depth0〜3)で、自分自身の階層の縦線がその開始行自身には無い`,
    rows.length >= 3 && rows.every((r) => !r.ownGuideOnSelf));
  ok(`(Z2) foldモード: マーカーが存在するすべての行(${rows.length}行、depth0〜3)で、自分自身の階層の縦線が次の行(内側の1行目)にはある`,
    rows.length >= 3 && rows.every((r) => r.ownGuideOnNext));

  ok("(Z2) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (Z3) 依頼③の実測: インデントガイドの3択設定(codeIndentGuides: none/fold/all)。
// 再起動なしで即座に反映されること・折りたたみを畳むとその範囲の線が消えることを実測する。
//
// 【依頼②に伴う書き直し】 以前は"all"用(.cm-indent-guide)と"fold"用(.cm-fold-guide-line)が
// 別クラス名だったため、「同時に両方出ていないか」をクラス名で区別して確認できたが、
// 依頼②で両モードとも同じクラス名(.cm-guide-line)の1つの仕組みに統合した
// ため、クラス名では区別できなくなった(=それ自体が「二重線を描く仕組みが物理的に1つしか
// 無い」ことの証明でもある)。代わりに、"all"は"fold"の出力を完全に包含する設計にした
// (buildAllIndentGuides参照。構造的な範囲はfoldモードと全く同じ規則で描いてから、
// 残りを汎用の目盛りで埋める)ため、本数(all >= fold)で両モードの違いを確認する。
// =========================================================================
{
  // 注意: このnewPage()はwindow.chrome.webviewをモックするため、src/main.jsの
  // `if (!bridge)`によりwindow.__paneDebugEditorは公開されない(このファイル冒頭の運用
  // ルールどおり)。そのため、この節ではブリッジ経由(apply-settingsメッセージ、実際の
  // 設定画面と全く同じ経路)とDOM観測だけで検証する。
  const { page, errors } = await newPage();
  await openFile(page, "z3.js", NEST_DOC3);

  async function guideCount(page) {
    return page.evaluate(() => document.querySelectorAll(".cm-guide-line").length);
  }

  const c0 = await guideCount(page);
  ok(`(Z3) 既定("fold")では縦線が出ている(実際=${c0})`, c0 > 0);

  // "all"へ切替(設定画面と同じ経路: apply-settingsメッセージ)。再起動なしで即座に切り替わり、
  // "fold"の出力を完全に包含する(=本数がfold以上になる)こと。
  await applySettings(page, { codeIndentGuides: "all" });
  const c1 = await guideCount(page);
  ok(`(Z3) "all"へ切り替えると、再起動なしで即座に本数が変わる(fold=${c0} → all=${c1}、allはfoldの出力を包含するため本数以上になるはず)`, c1 >= c0);

  // "none"へ切替。両方0本になる。
  await applySettings(page, { codeIndentGuides: "none" });
  const c2 = await guideCount(page);
  ok(`(Z3) "none"へ切り替えると、縦線が0本になる(実際=${c2})`, c2 === 0);
  const markerCount = await page.evaluate(() => document.querySelectorAll(".cm-fold-marker2").length);
  ok(`(Z3) "none"でも折りたたみマーカー自体は消えない(codeIndentGuidesはガイドの表示だけを制御する。実際=${markerCount})`, markerCount >= 3);

  // "fold"へ戻す。元と同じ本数に戻ること(=蓄積・残留が無いこと)。
  await applySettings(page, { codeIndentGuides: "fold" });
  const c3 = await guideCount(page);
  ok(`(Z3) "fold"へ戻すと、切替前と同じ本数に戻る(元=${c0}, 実際=${c3})`, c3 === c0);

  // 不正な値は設定ファイル破損対策と同じ方針で既定の"fold"へ倒れる(apply-settings経由、
  // 実際の設定ファイルが手で壊れていた場合と同じ経路)。
  await applySettings(page, { codeIndentGuides: "bogus" });
  const afterBogus = await guideCount(page);
  ok(`(Z3) 不正な値("bogus")は既定の"fold"へ倒れる(本数もfold相当に戻る。実際=${afterBogus})`, afterBogus === c0);

  // 折りたたみを畳むと、その範囲ぶんの縦線が消えること(依頼③「畳んだ状態(+表示)では、
  // その範囲の線が消える」)。forの範囲を畳む。
  await page.locator(".cm-line", { hasText: "for (let i" }).first().click();
  await page.keyboard.press("Alt+BracketLeft");
  await page.waitForTimeout(300);
  const afterFold = await guideCount(page);
  console.log(`  [実測] for範囲を畳んだ後の縦線数: 畳む前=${c3} → 畳んだ後=${afterFold}`);
  ok(`(Z3) forの範囲を畳むと、その分だけ縦線の本数が減る(畳む前=${c3}, 畳んだ後=${afterFold})`, afterFold < c3);
  await page.keyboard.press("Alt+BracketRight");
  await page.waitForTimeout(200);

  // codeFoldingEnabled自体がOFFのときは、マーカーが無いのにfoldモードの線だけ残る、という
  // 不自然な状態を避けるため、foldモードの線も一緒に消える設計にしてある(allモードは
  // codeFoldingEnabledに関わらず表示されるため対象外)。
  await applySettings(page, { codeFoldingEnabled: false });
  const afterFoldingOff = await guideCount(page);
  ok(`(Z3) codeFoldingEnabled:falseのとき、foldモードの線も一緒に消える(マーカーだけ消しても線が残る、という不自然な状態を避ける。実際=${afterFoldingOff})`, afterFoldingOff === 0);
  await applySettings(page, { codeFoldingEnabled: true });

  ok("(Z3) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (Z4) 依頼③の実測: 設定画面(settings.js/settings-window.html)側の配線。「編集」カテゴリに
// codeIndentGuidesのセレクトが追加されており、3つの選択肢・既定値"fold"(C#側が未対応で
// キーを送ってこなくても)・保存時の往復が正しく機能すること。
// =========================================================================
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  await page.addInitScript(() => {
    const listeners = [];
    window.__sent = [];
    window.chrome = { webview: { postMessage: (m) => { window.__sent.push(m); }, addEventListener: (_t, fn) => listeners.push(fn) } };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(`http://localhost:8195/settings-window.html`);
  await page.waitForTimeout(400);

  // 旧バージョンのC#(codeIndentGuides未対応)を模して、あえてこのキーを含めない応答を返す。
  await page.evaluate(() => window.__reply({
    type: "settings",
    codeIndentSize: 4, codeFoldingEnabled: true, // codeIndentGuidesは意図的に含めない
  }));
  await page.waitForTimeout(300);

  const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
  const editIdx = cats.findIndex((c) => c === "編集");
  ok(`(Z4) 「編集」カテゴリが見つかる(実際=${JSON.stringify(cats)})`, editIdx >= 0);
  if (editIdx >= 0) {
    await page.click(`.settings-nav-item >> nth=${editIdx}`);
    await page.waitForTimeout(150);

    const field = await page.evaluate(() => {
      const sel = document.querySelector('select[data-field="codeIndentGuides"]');
      if (!sel) return null;
      return { value: sel.value, options: [...sel.options].map((o) => ({ value: o.value, text: o.textContent })) };
    });
    ok(`(Z4) codeIndentGuidesのセレクトが「編集」カテゴリに存在する`, !!field);
    ok(`(Z4) 3つの選択肢(none/fold/all)が正しい順で並んでいる(実際=${JSON.stringify(field?.options.map((o) => o.value))})`,
      JSON.stringify(field?.options.map((o) => o.value)) === JSON.stringify(["none", "fold", "all"]));
    ok(`(Z4) C#側が未対応でキーを送ってこなくても、既定値"fold"が選ばれている(実際=${field?.value})`, field?.value === "fold");

    await page.selectOption('select[data-field="codeIndentGuides"]', "all");
    await page.click('[data-act="save"]');
    await page.waitForTimeout(200);
    const sentSave = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings").pop());
    ok(`(Z4) "all"を選んで保存すると、save-settingsにcodeIndentGuides:"all"が含まれる(実際=${sentSave?.settings?.codeIndentGuides})`, sentSave?.settings?.codeIndentGuides === "all");
  }

  ok("(Z4) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (AA) 依頼②の実測: "all"と"fold"で、同じ階層の線が必ず同じx座標になること。
// 依頼②の核心(「位置の決め方が違うため、両方出すとずれる」というユーザー指摘の再発防止)。
// codeIndentSizeと実際のインデント幅が一致した、整形されたコード(4スペース刻み)で、
// foldモード・allモードそれぞれで使われる縦線のx座標の集合を全行から集め、両者が
// 完全に一致することを確認する(2つのモードが同じ列計算の経路(view.defaultCharacterWidth
// による実測px)を通っていることの直接証拠)。
// =========================================================================
{
  const { page, errors } = await newPage();
  const ALIGN_DOC = [
    "function outer() {",
    "    if (x) {",
    "        for (let i = 0; i < 10; i++) {",
    "            doThing(i);",
    "        }",
    "    }",
    "    return 1;",
    "}",
    "",
    "const config = {",
    '    name: "pane",',
    "};",
    "",
  ].join("\n"); // codeIndentSize既定(4)に合わせて4スペース刻みでインデントする
  await openFile(page, "align.js", ALIGN_DOC);

  async function guideXs(page) {
    return page.evaluate(() => {
      const lines = [...document.querySelectorAll(".cm-line")];
      const xs = new Set();
      for (const l of lines) for (const g of l.querySelectorAll(".cm-guide-line")) xs.add(Math.round(g.getBoundingClientRect().left * 100) / 100);
      return [...xs].sort((a, b) => a - b);
    });
  }

  await applySettings(page, { codeIndentGuides: "fold" });
  const foldXs = await guideXs(page);
  await applySettings(page, { codeIndentGuides: "all" });
  const allXs = await guideXs(page);
  console.log(`  [実測] foldモードのx座標集合= [${foldXs.map((x) => x.toFixed(2))}] / allモードのx座標集合= [${allXs.map((x) => x.toFixed(2))}]`);
  ok(`(AA) foldモードで使われるx座標がすべてallモードにも存在する(依頼②「同じ階層の線は必ず同じx座標」。fold=${foldXs.length}種, all=${allXs.length}種)`,
    foldXs.length > 0 && foldXs.every((fx) => allXs.some((ax) => Math.abs(ax - fx) < 0.5)));
  // allはfoldの出力を完全に包含する設計(buildAllIndentGuides参照)のため、種類数もfold以上になる。
  ok(`(AA) allモードの縦線の列数がfoldモード以上(allがfoldを包含する設計。fold=${foldXs.length}, all=${allXs.length})`, allXs.length >= foldXs.length);

  await applySettings(page, { codeIndentGuides: "fold" });
  ok("(AA) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (BB) 【Windows実機フィードバックの訂正版】終了行(toLine)の判定は行番号の機械的な-1では
// なく実インデント列で行っていることの実測(L字は廃止済みのため、その代わりにこの節を
// 作り直した)。JS/HTML等の括弧・タグ言語では終了行=閉じ括弧/閉じタグの行(開始行と同じ
// 浅さ)だが、Pythonのようなインデントベースの折りたたみでは終了行はブロック内の最後の
// 実行行(開始行より深いインデント)を指す。もし機械的に「toLineを常に描画対象から除外する」
// 実装にしていたら、Pythonでは本来線を引くべき最終行が消えてしまう。それが起きていないこと
// (=isLineDeeperThanLevelによる実インデント判定が機能していること)を実測する。
// あわせて、縦線が行ボックスの全高をまっすぐ塗るだけであること(L字が無いこと)も確認する。
// =========================================================================
{
  const { page, errors } = await newPage();
  const PY_DOC = [
    "def outer():",            // 0 outer開始(マーカー)。leftCol=0
    "    def inner():",        // 1 inner開始(マーカー)。leftCol=4
    "        x = 1",           // 2 inner内側
    "        return x",        // 3 inner内側かつouter内側(inner範囲の最終行=閉じ括弧が無く、
                                //   ブロック内最後の実行行そのもの。indent8 > inner自身のleftCol4)
    "    return inner()",      // 4 outer範囲の最終行そのもの(閉じ括弧が無く、indent4 > outer自身のleftCol0)
    "",
    'print("after")',           // 6 outerが閉じた後
  ].join("\n");
  await openFile(page, "range.py", PY_DOC);
  const pyMode = await mode(page);
  ok(`(BB) .pyがコード(Python)モードで開く(実際: ${pyMode})`, pyMode === "コード (Python)");

  const info = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    function codeStartX(line) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = null, offset = -1;
      while (walker.nextNode()) {
        const t = walker.currentNode;
        if (t.parentElement.closest(".cm-fold-marker2")) continue;
        const idx = t.data.search(/\S/);
        if (idx >= 0) { node = t; offset = idx; break; }
      }
      if (!node) return null;
      const r = document.createRange();
      r.setStart(node, offset); r.setEnd(node, offset + 1);
      return r.getBoundingClientRect().left;
    }
    function hasGuideAt(line, x) {
      return x != null && [...line.querySelectorAll(".cm-guide-line")].some((g) => Math.abs(g.getBoundingClientRect().left - x) < 0.6);
    }
    const outerCol = codeStartX(lines[0]); // "def outer():" のコード開始位置=outer自身の階層の列
    return {
      texts: lines.map((l) => l.textContent),
      outerCol,
      outerGuideOnOpenLine: hasGuideAt(lines[0], outerCol),   // 開始行(0行目)には無いはず
      outerGuideOnLastLine: hasGuideAt(lines[4], outerCol),   // ブロック内最後の実行行(4行目)にはあるはず
      outerGuideOnAfterBlank: hasGuideAt(lines[6], outerCol), // ブロックの外(6行目、print)には無いはず
    };
  });
  console.log(`  [実測] Python範囲判定: ${JSON.stringify(info)}`);
  ok("(BB) Pythonのouter開始行(1行目)にはouter自身の縦線が無い", !info.outerGuideOnOpenLine);
  ok("(BB) Pythonのブロック内最後の実行行(5行目'    return inner()'、閉じ括弧ではなく実インデントで判定)にouter自身の縦線がある(機械的な-1ではなく実インデント列で判定できている証拠)",
    info.outerGuideOnLastLine);
  ok("(BB) outerブロックの外(print行)にはouter自身の縦線が無い", !info.outerGuideOnAfterBlank);

  // L字が無いこと(縦線は行ボックスの全高をまっすぐ塗るだけ)を実測する。
  const lineGeo = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const target = lines[4]; // "    return inner()"(outer自身の縦線が乗る行)
    const guide = target?.querySelector(".cm-guide-line");
    if (!guide) return null;
    const gr = guide.getBoundingClientRect();
    const lr = target.getBoundingClientRect();
    return { guideTop: gr.top, guideBottom: gr.bottom, guideHeight: gr.height, lineTop: lr.top, lineBottom: lr.bottom, lineHeight: lr.height, elbowCount: target.querySelectorAll(".cm-guide-elbow").length };
  });
  console.log(`  [実測] 縦線のジオメトリ: ${JSON.stringify(lineGeo)}`);
  ok(`(BB) 縦線は行ボックスの全高をまっすぐ塗る(L字による半分止めが無い。線の高さ=${lineGeo?.guideHeight.toFixed(2)}, 行の高さ=${lineGeo?.lineHeight.toFixed(2)})`,
    !!lineGeo && Math.abs(lineGeo.guideHeight - lineGeo.lineHeight) < 0.6);
  ok(`(BB) L字要素(.cm-guide-elbow)自体が存在しない(実測=${lineGeo?.elbowCount})`, lineGeo?.elbowCount === 0);

  // 行の高さを変える設定(editorLineHeight)でも、縦線の高さが正しく追従すること
  // (固定値を焼き込んでいれば古い高さのままズレるはずのテスト)。
  await applySettings(page, { editorLineHeight: 2.6 });
  await page.waitForTimeout(200);
  const lineGeo2 = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const target = lines[4];
    const guide = target?.querySelector(".cm-guide-line");
    if (!guide) return null;
    const gr = guide.getBoundingClientRect();
    const lr = target.getBoundingClientRect();
    return { guideHeight: gr.height, lineHeight: lr.height };
  });
  console.log(`  [実測] editorLineHeight=2.6後: ${JSON.stringify(lineGeo2)}`);
  ok(`(BB) 行の高さ設定を変えても、縦線の高さは行の高さに追従する(差=${lineGeo2 ? Math.abs(lineGeo2.guideHeight - lineGeo2.lineHeight).toFixed(2) : "N/A"})`,
    !!lineGeo2 && Math.abs(lineGeo2.guideHeight - lineGeo2.lineHeight) < 0.6);
  ok(`(BB) 行の高さが実際に変わっている(変更前=${lineGeo?.lineHeight.toFixed(2)}, 変更後=${lineGeo2?.lineHeight.toFixed(2)})`,
    !!lineGeo2 && Math.abs(lineGeo2.lineHeight - lineGeo.lineHeight) > 1.0);
  await applySettings(page, { editorLineHeight: 1.95 });

  ok("(BB) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (CC) 依頼④の実測: VS Codeのような折りたたみコマンド(レベル1〜5・すべてのコメント
// ブロックを折りたたむ・カーソル位置を再帰的に折りたたむ/展開)。メニュー(表示メニュー)
// 経由での動作、Markdownモードでは無効(グレーアウト)になることを確認する。
// =========================================================================
{
  const { page, errors } = await newPage();

  async function runMenuCommand(id) {
    await page.click("#menubar .menu-top:text('表示')");
    await page.waitForTimeout(150);
    await page.evaluate((i) => window.__reply({ type: "menu-command", id: i }), id);
    await page.waitForTimeout(250);
  }

  const LEVEL_DOC = [
    "function a() {",
    "    if (x) {",
    "        for (i = 0;;) {",
    "            g();",
    "        }",
    "    }",
    "}",
    "",
    "function b() {",
    "    return 1;",
    "}",
    "",
  ].join("\n");
  await openFile(page, "level.js", LEVEL_DOC);

  await runMenuCommand("view.foldLevel1");
  let text = await contentText(page);
  ok(`(CC) レベル1で折りたたむ: 両方のfunctionが畳まれ、中身(if等)が見えない(実際=${JSON.stringify(text)})`,
    !text.includes("if (x)") && text.includes("function a() {") && text.includes("function b() {"));

  await runMenuCommand("view.foldLevel2");
  text = await contentText(page);
  ok(`(CC) レベル2で折りたたむ: ifは畳まれるが、functionは展開される(実際=${JSON.stringify(text)})`,
    text.includes("if (x)") && !text.includes("for (i") && text.includes("return 1;"));
  await runMenuCommand("view.unfoldAllRanges");

  // 再帰的な折りたたみ: カーソルをfunction aの行に置いてから実行する。
  await page.click(".cm-content");
  await page.keyboard.press("Control+Home");
  await runMenuCommand("view.foldRecursively");
  text = await contentText(page);
  ok(`(CC) カーソル位置を再帰的に折りたたむ: function a全体(内側のif/forも含めて)が畳まれ、function bには影響しない(実際=${JSON.stringify(text)})`,
    text.includes("function a() {") && !text.includes("if (x)") && text.includes("function b() {") && text.includes("return 1;"));

  // 外側だけ(非再帰)展開すると、内側は畳まれたまま(=再帰的に畳んだ証拠)。
  await runMenuCommand("view.unfoldAtCursor");
  text = await contentText(page);
  ok(`(CC) 再帰的に畳んだ後、外側だけ展開(Alt-]相当)すると内側(if)はまだ畳まれたまま(実際=${JSON.stringify(text)})`,
    text.includes("if (x) {") && !text.includes("for (i"));

  // 再帰的に展開: 畳まれている"if"の行にカーソルを置いて実行する。
  const foldedLineBox = await page.evaluate(() => {
    const marker = document.querySelector('.cm-fold-marker2[title="Unfold line"]');
    const line = marker?.closest(".cm-line");
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: r.left + r.width - 5, y: r.top + r.height / 2 };
  });
  if (foldedLineBox) await page.mouse.click(foldedLineBox.x, foldedLineBox.y);
  await page.waitForTimeout(150);
  await runMenuCommand("view.unfoldRecursively");
  text = await contentText(page);
  ok(`(CC) カーソル位置を再帰的に展開する: forの中身まで見える(実際=${JSON.stringify(text)})`, text.includes("for (i") && text.includes("g();"));

  // すべてのコメントブロックを折りたたむ(複数行コメントのみ対象。1行コメントは対象外)。
  const COMMENT_DOC = [
    "/*",
    " * multi-line comment",
    " */",
    "function f() {",
    "  // single line, should not fold",
    "  return 1;",
    "}",
  ].join("\n");
  await openFile(page, "comments.js", COMMENT_DOC);
  await runMenuCommand("view.foldAllBlockComments");
  text = await contentText(page);
  console.log(`  [実測] すべてのコメントブロックを折りたたんだ後: ${JSON.stringify(text)}`);
  ok(`(CC) すべてのコメントブロックを折りたたむ: 複数行コメントが畳まれ、1行コメント・functionは畳まれない(実際=${JSON.stringify(text)})`,
    !text.includes("multi-line comment") && text.includes("single line, should not fold") && text.includes("return 1;"));

  // Markdownモードでは無効(グレーアウト)。ブリッジあり(ネイティブメニュー経路)のため
  // 実際のHTMLドロップダウンは描画されず、C#へpostMessageする"open-menu"のitems配列で
  // enabledを確認する(commands.js buildNativeItem参照)。
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(200);
  const openMenuMd = await page.evaluate(() => window.__sent.find((m) => m.type === "open-menu" && m.menu === "View"));
  const foldItemMd = openMenuMd?.items?.find((i) => i.id === "view.foldAtCursor");
  const levelItemMd = openMenuMd?.items?.find((i) => i.id === "view.foldLevel3");
  const commentsItemMd = openMenuMd?.items?.find((i) => i.id === "view.foldAllBlockComments");
  ok(`(CC) Markdownモードでは折りたたみ関連のメニュー項目がすべて無効になる(fold=${foldItemMd?.enabled}, level3=${levelItemMd?.enabled}, comments=${commentsItemMd?.enabled})`,
    foldItemMd?.enabled === false && levelItemMd?.enabled === false && commentsItemMd?.enabled === false);
  await page.keyboard.press("Escape");

  // コードモードに戻すと有効になる。
  await runMenuCommand("view.modeCode");
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(200);
  const openMenuCode = await page.evaluate(() => window.__sent.find((m) => m.type === "open-menu" && m.menu === "View"));
  const levelItemCode = openMenuCode?.items?.find((i) => i.id === "view.foldLevel3");
  ok(`(CC) コードモードに戻すと折りたたみ関連のメニュー項目が有効になる(level3=${levelItemCode?.enabled})`, levelItemCode?.enabled === true);
  // 依頼どおりレベル1〜5の5項目・再帰2項目・コメントブロック1項目が揃っていることも確認する。
  const foldIds = (openMenuCode?.items ?? []).map((i) => i.id).filter((id) => id && id.startsWith("view.fold") || id === "view.unfoldAtCursor" || id === "view.unfoldAllRanges" || id === "view.unfoldRecursively");
  console.log(`  [実測] 表示メニューの折りたたみ関連コマンドID一覧: ${JSON.stringify(foldIds)}`);
  for (const id of ["view.foldAtCursor", "view.unfoldAtCursor", "view.foldAllRanges", "view.unfoldAllRanges", "view.foldRecursively", "view.unfoldRecursively", "view.foldLevel1", "view.foldLevel2", "view.foldLevel3", "view.foldLevel4", "view.foldLevel5", "view.foldAllBlockComments"]) {
    ok(`(CC) メニューにコマンド"${id}"が存在する`, foldIds.includes(id));
  }
  await page.keyboard.press("Escape");

  ok("(CC) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (DD) 依頼⑤の実測: マーカーにマウスを乗せると、対応する折りたたみ範囲の縦線だけが
// 強調され、無関係な縦線は変化しないこと。マウスを離すと元に戻ること。
// 依頼(ホバー強調色をテーマごとに個別実測): --fold-guide-hoverが9テーマそれぞれで
// (a) --paperに対しコントラスト比3.0以上(目標4.5以上)、(b) 通常時の線--ruleとの
// 差がはっきりしている(色差・コントラスト比とも実測)ことを確認する。1万行でも
// ホバー時に処理が引っかからないこと(decoration setを再構築しない設計、実測)。
// =========================================================================
{
  const { page, errors } = await newPage();
  await openFile(page, "hover.js", NEST_DOC3);
  await applySettings(page, { codeIndentGuides: "fold" });

  // forの行(depth2)のマーカーにホバーする。
  const forMarkerBox = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const target = lines.find((l) => l.textContent.includes("for (let i"));
    const marker = target?.querySelector(".cm-fold-marker2");
    if (!marker) return null;
    const r = marker.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(forMarkerBox.x, forMarkerBox.y);
  await page.waitForTimeout(150);
  const hotState = await page.evaluate(() => {
    const all = [...document.querySelectorAll(".cm-guide-line")];
    return all.map((l) => ({ hot: l.classList.contains("cm-guide-hot"), color: getComputedStyle(l).backgroundColor, left: l.getBoundingClientRect().left }));
  });
  const hotCount = hotState.filter((s) => s.hot).length;
  console.log(`  [実測] forマーカーホバー時: 強調された線の本数=${hotCount} / 全体の本数=${hotState.length}`);
  ok(`(DD) マーカーにホバーすると、対応する範囲の縦線だけがcm-guide-hotになる(強調=${hotCount}, 全体=${hotState.length})`, hotCount > 0 && hotCount < hotState.length);
  const forLeft = hotState.find((s) => s.hot)?.left;
  ok("(DD) 強調される線はすべて同じx座標(=forの範囲1本分)", hotState.filter((s) => s.hot).every((s) => Math.abs(s.left - forLeft) < 0.5));
  const hotColor = hotState.find((s) => s.hot)?.color;
  const coldColor = hotState.find((s) => !s.hot)?.color;
  ok(`(DD) 強調時の色が非強調時と実際に異なる(hot=${hotColor}, cold=${coldColor})`, hotColor !== coldColor);

  // マウスを離すと元に戻る。
  await page.mouse.move(10, 10);
  await page.waitForTimeout(150);
  const afterLeave = await page.evaluate(() => document.querySelectorAll(".cm-guide-hot").length);
  ok(`(DD) マウスを離すと強調が消える(残数=${afterLeave})`, afterLeave === 0);

  // "none"モード(縦線を出さない設定)では、強調すべき線が無いためホバーしてもエラーに
  // ならず何も起きない(マーカー自体の既存hover配色は引き続き効く)。
  await applySettings(page, { codeIndentGuides: "none" });
  await page.mouse.move(forMarkerBox.x, forMarkerBox.y);
  await page.waitForTimeout(150);
  ok("(DD) noneモードでもマーカーホバーでエラーが出ない", errors.length === 0);
  await page.mouse.move(10, 10);
  await applySettings(page, { codeIndentGuides: "fold" });

  // 9テーマでの--fold-guide-hoverの実測: (a)--paperに対するコントラスト比、
  // (b)通常時の線--ruleとの差(色差・コントラスト比)。テーマごとに個別の色を選定した
  // ため、9テーマそれぞれのCSS変数を実際に解決してから測る(決め打ちの値は使わない)。
  const summaryRows = [];
  for (const th of THEMES) {
    await applySettings(page, { theme: th.theme, lightTheme: th.lightTheme, darkTheme: th.darkTheme });
    const hoverRGB = await probeVar(page, "--fold-guide-hover");
    const paperRGB = await probeVar(page, "--paper");
    const ruleRGB = await probeVar(page, "--rule");
    const toStr = (c) => (c ? `rgb(${c.r}, ${c.g}, ${c.b})` : null);
    const hoverStr = toStr(hoverRGB), paperStr = toStr(paperRGB), ruleStr = toStr(ruleRGB);
    const ratioVsPaper = hoverStr && paperStr ? contrastRatio(hoverStr, paperStr) : null;
    const ratioVsRule = hoverStr && ruleStr ? contrastRatio(hoverStr, ruleStr) : null;
    const distVsRule = hoverRGB && ruleRGB ? colorDist(hoverRGB, ruleRGB) : null;
    summaryRows.push({ label: th.label, hover: hoverStr, paper: paperStr, rule: ruleStr, ratioVsPaper, ratioVsRule, distVsRule });
    ok(`(DD) ${th.label}: --fold-guide-hover(${hoverStr})の--paper(${paperStr})に対するコントラスト比が3.0以上(実測=${ratioVsPaper?.toFixed(2)})`, !!ratioVsPaper && ratioVsPaper >= 3.0);
    ok(`(DD) ${th.label}: --fold-guide-hover(${hoverStr})の--paper(${paperStr})に対するコントラスト比が4.5以上(目標達成。実測=${ratioVsPaper?.toFixed(2)})`, !!ratioVsPaper && ratioVsPaper >= 4.5);
    ok(`(DD) ${th.label}: --fold-guide-hover(${hoverStr})が通常時の線--rule(${ruleStr})とはっきり異なる(色差=${distVsRule?.toFixed(1)}, コントラスト比=${ratioVsRule?.toFixed(2)})`,
      !!distVsRule && distVsRule >= 60 && !!ratioVsRule && ratioVsRule >= 1.5);
  }
  console.log("  [実測表] 9テーマの--fold-guide-hover実測一覧:");
  console.log("  " + ["テーマ", "hover", "paper", "rule", "vs paper", "vs rule(比)", "vs rule(色差)"].join(" | "));
  for (const r of summaryRows) {
    console.log("  " + [r.label, r.hover, r.paper, r.rule, r.ratioVsPaper?.toFixed(2), r.ratioVsRule?.toFixed(2), r.distVsRule?.toFixed(1)].join(" | "));
  }
  await applySettings(page, { theme: "light", lightTheme: "default", darkTheme: "default" });

  ok("(DD) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// =========================================================================
// (EE) 依頼⑤の性能実測: 1万行の文書でホバーしても処理が引っかからないこと
// (decoration setを再構築せず、DOMのクラス付け外しだけで完結する設計であることの実測)。
// =========================================================================
{
  const { page, errors } = await newPage();
  const genDoc = (n) => {
    const parts = ["function root() {\n"];
    let i = 0;
    while (i < n - 20) { parts.push(`  if (cond${i}) {\n    doThing(${i});\n  }\n`); i += 3; }
    parts.push("}\n");
    return parts.join("");
  };
  await openFile(page, "big.js", genDoc(10000));
  await page.waitForTimeout(1000);

  const box = await page.evaluate(() => {
    const marker = document.querySelector(".cm-fold-marker2");
    if (!marker) return null;
    const r = marker.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok("(EE) 1万行文書でも折りたたみマーカーが表示される", !!box);

  if (box) {
    // mouseenter/mouseleaveハンドラ自体(querySelectorAll+クラス付け外し)の実行時間を
    // 直接計測する(Playwrightのマウス移動イベント自体のディスパッチ・IPCコストを含まない、
    // 純粋なJS実行時間)。decoration setを再構築する設計であれば、1万行の文書では
    // 数ミリ秒〜数十ミリ秒のオーダーになるはずだが、DOMクラスの付け外しだけなら
    // 1ms未満で終わるはず。
    const handlerTimes = await page.evaluate(() => {
      const marker = document.querySelector(".cm-fold-marker2");
      const results = [];
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        marker.dispatchEvent(new MouseEvent("mouseenter"));
        const t1 = performance.now();
        marker.dispatchEvent(new MouseEvent("mouseleave"));
        const t2 = performance.now();
        results.push({ enter: t1 - t0, leave: t2 - t1 });
      }
      return results;
    });
    const enterTimes = handlerTimes.map((r) => r.enter).sort((a, b) => a - b);
    const maxEnter = enterTimes[enterTimes.length - 1];
    const medianEnter = enterTimes[Math.floor(enterTimes.length / 2)];
    console.log(`  [実測] 1万行文書でのmouseenterハンドラ実行時間(ms): 中央値=${medianEnter.toFixed(3)}, 最大=${maxEnter.toFixed(3)}`);
    ok(`(EE) 1万行文書でもホバーのハンドラ実行時間が16ms以内(中央値=${medianEnter.toFixed(3)}ms, 最大=${maxEnter.toFixed(3)}ms)`, maxEnter < 16);
  }

  ok("(EE) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
