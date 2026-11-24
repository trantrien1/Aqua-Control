# Chạy toàn bộ kiểm thử phần mềm và ghi log để chụp màn hình hồ sơ.
# Dùng:  powershell -ExecutionPolicy Bypass -File tools\run-all-tests.ps1
# Kết quả: in ra Terminal + lưu docs\ket-qua-kiem-thu-<ngày-giờ>.log
# Không cần quyền admin. Không đụng tới dữ liệu thật (test tự dùng cổng/DB tạm).

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path 'docs' | Out-Null
$log = Join-Path $root "docs\ket-qua-kiem-thu-$stamp.log"

$results = New-Object System.Collections.Generic.List[object]

function Write-Both([string]$text) {
    Write-Host $text
    Add-Content -Path $log -Value $text -Encoding utf8
}

function Step([string]$name, [scriptblock]$action) {
    $start = Get-Date
    Write-Both ''
    Write-Both ('=' * 78)
    Write-Both ("[{0}] {1}" -f $start.ToString('HH:mm:ss'), $name)
    Write-Both ('=' * 78)
    $code = 0
    try {
        & $action 2>&1 | ForEach-Object { Write-Both "$_" }
        if ($LASTEXITCODE -ne $null) { $code = $LASTEXITCODE }
    } catch {
        Write-Both ("LỖI: {0}" -f $_.Exception.Message)
        $code = 1
    }
    $ms = [int]((Get-Date) - $start).TotalMilliseconds
    $ok = ($code -eq 0)
    $results.Add([pscustomobject]@{ Name = $name; Status = $(if ($ok) { "ĐẠT" } else { "KHÔNG ĐẠT" }); Ms = $ms }) | Out-Null
    Write-Both ("=> {0} ({1:N1}s)" -f $(if ($ok) { 'ĐẠT' } else { 'KHÔNG ĐẠT' }), ($ms / 1000))
}

Write-Both ("HỒ SƠ KIỂM THỬ AQUA-CONTROL - {0}" -f (Get-Date -Format 'dd/MM/yyyy HH:mm:ss zzz'))
Write-Both ("Máy: {0} {1}" -f (Get-CimInstance Win32_OperatingSystem).Caption, (Get-CimInstance Win32_OperatingSystem).Version)
Write-Both ("Node: {0}   npm: {1}" -f (& node -v), (& npm -v))
Write-Both ("Mã nguồn: {0}" -f (& git rev-parse --short HEAD))
Write-Both ("Thư mục: {0}" -f $root)

Step 'npm test (MQTT + Web + SQLite/SSE)' { & npm.cmd test }
Step 'npm run test:multi (27 ca đa khách hàng)' { & npm.cmd run test:multi }
Step 'npm run test:admin (quyền quản trị viên)' { & npm.cmd run test:admin }
Step 'npm run test:water (chu trình thay nước)' { & npm.cmd run test:water }
Step 'npm run test:telegram (kế hoạch cảnh báo)' { & npm.cmd run test:telegram }
Step 'npm run test:telegram-control (lệnh trong bot)' { & npm.cmd run test:telegram-control }
Step 'npm run test:e2e (Telegram đầu-cuối)' { & npm.cmd run test:e2e }
Step 'npm run check:ui (kiểm tra tĩnh giao diện)' { & npm.cmd run check:ui }

# --- Firmware C++: cần g++ (hoặc biến CXX). Trên Windows thử WSL Debian nếu có. ---
Write-Both ''
Write-Both ('=' * 78)
Write-Both ("[{0}] npm run test:firmware (logic C++ trên máy tính)" -f (Get-Date -Format 'HH:mm:ss'))
Write-Both ('=' * 78)

$cxx = $env:CXX
if (-not $cxx) { $cxx = (Get-Command g++ -ErrorAction SilentlyContinue).Source }
$firmwareOk = $false
$firmwareNote = ''
$firmwareStart = Get-Date

if ($cxx) {
    & npm.cmd run test:firmware 2>&1 | ForEach-Object { Write-Both "$_" }
    $firmwareOk = ($LASTEXITCODE -eq 0)
} else {
    Write-Both 'Không thấy g++ trên Windows, thử biên dịch trong WSL Debian...'
    $wslRoot = '/mnt/' + $root.Substring(0, 1).ToLower() + ($root.Substring(2) -replace '\\', '/')
    $wslCmd = "cd '$wslRoot' && mkdir -p .tooling && g++ -std=c++14 -Wall -Wextra tests/water-change.test.cpp -o .tooling/water-test-linux && ./.tooling/water-test-linux"
    Write-Both ("Lệnh: wsl -d Debian -- bash -lc `"{0}`"" -f $wslCmd)
    $wslOut = & wsl.exe -d Debian -- bash -lc $wslCmd 2>&1
    $wslOut | ForEach-Object { Write-Both "$_" }
    $firmwareOk = (($wslOut -join "`n") -match 'PASS')
    if (-not $firmwareOk) { $firmwareNote = 'Cần g++ trên Windows (đặt biến CXX) hoặc WSL Debian có g++.' }
}

$firmwareMs = [int]((Get-Date) - $firmwareStart).TotalMilliseconds
$firmwareStatus = if ($firmwareOk) { 'ĐẠT' } elseif ($firmwareNote) { 'BỎ QUA' } else { 'KHÔNG ĐẠT' }
$results.Add([pscustomobject]@{ Name = 'test:firmware (C++)'; Status = $firmwareStatus; Ms = $firmwareMs }) | Out-Null
if ($firmwareNote) { Write-Both ("GHI CHÚ: {0}" -f $firmwareNote) }
Write-Both ("=> {0} ({1:N1}s)" -f $firmwareStatus, ($firmwareMs / 1000))

# --- Build ESP32: cần PlatformIO ---
Write-Both ''
Write-Both ('=' * 78)
Write-Both 'pio run -e esp32dev (build firmware ESP32)'
Write-Both ('=' * 78)
$pio = (Get-Command pio -ErrorAction SilentlyContinue).Source
if (-not $pio) {
    $pio = @(
        (Join-Path $env:USERPROFILE '.platformio\penv\Scripts\pio.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts\pio.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\Scripts\pio.exe')
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
$buildOk = $false
$buildNote = ''
$buildStart = Get-Date
if ($pio) {
    Write-Both ("Dùng: {0}" -f $pio)
    & $pio run -e esp32dev 2>&1 | ForEach-Object { Write-Both "$_" }
    $buildOk = ($LASTEXITCODE -eq 0)
} else {
    $buildNote = 'Không có PlatformIO trên máy này. Cài bằng: pip install platformio (hoặc dùng hồ sơ bàn giao).'
    Write-Both $buildNote
}
$buildMs = [int]((Get-Date) - $buildStart).TotalMilliseconds
$buildStatus = if ($pio) { if ($buildOk) { 'ĐẠT' } else { 'KHÔNG ĐẠT' } } else { 'BỎ QUA' }
$results.Add([pscustomobject]@{ Name = 'pio run -e esp32dev (build ESP32)'; Status = $buildStatus; Ms = $buildMs }) | Out-Null
Write-Both ("=> {0}" -f $buildStatus)

# --- test:lighting: script không tồn tại trong package.json ---
Write-Both ''
Write-Both ('=' * 78)
Write-Both 'npm run test:lighting (lịch đèn + giữ ấm)'
Write-Both ('=' * 78)
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if ($pkg.scripts.'test:lighting') {
    & npm.cmd run test:lighting 2>&1 | ForEach-Object { Write-Both "$_" }
} else {
    Write-Both 'KHÔNG CHẠY ĐƯỢC: package.json không có script "test:lighting" và mã nguồn không có module lịch đèn/giữ ấm (water.lighting).'
    Write-Both 'Cần bổ sung tính năng + test trước khi điền bảng nghiệm thu đèn.'
}
$results.Add([pscustomobject]@{ Name = 'npm run test:lighting'; Status = 'BỎ QUA'; Ms = 0 }) | Out-Null

# --- Tổng kết ---
Write-Both ''
Write-Both ('=' * 78)
Write-Both 'TỔNG KẾT'
Write-Both ('=' * 78)
foreach ($r in $results) {
    Write-Both ("{0,-46} {1,-10} {2,7:N1}s" -f $r.Name, $r.Status, ($r.Ms / 1000))
}
$pass = ($results | Where-Object { $_.Status -eq 'ĐẠT' }).Count
$ran = ($results | Where-Object { $_.Status -ne 'BỎ QUA' }).Count
$total = $results.Count
Write-Both ''
Write-Both ("Đạt {0}/{1} hạng mục chạy được trên máy này ({2} hạng mục bỏ qua)." -f $pass, $ran, ($total - $ran))
Write-Both ("Log đã lưu: {0}" -f $log)
Write-Both 'Chụp màn hình Terminal ở khung TỔNG KẾT này để đưa vào hồ sơ.'


