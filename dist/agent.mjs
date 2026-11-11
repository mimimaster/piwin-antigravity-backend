// src/main.ts
import { spawn as spawn2 } from "node:child_process";
import { createInterface } from "node:readline";

// src/acp-stdio.ts
import { spawn } from "node:child_process";
var ACP_DEFAULT_APP_DATA_DIR = "antigravity";
var MAX_FRAME_BYTES = 4e6;
var MAX_BUFFER_BYTES = 8e6;
var MAX_PENDING = 64;
var MAX_STDERR_BYTES = 16384;
function createAcpStdio(input) {
  const spawnImpl = input.spawnImpl ?? spawn;
  const appDataDir = input.appDataDir ?? ACP_DEFAULT_APP_DATA_DIR;
  const args = ["acp", "--app-data-dir", appDataDir];
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
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
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
import { accessSync, constants } from "node:fs";
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
  if (!sessionId) return "antigravity";
  const home = deps.homeDir ?? process.env.HOME ?? homedir();
  const exists = deps.fileExists ?? defaultFileExists;
  const mainDb = join(home, ".gemini", "antigravity", "conversations", `${sessionId}.db`);
  if (exists(mainDb)) return "antigravity";
  const cliDb = join(home, ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
  if (exists(cliDb)) return "antigravity-cli";
  return "antigravity";
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
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    description: "Antigravity flagship Gemini 4 Argon model with configurable thought level",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
    currentEffortId: "medium"
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    description: "Fast multimodal Gemini 3.8 Flash model with configurable thought level",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
    currentEffortId: "medium"
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    description: "Claude Opus 5.5 on Antigravity",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
    currentEffortId: "medium"
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    description: "Claude Sonnet 5.5 on Antigravity",
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
    currentEffortId: "medium"
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    description: "Open-weight 120B model on Antigravity"
  }
];
var DEFAULT_ANTIGRAVITY_MODES = [
  { id: "default", name: "Default", description: "Prompts for permission on dangerous operations" },
  { id: "accept-edits", name: "Accept Edits", description: "Automatically accepts file edit operations" },
  { id: "auto", name: "Auto", description: "Automatically approves all tool calls (YOLO mode)" },
  { id: "plan", name: "Plan", description: "Read-only mode; creates plans without modifying files" }
];
var DEFAULT_ANTIGRAVITY_OPTIONS = {
  models: DEFAULT_ANTIGRAVITY_MODELS,
  currentModelId: "gemini-4-argon",
  efforts: [...DEFAULT_ANTIGRAVITY_EFFORTS],
  currentEffortId: "medium",
  modes: DEFAULT_ANTIGRAVITY_MODES,
  currentModeId: "default"
};
function antigravityCapabilities() {
  const yes = { supported: true };
  return {
    agentId: "antigravity",
    session: {
      create: yes,
      load: yes,
      resume: yes,
      fork: { supported: false, reason: "Antigravity ACP does not expose session/fork" },
      close: yes
    },
    controls: {
      prompt: yes,
      cancel: yes,
      setModel: yes,
      setEffort: yes,
      setMode: yes,
      slashCommands: yes,
      images: yes
    },
    nativeCli: { supported: true }
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
var MAX_LINE_CHARS = 512 * 1024;
var MAX_EVENTS = 2e3;
function asRecord(value) {
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
    join2(homeDir, ".gemini", "antigravity", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"),
    join2(homeDir, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl")
  ];
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
      const rec = asRecord(parsed);
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
      if (thinking.length > 0 || content.length > 0) {
        events.push({ type: "agent", event: { type: "message/start", messageId, role: "assistant" } });
        if (thinking.length > 0) {
          events.push({ type: "thinking", messageId, delta: thinking });
        }
        if (content.length > 0) {
          events.push({ type: "agent", event: { type: "message/text_delta", messageId, delta: content } });
        }
        events.push({ type: "agent", event: { type: "message/end", messageId } });
      }
      let toolIdx = 0;
      for (const rawTool of toolCalls) {
        const tool = asRecord(rawTool);
        if (!tool || typeof tool.name !== "string") continue;
        const toolCallId = `agy-hist-tool-${stepIndex}-${toolIdx++}`;
        events.push(
          { type: "agent", event: { type: "tool/start", toolCallId, toolName: tool.name } },
          { type: "agent", event: { type: "tool/end", toolCallId, isError: record.status === "ERROR" } }
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

// src/options.ts
function asRecord2(value) {
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
function parseAcpOptions(payload, fallback = DEFAULT_ANTIGRAVITY_OPTIONS) {
  const rec = asRecord2(payload);
  if (!rec) return fallback;
  const configOptions = Array.isArray(rec.configOptions) ? rec.configOptions : [];
  const availableModelsBlock = asRecord2(rec.models);
  const availableModels = Array.isArray(availableModelsBlock?.availableModels) ? availableModelsBlock.availableModels : [];
  let currentModelId;
  let currentEffortId;
  let currentModeId;
  let efforts = [];
  const models = [];
  const modes = [];
  const modelEffortsMap = /* @__PURE__ */ new Map();
  for (const item of availableModels) {
    const entry = asRecord2(item);
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
    const cfg = asRecord2(rawConfig);
    if (!cfg || typeof cfg.id !== "string") continue;
    const opts = Array.isArray(cfg.options) ? cfg.options : [];
    const currentValue = typeof cfg.currentValue === "string" ? cfg.currentValue : void 0;
    if (cfg.id === "thought_level" || cfg.category === "thought_level") {
      if (currentValue) currentEffortId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord2(rawOpt);
        const value = typeof opt?.value === "string" ? opt.value : void 0;
        if (value && !efforts.includes(value)) efforts.push(value);
      }
    }
  }
  for (const rawConfig of configOptions) {
    const cfg = asRecord2(rawConfig);
    if (!cfg || typeof cfg.id !== "string") continue;
    const opts = Array.isArray(cfg.options) ? cfg.options : [];
    const currentValue = typeof cfg.currentValue === "string" ? cfg.currentValue : void 0;
    if (cfg.id === "model" || cfg.category === "model") {
      if (currentValue) currentModelId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord2(rawOpt);
        const id = typeof opt?.value === "string" ? opt.value : void 0;
        if (!id) continue;
        const name = typeof opt?.name === "string" ? opt.name : id;
        const description = typeof opt?.description === "string" ? opt.description : void 0;
        const knownEfforts = modelEffortsMap.get(id) ?? (id === "gpt-oss-120b-medium" ? void 0 : efforts.length > 0 ? efforts : [...DEFAULT_ANTIGRAVITY_EFFORTS]);
        models.push({
          id,
          name,
          ...description !== void 0 ? { description } : {},
          ...knownEfforts && knownEfforts.length > 0 ? {
            efforts: knownEfforts,
            ...currentEffortId !== void 0 ? { currentEffortId } : {}
          } : {}
        });
      }
    } else if (cfg.id === "mode" || cfg.category === "mode") {
      if (currentValue) currentModeId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord2(rawOpt);
        const id = typeof opt?.value === "string" ? opt.value : void 0;
        if (!id) continue;
        const name = typeof opt?.name === "string" ? opt.name : id;
        const description = typeof opt?.description === "string" ? opt.description : void 0;
        modes.push({
          id,
          name,
          ...description !== void 0 ? { description } : {}
        });
      }
    }
  }
  if (models.length === 0 && availableModels.length > 0) {
    const seen = /* @__PURE__ */ new Set();
    for (const item of availableModels) {
      const entry = asRecord2(item);
      const rawId = typeof entry?.modelId === "string" ? entry.modelId : void 0;
      if (!rawId) continue;
      const { baseModelId } = splitCombinedModelAndEffort(rawId);
      if (seen.has(baseModelId)) continue;
      seen.add(baseModelId);
      const rawName = typeof entry?.name === "string" ? entry.name : baseModelId;
      const cleanName = rawName.replace(/\s*\((Low|Medium|High)\)\s*$/i, "");
      const description = typeof entry?.description === "string" ? entry.description : void 0;
      const knownEfforts = modelEffortsMap.get(baseModelId);
      models.push({
        id: baseModelId,
        name: cleanName,
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
  const modesBlock = asRecord2(rec.modes);
  if (modes.length === 0 && Array.isArray(modesBlock?.availableModes)) {
    for (const rawMode of modesBlock.availableModes) {
      const m = asRecord2(rawMode);
      const id = typeof m?.id === "string" ? m.id : void 0;
      if (!id) continue;
      const name = typeof m?.name === "string" ? m.name : id;
      const description = typeof m?.description === "string" ? m.description : void 0;
      modes.push({
        id,
        name,
        ...description !== void 0 ? { description } : {}
      });
    }
  }
  if (!currentModeId && typeof modesBlock?.currentModeId === "string") {
    currentModeId = modesBlock.currentModeId;
  }
  const finalModels = models.length > 0 ? models : fallback.models;
  const finalModes = modes.length > 0 ? modes : DEFAULT_ANTIGRAVITY_MODES;
  const resolvedModelId = currentModelId ?? fallback.currentModelId;
  const activeModel = finalModels.find((m) => m.id === resolvedModelId);
  const finalEfforts = efforts.length > 0 ? efforts : activeModel?.efforts ? [...activeModel.efforts] : [];
  const resolvedEffortId = finalEfforts.length > 0 ? currentEffortId ?? fallback.currentEffortId ?? finalEfforts[0] : void 0;
  const resolvedModeId = currentModeId ?? fallback.currentModeId;
  return {
    models: finalModels,
    ...resolvedModelId !== void 0 ? { currentModelId: resolvedModelId } : {},
    efforts: finalEfforts,
    ...resolvedEffortId !== void 0 ? { currentEffortId: resolvedEffortId } : {},
    modes: finalModes,
    ...resolvedModeId !== void 0 ? { currentModeId: resolvedModeId } : {}
  };
}

// src/projector.ts
function asRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function pickString(rec, keys) {
  if (!rec) return void 0;
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return void 0;
}
function extractToolPresentation(update) {
  const kind = typeof update.kind === "string" ? update.kind : void 0;
  const label = typeof update.title === "string" && update.title.trim().length > 0 ? update.title.trim() : typeof update.name === "string" && update.name.trim().length > 0 ? update.name.trim() : void 0;
  const rawInput = asRecord3(update.rawInput);
  const command = pickString(rawInput, ["CommandLine", "command", "cmd"]);
  let path = pickString(rawInput, [
    "Path",
    "TargetFile",
    "SearchDirectory",
    "DirectoryPath",
    "Cwd",
    "path",
    "file_path",
    "filePath",
    "target_file",
    "Query",
    "Pattern",
    "Url"
  ]);
  if (!path && Array.isArray(update.locations)) {
    for (const loc of update.locations) {
      const locRec = asRecord3(loc);
      if (typeof locRec?.path === "string" && locRec.path.trim().length > 0) {
        path = locRec.path.trim();
        break;
      }
    }
  }
  let outputPreview;
  const rawOutput = asRecord3(update.rawOutput);
  if (typeof rawOutput?.output === "string" && rawOutput.output.trim().length > 0) {
    outputPreview = rawOutput.output.slice(0, 4e3);
  } else if (Array.isArray(update.content)) {
    const parts = [];
    for (const item of update.content) {
      const block = asRecord3(item);
      if (!block) continue;
      if (block.type === "content") {
        const inner = asRecord3(block.content);
        if (inner?.type === "text" && typeof inner.text === "string") {
          parts.push(inner.text);
        }
      } else if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "diff" && typeof block.path === "string") {
        if (!path) path = block.path;
      }
    }
    const joined = parts.join("\n").trim();
    if (joined.length > 0) outputPreview = joined.slice(0, 4e3);
  }
  if (!kind && !label && !command && !path && !outputPreview) return void 0;
  return {
    ...kind !== void 0 ? { kind } : {},
    ...label !== void 0 ? { label } : {},
    ...command !== void 0 ? { command } : {},
    ...path !== void 0 ? { path } : {},
    ...outputPreview !== void 0 ? { outputPreview } : {}
  };
}
function normalizePermissionOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) return [];
  const options = [];
  for (const item of rawOptions) {
    const rec = asRecord3(item);
    if (!rec || typeof rec.optionId !== "string") continue;
    const label = typeof rec.name === "string" ? rec.name : typeof rec.label === "string" ? rec.label : rec.optionId;
    const rawKind = typeof rec.kind === "string" ? rec.kind : "";
    const kind = rawKind === "allow_always" || rawKind === "allow_once" || rawKind === "reject_always" || rawKind === "reject_once" ? rawKind : rawKind.includes("allow") ? "allow_once" : "reject_once";
    options.push({ optionId: rec.optionId, label, kind });
  }
  return options;
}
var AcpSessionProjector = class {
  nextSeq = 1;
  activeRole;
  activeMessageId;
  activeRunId;
  startedTools = /* @__PURE__ */ new Set();
  endedTools = /* @__PURE__ */ new Set();
  currentOptions;
  constructor(initialOptions) {
    this.currentOptions = initialOptions;
  }
  setRunId(runId) {
    this.activeRunId = runId;
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
    const runId = this.activeRunId;
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
  projectSessionUpdate(update) {
    const kind = update.sessionUpdate;
    if (typeof kind !== "string") return [];
    if (kind === "user_message_chunk") {
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
      return this.projectCommandsUpdate(update);
    }
    if (kind === "current_mode_update") {
      const modeId = typeof update.currentModeId === "string" ? update.currentModeId : void 0;
      if (!modeId) return [];
      this.currentOptions = { ...this.currentOptions, currentModeId: modeId };
      return [{ type: "options", options: this.currentOptions }];
    }
    if (kind === "config_option_update") {
      this.currentOptions = parseAcpOptions(update, this.currentOptions);
      return [{ type: "options", options: this.currentOptions }];
    }
    if (kind === "session_info_update") {
      const title = typeof update.title === "string" ? update.title : void 0;
      const updatedAt = typeof update.updatedAt === "string" ? update.updatedAt : void 0;
      if (title === void 0 && updatedAt === void 0) return [];
      return [
        {
          type: "session_info",
          ...title !== void 0 ? { title } : {},
          ...updatedAt !== void 0 ? { updatedAt } : {}
        }
      ];
    }
    if (kind === "plan" && Array.isArray(update.entries)) {
      const entries = [];
      for (const item of update.entries) {
        const rec = asRecord3(item);
        if (!rec || typeof rec.content !== "string") continue;
        const status = rec.status === "in_progress" || rec.status === "completed" ? rec.status : "pending";
        const priority = rec.priority === "high" || rec.priority === "medium" || rec.priority === "low" ? rec.priority : void 0;
        entries.push({
          content: rec.content,
          status,
          ...priority !== void 0 ? { priority } : {}
        });
      }
      return [
        {
          type: "plan",
          entries,
          ...this.activeRunId !== void 0 ? { runId: this.activeRunId } : {}
        }
      ];
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
      type: "thinking",
      messageId,
      delta: text,
      ...this.activeRunId !== void 0 ? { runId: this.activeRunId } : {}
    });
    return emissions;
  }
  projectToolUpdate(kind, update) {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : void 0;
    if (!toolCallId) return [];
    const rawStatus = typeof update.status === "string" ? update.status : void 0;
    const status = rawStatus === "completed" || rawStatus === "failed" || rawStatus === "in_progress" || rawStatus === "pending" ? rawStatus : kind === "tool_call" ? "in_progress" : "completed";
    const toolName = typeof update.name === "string" && update.name.length > 0 ? update.name : typeof update.title === "string" && update.title.length > 0 ? update.title : "tool";
    const presentation = extractToolPresentation(update);
    const runId = this.activeRunId;
    const emissions = [];
    if (!this.startedTools.has(toolCallId)) {
      if (this.activeRole === "user") {
        emissions.push(...this.flushActiveMessage());
      }
      this.startedTools.add(toolCallId);
      emissions.push({
        type: "agent",
        event: {
          type: "tool/start",
          toolCallId,
          toolName,
          ...runId !== void 0 ? { runId } : {}
        }
      });
      emissions.push({
        type: "tool",
        toolCallId,
        phase: "start",
        status: status === "completed" || status === "failed" ? "in_progress" : status,
        ...presentation !== void 0 ? { presentation } : {},
        ...runId !== void 0 ? { runId } : {}
      });
    } else if (status === "pending" || status === "in_progress") {
      emissions.push({
        type: "tool",
        toolCallId,
        phase: "update",
        status,
        ...presentation !== void 0 ? { presentation } : {},
        ...runId !== void 0 ? { runId } : {}
      });
    }
    if ((status === "completed" || status === "failed") && !this.endedTools.has(toolCallId)) {
      this.endedTools.add(toolCallId);
      emissions.push({
        type: "tool",
        toolCallId,
        phase: "end",
        status,
        ...presentation !== void 0 ? { presentation } : {},
        ...runId !== void 0 ? { runId } : {}
      });
      emissions.push({
        type: "agent",
        event: {
          type: "tool/end",
          toolCallId,
          isError: status === "failed",
          ...runId !== void 0 ? { runId } : {}
        }
      });
    }
    return emissions;
  }
  projectCommandsUpdate(update) {
    if (!Array.isArray(update.availableCommands)) return [];
    const commands = [];
    for (const rawCmd of update.availableCommands) {
      const cmd = asRecord3(rawCmd);
      if (!cmd || typeof cmd.name !== "string") continue;
      const description = typeof cmd.description === "string" ? cmd.description : "";
      const inputRec = asRecord3(cmd.input);
      const inputHint = typeof inputRec?.hint === "string" ? inputRec.hint : void 0;
      commands.push({
        name: cmd.name,
        description,
        ...inputHint !== void 0 ? { inputHint } : {}
      });
    }
    return [{ type: "commands", commands }];
  }
};

// src/prompt-content.ts
import { readFileSync as readFileSync2 } from "node:fs";
var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
function readBytes(path) {
  try {
    return readFileSync2(path);
  } catch {
    return void 0;
  }
}
function buildAcpPromptBlocks(text, attachments, readFile = readBytes) {
  const blocks = [];
  if (text.length > 0 || !Array.isArray(attachments) || attachments.length === 0) {
    blocks.push({ type: "text", text });
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
function asRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
async function openAntigravitySession(input) {
  const { frame, io: io2, sessions, ensureAcp } = input;
  if (frame.scope.kind !== "session") {
    io2.write(errFrame(frame, "invalid-request", "session scope required"));
    return;
  }
  const params = asRecord4(frame.params);
  const cwd = typeof params?.cwd === "string" && params.cwd.length > 0 ? params.cwd : process.cwd();
  const binding = asRecord4(params?.binding);
  const storedId = typeof binding?.backendSessionId === "string" ? binding.backendSessionId.trim() : "";
  if ((frame.method === "session/load" || frame.method === "session/resume") && storedId.length === 0) {
    io2.write(errFrame(frame, "invalid-request", "native session id required"));
    return;
  }
  const existing = sessions.get(frame.scope.sessionId);
  if (frame.method !== "session/new" && existing && existing.backendSessionId === storedId) {
    io2.write(
      okFrame(frame, {
        backendSessionId: existing.backendSessionId,
        ...input.agentVersion !== void 0 ? { agentVersion: input.agentVersion } : {},
        capabilities: antigravityCapabilities(),
        options: existing.projector.getOptions(),
        replayEvents: frame.method === "session/load" ? existing.replay : []
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
  let commands = [];
  const stopCollect = acp.onNotification((method, noteParams) => {
    if (method !== "session/update") return;
    const rec = asRecord4(noteParams);
    if (!rec) return;
    if (storedId.length > 0 && typeof rec.sessionId === "string" && rec.sessionId !== storedId) return;
    const update = asRecord4(rec.update);
    if (!update) return;
    for (const emission of projector.projectSessionUpdate(update)) {
      if (emission.type === "commands") {
        commands = [...emission.commands];
      }
      replay.push(emission);
    }
  });
  let rpcResult;
  try {
    const rpcMethod = frame.method === "session/new" ? "session/new" : frame.method === "session/load" ? "session/load" : "session/resume";
    const rpcParams = frame.method === "session/new" ? { cwd, mcpServers: [] } : { sessionId: storedId, cwd, mcpServers: [] };
    rpcResult = asRecord4(await acp.request(rpcMethod, rpcParams));
  } finally {
    stopCollect();
  }
  replay.push(...projector.flushActiveMessage());
  const backendSessionId = typeof rpcResult?.sessionId === "string" && rpcResult.sessionId.length > 0 ? rpcResult.sessionId : storedId;
  if (!backendSessionId) {
    io2.write(errFrame(frame, "backend-error", "Antigravity ACP did not return a sessionId"));
    return;
  }
  const options = projector.updateOptionsFromPayload(rpcResult);
  if (frame.method === "session/load" && !replay.some((e) => e.type === "agent")) {
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
    cwd,
    backendSessionId,
    appDataDir,
    projector,
    commands,
    replay,
    cancelled: false,
    runningPrompt: false
  };
  sessions.set(frame.scope.sessionId, slot);
  if (commands.length > 0) {
    io2.write(eventFrame(frame.scope, { type: "commands", commands }));
  }
  io2.write(
    okFrame(frame, {
      backendSessionId,
      ...input.agentVersion !== void 0 ? { agentVersion: input.agentVersion } : {},
      capabilities: antigravityCapabilities(),
      options,
      replayEvents: frame.method === "session/new" ? [] : replay
    })
  );
}
async function runAntigravityPrompt(input) {
  const { frame, io: io2, slot, acp, readMediaFile } = input;
  const sessionScope = frame.scope;
  const params = asRecord4(frame.params);
  const runId = typeof params?.runId === "string" && params.runId.length > 0 ? params.runId : void 0;
  const promptInput = asRecord4(params?.input);
  const text = typeof promptInput?.text === "string" ? promptInput.text : "";
  const built = buildAcpPromptBlocks(text, promptInput?.attachments, readMediaFile);
  if (!built.ok) {
    io2.write(errFrame(frame, "invalid-request", built.reason));
    return;
  }
  slot.cancelled = false;
  slot.runningPrompt = true;
  slot.projector.setRunId(runId);
  const emit = (emission) => {
    if (emission.type === "commands") {
      slot.commands = [...emission.commands];
    }
    slot.replay.push(emission);
    io2.write(eventFrame(sessionScope, emission));
  };
  const stopNotes = acp.onNotification((method, noteParams) => {
    if (method !== "session/update") return;
    const rec = asRecord4(noteParams);
    if (!rec || typeof rec.sessionId === "string" && rec.sessionId !== slot.backendSessionId) return;
    const update = asRecord4(rec.update);
    if (!update) return;
    for (const emission of slot.projector.projectSessionUpdate(update)) {
      emit(emission);
    }
  });
  const stopReqs = acp.onRequest(async (_id, method, reqParams) => {
    if (method === "session/request_permission") {
      const rec = asRecord4(reqParams);
      const toolCall = asRecord4(rec?.toolCall);
      const toolCallId = typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : void 0;
      const toolName = typeof toolCall?.title === "string" && toolCall.title.length > 0 ? toolCall.title : typeof toolCall?.name === "string" && toolCall.name.length > 0 ? toolCall.name : "tool";
      const options = normalizePermissionOptions(rec?.options);
      const decision = asRecord4(
        await io2.callHost(sessionScope, "permission/request", {
          action: toolName,
          detail: JSON.stringify(toolCall?.rawInput ?? {}).slice(0, 500),
          ...toolCallId !== void 0 ? { toolCallId } : {},
          context: { kind: "tool", toolName },
          options,
          ...runId !== void 0 ? { runId } : {}
        })
      );
      if (decision?.cancelled === true || typeof decision?.optionId !== "string") {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: decision.optionId } };
    }
    throw new Error(`Unsupported ACP client request: ${method}`);
  });
  try {
    const promptRes = asRecord4(
      await acp.request("session/prompt", {
        sessionId: slot.backendSessionId,
        prompt: built.blocks
      })
    );
    for (const flushed of slot.projector.flushActiveMessage()) {
      emit(flushed);
    }
    const rawStop = typeof promptRes?.stopReason === "string" ? promptRes.stopReason : "end_turn";
    const aborted = slot.cancelled || rawStop === "cancelled" || rawStop === "aborted";
    if (aborted) {
      emit({
        type: "agent",
        event: {
          type: "session/aborted",
          sessionId: slot.backendSessionId,
          ...runId !== void 0 ? { runId } : {}
        }
      });
    }
    io2.write(
      okFrame(frame, {
        status: aborted ? "aborted" : "ok",
        stopReason: aborted ? "aborted" : rawStop
      })
    );
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
  const params = asRecord4(frame.params);
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
    if (effortId && updatedOptions.efforts.includes(effortId)) {
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
function asRecord5(value) {
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
        const params = asRecord5(frame.params);
        const runtime = asRecord5(params?.runtime);
        const caps = asRecord5(params?.hostCapabilities);
        this.hostBinaryPath = typeof runtime?.binaryPath === "string" ? runtime.binaryPath : void 0;
        this.hostCapabilities = {
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
      case "catalog/delete":
        this.deps.io.write(errFrame(frame, "unsupported", `${frame.method} is not supported by Antigravity ACP`));
        return;
      case "session/new":
      case "session/load":
      case "session/resume":
        await openAntigravitySession({
          frame,
          io: this.deps.io,
          sessions: this.sessions,
          ensureAcp: (dir) => this.ensureAcp(dir),
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
        this.deps.io.write(okFrame(frame, slot?.commands ?? []));
        return;
      }
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
  async ensureAcp(appDataDir = "antigravity") {
    if (this.deps.acp !== void 0) {
      if (!this.acpClients.has(appDataDir)) {
        const initRes2 = asRecord5(
          await this.deps.acp.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "piwin", version: "0.1.0" }
          })
        );
        const agentInfo2 = asRecord5(initRes2?.agentInfo);
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
    client.onExit?.(() => {
      this.acpClients.delete(appDataDir);
    });
    const initRes = asRecord5(
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "piwin", version: "0.1.0" }
      })
    );
    const agentInfo = asRecord5(initRes?.agentInfo);
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
    const params = asRecord5(frame.params);
    const cwd = typeof params?.cwd === "string" && params.cwd.length > 0 ? params.cwd : void 0;
    const acp = await this.ensureAcp("antigravity");
    const raw = asRecord5(await acp.request("session/list", cwd ? { cwd } : {}));
    const sessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
    const entries = [];
    for (const item of sessions) {
      const rec = asRecord5(item);
      const backendSessionId = typeof rec?.sessionId === "string" ? rec.sessionId : void 0;
      if (!backendSessionId) continue;
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
    this.deps.io.write(okFrame(frame, entries));
  }
  async nativeObserve(frame) {
    const params = asRecord5(frame.params);
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
    const params = asRecord5(frame.params);
    const binding = asRecord5(params?.binding);
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
      return new Promise((resolve, reject) => {
        waiters2.set(requestId, { resolve, reject });
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
    return new Promise((resolve) => {
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
        resolve({ ok: false });
      });
      child.on("close", (code) => {
        if (code !== 0 || isUnusableAntigravityProbe({ stderr })) {
          resolve({ ok: false });
          return;
        }
        const firstLine = stdout.trim().split("\n")[0]?.trim() ?? "";
        const match = firstLine.match(/(\d+\.\d+\.\d+)/);
        resolve({ ok: true, version: match?.[1] ?? (firstLine || "unknown") });
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
