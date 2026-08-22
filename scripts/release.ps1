# Pane のリリース用 Zip を作る。
#
# 使い方（リポジトリ直下で実行）:
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 1.0.1
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -ReadyToRun   # 起動短縮の比較用
#
# 既定では .NET ランタイムを同梱した自己完結型（self-contained）で作る。
# 利用者側に .NET のインストールを求めないためで、インストーラを使えない環境でも
# exe を置くだけで動く、という配布方針（仕様書 第7.1節）に合わせている。
# ランタイム同梱をやめて小さくしたい場合だけ -FrameworkDependent を付ける
# （その場合、利用者に .NET 8 デスクトップランタイムの導入が必要になる）。
#
# 出力サイズの目安（v1.0.0 実測）:
#   self-contained      : exe 189MB / Zip 76MB
#   framework-dependent : exe 数MB  / Zip 十数MB

[CmdletBinding()]
param(
    [string]$Version = "1.0.2",
    [switch]$FrameworkDependent,
    # 事前コンパイル(ReadyToRun)を有効にする。起動時のJITが減り「プロセス開始→Main到達」が
    # 短くなる一方、配布物が大きくなる(win-x64 self-contained での実測:
    # exe 180MB→238MB、Zip 71.9MB→88.2MB)。既定は無効。
    # 起動時間への効果は実機のログ「[計測] プロセス開始→Main到達」で比較できる。
    [switch]$ReadyToRun,
    # 既に release フォルダに同名の Zip があるとき、確認せず上書きする
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# このスクリプトはリポジトリ直下を基準に動く（scripts\ の1つ上）
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$Rid         = "win-x64"
# ReadyToRun 版は比較用に別名の Zip にする(同じ名前だとどちらを配ったか分からなくなる)。
$PackageName = if ($ReadyToRun) { "Pane-v$Version-$Rid-r2r" } else { "Pane-v$Version-$Rid" }
$PublishDir  = Join-Path $RepoRoot "publish"
$ReleaseDir  = Join-Path $RepoRoot "release"
$StageDir    = Join-Path $ReleaseDir $PackageName
$ZipPath     = Join-Path $ReleaseDir "$PackageName.zip"

function Write-Step([string]$message) {
    Write-Host ""
    Write-Host "=== $message ===" -ForegroundColor Cyan
}

# 外部コマンドの失敗を確実に検知する。PowerShell は外部 exe が非ゼロ終了しても
# 例外にならないため、$LASTEXITCODE を都度見る必要がある。
function Invoke-Checked([string]$label, [scriptblock]$command) {
    & $command
    if ($LASTEXITCODE -ne 0) {
        throw "$label に失敗しました（終了コード $LASTEXITCODE）"
    }
}

# ---- 事前チェック ----
Write-Step "事前チェック"

foreach ($tool in @("node", "npm", "dotnet")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool が見つかりません。インストールしてから実行してください。"
    }
}
Write-Host "node   : $(node --version)"
Write-Host "npm    : $(npm --version)"
Write-Host "dotnet : $(dotnet --version)"

if ((Test-Path $ZipPath) -and (-not $Force)) {
    $answer = Read-Host "$ZipPath は既に存在します。上書きしますか? (y/N)"
    if ($answer -ne "y") { throw "中止しました。" }
}

# 起動中の Pane があると publish 時にファイルが掴まれて失敗する
Get-Process Pane -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

# ---- クリーン ----
# 前回のビルド成果物が混ざらないよう、毎回まっさらから作る。
# dist は削除してから npm run build で作り直す（古いチャンクが残ると Zip に紛れ込む）。
Write-Step "前回の成果物を削除"

foreach ($dir in @("dist", "publish", $StageDir)) {
    $path = if ([System.IO.Path]::IsPathRooted($dir)) { $dir } else { Join-Path $RepoRoot $dir }
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path
        Write-Host "削除: $path"
    }
}
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }

# ---- フロントエンドのビルド ----
# Pane/FileTypes.generated.cs もここで生成されるため、dotnet publish より先に実行する。
Write-Step "npm install"
Invoke-Checked "npm install" { npm install }

Write-Step "npm run build"
Invoke-Checked "npm run build" { npm run build }

if (-not (Test-Path (Join-Path $RepoRoot "dist\index.html"))) {
    throw "dist\index.html が作られていません。npm run build の出力を確認してください。"
}

# ---- .NET の publish ----
Write-Step "dotnet publish"

$publishArgs = @(
    "publish", "Pane\Pane.csproj",
    "-c", "Release",
    "-r", $Rid,
    "-p:Version=$Version",
    "-o", $PublishDir
)
if ($FrameworkDependent) {
    # ランタイム非同梱。利用者に .NET 8 デスクトップランタイムが必要になる。
    $publishArgs += "--self-contained", "false"
    Write-Host "ランタイム非同梱でビルドします（利用者に .NET 8 の導入が必要）" -ForegroundColor Yellow
} else {
    $publishArgs += "--self-contained", "true"
}
if ($ReadyToRun) {
    $publishArgs += "-p:PublishReadyToRun=true"
    Write-Host "事前コンパイル(ReadyToRun)を有効にしてビルドします（起動は速くなるがサイズが増えます）" -ForegroundColor Yellow
}

Invoke-Checked "dotnet publish" { dotnet @publishArgs }

$exePath = Join-Path $PublishDir "Pane.exe"
if (-not (Test-Path $exePath)) { throw "Pane.exe が作られていません。" }

# csproj の CopyDistToPublishDir ターゲットが publish 後に dist をコピーする。
# ここが空だと配布物として成立しないので確実に確認する。
$publishedDist = Join-Path $PublishDir "dist"
if (-not (Test-Path (Join-Path $publishedDist "index.html"))) {
    throw "publish\dist\index.html がありません。dist のコピーに失敗しています。"
}

# ---- 配布物を組み立てる ----
# Zip を解凍したときにファイルが散らばらないよう、1階層フォルダを挟む。
Write-Step "配布物を組み立て"

New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
Copy-Item $exePath -Destination $StageDir
Copy-Item $publishedDist -Destination $StageDir -Recurse

# .pdb はデバッグ情報。配布物には不要なので除く（万一コピーされていた場合の保険）。
Get-ChildItem $StageDir -Filter "*.pdb" -Recurse | Remove-Item -Force

# 同梱する説明書き。解凍しただけの人が最初に読む想定。
$runtimeSection = if ($FrameworkDependent) {
@"
動作環境
  Windows 10 / 11 (64bit)
  .NET 8 デスクトップランタイム
  WebView2 ランタイム
"@
} else {
@"
動作環境
  Windows 10 / 11 (64bit)
  WebView2 ランタイム
  (.NET ランタイムは同梱しているため、別途の導入は不要です)
"@
}

$readme = @"
Pane v$Version

使い方
  Pane.exe をダブルクリックしてください。インストールは不要です。

  Pane.exe と dist フォルダは必ず同じ場所に置いたままにしてください。
  dist フォルダを移動・削除すると起動しなくなります。

  好きな場所に置いて構いません（デスクトップ、USBメモリなど）。

設定の保存先
  %LOCALAPPDATA%\Pane\

  設定と自動保存のデータはここに作られます。アンインストールは、
  このフォルダと解凍したフォルダを削除するだけで完了します。

ファイルの関連付け
  .md ファイルを Pane で開くようにしたい場合は、設定画面から
  明示的に有効にしてください。起動しただけでは何も書き換えません。

$runtimeSection
"@

# 同梱する txt は、Windows のメモ帳で開いても文字化けしないよう BOM 付き UTF-8 にする
# （Set-Content の UTF8 は Windows PowerShell 5.1 では BOM 付きになるが、
#   PowerShell 7 では BOM 無しになるため、実行環境によらず揃うよう明示的に書き出す）。
$utf8WithBom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText(
    (Join-Path $StageDir "はじめにお読みください.txt"),
    ($readme -replace "`r?`n", "`r`n"),
    $utf8WithBom)

# ---- Zip にする ----
Write-Step "Zip を作成"

New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
Compress-Archive -Path $StageDir -DestinationPath $ZipPath -CompressionLevel Optimal

# 中身を確認したい人のためにステージフォルダは残す（不要なら次回実行時に消える）

# ---- 結果 ----
Write-Step "完了"

$zipInfo = Get-Item $ZipPath
$hash = (Get-FileHash $ZipPath -Algorithm SHA256).Hash

Write-Host ""
Write-Host "出力      : $ZipPath"
Write-Host "サイズ    : $([math]::Round($zipInfo.Length / 1MB, 1)) MB"
Write-Host "SHA256    : $hash"
Write-Host "ランタイム: $(if ($FrameworkDependent) { '非同梱（利用者に .NET 8 が必要）' } else { '同梱（導入不要）' })"
Write-Host "事前コンパイル: $(if ($ReadyToRun) { '有効（ReadyToRun）' } else { '無効' })"
Write-Host ""
Write-Host "GitHub Releases にこの Zip をアップロードし、リリース文へ上の SHA256 を載せてください。"
