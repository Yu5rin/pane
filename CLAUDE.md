# Pane — Claude Code向けプロジェクト指針

## 言語

- Claude Codeの応答、コミットメッセージ、PRのタイトル・本文は日本語で書く。
- ソースコード内のコメントも日本語で書く。
- 例外：ライブラリ名・APIシンボル・CLIコマンド名・エラーメッセージの引用など、
  技術的に英語であるべき箇所はそのまま残す。

## 見た目

- 絵文字は使用しない。アイコンと記号はすべてSVG（線幅1.75、16px。第10.1節参照）。
- 配色・タイポグラフィは `docs/仕様書.md` 第10.2節・第10.3節のCSS変数
  （`--paper` `--ink` `--ink-mute` `--rule` `--accent` `--accent-soft` /
  `--font-heading` `--font-body` `--font-mono`）に従う。ここにない色・フォントを
  新たに導入しない。

## 性能要件

- `docs/仕様書.md` 第8章（性能要件）に反する実装をしない。特に以下は必須。
  - プロセスは常に1つ（8.1）。ウィンドウが増えてもプロセスを増やさない
  - 文書全行を走査する更新処理を新たに追加しない。`visibleRanges` や差分更新を使う（8.2）
  - 大容量ファイル（既定10MB超）ではライブプレビューを自動無効化する（8.3）
  - 8.4の数値目標（起動2秒以内、10,000行での入力遅延16ms以内、初期ロードJS 300KB以内 等）
    を悪化させる変更は避ける

## 開発の進め方

- 新機能を追加する前に、必ず `docs/仕様書.md` を参照し、該当する章・項番を確認する。
  仕様書にない機能を推測で追加しない。
- 実装フェーズ（第9章）の順序を守る。現在のフェーズを超える機能を先取りしない。
- SyncMemoとは分離した別プロダクトである。SyncMemo側との互換性は考慮しない。

## Windows実機での確認手順

ユーザーがWindows側で動作確認するときの手順は次で固定する。**この形から勝手に
変えない**（`dotnet run` に置き換えない）。Paneはポータブルな単一exeとして配布する
方針のため、確認も `dotnet publish` で作った `publish\Pane.exe` を起動して行う。

```powershell
cd C:\Users\YUGO\pane; Get-Process Pane -ErrorAction SilentlyContinue | Stop-Process -Force; git pull origin claude/pane-phase-1-setup-87833g; npm install; Remove-Item -Recurse -Force dist,publish -ErrorAction SilentlyContinue; npm run build; dotnet publish Pane\Pane.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o publish; .\publish\Pane.exe
```

- パス（`C:\Users\YUGO\pane`）は省略せず毎回そのまま書く
- `cd` と各コマンドは `;` でつないだ**1つのPowerShellコードブロック**として提示する
- この手順は**プッシュしたときだけ**提示する

## 時刻の扱い

- ユーザーへの報告で時刻に触れるときは、**必ず日本時間(JST, UTC+9)で書く**。
- 開発コンテナのシステム時刻はUTCなので、`date` の出力をそのまま書かないこと。
  `TZ=Asia/Tokyo date` を使うか、UTCに9時間を足して換算する。
