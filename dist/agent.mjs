// src/main.ts
import { spawn as spawn2 } from "node:child_process";
import { createInterface } from "node:readline";

// src/acp-stdio.ts
import { spawn } from "node:child_process";
var ACP_DEFAULT_APP_DATA_DIR = "antigravity-cli";
var MAX_FRAME_BYTES = 4e6;
var MAX_BUFFER_BYTES = 8e6;
var MAX_PENDING = 64;
var MAX_STDERR_BYTES = 16384;
function createAcpStdio(input) {
  const spawnImpl = input.spawnImpl ?? spawn;
  const appDataDir = input.appDataDir ?? ACP_DEFAULT_APP_DATA_DIR;
  const args = appDataDir === "antigravity-cli" ? ["acp"] : ["acp", "--app-data-dir", appDataDir];
  const child = spawnImpl(input.binaryPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: input.env ?? process.env,
    ...input.cwd ? { cwd: input.cwd } : {}
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let closed = false;
  const pending = /* @__PURE__ */ new Map();
  const notificationHandlers = /* @__PURE__ */ new Set();
  let requestHandler;
  const exitHandlers = /* @__PURE__ */ new Set();
  const failAll = (error) => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const handler of exitHandlers) handler(error.message);
  };
  const write2 = (message) => {
    if (closed) throw new Error("antigravity acp process is closed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}
`);
  };
  const handleMessage = (message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      throw new Error("antigravity acp sent a non-object JSON-RPC frame");
    }
    const rec = message;
    const id = rec.id;
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof rec.method === "string" && hasId) {
      const handler = requestHandler;
      if (handler === void 0) {
        write2({ id, error: { code: -32601, message: `no handler for ${rec.method}` } });
        return;
      }
      void handler(id, rec.method, rec.params).then(
        (result) => {
          if (!closed) write2({ id, result });
        },
        (error) => {
          if (!closed) {
            write2({
              id,
              error: { code: -32e3, message: error instanceof Error ? error.message : String(error) }
            });
          }
        }
      );
      return;
    }
    if (typeof rec.method === "string" && !hasId) {
      for (const handler of notificationHandlers) handler(rec.method, rec.params);
      return;
    }
    if (hasId) {
      const waiter = pending.get(id);
      if (waiter === void 0) return;
      pending.delete(id);
      if (rec.error !== void 0) {
        const err = rec.error;
        const detail = typeof err?.data === "string" && err.data.length > 0 ? `${typeof err.message === "string" ? err.message : "ACP error"}: ${err.data}` : typeof err?.message === "string" ? err.message : "antigravity acp error";
        waiter.reject(new Error(detail));
        return;
      }
      waiter.resolve(rec.result);
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      failAll(new Error("antigravity acp stdout exceeded buffer bound"));
      child.kill();
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (line.length > MAX_FRAME_BYTES) {
        failAll(new Error("antigravity acp frame exceeded size bound"));
        child.kill();
        return;
      }
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        failAll(error instanceof Error ? error : new Error("antigravity acp malformed JSON"));
        child.kill();
        return;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
  });
  child.on("error", (error) => {
    failAll(error instanceof Error ? error : new Error("antigravity acp spawn failed"));
  });
  child.on("close", (code) => {
    const suffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
    failAll(new Error(`antigravity acp exited (${code ?? "null"})${suffix}`));
  });
  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error("antigravity acp process is closed"));
      if (pending.size >= MAX_PENDING) return Promise.reject(new Error("antigravity acp pending map is full"));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve2, reject) => {
        pending.set(id, { resolve: resolve2, reject });
        try {
          write2({ method, id, params });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(method, params) {
      if (!closed) write2({ method, params });
    },
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => {
        notificationHandlers.delete(handler);
      };
    },
    onRequest(handler) {
      requestHandler = handler;
      return () => {
        if (requestHandler === handler) requestHandler = void 0;
      };
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => {
        exitHandlers.delete(handler);
      };
    },
    dispose() {
      failAll(new Error("antigravity acp disposed"));
      child.kill();
    },
    pid() {
      return child.pid;
    }
  };
}

// src/binary.ts
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
function defaultExists(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function defaultFileExists(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
function resolveAntigravityBinary(hostBinaryPath, deps = {}) {
  const exists = deps.pathExists ?? defaultExists;
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();
  if (hostBinaryPath && hostBinaryPath !== "agy" && exists(hostBinaryPath)) {
    return hostBinaryPath;
  }
  const envOverride = env.AGY_CLI ?? env.ANTIGRAVITY_CLI;
  if (envOverride && exists(envOverride)) {
    return envOverride;
  }
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const name of ["agy", "agy.exe"]) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  const fallbackPaths = [
    "/Applications/Gemini.app/Contents/Helpers/agy",
    "/Applications/Antigravity.app/Contents/Helpers/agy",
    "/Applications/Antigravity.app/Contents/Resources/app/bin/agy",
    join(home, ".gemini", "antigravity", "bin", "agy"),
    join(home, ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy"
  ];
  for (const candidate of fallbackPaths) {
    if (exists(candidate)) return candidate;
  }
  return void 0;
}
function isUnusableAntigravityProbe(input) {
  const text = input.stderr.toLowerCase();
  return text.includes("command not found") || text.includes("no such file or directory");
}
function resolveAntigravityAppDataDir(sessionId, deps = {}) {
  if (!sessionId) return "antigravity-cli";
  const home = deps.homeDir ?? process.env.HOME ?? homedir();
  const exists = deps.fileExists ?? defaultFileExists;
  const cliDb = join(home, ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
  if (exists(cliDb)) return "antigravity-cli";
  const mainDb = join(home, ".gemini", "antigravity", "conversations", `${sessionId}.db`);
  if (exists(mainDb)) return "antigravity";
  return "antigravity-cli";
}
var UUID_DB_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i;
function listCliConversationDbFiles(homeDir = process.env.HOME ?? homedir()) {
  const dir = join(homeDir, ".gemini", "antigravity-cli", "conversations");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const name of names) {
    const match = UUID_DB_PATTERN.exec(name);
    const id = match?.[1];
    if (!id) continue;
    try {
      const stat = statSync(join(dir, name));
      results.push({ backendSessionId: id, lastChangeUnixMs: Math.round(stat.mtimeMs) });
    } catch {
    }
  }
  return results;
}

// src/types.ts
var PROTOCOL_VERSION = 1;
var AGENT_ID = "antigravity";

// src/frames.ts
function parseFrame(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return void 0;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const rec = value;
  if (rec.protocolVersion !== PROTOCOL_VERSION) return void 0;
  if (rec.kind === "request") {
    if (typeof rec.requestId !== "string" || typeof rec.method !== "string") return void 0;
    return rec;
  }
  if (rec.kind === "response" || rec.kind === "event") return rec;
  return void 0;
}
function requestFrame(scope, requestId, method, params) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "request", scope, requestId, method, params };
}
function okFrame(request, result) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    scope: request.scope,
    requestId: request.requestId,
    method: request.method,
    ok: true,
    result
  };
}
function errFrame(request, code, message) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    scope: request.scope,
    requestId: request.requestId,
    method: request.method,
    ok: false,
    error: { code, message }
  };
}
function eventFrame(scope, emission) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "event", scope, emission };
}

// src/capabilities.ts
var DEFAULT_ANTIGRAVITY_EFFORTS = ["low", "medium", "high"];
var DEFAULT_ANTIGRAVITY_MODELS = [
  {
    id: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    description: "Antigravity flagship Gemini 4 Carbon model with configurable thought level",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    description: "Antigravity Gemini 4 Argon model with configurable thought level",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    description: "Fast multimodal Gemini 3.8 Flash model with configurable thought level",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "Claude Opus 5.5 on Antigravity",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    description: "Claude Sonnet 5.5 on Antigravity",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS
  },
  {
    id: "gpt-oss-120b-medium",
    label: "GPT-OSS 120B (Medium)",
    description: "Open-weight 120B model on Antigravity"
  }
];
var DEFAULT_ANTIGRAVITY_MODES = [
  { id: "default", label: "Default", description: "Prompts for permission on dangerous operations" },
  { id: "accept-edits", label: "Accept Edits", description: "Automatically accepts file edit operations" },
  { id: "auto", label: "Auto", description: "Automatically approves all tool calls (YOLO mode)" },
  { id: "plan", label: "Plan", description: "Read-only mode; creates plans without modifying files" }
];
var DEFAULT_ANTIGRAVITY_OPTIONS = {
  agentId: AGENT_ID,
  models: DEFAULT_ANTIGRAVITY_MODELS,
  currentModelId: "gemini-4-carbon",
  currentEffortId: "medium",
  modes: DEFAULT_ANTIGRAVITY_MODES,
  currentModeId: "default",
  modeConfirmed: true,
  autoApprove: false,
  commands: []
};
var SUPPORTED = { supported: true };
function unsupported(reason) {
  return { supported: false, reason };
}
function antigravityCapabilities() {
  const operations = {
    prompt: SUPPORTED,
    cancel: SUPPORTED,
    queue: SUPPORTED,
    intervene: unsupported("Antigravity ACP does not expose mid-turn interventions"),
    setModel: SUPPORTED,
    setEffort: SUPPORTED,
    setMode: SUPPORTED,
    slashCommands: SUPPORTED,
    fileReferences: SUPPORTED,
    images: SUPPORTED,
    rename: SUPPORTED,
    delete: unsupported("Antigravity conversations live in ~/.gemini; archive in piwin to hide"),
    archive: SUPPORTED,
    pin: SUPPORTED,
    export: SUPPORTED,
    fork: unsupported("Antigravity ACP does not support session branching"),
    rewind: unsupported("Antigravity owns conversation history natively"),
    duplicate: unsupported("Antigravity ACP does not support duplicating trajectories"),
    pause: unsupported("Antigravity runs can be cancelled, not paused"),
    compact: unsupported("Antigravity manages context compaction automatically"),
    conversationTree: unsupported("Antigravity sessions have a linear transcript"),
    coldStorage: unsupported("Antigravity manages its own trajectory database"),
    hostSubagents: unsupported("Antigravity runs its own subagents internally"),
    hostTools: unsupported("Antigravity executes its own built-in and MCP tools")
  };
  return {
    agentId: AGENT_ID,
    operations,
    nativeCli: SUPPORTED
  };
}

// src/cli-launch.ts
function antigravityCliLaunch(backendSessionId) {
  if (!backendSessionId || backendSessionId.trim().length === 0) {
    throw new Error("Cannot launch Antigravity CLI without a bound conversation ID");
  }
  return {
    backendSessionId,
    args: ["--conversation", backendSessionId]
  };
}

// src/history.ts
import { readFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/options.ts
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
var EFFORT_SUFFIXES = ["low", "medium", "high"];
function splitCombinedModelAndEffort(rawModelId) {
  if (rawModelId === "gpt-oss-120b-medium") {
    return { baseModelId: rawModelId };
  }
  for (const effort of EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (rawModelId.endsWith(suffix)) {
      return {
        baseModelId: rawModelId.slice(0, -suffix.length),
        effortId: effort
      };
    }
  }
  return { baseModelId: rawModelId };
}
function parseAcpCommands(rawCommands) {
  if (!Array.isArray(rawCommands)) return [];
  const commands = [];
  for (const rawCmd of rawCommands) {
    const cmd = asRecord(rawCmd);
    if (!cmd || typeof cmd.name !== "string" || cmd.name.trim().length === 0) continue;
    const name = cmd.name.trim();
    const description = typeof cmd.description === "string" && cmd.description.trim().length > 0 ? cmd.description.trim() : void 0;
    const inputRec = asRecord(cmd.input);
    const inputHint = typeof inputRec?.hint === "string" && inputRec.hint.trim().length > 0 ? inputRec.hint.trim() : void 0;
    commands.push({
      name,
      ...description !== void 0 ? { description } : {},
      ...inputHint !== void 0 ? { inputHint } : {}
    });
  }
  return commands;
}
function parseAcpOptions(payload, fallback = DEFAULT_ANTIGRAVITY_OPTIONS) {
  const rec = asRecord(payload);
  if (!rec) return fallback;
  const configOptions = Array.isArray(rec.configOptions) ? rec.configOptions : [];
  const availableModelsBlock = asRecord(rec.models);
  const availableModels = Array.isArray(availableModelsBlock?.availableModels) ? availableModelsBlock.availableModels : [];
  let currentModelId;
  let currentEffortId;
  let currentModeId;
  const efforts = [];
  const models = [];
  const modes = [];
  const modelEffortsMap = /* @__PURE__ */ new Map();
  for (const item of availableModels) {
    const entry = asRecord(item);
    const modelId = typeof entry?.modelId === "string" ? entry.modelId : void 0;
    if (!modelId) continue;
    const { baseModelId, effortId } = splitCombinedModelAndEffort(modelId);
    if (effortId) {
      const list = modelEffortsMap.get(baseModelId) ?? [];
      if (!list.includes(effortId)) list.push(effortId);
      modelEffortsMap.set(baseModelId, list);
    }
  }
  for (const rawConfig of configOptions) {
    const cfg = asRecord(rawConfig);
    if (!cfg || typeof cfg.id !== "string") continue;
    const opts = Array.isArray(cfg.options) ? cfg.options : [];
    const currentValue = typeof cfg.currentValue === "string" ? cfg.currentValue : void 0;
    if (cfg.id === "thought_level" || cfg.category === "thought_level") {
      if (currentValue) currentEffortId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord(rawOpt);
        const value = typeof opt?.value === "string" ? opt.value : void 0;
        if (value && !efforts.includes(value)) efforts.push(value);
      }
    }
  }
  for (const rawConfig of configOptions) {
    const cfg = asRecord(rawConfig);
    if (!cfg || typeof cfg.id !== "string") continue;
    const opts = Array.isArray(cfg.options) ? cfg.options : [];
    const currentValue = typeof cfg.currentValue === "string" ? cfg.currentValue : void 0;
    if (cfg.id === "model" || cfg.category === "model") {
      if (currentValue) currentModelId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord(rawOpt);
        const id = typeof opt?.value === "string" ? opt.value : void 0;
        if (!id) continue;
        const label = typeof opt?.name === "string" && opt.name.trim().length > 0 ? opt.name.trim() : typeof opt?.label === "string" && opt.label.trim().length > 0 ? opt.label.trim() : id;
        const description = typeof opt?.description === "string" ? opt.description : void 0;
        const fallbackModel = fallback.models.find((m) => m.id === id);
        const knownEfforts = modelEffortsMap.get(id) ?? (id === "gpt-oss-120b-medium" ? void 0 : efforts.length > 0 ? efforts : fallbackModel?.efforts ? [...fallbackModel.efforts] : [...DEFAULT_ANTIGRAVITY_EFFORTS]);
        models.push({
          id,
          label,
          ...description !== void 0 ? { description } : {},
          ...knownEfforts && knownEfforts.length > 0 ? { efforts: knownEfforts } : {}
        });
      }
    } else if (cfg.id === "mode" || cfg.category === "mode") {
      if (currentValue) currentModeId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord(rawOpt);
        const id = typeof opt?.value === "string" ? opt.value : void 0;
        if (!id) continue;
        const label = typeof opt?.name === "string" && opt.name.trim().length > 0 ? opt.name.trim() : typeof opt?.label === "string" && opt.label.trim().length > 0 ? opt.label.trim() : id;
        const description = typeof opt?.description === "string" ? opt.description : void 0;
        modes.push({
          id,
          label,
          ...description !== void 0 ? { description } : {}
        });
      }
    }
  }
  if (models.length === 0 && availableModels.length > 0) {
    const seen = /* @__PURE__ */ new Set();
    for (const item of availableModels) {
      const entry = asRecord(item);
      const rawId = typeof entry?.modelId === "string" ? entry.modelId : void 0;
      if (!rawId) continue;
      const { baseModelId } = splitCombinedModelAndEffort(rawId);
      if (seen.has(baseModelId)) continue;
      seen.add(baseModelId);
      const rawName = typeof entry?.name === "string" ? entry.name : baseModelId;
      const label = rawName.replace(/\s*\((Low|Medium|High)\)\s*$/i, "").trim() || baseModelId;
      const description = typeof entry?.description === "string" ? entry.description : void 0;
      const knownEfforts = modelEffortsMap.get(baseModelId);
      models.push({
        id: baseModelId,
        label,
        ...description !== void 0 ? { description } : {},
        ...knownEfforts && knownEfforts.length > 0 ? { efforts: knownEfforts } : {}
      });
    }
  }
  if (!currentModelId && typeof availableModelsBlock?.currentModelId === "string") {
    const split = splitCombinedModelAndEffort(availableModelsBlock.currentModelId);
    currentModelId = split.baseModelId;
    if (!currentEffortId && split.effortId) {
      currentEffortId = split.effortId;
    }
  }
  const modesBlock = asRecord(rec.modes);
  if (modes.length === 0 && Array.isArray(modesBlock?.availableModes)) {
    for (const rawMode of modesBlock.availableModes) {
      const m = asRecord(rawMode);
      const id = typeof m?.id === "string" ? m.id : void 0;
      if (!id) continue;
      const label = typeof m?.name === "string" && m.name.trim().length > 0 ? m.name.trim() : typeof m?.label === "string" && m.label.trim().length > 0 ? m.label.trim() : id;
      const description = typeof m?.description === "string" ? m.description : void 0;
      modes.push({
        id,
        label,
        ...description !== void 0 ? { description } : {}
      });
    }
  }
  if (!currentModeId && typeof modesBlock?.currentModeId === "string") {
    currentModeId = modesBlock.currentModeId;
  }
  const finalModels = models.length > 0 ? models : fallback.models;
  const finalModes = modes.length > 0 ? modes : fallback.modes.length > 0 ? fallback.modes : DEFAULT_ANTIGRAVITY_MODES;
  const resolvedModelId = currentModelId ?? fallback.currentModelId;
  const activeModel = finalModels.find((m) => m.id === resolvedModelId);
  const activeModelEfforts = activeModel?.efforts ?? [];
  const resolvedEffortId = activeModelEfforts.length > 0 ? currentEffortId && activeModelEfforts.includes(currentEffortId) ? currentEffortId : fallback.currentEffortId && activeModelEfforts.includes(fallback.currentEffortId) ? fallback.currentEffortId : activeModelEfforts[0] : void 0;
  const resolvedModeId = currentModeId ?? fallback.currentModeId;
  const commands = Array.isArray(rec.availableCommands) ? parseAcpCommands(rec.availableCommands) : fallback.commands;
  return {
    agentId: AGENT_ID,
    models: finalModels,
    ...resolvedModelId !== void 0 ? { currentModelId: resolvedModelId } : {},
    ...resolvedEffortId !== void 0 ? { currentEffortId: resolvedEffortId } : {},
    modes: finalModes,
    ...resolvedModeId !== void 0 ? { currentModeId: resolvedModeId } : {},
    modeConfirmed: true,
    autoApprove: resolvedModeId === "auto",
    commands
  };
}

// src/protocol-mapping.ts
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function pickNonEmptyString(rec, keys) {
  if (!rec) return void 0;
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return void 0;
}
function inferToolKindFromName(toolName, acpKind) {
  const lower = toolName.toLowerCase();
  const kindLower = acpKind?.toLowerCase() ?? "";
  if (kindLower === "execute" || lower.includes("run_command") || lower.includes("bash") || lower.includes("shell")) {
    return "shell";
  }
  if (lower.startsWith("git") || lower.includes("_git")) {
    return "git";
  }
  if (kindLower === "read" || kindLower === "edit" || kindLower === "delete" || kindLower === "move" || kindLower === "search" || lower.includes("file") || lower.includes("grep") || lower.includes("find") || lower.includes("dir")) {
    return "filesystem";
  }
  if (kindLower === "fetch" || lower.includes("web") || lower.includes("url") || lower.includes("http")) {
    return "web";
  }
  if (lower.includes("mcp")) {
    return "mcp";
  }
  if (lower.includes("subagent") || lower.includes("swarm")) {
    return "subagent";
  }
  if (lower.includes("task") || lower.includes("process")) {
    return "process";
  }
  if (lower.includes("image")) {
    return "image";
  }
  return "other";
}
var MAX_TOOL_OUTPUT_CHARS = 4e3;
function extractAcpToolOutput(update) {
  const rawOutput = asRecord2(update.rawOutput);
  const exitCode = typeof rawOutput?.exit_code === "number" ? rawOutput.exit_code : typeof rawOutput?.exitCode === "number" ? rawOutput.exitCode : void 0;
  if (typeof rawOutput?.output === "string" && rawOutput.output.trim().length > 0) {
    const raw = rawOutput.output;
    return {
      text: raw.slice(0, MAX_TOOL_OUTPUT_CHARS),
      ...raw.length > MAX_TOOL_OUTPUT_CHARS ? { truncated: true } : {},
      ...exitCode !== void 0 ? { exitCode } : {}
    };
  }
  let diffPath;
  if (Array.isArray(update.content)) {
    const parts = [];
    for (const item of update.content) {
      const block = asRecord2(item);
      if (!block) continue;
      if (block.type === "content") {
        const inner = asRecord2(block.content);
        if (inner?.type === "text" && typeof inner.text === "string") {
          parts.push(inner.text);
        }
      } else if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "diff" && typeof block.path === "string") {
        if (!diffPath) diffPath = block.path;
      }
    }
    const joined = parts.join("\n").trim();
    if (joined.length > 0) {
      return {
        text: joined.slice(0, MAX_TOOL_OUTPUT_CHARS),
        ...joined.length > MAX_TOOL_OUTPUT_CHARS ? { truncated: true } : {},
        ...exitCode !== void 0 ? { exitCode } : {},
        ...diffPath !== void 0 ? { diffPath } : {}
      };
    }
  }
  return {
    ...exitCode !== void 0 ? { exitCode } : {},
    ...diffPath !== void 0 ? { diffPath } : {}
  };
}
function buildPresentationFromToolState(state, options) {
  return {
    kind: state.kind,
    title: state.title,
    routedToolName: state.toolName,
    startedAt: state.startedAt,
    ...options?.endedAt !== void 0 ? { endedAt: options.endedAt } : {},
    ...options?.durationMs !== void 0 ? { durationMs: options.durationMs } : {},
    ...state.command !== void 0 ? { command: state.command } : {},
    ...state.targetPaths !== void 0 && state.targetPaths.length > 0 ? { targetPaths: state.targetPaths } : {},
    ...state.changedPaths !== void 0 && state.changedPaths.length > 0 ? { changedPaths: state.changedPaths } : {},
    ...state.exitCode !== void 0 ? { exitCode: state.exitCode } : {},
    ...state.outputText !== void 0 ? {
      output: {
        text: state.outputText,
        ...state.outputTruncated ? { truncated: true } : {}
      }
    } : {},
    ...options?.isError ? {
      error: {
        category: "execution",
        message: state.outputText ?? `${state.title} failed`
      }
    } : {}
  };
}
function normalizePermissionOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) return [];
  const options = [];
  for (const item of rawOptions) {
    const rec = asRecord2(item);
    if (!rec || typeof rec.optionId !== "string") continue;
    const label = typeof rec.name === "string" ? rec.name : typeof rec.label === "string" ? rec.label : rec.optionId;
    const rawKind = typeof rec.kind === "string" ? rec.kind : "";
    const kind = rawKind === "allow_always" || rawKind === "allow_once" || rawKind === "reject_always" || rawKind === "reject_once" ? rawKind : rawKind.includes("allow") ? "allow_once" : "reject_once";
    options.push({ optionId: rec.optionId, label, kind });
  }
  return options;
}
function parseAntigravityPermissionPrompt(reqParams, runId) {
  const rec = asRecord2(reqParams);
  const toolCall = asRecord2(rec?.toolCall);
  const rawInput = asRecord2(toolCall?.rawInput);
  const toolName = pickNonEmptyString(toolCall, ["name", "title"]) ?? pickNonEmptyString(rec, ["action", "title"]) ?? "tool";
  const title = pickNonEmptyString(toolCall, ["title", "name"]) ?? toolName;
  const command = pickNonEmptyString(rawInput, ["CommandLine", "command", "cmd"]);
  const pathVal = pickNonEmptyString(rawInput, ["Path", "TargetFile", "file_path", "filePath", "path"]);
  const acpKind = typeof toolCall?.kind === "string" ? toolCall.kind.toLowerCase() : "";
  let riskKind = "unknown";
  if (command?.startsWith("git ") || toolName.toLowerCase().includes("git")) {
    riskKind = "git";
  } else if (command !== void 0 || acpKind === "execute" || toolName.toLowerCase().includes("command")) {
    riskKind = "command";
  } else if (acpKind === "edit" || acpKind === "delete" || toolName.toLowerCase().includes("write") || toolName.toLowerCase().includes("edit")) {
    riskKind = "file-write";
  } else if (acpKind === "fetch" || toolName.toLowerCase().includes("web") || toolName.toLowerCase().includes("http")) {
    riskKind = "network";
  } else if (toolName.toLowerCase().includes("mcp")) {
    riskKind = "mcp";
  }
  const options = normalizePermissionOptions(rec?.options);
  const detail = command ?? pathVal ?? (rawInput && Object.keys(rawInput).length > 0 ? JSON.stringify(rawInput).slice(0, 500) : title);
  return {
    action: title,
    detail,
    context: {
      kind: riskKind,
      summary: title,
      ...command !== void 0 ? { command } : {},
      ...pathVal !== void 0 ? { paths: [pathVal] } : {},
      backendOptions: options,
      backendAgentId: AGENT_ID
    },
    options,
    ...runId !== void 0 ? { runId } : {}
  };
}
function classifyAntigravityFailure(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  const message = raw.slice(0, 500);
  if (lower.includes("auth") || lower.includes("sign in") || lower.includes("unauthenticated") || lower.includes("401")) {
    return { code: "provider-authentication", origin: "provider", message, retriable: false };
  }
  if (lower.includes("quota") || lower.includes("exhausted")) {
    return { code: "provider-quota", origin: "provider", message, retriable: false };
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return { code: "provider-rate-limit", origin: "provider", message, retriable: true };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { code: "model-request-timeout", origin: "transport", message, retriable: true };
  }
  if (lower.includes("exited") || lower.includes("closed")) {
    return { code: "backend-worker-crash", origin: "runtime", message, retriable: true };
  }
  return { code: "unknown-agent-failure", origin: "runtime", message, retriable: false };
}
function mapAcpStopReason(rawStop, cancelled) {
  if (cancelled || rawStop === "cancelled" || rawStop === "aborted") {
    return { status: "aborted", stopReason: "aborted" };
  }
  if (rawStop === "max_tokens" || rawStop === "length" || rawStop === "max_turn_requests") {
    return { status: "completed", stopReason: "length" };
  }
  if (rawStop === "tool_use" || rawStop === "toolUse") {
    return { status: "completed", stopReason: "toolUse" };
  }
  if (rawStop === "refusal" || rawStop === "handled") {
    return { status: "completed", stopReason: "handled" };
  }
  return { status: "completed", stopReason: "stop" };
}

// src/projector.ts
function asRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
var AcpSessionProjector = class {
  nextSeq = 1;
  activeRole;
  activeMessageId;
  lastAssistantMessageId;
  activeRunId;
  tools = /* @__PURE__ */ new Map();
  currentOptions;
  constructor(initialOptions) {
    this.currentOptions = initialOptions;
  }
  setRunId(runId) {
    this.activeRunId = runId;
    if (runId !== void 0) {
      this.lastAssistantMessageId = void 0;
    }
  }
  getOptions() {
    return this.currentOptions;
  }
  updateOptionsFromPayload(payload) {
    this.currentOptions = parseAcpOptions(payload, this.currentOptions);
    return this.currentOptions;
  }
  flushActiveMessage() {
    if (!this.activeMessageId) return [];
    const messageId = this.activeMessageId;
    const role = this.activeRole;
    const runId = role === "assistant" ? this.activeRunId : void 0;
    this.activeMessageId = void 0;
    this.activeRole = void 0;
    return [
      {
        type: "agent",
        event: {
          type: "message/end",
          messageId,
          ...runId !== void 0 ? { runId } : {}
        }
      }
    ];
  }
  finishTurn(aborted = false) {
    const emissions = [];
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const nowMs = Date.now();
    for (const state of this.tools.values()) {
      if (state.ended) continue;
      state.ended = true;
      const durationMs = Math.max(0, nowMs - state.startedMs);
      emissions.push({
        type: "agent",
        event: {
          type: "tool/end",
          toolCallId: state.toolCallId,
          isError: aborted,
          ...state.responseMessageId !== void 0 ? { responseMessageId: state.responseMessageId } : {},
          ...this.activeRunId !== void 0 ? { runId: this.activeRunId } : {},
          presentation: buildPresentationFromToolState(state, {
            endedAt: nowIso,
            durationMs,
            isError: aborted
          })
        }
      });
    }
    emissions.push(...this.flushActiveMessage());
    return emissions;
  }
  projectSessionUpdate(update) {
    const kind = update.sessionUpdate;
    if (typeof kind !== "string") return [];
    if (kind === "user_message_chunk") {
      if (this.activeRunId !== void 0) return [];
      return this.projectTextChunk("user", update);
    }
    if (kind === "agent_message_chunk") {
      return this.projectTextChunk("assistant", update);
    }
    if (kind === "agent_thought_chunk") {
      return this.projectThoughtChunk(update);
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      return this.projectToolUpdate(kind, update);
    }
    if (kind === "available_commands_update") {
      const commands = parseAcpCommands(update.availableCommands);
      this.currentOptions = { ...this.currentOptions, commands };
      return [{ type: "options", options: this.currentOptions }];
    }
    if (kind === "current_mode_update") {
      const modeId = typeof update.currentModeId === "string" ? update.currentModeId : void 0;
      if (!modeId) return [];
      this.currentOptions = {
        ...this.currentOptions,
        currentModeId: modeId,
        modeConfirmed: true,
        autoApprove: modeId === "auto"
      };
      return [{ type: "options", options: this.currentOptions }];
    }
    if (kind === "config_option_update") {
      this.currentOptions = parseAcpOptions(update, this.currentOptions);
      return [{ type: "options", options: this.currentOptions }];
    }
    if (kind === "session_info_update") {
      const title = typeof update.title === "string" && update.title.trim().length > 0 ? update.title.trim() : void 0;
      if (title === void 0) return [];
      return [{ type: "title", title }];
    }
    return [];
  }
  ensureMessage(role) {
    if (this.activeRole === role && this.activeMessageId) {
      return { emissions: [], messageId: this.activeMessageId };
    }
    const flushed = this.flushActiveMessage();
    const messageId = `agy-${role}-${this.nextSeq}`;
    this.nextSeq += 1;
    this.activeRole = role;
    this.activeMessageId = messageId;
    if (role === "assistant") {
      this.lastAssistantMessageId = messageId;
    } else {
      this.lastAssistantMessageId = void 0;
    }
    const runId = role === "assistant" ? this.activeRunId : void 0;
    flushed.push({
      type: "agent",
      event: {
        type: "message/start",
        messageId,
        role,
        ...runId !== void 0 ? { runId } : {}
      }
    });
    return { emissions: flushed, messageId };
  }
  projectTextChunk(role, update) {
    const content = asRecord3(update.content);
    const text = typeof content?.text === "string" ? content.text : void 0;
    if (!text || text.length === 0) return [];
    const { emissions, messageId } = this.ensureMessage(role);
    const runId = role === "assistant" ? this.activeRunId : void 0;
    emissions.push({
      type: "agent",
      event: {
        type: "message/text_delta",
        messageId,
        delta: text,
        ...runId !== void 0 ? { runId } : {}
      }
    });
    return emissions;
  }
  projectThoughtChunk(update) {
    const content = asRecord3(update.content);
    const text = typeof content?.text === "string" ? content.text : void 0;
    if (!text || text.length === 0) return [];
    const { emissions, messageId } = this.ensureMessage("assistant");
    emissions.push({
      type: "agent",
      event: {
        type: "message/thinking_delta",
        messageId,
        delta: text,
        ...this.activeRunId !== void 0 ? { runId: this.activeRunId } : {}
      }
    });
    return emissions;
  }
  projectToolUpdate(kind, update) {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : void 0;
    if (!toolCallId) return [];
    const rawStatus = typeof update.status === "string" ? update.status : void 0;
    const status = rawStatus === "completed" || rawStatus === "failed" || rawStatus === "in_progress" || rawStatus === "pending" ? rawStatus : kind === "tool_call" ? "in_progress" : "completed";
    const rawInput = asRecord3(update.rawInput);
    const command = pickNonEmptyString(rawInput, ["CommandLine", "command", "cmd"]);
    let pathVal = pickNonEmptyString(rawInput, [
      "Path",
      "TargetFile",
      "SearchDirectory",
      "DirectoryPath",
      "Cwd",
      "path",
      "file_path",
      "filePath",
      "target_file"
    ]);
    if (!pathVal && Array.isArray(update.locations)) {
      for (const loc of update.locations) {
        const locRec = asRecord3(loc);
        if (typeof locRec?.path === "string" && locRec.path.trim().length > 0) {
          pathVal = locRec.path.trim();
          break;
        }
      }
    }
    const extracted = extractAcpToolOutput(update);
    if (!pathVal && extracted.diffPath) pathVal = extracted.diffPath;
    const runId = this.activeRunId;
    const emissions = [];
    let state = this.tools.get(toolCallId);
    if (!state) {
      emissions.push(...this.flushActiveMessage());
      const toolName = pickNonEmptyString(update, ["name", "title"]) ?? "tool";
      const title = pickNonEmptyString(update, ["title", "name"]) ?? toolName;
      const acpKind = typeof update.kind === "string" ? update.kind : void 0;
      const nowMs = Date.now();
      state = {
        toolCallId,
        toolName,
        ...this.lastAssistantMessageId !== void 0 ? { responseMessageId: this.lastAssistantMessageId } : {},
        kind: inferToolKindFromName(toolName, acpKind),
        title,
        ...command !== void 0 ? { command } : {},
        ...pathVal !== void 0 ? { targetPaths: [pathVal] } : {},
        ...extracted.diffPath !== void 0 ? { changedPaths: [extracted.diffPath] } : {},
        ...extracted.text !== void 0 ? { outputText: extracted.text } : {},
        ...extracted.truncated ? { outputTruncated: true } : {},
        ...extracted.exitCode !== void 0 ? { exitCode: extracted.exitCode } : {},
        startedAt: new Date(nowMs).toISOString(),
        startedMs: nowMs,
        ended: false
      };
      this.tools.set(toolCallId, state);
      emissions.push({
        type: "agent",
        event: {
          type: "tool/start",
          toolCallId,
          toolName: state.toolName,
          ...state.responseMessageId !== void 0 ? { responseMessageId: state.responseMessageId } : {},
          ...runId !== void 0 ? { runId } : {},
          presentation: buildPresentationFromToolState(state)
        }
      });
    } else {
      const updatedTitle = pickNonEmptyString(update, ["title"]);
      if (updatedTitle !== void 0) state.title = updatedTitle;
      if (command !== void 0) state.command = command;
      if (pathVal !== void 0 && (!state.targetPaths || state.targetPaths.length === 0)) {
        state.targetPaths = [pathVal];
      }
      if (extracted.diffPath !== void 0) state.changedPaths = [extracted.diffPath];
      if (extracted.text !== void 0) state.outputText = extracted.text;
      if (extracted.truncated) state.outputTruncated = true;
      if (extracted.exitCode !== void 0) state.exitCode = extracted.exitCode;
      if ((status === "pending" || status === "in_progress") && !state.ended) {
        emissions.push({
          type: "agent",
          event: {
            type: "tool/update",
            toolCallId,
            delta: extracted.text ?? "",
            ...state.responseMessageId !== void 0 ? { responseMessageId: state.responseMessageId } : {},
            ...runId !== void 0 ? { runId } : {},
            presentation: buildPresentationFromToolState(state)
          }
        });
      }
    }
    if ((status === "completed" || status === "failed") && !state.ended) {
      state.ended = true;
      const nowMs = Date.now();
      const endedAt = new Date(nowMs).toISOString();
      const durationMs = Math.max(0, nowMs - state.startedMs);
      const isError = status === "failed";
      emissions.push({
        type: "agent",
        event: {
          type: "tool/end",
          toolCallId,
          isError,
          ...state.responseMessageId !== void 0 ? { responseMessageId: state.responseMessageId } : {},
          ...runId !== void 0 ? { runId } : {},
          presentation: buildPresentationFromToolState(state, { endedAt, durationMs, isError })
        }
      });
    }
    return emissions;
  }
};

// src/history.ts
var MAX_LINE_CHARS = 512 * 1024;
var MAX_EVENTS = 2e3;
function asRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function readUtf8(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
}
function extractUserRequestText(rawContent) {
  const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && typeof match[1] === "string") {
    return match[1].trim();
  }
  return rawContent.trim();
}
function antigravityTranscriptCandidates(sessionId, homeDir = process.env.HOME ?? homedir2()) {
  return [
    join2(homeDir, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"),
    join2(homeDir, ".gemini", "antigravity", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl")
  ];
}
function buildHistoricalToolPresentation(toolName, args) {
  const kind = inferToolKindFromName(toolName);
  const command = typeof args?.CommandLine === "string" ? args.CommandLine : typeof args?.command === "string" ? args.command : void 0;
  const pathVal = typeof args?.Path === "string" ? args.Path : typeof args?.TargetFile === "string" ? args.TargetFile : typeof args?.SearchDirectory === "string" ? args.SearchDirectory : typeof args?.path === "string" ? args.path : void 0;
  const summary = typeof args?.toolSummary === "string" ? args.toolSummary : void 0;
  return {
    kind,
    title: summary ?? toolName,
    routedToolName: toolName,
    ...command !== void 0 ? { command } : {},
    ...pathVal !== void 0 ? { targetPaths: [pathVal] } : {}
  };
}
function reconstructAntigravityHistory(input) {
  if (!input.sessionId || input.sessionId.trim().length === 0) {
    return { ok: false, reason: "native session id required" };
  }
  const reader = input.readFile ?? readUtf8;
  let body;
  for (const candidate of antigravityTranscriptCandidates(input.sessionId, input.homeDir)) {
    body = reader(candidate);
    if (body !== void 0) break;
  }
  if (body === void 0) {
    return { ok: false, reason: "native transcript unavailable" };
  }
  const events = [];
  let lastStatus;
  let seq = 1;
  for (const raw of body.split("\n")) {
    if (events.length >= MAX_EVENTS) break;
    const line = raw.trim();
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    let record;
    try {
      const parsed = JSON.parse(line);
      const rec = asRecord4(parsed);
      if (!rec) continue;
      record = rec;
    } catch {
      continue;
    }
    const stepIndex = typeof record.step_index === "number" ? record.step_index : seq++;
    if (typeof record.status === "string") {
      lastStatus = record.status;
    }
    if (record.type === "USER_INPUT" && typeof record.content === "string") {
      const text = extractUserRequestText(record.content);
      if (text.length === 0) continue;
      const messageId = `agy-hist-user-${stepIndex}`;
      events.push(
        { type: "agent", event: { type: "message/start", messageId, role: "user" } },
        { type: "agent", event: { type: "message/text_delta", messageId, delta: text } },
        { type: "agent", event: { type: "message/end", messageId } }
      );
      continue;
    }
    if (record.type === "PLANNER_RESPONSE") {
      const thinking = typeof record.thinking === "string" ? record.thinking.trim() : "";
      const content = typeof record.content === "string" ? record.content.trim() : "";
      const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      if (thinking.length === 0 && content.length === 0 && toolCalls.length === 0) continue;
      const messageId = `agy-hist-assistant-${stepIndex}`;
      events.push({ type: "agent", event: { type: "message/start", messageId, role: "assistant" } });
      if (thinking.length > 0) {
        events.push({ type: "agent", event: { type: "message/thinking_delta", messageId, delta: thinking } });
      }
      if (content.length > 0) {
        events.push({ type: "agent", event: { type: "message/text_delta", messageId, delta: content } });
      }
      events.push({ type: "agent", event: { type: "message/end", messageId } });
      let toolIdx = 0;
      for (const rawTool of toolCalls) {
        const tool = asRecord4(rawTool);
        if (!tool || typeof tool.name !== "string") continue;
        const toolCallId = `agy-hist-tool-${stepIndex}-${toolIdx++}`;
        const args = asRecord4(tool.args) ?? asRecord4(tool.arguments);
        const presentation = buildHistoricalToolPresentation(tool.name, args);
        events.push(
          {
            type: "agent",
            event: {
              type: "tool/start",
              toolCallId,
              toolName: tool.name,
              responseMessageId: messageId,
              presentation
            }
          },
          {
            type: "agent",
            event: {
              type: "tool/end",
              toolCallId,
              isError: record.status === "ERROR",
              responseMessageId: messageId,
              presentation
            }
          }
        );
      }
    }
  }
  if (events.length === 0) {
    return { ok: false, reason: "native transcript empty" };
  }
  const activity = lastStatus === "IN_PROGRESS" || lastStatus === "RUNNING" || lastStatus === "PENDING" ? "running" : lastStatus === "DONE" || lastStatus === "ERROR" || lastStatus === "CANCELLED" ? "idle" : "unknown";
  return { ok: true, events: events.slice(0, MAX_EVENTS), activity };
}

// src/prompt-content.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
function readBytes(path) {
  try {
    return readFileSync2(path);
  } catch {
    return void 0;
  }
}
function buildAcpPromptBlocks(text, attachments, readFile = readBytes, contextRefs) {
  const blocks = [];
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const hasRefs = Array.isArray(contextRefs) && contextRefs.length > 0;
  if (text.length > 0 || !hasAttachments && !hasRefs) {
    blocks.push({ type: "text", text });
  }
  if (Array.isArray(contextRefs)) {
    for (const rawRef of contextRefs) {
      if (typeof rawRef !== "object" || rawRef === null) continue;
      const ref = rawRef;
      if (ref.kind === "file" && typeof ref.projectPath === "string" && typeof ref.relativePath === "string") {
        const fullPath = isAbsolute(ref.relativePath) ? ref.relativePath : resolve(ref.projectPath, ref.relativePath);
        const uri = pathToFileURL(fullPath).href;
        const name = typeof ref.label === "string" && ref.label.trim().length > 0 ? ref.label.trim() : ref.relativePath;
        blocks.push({ type: "resource_link", uri, name });
      }
    }
  }
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { ok: true, blocks };
  }
  for (const item of attachments) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item;
    if (rec.kind !== "media") continue;
    const mimeType = typeof rec.mimeType === "string" ? rec.mimeType : "";
    const contentKind = rec.contentKind;
    const isImage = contentKind === "image" || contentKind === void 0 && mimeType.toLowerCase().startsWith("image/");
    if (!isImage) continue;
    if (typeof rec.path !== "string" || rec.path.length === 0) {
      return { ok: false, reason: "image attachment is missing a Host media path" };
    }
    const bytes = readFile(rec.path);
    if (bytes === void 0) {
      return { ok: false, reason: "image attachment could not be read" };
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, reason: "image attachment exceeds 8 MiB" };
    }
    blocks.push({
      type: "image",
      mimeType: mimeType || "image/png",
      data: bytes.toString("base64")
    });
  }
  return { ok: true, blocks };
}

// src/session-runner.ts
function asRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
async function applyRequestedBindingChoices(acp, backendSessionId, projector, binding) {
  let options = projector.getOptions();
  if (!binding) return options;
  const requestedModel = typeof binding.modelId === "string" ? binding.modelId.trim() : "";
  if (requestedModel.length > 0 && requestedModel !== options.currentModelId) {
    const { baseModelId } = splitCombinedModelAndEffort(requestedModel);
    try {
      const res = await acp.request("session/set_config_option", {
        sessionId: backendSessionId,
        configId: "model",
        value: baseModelId
      });
      options = projector.updateOptionsFromPayload(res);
    } catch {
    }
  }
  const requestedEffort = typeof binding.effortId === "string" ? binding.effortId.trim() : "";
  const activeModel = options.models.find((m) => m.id === options.currentModelId);
  if (requestedEffort.length > 0 && requestedEffort !== options.currentEffortId && activeModel?.efforts?.includes(requestedEffort)) {
    try {
      const res = await acp.request("session/set_config_option", {
        sessionId: backendSessionId,
        configId: "thought_level",
        value: requestedEffort
      });
      options = projector.updateOptionsFromPayload(res);
    } catch {
    }
  }
  const requestedMode = typeof binding.modeId === "string" ? binding.modeId.trim() : "";
  if (requestedMode.length > 0 && requestedMode !== options.currentModeId) {
    try {
      await acp.request("session/set_mode", {
        sessionId: backendSessionId,
        modeId: requestedMode
      });
      options = projector.updateOptionsFromPayload({
        modes: { currentModeId: requestedMode, availableModes: options.modes }
      });
    } catch {
    }
  }
  return options;
}
async function openAntigravitySession(input) {
  const { frame, io: io2, sessions, ensureAcp } = input;
  if (frame.scope.kind !== "session") {
    io2.write(errFrame(frame, "invalid-request", "session scope required"));
    return;
  }
  const sessionScope = frame.scope;
  const params = asRecord5(frame.params);
  const cwd = typeof params?.cwd === "string" && params.cwd.length > 0 ? params.cwd : process.cwd();
  const binding = asRecord5(params?.binding);
  const storedId = typeof binding?.backendSessionId === "string" ? binding.backendSessionId.trim() : "";
  if ((frame.method === "session/load" || frame.method === "session/resume") && storedId.length === 0) {
    io2.write(errFrame(frame, "invalid-request", "native session id required"));
    return;
  }
  const existing = sessions.get(sessionScope.sessionId);
  if (frame.method !== "session/new" && existing && existing.backendSessionId === storedId) {
    existing.scope = sessionScope;
    const isLoad2 = frame.method === "session/load";
    if (isLoad2 && input.replayStreaming === true) {
      for (const emission of existing.replay) {
        io2.write(eventFrame(sessionScope, emission));
      }
      io2.write(
        okFrame(frame, {
          backendSessionId: existing.backendSessionId,
          ...input.agentVersion !== void 0 ? { agentVersion: input.agentVersion } : {},
          capabilities: antigravityCapabilities(),
          options: existing.projector.getOptions(),
          replayEvents: [],
          streamedReplayEventCount: existing.replay.length
        })
      );
      return;
    }
    io2.write(
      okFrame(frame, {
        backendSessionId: existing.backendSessionId,
        ...input.agentVersion !== void 0 ? { agentVersion: input.agentVersion } : {},
        capabilities: antigravityCapabilities(),
        options: existing.projector.getOptions(),
        replayEvents: isLoad2 ? existing.replay : []
      })
    );
    return;
  }
  const appDataDir = resolveAntigravityAppDataDir(
    frame.method === "session/new" ? void 0 : storedId,
    {
      ...input.homeDir !== void 0 ? { homeDir: input.homeDir } : {},
      ...input.fileExists !== void 0 ? { fileExists: input.fileExists } : {}
    }
  );
  const acp = await ensureAcp(appDataDir);
  const projector = new AcpSessionProjector(DEFAULT_ANTIGRAVITY_OPTIONS);
  const replay = [];
  const stopCollect = acp.onNotification((method, noteParams) => {
    if (method !== "session/update") return;
    const rec = asRecord5(noteParams);
    if (!rec) return;
    if (storedId.length > 0 && typeof rec.sessionId === "string" && rec.sessionId !== storedId) return;
    const update = asRecord5(rec.update);
    if (!update) return;
    for (const emission of projector.projectSessionUpdate(update)) {
      if (emission.type === "agent") {
        replay.push(emission);
      }
    }
  });
  let rpcResult;
  try {
    const rpcMethod = frame.method === "session/new" ? "session/new" : frame.method === "session/load" ? "session/load" : "session/resume";
    const rpcParams = frame.method === "session/new" ? { cwd, mcpServers: [] } : { sessionId: storedId, cwd, mcpServers: [] };
    rpcResult = asRecord5(await acp.request(rpcMethod, rpcParams));
  } finally {
    stopCollect();
  }
  for (const emission of projector.finishTurn(false)) {
    if (emission.type === "agent") {
      replay.push(emission);
    }
  }
  const backendSessionId = typeof rpcResult?.sessionId === "string" && rpcResult.sessionId.length > 0 ? rpcResult.sessionId : storedId;
  if (!backendSessionId) {
    io2.write(errFrame(frame, "backend-error", "Antigravity ACP did not return a sessionId"));
    return;
  }
  projector.updateOptionsFromPayload(rpcResult);
  const options = await applyRequestedBindingChoices(acp, backendSessionId, projector, binding);
  if (frame.method === "session/load" && replay.length === 0) {
    const fallbackHistory = reconstructAntigravityHistory({
      sessionId: backendSessionId,
      ...input.homeDir !== void 0 ? { homeDir: input.homeDir } : {},
      ...input.readHistoryFile !== void 0 ? { readFile: input.readHistoryFile } : {}
    });
    if (fallbackHistory.ok) {
      replay.push(...fallbackHistory.events);
    }
  }
  const slot = {
    scope: sessionScope,
    cwd,
    backendSessionId,
    appDataDir,
    projector,
    replay,
    cancelled: false,
    runningPrompt: false
  };
  sessions.set(sessionScope.sessionId, slot);
  const isLoad = frame.method === "session/load";
  if (isLoad && input.replayStreaming === true) {
    for (const emission of replay) {
      io2.write(eventFrame(sessionScope, emission));
    }
    io2.write(
      okFrame(frame, {
        backendSessionId,
        ...input.agentVersion !== void 0 ? { agentVersion: input.agentVersion } : {},
        capabilities: antigravityCapabilities(),
        options,
        replayEvents: [],
        streamedReplayEventCount: replay.length
      })
    );
    return;
  }
  io2.write(
    okFrame(frame, {
      backendSessionId,
      ...input.agentVersion !== void 0 ? { agentVersion: input.agentVersion } : {},
      capabilities: antigravityCapabilities(),
      options,
      replayEvents: isLoad ? replay : []
    })
  );
}
async function runAntigravityPrompt(input) {
  const { frame, io: io2, slot, acp, readMediaFile } = input;
  const sessionScope = frame.scope;
  slot.scope = sessionScope;
  const params = asRecord5(frame.params);
  const runId = typeof params?.runId === "string" && params.runId.length > 0 ? params.runId : void 0;
  const promptInput = asRecord5(params?.input);
  const text = typeof promptInput?.text === "string" ? promptInput.text : "";
  const built = buildAcpPromptBlocks(text, promptInput?.attachments, readMediaFile, promptInput?.contextRefs);
  if (!built.ok) {
    io2.write(errFrame(frame, "invalid-request", built.reason));
    return;
  }
  slot.cancelled = false;
  slot.runningPrompt = true;
  slot.projector.setRunId(runId);
  if (text.length > 0) {
    const userMsgId = `agy-prompt-user-${Date.now()}`;
    slot.replay.push(
      { type: "agent", event: { type: "message/start", messageId: userMsgId, role: "user" } },
      { type: "agent", event: { type: "message/text_delta", messageId: userMsgId, delta: text } },
      { type: "agent", event: { type: "message/end", messageId: userMsgId } }
    );
  }
  const emit = (emission) => {
    if (emission.type === "agent") {
      slot.replay.push(emission);
    }
    io2.write(eventFrame(sessionScope, emission));
  };
  const stopNotes = acp.onNotification((method, noteParams) => {
    if (method !== "session/update") return;
    const rec = asRecord5(noteParams);
    if (!rec || typeof rec.sessionId === "string" && rec.sessionId !== slot.backendSessionId) return;
    const update = asRecord5(rec.update);
    if (!update) return;
    for (const emission of slot.projector.projectSessionUpdate(update)) {
      emit(emission);
    }
  });
  const stopReqs = acp.onRequest(async (_id, method, reqParams) => {
    if (method === "session/request_permission") {
      const prompt = parseAntigravityPermissionPrompt(reqParams, runId);
      const decision = asRecord5(await io2.callHost(sessionScope, "permission/request", prompt));
      if (decision?.cancelled === true || typeof decision?.optionId !== "string") {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: decision.optionId } };
    }
    throw new Error(`Unsupported ACP client request: ${method}`);
  });
  try {
    const promptRes = asRecord5(
      await acp.request("session/prompt", {
        sessionId: slot.backendSessionId,
        prompt: built.blocks
      })
    );
    const rawStop = typeof promptRes?.stopReason === "string" ? promptRes.stopReason : "end_turn";
    const outcome = mapAcpStopReason(rawStop, slot.cancelled);
    for (const flushed of slot.projector.finishTurn(outcome.status === "aborted")) {
      emit(flushed);
    }
    if (outcome.status === "aborted") {
      emit({
        type: "agent",
        event: {
          type: "session/aborted",
          sessionId: slot.backendSessionId,
          ...runId !== void 0 ? { runId } : {}
        }
      });
    }
    io2.write(okFrame(frame, outcome));
  } catch (error) {
    for (const flushed of slot.projector.finishTurn(true)) {
      emit(flushed);
    }
    if (slot.cancelled) {
      emit({
        type: "agent",
        event: {
          type: "session/aborted",
          sessionId: slot.backendSessionId,
          ...runId !== void 0 ? { runId } : {}
        }
      });
      io2.write(okFrame(frame, { status: "aborted", stopReason: "aborted" }));
      return;
    }
    const failure = classifyAntigravityFailure(error);
    emit({
      type: "agent",
      event: {
        type: "error",
        message: failure.message,
        retriable: failure.retriable,
        failure,
        ...runId !== void 0 ? { runId } : {}
      }
    });
    io2.write(okFrame(frame, { status: "failed", stopReason: "error", failure }));
  } finally {
    slot.runningPrompt = false;
    slot.projector.setRunId(void 0);
    stopNotes();
    stopReqs();
  }
}
async function configureAntigravitySession(input) {
  const { frame, io: io2, slot, ensureAcp } = input;
  if (!slot) {
    io2.write(okFrame(frame, DEFAULT_ANTIGRAVITY_OPTIONS));
    return;
  }
  if (frame.method === "session/options") {
    io2.write(okFrame(frame, slot.projector.getOptions()));
    return;
  }
  const acp = await ensureAcp(slot.appDataDir);
  const params = asRecord5(frame.params);
  let updatedOptions = slot.projector.getOptions();
  if (frame.method === "session/model") {
    const rawModelId = typeof params?.modelId === "string" ? params.modelId.trim() : "";
    if (!rawModelId) {
      io2.write(errFrame(frame, "invalid-request", "modelId is required"));
      return;
    }
    const { baseModelId, effortId } = splitCombinedModelAndEffort(rawModelId);
    const res = await acp.request("session/set_config_option", {
      sessionId: slot.backendSessionId,
      configId: "model",
      value: baseModelId
    });
    updatedOptions = slot.projector.updateOptionsFromPayload(res);
    const activeModel = updatedOptions.models.find((m) => m.id === updatedOptions.currentModelId);
    if (effortId && activeModel?.efforts?.includes(effortId)) {
      const effortRes = await acp.request("session/set_config_option", {
        sessionId: slot.backendSessionId,
        configId: "thought_level",
        value: effortId
      });
      updatedOptions = slot.projector.updateOptionsFromPayload(effortRes);
    }
  } else if (frame.method === "session/effort") {
    const effortId = typeof params?.effortId === "string" ? params.effortId.trim() : "";
    if (!effortId) {
      io2.write(errFrame(frame, "invalid-request", "effortId is required"));
      return;
    }
    const res = await acp.request("session/set_config_option", {
      sessionId: slot.backendSessionId,
      configId: "thought_level",
      value: effortId
    });
    updatedOptions = slot.projector.updateOptionsFromPayload(res);
  } else if (frame.method === "session/mode") {
    const modeId = typeof params?.modeId === "string" ? params.modeId.trim() : "";
    if (!modeId) {
      io2.write(errFrame(frame, "invalid-request", "modeId is required"));
      return;
    }
    await acp.request("session/set_mode", {
      sessionId: slot.backendSessionId,
      modeId
    });
    updatedOptions = slot.projector.updateOptionsFromPayload({
      modes: { currentModeId: modeId, availableModes: updatedOptions.modes }
    });
  }
  io2.write(okFrame(frame, updatedOptions));
}

// src/plugin.ts
function asRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
var AntigravityPlugin = class {
  constructor(deps) {
    this.deps = deps;
  }
  hostBinaryPath;
  hostCapabilities = {};
  sessions = /* @__PURE__ */ new Map();
  acpClients = /* @__PURE__ */ new Map();
  agentVersion;
  async handle(frame) {
    if (frame.kind !== "request") return;
    try {
      await this.dispatch(frame);
    } catch (error) {
      this.deps.io.write(
        errFrame(frame, "backend-error", error instanceof Error ? error.message : String(error))
      );
    }
  }
  async dispatch(frame) {
    switch (frame.method) {
      case "plugin/initialize": {
        const params = asRecord6(frame.params);
        const runtime = asRecord6(params?.runtime);
        const caps = asRecord6(params?.hostCapabilities);
        this.hostBinaryPath = typeof runtime?.binaryPath === "string" ? runtime.binaryPath : void 0;
        this.hostCapabilities = {
          replayStreaming: caps?.replayStreaming === true,
          nativeCliLaunch: caps?.nativeCliLaunch === true,
          nativeUserInput: caps?.nativeUserInput === true
        };
        this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, protocolVersion: 1, nativeObservation: true }));
        return;
      }
      case "plugin/dispose": {
        for (const client of this.acpClients.values()) client.dispose?.();
        this.acpClients.clear();
        this.sessions.clear();
        this.deps.io.write(okFrame(frame, null));
        return;
      }
      case "check":
        await this.check(frame);
        return;
      case "catalog/list":
        await this.catalogList(frame);
        return;
      case "catalog/usage":
        this.deps.io.write(okFrame(frame, []));
        return;
      case "catalog/native-observe":
        await this.nativeObserve(frame);
        return;
      case "catalog/rename":
        this.deps.io.write(okFrame(frame, null));
        return;
      case "catalog/delete":
        this.deps.io.write(errFrame(frame, "unsupported", "Antigravity conversations are managed natively; archive in piwin instead"));
        return;
      case "session/new":
      case "session/load":
      case "session/resume":
        await openAntigravitySession({
          frame,
          io: this.deps.io,
          sessions: this.sessions,
          ensureAcp: (dir) => this.ensureAcp(dir),
          ...this.hostCapabilities.replayStreaming !== void 0 ? { replayStreaming: this.hostCapabilities.replayStreaming } : {},
          ...this.agentVersion !== void 0 ? { agentVersion: this.agentVersion } : {},
          ...this.deps.homeDir !== void 0 ? { homeDir: this.deps.homeDir } : {},
          ...this.deps.fileExists !== void 0 ? { fileExists: this.deps.fileExists } : {},
          ...this.deps.readHistoryFile !== void 0 ? { readHistoryFile: this.deps.readHistoryFile } : {}
        });
        return;
      case "session/prompt":
        await this.prompt(frame);
        return;
      case "session/cancel":
        await this.cancel(frame);
        return;
      case "session/options":
      case "session/model":
      case "session/effort":
      case "session/mode": {
        const slot = frame.scope.kind === "session" ? this.sessions.get(frame.scope.sessionId) : void 0;
        await configureAntigravitySession({
          frame,
          io: this.deps.io,
          slot,
          ensureAcp: (dir) => this.ensureAcp(dir)
        });
        return;
      }
      case "session/commands": {
        const slot = frame.scope.kind === "session" ? this.sessions.get(frame.scope.sessionId) : void 0;
        this.deps.io.write(okFrame(frame, slot ? slot.projector.getOptions().commands : []));
        return;
      }
      case "session/mcp-status":
        this.deps.io.write(okFrame(frame, { servers: [], observed: false }));
        return;
      case "session/workflows":
        this.deps.io.write(okFrame(frame, []));
        return;
      case "session/cli-launch":
        this.cliLaunch(frame);
        return;
      case "session/release":
        await this.releaseSession(frame);
        return;
      default:
        this.deps.io.write(errFrame(frame, "unsupported", frame.method));
    }
  }
  resolveBinary() {
    return resolveAntigravityBinary(this.hostBinaryPath, {
      ...this.deps.env !== void 0 ? { env: this.deps.env } : {},
      ...this.deps.pathExists !== void 0 ? { pathExists: this.deps.pathExists } : {},
      ...this.deps.homeDir !== void 0 ? { homeDir: this.deps.homeDir } : {}
    });
  }
  async ensureAcp(appDataDir = "antigravity-cli") {
    if (this.deps.acp !== void 0) {
      if (!this.acpClients.has(appDataDir)) {
        const initRes2 = asRecord6(
          await this.deps.acp.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "piwin", version: "0.1.1" }
          })
        );
        const agentInfo2 = asRecord6(initRes2?.agentInfo);
        if (typeof agentInfo2?.version === "string") this.agentVersion = agentInfo2.version;
        this.acpClients.set(appDataDir, this.deps.acp);
      }
      return this.deps.acp;
    }
    const existing = this.acpClients.get(appDataDir);
    if (existing !== void 0) return existing;
    const binaryPath = this.resolveBinary();
    if (!binaryPath) throw new Error("Antigravity CLI (agy) executable not found");
    if (!this.deps.createAcp) throw new Error("Antigravity ACP factory is not configured");
    const client = this.deps.createAcp({ binaryPath, appDataDir });
    client.onExit?.((reason) => {
      this.acpClients.delete(appDataDir);
      for (const [sessionId, slot] of this.sessions) {
        if (slot.appDataDir === appDataDir) {
          this.sessions.delete(sessionId);
          this.deps.io.write(eventFrame(slot.scope, { type: "closed", reason }));
        }
      }
    });
    const initRes = asRecord6(
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "piwin", version: "0.1.1" }
      })
    );
    const agentInfo = asRecord6(initRes?.agentInfo);
    if (typeof agentInfo?.version === "string") this.agentVersion = agentInfo.version;
    this.acpClients.set(appDataDir, client);
    return client;
  }
  async check(frame) {
    const binaryPath = this.resolveBinary();
    const checkedAt = (this.deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
    if (!binaryPath) {
      this.deps.io.write(
        okFrame(frame, {
          agentId: AGENT_ID,
          state: "not-installed",
          searched: [
            this.hostBinaryPath ?? "agy",
            "/Applications/Gemini.app/Contents/Helpers/agy",
            "/Applications/Antigravity.app/Contents/Helpers/agy"
          ],
          checkedAt
        })
      );
      return;
    }
    const probe = this.deps.probeBinary === void 0 ? { ok: true, version: this.agentVersion ?? "1.5.5" } : await this.deps.probeBinary(binaryPath);
    if (!probe.ok) {
      this.deps.io.write(
        okFrame(frame, {
          agentId: AGENT_ID,
          state: "not-installed",
          searched: [binaryPath],
          checkedAt
        })
      );
      return;
    }
    this.agentVersion = probe.version;
    this.deps.io.write(
      okFrame(frame, {
        agentId: AGENT_ID,
        state: "ready",
        binaryPath,
        version: probe.version,
        supportStatus: "verified",
        checkedAt,
        nativeCli: { supported: true },
        options: DEFAULT_ANTIGRAVITY_OPTIONS
      })
    );
  }
  async catalogList(frame) {
    const params = asRecord6(frame.params);
    const cwd = typeof params?.cwd === "string" && params.cwd.length > 0 ? params.cwd : void 0;
    const acp = await this.ensureAcp("antigravity-cli");
    const raw = asRecord6(await acp.request("session/list", cwd ? { cwd } : {}));
    const sessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
    const entries = [];
    const seenIds = /* @__PURE__ */ new Set();
    for (const item of sessions) {
      const rec = asRecord6(item);
      const backendSessionId = typeof rec?.sessionId === "string" ? rec.sessionId : void 0;
      if (!backendSessionId || seenIds.has(backendSessionId)) continue;
      seenIds.add(backendSessionId);
      const title = typeof rec?.title === "string" && rec.title.trim().length > 0 ? rec.title.trim() : void 0;
      const itemCwd = typeof rec?.cwd === "string" && rec.cwd.trim().length > 0 ? rec.cwd.trim() : void 0;
      const updatedAt = typeof rec?.updatedAt === "string" ? Date.parse(rec.updatedAt) : Number.NaN;
      entries.push({
        backendSessionId,
        ...title !== void 0 ? { title } : {},
        ...itemCwd !== void 0 ? { cwd: itemCwd } : {},
        ...Number.isFinite(updatedAt) ? { lastChangeUnixMs: updatedAt } : {}
      });
    }
    const listDb = this.deps.listCliConversations ?? listCliConversationDbFiles;
    for (const dbEntry of listDb(this.deps.homeDir)) {
      if (seenIds.has(dbEntry.backendSessionId)) continue;
      seenIds.add(dbEntry.backendSessionId);
      entries.push({
        backendSessionId: dbEntry.backendSessionId,
        lastChangeUnixMs: dbEntry.lastChangeUnixMs
      });
    }
    this.deps.io.write(okFrame(frame, entries));
  }
  async nativeObserve(frame) {
    const params = asRecord6(frame.params);
    const backendSessionId = typeof params?.backendSessionId === "string" ? params.backendSessionId.trim() : "";
    if (backendSessionId.length === 0) {
      this.deps.io.write(errFrame(frame, "invalid-request", "native session id required"));
      return;
    }
    const live = [...this.sessions.values()].find((slot) => slot.backendSessionId === backendSessionId);
    const reconstructed = reconstructAntigravityHistory({
      sessionId: backendSessionId,
      ...this.deps.homeDir !== void 0 ? { homeDir: this.deps.homeDir } : {},
      ...this.deps.readHistoryFile !== void 0 ? { readFile: this.deps.readHistoryFile } : {}
    });
    const activity = live?.runningPrompt ? "running" : reconstructed.ok ? reconstructed.activity : live ? "idle" : "unknown";
    const replayEvents = reconstructed.ok ? reconstructed.events : live?.replay;
    this.deps.io.write(
      okFrame(frame, {
        backendSessionId,
        activity,
        ...params?.includeHistory === true && replayEvents !== void 0 ? { replayEvents } : {}
      })
    );
  }
  async prompt(frame) {
    if (frame.scope.kind !== "session") {
      this.deps.io.write(errFrame(frame, "invalid-request", "session scope required"));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (!slot) {
      this.deps.io.write(errFrame(frame, "invalid-request", "no session"));
      return;
    }
    const acp = await this.ensureAcp(slot.appDataDir);
    await runAntigravityPrompt({
      frame,
      io: this.deps.io,
      slot,
      acp,
      ...this.deps.readMediaFile !== void 0 ? { readMediaFile: this.deps.readMediaFile } : {}
    });
  }
  async cancel(frame) {
    if (frame.scope.kind === "session") {
      const slot = this.sessions.get(frame.scope.sessionId);
      if (slot) {
        slot.cancelled = true;
        const acp = this.acpClients.get(slot.appDataDir) ?? this.deps.acp;
        acp?.notify("session/cancel", { sessionId: slot.backendSessionId });
      }
    }
    this.deps.io.write(okFrame(frame, null));
  }
  cliLaunch(frame) {
    if (this.hostCapabilities.nativeCliLaunch !== true) {
      this.deps.io.write(errFrame(frame, "unsupported", "nativeCliLaunch was not negotiated"));
      return;
    }
    if (frame.scope.kind !== "session") {
      this.deps.io.write(errFrame(frame, "invalid-request", "session scope required"));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    const params = asRecord6(frame.params);
    const binding = asRecord6(params?.binding);
    const backendSessionId = slot?.backendSessionId ?? (typeof binding?.backendSessionId === "string" ? binding.backendSessionId.trim() : "");
    if (!backendSessionId) {
      this.deps.io.write(errFrame(frame, "invalid-request", "no session"));
      return;
    }
    this.deps.io.write(okFrame(frame, antigravityCliLaunch(backendSessionId)));
  }
  async releaseSession(frame) {
    if (frame.scope.kind === "session") {
      const slot = this.sessions.get(frame.scope.sessionId);
      if (slot) {
        this.sessions.delete(frame.scope.sessionId);
        const acp = this.acpClients.get(slot.appDataDir) ?? this.deps.acp;
        try {
          await acp?.request("session/close", { sessionId: slot.backendSessionId });
        } catch {
        }
      }
    }
    this.deps.io.write(okFrame(frame, null));
  }
};
function createCallbackIo(write2, waiters2) {
  let seq = 0;
  return {
    write: write2,
    callHost(scope, method, params) {
      const requestId = `cb-${seq += 1}`;
      return new Promise((resolve2, reject) => {
        waiters2.set(requestId, { resolve: resolve2, reject });
        write2(requestFrame(scope, requestId, method, params));
      });
    }
  };
}

// src/main.ts
var waiters = /* @__PURE__ */ new Map();
var write = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}
`);
};
var io = createCallbackIo(write, waiters);
var plugin = new AntigravityPlugin({
  io,
  createAcp: ({ binaryPath, appDataDir }) => createAcpStdio({ binaryPath, appDataDir }),
  probeBinary(binaryPath) {
    return new Promise((resolve2) => {
      const child = spawn2(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", () => {
        resolve2({ ok: false });
      });
      child.on("close", (code) => {
        if (code !== 0 || isUnusableAntigravityProbe({ stderr })) {
          resolve2({ ok: false });
          return;
        }
        const firstLine = stdout.trim().split("\n")[0]?.trim() ?? "";
        const match = firstLine.match(/(\d+\.\d+\.\d+)/);
        resolve2({ ok: true, version: match?.[1] ?? (firstLine || "unknown") });
      });
    });
  }
});
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const frame = parseFrame(line);
  if (frame === void 0) return;
  if (frame.kind === "response") {
    const pending = waiters.get(frame.requestId);
    if (pending === void 0) return;
    waiters.delete(frame.requestId);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error.message));
    return;
  }
  void plugin.handle(frame);
});
