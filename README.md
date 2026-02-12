# Prism-Relay MCP Server

**Refracting Single Queries into a Spectrum of Logic.**

Prism-Relay is a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets AI coding assistants query and compare multiple LLM providers in parallel. Get a second opinion from Anthropic Claude, Google Gemini, DeepSeek, or a local LM Studio model — all from within your editor.

## Features

- **Multi-provider queries** — Ask the same question to 2-3 LLMs and compare answers side-by-side
- **Single provider queries** — Get a second opinion or specialized analysis from any supported provider
- **Live status checking** — See which providers are configured and reachable
- **Settings GUI/TUI** — Visual configuration tool for API keys, models, and preferences
- **Auto-sync** — Settings automatically propagate to Claude Code's MCP config

## Supported Providers

| Provider | Type | Auth Required |
|----------|------|---------------|
| **Anthropic Claude** | Cloud API | API key |
| **Google Gemini** | CLI tool | Google account (via `gemini` CLI) |
| **DeepSeek** | Cloud API | API key |
| **LM Studio** | Local (OpenAI-compatible) | None |

## MCP Tools

| Tool | Description |
|------|-------------|
| `prism_query` | Query a single LLM provider |
| `prism_compare` | Query 2-3 providers in parallel, get side-by-side results |
| `prism_providers` | List all providers and their live status |

---

## Installation

### Prerequisites

- **Node.js** 18+ (`node --version`)
- **Python** 3.8+ (`python3 --version`) — for the settings tool
- **Pillow** (optional) — for GUI splash screen (`pip install Pillow`)

### Quick Install (Linux/macOS)

```bash
# Clone or copy the project
git clone <repo-url> ~/mcp-servers/prism-relay
cd ~/mcp-servers/prism-relay

# Run the install script
chmod +x install.sh
./install.sh
```

### Quick Install (Windows)

```powershell
# Clone or copy the project
git clone <repo-url> %USERPROFILE%\mcp-servers\prism-relay
cd %USERPROFILE%\mcp-servers\prism-relay

# Run the install script (PowerShell as Administrator)
.\install.ps1
```

### Manual Install

```bash
# 1. Install Node.js dependencies
cd ~/mcp-servers/prism-relay
npm install

# 2. Make the settings tool executable
chmod +x prismmcp.py

# 3. Add to PATH (Linux/macOS)
ln -sf "$(pwd)/prismmcp.py" ~/.local/bin/prismmcp

# 4. (Optional) Install Pillow for GUI splash screen
pip install Pillow
```

---

## Configuration

### Settings Tool

Prism-Relay includes a visual settings manager:

```bash
prismmcp          # Auto-detect: GUI if display available, otherwise TUI
prismmcp --gui    # Force graphical interface
prismmcp --tui    # Force terminal interface
```

### Provider Setup

**Anthropic Claude:**
1. Get an API key at https://console.anthropic.com/settings/keys
2. Enter it in the settings tool under Providers > Anthropic API Key
3. Select your preferred model (Opus 4.6, Sonnet 4.5, or Haiku 4.5)

**Google Gemini:**
1. Install the Gemini CLI: https://github.com/google-gemini/gemini-cli
2. Authenticate: `gemini auth login`
3. Select your preferred model in the settings tool

**DeepSeek:**
1. Get an API key at https://platform.deepseek.com/api_keys
2. Enter it in the settings tool under Providers > DeepSeek API Key
3. Select your preferred model (V3.2 chat or reasoner)

**LM Studio:**
1. Install LM Studio: https://lmstudio.ai
2. Load a model and start the local server (default: `http://localhost:1234/v1`)
3. The model is auto-detected — no additional config needed

### CLI Utilities

```bash
prismmcp --status    # Check provider status
prismmcp --env       # Print env vars for shell export
prismmcp --sync      # Sync settings to Claude Code config
```

---

## Adding to AI Coding Assistants

### Claude Code

**Option A: Automatic (recommended)**

```bash
# Configure providers in the settings tool, then sync
prismmcp --gui       # Set API keys and models
prismmcp --sync      # Write config to ~/.claude.json
```

**Option B: Manual**

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "prism-relay": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/prism-relay/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "ANTHROPIC_MODEL": "claude-sonnet-4-5-20250929",
        "DEEPSEEK_API_KEY": "sk-...",
        "DEEPSEEK_MODEL": "deepseek-chat",
        "DEEPSEEK_BASE_URL": "https://api.deepseek.com/v1",
        "GEMINI_MODEL": "gemini-3-pro-preview",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1",
        "LLM_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

Restart Claude Code after editing the config.

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "prism-relay": {
      "command": "node",
      "args": ["/path/to/prism-relay/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "DEEPSEEK_API_KEY": "sk-...",
        "DEEPSEEK_MODEL": "deepseek-chat",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1",
        "LLM_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

**Note:** When running inside Gemini CLI, the Gemini provider queries itself via the CLI — you may want to omit querying Gemini from within Gemini to avoid recursion. Use `prism_query` with `anthropic`, `deepseek`, or `lmstudio` instead.

### OpenAI Codex CLI

Add to `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "prism-relay": {
      "command": "node",
      "args": ["/path/to/prism-relay/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "DEEPSEEK_API_KEY": "sk-...",
        "GEMINI_MODEL": "gemini-3-pro-preview",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1",
        "LLM_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

**Windows paths:** Replace `/path/to/prism-relay/index.js` with the full Windows path, e.g. `C:\\Users\\YourName\\mcp-servers\\prism-relay\\index.js`.

---

## Environment Variables

All settings can be overridden with environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key | _(none)_ |
| `ANTHROPIC_MODEL` | Default Anthropic model | `claude-sonnet-4-5-20250929` |
| `DEEPSEEK_API_KEY` | DeepSeek API key | _(none)_ |
| `DEEPSEEK_MODEL` | Default DeepSeek model | `deepseek-chat` |
| `DEEPSEEK_BASE_URL` | DeepSeek API endpoint | `https://api.deepseek.com/v1` |
| `GEMINI_MODEL` | Default Gemini model | `gemini-3-pro-preview` |
| `LMSTUDIO_BASE_URL` | LM Studio server URL | `http://localhost:1234/v1` |
| `LMSTUDIO_MODEL` | LM Studio model override | _(auto-detect)_ |
| `LLM_TIMEOUT_MS` | Request timeout in ms | `120000` |

Settings priority: **Environment variables > Settings file > Built-in defaults**

Settings file location: `~/.config/prism-relay/settings.json`

---

## Adding to System PATH

### Linux / macOS

The install script handles this automatically. To do it manually:

```bash
# Option 1: Symlink (recommended)
ln -sf /path/to/prism-relay/prismmcp.py ~/.local/bin/prismmcp

# Option 2: Add project directory to PATH
echo 'export PATH="$PATH:/path/to/prism-relay"' >> ~/.bashrc
source ~/.bashrc
```

Make sure `~/.local/bin` is in your PATH:

```bash
# Add to ~/.bashrc or ~/.zshrc if not already present
export PATH="$HOME/.local/bin:$PATH"
```

### Windows

```powershell
# Option 1: Add to user PATH (PowerShell)
$prismPath = "$env:USERPROFILE\mcp-servers\prism-relay"
[Environment]::SetEnvironmentVariable("PATH",
    "$([Environment]::GetEnvironmentVariable('PATH', 'User'));$prismPath",
    "User")

# Option 2: Create a batch wrapper in a PATH directory
# The install script creates prismmcp.cmd automatically
```

---

## Troubleshooting

**"Cannot find module @modelcontextprotocol/sdk"**
```bash
cd /path/to/prism-relay && npm install
```

**"gemini CLI not found"**
```bash
# Install: https://github.com/google-gemini/gemini-cli
npm install -g @anthropic-ai/gemini-cli
gemini auth login
```

**Provider shows "unavailable" in status**
```bash
prismmcp --status    # Check what's wrong
prismmcp --gui       # Fix settings
prismmcp --sync      # Push to Claude Code
```

**Settings not taking effect in Claude Code**
```bash
prismmcp --sync      # Re-sync settings
# Then restart Claude Code to reload MCP servers
```

**GUI splash screen not showing**
```bash
pip install Pillow   # Required for image display
```

---

## Project Structure

```
prism-relay/
  index.js        — MCP server (Node.js)
  prismmcp.py     — Settings GUI/TUI (Python)
  package.json    — Node.js dependencies
  install.sh      — Linux/macOS installer
  install.ps1     — Windows installer
```

## License

MIT
