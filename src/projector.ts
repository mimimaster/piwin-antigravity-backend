import { parseAcpCommands, parseAcpOptions } from './options.js';
import {
  buildPresentationFromToolState,
  extractAcpToolOutput,
  inferToolKindFromName,
  pickNonEmptyString,
  type ToolCallState,
} from './protocol-mapping.js';
import type { AgentPluginEmission, SessionBackendOptions } from './types.js';

export {
  classifyAntigravityFailure,
  inferToolKindFromName,
  mapAcpStopReason,
  normalizePermissionOptions,
  parseAntigravityPermissionPrompt,
} from './protocol-mapping.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class AcpSessionProjector {
  private nextSeq = 1;
  private activeRole: 'user' | 'assistant' | undefined;
  private activeMessageId: string | undefined;
  private lastAssistantMessageId: string | undefined;
  private activeRunId: string | undefined;
  private readonly tools = new Map<string, ToolCallState>();
  private currentOptions: SessionBackendOptions;

  constructor(initialOptions: SessionBackendOptions) {
    this.currentOptions = initialOptions;
  }

  setRunId(runId: string | undefined): void {
    this.activeRunId = runId;
    if (runId !== undefined) {
      this.lastAssistantMessageId = undefined;
    }
  }

  getOptions(): SessionBackendOptions {
    return this.currentOptions;
  }

  getLastAssistantMessageId(): string | undefined {
    return this.lastAssistantMessageId;
  }

  ensureAssistantMessageId(): { emissions: AgentPluginEmission[]; messageId: string } {
    if (this.lastAssistantMessageId) {
      return { emissions: [], messageId: this.lastAssistantMessageId };
    }
    return this.ensureMessage('assistant');
  }

  updateOptionsFromPayload(payload: unknown): SessionBackendOptions {
    this.currentOptions = parseAcpOptions(payload, this.currentOptions);
    return this.currentOptions;
  }

  flushActiveMessage(): AgentPluginEmission[] {
    if (!this.activeMessageId) return [];
    const messageId = this.activeMessageId;
    const role = this.activeRole;
    const runId = role === 'assistant' ? this.activeRunId : undefined;
    this.activeMessageId = undefined;
    this.activeRole = undefined;
    return [
      {
        type: 'agent',
        event: {
          type: 'message/end',
          messageId,
          ...(runId !== undefined ? { runId } : {}),
        },
      },
    ];
  }

  finishTurn(aborted = false): AgentPluginEmission[] {
    const emissions: AgentPluginEmission[] = [];
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    for (const state of this.tools.values()) {
      if (state.ended) continue;
      state.ended = true;
      const durationMs = Math.max(0, nowMs - state.startedMs);
      emissions.push({
        type: 'agent',
        event: {
          type: 'tool/end',
          toolCallId: state.toolCallId,
          isError: aborted,
          ...(state.responseMessageId !== undefined ? { responseMessageId: state.responseMessageId } : {}),
          ...(this.activeRunId !== undefined ? { runId: this.activeRunId } : {}),
          presentation: buildPresentationFromToolState(state, {
            endedAt: nowIso,
            durationMs,
            isError: aborted,
          }),
        },
      });
    }
    emissions.push(...this.flushActiveMessage());
    return emissions;
  }

  projectSessionUpdate(update: Record<string, unknown>): AgentPluginEmission[] {
    const kind = update.sessionUpdate;
    if (typeof kind !== 'string') return [];

    if (kind === 'user_message_chunk') {
      // During live prompts (activeRunId !== undefined), Host already owns the user row;
      // only project user_message_chunk during session/load replay.
      if (this.activeRunId !== undefined) return [];
      return this.projectTextChunk('user', update);
    }
    if (kind === 'agent_message_chunk') {
      return this.projectTextChunk('assistant', update);
    }
    if (kind === 'agent_thought_chunk') {
      return this.projectThoughtChunk(update);
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      return this.projectToolUpdate(kind, update);
    }
    if (kind === 'available_commands_update') {
      const commands = parseAcpCommands(update.availableCommands);
      this.currentOptions = { ...this.currentOptions, commands };
      return [{ type: 'options', options: this.currentOptions }];
    }
    if (kind === 'current_mode_update') {
      const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : undefined;
      if (!modeId) return [];
      this.currentOptions = {
        ...this.currentOptions,
        currentModeId: modeId,
        modeConfirmed: true,
        autoApprove: modeId === 'auto',
      };
      return [{ type: 'options', options: this.currentOptions }];
    }
    if (kind === 'config_option_update') {
      this.currentOptions = parseAcpOptions(update, this.currentOptions);
      return [{ type: 'options', options: this.currentOptions }];
    }
    if (kind === 'session_info_update') {
      const title = typeof update.title === 'string' && update.title.trim().length > 0 ? update.title.trim() : undefined;
      if (title === undefined) return [];
      return [{ type: 'title', title }];
    }
    return [];
  }

  private ensureMessage(role: 'user' | 'assistant'): { emissions: AgentPluginEmission[]; messageId: string } {
    if (this.activeRole === role && this.activeMessageId) {
      return { emissions: [], messageId: this.activeMessageId };
    }
    const flushed = this.flushActiveMessage();
    const messageId = `agy-${role}-${this.nextSeq}`;
    this.nextSeq += 1;
    this.activeRole = role;
    this.activeMessageId = messageId;
    if (role === 'assistant') {
      this.lastAssistantMessageId = messageId;
    } else {
      this.lastAssistantMessageId = undefined;
    }
    const runId = role === 'assistant' ? this.activeRunId : undefined;
    flushed.push({
      type: 'agent',
      event: {
        type: 'message/start',
        messageId,
        role,
        ...(runId !== undefined ? { runId } : {}),
      },
    });
    return { emissions: flushed, messageId };
  }

  private projectTextChunk(role: 'user' | 'assistant', update: Record<string, unknown>): AgentPluginEmission[] {
    const content = asRecord(update.content);
    const text = typeof content?.text === 'string' ? content.text : undefined;
    if (!text || text.length === 0) return [];
    const { emissions, messageId } = this.ensureMessage(role);
    const runId = role === 'assistant' ? this.activeRunId : undefined;
    emissions.push({
      type: 'agent',
      event: {
        type: 'message/text_delta',
        messageId,
        delta: text,
        ...(runId !== undefined ? { runId } : {}),
      },
    });
    return emissions;
  }

  private projectThoughtChunk(update: Record<string, unknown>): AgentPluginEmission[] {
    const content = asRecord(update.content);
    const text = typeof content?.text === 'string' ? content.text : undefined;
    if (!text || text.length === 0) return [];
    const { emissions, messageId } = this.ensureMessage('assistant');
    emissions.push({
      type: 'agent',
      event: {
        type: 'message/thinking_delta',
        messageId,
        delta: text,
        ...(this.activeRunId !== undefined ? { runId: this.activeRunId } : {}),
      },
    });
    return emissions;
  }

  private projectToolUpdate(
    kind: 'tool_call' | 'tool_call_update',
    update: Record<string, unknown>,
  ): AgentPluginEmission[] {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    if (!toolCallId) return [];
    const rawStatus = typeof update.status === 'string' ? update.status : undefined;
    const status: 'pending' | 'in_progress' | 'completed' | 'failed' =
      rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'in_progress' || rawStatus === 'pending'
        ? rawStatus
        : kind === 'tool_call'
          ? 'in_progress'
          : 'completed';

    const rawInput = asRecord(update.rawInput);
    const command = pickNonEmptyString(rawInput, ['CommandLine', 'command', 'cmd']);
    let pathVal = pickNonEmptyString(rawInput, [
      'Path',
      'TargetFile',
      'SearchDirectory',
      'DirectoryPath',
      'Cwd',
      'path',
      'file_path',
      'filePath',
      'target_file',
    ]);
    if (!pathVal && Array.isArray(update.locations)) {
      for (const loc of update.locations) {
        const locRec = asRecord(loc);
        if (typeof locRec?.path === 'string' && locRec.path.trim().length > 0) {
          pathVal = locRec.path.trim();
          break;
        }
      }
    }
    const extracted = extractAcpToolOutput(update);
    if (!pathVal && extracted.diffPath) pathVal = extracted.diffPath;

    const runId = this.activeRunId;
    const emissions: AgentPluginEmission[] = [];
    let state = this.tools.get(toolCallId);

    if (!state) {
      emissions.push(...this.flushActiveMessage());
      const toolName = pickNonEmptyString(update, ['name', 'title']) ?? 'tool';
      const title = pickNonEmptyString(update, ['title', 'name']) ?? toolName;
      const acpKind = typeof update.kind === 'string' ? update.kind : undefined;
      const nowMs = Date.now();
      state = {
        toolCallId,
        toolName,
        ...(this.lastAssistantMessageId !== undefined ? { responseMessageId: this.lastAssistantMessageId } : {}),
        kind: inferToolKindFromName(toolName, acpKind),
        title,
        ...(command !== undefined ? { command } : {}),
        ...(pathVal !== undefined ? { targetPaths: [pathVal] } : {}),
        ...(extracted.diffPath !== undefined ? { changedPaths: [extracted.diffPath] } : {}),
        ...(extracted.text !== undefined ? { outputText: extracted.text } : {}),
        ...(extracted.truncated ? { outputTruncated: true } : {}),
        ...(extracted.exitCode !== undefined ? { exitCode: extracted.exitCode } : {}),
        startedAt: new Date(nowMs).toISOString(),
        startedMs: nowMs,
        ended: false,
      };
      this.tools.set(toolCallId, state);
      emissions.push({
        type: 'agent',
        event: {
          type: 'tool/start',
          toolCallId,
          toolName: state.toolName,
          ...(state.responseMessageId !== undefined ? { responseMessageId: state.responseMessageId } : {}),
          ...(runId !== undefined ? { runId } : {}),
          presentation: buildPresentationFromToolState(state),
        },
      });
    } else {
      const updatedTitle = pickNonEmptyString(update, ['title']);
      if (updatedTitle !== undefined) state.title = updatedTitle;
      if (command !== undefined) state.command = command;
      if (pathVal !== undefined && (!state.targetPaths || state.targetPaths.length === 0)) {
        state.targetPaths = [pathVal];
      }
      if (extracted.diffPath !== undefined) state.changedPaths = [extracted.diffPath];
      if (extracted.text !== undefined) state.outputText = extracted.text;
      if (extracted.truncated) state.outputTruncated = true;
      if (extracted.exitCode !== undefined) state.exitCode = extracted.exitCode;

      if ((status === 'pending' || status === 'in_progress') && !state.ended) {
        emissions.push({
          type: 'agent',
          event: {
            type: 'tool/update',
            toolCallId,
            delta: extracted.text ?? '',
            ...(state.responseMessageId !== undefined ? { responseMessageId: state.responseMessageId } : {}),
            ...(runId !== undefined ? { runId } : {}),
            presentation: buildPresentationFromToolState(state),
          },
        });
      }
    }

    if ((status === 'completed' || status === 'failed') && !state.ended) {
      state.ended = true;
      const nowMs = Date.now();
      const endedAt = new Date(nowMs).toISOString();
      const durationMs = Math.max(0, nowMs - state.startedMs);
      const isError = status === 'failed';
      emissions.push({
        type: 'agent',
        event: {
          type: 'tool/end',
          toolCallId,
          isError,
          ...(state.responseMessageId !== undefined ? { responseMessageId: state.responseMessageId } : {}),
          ...(runId !== undefined ? { runId } : {}),
          presentation: buildPresentationFromToolState(state, { endedAt, durationMs, isError }),
        },
      });
    }
    return emissions;
  }
}
