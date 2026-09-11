#!/usr/bin/env node
/**
 * Launch or inspect Cursor Cloud Agents from GitHub Actions.
 * Never logs CURSOR_API_KEY. Browser callers cannot use api.cursor.com
 * from github.io because CORS only allows the cursor.com origin.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.cursor.com/v1";
const ALLOWED_REPO_OWNERS = Object.freeze(["berkyuo2-cpu"]);
const DEFAULT_REPOSITORY =
  "https://github.com/berkyuo2-cpu/berkyuo2-cpu.github.io";
const AGENT_ID_PATTERN = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export {
  API_BASE,
  ALLOWED_REPO_OWNERS,
  DEFAULT_REPOSITORY,
  AGENT_ID_PATTERN,
  AuthRequiredError,
  ConfigError,
  parseBoolean,
  parseArgs,
  resolveConfig,
  normalizeRepository,
  assertAllowedRepository,
  assertAgentId,
  buildLaunchPayload,
  buildFollowupPayload,
  runRemoteCursor,
};

class AuthRequiredError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "AuthRequiredError";
    this.exitCode = 2;
  }
}

class ConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.exitCode = 1;
  }
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new ConfigError(`Geçersiz boolean değer: ${value}`);
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  const args = argv.slice(2);
  if (args[0] && !args[0].startsWith("-")) {
    out.action = args.shift();
  }
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new ConfigError(`Beklenmeyen argüman: ${token}`);
    }
    const key = token.slice(2);
    const next = args[0];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    args.shift();
    out[key] = next;
  }
  return out;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} argv
 */
function resolveConfig(env, argv) {
  const args = parseArgs(argv);
  const action = String(
    env.CURSOR_REMOTE_ACTION || args.action || "",
  ).trim();
  const prompt = env.CURSOR_REMOTE_PROMPT ?? args.prompt ?? "";
  const repository = String(
    env.CURSOR_REMOTE_REPOSITORY ||
      args.repository ||
      DEFAULT_REPOSITORY,
  ).trim();
  const agentId = String(
    env.CURSOR_REMOTE_AGENT_ID || args["agent-id"] || args.agent_id || "",
  ).trim();
  const mode = String(env.CURSOR_REMOTE_MODE || args.mode || "agent")
    .trim()
    .toLowerCase();
  const autoCreatePr = parseBoolean(
    env.CURSOR_REMOTE_AUTO_CREATE_PR ?? args["auto-create-pr"],
    true,
  );
  const dryRun = parseBoolean(
    env.CURSOR_REMOTE_DRY_RUN ?? args.dryRun,
    false,
  );
  const apiKey = String(env.CURSOR_API_KEY || "").trim();

  if (!action) {
    throw new ConfigError("İşlem gerekli: launch | followup | list");
  }

  return {
    action,
    prompt: String(prompt),
    repository,
    agentId,
    mode,
    autoCreatePr,
    dryRun,
    apiKey,
  };
}

/**
 * @param {string} url
 * @returns {string}
 */
function normalizeRepository(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`Geçersiz repo URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigError("Repo URL https olmalıdır.");
  }
  if (parsed.hostname !== "github.com") {
    throw new ConfigError("Yalnızca github.com depoları kullanılabilir.");
  }
  const parts = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new ConfigError("Repo URL github.com/owner/name biçiminde olmalıdır.");
  }
  const [owner, name] = parts;
  if (name.endsWith(".git")) {
    return `https://github.com/${owner}/${name.slice(0, -4)}`;
  }
  return `https://github.com/${owner}/${name}`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function assertAllowedRepository(url) {
  const normalized = normalizeRepository(url);
  const owner = new URL(normalized).pathname.split("/").filter(Boolean)[0];
  if (!ALLOWED_REPO_OWNERS.includes(owner)) {
    throw new ConfigError(
      `Repo sahibi izin listesinde değil (${owner}).`,
    );
  }
  return normalized;
}

/**
 * @param {string} agentId
 * @returns {string}
 */
function assertAgentId(agentId) {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new ConfigError("agent_id bc-uuid biçiminde olmalıdır.");
  }
  return agentId;
}

/**
 * @param {{ prompt: string, repository: string, mode: string, autoCreatePr: boolean }} config
 */
function buildLaunchPayload(config) {
  const prompt = config.prompt.trim();
  if (!prompt) {
    throw new ConfigError("launch için prompt gerekli.");
  }
  if (config.mode !== "agent" && config.mode !== "plan") {
    throw new ConfigError("mode yalnızca agent veya plan olabilir.");
  }
  const repository = assertAllowedRepository(config.repository);
  return {
    prompt: { text: prompt },
    repos: [{ url: repository, startingRef: "main" }],
    autoCreatePR: config.autoCreatePr,
    mode: config.mode,
  };
}

/**
 * @param {{ prompt: string, agentId: string, mode: string }} config
 */
function buildFollowupPayload(config) {
  const prompt = config.prompt.trim();
  if (!prompt) {
    throw new ConfigError("followup için prompt gerekli.");
  }
  if (config.mode !== "agent" && config.mode !== "plan") {
    throw new ConfigError("mode yalnızca agent veya plan olabilir.");
  }
  return {
    agentId: assertAgentId(config.agentId),
    body: {
      prompt: { text: prompt },
      mode: config.mode,
    },
  };
}

/**
 * @param {object} config
 * @param {{ fetch: typeof fetch, stdout?: { write: (s: string) => void }, stderr?: { write: (s: string) => void } }} deps
 */
async function runRemoteCursor(config, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fetchFn = deps.fetch;

  if (!config.dryRun && !config.apiKey) {
    throw new AuthRequiredError(
      "AUTH_REQUIRED: CURSOR_API_KEY yok. GitHub repo Settings → Secrets and variables → Actions altına ekle.",
    );
  }

  switch (config.action) {
    case "launch": {
      const payload = buildLaunchPayload(config);
      if (config.dryRun) {
        stdout.write(`${JSON.stringify({ action: "launch", payload }, null, 2)}\n`);
        return { action: "launch", payload };
      }
      const data = await cursorRequest(fetchFn, config.apiKey, "/agents", {
        method: "POST",
        body: payload,
      });
      const url = data?.agent?.url || "";
      stdout.write(`LAUNCHED ${data?.agent?.id || ""}\n`);
      if (url) stdout.write(`${url}\n`);
      return data;
    }
    case "followup": {
      const payload = buildFollowupPayload(config);
      if (config.dryRun) {
        stdout.write(`${JSON.stringify({ action: "followup", payload }, null, 2)}\n`);
        return { action: "followup", payload };
      }
      const data = await cursorRequest(
        fetchFn,
        config.apiKey,
        `/agents/${payload.agentId}/runs`,
        { method: "POST", body: payload.body },
      );
      stdout.write(`FOLLOWUP ${payload.agentId} ${data?.run?.id || ""}\n`);
      stdout.write(`https://cursor.com/agents/${payload.agentId}\n`);
      return data;
    }
    case "list": {
      if (config.dryRun) {
        stdout.write(`${JSON.stringify({ action: "list", path: "/agents" }, null, 2)}\n`);
        return { action: "list" };
      }
      const data = await cursorRequest(
        fetchFn,
        config.apiKey,
        "/agents?limit=20&includeArchived=false",
        { method: "GET" },
      );
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length === 0) {
        stdout.write("Aktif ajan yok.\n");
        return data;
      }
      for (const item of items) {
        stdout.write(
          `${item.status || "UNKNOWN"}\t${item.id || ""}\t${item.name || ""}\t${item.url || ""}\n`,
        );
      }
      return data;
    }
    default:
      throw new ConfigError(
        `Bilinmeyen işlem: ${config.action}. launch | followup | list kullan.`,
      );
  }
}

/**
 * @param {typeof fetch} fetchFn
 * @param {string} apiKey
 * @param {string} path
 * @param {{ method: string, body?: unknown }} options
 */
async function cursorRequest(fetchFn, apiKey, path, options) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  /** @type {RequestInit} */
  const init = { method: options.method, headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetchFn(`${API_BASE}${path}`, init);
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const message =
      parsed?.message || parsed?.error || `HTTP ${response.status}`;
    throw new ConfigError(`Cursor API ${response.status}: ${message}`);
  }
  return parsed;
}

async function main() {
  try {
    const config = resolveConfig(process.env, process.argv);
    await runRemoteCursor(config, { fetch: globalThis.fetch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    const exitCode =
      error instanceof AuthRequiredError || error instanceof ConfigError
        ? error.exitCode
        : 1;
    process.exitCode = exitCode;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";

if (invokedPath === import.meta.url) {
  await main();
}
