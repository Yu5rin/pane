// Mermaidによる図のライブプレビュー描画(仕様書 第4.2節・第8.3節)。
// math.js(MathJaxのラッパー)と同じ作法: 呼び出し側からは renderMermaid() 一本を叩くだけで、
// mermaid本体のロード・初期化・エラー処理をここに閉じ込める。
//
// mermaid本体は数MBある非常に大きいライブラリのため、mermaid記法を含む文書を開いた
// (= 実際にこの関数が呼ばれた)ときにだけ動的importする。静的importすると初期ロードJSに
// 常時同梱されてしまい、仕様書第8.4節が気にしている初期ロードサイズを悪化させる。
let mermaidModulePromise = null;

function loadMermaidModule() {
  if (!mermaidModulePromise) {
    // トップレベルの"mermaid"をそのままimportする。esbuildのcode splitting(splitting: true)
    // により、これは呼び出されるまでダウンロードされない別チャンクとして分離される。
    mermaidModulePromise = import("mermaid").then((mod) => mod.default ?? mod);
  }
  return mermaidModulePromise;
}

// 直近にinitialize()した際のテーマ(true=dark)。異なるテーマで呼ばれたら再初期化する。
let initializedForDark = null;

function ensureInitialized(mermaid, dark) {
  if (initializedForDark === dark) return;
  mermaid.initialize({
    startOnLoad: false, // DOM全体を勝手に走査させない(このアプリではウィジェットのtoDOM()からしか呼ばない)
    theme: dark ? "dark" : "default",
    securityLevel: "strict", // 生成SVGへのスクリプト混入を許さない(既定値だが明示しておく)
    // trueにしないと、mermaid.render()はパースエラー時に自前の「エラー用ダイアグラム」を
    // 代わりに描画しようとする。この副経路がこのアプリの構成(esbuildによるコード分割)だと
    // 例外を起こし、window.onerrorにまで漏れて「アプリを壊さない」という要件に反する。
    // trueにすることで元のパースエラーがそのままthrowされ、下のcatchで確実に拾える。
    suppressErrorRendering: true,
  });
  initializedForDark = dark;
}

// mermaid.render()に渡す一意なID。呼び出しのたびに増える連番で十分(この関数はモジュール内で
// 単一のカウンタを持つ)。
let renderSeq = 0;

// Mermaid記法のコードをSVG(文字列)に変換する。失敗時はエラーメッセージ付きで返す
// (呼び出し側=MermaidWidgetでエラー表示にフォールバックする。math.jsのrenderMathToHtmlと
// 同じ戻り値の流儀: { svg, error, message })。
export async function renderMermaid(code, { dark = false } = {}) {
  // mermaidはパース失敗時などに、計測用の一時的なDOM要素をdocument.body直下へ挿入したまま
  // 残してしまうことがある。呼び出し前後のbody直下の子要素を比較し、増えた分は必ず取り除く。
  const before = new Set(document.body.children);
  try {
    const mermaid = await loadMermaidModule();
    ensureInitialized(mermaid, dark);
    const id = `pane-mermaid-${++renderSeq}`;
    const { svg } = await mermaid.render(id, code);
    return { svg, error: false };
  } catch (e) {
    return { svg: null, error: true, message: e?.message || String(e) };
  } finally {
    for (const el of Array.from(document.body.children)) {
      if (!before.has(el)) el.remove();
    }
  }
}
