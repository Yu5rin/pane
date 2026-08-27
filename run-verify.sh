#!/bin/sh
# 開発用: .verify-*.mjs を全数まとめて実行し、OK/NG件数を集計するスクリプト。
# 製品コードではない(回帰確認で「一部しか回さない」という取りこぼしを防ぐためのもの)。
#
# 使い方: sh run-verify.sh
#   - 必要な静的サーバ(dist/を配信するだけの使い捨てHTTPサーバ)を自前で起動する
#   - .verify-*.mjs を ls で全数列挙し、1本ずつ実行する(1本あたり200秒でタイムアウト)
#   - 各スイートの出力にある "OK  " / "NG  " 行を数えてOK/NG件数を出す
#     (異常終了・タイムアウトはNG 1件として計上する)
#   - 最後に全体の合計と、1件でもNGを含む(または異常終了した)スイート名の一覧を出す
set -u
cd "$(dirname "$0")" || exit 1

# nodeは実行中のものをそのまま使う(CIでも開発環境でも同じ手順で動くように、
# 特定の場所へ入れたnodeを決め打ちにしない)。
NODE=${NODE:-node}
TIMEOUT_SEC=${TIMEOUT_SEC:-200}

# ブラウザの置き場。この開発環境には用意済みのものがあるが、無い環境
# (CIなど)ではplaywrightの既定の場所に入るため、あるときだけ指定する。
if [ -d /opt/pw-browsers ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
fi

# .verify-*.mjs が使っているポート全部(ソースから機械的に収集)。決め打ちの一覧に
# 頼らず、実際に使われているポートを毎回拾い直す(スイート追加時の取りこぼし防止)。
# 2通りの書き方がある: `localhost:8130/`のような直書きと、`const PORT = 8160;`の
# ように変数化してテンプレートリテラルで組み立てる書き方の両方を拾う。
PORTS=$(
  {
    grep -ohE ':[0-9]{4,5}/' .verify-*.mjs 2>/dev/null | tr -d ':/'
    grep -ohE 'PORT[[:space:]]*=[[:space:]]*[0-9]{4,5}' .verify-*.mjs 2>/dev/null | grep -oE '[0-9]{4,5}$'
  } | sort -n -u | tr '\n' ' '
)
if [ -z "$PORTS" ]; then
  echo "エラー: .verify-*.mjsからポート番号を1つも検出できませんでした" >&2
  exit 1
fi

echo "=== 静的サーバを起動: $PORTS ==="
for p in $PORTS; do
  (nohup "$NODE" -e "
    const http = require('http'), fs = require('fs'), path = require('path');
    const ROOT = path.join(__dirname, 'dist');
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
    http.createServer((q, s) => {
      const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
      try {
        const d = fs.readFileSync(f);
        const e = path.extname(f);
        s.writeHead(200, { 'Content-Type': TYPES[e] || 'application/octet-stream' });
        s.end(d);
      } catch { s.writeHead(404); s.end('nf'); }
    }).listen($p);
  " > "/tmp/pane-verify-srv-$p.log" 2>&1 &)
done
sleep 1.5

TOTAL_OK=0
TOTAL_NG=0
SUITE_COUNT=0
FAILED_SUITES=""

# 各スイートの生の出力を残す場所。CIで失敗したときに中身を取り出せるよう、
# 外から場所を指定できるようにしてある(指定が無ければ一時フォルダ)。
OUT_DIR=${OUT_DIR:-$(mktemp -d)}
mkdir -p "$OUT_DIR"
trap 'rm -rf "$OUT_DIR"' EXIT

for f in .verify-*.mjs; do
  SUITE_COUNT=$((SUITE_COUNT + 1))
  out_file="$OUT_DIR/$(basename "$f").log"
  start_ts=$(date +%s)
  timeout "$TIMEOUT_SEC" "$NODE" "$f" > "$out_file" 2>&1
  code=$?
  elapsed=$(( $(date +%s) - start_ts ))

  ok=$(grep -cE '^OK([[:space:]]|$)' "$out_file")
  ng=$(grep -cE '^NG([[:space:]]|$)' "$out_file")

  abnormal=0
  reason=""
  if [ "$code" -eq 124 ]; then
    abnormal=1
    reason="タイムアウト(${TIMEOUT_SEC}秒)"
  elif [ "$code" -ne 0 ] && [ "$ng" -eq 0 ]; then
    # NG行を1つも出さずに異常終了した(未処理例外など)場合もNGとして扱う。
    abnormal=1
    reason="異常終了(exit=$code)"
  fi

  if [ "$abnormal" -eq 1 ]; then
    ng=$((ng + 1))
    FAILED_SUITES="$FAILED_SUITES $f"
    status="異常終了: $reason"
  elif [ "$ng" -gt 0 ]; then
    FAILED_SUITES="$FAILED_SUITES $f"
    status="NG${ng}件"
  else
    status="OK"
  fi

  printf '%-34s OK=%-4s NG=%-4s (%3ss, exit=%s) %s\n' "$f" "$ok" "$ng" "$elapsed" "$code" "$status"

  TOTAL_OK=$((TOTAL_OK + ok))
  TOTAL_NG=$((TOTAL_NG + ng))
done

echo
echo "=== 合計: ${SUITE_COUNT}本 / OK=${TOTAL_OK} NG=${TOTAL_NG} ==="
if [ -n "$FAILED_SUITES" ]; then
  echo "--- 失敗したスイート ---"
  for s in $FAILED_SUITES; do
    echo "  - $s"
  done
  exit 1
fi
echo "全スイートNG 0件"
exit 0
