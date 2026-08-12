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

const buildOptions = {
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "dist",
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
