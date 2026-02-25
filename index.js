#!/usr/bin/env node
// Copyright (c) 2026 Michael Burgus (https://github.com/NeuralDrifter)
// Licensed under the MIT License. See LICENSE file for details.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// --- Load settings from prismmcp config (falls back to env vars) ---

function loadSettings() {
  const cfgPath = join(homedir(), ".config", "prism-relay", "settings.json");
  try {
    return JSON.parse(readFileSync(cfgPath, "utf-8"));
  } catch {
    return {};
  }
}

function cfg(key, envVar, fallback) {
  // env vars take priority (set by Claude Code), then settings file, then fallback
  if (process.env[envVar]) return process.env[envVar];
  const settings = loadSettings();
  return settings[key] || fallback;
}

const TIMEOUT_MS = parseInt(cfg("timeout_ms", "LLM_TIMEOUT_MS", "120000"));
const LOG_CONVERSATIONS = cfg("log_conversations", "LOG_CONVERSATIONS", "true") === "true";
const LOG_DIR = join(homedir(), ".config", "prism-relay", "logs");

// --- Conversation logging (both sides: prompt sent + response received) ---

function logConversation({ tool, prompt, queries, durationMs }) {
  if (!LOG_CONVERSATIONS) return;

  try {
    mkdirSync(LOG_DIR, { recursive: true });

    const now = new Date();
    const ts = now.toISOString();
    // Filesystem-safe timestamp: 2026-02-19T14-30-00-123Z
    const fileSafe = ts.replace(/:/g, "-").replace(/\./g, "-");
    const providerNames = queries.map((q) => q.provider).join("+");
    const baseName = `${fileSafe}_${providerNames}`;

    // JSON log
    const jsonData = {
      timestamp: ts,
      tool,
      providers: queries.map((q) => q.provider),
      duration_ms: durationMs,
      queries: queries.map((q) => ({
        provider: q.provider,
        model: q.model,
        prompt: q.prompt,
        response: q.response,
        duration_ms: q.duration_ms,
        error: q.error || null,
      })),
    };
    writeFileSync(join(LOG_DIR, `${baseName}.json`), JSON.stringify(jsonData, null, 2));

    // Markdown log
    const date = ts.replace("T", " ").replace("Z", " UTC");
    let md = `# Prism-Relay — ${date}\n`;
    md += `**Tool:** ${tool} | **Duration:** ${(durationMs / 1000).toFixed(1)}s\n\n`;

    for (const q of queries) {
      if (queries.length > 1) {
        md += `---\n\n## ${PROVIDERS[q.provider]?.label || q.provider} (${q.model})\n\n`;
      } else {
        md += `**Provider:** ${PROVIDERS[q.provider]?.label || q.provider} | **Model:** ${q.model}\n\n`;
      }

      md += `## Prompt\n\n${q.prompt}\n\n`;

      if (q.error) {
        md += `## Error\n\n${q.error}\n\n`;
      } else {
        md += `## Response\n\n${q.response}\n\n`;
      }
    }

    writeFileSync(join(LOG_DIR, `${baseName}.md`), md);
  } catch {
    // Logging must never crash the server
  }
}

// --- Provider configs ---

const PROVIDERS = {
  anthropic: {
    label: "Anthropic Claude",
    defaultModel: cfg("anthropic_model", "ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929"),
    models: "claude-opus-4-6, claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001",
    mode: cfg("anthropic_mode", "ANTHROPIC_MODE", "cli"),   // "cli" or "api"
    apiKey: cfg("anthropic_api_key", "ANTHROPIC_API_KEY", ""),
  },
  gemini: {
    label: "Google Gemini",
    defaultModel: cfg("gemini_model", "GEMINI_MODEL", "gemini-3-pro-preview"),
    models: "gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, gemini-2.5-flash",
    mode: cfg("gemini_mode", "GEMINI_MODE", "cli"),          // "cli" or "api"
    apiKey: cfg("gemini_api_key", "GEMINI_API_KEY", ""),
  },
  deepseek: {
    label: "DeepSeek",
    defaultModel: cfg("deepseek_model", "DEEPSEEK_MODEL", "deepseek-chat"),
    models: "deepseek-chat (V3.2), deepseek-reasoner (V3.2 thinking)",
    baseUrl: cfg("deepseek_base_url", "DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
    apiKey: cfg("deepseek_api_key", "DEEPSEEK_API_KEY", ""),
  },
  lmstudio: {
    label: "LM Studio (local)",
    defaultModel: cfg("lmstudio_model", "LMSTUDIO_MODEL", ""),
    models: "whatever is loaded in LM Studio",
    baseUrl: cfg("lmstudio_base_url", "LMSTUDIO_BASE_URL", "http://localhost:1234/v1"),
  },
};

// ============================================================
//  CLI providers (spawn local CLI tools)
// ============================================================

// --- Gemini CLI ---

function queryGeminiCLI(prompt, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ["--prompt", prompt, "-o", "text"];
    if (model) args.push("--model", model);

    const proc = spawn("gemini", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Gemini CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Gemini CLI exited with code ${code}: ${stderr}`));
      } else {
        const cleaned = stdout
          .split("\n")
          .filter(
            (l) =>
              !l.startsWith("Loaded cached credentials") &&
              !l.startsWith("Hook registry initialized")
          )
          .join("\n")
          .trim();
        resolve(cleaned);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn gemini CLI: ${err.message}`));
    });
  });
}

// --- Anthropic Claude CLI ---

function queryAnthropicCLI(prompt, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "text"];
    if (model) args.push("--model", model);
    args.push("--no-session-persistence");

    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });
  });
}

// ============================================================
//  API providers (direct HTTP calls)
// ============================================================

// --- Anthropic Claude API ---

async function queryAnthropicAPI(apiKey, model, prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    const text = data.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n") || "";
    return text.trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// --- Gemini API ---

async function queryGeminiAPI(apiKey, model, prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) throw new Error("No response from Gemini API");
    return parts.map((p) => p.text || "").join("\n").trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// --- OpenAI-compatible provider (DeepSeek, LM Studio) ---

async function queryOpenAICompat(baseUrl, apiKey, model, prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${body}`);
    }

    const data = await resp.json();

    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("No response from API");

    let result = "";
    if (msg.reasoning_content) {
      result += `<thinking>\n${msg.reasoning_content}\n</thinking>\n\n`;
    }
    result += msg.content || "";
    return result.trim();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// --- Resolve LM Studio model ---

async function resolveLMStudioModel(cfg) {
  try {
    const resp = await fetch(`${cfg.baseUrl}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await resp.json();
    if (data.data?.length > 0) return data.data[0].id;
    throw new Error("No models loaded in LM Studio");
  } catch (err) {
    throw new Error(
      `LM Studio not reachable at ${cfg.baseUrl}. Is it running? (${err.message})`
    );
  }
}

// ============================================================
//  Dispatch single query
// ============================================================

async function queryLLM(provider, prompt, model) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  const effectiveModel = model || cfg.defaultModel;

  switch (provider) {
    case "anthropic":
      if (cfg.mode === "api") {
        if (!cfg.apiKey) {
          throw new Error(
            "Anthropic mode is 'api' but ANTHROPIC_API_KEY is not set. " +
            "Set the key or switch to cli mode (ANTHROPIC_MODE=cli)."
          );
        }
        return {
          provider,
          label: `${cfg.label} (API)`,
          text: await queryAnthropicAPI(cfg.apiKey, effectiveModel, prompt, TIMEOUT_MS),
          model: effectiveModel,
        };
      } else {
        return {
          provider,
          label: `${cfg.label} (CLI)`,
          text: await queryAnthropicCLI(prompt, effectiveModel, TIMEOUT_MS),
          model: effectiveModel,
        };
      }

    case "gemini":
      if (cfg.mode === "api") {
        if (!cfg.apiKey) {
          throw new Error(
            "Gemini mode is 'api' but GEMINI_API_KEY is not set. " +
            "Set the key or switch to cli mode (GEMINI_MODE=cli)."
          );
        }
        return {
          provider,
          label: `${cfg.label} (API)`,
          text: await queryGeminiAPI(cfg.apiKey, effectiveModel, prompt, TIMEOUT_MS),
          model: effectiveModel,
        };
      } else {
        return {
          provider,
          label: `${cfg.label} (CLI)`,
          text: await queryGeminiCLI(prompt, effectiveModel, TIMEOUT_MS),
          model: effectiveModel,
        };
      }

    case "deepseek":
      if (!cfg.apiKey) {
        throw new Error(
          "DEEPSEEK_API_KEY not set. Get one at https://platform.deepseek.com/api_keys"
        );
      }
      return {
        provider,
        label: cfg.label,
        text: await queryOpenAICompat(
          cfg.baseUrl, cfg.apiKey, effectiveModel, prompt, TIMEOUT_MS
        ),
        model: effectiveModel,
      };

    case "lmstudio": {
      const lmModel = effectiveModel || await resolveLMStudioModel(cfg);
      return {
        provider,
        label: cfg.label,
        text: await queryOpenAICompat(
          cfg.baseUrl, null, lmModel, prompt, TIMEOUT_MS
        ),
        model: lmModel,
      };
    }
  }
}

// ============================================================
//  Code bundling (reads files server-side, never enters caller's context)
// ============================================================

// ──────────────────────────────────────────────────────────────
//  ALWAYS_EXCLUDE — binary, media, database, archive, OS junk
//  These are NEVER useful as code context regardless of project.
//  Applied unconditionally whether .gitignore exists or not.
// ──────────────────────────────────────────────────────────────

const ALWAYS_EXCLUDE = [
  // ── Version control internals ──
  ".git/", ".hg/", ".svn/",

  // ── Compiled objects & native libraries ──
  "*.o", "*.a", "*.so", "*.so.*", "*.dylib", "*.dll", "*.exe", "*.out",
  "*.bin", "*.elf", "*.obj", "*.lib", "*.exp", "*.pdb",
  "*.ko", "*.mod.c",                             // Linux kernel modules (NOT *.mod — conflicts with go.mod)
  "*.class",                                    // Java bytecode
  "*.pyc", "*.pyo",                             // Python bytecode
  "*.wasm",                                     // WebAssembly
  "*.beam",                                     // Erlang/Elixir BEAM
  "*.Hi", "*.dyn_hi", "*.dyn_o",               // Haskell interface/object
  "*.cmx", "*.cmo", "*.cmi", "*.cma", "*.cmxa",// OCaml
  "*.luac",                                     // Lua bytecode
  "*.rlib",                                     // Rust library
  // NOT *.d (conflicts with D language source files)
  "*.int", "*.idy",                             // COBOL intermediates (GnuCOBOL)
  "*.mojopkg",                                  // Mojo compiled package
  "*.ez",                                       // Erlang archive

  // ── Archives & packages ──
  "*.zip", "*.tar", "*.gz", "*.tgz", "*.bz2", "*.xz", "*.zst",
  "*.rar", "*.7z", "*.lz4", "*.lzma", "*.cab",
  "*.jar", "*.war", "*.ear",                   // Java archives
  "*.deb", "*.rpm", "*.apk", "*.snap",         // System packages
  "*.dmg", "*.iso", "*.img",                   // Disk images
  "*.nupkg", "*.snupkg",                       // NuGet
  "*.gem",                                      // Ruby gem
  "*.whl",                                      // Python wheel
  "*.crate",                                    // Rust crate

  // ── Images ──
  "*.jpg", "*.jpeg", "*.png", "*.gif", "*.bmp", "*.ico", "*.icns",
  "*.svg", "*.webp", "*.tiff", "*.tif", "*.psd", "*.ai", "*.eps",
  "*.raw", "*.cr2", "*.nef", "*.heic", "*.heif", "*.avif",
  "*.xcf",                                      // GIMP

  // ── Audio ──
  "*.mp3", "*.wav", "*.flac", "*.ogg", "*.aac", "*.m4a", "*.wma",
  "*.opus", "*.aiff", "*.mid", "*.midi",

  // ── Video ──
  "*.mp4", "*.avi", "*.mov", "*.mkv", "*.wmv", "*.webm", "*.flv",
  "*.m4v", "*.3gp", "*.mpg", "*.mpeg",

  // ── Fonts ──
  "*.ttf", "*.otf", "*.woff", "*.woff2", "*.eot",

  // ── Documents & office ──
  "*.pdf", "*.doc", "*.docx", "*.xls", "*.xlsx", "*.ppt", "*.pptx",
  "*.odt", "*.ods", "*.odp", "*.rtf",
  "*.pages", "*.numbers", "*.key",             // Apple iWork

  // ── Database files ──
  "*.db", "*.sqlite", "*.sqlite3", "*.sqlite-journal", "*.sqlite-wal", "*.sqlite-shm",
  "*.mdb", "*.accdb",                          // Access
  "*.ldf", "*.mdf", "*.ndf",                   // SQL Server
  "*.rdb", "dump.rdb",                         // Redis
  "*.frm", "*.MYD", "*.MYI", "*.ibd",         // MySQL/MariaDB
  "*.dbf", "*.fdb", "*.gdb",                   // dBASE / Firebird
  "*.kdb", "*.kdbx",                           // KeePass
  "*.bak",                                      // DB backups
  "*.dump",                                     // pg_dump / mysqldump

  // ── OS junk ──
  ".DS_Store", ".AppleDouble", ".LSOverride",
  "._*",                                        // macOS resource forks
  ".Spotlight-V100/", ".Trashes/", ".fseventsd/", ".VolumeIcon.icns",
  "Thumbs.db", "Thumbs.db:encryptable", "desktop.ini",
  "ehthumbs.db", "ehthumbs_vista.db",
  "$RECYCLE.BIN/", "*.lnk",
  ".directory",                                 // KDE

  // ── Editor temp / swap (never intentional code) ──
  "*.swp", "*.swo", "*~",                      // Vim swap
  "*#", ".#*",                                  // Emacs auto-save
  ".netrwhist", "Session.vim",                  // Vim history/session
];

// ──────────────────────────────────────────────────────────────
//  FALLBACK_EXCLUDES — comprehensive gitignore best practices
//  Applied ONLY when no .gitignore is found in the project root.
//  Covers all major languages, frameworks, IDEs, and toolchains.
//  Based on GitHub's official gitignore templates.
// ──────────────────────────────────────────────────────────────

const FALLBACK_EXCLUDES = [

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Build output directories (multi-language)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "build/", "dist/", "out/", "output/", "target/",
  "bin/", "obj/", "lib/",
  "release/", "debug/", "Release/", "Debug/",
  "_build/",                                    // Elixir Mix, CMake
  "cmake-build-*/",                             // CLion CMake profiles
  "CMakeFiles/", "CMakeCache.txt",              // CMake generated
  "install_manifest.txt",                       // CMake install
  "*.cmake",                                    // CMake generated (not CMakeLists)

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  C / C++ / Fortran
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "*.gch", "*.pch",                             // Precompiled headers
  "*.dSYM/",                                    // macOS debug symbols
  "*.su",                                       // GCC stack usage
  "*.map",                                      // Linker map
  "compile_commands.json",                      // Clang compilation database
  "_deps/",                                     // CMake FetchContent
  "*.mod",                                      // Fortran modules

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Python
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "__pycache__/", "*.py[cod]",
  "*.egg-info/", ".eggs/", "*.egg",
  "*.manifest", "*.spec",                       // PyInstaller
  ".Python", "develop-eggs/", "eggs/",
  "sdist/", "wheels/",
  ".installed.cfg",
  ".venv/", "venv/", "ENV/", "env/",           // Virtual environments
  ".pytest_cache/", ".mypy_cache/", ".ruff_cache/",
  ".pytype/", ".pyre/", ".pyright/",
  ".tox/", ".nox/",
  ".hypothesis/",
  "htmlcov/", ".coverage", ".coverage.*",
  "coverage.xml", "nosetests.xml",
  "pip-log.txt", "pip-delete-this-directory.txt",
  "Pipfile.lock", "poetry.lock",
  ".pdm.toml", ".pdm-python",
  "celerybeat-schedule", "celerybeat.pid",
  ".scrapy/",
  ".ipynb_checkpoints/",
  "profile_default/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  JavaScript / TypeScript / Node.js
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "node_modules/",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  ".npm/", ".yarn/",
  "bower_components/", "jspm_packages/",
  ".eslintcache", ".stylelintcache",
  "*.tsbuildinfo",                              // TypeScript build info
  ".node_repl_history",
  "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*",
  "lerna-debug.log*", ".pnpm-debug.log*",
  ".grunt/",
  ".fusebox/", ".dynamodb/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Java / Kotlin / Scala / JVM
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".gradle/", "gradle/",
  "gradlew", "gradlew.bat",                    // Gradle wrapper scripts
  ".m2/", ".mvn/",                              // Maven
  "*.ctxt",                                     // BlueJ
  "hs_err_pid*",                                // JVM crash logs
  "replay_pid*",                                // JVM replay
  ".factorypath",                               // Eclipse annotation processing
  ".apt_generated/", ".apt_generated_tests/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Go
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "go.sum",
  "vendor/",                                    // Go vendor (also PHP)

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Rust
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "Cargo.lock",                                 // Library lockfile
  ".cargo/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Zig
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "zig-cache/", "zig-out/", ".zig-cache/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Haskell
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".stack-work/", ".cabal-sandbox/",
  "cabal.sandbox.config",
  "dist-newstyle/",                             // Cabal new-build

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Elixir / Erlang
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "deps/",                                      // Mix dependencies
  "_build/",                                    // Mix build output
  ".fetch/",                                    // Mix fetch cache
  "erl_crash.dump",                             // Erlang crash dump
  // *.ez already in ALWAYS_EXCLUDE

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Ruby
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".bundle/",
  "Gemfile.lock",
  ".ruby-version", ".ruby-gemset",
  ".rvmrc",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  PHP
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "composer.lock",
  ".phpunit.result.cache",
  ".php_cs.cache", ".php-cs-fixer.cache",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  C# / .NET
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "[Bb]in/", "[Oo]bj/",
  "*.suo", "*.user", "*.userosscache", "*.sln.docstates",
  "packages/",                                  // NuGet packages
  "project.lock.json",
  ".paket/",
  "BundleArtifacts/", "PublishProfiles/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Swift / Xcode
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".build/",                                    // Swift Package Manager
  "Package.resolved",
  "DerivedData/", "xcuserdata/",
  "*.xcworkspace/",
  "*.playground/",
  "Pods/",                                      // CocoaPods

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Dart / Flutter
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".dart_tool/", ".pub-cache/", ".pub/",
  "pubspec.lock",
  ".flutter-plugins", ".flutter-plugins-dependencies",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Julia
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "Manifest.toml",                              // Julia package manifest
  ".julia/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  R
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".Rhistory", ".Rdata", ".Ruserdata",
  ".Rproj.user/",
  "renv/library/", "renv.lock",
  "*.Rcheck/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Lua
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "lua_modules/", ".luarocks/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Perl
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "blib/", "_Inline/", "pm_to_blib",
  "MYMETA.*", "Makefile.old",
  "local/",                                     // local::lib

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Mojo (*.mojopkg already in ALWAYS_EXCLUDE)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".modular/", ".magic/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Nim / Crystal / D / V / OCaml
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "nimcache/", "nimble/",                       // Nim
  ".crystal/", "shard.lock",                    // Crystal
  ".dub/",                                      // D
  "_esy/", "_opam/",                            // OCaml

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  IDE / Editor / Tool configs
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // JetBrains (IntelliJ, CLion, PyCharm, GoLand, etc.)
  ".idea/", "*.iml", "*.iws", "*.ipr",
  // Visual Studio / VS Code
  ".vscode/", ".vs/",
  // Eclipse
  ".project", ".settings/", ".classpath", ".factorypath",
  // NetBeans
  "nbproject/", "nbbuild/", "nbdist/",
  // Sublime Text
  "*.sublime-workspace", "*.sublime-project",
  // Vim / Neovim (swap/session/history already in ALWAYS_EXCLUDE)
  ".vim/",
  // Emacs (auto-save markers already in ALWAYS_EXCLUDE)
  "*.elc", "auto-save-list/",
  // Xcode
  "*.xcodeproj/", "*.pbxuser",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Web frameworks
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".next/", ".nuxt/", ".svelte-kit/", ".output/",
  ".docusaurus/", ".gatsby/",
  ".parcel-cache/", ".turbo/",
  ".vercel/", ".netlify/", ".serverless/", ".amplify/",
  ".angular/", ".vite/",
  "storybook-static/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Testing & coverage
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "coverage/", ".nyc_output/", "htmlcov/",
  ".coverage", ".coverage.*",
  "coverage.xml", "lcov.info",
  "*.gcno", "*.gcda", "*.gcov",                // GCC coverage
  "test-results/", "test-reports/",
  ".scannerwork/",                              // SonarQube

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Logs
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "*.log", "logs/",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Infrastructure & DevOps
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".terraform/", "*.tfstate", "*.tfstate.*",
  ".vagrant/",
  ".ansible/",
  "*.retry",                                    // Ansible retry files
  "charts/", "helmfile.lock",                   // Helm

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Containers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ".docker/",
  "docker-compose.override.yml",

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  Temp, cache, misc
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  "tmp/", "temp/", ".tmp/", ".cache/",
  ".sass-cache/", ".connect-gems/",
  ".nix-profile/", ".nix-defexpr/",             // Nix
  "flake.lock",
  "result",                                     // Nix build output symlink
  ".direnv/",
  ".env.local", ".env.*.local",                 // Framework dotenv overrides
];

// --- Safe recursive directory walk (skips ALL symlinks — files AND directories) ---

function walkDir(rootPath) {
  const results = [];

  function walk(dir, prefix) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied, etc.
    }

    for (const entry of entries) {
      const relPath = prefix ? prefix + "/" + entry.name : entry.name;
      const fullPath = join(dir, entry.name);

      // Skip ALL symlinks — prevents escaping the project tree and infinite loops
      try {
        if (lstatSync(fullPath).isSymbolicLink()) continue;
      } catch {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }
  }

  walk(rootPath, "");
  return results;
}

// --- Simple glob matcher (for ALWAYS_EXCLUDE / FALLBACK_EXCLUDES / user excludes) ---

function matchesPattern(filePath, pattern) {
  const norm = filePath.replace(/\\/g, "/");
  if (pattern.startsWith("*.")) {
    return norm.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("/") || pattern.endsWith("/*")) {
    const dir = pattern.replace(/\/?\*?$/, "");
    return norm.startsWith(dir + "/") || norm.includes("/" + dir + "/");
  }
  const basename = norm.split("/").pop();
  return basename === pattern;
}

// --- .gitignore parser ---

function parseGitignoreFile(rootPath) {
  try {
    const raw = readFileSync(join(rootPath, ".gitignore"), "utf-8");
    const matchers = [];

    for (let line of raw.split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("!")) continue; // negation not supported (complex ordered eval)

      let dirOnly = false;
      if (line.endsWith("/")) {
        dirOnly = true;
        line = line.slice(0, -1);
      }

      let anchored = line.startsWith("/");
      if (anchored) line = line.slice(1);

      // Inner slash (not from **/) means path-anchored
      if (line.includes("/") && !line.startsWith("**/")) anchored = true;

      // Escape regex metacharacters, then convert globs
      let re = line
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "(?:.+/)?")    // **/ → zero or more directory levels
        .replace(/\/\*\*/g, "(?:/.*)?")     // /** → everything inside
        .replace(/\*\*/g, ".*")             // ** standalone → everything
        .replace(/\*/g, "[^/]*")            // * → anything except /
        .replace(/\?/g, "[^/]");            // ? → single char except /

      re = anchored ? "^" + re : "(?:^|/)" + re;
      re += dirOnly ? "(?:/|$)" : "(?:$|/)";

      try {
        matchers.push(new RegExp(re));
      } catch {
        // malformed pattern, skip
      }
    }

    return matchers.length > 0 ? matchers : null;
  } catch {
    return null; // no .gitignore found
  }
}

// --- Secret file detection ---

const SECRET_FILE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".crt",
  ".credentials", ".secret",
]);

const SECRET_FILE_NAMES = new Set([
  ".htpasswd", ".netrc", ".pgpass",
  "credentials.json", "service-account.json", "service_account.json",
  "secrets.json", "secrets.yaml", "secrets.yml", "secrets.toml",
  "token.json", "tokens.json",
  "id_rsa", "id_ed25519", "id_dsa", "id_ecdsa",
  "known_hosts",
]);

const SECRET_DIR_PREFIXES = [".ssh/", ".gnupg/", ".aws/", ".docker/", ".kube/"];

function isSecretFile(filePath) {
  const norm = filePath.replace(/\\/g, "/");
  const basename = norm.split("/").pop();

  // .env, .env.local, .env.production, etc.
  if (basename === ".env" || basename.startsWith(".env.")) return true;

  // Exact filename matches
  if (SECRET_FILE_NAMES.has(basename)) return true;

  // Extension matches
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx !== -1) {
    const ext = basename.slice(dotIdx);
    if (SECRET_FILE_EXTENSIONS.has(ext)) return true;
  }

  // Directory prefixes
  for (const dir of SECRET_DIR_PREFIXES) {
    if (norm.startsWith(dir) || norm.includes("/" + dir)) return true;
  }

  return false;
}

// --- Content-level secret redaction ---

const SECRET_VALUE_PATTERNS = [
  // Private key blocks (redact entire block)
  { re: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE KEY-----/g,
    replace: "[REDACTED: PRIVATE KEY BLOCK]" },
  // AWS access key IDs
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED:AWS_KEY]" },
  // OpenAI / Anthropic style keys
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED:API_KEY]" },
  // GitHub PATs
  { re: /\bghp_[A-Za-z0-9]{36}\b/g, replace: "[REDACTED:GH_TOKEN]" },
  { re: /\bgho_[A-Za-z0-9]{36}\b/g, replace: "[REDACTED:GH_TOKEN]" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replace: "[REDACTED:GH_TOKEN]" },
  // GitLab PATs
  { re: /\bglpat-[A-Za-z0-9\-]{20,}\b/g, replace: "[REDACTED:GL_TOKEN]" },
  // Slack tokens
  { re: /\bxox[bprs]-[A-Za-z0-9\-]+/g, replace: "[REDACTED:SLACK_TOKEN]" },
  // Generic Bearer tokens in strings/configs
  { re: /(\bBearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/g, replace: "$1[REDACTED:TOKEN]" },
];

// Key-value patterns: redact the value, keep the key name for context
const SECRET_KV_RE = new RegExp(
  "((?:API[_-]?KEY|SECRET[_-]?KEY|PASSWORD|PASSWD|TOKEN|AUTH[_-]?TOKEN|ACCESS[_-]?KEY|" +
  "PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|DB[_-]?PASSWORD|DATABASE[_-]?PASSWORD|" +
  "REDIS[_-]?PASSWORD|JWT[_-]?SECRET|ENCRYPTION[_-]?KEY|SIGNING[_-]?KEY|" +
  "WEBHOOK[_-]?SECRET|MASTER[_-]?KEY|APP[_-]?SECRET|SESSION[_-]?SECRET|" +
  "DEEPSEEK[_-]?API[_-]?KEY|ANTHROPIC[_-]?API[_-]?KEY|OPENAI[_-]?API[_-]?KEY|" +
  "GEMINI[_-]?API[_-]?KEY|HF[_-]?TOKEN|HUGGING[_-]?FACE[_-]?TOKEN)" +
  "\\s*[=:]\\s*[\"']?)([^\\s\"'\\n]{8,})",
  "gi"
);

function redactSecrets(content) {
  let result = content;
  let count = 0;

  // Pattern-based value redaction
  for (const { re, replace } of SECRET_VALUE_PATTERNS) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    result = result.replace(re, (match) => {
      count++;
      return typeof replace === "string" && replace.includes("$1")
        ? match.replace(re, replace)
        : replace;
    });
  }

  // Re-run value patterns properly (the $1 handling above is tricky with replace count)
  // Simpler: just do two passes
  result = content;
  count = 0;

  for (const { re, replace } of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    const before = result;
    result = result.replace(re, replace);
    if (result !== before) {
      // Count replacements by comparing
      re.lastIndex = 0;
      const matches = before.match(re);
      count += matches ? matches.length : 0;
    }
  }

  // Key-value redaction (keep key, redact value)
  const kvBefore = result;
  result = result.replace(SECRET_KV_RE, (match, prefix, value) => {
    count++;
    return `${prefix}[REDACTED]`;
  });

  return { content: result, redactedCount: count };
}

function bundleFiles(rootPath, includePatterns, excludePatterns, maxSizeKb) {
  const maxBytes = (maxSizeKb || 500) * 1024;

  // Try to load .gitignore from project root
  const gitignoreMatchers = parseGitignoreFile(rootPath);
  const hasGitignore = !!gitignoreMatchers;

  // Build exclusion list:
  //  - ALWAYS_EXCLUDE: binary, media, database, OS junk (always applied)
  //  - If .gitignore exists: use it for project-specific patterns
  //  - If no .gitignore: apply FALLBACK_EXCLUDES (broad best-practice rules)
  //  - Plus any user-specified extra excludes
  const simpleExcludes = [...ALWAYS_EXCLUDE];
  if (!hasGitignore) simpleExcludes.push(...FALLBACK_EXCLUDES);
  if (excludePatterns?.length) simpleExcludes.push(...excludePatterns);

  // Walk directory tree (skips symlinks to prevent escaping project or loops)
  let entries;
  try {
    entries = walkDir(rootPath);
  } catch (err) {
    throw new Error(`Cannot read directory "${rootPath}": ${err.message}`);
  }

  // Sort for consistent ordering
  const sorted = [...entries].sort();
  const files = [];
  const blockedSecrets = [];
  let bundle = "";
  let totalSize = 0;
  let truncatedCount = 0;
  let totalRedacted = 0;

  for (const relPath of sorted) {
    const fullPath = join(rootPath, relPath);
    const normalized = relPath.replace(/\\/g, "/");

    // Include filter (if specified, file must match at least one)
    if (includePatterns?.length > 0) {
      if (!includePatterns.some((p) => matchesPattern(normalized, p))) continue;
    }

    // Simple-pattern excludes (ALWAYS_EXCLUDE + fallback/user)
    if (simpleExcludes.some((p) => matchesPattern(normalized, p))) continue;

    // .gitignore regex excludes (if .gitignore was found)
    if (gitignoreMatchers && gitignoreMatchers.some((re) => re.test(normalized))) continue;

    // Secret file check — block entirely, never send to LLM
    if (isSecretFile(normalized)) {
      blockedSecrets.push(normalized);
      continue;
    }

    // Try to read as text
    try {
      const raw = readFileSync(fullPath, "utf-8");

      // Skip likely binary files (high ratio of non-printable chars)
      const sample = raw.slice(0, 1000);
      const nonPrintable = (sample.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
      if (sample.length > 0 && nonPrintable / sample.length > 0.1) continue;

      // Redact any secrets found in file content
      const { content, redactedCount } = redactSecrets(raw);
      totalRedacted += redactedCount;

      const section = `=== ${normalized} ===\n${content}\n\n`;

      if (totalSize + section.length > maxBytes) {
        truncatedCount++;
        continue;
      }

      bundle += section;
      totalSize += section.length;
      files.push(normalized);
    } catch {
      // Binary file or read error — skip silently
    }
  }

  // Prepend file listing header
  const sizeStr = totalSize > 1024
    ? `${(totalSize / 1024).toFixed(0)}KB`
    : `${totalSize}B`;
  let header = `=== Code Bundle: ${files.length} files, ${sizeStr} from ${rootPath} ===\n`;
  header += `=== Exclusions: ${hasGitignore ? ".gitignore + always-exclude" : "fallback best-practices + always-exclude"} ===\n`;
  header += files.join("\n") + "\n\n";

  if (truncatedCount > 0) {
    header += `(${truncatedCount} file(s) skipped — bundle size limit reached)\n\n`;
  }

  // Security warnings
  let securityWarning = "";
  if (blockedSecrets.length > 0) {
    securityWarning += `BLOCKED ${blockedSecrets.length} secret file(s): ${blockedSecrets.join(", ")}\n`;
  }
  if (totalRedacted > 0) {
    securityWarning += `REDACTED ${totalRedacted} secret value(s) found in bundled files\n`;
  }

  return {
    bundle: header + bundle,
    fileCount: files.length,
    totalSize,
    truncatedCount,
    files,
    blockedSecrets,
    totalRedacted,
    securityWarning,
    hasGitignore,
  };
}

// ============================================================
//  MCP Server
// ============================================================

const server = new McpServer({
  name: "prism-relay",
  version: "3.2.0",
});

const providerEnum = z
  .enum(["anthropic", "gemini", "deepseek", "lmstudio"])
  .describe(
    "anthropic = Anthropic Claude (cli or api mode). gemini = Google Gemini (cli or api mode). deepseek = DeepSeek API (cloud). lmstudio = local LM Studio."
  );

// Tool 1: Single provider query
server.tool(
  "prism_query",
  "Query a single LLM for analysis, reasoning, or a second opinion. Output-only — the target LLM cannot execute commands or modify files.",
  {
    provider: providerEnum,
    prompt: z.string().describe("The question or analysis request to send."),
    model: z.string().optional().describe(
      "Model override. Defaults: anthropic=claude-sonnet-4-5-20250929, gemini=gemini-3-pro-preview, deepseek=deepseek-reasoner, lmstudio=auto-detect."
    ),
    context: z.string().optional().describe(
      "Optional context to prepend (file contents, error logs, etc)."
    ),
  },
  async ({ provider, prompt, model, context }) => {
    let fullPrompt = "";
    if (context) fullPrompt += `Context:\n${context}\n\n`;
    fullPrompt += prompt;

    const t0 = Date.now();
    try {
      const r = await queryLLM(provider, fullPrompt, model);
      const elapsed = Date.now() - t0;
      logConversation({
        tool: "prism_query",
        prompt: fullPrompt,
        queries: [{ provider, model: r.model, prompt: fullPrompt, response: r.text, duration_ms: elapsed }],
        durationMs: elapsed,
      });
      return {
        content: [{
          type: "text",
          text: `[${r.label} — ${r.model}]\n\n${r.text}`,
        }],
      };
    } catch (err) {
      const elapsed = Date.now() - t0;
      logConversation({
        tool: "prism_query",
        prompt: fullPrompt,
        queries: [{ provider, model: model || PROVIDERS[provider]?.defaultModel || "unknown", prompt: fullPrompt, response: "", duration_ms: elapsed, error: err.message }],
        durationMs: elapsed,
      });
      return {
        content: [{
          type: "text",
          text: `Error querying ${PROVIDERS[provider].label}: ${err.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool 2: Multi-provider parallel query
server.tool(
  "prism_compare",
  "Query multiple LLMs with the same prompt in parallel and return all responses side-by-side for comparison. Use this when you want diverse perspectives or to cross-validate reasoning across models.",
  {
    providers: z
      .array(providerEnum)
      .min(2)
      .max(3)
      .describe("Which providers to query (2-3). e.g. [\"gemini\", \"deepseek\"]"),
    prompt: z.string().describe("The question sent to ALL providers."),
    context: z.string().optional().describe(
      "Optional context prepended for all providers."
    ),
  },
  async ({ providers, prompt, context }) => {
    let fullPrompt = "";
    if (context) fullPrompt += `Context:\n${context}\n\n`;
    fullPrompt += prompt;

    // Deduplicate
    const unique = [...new Set(providers)];

    // Fire all queries in parallel
    const t0 = Date.now();
    const settled = await Promise.allSettled(
      unique.map((p) => queryLLM(p, fullPrompt, null))
    );
    const elapsed = Date.now() - t0;

    // Build log entries + output
    const logQueries = [];
    const sections = [];
    for (let i = 0; i < unique.length; i++) {
      const p = unique[i];
      const result = settled[i];
      const label = PROVIDERS[p].label;

      if (result.status === "fulfilled") {
        const r = result.value;
        logQueries.push({ provider: p, model: r.model, prompt: fullPrompt, response: r.text, duration_ms: elapsed });
        sections.push(
          `${"=".repeat(60)}\n` +
          `${r.label} (${r.model})\n` +
          `${"=".repeat(60)}\n\n` +
          r.text
        );
      } else {
        logQueries.push({ provider: p, model: PROVIDERS[p]?.defaultModel || "unknown", prompt: fullPrompt, response: "", duration_ms: elapsed, error: result.reason?.message || "Unknown error" });
        sections.push(
          `${"=".repeat(60)}\n` +
          `${label} — ERROR\n` +
          `${"=".repeat(60)}\n\n` +
          result.reason?.message || "Unknown error"
        );
      }
    }

    logConversation({ tool: "prism_compare", prompt: fullPrompt, queries: logQueries, durationMs: elapsed });

    const successes = settled.filter((s) => s.status === "fulfilled").length;
    const failures = settled.length - successes;

    let header = `Prism-Relay: ${successes}/${settled.length} providers responded`;
    if (failures > 0) header += ` (${failures} failed)`;

    return {
      content: [{
        type: "text",
        text: header + "\n\n" + sections.join("\n\n"),
      }],
      isError: failures === settled.length,
    };
  }
);

// Tool 3: List providers and status
server.tool(
  "prism_providers",
  "List available LLM providers and their live status.",
  {},
  async () => {
    const { execSync } = await import("child_process");
    const lines = [];

    for (const [id, cfg] of Object.entries(PROVIDERS)) {
      let status = "unknown";
      let mode = "";

      if (id === "anthropic" || id === "gemini") {
        const cliName = id === "anthropic" ? "claude" : "gemini";
        mode = ` [mode: ${cfg.mode}]`;

        if (cfg.mode === "api") {
          status = cfg.apiKey
            ? "available (API key set)"
            : `unavailable (${id.toUpperCase()}_API_KEY not set)`;
        } else {
          try {
            execSync(`which ${cliName}`, { stdio: "ignore" });
            status = `available (${cliName} CLI installed)`;
          } catch {
            status = `unavailable (${cliName} CLI not found)`;
          }
        }

        // Also show fallback info
        const hasKey = !!cfg.apiKey;
        let hasCli = false;
        try {
          execSync(`which ${cliName}`, { stdio: "ignore" });
          hasCli = true;
        } catch {}

        const altMode = cfg.mode === "cli" ? "api" : "cli";
        const altReady = cfg.mode === "cli"
          ? (hasKey ? "ready" : "needs key")
          : (hasCli ? "ready" : "not installed");
        status += ` | ${altMode}: ${altReady}`;
      } else if (id === "deepseek") {
        status = cfg.apiKey
          ? "available (API key set)"
          : "unavailable (DEEPSEEK_API_KEY not set)";
      } else if (id === "lmstudio") {
        try {
          const resp = await fetch(`${cfg.baseUrl}/models`, {
            signal: AbortSignal.timeout(2000),
          });
          const data = await resp.json();
          const count = data.data?.length || 0;
          status = `available (${count} model${count !== 1 ? "s" : ""} loaded)`;
        } catch {
          status = `unavailable (not reachable at ${cfg.baseUrl})`;
        }
      }

      lines.push(
        `${cfg.label} [${id}]${mode}\n  Default model: ${cfg.defaultModel || "(auto-detect)"}\n  Models: ${cfg.models}\n  Status: ${status}`
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
    };
  }
);

// Tool 4: Bundle + query single provider
server.tool(
  "prism_bundle_query",
  "Bundle source files from a directory and query an LLM — code is read server-side and never enters the calling agent's context window. Use for code review, architecture questions, or second opinions on a codebase.",
  {
    provider: providerEnum,
    prompt: z.string().describe("The question or task for the LLM (the code bundle is prepended automatically)."),
    path: z.string().describe("Absolute path to the directory to bundle (e.g. /home/user/project/src)."),
    include: z.array(z.string()).optional().describe(
      'Glob patterns to include (e.g. ["*.cpp", "*.h"]). If omitted, all text files are included.'
    ),
    exclude: z.array(z.string()).optional().describe(
      "Extra glob patterns to exclude (node_modules/.git/build/ are excluded by default)."
    ),
    model: z.string().optional().describe("Model override."),
    max_size_kb: z.number().optional().describe("Max bundle size in KB (default 500)."),
  },
  async ({ provider, prompt, path: dirPath, include, exclude, model, max_size_kb }) => {
    try {
      const result = bundleFiles(dirPath, include, exclude, max_size_kb);

      if (result.fileCount === 0) {
        let msg = `No files matched in "${dirPath}" with the given patterns.`;
        if (result.blockedSecrets.length > 0) {
          msg += `\n(${result.blockedSecrets.length} file(s) were blocked as secrets: ${result.blockedSecrets.join(", ")})`;
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }

      const fullPrompt = `${result.bundle}\n---\n\n${prompt}`;
      const t0 = Date.now();
      const r = await queryLLM(provider, fullPrompt, model);
      const elapsed = Date.now() - t0;

      logConversation({
        tool: "prism_bundle_query",
        prompt: fullPrompt,
        queries: [{ provider, model: r.model, prompt: fullPrompt, response: r.text, duration_ms: elapsed }],
        durationMs: elapsed,
      });

      const sizeStr = result.totalSize > 1024 ? `${(result.totalSize / 1024).toFixed(0)}KB` : `${result.totalSize}B`;
      let meta = `[Bundle: ${result.fileCount} files, ${sizeStr} from ${dirPath}]`;
      if (result.truncatedCount > 0) meta += ` (${result.truncatedCount} skipped for size)`;
      if (result.securityWarning) meta += `\n[Security: ${result.securityWarning.trim()}]`;

      return {
        content: [{
          type: "text",
          text: `${meta}\n[${r.label} — ${r.model}]\n\n${r.text}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: Bundle + compare multiple providers
server.tool(
  "prism_bundle_compare",
  "Bundle source files from a directory and query multiple LLMs in parallel — code is read server-side, never enters the calling agent's context. Great for diverse perspectives on a codebase.",
  {
    providers: z.array(providerEnum).min(2).max(3).describe(
      'Which providers to query (2-3). e.g. ["gemini", "deepseek"]'
    ),
    prompt: z.string().describe("The question sent to ALL providers (code bundle prepended automatically)."),
    path: z.string().describe("Absolute path to the directory to bundle."),
    include: z.array(z.string()).optional().describe(
      'Glob patterns to include (e.g. ["*.cpp", "*.h"]). If omitted, all text files are included.'
    ),
    exclude: z.array(z.string()).optional().describe(
      "Extra glob patterns to exclude."
    ),
    max_size_kb: z.number().optional().describe("Max bundle size in KB (default 500)."),
  },
  async ({ providers, prompt, path: dirPath, include, exclude, max_size_kb }) => {
    try {
      const bResult = bundleFiles(dirPath, include, exclude, max_size_kb);

      if (bResult.fileCount === 0) {
        let msg = `No files matched in "${dirPath}" with the given patterns.`;
        if (bResult.blockedSecrets.length > 0) {
          msg += `\n(${bResult.blockedSecrets.length} file(s) were blocked as secrets: ${bResult.blockedSecrets.join(", ")})`;
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }

      const fullPrompt = `${bResult.bundle}\n---\n\n${prompt}`;
      const unique = [...new Set(providers)];
      const t0 = Date.now();
      const settled = await Promise.allSettled(
        unique.map((p) => queryLLM(p, fullPrompt, null))
      );
      const elapsed = Date.now() - t0;

      const sizeStr = bResult.totalSize > 1024 ? `${(bResult.totalSize / 1024).toFixed(0)}KB` : `${bResult.totalSize}B`;
      let meta = `[Bundle: ${bResult.fileCount} files, ${sizeStr} from ${dirPath}]`;
      if (bResult.truncatedCount > 0) meta += ` (${bResult.truncatedCount} skipped for size)`;
      if (bResult.securityWarning) meta += `\n[Security: ${bResult.securityWarning.trim()}]`;

      const logQueries = [];
      const sections = [];
      for (let i = 0; i < unique.length; i++) {
        const p = unique[i];
        const result = settled[i];
        const label = PROVIDERS[p].label;

        if (result.status === "fulfilled") {
          const r = result.value;
          logQueries.push({ provider: p, model: r.model, prompt: fullPrompt, response: r.text, duration_ms: elapsed });
          sections.push(
            `${"=".repeat(60)}\n` +
            `${r.label} (${r.model})\n` +
            `${"=".repeat(60)}\n\n` +
            r.text
          );
        } else {
          logQueries.push({ provider: p, model: PROVIDERS[p]?.defaultModel || "unknown", prompt: fullPrompt, response: "", duration_ms: elapsed, error: result.reason?.message || "Unknown error" });
          sections.push(
            `${"=".repeat(60)}\n` +
            `${label} — ERROR\n` +
            `${"=".repeat(60)}\n\n` +
            (result.reason?.message || "Unknown error")
          );
        }
      }

      logConversation({ tool: "prism_bundle_compare", prompt: fullPrompt, queries: logQueries, durationMs: elapsed });

      const successes = settled.filter((s) => s.status === "fulfilled").length;
      const failures = settled.length - successes;
      let header = `${meta}\nPrism-Relay: ${successes}/${settled.length} providers responded`;
      if (failures > 0) header += ` (${failures} failed)`;

      return {
        content: [{
          type: "text",
          text: header + "\n\n" + sections.join("\n\n"),
        }],
        isError: failures === settled.length,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
