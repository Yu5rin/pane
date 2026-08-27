# Pane — Claude Code向けプロジェクト指針

## 言語

- Claude Codeの応答、コミットメッセージ、PRのタイトル・本文は日本語で書く。
- ソースコード内のコメントも日本語で書く。
- 例外：ライブラリ名・APIシンボル・CLIコマンド名・エラーメッセージの引用など、
  技術的に英語であるべき箇所はそのまま残す。

## 名義

- コミットの作者・コミッターは必ず `YUGO <220513216+Yu5rin@users.noreply.github.com>` にする。
  本名や個人のメールアドレスは使わない（公開リポジトリになっても差し支えない状態を保つ）。
- コミットメッセージに `Co-Authored-By: Claude ...` や `Claude-Session: ...` の行を付けない。
- PRのタイトル・本文にも Claude の署名（`🤖 Generated with [Claude Code]...`）や
  セッションURLを付けない。
- 過去の履歴も全コミットこの名義に統一済み。崩さないこと。

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

## 変更を確かめる手順

「完了」と報告する前に、変更した側を必ず回す。

```bash
npm run build          # dist/ を作り直す（毎回まっさらから作る）
npm run verify         # 回帰スイート60本・約2400件（JS側を触ったとき）
dotnet test            # C#側のテスト（Pane/ を触ったとき）
dotnet build Pane/Pane.csproj -c Release -p:EnableWindowsTargeting=true   # Linuxでもビルドは通る
```

PRとmainへの変更では、同じものがCI（`.github/workflows/ci.yml`）でも回る。

- 回帰スイート（`.verify-*.mjs`）は**git管理下に置く**。手元にしか無い状態にしない
  （実際にコンテナが作り直されて60本すべてを失いかけたことがある）。
- 実機で見つかった不具合は、直すだけでなく**なぜ起きたかをコメントかテストに残す**。
  同じ誤りに戻らないための記録であり、`Pane/UpdateCheckLogic.cs` と
  `Pane.Tests/UpdateCheckLogicTests.cs` がその書き方の見本。
- 外の世界（通信・ファイル・時刻）に触れない判断ロジックは、依存の無いクラスへ切り出して
  テストで固定する。切り出したものは `Pane.Tests` へソースごと取り込む
  （`Pane.Tests.csproj` の `<Compile Include>`）ので、Windows専用のAPIを混ぜない。

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
