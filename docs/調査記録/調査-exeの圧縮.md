# exe の圧縮（EnableCompressionInSingleFile）を測って見送った

調査日: 2026-09-25（JST）。**製品コードは変えていない**（`Pane.csproj` に見送った理由のコメントを足しただけ）。

## きっかけ

利用者から「exe の容量が大きいので、圧縮したらどれぐらい減るか」。

`Pane.exe` は .NET 本体ごと同梱した単一ファイル（self-contained・単一exe、仕様書 第7章）で、
約180MB ある。.NET には、この単一ファイルの中身を圧縮する設定 `EnableCompressionInSingleFile`
がある（self-contained のときだけ使える）。

## 大きさ（開発コンテナで測った）

同じソース（v1.2.2 相当）を `-r win-x64 --self-contained true` で2通りに publish した。

| | 圧縮なし（今） | 圧縮あり | 差 |
|---|---|---|---|
| `Pane.exe` | 188,755,939 バイト（約180MB） | 78,522,747 バイト（約75MB） | -105MB（-58%） |
| 配布 Zip（exe + dist） | 71.4MB | 71.6MB | ほぼ同じ |

**配布 Zip の大きさは変わらない。** Zip にする時点で exe はすでに圧縮されているため。
ダウンロード（配布 Zip・「更新する」）が軽くなるわけではなく、減るのは置いたあとのディスク上の大きさだけ。

## 起動時間とメモリ（実機、利用者の開発機で測った）

Microsoft の説明では、圧縮した単一ファイルは**起動のたびに中身をメモリへ展開する**ため時間がかかり、
その影響はアプリによって大きく違うので「大きさと起動時間の両方を測ってから決める」よう勧めている
（[Microsoft Learn: Compress assemblies in single-file apps](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview#compress-assemblies-in-single-file-apps)）。

両方を `measure\plain` と `measure\comp` に作り、**交互に5回ずつ**起動した（毎回 Pane を止めてから起動し、
10秒待ってログと `Get-Process` から読む）。

- **Main到達**: ログの `[計測] プロセス開始→Main到達`
- **画面の準備完了**: 同じ行の「プロセス開始」の時刻から、`initial-render-ready受信(JS側の初期描画完了通知)` の行の時刻まで
- **メモリ**: `Pane.exe` 自身の `PrivateMemorySize64`（画面を描く WebView2 のプロセスは圧縮と関係ないので含めない）

```
種類     回 Main到達(ms) 画面の準備完了(ms) メモリ(MB)
圧縮なし  1          859               1656        107
圧縮あり  1         1369               2208        149
圧縮なし  2           68                824        106
圧縮あり  2          166                942        149
圧縮なし  3           68                809        107
圧縮あり  3          160                932        149
圧縮なし  4           68                810        108
圧縮あり  4          168                954        149
圧縮なし  5           72                854        107
圧縮あり  5          169                965        149
```

1回目は publish した直後の exe で、ウイルス対策が新しいファイルを調べる時間が入りやすいので分けて見る。

| | 圧縮なし | 圧縮あり | 差 |
|---|---|---|---|
| 画面の準備完了（2〜5回目の平均） | 824ms | 948ms | +124ms（+15%） |
| 画面の準備完了（1回目） | 1,656ms | **2,208ms** | +552ms |
| Main到達（2〜5回目の平均） | 69ms | 166ms | +97ms |
| `Pane.exe` のメモリ | 107MB | 149MB | **+42MB（+39%）** |

## 見送った理由

1. **メモリが常に42MB増える。** 圧縮した中身をメモリへ展開して持ち続けるためで、一度きりの負担ではない。
   Pane は常駐するので、この分は PC を使っている間ずっと使われる
2. **初回の起動が2秒を超えた**（2,208ms）。仕様書 8.4 の「起動2秒以内」を、この開発機ですら割った。
   ウイルス対策の走査が重い会社のPCでは、さらに延びるはず
3. **得られるのはディスク上の105MBだけ。** ダウンロードの大きさは変わらない

2回目以降の +124ms は体感では気にならない程度だが、メモリと初回の起動の2つが重い。

## 試し直すなら

- 測り方は上のとおり。`dotnet publish Pane\Pane.csproj -c Release -r win-x64 --self-contained true -p:EnableCompressionInSingleFile=true`
  で圧縮ありの版を作れる
- **いつもの実機確認の手順（`--self-contained false`）では使えない。** 圧縮は self-contained のときだけの機能で、
  `Pane.csproj` に無条件で書くと、その手順の publish が失敗する（NETSDK1176）。入れるなら
  `Condition="'$(SelfContained)' == 'true'"` を付けること
