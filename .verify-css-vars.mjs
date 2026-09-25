// src/css-vars.js(カスタムCSSの作成補助 仕様書 第2.10.1節 C-16)の読み書きを固定する。
// ブラウザは使わない。esbuildでESMのまま読み込み、純粋な関数だけを試す。
// 守りたいこと: フォームで変えた変数の宣言だけを書き換え、利用者が書いたほかの指定・
// コメントには触れないこと(CSSがただ1つの原本)。
import esbuild from "esbuild";

const code = esbuild.buildSync({ entryPoints: ["src/css-vars.js"], bundle: true, format: "esm", write: false, logLevel: "silent" }).outputFiles[0].text;
const { readVars, setVar, removeVar, findTopLevelRules, minimalChange } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

let ng = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${cond || detail === undefined ? "" : `\n     実際: ${JSON.stringify(detail)}`}`);
  if (!cond) ng++;
};

const base = `/* 先頭のコメント { :root } */
:root {
  --paper: #FBFBFA; /* 背景 */
  --ink: #1F2428;
  --font-body: "Noto Sans JP", system-ui, sans-serif;
}

html[data-theme="dark"] {
  --paper: #14171A;
}

.cm-content strong { color: red; }
`;

// 読む
const light = readVars(base, "light");
ok("ライトの変数を読める", light.get("--paper") === "#FBFBFA" && light.get("--ink") === "#1F2428", [...light]);
ok("カンマや引用符を含む値をそのまま読める", light.get("--font-body") === '"Noto Sans JP", system-ui, sans-serif', light.get("--font-body"));
ok("ダークの変数はダークのブロックだけから読む", readVars(base, "dark").get("--paper") === "#14171A" && !readVars(base, "dark").has("--ink"));
ok("コメントの中の { } をルールと見なさない", findTopLevelRules(base).length === 3, findTopLevelRules(base).map((r) => r.selector));
ok("シングルクォートのダークセレクタも同じものとして読む", readVars(`html[data-theme='dark'] { --ink: #fff; }`, "dark").get("--ink") === "#fff");

// 書く(既存の値を差し替え)
const s1 = setVar(base, "light", "--paper", "#FFFFFF");
ok("既存の値だけを差し替え、行末のコメントは残す", s1.includes("--paper: #FFFFFF; /* 背景 */"), s1);
ok("差し替えはほかの部分を変えない", s1.replace("#FFFFFF", "#FBFBFA") === base);

// 書く(無い変数を足す)
const s2 = setVar(base, "dark", "--accent", "#6FB3A8");
ok("無い変数は該当ブロックの末尾に足す", readVars(s2, "dark").get("--accent") === "#6FB3A8" && readVars(s2, "light").get("--accent") === undefined, s2);
ok("利用者が書いたセレクタの指定は残る", s2.includes(".cm-content strong { color: red; }"));

// ; の無い最後の宣言の後ろに足しても壊れない
const s3 = setVar(":root { --ink: #111 }", "light", "--paper", "#fff");
ok("最後の宣言に ; が無くても壊さずに足す", readVars(s3, "light").get("--ink") === "#111" && readVars(s3, "light").get("--paper") === "#fff", s3);

// ブロックが無ければ作る
const s4 = setVar("", "dark", "--ink", "#E4E7E5");
ok("ブロックが無ければ末尾に作る", s4 === 'html[data-theme="dark"] {\n  --ink: #E4E7E5;\n}\n', s4);
const s4b = setVar(".x { color: red; }\n", "light", "--ink", "#000");
ok("既存のCSSの後ろに空行を挟んで作る", s4b === '.x { color: red; }\n\n:root {\n  --ink: #000;\n}\n', s4b);

// 消す
const s5 = removeVar(base, "light", "--ink");
ok("消すと行ごと無くなる", !s5.includes("--ink") && s5.includes("--paper: #FBFBFA;") && s5.split("\n").length === base.split("\n").length - 1, s5);
ok("空の値を設定すると消す", setVar(base, "light", "--ink", "  ") === s5);
ok("ほかのブロックの同名の変数は消さない", readVars(removeVar(base, "light", "--paper"), "dark").get("--paper") === "#14171A");

// 同名が2回あれば後ろを書き換える(CSSと同じく後ろが効くため)
const dup = ":root {\n  --ink: #111;\n  --ink: #222;\n}\n";
ok("同名が2つあれば後ろの値を読む", readVars(dup, "light").get("--ink") === "#222");
ok("同名が2つあれば後ろの値を書き換える", setVar(dup, "light", "--ink", "#333") === ":root {\n  --ink: #111;\n  --ink: #333;\n}\n");

// @media の中は触らない
const media = "@media print { :root { --ink: #000; } }\n:root { --ink: #111; }\n";
ok("@media の中の :root は読まない", readVars(media, "light").get("--ink") === "#111");

// 最小の差分
const ch = minimalChange("abcXYZdef", "abc12def");
ok("最小の差分を1か所の置き換えで表す", ch && ch.from === 3 && ch.to === 6 && ch.insert === "12", ch);
ok("同じなら差分なし", minimalChange("a", "a") === null);

console.log(`\nNG=${ng}`);
process.exit(ng ? 1 : 0);
