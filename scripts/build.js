// distを生成する唯一の経路。
// index.html・style.css・icon.svgをdistへコピーし、main.jsをesbuildでバンドルする
// (splitting有効)。CodeMirror等の依存はすべてここでdistに同梱するため、
// 実行時に外部CDNへは一切到達しない。開発サーバーもこのdistを配信する。
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const serve = process.argv.includes("--serve");
const watch = process.argv.includes("--watch") || serve;

const staticFiles = ["index.html", "style.css", "icon.svg"];

function copyStaticFiles() {
  fs.mkdirSync("dist", { recursive: true });
  for (const f of staticFiles) {
    fs.copyFileSync(path.join("src", f), path.join("dist", f));
  }
}

// mathjax-full の components/version.js は、バンドル時に PACKAGE_VERSION が定義されて
// いないと eval("require") 経由でNode専用コード(package.jsonの動的読み込み)を実行しよう
// とし、ブラウザ上で "require is not defined" を投げる。MathJax公式のwebpack設定と同様に、
// ビルド時定数として注入して回避する(mathjax-full自身のドキュメントに明記された対処法)。
const mathjaxVersion = require("mathjax-full/package.json").version;

const buildOptions = {
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "dist",
  define: { PACKAGE_VERSION: JSON.stringify(mathjaxVersion) },
};

async function run() {
  copyStaticFiles();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    for (const f of staticFiles) {
      fs.watchFile(path.join("src", f), () => copyStaticFiles());
    }
    if (serve) {
      const { host, port } = await ctx.serve({ servedir: "dist", port: 8000 });
      console.log(`Pane dev server: http://${host}:${port}`);
    } else {
      console.log("watching for changes...");
    }
  } else {
    await esbuild.build(buildOptions);
  }
}

run();
