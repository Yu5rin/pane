# Pane

Windows 向けの Markdown エディタです。インストール不要の単一実行ファイルで動きます。

Markdown をそのまま書きながら整形結果が見える（ライブプレビュー）エディタでありながら、
`.js` `.py` `.cs` `.json` などのコードファイルを開くと、**行番号付き・シンタックスハイライト付きの
コードエディタとしても使えます**。日々のメモ帳としても、ソースやログを覗く道具としても、
この1本で済ませられます。

## 主な特徴

- **インストール不要** — `Pane.exe` を好きな場所に置くだけ。レジストリを勝手に書き換えません
- **外部と通信しません** — 使用状況の送信も、テーマのダウンロードも、画像アップロード連携もありません
- **Markdown を書いたまま整形して見せる** — 見出し・表・数式・Mermaid 図・脚注・Callouts に対応
- **約60種類の言語のシンタックスハイライト** — 折りたたみ、インデントガイド、カラープレビュー付き
- **文字コードと改行コードを保って開き直す** — Shift_JIS の古いテキストもそのまま扱えます
- **9種類のテーマ** — カスタム CSS も読み込めます
- **PDF / HTML / Word / EPUB などへのエクスポート**（一部は Pandoc が必要）

## 動作環境

- Windows 10 / 11（64ビット）
- WebView2 ランタイム（Windows 11 には標準で入っています）

## インストール

[Releases](../../releases) から Zip をダウンロードして展開し、`Pane.exe` を実行してください。

`Pane.exe` と `dist` フォルダは同じ場所に置いたままにしてください。

設定と自動保存のデータは `%LOCALAPPDATA%\Pane\` に作られます。アンインストールは、
このフォルダと展開したフォルダを削除するだけです。

## 使い方

起動後に **F1キー** を押すと取扱説明書が開きます。

## ビルド

```bash
npm install
npm run build                      # dist/ を生成（Pane/FileTypes.generated.cs もここで作られます）
dotnet publish Pane/Pane.csproj -c Release -r win-x64 --self-contained true -o publish
```

`npm run build` を先に実行する必要があります（C# 側がその生成物に依存しているため）。

配布用の Zip はリリーススクリプトで作れます。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1
```

## 構成

C# (WinForms) が窓とファイル I/O を担い、その中の WebView2 で動く CodeMirror 6 が本文を扱う、
という二層構成です。両者は postMessage でやり取りします。

| | |
|---|---|
| `Pane/` | C# 側。ウィンドウ、ファイル I/O、設定、関連付け、エクスポート |
| `src/` | JS 側。エディタ本体、メニュー、サイドバー、設定画面 |
| `docs/` | 仕様書と取扱説明書 |
| `scripts/` | ビルドとリリースのスクリプト |

## ライセンス

MIT License（[LICENSE](LICENSE) を参照）

同梱している主なオープンソースソフトウェア:

| ライブラリ | ライセンス |
|---|---|
| [CodeMirror 6](https://codemirror.net/) | MIT |
| [Lezer](https://lezer.codemirror.net/) | MIT |
| [Mermaid](https://mermaid.js.org/) | MIT |
| [MathJax](https://www.mathjax.org/) | Apache-2.0 |

アプリ内では 設定 → バージョン情報 からも確認できます。
