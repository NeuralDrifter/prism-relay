# ── Prism-Relay MCP Server — Windows Installer (PowerShell) ──────────────────
# Run as: .\install.ps1
# Requires: PowerShell 5.1+, Node.js 18+, Python 3.8+ (optional)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigDir = Join-Path $env:USERPROFILE ".config\prism-relay"
$LocalBin  = Join-Path $env:USERPROFILE ".local\bin"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Prism-Relay MCP Server - Installer" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Check prerequisites ─────────────────────────────────────────────────────

Write-Host "[1/6] Checking prerequisites..." -ForegroundColor Yellow

# Node.js
try {
    $nodeVer = (node --version 2>$null)
    if (-not $nodeVer) { throw "not found" }
    $major = [int]($nodeVer -replace 'v','').Split('.')[0]
    if ($major -lt 18) {
        Write-Host "  ERROR: Node.js 18+ required (found $nodeVer)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Node.js $nodeVer ......... OK" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Node.js not found. Install from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# npm
try {
    $npmVer = (npm --version 2>$null)
    if (-not $npmVer) { throw "not found" }
    Write-Host "  npm $npmVer ................. OK" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: npm not found. Install Node.js with npm." -ForegroundColor Red
    exit 1
}

# Python (optional)
$Python = $null
try {
    $pyVer = (python --version 2>$null)
    if ($pyVer) { $Python = "python" }
} catch {}
if (-not $Python) {
    try {
        $pyVer = (python3 --version 2>$null)
        if ($pyVer) { $Python = "python3" }
    } catch {}
}
if ($Python) {
    Write-Host "  $pyVer ............ OK" -ForegroundColor Green
} else {
    Write-Host "  WARNING: Python not found. Settings tool will not work." -ForegroundColor DarkYellow
    Write-Host "           Install Python 3.8+ for the GUI/TUI config tool." -ForegroundColor DarkYellow
}
Write-Host ""

# ── Install Node.js dependencies ────────────────────────────────────────────

Write-Host "[2/6] Installing Node.js dependencies..." -ForegroundColor Yellow
Push-Location $ScriptDir
npm install --production 2>$null | Select-Object -Last 1
Pop-Location
Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── Install Pillow (optional) ───────────────────────────────────────────────

Write-Host "[3/6] Checking Pillow (optional, for GUI splash)..." -ForegroundColor Yellow
if ($Python) {
    $pillowCheck = & $Python -c "from PIL import Image" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Pillow .................. OK" -ForegroundColor Green
    } else {
        Write-Host "  Pillow not found. Installing..."
        pip install Pillow 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  WARNING: Could not install Pillow. GUI splash will be skipped." -ForegroundColor DarkYellow
        }
    }
} else {
    Write-Host "  Skipped (no Python)." -ForegroundColor DarkYellow
}
Write-Host ""

# ── Create config directory ─────────────────────────────────────────────────

Write-Host "[4/6] Setting up config directory..." -ForegroundColor Yellow
if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}

# Copy splash image
$splashSrc = Join-Path $ScriptDir "splash.png"
$splashDst = Join-Path $ConfigDir "splash.png"
if ((Test-Path $splashSrc) -and -not (Test-Path $splashDst)) {
    Copy-Item $splashSrc $splashDst
    Write-Host "  Copied splash.png to $ConfigDir\" -ForegroundColor Green
}

# Create default settings
$settingsPath = Join-Path $ConfigDir "settings.json"
if (-not (Test-Path $settingsPath)) {
    $defaultSettings = @{
        anthropic_api_key  = ""
        anthropic_model    = "claude-sonnet-4-5-20250929"
        deepseek_api_key   = ""
        deepseek_model     = "deepseek-chat"
        deepseek_base_url  = "https://api.deepseek.com/v1"
        gemini_model       = "gemini-3-pro-preview"
        lmstudio_base_url  = "http://localhost:1234/v1"
        lmstudio_model     = ""
        timeout_ms         = "120000"
        show_splash        = "true"
    }
    $defaultSettings | ConvertTo-Json -Depth 2 | Set-Content $settingsPath -Encoding UTF8
    Write-Host "  Created default settings.json" -ForegroundColor Green
} else {
    Write-Host "  Settings file already exists, skipping." -ForegroundColor DarkYellow
}
Write-Host ""

# ── Add to PATH ─────────────────────────────────────────────────────────────

Write-Host "[5/6] Adding to PATH..." -ForegroundColor Yellow

# Create .local/bin directory
if (-not (Test-Path $LocalBin)) {
    New-Item -ItemType Directory -Path $LocalBin -Force | Out-Null
}

# Create prismmcp.cmd wrapper
$cmdWrapper = Join-Path $LocalBin "prismmcp.cmd"
$pyScript = Join-Path $ScriptDir "prismmcp.py"
@"
@echo off
python "$pyScript" %*
"@ | Set-Content $cmdWrapper -Encoding ASCII
Write-Host "  Created: $cmdWrapper" -ForegroundColor Green

# Check if already in PATH
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($currentPath -notlike "*$LocalBin*") {
    $response = Read-Host "  Add $LocalBin to user PATH? [Y/n]"
    if ($response -eq "" -or $response -match "^[Yy]") {
        [Environment]::SetEnvironmentVariable("PATH", "$currentPath;$LocalBin", "User")
        $env:PATH = "$env:PATH;$LocalBin"
        Write-Host "  Added to user PATH. Restart your terminal to use 'prismmcp'." -ForegroundColor Green
    }
} else {
    Write-Host "  $LocalBin already in PATH." -ForegroundColor Green
}
Write-Host ""

# ── Print summary ───────────────────────────────────────────────────────────

$indexJs = (Join-Path $ScriptDir "index.js") -replace '\\', '\\'

Write-Host "[6/6] Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Configure providers:" -ForegroundColor White
Write-Host "     prismmcp --gui"
Write-Host ""
Write-Host "  2. Add to your AI assistant's MCP config:" -ForegroundColor White
Write-Host ""
Write-Host "     Claude Code (~/.claude.json):" -ForegroundColor DarkCyan
Write-Host "     {"
Write-Host "       `"mcpServers`": {"
Write-Host "         `"prism-relay`": {"
Write-Host "           `"type`": `"stdio`","
Write-Host "           `"command`": `"node`","
Write-Host "           `"args`": [`"$indexJs`"]"
Write-Host "         }"
Write-Host "       }"
Write-Host "     }"
Write-Host ""
Write-Host "     Gemini CLI (~/.gemini/settings.json):" -ForegroundColor DarkCyan
Write-Host "     {"
Write-Host "       `"mcpServers`": {"
Write-Host "         `"prism-relay`": {"
Write-Host "           `"command`": `"node`","
Write-Host "           `"args`": [`"$indexJs`"]"
Write-Host "         }"
Write-Host "       }"
Write-Host "     }"
Write-Host ""
Write-Host "     Codex CLI (~/.codex/config.json):" -ForegroundColor DarkCyan
Write-Host "     {"
Write-Host "       `"mcpServers`": {"
Write-Host "         `"prism-relay`": {"
Write-Host "           `"command`": `"node`","
Write-Host "           `"args`": [`"$indexJs`"]"
Write-Host "         }"
Write-Host "       }"
Write-Host "     }"
Write-Host ""
Write-Host "  3. Sync settings to Claude Code:" -ForegroundColor White
Write-Host "     prismmcp --sync"
Write-Host ""
Write-Host "  4. Restart your AI assistant to load the MCP server." -ForegroundColor White
Write-Host ""
Write-Host "  5. Check status:" -ForegroundColor White
Write-Host "     prismmcp --status"
Write-Host ""
