// dist の全ファイルの一覧(dist/dist-files.json)が、実際の dist と一致するかの検証。
// ブラウザは使わない(ファイルを見るだけ)。npm run build の直後に回す前提。
//
// Pane は起動時にこの一覧と突き合わせ、欠けていれば最新版を取って直すかを尋ねる
// (Pane/DistIntegrity.cs・Pane/DistRepairFlow.cs、仕様書 U-09)。一覧がずれていると:
//   ・一覧にあるのに dist に無い → 正常な配布物でも毎回「欠けている」と言い出す
//   ・dist にあるのに一覧に無い → そのファイルが欠けても気づけない
// どちらも利用者の手元では気づきにくいので、ここで固定する。
//
// 経緯: 実機で dist\style.css だけが欠け、画面が崩れたまま何も言わずに動き続けた
// (docs/調査記録/修正-distの欠けを直せるようにする.md)。
import fs from "node:fs";
import path from "node:path";

const DIST = "dist";
const LIST = "dist-files.json";
// Pane/DistIntegrity.cs の RequiredFiles と同じもの(ずれは Pane.Tests が build.js と突き合わせて見る)
const REQUIRED = [
  "index.html", "main.js", "style.css", "themes.css",
  "settings-window.html", "settings-entry.js", "help-window.html", "help-entry.js",
  "css-editor-window.html", "css-editor-entry.js", "css-preview.html", "css-preview-entry.js",
  "icon.svg", "manual.md",
];

let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

const listPath = path.join(DIST, LIST);
ok(`一覧(${LIST})が dist に書き出されている`, fs.existsSync(listPath));
if (!fs.existsSync(listPath)) {
  console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(listPath, "utf8"));
ok(`形の版は1(実際=${data.format})`, data.format === 1);
ok(`files は配列(実際=${Array.isArray(data.files) ? "配列" : typeof data.files})`, Array.isArray(data.files));
const listed = data.files ?? [];

// dist を実際に歩く(区切りは "/" に揃える。一覧もそう書かれる)
const onDisk = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile()) onDisk.push(path.relative(DIST, full).split(path.sep).join("/"));
  }
})(DIST);
const diskSet = new Set(onDisk.filter((f) => f !== LIST));
const listSet = new Set(listed);

const notOnDisk = listed.filter((f) => !diskSet.has(f));
const notListed = [...diskSet].filter((f) => !listSet.has(f));
ok(`一覧にあるものはすべて dist にある(無いもの=${JSON.stringify(notOnDisk.slice(0, 5))})`, notOnDisk.length === 0);
ok(`dist にあるものはすべて一覧に載っている(載っていないもの=${JSON.stringify(notListed.slice(0, 5))})`, notListed.length === 0);
ok(`件数が一致する(一覧=${listed.length}, dist=${diskSet.size})`, listed.length === diskSet.size);
ok("一覧そのものは載せていない", !listSet.has(LIST));
ok(`重複が無い`, listSet.size === listed.length);
ok("名前順に並んでいる(ビルドのたびに差分が出ないように)", JSON.stringify(listed) === JSON.stringify([...listed].sort()));
ok(`区切りは "/" だけで、dist の外を指すものが無い`,
  listed.every((f) => !f.includes("\\") && !f.startsWith("/") && !f.split("/").some((p) => p === "" || p === "." || p === "..")));

const requiredMissing = REQUIRED.filter((f) => !listSet.has(f));
ok(`必須の10ファイルがすべて載っている(欠け=${JSON.stringify(requiredMissing)})`, requiredMissing.length === 0);
// 分割ファイル(名前にハッシュが付くもの)まで載っていること。これが一覧を作った目的。
const hashed = listed.filter((f) => /-[A-Z0-9]{8}\.js$/.test(f));
ok(`名前にハッシュが付く分割ファイルも載っている(${hashed.length}件)`, hashed.length > 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
process.exit(ngCount > 0 ? 1 : 0);
