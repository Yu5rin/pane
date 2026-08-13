// MathJaxによる数式描画(仕様書 第5章・第2.9.1節)。
// 数式を含む文書を開いたときにだけ動的importする。mhchem・AMSmath拡張を有効化する。
// 数式の自動採番(C-04)はTeX入力プロセッサの構築時オプションのため、
// ON/OFFそれぞれのレンダラーを個別にキャッシュする。
const renderers = new Map(); // autoNumber(bool) -> Promise<{ adaptor, doc }>

// mathjax-fullはCommonJSパッケージのため、動的import時にesbuildが名前付きexportを
// 合成できない場合がある(その場合 default にCJSのexportsオブジェクトが入る)。
// 両方のケースに対応できるよう、defaultへのフォールバックを挟んで取り出す。
function pick(mod, name) {
  return mod[name] ?? mod.default?.[name];
}

function createRenderer(autoNumber) {
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
    ]);
    const adaptor = browserAdaptor();
    RegisterHTMLHandler(adaptor);
    const tex = new TeX({ packages: ["base", "ams", "mhchem"], tags: autoNumber ? "ams" : "none" });
    const svg = new SVG({ fontCache: "none" });
    const doc = mathjax.document("", { InputJax: tex, OutputJax: svg });
    return { adaptor, doc };
  })();
}

function getRenderer(autoNumber) {
  const key = !!autoNumber;
  if (!renderers.has(key)) renderers.set(key, createRenderer(key));
  return renderers.get(key);
}

// texをSVG(文字列)に変換する。失敗時はエラーメッセージ付きで返す(表示側でフォールバックする)。
export async function renderMathToHtml(tex, { display = false, autoNumber = false } = {}) {
  try {
    const { adaptor, doc } = await getRenderer(autoNumber);
    const node = doc.convert(tex, { display });
    return { html: adaptor.outerHTML(node), error: false };
  } catch (e) {
    return { html: null, error: true, message: e?.message || String(e) };
  }
}
