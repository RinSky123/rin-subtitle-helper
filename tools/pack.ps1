# =====================================================================
#  Rin字幕效果助手 — 打包发布用 zip
#  用法：powershell -ExecutionPolicy Bypass -File tools\pack.ps1
#  产物：dist\RinSubtitleHelper_v<版本>.zip（结构正确，可直接解压安装）
# =====================================================================

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src  = Join-Path $root "RinSubtitleHelper"
$dist = Join-Path $root "dist"

if (-not (Test-Path $src)) { Write-Host "[x] 找不到 $src" -ForegroundColor Red; exit 1 }

# 从 manifest 里读版本号，避免手写版本对不上
$manifest = Join-Path $src "CSXS\manifest.xml"
$ver = (Select-String -Path $manifest -Pattern 'ExtensionBundleVersion="([^"]+)"').Matches[0].Groups[1].Value
if (-not $ver) { Write-Host "[x] 读不到版本号" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }
$out = Join-Path $dist "RinSubtitleHelper_v$ver.zip"
if (Test-Path $out) { Remove-Item $out -Force }

# 先把要发的内容拷到临时目录，顺手剔除本地测试 / 编辑器残留
# （_smoketest.html 是 _mk_test.js 生成的面板冒烟测试页，不能进发布包）
$stage = Join-Path $env:TEMP ("rinpack_" + [System.Guid]::NewGuid().ToString("N"))
$stageExt = Join-Path $stage "RinSubtitleHelper"
New-Item -ItemType Directory -Path $stageExt -Force | Out-Null

$excludeNames = @("_smoketest.html", "desktop.ini", "Thumbs.db", ".DS_Store")
$excludeDirs  = @(".git", ".vscode", ".idea", "__MACOSX")

Get-ChildItem -Recurse -Force -File $src | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1)
    $parts = $rel -split '\\'
    $skip = $false
    foreach ($p in $parts) {
        if ($excludeDirs -contains $p) { $skip = $true }
    }
    if (-not $skip -and ($excludeNames -contains $_.Name)) { $skip = $true }
    if ($skip) { Write-Host ("     [跳过] " + $rel) -ForegroundColor DarkGray; return }

    $target = Join-Path $stageExt $rel
    $targetDir = Split-Path -Parent $target
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
}

Compress-Archive -Path $stageExt -DestinationPath $out -Force
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host ""
Write-Host "  ✅ 打包完成" -ForegroundColor Green
Write-Host "     版本：v$ver"
Write-Host "     产物：$out"
Write-Host ("     大小：" + ("{0:N0}" -f (Get-Item $out).Length) + " 字节")
Write-Host ""
Write-Host "  上传到 GitHub Releases 即可让用户直接下载。" -ForegroundColor Cyan
Write-Host ""
