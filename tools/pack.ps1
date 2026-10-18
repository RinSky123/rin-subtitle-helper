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

Compress-Archive -Path $src -DestinationPath $out -Force

Write-Host ""
Write-Host "  ✅ 打包完成" -ForegroundColor Green
Write-Host "     版本：v$ver"
Write-Host "     产物：$out"
Write-Host ("     大小：" + ("{0:N0}" -f (Get-Item $out).Length) + " 字节")
Write-Host ""
Write-Host "  上传到 GitHub Releases 即可让用户直接下载。" -ForegroundColor Cyan
Write-Host ""
