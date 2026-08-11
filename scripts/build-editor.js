// esm.sh のCDN指定(https://esm.sh/@codemirror/view@6 等)をbare specifierへ変換し、
// esbuildでnode_modulesからバンドルできるようにする。
const fs = require("fs");

const src = fs.readFileSync("src/editor.js", "utf8");
const out = src.replace(
  /https:\/\/esm\.sh\/((?:@[\w.-]+\/)?[\w.-]+)@[\w.]+/g,
  "$1"
);
fs.writeFileSync("src/editor.src.js", out);
