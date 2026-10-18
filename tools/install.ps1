# =====================================================================
#  Rin字幕效果助手 — 一键安装（Windows）
#  用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行
#        powershell -ExecutionPolicy Bypass -File install.ps1
# =====================================================================

$ErrorActionPreference = "Stop"

$extName = "RinSubtitleHelper"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path (Split-Path -Parent $scriptDir) $extName

if (-not (Test-Path $src)) {
    Write-Host "[x] 找不到扩展文件夹：$src" -ForegroundColor Red
    Write-Host "    请确认本脚本位于仓库的 tools\ 目录下。" -ForegroundColor Red
    exit 1
}

$destRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$dest = Join-Path $destRoot $extName

Write-Host ""
Write-Host "  Rin字幕效果助手 — 安装程序" -ForegroundColor Cyan
Write-Host "  ------------------------------------" -ForegroundColor DarkGray
Write-Host "  源目录：$src"
Write-Host "  目标  ：$dest"
Write-Host ""

# 1) 复制扩展
if (-not (Test-Path $destRoot)) { New-Item -ItemType Directory -Path $destRoot -Force | Out-Null }
if (Test-Path $dest) {
    Write-Host "  [1/2] 已存在旧版本，正在覆盖…" -ForegroundColor Yellow
    Remove-Item $dest -Recurse -Force
} else {
    Write-Host "  [1/2] 复制扩展文件…" -ForegroundColor Green
}
Copy-Item $src -Destination $dest -Recurse
Write-Host "        完成" -ForegroundColor DarkGray

# 2) 打开调试模式（未签名扩展必须开，否则 AE 里看不到）
Write-Host "  [2/2] 开启 CEP 调试模式（PlayerDebugMode）…" -ForegroundColor Green
$versions = @("CSXS.9","CSXS.10","CSXS.11","CSXS.12","CSXS.13","CSXS.14","CSXS.15")
foreach ($v in $versions) {
    $key = "HKCU:\Software\Adobe\$v"
    try {
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
    } catch {
        Write-Host "        $v 写入失败（可忽略）：$($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}
Write-Host "        完成（已写入 CSXS.9 ~ CSXS.15）" -ForegroundColor DarkGray

Write-Host ""
Write-Host "  ✅ 安装完成！" -ForegroundColor Green
Write-Host ""
Write-Host "  接下来：" -ForegroundColor Cyan
Write-Host "    1. 完全退出并重新启动 After Effects（必须重启，不能只关面板）"
Write-Host "    2. 菜单：窗口 (Window) → 扩展 (Extensions) → Rin字幕效果助手"
Write-Host ""
Write-Host "  如果菜单里看不到，检查 AE 是否彻底退出（任务管理器里不能有 AfterFX.exe）"
Write-Host ""
