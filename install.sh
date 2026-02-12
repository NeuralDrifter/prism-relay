#!/usr/bin/env bash
# Copyright (c) 2026 Michael Burgus (https://github.com/NeuralDrifter)
# Licensed under the MIT License. See LICENSE file for details.
set -e

# ── Prism-Relay MCP Server — Linux/macOS Installer ──────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.config/prism-relay"
LOCAL_BIN="$HOME/.local/bin"

echo "============================================"
echo "  Prism-Relay MCP Server — Installer"
echo "============================================"
echo ""

# ── Check prerequisites ─────────────────────────────────────────────────────

echo "[1/6] Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
    echo "  ERROR: Node.js not found. Install Node.js 18+ first:"
    echo "         https://nodejs.org/"
    exit 1
fi
NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo "  ERROR: Node.js 18+ required (found v$NODE_VER)"
    exit 1
fi
echo "  Node.js $(node --version) ......... OK"

# Python
if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null; then
    PYTHON=python
else
    echo "  WARNING: Python not found. Settings tool (prismmcp) will not work."
    echo "           Install Python 3.8+ for the GUI/TUI configuration tool."
    PYTHON=""
fi
if [ -n "$PYTHON" ]; then
    echo "  $($PYTHON --version) ............ OK"
fi

# npm
if ! command -v npm &>/dev/null; then
    echo "  ERROR: npm not found. Install Node.js with npm."
    exit 1
fi
echo "  npm $(npm --version) ................. OK"
echo ""

# ── Install Node.js dependencies ────────────────────────────────────────────

echo "[2/6] Installing Node.js dependencies..."
cd "$SCRIPT_DIR"
npm install --production 2>&1 | tail -1
echo "  Done."
echo ""

# ── Install Pillow (optional) ───────────────────────────────────────────────

echo "[3/6] Checking Pillow (optional, for GUI splash)..."
if [ -n "$PYTHON" ]; then
    if $PYTHON -c "from PIL import Image" 2>/dev/null; then
        echo "  Pillow .................. OK"
    else
        echo "  Pillow not found. Installing..."
        pip install Pillow 2>/dev/null || pip3 install Pillow 2>/dev/null || \
            echo "  WARNING: Could not install Pillow. GUI splash screen will be skipped."
    fi
else
    echo "  Skipped (no Python)."
fi
echo ""

# ── Create config directory ─────────────────────────────────────────────────

echo "[4/6] Setting up config directory..."
mkdir -p "$CONFIG_DIR"

# Copy splash image if it exists in the project and not yet in config
if [ -f "$SCRIPT_DIR/splash.png" ] && [ ! -f "$CONFIG_DIR/splash.png" ]; then
    cp "$SCRIPT_DIR/splash.png" "$CONFIG_DIR/splash.png"
    echo "  Copied splash.png to $CONFIG_DIR/"
fi

# Create default settings if none exist
if [ ! -f "$CONFIG_DIR/settings.json" ]; then
    cat > "$CONFIG_DIR/settings.json" << 'SETTINGS'
{
  "anthropic_api_key": "",
  "anthropic_model": "claude-sonnet-4-5-20250929",
  "deepseek_api_key": "",
  "deepseek_model": "deepseek-chat",
  "deepseek_base_url": "https://api.deepseek.com/v1",
  "gemini_model": "gemini-3-pro-preview",
  "lmstudio_base_url": "http://localhost:1234/v1",
  "lmstudio_model": "",
  "timeout_ms": "120000",
  "show_splash": "true"
}
SETTINGS
    chmod 600 "$CONFIG_DIR/settings.json"
    echo "  Created default settings.json"
else
    echo "  Settings file already exists, skipping."
fi
echo ""

# ── Add to PATH ─────────────────────────────────────────────────────────────

echo "[5/6] Adding prismmcp to PATH..."
mkdir -p "$LOCAL_BIN"

# Make settings tool executable
chmod +x "$SCRIPT_DIR/prismmcp.py"

# Create/update symlink
ln -sf "$SCRIPT_DIR/prismmcp.py" "$LOCAL_BIN/prismmcp"
echo "  Symlinked: $LOCAL_BIN/prismmcp -> $SCRIPT_DIR/prismmcp.py"

# Check if ~/.local/bin is in PATH
if ! echo "$PATH" | grep -q "$LOCAL_BIN"; then
    echo ""
    echo "  NOTE: $LOCAL_BIN is not in your PATH."
    echo "  Add this line to your shell profile (~/.bashrc or ~/.zshrc):"
    echo ""
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""

    # Attempt to add it automatically
    SHELL_RC=""
    if [ -f "$HOME/.zshrc" ]; then
        SHELL_RC="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
        SHELL_RC="$HOME/.bashrc"
    fi

    if [ -n "$SHELL_RC" ]; then
        read -p "  Add it to $SHELL_RC automatically? [Y/n] " answer
        answer=${answer:-Y}
        if [[ "$answer" =~ ^[Yy] ]]; then
            echo '' >> "$SHELL_RC"
            echo '# Prism-Relay MCP settings tool' >> "$SHELL_RC"
            echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
            echo "  Added to $SHELL_RC. Run: source $SHELL_RC"
        fi
    fi
fi
echo ""

# ── Print summary ───────────────────────────────────────────────────────────

echo "[6/6] Installation complete!"
echo ""
echo "============================================"
echo "  Next steps:"
echo "============================================"
echo ""
echo "  1. Configure providers:"
echo "     prismmcp --gui        # or --tui"
echo ""
echo "  2. Add to your AI assistant:"
echo ""
echo "     Claude Code (~/.claude.json):"
echo "     {"
echo "       \"mcpServers\": {"
echo "         \"prism-relay\": {"
echo "           \"type\": \"stdio\","
echo "           \"command\": \"node\","
echo "           \"args\": [\"$SCRIPT_DIR/index.js\"]"
echo "         }"
echo "       }"
echo "     }"
echo ""
echo "     Gemini CLI (~/.gemini/settings.json):"
echo "     {"
echo "       \"mcpServers\": {"
echo "         \"prism-relay\": {"
echo "           \"command\": \"node\","
echo "           \"args\": [\"$SCRIPT_DIR/index.js\"]"
echo "         }"
echo "       }"
echo "     }"
echo ""
echo "     Codex CLI (~/.codex/config.json):"
echo "     {"
echo "       \"mcpServers\": {"
echo "         \"prism-relay\": {"
echo "           \"command\": \"node\","
echo "           \"args\": [\"$SCRIPT_DIR/index.js\"]"
echo "         }"
echo "       }"
echo "     }"
echo ""
echo "  3. Sync settings to Claude Code (if using):"
echo "     prismmcp --sync"
echo ""
echo "  4. Restart your AI assistant to load the MCP server."
echo ""
echo "  5. Check provider status:"
echo "     prismmcp --status"
echo ""
