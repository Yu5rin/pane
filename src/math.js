// MathJaxによる数式描画(仕様書 第5章・第2.9.1節)。
// 数式を含む文書を開いたときにだけ動的importする。mhchem・AMSmath拡張を有効化する。
// 数式の自動採番(仕様書 mathAutoNumber、C-04)は"off"/"ams"/"all"の3値で、そのまま
// MathJaxのTeX入力プロセッサの`tags`オプション("none"/"ams"/"all")に対応する。
// tagsはTeX入力プロセッサの構築時オプションのため、モードごとにレンダラーを個別にキャッシュする。
const renderers = new Map(); // "off"|"ams"|"all" -> Promise<{ adaptor, doc }>

// mathjax-fullはCommonJSパッケージのため、動的import時にesbuildが名前付きexportを
// 合成できない場合がある(その場合 default にCJSのexportsオブジェクトが入る)。
// 両方のケースに対応できるよう、defaultへのフォールバックを挟んで取り出す。
function pick(mod, name) {
  return mod[name] ?? mod.default?.[name];
}

// "off"/"ams"/"all" → MathJax TeX入力プロセッサの tags オプション
function tagsFor(mode) {
  return mode === "ams" || mode === "all" ? mode : "none";
}

function createRenderer(mode) {
  return (async () => {
    const [mathjaxMod, texMod, svgMod, adaptorMod, handlerMod] = await Promise.all([
      import("mathjax-full/js/mathjax.js"),
      import("mathjax-full/js/input/tex.js"),
      import("mathjax-full/js/output/svg.js"),
      import("mathjax-full/js/adaptors/browserAdaptor.js"),
      import("mathjax-full/js/handlers/html.js"),
    ]);
    const mathjax = pick(mathjaxMod, "mathjax");
    const TeX = pick(texMod, "TeX");
    const SVG = pick(svgMod, "SVG");
    const browserAdaptor = pick(adaptorMod, "browserAdaptor");
    const RegisterHTMLHandler = pick(handlerMod, "RegisterHTMLHandler");
    await Promise.all([
      import("mathjax-full/js/input/tex/ams/AmsConfiguration.js"),
      import("mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js"),
      // BBox拡張(仕様書 第2.9.1節「mhchem、AMSmath、BBoxに対応する」)。$$\bbox[yellow]{x}$$ 等の
      // 背景色・枠付き数式に対応する。他の拡張と同じく数式を開いたときだけ動的importされるため、
      // 初期ロード(main.jsの初回バンドル)には影響しない。
      import("mathjax-full/js/input/tex/bbox/BboxConfiguration.js"),
    ]);
    const adaptor = browserAdaptor();
    RegisterHTMLHandler(adaptor);
    const tex = new TeX({ packages: ["base", "ams", "mhchem", "bbox"], tags: tagsFor(mode) });
    const svg = new SVG({ fontCache: "none" });
    const doc = mathjax.document("", { InputJax: tex, OutputJax: svg });
    return { adaptor, doc };
  })();
}

function getRenderer(mode) {
  const key = mode === "ams" || mode === "all" ? mode : "off";
  if (!renderers.has(key)) renderers.set(key, createRenderer(key));
  return renderers.get(key);
}

// texをSVG(文字列)に変換する。失敗時はエラーメッセージ付きで返す(表示側でフォールバックする)。
// autoNumberは"off"|"ams"|"all"(仕様書 mathAutoNumber)。
export async function renderMathToHtml(tex, { display = false, autoNumber = "off" } = {}) {
  try {
    const { adaptor, doc } = await getRenderer(autoNumber);
    const node = doc.convert(tex, { display });
    return { html: adaptor.outerHTML(node), error: false };
  } catch (e) {
    return { html: null, error: true, message: e?.message || String(e) };
  }
}
