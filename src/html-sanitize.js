// Markdown中に書かれた生HTML(仕様書 第2.9節 M-27〜M-31)を安全に描画するためのサニタイザ。
//
// 方針: 必ず「ホワイトリスト方式」(許可したものだけ通す)で実装する。
// ブラックリスト方式(危険なものだけを列挙して弾く)は新しい攻撃パターンに対して
// 必ず漏れが出るため、このファイルでは一切使わない。
//
// 実装方式: 信頼できないHTML文字列は絶対に innerHTML へ直接流し込まない。
// DOMParser で文書から切り離された(スクリプト実行や画像取得の起きない)DOMツリーに
// 一度変換し、そのツリーを再帰的に辿りながら「許可したタグ・属性・CSSプロパティだけ」を
// 新しいDOM要素として組み立て直す。組み立てたDocumentFragmentをそのままDOMへ追加すれば、
// 呼び出し側は一度も innerHTML に生文字列を渡す必要がない(渡さないことを徹底する)。
//
// DOMParser を使う理由: 属性値の中の HTML実体参照(`&#115;` 等によるプロトコル偽装)は
// DOMParser が構文解析する時点で自動的にデコードされるため、getAttribute() で取得した
// 時点では既にデコード済みの文字列として扱える。正規表現で生文字列を検査するよりも
// 偽装を見落としにくい。

// ---- 許可するタグ(仕様書 M-31: 許可タグのホワイトリスト方式) ----
const ALLOWED_TAGS = new Set([
  "u", "b", "strong", "i", "em", "s", "del", "ins", "mark", "sub", "sup", "small",
  "kbd", "code", "samp", "var", "abbr", "cite", "q", "br", "wbr", "span", "div", "p",
  "a", "img", "video", "audio", "source", "iframe",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "figure", "figcaption", "details", "summary", "time", "ruby", "rt", "rp",
]);

// ---- 明確に禁止するタグ(タグごと中身も含めて丸ごと除去する) ----
// ホワイトリストに無いタグは「タグだけ剥がして中身は残す」のが既定動作だが、
// これらは中身ごと消さないと(例: <script>のテキストノードだけ残す等)意味がないため区別する。
const FULLY_REMOVED_TAGS = new Set([
  "script", "style", "link", "meta", "base", "object", "embed", "applet",
  "form", "input", "button", "select", "textarea", "option", "noscript", "template", "slot",
]);

// ---- 許可する属性(タグ共通のホワイトリスト。個別の値検証は別途行う) ----
// "style" は仕様書 第2.9節の属性列挙そのものには含まれていないが、M-28で
// 「インラインスタイルを限定的に許可する」ことが明示的に要求されているため、
// ここに追加する(下のsanitizeStyle()でプロパティ名・値をさらに厳格に検証する)。
const ALLOWED_ATTRS = new Set([
  "class", "id", "title", "alt", "href", "src", "srcset", "width", "height",
  "colspan", "rowspan", "span", "start", "reversed", "type", "datetime", "open",
  "controls", "loop", "muted", "poster", "preload", "playsinline",
  "sandbox", "allow", "allowfullscreen", "referrerpolicy", "loading",
  "dir", "lang", "align", "valign", "style",
]);

// ---- 許可するCSSプロパティ(仕様書 M-28: styleは限定的に許可) ----
const ALLOWED_STYLE_PROPS = new Set([
  "color", "background-color", "background", "font-size", "font-weight", "font-style",
  "font-family", "text-decoration", "text-align", "vertical-align", "width", "height",
  "max-width", "max-height", "margin", "padding", "border", "border-radius", "opacity",
  "display", "float", "line-height", "letter-spacing",
]);

// style値に含まれてはならないパターン。
// - expression(...) : 古いIEのCSS式(任意JS実行)
// - javascript:      : URL文脈でのスクリプト実行
// - url(...)         : 外部リソースの読み込みそのものであり、追跡・不正なリソース取得に
//                       悪用できるため、正当な用途(background画像等)も含めて一律禁止する
//                       (仕様書の指示どおり)。
const STYLE_DANGEROUS_RE = /expression\s*\(|javascript\s*:|url\s*\(/i;

// 再帰の深さの上限。悪意/事故による極端なネストでスタックオーバーフローや
// フリーズを起こさないための安全弁(仕様の必須要件ではないが、信頼できない入力を
// 扱う以上は付けておくべき最低限の防御)。
const MAX_DEPTH = 200;

// ---- パース前の安全弁(MAX_DEPTHの手前で効かせる) ----
// appendSanitized()の再帰上限(MAX_DEPTH)はDOMツリーが出来上がった後にしか働かない。
// しかしボトルネックは DOMParser.parseFromString() 自体(Chromiumは深いネストに対して
// ほぼ二次関数的なコストを持つ)であり、パースに入った時点で手遅れになる。そのため
// パースする「前」に文字列だけを見て危険性を見積もり、危険なら丸ごとプレーンテキスト
// 扱いに倒す(HTMLとして解釈しない)。
//
// MAX_HTML_INPUT_LENGTH: 2MB。Markdown文書中の生HTML1ブロック分としては通常あり得ない
// 大きさで、かつ「2MB」は文字数ベースの上限として調査時に指示された目安値をそのまま採用した。
// 通常のコピー&ペースト(Webページ1枚分のHTML等)はこれを大きく下回るため、正常系には影響しない。
const MAX_HTML_INPUT_LENGTH = 2 * 1024 * 1024;
// MAX_HTML_NEST_DEPTH: 500。appendSanitized()側のMAX_DEPTH(200)より十分大きい値にして、
// 「後段のMAX_DEPTHで安全に切り詰められる程度の深さ」までは通し、それを超える異常な
// ネスト(数万段規模の攻撃/事故入力)だけをパース前に弾く。実測(調査時)では数千段を
// 超えるネストは通常の文書には現れず、Chromiumのパース時間もこのあたりから急激に
// 悪化し始めるため、余裕を持たせつつ実害の出る手前で止める値として選んだ。
const MAX_HTML_NEST_DEPTH = 500;

// 開始/終了タグらしき箇所だけを正規表現で拾い、実際にDOMを構築せずにネストの深さを見積もる。
// 属性値の中身などは解釈しない(パースではなく「見積り」でよい。危険な入力を弾ければ十分)。
const TAG_BOUNDARY_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
function estimateMaxNestDepth(html) {
  let depth = 0;
  let max = 0;
  TAG_BOUNDARY_RE.lastIndex = 0;
  let m;
  while ((m = TAG_BOUNDARY_RE.exec(html))) {
    const whole = m[0];
    if (whole[1] === "/") {
      if (depth > 0) depth--;
    } else if (whole[whole.length - 2] !== "/") { // "<br/>" のような自己終了タグは深さを増やさない
      depth++;
      if (depth > max) max = depth;
    }
  }
  return max;
}

// 入力文字列がパースするには危険(長すぎる/ネストが深すぎる)かどうかを判定する。
// html-to-markdown.js(貼り付け経路)からも同じ基準を使う。
export function isHtmlInputTooDangerous(html) {
  const s = String(html ?? "");
  if (s.length > MAX_HTML_INPUT_LENGTH) return true;
  if (estimateMaxNestDepth(s) > MAX_HTML_NEST_DEPTH) return true;
  return false;
}

// URL文字列の正規化(仕様書の指示: 前後の空白・制御文字・大文字小文字による偽装を通さない)。
// タブ・改行・復帰は「URL中のどこにあっても無視される」というWHATWG URL仕様の挙動に合わせて
// 位置を問わず除去し、先頭・末尾の空白/制御文字も除去してから小文字化して比較する。
function normalizeUrl(raw) {
  let s = String(raw);
  s = s.replace(/[\t\n\r]/g, "");
  s = s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  return s.toLowerCase();
}

// href/src系のURLが安全か判定する。javascript:/vbscript: は常に禁止。
// data: は仕様書の指示どおり "data:image/" だけ例外的に許可する(img/video posterなど)。
// md-to-html.js(Markdown記法のリンク・画像)とeditor.js(リンククリック時の遷移)からも
// 同じ基準を使う(生HTMLだけ保護対象という一貫性の欠落を防ぐため、ここで export する)。
export function isSafeUrl(raw, { allowDataImage = false } = {}) {
  if (raw == null) return false;
  const n = normalizeUrl(raw);
  if (n.startsWith("javascript:") || n.startsWith("vbscript:")) return false;
  if (n.startsWith("data:")) return allowDataImage && n.startsWith("data:image/");
  return true;
}

// video/audio/sourceの src が「ローカルファイル参照のみ」(仕様書 M-30)かどうか。
// http:/https:、および常にその時点のプロトコルで解決される "//host/..." 形式
// (プロトコル相対URL、実質的にhttp/https)を外部URLとして禁止する。
// file: および相対パス(スキーム無し。"./a.mp4" "images/a.mp4" 等)は許可する。
function isRemoteMediaUrl(raw) {
  const n = normalizeUrl(raw);
  return n.startsWith("http://") || n.startsWith("https://") || n.startsWith("//");
}

// style属性値をプロパティ単位で検証し、安全なものだけを残す。
// プロパティ名・値の両方をホワイトリストで検証すること(仕様書の指示)。
function sanitizeStyle(styleValue) {
  const kept = [];
  for (const decl of styleValue.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!prop || !val) continue;
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue; // プロパティ名のホワイトリスト
    if (STYLE_DANGEROUS_RE.test(val)) continue; // expression()/javascript:/url() を含む値は除去
    if (/[<>"'`]/.test(val)) continue; // HTML構文的な文字が混じる異常値は除去(念のため)
    kept.push(`${prop}: ${val}`);
  }
  return kept.join("; ");
}

// srcset="url1 1x, url2 2x" 形式。各エントリのURL部分だけを個別に安全性検証する。
function sanitizeSrcset(value) {
  const kept = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(" ");
    const url = sp < 0 ? trimmed : trimmed.slice(0, sp);
    const descriptor = sp < 0 ? "" : trimmed.slice(sp);
    if (isSafeUrl(url, { allowDataImage: true })) kept.push(url + descriptor);
  }
  return kept.length ? kept.join(", ") : null;
}

// iframeのsandbox属性(仕様書 M-29)。
// 元のHTMLに書かれたsandbox値は絶対に信用せず、常にこちらの値で上書きする。
//
// 値の判断: sandbox="" (全制限)を採用する。allow-scripts と allow-same-origin を
// 同時に付与すると、サンドボックス化されたiframe内のスクリプトが親フレームのDOMに
// アクセスして自分自身のsandbox属性を書き換え、実質的にサンドボックスを解除できてしまう
// (ブラウザのサンドボックス実装でよく知られている抜け道)。信頼できない埋め込み先を
// 前提とする以上、この2つを同時に許可するのは避ける。allow-scriptsだけ/
// allow-same-originだけを付与する案も検討したが、前者だけでは任意サイトのスクリプトを
// そのまま実行させてしまい、後者だけでは動画埋め込み等が動かない点は変わらないため
// 利点が薄い。よって「動画埋め込みが動かない」場合はユーザーがvideoタグ
// (M-30、ローカルファイルのみ許可)を使う運用とし、iframeは閲覧用途(常に全制限)と
// 割り切る。allow-top-navigationとallow-modalsは指示どおり付与しない。
function applyIframeSandbox(el) {
  el.setAttribute("sandbox", "");
}

// 属性のコピー(共通のホワイトリスト検証 + 属性ごとの追加検証)。
function sanitizeAttributes(tag, srcEl, destEl) {
  for (const attr of Array.from(srcEl.attributes)) {
    const name = attr.name.toLowerCase();
    // onclick等のイベントハンドラ属性は問答無用ですべて除去する(最優先のセキュリティ要件)。
    if (name.startsWith("on")) continue;
    // sandboxはiframeについて必ずこちら側で上書きするため、元の値はここでは一切コピーしない。
    if (name === "sandbox") continue;
    if (!ALLOWED_ATTRS.has(name)) continue;
    let value = attr.value;
    if (name === "href" || name === "src" || name === "poster") {
      // data:image/ の例外はimg/posterに限らずhref/src全般に適用する(仕様書の記述どおり)。
      if (!isSafeUrl(value, { allowDataImage: true })) continue;
    } else if (name === "srcset") {
      const cleaned = sanitizeSrcset(value);
      if (cleaned == null) continue;
      value = cleaned;
    } else if (name === "style") {
      const cleaned = sanitizeStyle(value);
      if (!cleaned) continue; // 安全なプロパティが1つも残らなければ属性自体を落とす
      value = cleaned;
    }
    destEl.setAttribute(name, value);
  }
  if (tag === "iframe") applyIframeSandbox(destEl);
  if (tag === "a" && destEl.hasAttribute("href")) {
    // 埋め込みHTML内の<a>をクリックするとWebView2のトップレベルナビゲーションが
    // アプリ画面ごと差し替わってしまう恐れがあるため、常に新規タブ相当(noopener)にする。
    // target/relはALLOWED_ATTRSに含めていない(元のHTMLの値は使わない)ため、ここで
    //明示的に安全な値を設定する。
    destEl.setAttribute("target", "_blank");
    destEl.setAttribute("rel", "noopener noreferrer");
  }
}

// video/audio/sourceの src が外部URLの場合、要素ごと除去して短い注記テキストに置き換える
// (仕様書 M-30: ローカルファイル参照のみ)。属性が安全でない場合(javascript:等)も同様に扱う。
function isDisallowedMediaSrc(rawSrc) {
  return !isSafeUrl(rawSrc, { allowDataImage: true }) || isRemoteMediaUrl(rawSrc);
}

// ノード1つを検証し、許可されていれば destParent の子として追加する(再帰)。
function appendSanitized(node, destParent, destDocument, depth) {
  if (depth > MAX_DEPTH) return; // 異常なネストからの防御(§実装メモ参照)
  if (node.nodeType === Node.TEXT_NODE) {
    destParent.appendChild(destDocument.createTextNode(node.textContent));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return; // コメント等は出力しない

  const tag = node.tagName.toLowerCase();

  if (FULLY_REMOVED_TAGS.has(tag)) return; // タグごと中身も除去(script/style等)

  if (!ALLOWED_TAGS.has(tag)) {
    // ホワイトリスト外のタグ: タグを剥がしてテキスト(子ノード)だけ残す(M-31)
    for (const child of Array.from(node.childNodes)) appendSanitized(child, destParent, destDocument, depth + 1);
    return;
  }

  if (tag === "video" || tag === "audio" || tag === "source") {
    const rawSrc = node.getAttribute("src");
    if (rawSrc != null && isDisallowedMediaSrc(rawSrc)) {
      destParent.appendChild(destDocument.createTextNode("[外部URLの動画は表示しません]"));
      return; // 子要素(<source>等)にも降りない
    }
  }

  const el = destDocument.createElement(tag);
  sanitizeAttributes(tag, node, el);
  for (const child of Array.from(node.childNodes)) appendSanitized(child, el, destDocument, depth + 1);
  destParent.appendChild(el);
}

// 信頼できないHTML文字列を安全なDocumentFragmentに変換して返す。
// options.doc: 生成先のDocument(既定はグローバルのdocument。テスト等での差し替え用)。
export function sanitizeHtml(html, options = {}) {
  const destDocument = options.doc || document;
  const raw = String(html ?? "");
  // DOMParser.parseFromString() 自体が深いネストに対してほぼ二次関数的なコストを持つため、
  // パースに入る前に危険性を見積もり、危険であればパースせずプレーンテキストとして扱う
  // (黙って消すのではなく、原文をそのままテキストとして表示することで内容は失わない)。
  if (isHtmlInputTooDangerous(raw)) {
    console.log(`Pane: 生HTMLが長すぎる/ネストが深すぎるためパースを打ち切り、プレーンテキストとして表示しました(文字数=${raw.length})`);
    const frag = destDocument.createDocumentFragment();
    frag.appendChild(destDocument.createTextNode(raw));
    return frag;
  }
  // DOMParserで解析するだけの段階ではスクリプトは実行されず、画像・iframe等の
  // リソースも取得されない(生成された文書はどこにもアタッチされていないため)。
  // ここで得たツリーの要素・属性をそのまま使わず、許可したものだけを再構築する。
  const parsed = new DOMParser().parseFromString(raw, "text/html");
  const frag = destDocument.createDocumentFragment();
  for (const child of Array.from(parsed.body.childNodes)) {
    appendSanitized(child, frag, destDocument, 0);
  }
  return frag;
}

// テスト・診断用に許可リストを公開する(実行時の判定ロジックは上記の関数群が担う)。
export const _internal = { ALLOWED_TAGS, FULLY_REMOVED_TAGS, ALLOWED_ATTRS, ALLOWED_STYLE_PROPS };
