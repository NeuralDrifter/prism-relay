#!/usr/bin/env node
// Copyright (c) 2026 Michael Burgus (https://github.com/NeuralDrifter)
// Licensed under the MIT License. See LICENSE file for details.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import { readFileSync } from "fs";
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
//  MCP Server
// ============================================================

const server = new McpServer({
  name: "prism-relay",
  version: "3.1.0",
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

    try {
      const r = await queryLLM(provider, fullPrompt, model);
      return {
        content: [{
          type: "text",
          text: `[${r.label} — ${r.model}]\n\n${r.text}`,
        }],
      };
    } catch (err) {
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
    const settled = await Promise.allSettled(
      unique.map((p) => queryLLM(p, fullPrompt, null))
    );

    // Build output
    const sections = [];
    for (let i = 0; i < unique.length; i++) {
      const p = unique[i];
      const result = settled[i];
      const label = PROVIDERS[p].label;

      if (result.status === "fulfilled") {
        const r = result.value;
        sections.push(
          `${"=".repeat(60)}\n` +
          `${r.label} (${r.model})\n` +
          `${"=".repeat(60)}\n\n` +
          r.text
        );
      } else {
        sections.push(
          `${"=".repeat(60)}\n` +
          `${label} — ERROR\n` +
          `${"=".repeat(60)}\n\n` +
          result.reason?.message || "Unknown error"
        );
      }
    }

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

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
