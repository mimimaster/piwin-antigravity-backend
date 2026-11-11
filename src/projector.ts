import { parseAcpOptions } from './options.js';
import type {
  PermissionOption,
  SessionBackendOptions,
  SessionEmission,
  SlashCommandDescriptor,
  ToolPresentation,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(rec: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!rec) return undefined;
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

export function extractToolPresentation(update: Record<string, unknown>): ToolPresentation | undefined {
  const kind = typeof update.kind === 'string' ? update.kind : undefined;
  const label =
    typeof update.title === 'string' && update.title.trim().length > 0
      ? update.title.trim()
      : typeof update.name === 'string' && update.name.trim().length > 0
        ? update.name.trim()
        : undefined;

  const rawInput = asRecord(update.rawInput);
  const command = pickString(rawInput, ['CommandLine', 'command', 'cmd']);

  let path = pickString(rawInput, [
    'Path',
    'TargetFile',
    'SearchDirectory',
    'DirectoryPath',
    'Cwd',
    'path',
    'file_path',
    'filePath',
    'target_file',
    'Query',
    'Pattern',
    'Url',
  ]);
  if (!path && Array.isArray(update.locations)) {
    for (const loc of update.locations) {
      const locRec = asRecord(loc);
      if (typeof locRec?.path === 'string' && locRec.path.trim().length > 0) {
        path = locRec.path.trim();
        break;
      }
    }
  }

  let outputPreview: string | undefined;
  const rawOutput = asRecord(update.rawOutput);
  if (typeof rawOutput?.output === 'string' && rawOutput.output.trim().length > 0) {
    outputPreview = rawOutput.output.slice(0, 4000);
  } else if (Array.isArray(update.content)) {
    const parts: string[] = [];
    for (const item of update.content) {
      const block = asRecord(item);
      if (!block) continue;
      if (block.type === 'content') {
        const inner = asRecord(block.content);
        if (inner?.type === 'text' && typeof inner.text === 'string') {
          parts.push(inner.text);
        }
      } else if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'diff' && typeof block.path === 'string') {
        if (!path) path = block.path;
      }
    }
    const joined = parts.join('\n').trim();
    if (joined.length > 0) outputPreview = joined.slice(0, 4000);
  }

  if (!kind && !label && !command && !path && !outputPreview) return undefined;
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(outputPreview !== undefined ? { outputPreview } : {}),
  };
}

export function normalizePermissionOptions(rawOptions: unknown): PermissionOption[] {
  if (!Array.isArray(rawOptions)) return [];
  const options: PermissionOption[] = [];
  for (const item of rawOptions) {
    const rec = asRecord(item);
    if (!rec || typeof rec.optionId !== 'string') continue;
    const label = typeof rec.name === 'string' ? rec.name : typeof rec.label === 'string' ? rec.label : rec.optionId;
    const rawKind = typeof rec.kind === 'string' ? rec.kind : '';
    const kind: PermissionOption['kind'] =
      rawKind === 'allow_always' || rawKind === 'allow_once' || rawKind === 'reject_always' || rawKind === 'reject_once'
        ? rawKind
        : rawKind.includes('allow')
          ? 'allow_once'
          : 'reject_once';
    options.push({ optionId: rec.optionId, label, kind });
  }
  return options;
}

export class AcpSessionProjector {
  private nextSeq = 1;
  private activeRole: 'user' | 'assistant' | undefined;
  private activeMessageId: string | undefined;
  private activeRunId: string | undefined;
  private readonly startedTools = new Set<string>();
  private readonly endedTools = new Set<string>();
  private currentOptions: SessionBackendOptions;

  constructor(initialOptions: SessionBackendOptions) {
    this.currentOptions = initialOptions;
  }

  setRunId(runId: string | undefined): void {
    this.activeRunId = runId;
  }

  getOptions(): SessionBackendOptions {
    return this.currentOptions;
  }

  updateOptionsFromPayload(payload: unknown): SessionBackendOptions {
    this.currentOptions = parseAcpOptions(payload, this.currentOptions);
    return this.currentOptions;
  }

  flushActiveMessage(): SessionEmission[] {
    if (!this.activeMessageId) return [];
    const messageId = this.activeMessageId;
    const runId = this.activeRunId;
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

  projectSessionUpdate(update: Record<string, unknown>): SessionEmission[] {
    const kind = update.sessionUpdate;
    if (typeof kind !== 'string') return [];

    if (kind === 'user_message_chunk') {
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
      return this.projectCommandsUpdate(update);
    }
    if (kind === 'current_mode_update') {
      const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : undefined;
      if (!modeId) return [];
      this.currentOptions = { ...this.currentOptions, currentModeId: modeId };
      return [{ type: 'options', options: this.currentOptions }];
    }
    if (kind === 'config_option_update') {
      this.currentOptions = parseAcpOptions(update, this.currentOptions);
      return [{ type: 'options', options: this.currentOptions }];
    }
    if (kind === 'session_info_update') {
      const title = typeof update.title === 'string' ? update.title : undefined;
      const updatedAt = typeof update.updatedAt === 'string' ? update.updatedAt : undefined;
      if (title === undefined && updatedAt === undefined) return [];
      return [
        {
          type: 'session_info',
          ...(title !== undefined ? { title } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        },
      ];
    }
    if (kind === 'plan' && Array.isArray(update.entries)) {
      const entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: 'high' | 'medium' | 'low' }[] = [];
      for (const item of update.entries) {
        const rec = asRecord(item);
        if (!rec || typeof rec.content !== 'string') continue;
        const status =
          rec.status === 'in_progress' || rec.status === 'completed' ? rec.status : 'pending';
        const priority =
          rec.priority === 'high' || rec.priority === 'medium' || rec.priority === 'low'
            ? rec.priority
            : undefined;
        entries.push({
          content: rec.content,
          status,
          ...(priority !== undefined ? { priority } : {}),
        });
      }
      return [
        {
          type: 'plan',
          entries,
          ...(this.activeRunId !== undefined ? { runId: this.activeRunId } : {}),
        },
      ];
    }
    return [];
  }

  private ensureMessage(role: 'user' | 'assistant'): { emissions: SessionEmission[]; messageId: string } {
    if (this.activeRole === role && this.activeMessageId) {
      return { emissions: [], messageId: this.activeMessageId };
    }
    const flushed = this.flushActiveMessage();
    const messageId = `agy-${role}-${this.nextSeq}`;
    this.nextSeq += 1;
    this.activeRole = role;
    this.activeMessageId = messageId;
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

  private projectTextChunk(role: 'user' | 'assistant', update: Record<string, unknown>): SessionEmission[] {
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

  private projectThoughtChunk(update: Record<string, unknown>): SessionEmission[] {
    const content = asRecord(update.content);
    const text = typeof content?.text === 'string' ? content.text : undefined;
    if (!text || text.length === 0) return [];
    const { emissions, messageId } = this.ensureMessage('assistant');
    emissions.push({
      type: 'thinking',
      messageId,
      delta: text,
      ...(this.activeRunId !== undefined ? { runId: this.activeRunId } : {}),
    });
    return emissions;
  }

  private projectToolUpdate(
    kind: 'tool_call' | 'tool_call_update',
    update: Record<string, unknown>,
  ): SessionEmission[] {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    if (!toolCallId) return [];
    const rawStatus = typeof update.status === 'string' ? update.status : undefined;
    const status: 'pending' | 'in_progress' | 'completed' | 'failed' =
      rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'in_progress' || rawStatus === 'pending'
        ? rawStatus
        : kind === 'tool_call'
          ? 'in_progress'
          : 'completed';

    const toolName =
      typeof update.name === 'string' && update.name.length > 0
        ? update.name
        : typeof update.title === 'string' && update.title.length > 0
          ? update.title
          : 'tool';
    const presentation = extractToolPresentation(update);
    const runId = this.activeRunId;
    const emissions: SessionEmission[] = [];

    if (!this.startedTools.has(toolCallId)) {
      // Close any streaming user message before starting tool calls
      if (this.activeRole === 'user') {
        emissions.push(...this.flushActiveMessage());
      }
      this.startedTools.add(toolCallId);
      emissions.push({
        type: 'agent',
        event: {
          type: 'tool/start',
          toolCallId,
          toolName,
          ...(runId !== undefined ? { runId } : {}),
        },
      });
      emissions.push({
        type: 'tool',
        toolCallId,
        phase: 'start',
        status: status === 'completed' || status === 'failed' ? 'in_progress' : status,
        ...(presentation !== undefined ? { presentation } : {}),
        ...(runId !== undefined ? { runId } : {}),
      });
    } else if (status === 'pending' || status === 'in_progress') {
      emissions.push({
        type: 'tool',
        toolCallId,
        phase: 'update',
        status,
        ...(presentation !== undefined ? { presentation } : {}),
        ...(runId !== undefined ? { runId } : {}),
      });
    }

    if ((status === 'completed' || status === 'failed') && !this.endedTools.has(toolCallId)) {
      this.endedTools.add(toolCallId);
      emissions.push({
        type: 'tool',
        toolCallId,
        phase: 'end',
        status,
        ...(presentation !== undefined ? { presentation } : {}),
        ...(runId !== undefined ? { runId } : {}),
      });
      emissions.push({
        type: 'agent',
        event: {
          type: 'tool/end',
          toolCallId,
          isError: status === 'failed',
          ...(runId !== undefined ? { runId } : {}),
        },
      });
    }
    return emissions;
  }

  private projectCommandsUpdate(update: Record<string, unknown>): SessionEmission[] {
    if (!Array.isArray(update.availableCommands)) return [];
    const commands: SlashCommandDescriptor[] = [];
    for (const rawCmd of update.availableCommands) {
      const cmd = asRecord(rawCmd);
      if (!cmd || typeof cmd.name !== 'string') continue;
      const description = typeof cmd.description === 'string' ? cmd.description : '';
      const inputRec = asRecord(cmd.input);
      const inputHint = typeof inputRec?.hint === 'string' ? inputRec.hint : undefined;
      commands.push({
        name: cmd.name,
        description,
        ...(inputHint !== undefined ? { inputHint } : {}),
      });
    }
    return [{ type: 'commands', commands }];
  }
}
