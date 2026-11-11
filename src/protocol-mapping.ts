import {
  AGENT_ID,
  type AgentFailure,
  type AgentPluginPermissionPrompt,
  type AgentPromptOutcome,
  type BackendPermissionOption,
  type PermissionRiskKind,
  type ToolKind,
  type ToolPresentation,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function pickNonEmptyString(
  rec: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!rec) return undefined;
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

export function inferToolKindFromName(toolName: string, acpKind?: string): ToolKind {
  const lower = toolName.toLowerCase();
  const kindLower = acpKind?.toLowerCase() ?? '';
  if (kindLower === 'execute' || lower.includes('run_command') || lower.includes('bash') || lower.includes('shell')) {
    return 'shell';
  }
  if (lower.startsWith('git') || lower.includes('_git')) {
    return 'git';
  }
  if (
    kindLower === 'read' ||
    kindLower === 'edit' ||
    kindLower === 'delete' ||
    kindLower === 'move' ||
    kindLower === 'search' ||
    lower.includes('file') ||
    lower.includes('grep') ||
    lower.includes('find') ||
    lower.includes('dir')
  ) {
    return 'filesystem';
  }
  if (kindLower === 'fetch' || lower.includes('web') || lower.includes('url') || lower.includes('http')) {
    return 'web';
  }
  if (lower.includes('mcp')) {
    return 'mcp';
  }
  if (lower.includes('subagent') || lower.includes('swarm')) {
    return 'subagent';
  }
  if (lower.includes('task') || lower.includes('process')) {
    return 'process';
  }
  if (lower.includes('image')) {
    return 'image';
  }
  return 'other';
}

export type ToolCallState = {
  toolCallId: string;
  toolName: string;
  responseMessageId?: string;
  kind: ToolKind;
  title: string;
  command?: string;
  targetPaths?: string[];
  changedPaths?: string[];
  outputText?: string;
  outputTruncated?: boolean;
  exitCode?: number | null;
  startedAt: string;
  startedMs: number;
  ended: boolean;
};

const MAX_TOOL_OUTPUT_CHARS = 4_000;

export function extractAcpToolOutput(update: Record<string, unknown>): {
  text?: string;
  truncated?: boolean;
  exitCode?: number | null;
  diffPath?: string;
} {
  const rawOutput = asRecord(update.rawOutput);
  const exitCode =
    typeof rawOutput?.exit_code === 'number'
      ? rawOutput.exit_code
      : typeof rawOutput?.exitCode === 'number'
        ? rawOutput.exitCode
        : undefined;

  if (typeof rawOutput?.output === 'string' && rawOutput.output.trim().length > 0) {
    const raw = rawOutput.output;
    return {
      text: raw.slice(0, MAX_TOOL_OUTPUT_CHARS),
      ...(raw.length > MAX_TOOL_OUTPUT_CHARS ? { truncated: true } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  let diffPath: string | undefined;
  if (Array.isArray(update.content)) {
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
        if (!diffPath) diffPath = block.path;
      }
    }
    const joined = parts.join('\n').trim();
    if (joined.length > 0) {
      return {
        text: joined.slice(0, MAX_TOOL_OUTPUT_CHARS),
        ...(joined.length > MAX_TOOL_OUTPUT_CHARS ? { truncated: true } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(diffPath !== undefined ? { diffPath } : {}),
      };
    }
  }
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(diffPath !== undefined ? { diffPath } : {}),
  };
}

export function buildPresentationFromToolState(
  state: ToolCallState,
  options?: { endedAt?: string; durationMs?: number; isError?: boolean },
): ToolPresentation {
  return {
    kind: state.kind,
    title: state.title,
    routedToolName: state.toolName,
    startedAt: state.startedAt,
    ...(options?.endedAt !== undefined ? { endedAt: options.endedAt } : {}),
    ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    ...(state.command !== undefined ? { command: state.command } : {}),
    ...(state.targetPaths !== undefined && state.targetPaths.length > 0 ? { targetPaths: state.targetPaths } : {}),
    ...(state.changedPaths !== undefined && state.changedPaths.length > 0 ? { changedPaths: state.changedPaths } : {}),
    ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
    ...(state.outputText !== undefined
      ? {
          output: {
            text: state.outputText,
            ...(state.outputTruncated ? { truncated: true } : {}),
          },
        }
      : {}),
    ...(options?.isError
      ? {
          error: {
            category: 'execution',
            message: state.outputText ?? `${state.title} failed`,
          },
        }
      : {}),
  };
}

export function normalizePermissionOptions(rawOptions: unknown): BackendPermissionOption[] {
  if (!Array.isArray(rawOptions)) return [];
  const options: BackendPermissionOption[] = [];
  for (const item of rawOptions) {
    const rec = asRecord(item);
    if (!rec || typeof rec.optionId !== 'string') continue;
    const label = typeof rec.name === 'string' ? rec.name : typeof rec.label === 'string' ? rec.label : rec.optionId;
    const rawKind = typeof rec.kind === 'string' ? rec.kind : '';
    const kind: BackendPermissionOption['kind'] =
      rawKind === 'allow_always' || rawKind === 'allow_once' || rawKind === 'reject_always' || rawKind === 'reject_once'
        ? rawKind
        : rawKind.includes('allow')
          ? 'allow_once'
          : 'reject_once';
    options.push({ optionId: rec.optionId, label, kind });
  }
  return options;
}

export function parseAntigravityPermissionPrompt(
  reqParams: unknown,
  runId: string | undefined,
): AgentPluginPermissionPrompt {
  const rec = asRecord(reqParams);
  const toolCall = asRecord(rec?.toolCall);
  const rawInput = asRecord(toolCall?.rawInput);
  const toolName =
    pickNonEmptyString(toolCall, ['name', 'title']) ??
    pickNonEmptyString(rec, ['action', 'title']) ??
    'tool';
  const title = pickNonEmptyString(toolCall, ['title', 'name']) ?? toolName;
  const command = pickNonEmptyString(rawInput, ['CommandLine', 'command', 'cmd']);
  const pathVal = pickNonEmptyString(rawInput, ['Path', 'TargetFile', 'file_path', 'filePath', 'path']);
  const acpKind = typeof toolCall?.kind === 'string' ? toolCall.kind.toLowerCase() : '';

  let riskKind: PermissionRiskKind = 'unknown';
  if (command?.startsWith('git ') || toolName.toLowerCase().includes('git')) {
    riskKind = 'git';
  } else if (command !== undefined || acpKind === 'execute' || toolName.toLowerCase().includes('command')) {
    riskKind = 'command';
  } else if (acpKind === 'edit' || acpKind === 'delete' || toolName.toLowerCase().includes('write') || toolName.toLowerCase().includes('edit')) {
    riskKind = 'file-write';
  } else if (acpKind === 'fetch' || toolName.toLowerCase().includes('web') || toolName.toLowerCase().includes('http')) {
    riskKind = 'network';
  } else if (toolName.toLowerCase().includes('mcp')) {
    riskKind = 'mcp';
  }

  const options = normalizePermissionOptions(rec?.options);
  const detail =
    command ??
    pathVal ??
    (rawInput && Object.keys(rawInput).length > 0 ? JSON.stringify(rawInput).slice(0, 500) : title);

  return {
    action: title,
    detail,
    context: {
      kind: riskKind,
      summary: title,
      ...(command !== undefined ? { command } : {}),
      ...(pathVal !== undefined ? { paths: [pathVal] } : {}),
      backendOptions: options,
      backendAgentId: AGENT_ID,
    },
    options,
    ...(runId !== undefined ? { runId } : {}),
  };
}

export function classifyAntigravityFailure(error: unknown): AgentFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  const message = raw.slice(0, 500);
  if (lower.includes('auth') || lower.includes('sign in') || lower.includes('unauthenticated') || lower.includes('401')) {
    return { code: 'provider-authentication', origin: 'provider', message, retriable: false };
  }
  if (lower.includes('quota') || lower.includes('exhausted')) {
    return { code: 'provider-quota', origin: 'provider', message, retriable: false };
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return { code: 'provider-rate-limit', origin: 'provider', message, retriable: true };
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { code: 'model-request-timeout', origin: 'transport', message, retriable: true };
  }
  if (lower.includes('exited') || lower.includes('closed')) {
    return { code: 'backend-worker-crash', origin: 'runtime', message, retriable: true };
  }
  return { code: 'unknown-agent-failure', origin: 'runtime', message, retriable: false };
}

export function mapAcpStopReason(rawStop: string | undefined, cancelled: boolean): AgentPromptOutcome {
  if (cancelled || rawStop === 'cancelled' || rawStop === 'aborted') {
    return { status: 'aborted', stopReason: 'aborted' };
  }
  if (rawStop === 'max_tokens' || rawStop === 'length' || rawStop === 'max_turn_requests') {
    return { status: 'completed', stopReason: 'length' };
  }
  if (rawStop === 'tool_use' || rawStop === 'toolUse') {
    return { status: 'completed', stopReason: 'toolUse' };
  }
  if (rawStop === 'refusal' || rawStop === 'handled') {
    return { status: 'completed', stopReason: 'handled' };
  }
  return { status: 'completed', stopReason: 'stop' };
}
