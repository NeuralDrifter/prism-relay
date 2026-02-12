#!/usr/bin/env python3
"""
Prism-Relay MCP Settings — curses TUI and tkinter GUI for managing
LLM provider configuration (API keys, models, endpoints, timeouts).

Settings file: ~/.config/prism-relay/settings.json
The MCP server (index.js) reads env vars; this tool writes them to a
settings file and can also export to shell profile.

Usage:
    prismmcp              # auto-detect: GUI if DISPLAY, else TUI
    prismmcp --tui        # force TUI
    prismmcp --gui        # force GUI
"""

import os, sys, json, subprocess, shutil
from pathlib import Path

# ── Banner ──────────────────────────────────────────────────────────────────

BANNER = r"""
 ____       _                      ____       _
|  _ \ _ __(_)___ _ __ ___        |  _ \ ___ | | __ _ _   _
| |_) | '__| / __| '_ ` _ \ _____| |_) / _ \| |/ _` | | | |
|  __/| |  | \__ \ | | | | |_____|  _ <  __/| | (_| | |_| |
|_|   |_|  |_|___/_| |_| |_|     |_| \_\___|_|\__,_|\__, |
                                                      |___/
""".strip('\n').splitlines()
BANNER_H = len(BANNER)
BANNER_W = max(len(l) for l in BANNER)

# ── Paths ───────────────────────────────────────────────────────────────────

CONFIG_DIR = os.path.expanduser("~/.config/prism-relay")
CONFIG_PATH = os.path.join(CONFIG_DIR, "settings.json")
MCP_SERVER_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Schema ──────────────────────────────────────────────────────────────────

# (key, label, type, options_or_none, default, env_var)
# env_var: the environment variable the MCP server reads

TABS = [
    ("Providers", [
        ("anthropic_api_key", "Anthropic API Key", "secret", None, "",
         "ANTHROPIC_API_KEY"),
        ("anthropic_model", "Anthropic Model", "choice", [
            ("claude-opus-4-6",            "Claude Opus 4.6"),
            ("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
            ("claude-haiku-4-5-20251001",  "Claude Haiku 4.5"),
        ], "claude-sonnet-4-5-20250929", "ANTHROPIC_MODEL"),
        ("deepseek_api_key", "DeepSeek API Key", "secret", None, "",
         "DEEPSEEK_API_KEY"),
        ("deepseek_model", "DeepSeek Model", "choice", [
            ("deepseek-chat",     "deepseek-chat (V3.2)"),
            ("deepseek-reasoner", "deepseek-reasoner (V3.2 thinking)"),
        ], "deepseek-chat", "DEEPSEEK_MODEL"),
        ("deepseek_base_url", "DeepSeek Base URL", "text", None,
         "https://api.deepseek.com/v1", "DEEPSEEK_BASE_URL"),
        ("gemini_model", "Gemini Default Model", "choice", [
            ("gemini-3-pro-preview",   "gemini-3-pro (Preview)"),
            ("gemini-3-flash-preview", "gemini-3-flash (Preview)"),
            ("gemini-2.5-pro",         "gemini-2.5-pro"),
            ("gemini-2.5-flash",       "gemini-2.5-flash"),
            ("gemini-2.0-flash",       "gemini-2.0-flash"),
        ], "gemini-3-pro-preview", "GEMINI_MODEL"),
    ]),
    ("LM Studio", [
        ("lmstudio_base_url", "LM Studio URL", "text", None,
         "http://localhost:1234/v1", "LMSTUDIO_BASE_URL"),
        ("lmstudio_model", "LM Studio Model", "text", None,
         "", "LMSTUDIO_MODEL"),
    ]),
    ("General", [
        ("timeout_ms", "Timeout (ms)", "choice", [
            ("60000",  "60s"),
            ("120000", "120s"),
            ("180000", "180s"),
            ("300000", "300s"),
        ], "120000", "LLM_TIMEOUT_MS"),
        ("show_splash", "Show Splash Screen", "choice", [
            ("true",  "On"),
            ("false", "Off"),
        ], "true", ""),
    ]),
]

DEFAULTS = {}
SCHEMA = {}
for _tab, _items in TABS:
    for key, label, typ, options, default, env_var in _items:
        DEFAULTS[key] = default
        SCHEMA[key] = (label, typ, options, default, env_var, _tab)


# ── Load / Save ─────────────────────────────────────────────────────────────

def load():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f:
                saved = json.load(f)
            for k, v in saved.items():
                if k in SCHEMA:
                    cfg[k] = v
        except (json.JSONDecodeError, OSError):
            pass
    return cfg


def save(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_PATH, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)  # secrets inside


def get(key):
    return load().get(key, DEFAULTS.get(key))


def get_env_dict():
    """Return dict of env vars for the MCP server process."""
    cfg = load()
    env = {}
    for key, (_, _, _, _, env_var, _) in SCHEMA.items():
        val = cfg.get(key, "")
        if val:
            env[env_var] = str(val)
    return env


# ── Status checks ───────────────────────────────────────────────────────────

def check_provider_status():
    """Return list of (provider, status_str, ok_bool)."""
    cfg = load()
    results = []

    # Anthropic
    if cfg.get("anthropic_api_key"):
        results.append(("Anthropic", "API key set", True))
    else:
        results.append(("Anthropic", "No API key", False))

    # Gemini
    if shutil.which("gemini"):
        results.append(("Gemini", "CLI installed", True))
    else:
        results.append(("Gemini", "CLI not found", False))

    # DeepSeek
    if cfg.get("deepseek_api_key"):
        results.append(("DeepSeek", "API key set", True))
    else:
        results.append(("DeepSeek", "No API key", False))

    # LM Studio
    url = cfg.get("lmstudio_base_url", "http://localhost:1234/v1")
    try:
        import urllib.request
        req = urllib.request.Request(f"{url}/models", method='GET')
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            n = len(data.get("data", []))
            results.append(("LM Studio", f"{n} model{'s' if n != 1 else ''} loaded", True))
    except Exception:
        results.append(("LM Studio", "Not reachable", False))

    return results


# ── Update Claude Code MCP config ──────────────────────────────────────────

def sync_claude_config():
    """Update ~/.claude.json prism-relay env block with current settings."""
    claude_json = os.path.expanduser("~/.claude.json")
    if not os.path.exists(claude_json):
        return False
    try:
        with open(claude_json) as f:
            data = json.load(f)
        servers = data.get("mcpServers", {})
        if "prism-relay" not in servers:
            return False
        env = get_env_dict()
        servers["prism-relay"]["env"] = env
        with open(claude_json, 'w') as f:
            json.dump(data, f, indent=2)
        return True
    except Exception:
        return False


# ── Curses TUI ──────────────────────────────────────────────────────────────

class SettingsTUI:

    def __init__(self):
        self.cfg = load()
        self.saved_cfg = dict(self.cfg)
        self.tab_idx = 0
        self.item_idx = 0
        self.editing_text = False
        self.edit_buffer = ""
        self.edit_cursor = 0
        self.has_colors = False
        self.has_flame = False
        self.status_msg = ""
        self.status_color = 6
        self.show_secrets = False

    def run(self):
        import curses, struct, fcntl, termios, time
        try:
            packed = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b'\x00' * 8)
            orig_rows, orig_cols = struct.unpack('HHHH', packed)[:2]
        except Exception:
            orig_rows, orig_cols = 0, 0
        sys.stdout.write('\033[8;28;120t')
        sys.stdout.flush()
        time.sleep(0.05)
        try:
            return curses.wrapper(self._main)
        except KeyboardInterrupt:
            return False
        finally:
            if orig_rows > 0 and orig_cols > 0:
                sys.stdout.write(f'\033[8;{orig_rows};{orig_cols}t')
                sys.stdout.flush()

    def _show_splash(self, stdscr):
        """Show a splash screen with the Prism-Relay logo for 1 second."""
        if load().get('show_splash', 'true') == 'false':
            return
        import curses, time
        stdscr.clear()
        h, w = stdscr.getmaxyx()

        # ASCII art prism with rainbow rays
        art = [
            r"              /\              ",
            r"             /  \             ",
            r"            /    \            ",
            r"           /      \  ═══════ ",
            r"          /   /\   \ ═══════ ",
            r"         /   /  \   \═══════ ",
            r"        /   /    \   ══════  ",
            r"       /   /  ()  \  ══════  ",
            r"      /   /        \ ═════   ",
            r"     /   /    /\    \═════   ",
            r"    /   /    /  \    ════    ",
            r"   /   /    /    \   ════    ",
            r"  /   /____/______\  ═══    ",
            r" /                  \ ═══    ",
            r"/____________________\══     ",
        ]

        title    = "Prism-Relay"
        tagline  = "Refracting Single Queries into a Spectrum of Logic."

        art_h = len(art)
        art_w = max(len(line) for line in art)
        total_h = art_h + 4  # art + gap + title + tagline
        start_y = max(0, (h - total_h) // 2)
        start_x = max(0, (w - art_w) // 2)

        # Color pairs 10-15 are the prism gradient (violet→blue→cyan→green→yellow→white)
        ray_colors = [10, 11, 12, 13, 14, 15] if getattr(self, 'has_flame', False) else []

        for i, line in enumerate(art):
            y = start_y + i
            if y >= h - 1:
                break
            # Split line into prism part and ray part at the first '═'
            ray_pos = line.find('═')
            if ray_pos >= 0:
                prism_part = line[:ray_pos]
                ray_part = line[ray_pos:]
            else:
                prism_part = line
                ray_part = ""

            # Draw prism in white/bold
            px = start_x
            if px + len(prism_part) < w:
                try:
                    stdscr.addstr(y, px, prism_part, curses.A_BOLD | curses.color_pair(7))
                except curses.error:
                    pass

            # Draw rays with rainbow gradient
            if ray_part and ray_colors:
                rx = start_x + ray_pos
                color_idx = i % len(ray_colors)
                attr = curses.A_BOLD | curses.color_pair(ray_colors[color_idx])
                if rx + len(ray_part) < w:
                    try:
                        stdscr.addstr(y, rx, ray_part, attr)
                    except curses.error:
                        pass

        # Title — centered, bold white
        title_y = start_y + art_h + 1
        title_x = max(0, (w - len(title)) // 2)
        if title_y < h - 1:
            try:
                stdscr.addstr(title_y, title_x, title, curses.A_BOLD | curses.color_pair(7))
            except curses.error:
                pass

        # Tagline — centered, dimmer
        tag_y = title_y + 1
        tag_x = max(0, (w - len(tagline)) // 2)
        if tag_y < h - 1:
            try:
                stdscr.addstr(tag_y, tag_x, tagline, curses.color_pair(3))
            except curses.error:
                pass

        stdscr.refresh()
        time.sleep(1.0)

    def _main(self, stdscr):
        import curses
        self.stdscr = stdscr
        curses.curs_set(0)
        stdscr.timeout(-1)

        try:
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_WHITE, curses.COLOR_BLUE)
            curses.init_pair(2, curses.COLOR_BLACK, curses.COLOR_WHITE)
            curses.init_pair(3, curses.COLOR_CYAN, -1)
            curses.init_pair(4, curses.COLOR_GREEN, -1)
            curses.init_pair(5, curses.COLOR_RED, -1)
            curses.init_pair(6, curses.COLOR_YELLOW, -1)
            curses.init_pair(7, curses.COLOR_WHITE, -1)
            curses.init_pair(8, curses.COLOR_MAGENTA, -1)
            self.has_colors = True

            if curses.COLORS >= 256:
                # Prism gradient: violet → blue → cyan → green → yellow → white
                prism_colors = [135, 69, 39, 49, 228, 231]
                for i, c in enumerate(prism_colors):
                    curses.init_pair(10 + i, c, -1)
                self.has_flame = True
            else:
                prism_fallback = [
                    curses.COLOR_MAGENTA, curses.COLOR_BLUE, curses.COLOR_CYAN,
                    curses.COLOR_GREEN, curses.COLOR_YELLOW, curses.COLOR_WHITE,
                ]
                for i, c in enumerate(prism_fallback):
                    curses.init_pair(10 + i, c, -1)
                self.has_flame = True
        except Exception:
            self.has_colors = False

        self._show_splash(stdscr)

        while True:
            self._draw()
            ch = stdscr.getch()

            if self.editing_text:
                self._handle_text_edit(ch)
            else:
                action = self._handle_nav(ch)
                if action == 'quit':
                    return True

        return False

    def _cur_tab_items(self):
        return TABS[self.tab_idx][1]

    def _cur_item(self):
        items = self._cur_tab_items()
        if 0 <= self.item_idx < len(items):
            return items[self.item_idx]
        return None

    def _handle_nav(self, ch):
        import curses
        items = self._cur_tab_items()
        item = self._cur_item()

        if ch == ord('\t') or ch == 9:
            self.tab_idx = (self.tab_idx + 1) % len(TABS)
            self.item_idx = min(self.item_idx, len(self._cur_tab_items()) - 1)
            self.status_msg = ""
            return True

        if ch == curses.KEY_BTAB:
            self.tab_idx = (self.tab_idx - 1) % len(TABS)
            self.item_idx = min(self.item_idx, len(self._cur_tab_items()) - 1)
            self.status_msg = ""
            return True

        if ch == curses.KEY_UP:
            self.item_idx = max(0, self.item_idx - 1)
            return True

        if ch == curses.KEY_DOWN:
            self.item_idx = min(len(items) - 1, self.item_idx + 1)
            return True

        if item is None:
            return True

        key, label, typ, options, default, env_var = item

        if ch == curses.KEY_LEFT:
            if typ == 'choice':
                self._cycle_choice(key, options, -1)
            elif typ in ('text', 'secret'):
                self.tab_idx = (self.tab_idx - 1) % len(TABS)
                self.item_idx = min(self.item_idx, len(self._cur_tab_items()) - 1)
            return True

        if ch == curses.KEY_RIGHT:
            if typ == 'choice':
                self._cycle_choice(key, options, 1)
            elif typ in ('text', 'secret'):
                self.tab_idx = (self.tab_idx + 1) % len(TABS)
                self.item_idx = min(self.item_idx, len(self._cur_tab_items()) - 1)
            return True

        if ch == ord(' '):
            if typ == 'choice':
                self._cycle_choice(key, options, 1)
            return True

        if ch in (curses.KEY_ENTER, 10, 13):
            if typ in ('text', 'secret'):
                self.editing_text = True
                self.edit_buffer = str(self.cfg.get(key, default))
                self.edit_cursor = len(self.edit_buffer)
                curses.curs_set(1)
            elif typ == 'choice':
                self._cycle_choice(key, options, 1)
            return True

        # 's' to save
        if ch == ord('s'):
            save(self.cfg)
            synced = sync_claude_config()
            self.saved_cfg = dict(self.cfg)
            self.status_msg = "Saved!"
            if synced:
                self.status_msg += " (Claude Code config updated)"
            self.status_color = 4
            return True

        # 't' to test providers
        if ch == ord('t'):
            self.status_msg = "Testing providers..."
            self.status_color = 6
            self._draw()
            self.stdscr.refresh()
            # Save first so tests use current values
            save(self.cfg)
            results = check_provider_status()
            parts = []
            for name, status, ok in results:
                mark = "OK" if ok else "!!"
                parts.append(f"{name}: {mark} {status}")
            self.status_msg = "  |  ".join(parts)
            self.status_color = 4 if all(r[2] for r in results) else 6
            return True

        # '*' to toggle secret visibility
        if ch == ord('*'):
            self.show_secrets = not self.show_secrets
            return True

        if ch in (ord('q'), 27):
            # Check unsaved changes
            if self.cfg != self.saved_cfg:
                save(self.cfg)
                sync_claude_config()
            return 'quit'

        return True

    def _handle_text_edit(self, ch):
        import curses
        item = self._cur_item()
        if item is None:
            self.editing_text = False
            curses.curs_set(0)
            return

        key = item[0]

        if ch in (curses.KEY_ENTER, 10, 13):
            self.cfg[key] = self.edit_buffer
            self.editing_text = False
            curses.curs_set(0)
            return

        if ch == 27:
            self.editing_text = False
            curses.curs_set(0)
            return

        if ch in (curses.KEY_BACKSPACE, 127, 8):
            if self.edit_cursor > 0:
                self.edit_buffer = (self.edit_buffer[:self.edit_cursor-1] +
                                    self.edit_buffer[self.edit_cursor:])
                self.edit_cursor -= 1
            return

        if ch == curses.KEY_DC:
            if self.edit_cursor < len(self.edit_buffer):
                self.edit_buffer = (self.edit_buffer[:self.edit_cursor] +
                                    self.edit_buffer[self.edit_cursor+1:])
            return

        if ch == curses.KEY_LEFT:
            self.edit_cursor = max(0, self.edit_cursor - 1)
            return

        if ch == curses.KEY_RIGHT:
            self.edit_cursor = min(len(self.edit_buffer), self.edit_cursor + 1)
            return

        if ch == curses.KEY_HOME:
            self.edit_cursor = 0
            return

        if ch == curses.KEY_END:
            self.edit_cursor = len(self.edit_buffer)
            return

        if 32 <= ch < 127:
            self.edit_buffer = (self.edit_buffer[:self.edit_cursor] + chr(ch) +
                                self.edit_buffer[self.edit_cursor:])
            self.edit_cursor += 1

    def _cycle_choice(self, key, options, direction):
        cur = self.cfg.get(key, "")
        values = [o[0] for o in options]
        try:
            idx = values.index(cur)
        except ValueError:
            idx = 0
        idx = (idx + direction) % len(values)
        self.cfg[key] = values[idx]

    def _mask_secret(self, val):
        if not val:
            return "(not set)"
        if self.show_secrets:
            return val
        if len(val) <= 8:
            return "*" * len(val)
        return val[:4] + "*" * (len(val) - 8) + val[-4:]

    def _attr(self, pair, extra=0):
        import curses
        if self.has_colors:
            return curses.color_pair(pair) | extra
        return extra

    def _draw(self):
        import curses
        stdscr = self.stdscr
        stdscr.erase()
        h, w = stdscr.getmaxyx()

        if h < 10 or w < 40:
            stdscr.addstr(0, 0, "Terminal too small")
            stdscr.refresh()
            return

        border_attr = self._attr(7, curses.A_DIM) if self.has_colors else curses.A_DIM

        # Top border
        stdscr.addstr(0, 0, "+" + "-" * (w - 2) + "+"[:w], border_attr)

        # Side borders
        for row in range(1, h - 1):
            try:
                stdscr.addstr(row, 0, "|", border_attr)
                stdscr.addstr(row, w - 1, "|", border_attr)
            except curses.error:
                pass

        # Bottom border
        try:
            stdscr.addstr(h - 1, 0, ("+" + "-" * (w - 2) + "+")[:w-1], border_attr)
        except curses.error:
            pass

        # Banner
        show_banner = (h >= BANNER_H + 20 and w >= BANNER_W + 6)
        if show_banner:
            x_off = max(2, (w - BANNER_W) // 2)
            for bi, line in enumerate(BANNER):
                if self.has_flame:
                    attr = curses.color_pair(10 + bi) | curses.A_BOLD
                else:
                    attr = self._attr(6, curses.A_BOLD)
                try:
                    stdscr.addstr(1 + bi, x_off, line[:w-4], attr)
                except curses.error:
                    pass
            content_start = 1 + BANNER_H + 1
        else:
            title = " Prism-Relay Settings "
            if w > len(title) + 4:
                stdscr.addstr(0, 2, title, self._attr(8, curses.A_BOLD))
            content_start = 2

        # Provider status bar
        statuses = check_provider_status()
        status_row = content_start
        col = 3
        for name, status, ok in statuses:
            color = 4 if ok else 5
            dot = "●" if ok else "○"
            text = f"{dot} {name}"
            try:
                stdscr.addstr(status_row, col, text, self._attr(color, curses.A_BOLD))
            except curses.error:
                pass
            col += len(text) + 3
        content_start += 1

        # Tabs row
        row = content_start
        col = 3
        for ti, (tname, _) in enumerate(TABS):
            if ti == self.tab_idx:
                stdscr.addstr(row, col, f"[ {tname} ]", self._attr(1, curses.A_BOLD))
            else:
                stdscr.addstr(row, col, f"  {tname}  ", self._attr(7))
            col += len(tname) + 6

        # Separator
        row = content_start + 1
        stdscr.addstr(row, 2, ("-" * (w - 4))[:w-4], border_attr)

        # Items
        items = self._cur_tab_items()
        start_row = content_start + 3
        for ii, (key, label, typ, options, default, env_var) in enumerate(items):
            r = start_row + ii * 2
            if r >= h - 4:
                break

            selected = (ii == self.item_idx)
            ptr = ">" if selected else " "
            stdscr.addstr(r, 3, ptr, self._attr(6, curses.A_BOLD) if selected else 0)

            lbl_attr = self._attr(2) if selected else curses.A_NORMAL
            stdscr.addstr(r, 5, f"{label:<22}", lbl_attr)

            val_col = 28
            cur_val = self.cfg.get(key, default)

            if typ == 'choice':
                disp = str(cur_val)
                for oval, olbl in options:
                    if oval == cur_val:
                        disp = olbl
                        break
                arrows = "<" if selected else " "
                arrows_r = ">" if selected else " "
                stdscr.addstr(r, val_col, arrows, self._attr(6))
                stdscr.addstr(r, val_col + 2, disp[:w-val_col-6],
                              self._attr(3, curses.A_BOLD if selected else 0))
                end_col = val_col + 2 + len(disp[:w-val_col-6]) + 1
                if end_col < w - 2:
                    stdscr.addstr(r, end_col, arrows_r, self._attr(6))

            elif typ == 'secret':
                if self.editing_text and selected:
                    display = self.edit_buffer + " "
                    max_len = w - val_col - 4
                    stdscr.addstr(r, val_col, display[:max_len],
                                  self._attr(3, curses.A_UNDERLINE))
                    cpos = val_col + min(self.edit_cursor, max_len - 1)
                    try:
                        stdscr.move(r, cpos)
                    except curses.error:
                        pass
                else:
                    masked = self._mask_secret(str(cur_val))
                    color = 3 if cur_val else 5
                    stdscr.addstr(r, val_col, masked[:w-val_col-4],
                                  self._attr(color, curses.A_BOLD if selected else 0))

            elif typ == 'text':
                if self.editing_text and selected:
                    display = self.edit_buffer + " "
                    max_len = w - val_col - 4
                    stdscr.addstr(r, val_col, display[:max_len],
                                  self._attr(3, curses.A_UNDERLINE))
                    cpos = val_col + min(self.edit_cursor, max_len - 1)
                    try:
                        stdscr.move(r, cpos)
                    except curses.error:
                        pass
                else:
                    disp = str(cur_val) if cur_val else "(not set)"
                    color = 3 if cur_val else 5
                    stdscr.addstr(r, val_col, disp[:w-val_col-4],
                                  self._attr(color, curses.A_BOLD if selected else 0))

        # Status message
        if self.status_msg:
            try:
                stdscr.addstr(h - 4, 3, self.status_msg[:w-6],
                              self._attr(self.status_color, curses.A_BOLD))
            except curses.error:
                pass

        # Help line
        help_row = h - 2
        try:
            stdscr.addstr(help_row - 1, 2, ("-" * (w - 4))[:w-4], border_attr)
        except curses.error:
            pass

        if self.editing_text:
            help_text = "  Type to edit  |  Enter confirm  |  Esc cancel"
        else:
            help_text = ("  Up/Dn navigate  |  </>/Space cycle  |  "
                         "Enter edit  |  Tab switch  |  s save  |  t test  |  * secrets  |  q exit")
        try:
            stdscr.addstr(help_row, 2, help_text[:w-4], self._attr(6))
        except curses.error:
            pass

        stdscr.refresh()


# ── Tkinter GUI ─────────────────────────────────────────────────────────────

class SettingsGUI:

    BG      = '#0f1626'
    BG2     = '#1a2332'
    BG3     = '#243044'
    FG      = '#d4d4dc'
    FG_DIM  = '#7a8599'
    ACCENT  = '#a855f7'   # prism purple
    ACCENT2 = '#c084fc'
    ICE     = '#5eb8d4'
    OK_GRN  = '#22c55e'
    ERR_RED = '#ef4444'

    _SPLASH_CONFIG = os.path.join(os.path.expanduser('~'), '.config', 'prism-relay', 'splash.png')
    _SPLASH_LOCAL  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'splash.png')

    @property
    def SPLASH_IMG(self):
        if os.path.isfile(self._SPLASH_CONFIG):
            return self._SPLASH_CONFIG
        if os.path.isfile(self._SPLASH_LOCAL):
            return self._SPLASH_LOCAL
        return None

    def _show_splash(self, tk):
        """Display the splash image centered on screen for 1.5 seconds."""
        if load().get('show_splash', 'true') == 'false':
            return
        if not self.SPLASH_IMG:
            return
        splash = None
        try:
            from PIL import Image, ImageTk
            splash = tk.Tk()
            splash.overrideredirect(True)
            img = Image.open(self.SPLASH_IMG)
            orig_w, orig_h = img.size
            max_w = 600
            if orig_w > max_w:
                ratio = max_w / orig_w
                img = img.resize((max_w, int(orig_h * ratio)), Image.LANCZOS)
            cur_w, cur_h = img.size
            photo = ImageTk.PhotoImage(img)
            lbl = tk.Label(splash, image=photo, bg=self.BG, bd=0)
            lbl.image = photo
            lbl.pack()
            splash.update_idletasks()
            sw = splash.winfo_screenwidth()
            sh = splash.winfo_screenheight()
            x = int((sw - cur_w) / 2)
            y = int((sh - cur_h) / 2)
            splash.geometry(f"{cur_w}x{cur_h}+{x}+{y}")
            splash.update()
            splash.after(1000, splash.destroy)
            splash.mainloop()
        except Exception:
            import traceback
            traceback.print_exc()
            if splash and splash.winfo_exists():
                splash.destroy()

    def __init__(self):
        import tkinter as tk
        from tkinter import ttk
        self.tk = tk
        self.ttk = ttk

        # Show splash screen if image exists
        self._show_splash(tk)

        self.cfg = load()
        self.widgets = {}

        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title("Prism-Relay Settings")
        self.root.geometry("580x480")
        self.root.resizable(False, False)
        self.root.configure(bg=self.BG)

        # Style
        style = ttk.Style(self.root)
        style.theme_use('clam')

        style.configure('.', background=self.BG, foreground=self.FG)
        style.configure('TFrame', background=self.BG)
        style.configure('TLabel', background=self.BG, foreground=self.FG,
                         font=('sans-serif', 10))
        style.configure('TEntry', fieldbackground=self.BG3, foreground=self.FG,
                         insertcolor=self.FG)
        style.configure('TCombobox', fieldbackground=self.BG3, foreground=self.FG,
                         selectbackground=self.ACCENT, selectforeground='white')
        # Style the combobox dropdown list (Linux needs *Capitalized wildcards)
        self.root.option_add('*TCombobox*Listbox*Background', self.BG3)
        self.root.option_add('*TCombobox*Listbox*Foreground', self.FG)
        self.root.option_add('*TCombobox*Listbox*selectBackground', self.ACCENT)
        self.root.option_add('*TCombobox*Listbox*selectForeground', 'white')
        style.configure('TButton', background=self.BG3, foreground=self.FG,
                         font=('sans-serif', 10, 'bold'), padding=(12, 6))
        style.map('TButton',
                  background=[('active', self.ACCENT)],
                  foreground=[('active', 'white')])

        style.configure('Accent.TButton', background=self.ACCENT, foreground='white')
        style.map('Accent.TButton',
                  background=[('active', self.ACCENT2)])

        style.configure('Settings.TNotebook', background=self.BG,
                         bordercolor=self.BG3)
        style.configure('Settings.TNotebook.Tab', background=self.BG2,
                         foreground=self.FG_DIM, padding=(14, 5),
                         font=('sans-serif', 10, 'bold'))
        style.map('Settings.TNotebook.Tab',
                  background=[('selected', self.BG3)],
                  foreground=[('selected', self.ACCENT)])

        # Title
        title_frame = tk.Frame(self.root, bg=self.BG)
        title_frame.pack(fill='x', padx=15, pady=(12, 0))
        tk.Label(title_frame, text="PRISM-RELAY", bg=self.BG, fg=self.ACCENT,
                 font=('sans-serif', 16, 'bold')).pack(side='left')
        tk.Label(title_frame, text="  MCP Settings", bg=self.BG, fg=self.FG_DIM,
                 font=('sans-serif', 11)).pack(side='left', pady=(3, 0))

        # Status dots
        self.status_frame = tk.Frame(self.root, bg=self.BG)
        self.status_frame.pack(fill='x', padx=15, pady=(6, 4))
        self._update_status_dots()

        # Notebook
        nb = ttk.Notebook(self.root, style='Settings.TNotebook')
        nb.pack(fill='both', expand=True, padx=12, pady=(4, 6))

        for tab_name, items in TABS:
            frame = tk.Frame(nb, bg=self.BG2, padx=15, pady=12)
            nb.add(frame, text=tab_name)

            for row_i, (key, label, typ, options, default, env_var) in enumerate(items):
                tk.Label(frame, text=label + ":", bg=self.BG2, fg=self.FG,
                         font=('sans-serif', 10), anchor='w').grid(
                    row=row_i, column=0, sticky='w', pady=8, padx=(0, 15))

                cur_val = self.cfg.get(key, default)

                if typ == 'choice':
                    display_map = {olbl: oval for oval, olbl in options}
                    reverse_map = {oval: olbl for oval, olbl in options}
                    values = [olbl for _, olbl in options]
                    var = tk.StringVar(value=reverse_map.get(cur_val, str(cur_val)))
                    cb = ttk.Combobox(frame, textvariable=var, values=values,
                                      state='readonly', width=42)
                    cb.grid(row=row_i, column=1, sticky='ew', pady=8)
                    self.widgets[key] = ('choice', var, display_map)

                elif typ == 'secret':
                    var = tk.StringVar(value=str(cur_val))
                    ent_frame = tk.Frame(frame, bg=self.BG2)
                    ent_frame.grid(row=row_i, column=1, sticky='ew', pady=8)
                    ent = tk.Entry(ent_frame, textvariable=var, show='*',
                                   bg=self.BG3, fg=self.FG,
                                   insertbackground=self.FG, relief='flat',
                                   font=('monospace', 10), width=36)
                    ent.pack(side='left', fill='x', expand=True)
                    toggle_btn = tk.Button(ent_frame, text="Show", bg=self.BG3,
                                           fg=self.FG_DIM, relief='flat',
                                           font=('sans-serif', 8),
                                           command=lambda e=ent: self._toggle_show(e))
                    toggle_btn.pack(side='right', padx=(4, 0))
                    self.widgets[key] = ('text', var, None)

                elif typ == 'text':
                    var = tk.StringVar(value=str(cur_val))
                    ent = tk.Entry(frame, textvariable=var,
                                   bg=self.BG3, fg=self.FG,
                                   insertbackground=self.FG, relief='flat',
                                   font=('monospace', 10), width=44)
                    ent.grid(row=row_i, column=1, sticky='ew', pady=8)
                    self.widgets[key] = ('text', var, None)

                frame.columnconfigure(1, weight=1)

        # Buttons
        btn_frame = tk.Frame(self.root, bg=self.BG)
        btn_frame.pack(fill='x', padx=12, pady=(4, 12))

        ttk.Button(btn_frame, text="Test Providers",
                   command=self._test).pack(side='left', padx=4)
        ttk.Button(btn_frame, text="Defaults",
                   command=self._reset).pack(side='left', padx=4)
        ttk.Button(btn_frame, text="Save & Close", style='Accent.TButton',
                   command=self._save).pack(side='right', padx=4)
        ttk.Button(btn_frame, text="Cancel",
                   command=self.root.destroy).pack(side='right', padx=4)

        # Center on screen, then show
        self.root.update_idletasks()
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.root.geometry(f"+{(sw-580)//2}+{(sh-480)//2}")
        self.root.deiconify()

        self.root.mainloop()

    def _toggle_show(self, entry):
        if entry.cget('show') == '*':
            entry.config(show='')
        else:
            entry.config(show='*')

    def _update_status_dots(self):
        tk = self.tk
        for w in self.status_frame.winfo_children():
            w.destroy()
        statuses = check_provider_status()
        for name, status, ok in statuses:
            color = self.OK_GRN if ok else self.ERR_RED
            dot = "●" if ok else "○"
            tk.Label(self.status_frame, text=f" {dot} {name}: {status}",
                     bg=self.BG, fg=color,
                     font=('sans-serif', 9, 'bold')).pack(side='left', padx=(0, 12))

    def _collect(self):
        for key, (typ, var, extra) in self.widgets.items():
            if typ == 'choice':
                self.cfg[key] = extra.get(var.get(), var.get())
            else:
                self.cfg[key] = var.get()

    def _save(self):
        self._collect()
        save(self.cfg)
        sync_claude_config()
        self.root.destroy()

    def _reset(self):
        for key, (typ, var, extra) in self.widgets.items():
            default = DEFAULTS[key]
            if typ == 'choice':
                _, _, options, _, _, _ = [i for t in TABS for i in t[1] if i[0] == key][0:1] or [(None,)*6]
                # Find the schema entry
                for _t, _items in TABS:
                    for item in _items:
                        if item[0] == key:
                            options = item[3]
                            break
                if options:
                    for oval, olbl in options:
                        if oval == default:
                            var.set(olbl)
                            break
            else:
                var.set(str(default))

    def _test(self):
        self._collect()
        save(self.cfg)
        self._update_status_dots()


# ── CLI entry point ─────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(
        prog='prismmcp',
        description='Prism-Relay MCP — settings manager for multi-LLM query server')
    parser.add_argument('--tui', action='store_true', help='Force terminal UI')
    parser.add_argument('--gui', action='store_true', help='Force graphical UI')
    parser.add_argument('--status', action='store_true',
                        help='Print provider status and exit')
    parser.add_argument('--env', action='store_true',
                        help='Print env vars for shell export')
    parser.add_argument('--sync', action='store_true',
                        help='Sync settings to Claude Code config')
    args = parser.parse_args()

    if args.status:
        statuses = check_provider_status()
        for name, status, ok in statuses:
            mark = "OK" if ok else "!!"
            print(f"  {'●' if ok else '○'} {name}: {status}")
        sys.exit(0)

    if args.env:
        env = get_env_dict()
        for k, v in sorted(env.items()):
            print(f'export {k}="{v}"')
        sys.exit(0)

    if args.sync:
        if sync_claude_config():
            print("Claude Code config updated.")
        else:
            print("Could not update Claude Code config (prism-relay not found in ~/.claude.json).")
        sys.exit(0)

    if args.tui:
        SettingsTUI().run()
        return

    if args.gui:
        SettingsGUI()
        return

    # Auto-detect
    if os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'):
        try:
            SettingsGUI()
            return
        except Exception:
            pass

    SettingsTUI().run()


if __name__ == '__main__':
    main()
