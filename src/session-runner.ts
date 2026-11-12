import { resolveAntigravityAppDataDir } from './binary.js';
import { antigravityCapabilities, DEFAULT_ANTIGRAVITY_OPTIONS } from './capabilities.js';
import { errFrame, eventFrame, okFrame } from './frames.js';
import { reconstructAntigravityHistory } from './history.js';
import { splitCombinedModelAndEffort } from './options.js';
import {
  AcpSessionProjector,
  classifyAntigravityFailure,
  mapAcpStopReason,
  parseAntigravityPermissionPrompt,
} from './projector.js';
import { buildAcpPromptBlocks } from './prompt-content.js';
import type { HostIO } from './plugin.js';
import type {
  AcpPort,
  AgentPluginAgentEmission,
  AgentPluginEmission,
  Frame,
  Scope,
  SessionBackendOptions,
} from './types.js';

export type SessionSlot = {
  scope: Extract<Scope, { kind: 'session' }>;
  cwd: string;
  backendSessionId: string;
  appDataDir: 'antigravity' | 'antigravity-cli';
  projector: AcpSessionProjector;
  replay: AgentPluginAgentEmission[];
  cancelled: boolean;
  runningPrompt: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function applyRequestedBindingChoices(
  acp: AcpPort,
  backendSessionId: string,
  projector: AcpSessionProjector,
  binding: Record<string, unknown> | undefined,
): Promise<SessionBackendOptions> {
  let options = projector.getOptions();
  if (!binding) return options;

  const requestedModel = typeof binding.modelId === 'string' ? binding.modelId.trim() : '';
  if (requestedModel.length > 0 && requestedModel !== options.currentModelId) {
    const { baseModelId } = splitCombinedModelAndEffort(requestedModel);
    try {
      const res = await acp.request('session/set_config_option', {
        sessionId: backendSessionId,
        configId: 'model',
        value: baseModelId,
      });
      options = projector.updateOptionsFromPayload(res);
    } catch {
      // Keep backend-reported model if requested model is unavailable.
    }
  }

  const requestedEffort = typeof binding.effortId === 'string' ? binding.effortId.trim() : '';
  const activeModel = options.models.find((m) => m.id === options.currentModelId);
  if (
    requestedEffort.length > 0 &&
    requestedEffort !== options.currentEffortId &&
    activeModel?.efforts?.includes(requestedEffort)
  ) {
    try {
      const res = await acp.request('session/set_config_option', {
        sessionId: backendSessionId,
        configId: 'thought_level',
        value: requestedEffort,
      });
      options = projector.updateOptionsFromPayload(res);
    } catch {
      // Keep backend-reported effort if unsupported.
    }
  }

  const requestedMode = typeof binding.modeId === 'string' ? binding.modeId.trim() : '';
  if (requestedMode.length > 0 && requestedMode !== options.currentModeId) {
    try {
      await acp.request('session/set_mode', {
        sessionId: backendSessionId,
        modeId: requestedMode,
      });
      options = projector.updateOptionsFromPayload({
        modes: { currentModeId: requestedMode, availableModes: options.modes },
      });
    } catch {
      // Keep backend-reported mode if unsupported.
    }
  }
  return options;
}

export async function openAntigravitySession(input: {
  frame: Extract<Frame, { kind: 'request' }>;
  io: HostIO;
  sessions: Map<string, SessionSlot>;
  ensureAcp: (appDataDir: 'antigravity' | 'antigravity-cli') => Promise<AcpPort>;
  replayStreaming?: boolean;
  agentVersion?: string;
  homeDir?: string;
  fileExists?: (path: string) => boolean;
  readHistoryFile?: (path: string) => string | undefined;
}): Promise<void> {
  const { frame, io, sessions, ensureAcp } = input;
  if (frame.scope.kind !== 'session') {
    io.write(errFrame(frame, 'invalid-request', 'session scope required'));
    return;
  }
  const sessionScope = frame.scope;
  const params = asRecord(frame.params);
  const cwd = typeof params?.cwd === 'string' && params.cwd.length > 0 ? params.cwd : process.cwd();
  const binding = asRecord(params?.binding);
  const storedId = typeof binding?.backendSessionId === 'string' ? binding.backendSessionId.trim() : '';

  if ((frame.method === 'session/load' || frame.method === 'session/resume') && storedId.length === 0) {
    io.write(errFrame(frame, 'invalid-request', 'native session id required'));
    return;
  }

  const existing = sessions.get(sessionScope.sessionId);
  if (frame.method !== 'session/new' && existing && existing.backendSessionId === storedId) {
    existing.scope = sessionScope;
    const isLoad = frame.method === 'session/load';
    if (isLoad && input.replayStreaming === true) {
      for (const emission of existing.replay) {
        io.write(eventFrame(sessionScope, emission));
      }
      io.write(
        okFrame(frame, {
          backendSessionId: existing.backendSessionId,
          ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
          capabilities: antigravityCapabilities(),
          options: existing.projector.getOptions(),
          replayEvents: [],
          streamedReplayEventCount: existing.replay.length,
        }),
      );
      return;
    }
    io.write(
      okFrame(frame, {
        backendSessionId: existing.backendSessionId,
        ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
        capabilities: antigravityCapabilities(),
        options: existing.projector.getOptions(),
        replayEvents: isLoad ? existing.replay : [],
      }),
    );
    return;
  }

  const appDataDir = resolveAntigravityAppDataDir(
    frame.method === 'session/new' ? undefined : storedId,
    {
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      ...(input.fileExists !== undefined ? { fileExists: input.fileExists } : {}),
    },
  );
  const acp = await ensureAcp(appDataDir);
  const projector = new AcpSessionProjector(DEFAULT_ANTIGRAVITY_OPTIONS);
  const replay: AgentPluginAgentEmission[] = [];

  const stopCollect = acp.onNotification((method, noteParams) => {
    if (method !== 'session/update') return;
    const rec = asRecord(noteParams);
    if (!rec) return;
    if (storedId.length > 0 && typeof rec.sessionId === 'string' && rec.sessionId !== storedId) return;
    const update = asRecord(rec.update);
    if (!update) return;
    for (const emission of projector.projectSessionUpdate(update)) {
      if (emission.type === 'agent') {
        replay.push(emission);
      }
    }
  });

  let rpcResult: Record<string, unknown> | undefined;
  try {
    const rpcMethod =
      frame.method === 'session/new'
        ? 'session/new'
        : frame.method === 'session/load'
          ? 'session/load'
          : 'session/resume';
    const rpcParams =
      frame.method === 'session/new'
        ? { cwd, mcpServers: [] }
        : { sessionId: storedId, cwd, mcpServers: [] };
    rpcResult = asRecord(await acp.request(rpcMethod, rpcParams));
  } finally {
    stopCollect();
  }

  for (const emission of projector.finishTurn(false)) {
    if (emission.type === 'agent') {
      replay.push(emission);
    }
  }

  const backendSessionId =
    typeof rpcResult?.sessionId === 'string' && rpcResult.sessionId.length > 0
      ? rpcResult.sessionId
      : storedId;
  if (!backendSessionId) {
    io.write(errFrame(frame, 'backend-error', 'Antigravity ACP did not return a sessionId'));
    return;
  }

  projector.updateOptionsFromPayload(rpcResult);
  const options = await applyRequestedBindingChoices(acp, backendSessionId, projector, binding);

  if (frame.method === 'session/load' && replay.length === 0) {
    const fallbackHistory = reconstructAntigravityHistory({
      sessionId: backendSessionId,
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      ...(input.readHistoryFile !== undefined ? { readFile: input.readHistoryFile } : {}),
    });
    if (fallbackHistory.ok) {
      replay.push(...fallbackHistory.events);
    }
  }

  const slot: SessionSlot = {
    scope: sessionScope,
    cwd,
    backendSessionId,
    appDataDir,
    projector,
    replay,
    cancelled: false,
    runningPrompt: false,
  };
  sessions.set(sessionScope.sessionId, slot);

  const isLoad = frame.method === 'session/load';
  if (isLoad && input.replayStreaming === true) {
    for (const emission of replay) {
      io.write(eventFrame(sessionScope, emission));
    }
    io.write(
      okFrame(frame, {
        backendSessionId,
        ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
        capabilities: antigravityCapabilities(),
        options,
        replayEvents: [],
        streamedReplayEventCount: replay.length,
      }),
    );
    return;
  }

  io.write(
    okFrame(frame, {
      backendSessionId,
      ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
      capabilities: antigravityCapabilities(),
      options,
      replayEvents: isLoad ? replay : [],
    }),
  );
}

export async function runAntigravityPrompt(input: {
  frame: Extract<Frame, { kind: 'request' }>;
  io: HostIO;
  slot: SessionSlot;
  acp: AcpPort;
  readMediaFile?: (path: string) => Buffer | undefined;
}): Promise<void> {
  const { frame, io, slot, acp, readMediaFile } = input;
  const sessionScope = frame.scope as Extract<Scope, { kind: 'session' }>;
  slot.scope = sessionScope;
  const params = asRecord(frame.params);
  const runId = typeof params?.runId === 'string' && params.runId.length > 0 ? params.runId : undefined;
  const promptInput = asRecord(params?.input);
  const text = typeof promptInput?.text === 'string' ? promptInput.text : '';
  const built = buildAcpPromptBlocks(text, promptInput?.attachments, readMediaFile, promptInput?.contextRefs);
  if (!built.ok) {
    io.write(errFrame(frame, 'invalid-request', built.reason));
    return;
  }

  slot.cancelled = false;
  slot.runningPrompt = true;
  slot.projector.setRunId(runId);

  if (text.length > 0) {
    const userMsgId = `agy-prompt-user-${Date.now()}`;
    slot.replay.push(
      { type: 'agent', event: { type: 'message/start', messageId: userMsgId, role: 'user' } },
      { type: 'agent', event: { type: 'message/text_delta', messageId: userMsgId, delta: text } },
      { type: 'agent', event: { type: 'message/end', messageId: userMsgId } },
    );
  }

  const emit = (emission: AgentPluginEmission): void => {
    if (emission.type === 'agent') {
      slot.replay.push(emission);
    }
    io.write(eventFrame(sessionScope, emission));
  };

  const stopNotes = acp.onNotification((method, noteParams) => {
    if (method !== 'session/update') return;
    const rec = asRecord(noteParams);
    if (!rec || (typeof rec.sessionId === 'string' && rec.sessionId !== slot.backendSessionId)) return;
    const update = asRecord(rec.update);
    if (!update) return;
    for (const emission of slot.projector.projectSessionUpdate(update)) {
      emit(emission);
    }
  });

  const stopReqs = acp.onRequest(async (_id, method, reqParams) => {
    if (method === 'session/request_permission') {
      const prompt = parseAntigravityPermissionPrompt(reqParams, runId);
      const decision = asRecord(await io.callHost(sessionScope, 'permission/request', prompt));
      if (decision?.cancelled === true || typeof decision?.optionId !== 'string') {
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId: decision.optionId } };
    }
    throw new Error(`Unsupported ACP client request: ${method}`);
  });

  try {
    const promptRes = asRecord(
      await acp.request('session/prompt', {
        sessionId: slot.backendSessionId,
        prompt: built.blocks,
      }),
    );
    const rawStop = typeof promptRes?.stopReason === 'string' ? promptRes.stopReason : 'end_turn';
    const outcome = mapAcpStopReason(rawStop, slot.cancelled);
    for (const flushed of slot.projector.finishTurn(outcome.status === 'aborted')) {
      emit(flushed);
    }
    const usageRec = asRecord(promptRes?.usage);
    if (usageRec) {
      const inputTokens =
        typeof usageRec.inputTokens === 'number' && Number.isFinite(usageRec.inputTokens)
          ? usageRec.inputTokens
          : undefined;
      const outputTokens =
        typeof usageRec.outputTokens === 'number' && Number.isFinite(usageRec.outputTokens)
          ? usageRec.outputTokens
          : undefined;
      const cachedReadTokens =
        typeof usageRec.cachedReadTokens === 'number' && Number.isFinite(usageRec.cachedReadTokens)
          ? usageRec.cachedReadTokens
          : undefined;
      const cachedWriteTokens =
        typeof usageRec.cachedWriteTokens === 'number' && Number.isFinite(usageRec.cachedWriteTokens)
          ? usageRec.cachedWriteTokens
          : undefined;
      const thoughtTokens =
        typeof usageRec.thoughtTokens === 'number' && Number.isFinite(usageRec.thoughtTokens)
          ? usageRec.thoughtTokens
          : undefined;
      const totalTokens =
        typeof usageRec.totalTokens === 'number' && Number.isFinite(usageRec.totalTokens)
          ? usageRec.totalTokens
          : (inputTokens ?? 0) + (outputTokens ?? 0);

      const assistantMsg = slot.projector.ensureAssistantMessageId();
      for (const msgEmission of assistantMsg.emissions) {
        emit(msgEmission);
      }
      const messageId = assistantMsg.messageId;
      const options = slot.projector.getOptions();
      const currentModelId = options.currentModelId;
      const currentEffort = options.currentEffortId;

      emit({
        type: 'agent',
        event: {
          type: 'usage/finalized',
          measurement: {
            measurementId: `${sessionScope.sessionId}:${messageId}:${runId ?? Date.now()}`,
            sessionId: sessionScope.sessionId,
            messageId,
            ...(runId !== undefined ? { runId } : {}),
            ...(sessionScope.runtimeGenerationId !== undefined
              ? { runtimeGenerationId: sessionScope.runtimeGenerationId }
              : {}),
            ...(currentModelId !== undefined ? { modelId: currentModelId } : {}),
            ...(currentEffort === 'low' || currentEffort === 'medium' || currentEffort === 'high'
              ? { thinkingLevel: currentEffort }
              : {}),
            ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
            ...(outputTokens !== undefined ? { completionTokens: outputTokens } : {}),
            ...(cachedReadTokens !== undefined ? { cacheReadTokens: cachedReadTokens } : {}),
            ...(cachedWriteTokens !== undefined ? { cacheWriteTokens: cachedWriteTokens } : {}),
            ...(thoughtTokens !== undefined ? { reasoningTokens: thoughtTokens } : {}),
            totalTokens,
            stopReason: rawStop,
            recordedAt: new Date().toISOString(),
          },
        },
      });
    }
    if (outcome.status === 'aborted') {
      emit({
        type: 'agent',
        event: {
          type: 'session/aborted',
          sessionId: slot.backendSessionId,
          ...(runId !== undefined ? { runId } : {}),
        },
      });
    }
    io.write(okFrame(frame, outcome));
  } catch (error) {
    for (const flushed of slot.projector.finishTurn(true)) {
      emit(flushed);
    }
    if (slot.cancelled) {
      emit({
        type: 'agent',
        event: {
          type: 'session/aborted',
          sessionId: slot.backendSessionId,
          ...(runId !== undefined ? { runId } : {}),
        },
      });
      io.write(okFrame(frame, { status: 'aborted', stopReason: 'aborted' }));
      return;
    }
    const failure = classifyAntigravityFailure(error);
    emit({
      type: 'agent',
      event: {
        type: 'error',
        message: failure.message,
        retriable: failure.retriable,
        failure,
        ...(runId !== undefined ? { runId } : {}),
      },
    });
    io.write(okFrame(frame, { status: 'failed', stopReason: 'error', failure }));
  } finally {
    slot.runningPrompt = false;
    slot.projector.setRunId(undefined);
    stopNotes();
    stopReqs();
  }
}

export async function configureAntigravitySession(input: {
  frame: Extract<Frame, { kind: 'request' }>;
  io: HostIO;
  slot: SessionSlot | undefined;
  ensureAcp: (appDataDir: 'antigravity' | 'antigravity-cli') => Promise<AcpPort>;
}): Promise<void> {
  const { frame, io, slot, ensureAcp } = input;
  if (!slot) {
    io.write(okFrame(frame, DEFAULT_ANTIGRAVITY_OPTIONS));
    return;
  }
  if (frame.method === 'session/options') {
    io.write(okFrame(frame, slot.projector.getOptions()));
    return;
  }

  const acp = await ensureAcp(slot.appDataDir);
  const params = asRecord(frame.params);
  let updatedOptions: SessionBackendOptions = slot.projector.getOptions();

  if (frame.method === 'session/model') {
    const rawModelId = typeof params?.modelId === 'string' ? params.modelId.trim() : '';
    if (!rawModelId) {
      io.write(errFrame(frame, 'invalid-request', 'modelId is required'));
      return;
    }
    const { baseModelId, effortId } = splitCombinedModelAndEffort(rawModelId);
    const res = await acp.request('session/set_config_option', {
      sessionId: slot.backendSessionId,
      configId: 'model',
      value: baseModelId,
    });
    updatedOptions = slot.projector.updateOptionsFromPayload(res);
    const activeModel = updatedOptions.models.find((m) => m.id === updatedOptions.currentModelId);
    if (effortId && activeModel?.efforts?.includes(effortId)) {
      const effortRes = await acp.request('session/set_config_option', {
        sessionId: slot.backendSessionId,
        configId: 'thought_level',
        value: effortId,
      });
      updatedOptions = slot.projector.updateOptionsFromPayload(effortRes);
    }
  } else if (frame.method === 'session/effort') {
    const effortId = typeof params?.effortId === 'string' ? params.effortId.trim() : '';
    if (!effortId) {
      io.write(errFrame(frame, 'invalid-request', 'effortId is required'));
      return;
    }
    const res = await acp.request('session/set_config_option', {
      sessionId: slot.backendSessionId,
      configId: 'thought_level',
      value: effortId,
    });
    updatedOptions = slot.projector.updateOptionsFromPayload(res);
  } else if (frame.method === 'session/mode') {
    const modeId = typeof params?.modeId === 'string' ? params.modeId.trim() : '';
    if (!modeId) {
      io.write(errFrame(frame, 'invalid-request', 'modeId is required'));
      return;
    }
    await acp.request('session/set_mode', {
      sessionId: slot.backendSessionId,
      modeId,
    });
    updatedOptions = slot.projector.updateOptionsFromPayload({
      modes: { currentModeId: modeId, availableModes: updatedOptions.modes },
    });
  }

  io.write(okFrame(frame, updatedOptions));
}
