// Pane.ico(アプリ/ファイル関連付け用アイコン)を生成する。
//
// src/icon.svg(角丸正方形+パステルのカラーブロック+白いP)をPlaywright(Chromium)で
// 各サイズにラスタライズし、PNGとしてそのままICOに埋め込む(Vista以降が対応する形式)。
// 生成物はリポジトリにコミットするため、通常のビルド(scripts/build.js)からは呼ばない。
//
// 実行: node scripts/make-icon.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pw from "/opt/node22/lib/node_modules/playwright/index.js";

const { chromium } = pw;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Windowsのエクスプローラーが実際に使う主要サイズ。
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function rasterizeAll(svgPath, sizes) {
  const svg = readFileSync(svgPath, "utf8");
  const browser = await chromium.launch();
  const results = [];
  for (const size of sizes) {
    const page = await browser.newPage();
    await page.setViewportSize({ width: size, height: size });
    // SVGをビューポートいっぱいに表示するだけのページ。角丸の外側は透明にするため
    // body/html の背景は指定しない(デフォルト透明)。
    await page.setContent(
      `<html><body style="margin:0;padding:0;">${svg}</body></html>`
    );
    // viewBox 0 0 100 100 のsvgをsize x sizeいっぱいに広げる。
    await page.evaluate((s) => {
      const el = document.querySelector("svg");
      el.setAttribute("width", String(s));
      el.setAttribute("height", String(s));
      el.style.display = "block";
    }, size);
    const png = await page.screenshot({ omitBackground: true });
    results.push({ size, png });
    await page.close();
  }
  await browser.close();
  return results;
}

/**
 * ICOバイナリを組み立てる。全サイズをPNG圧縮のまま埋め込む形式
 * (ICONDIRENTRYのbBitCount=32等を指定しつつ、実データはPNGバイト列)。
 * Windows Vista以降はICO内のPNG埋め込みに対応している。
 */
function buildIco(images) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = 1 (icon)
  dir.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    // 256は1バイトに収まらないため、仕様どおり0を書く。
    const dim = img.size >= 256 ? 0 : img.size;
    e.writeUInt8(dim, 0); // bWidth
    e.writeUInt8(dim, 1); // bHeight
    e.writeUInt8(0, 2); // bColorCount
    e.writeUInt8(0, 3); // bReserved
    e.writeUInt16LE(1, 4); // wPlanes
    e.writeUInt16LE(32, 6); // wBitCount
    e.writeUInt32LE(img.data.length, 8); // dwBytesInRes
    e.writeUInt32LE(offset, 12); // dwImageOffset
    entries.push(e);
    offset += img.data.length;
  }

  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}

const svgPath = join(ROOT, "src", "icon.svg");
const rendered = await rasterizeAll(svgPath, SIZES);
const images = rendered.map((r) => ({ size: r.size, data: r.png }));

const ico = buildIco(images);
const out = join(ROOT, "Pane", "Assets", "Pane.ico");
writeFileSync(out, ico);
console.log(`${out} を生成しました (${images.length}サイズ, ${ico.length} bytes)`);
for (const i of images) console.log(`  ${i.size}x${i.size}  ${i.data.length} bytes`);
