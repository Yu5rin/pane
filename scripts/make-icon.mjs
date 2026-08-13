// Pane.ico(アプリ/ファイル関連付け用アイコン)を生成する。
//
// 従来の Pane/Assets/Pane.ico は 32x32 の1サイズしか持っておらず、エクスプローラーが
// 16px(詳細表示・一覧表示)や 48px/256px(大アイコン表示)を要求したときに適切な
// 画像が無く、拡大縮小でぼやける・環境によっては既定アイコンのまま表示される原因になっていた。
// Windowsが要求する主要サイズをすべて含む .ico を作り直す。
//
// 実行: node scripts/make-icon.mjs
// Chromium(Playwright同梱)のCanvasでラスタライズし、ICOのバイナリはこのスクリプトで組み立てる。
// 生成物はリポジトリにコミットするため、通常のビルド(scripts/build.js)からは呼ばない。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pw from "/opt/node22/lib/node_modules/playwright/index.js";

const { chromium } = pw;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// エクスプローラーが実際に使うサイズ。256はPNG圧縮で埋め込む(Vista以降の仕様)。
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// 24x24のデザイン座標系で描く。src/icon.svg と同じ「枠+十字(ペイン)」のマーク。
// 元のSVGは細い線画のみで、16pxではほとんど視認できず、暗い背景では埋もれてしまうため、
// 塗りつぶした角丸square + 白い十字という、小サイズでも判別できる形にしている。
const BRAND = "#2F6F68";

async function rasterize(page, size) {
  return await page.evaluate((s) => {
    const canvas = document.createElement("canvas");
    canvas.width = s;
    canvas.height = s;
    const g = canvas.getContext("2d");
    const k = s / 24; // デザイン座標(24x24)から実ピクセルへの倍率

    // 角丸の四角(本体)
    const pad = 1 * k;
    const r = 5 * k;
    const x0 = pad, y0 = pad, x1 = s - pad, y1 = s - pad;
    g.beginPath();
    g.moveTo(x0 + r, y0);
    g.lineTo(x1 - r, y0);
    g.quadraticCurveTo(x1, y0, x1, y0 + r);
    g.lineTo(x1, y1 - r);
    g.quadraticCurveTo(x1, y1, x1 - r, y1);
    g.lineTo(x0 + r, y1);
    g.quadraticCurveTo(x0, y1, x0, y1 - r);
    g.lineTo(x0, y0 + r);
    g.quadraticCurveTo(x0, y0, x0 + r, y0);
    g.closePath();
    g.fillStyle = "#2F6F68";
    g.fill();

    // 白い十字(ペイン=窓枠の分割)。小サイズでも線が消えないよう最低1pxを保証する。
    g.strokeStyle = "#FFFFFF";
    g.lineWidth = Math.max(1, 1.9 * k);
    g.lineCap = "butt";
    const mid = s / 2;
    g.beginPath();
    g.moveTo(mid, y0);
    g.lineTo(mid, y1);
    g.moveTo(x0, mid);
    g.lineTo(x1, mid);
    g.stroke();

    return {
      rgba: Array.from(g.getImageData(0, 0, s, s).data),
      png: canvas.toDataURL("image/png").split(",")[1],
    };
  }, size);
}

/** 32bpp BGRA のDIB(BITMAPINFOHEADER + XORデータ + ANDマスク)を作る。 */
function toDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight(XOR + ANDマスクぶんで2倍にするのがICOの決まり)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  // XORデータ: 下から上へ、BGRAの順
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }

  // ANDマスク: 1bpp、各行を4バイト境界に揃える。アルファ付き32bppでは実質使われないが、
  // 構造として必須なので全ビット0(=不透明)で埋める。
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size, 0);

  return Buffer.concat([header, xor, mask]);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");

const images = [];
for (const size of SIZES) {
  const { rgba, png } = await rasterize(page, size);
  // 256pxはPNG圧縮で埋め込む(非圧縮DIBだと256KB超になるため)。それ以外はDIB。
  const data = size >= 256 ? Buffer.from(png, "base64") : toDib(rgba, size);
  images.push({ size, data });
}
await browser.close();

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type = 1 (icon)
dir.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = [];
for (const img of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // 256は0で表す
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
  e.writeUInt8(0, 2); // colorCount
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bitCount
  e.writeUInt32LE(img.data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += img.data.length;
}

const ico = Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
const out = join(ROOT, "Pane", "Assets", "Pane.ico");
writeFileSync(out, ico);
console.log(`${out} を生成しました (${images.length}サイズ, ${ico.length} bytes)`);
for (const i of images) console.log(`  ${i.size}x${i.size}  ${i.data.length} bytes`);
