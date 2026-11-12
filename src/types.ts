/** Plugin-local copies of Host wire shapes. Keep 1:1 with @piwin/contracts protocol v1. */

export const PROTOCOL_VERSION = 1 as const;
export const AGENT_ID = 'antigravity';

export const SESSION_BACKEND_OPERATIONS = [
  'prompt',
  'cancel',
  'queue',
  'intervene',
  'setModel',
  'setEffort',
  'setMode',
  'slashCommands',
  'fileReferences',
  'images',
  'rename',
  'delete',
  'archive',
  'pin',
  'export',
  'fork',
  'rewind',
  'duplicate',
  'pause',
  'compact',
  'conversationTree',
  'coldStorage',
  'hostSubagents',
  'hostTools',
] as const;

export type SessionBackendOperation = (typeof SESSION_BACKEND_OPERATIONS)[number];

export type SessionBackendOperationSupport =
  | { supported: true }
  | { supported: false; reason: string };

export type SessionBackendCapabilities = {
  agentId: string;
  operations: Record<SessionBackendOperation, SessionBackendOperationSupport>;
  nativeCli?: SessionBackendOperationSupport;
};

export type BackendOption = {
  id: string;
  label: string;
  description?: string;
};

export type BackendModelOption = BackendOption & {
  contextTokens?: number;
  efforts?: readonly string[];
};

export type BackendSlashCommand = {
  name: string;
  description?: string;
  inputHint?: string;
};

export type SessionBackendOptions = {
  agentId: string;
  models: readonly BackendModelOption[];
  currentModelId?: string;
  currentEffortId?: string;
  modes: readonly BackendOption[];
  currentModeId?: string;
  modeConfirmed: boolean;
  autoApprove?: boolean;
  commands: readonly BackendSlashCommand[];
};

export type BackendPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export type BackendPermissionOption = {
  optionId: string;
  label: string;
  kind: BackendPermissionOptionKind;
};

export const TOOL_KINDS = [
  'filesystem',
  'shell',
  'git',
  'web',
  'mcp',
  'process',
  'image',
  'video',
  'subagent',
  'health',
  'other',
] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

export type ToolOutputView = {
  text: string;
  truncated?: boolean;
  redacted?: boolean;
};

export type ToolErrorView = {
  category: 'execution' | 'permission' | 'timeout' | 'cancelled' | 'unknown';
  message: string;
};

export type ToolPresentation = {
  kind: ToolKind;
  title: string;
  routedToolName?: string;
  summary?: string;
  inputPreview?: string;
  command?: string;
  targetPaths?: string[];
  changedPaths?: string[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  output?: ToolOutputView;
  error?: ToolErrorView;
  actionVerb?: string;
};

export type PermissionRiskKind = 'command' | 'file-write' | 'git' | 'network' | 'mcp' | 'unknown';

export type PermissionRequestContext = {
  kind: PermissionRiskKind;
  summary: string;
  reason?: string;
  cwd?: string;
  command?: string;
  paths?: string[];
  backendOptions?: BackendPermissionOption[];
  backendAgentId?: string;
};

export type AgentPluginPermissionPrompt = {
  action: string;
  detail: string;
  context: PermissionRequestContext;
  options: readonly BackendPermissionOption[];
  runId?: string;
};

export type AgentPluginPermissionDecision = { optionId: string } | { cancelled: true };

export type AgentFailureCode =
  | 'provider-authentication'
  | 'provider-quota'
  | 'provider-rate-limit'
  | 'provider-http-error'
  | 'provider-image-input-rejected'
  | 'provider-unavailable'
  | 'model-request-timeout'
  | 'model-stream-missing-finish'
  | 'model-stream-stalled'
  | 'context-limit-exceeded'
  | 'backend-worker-crash'
  | 'backend-protocol-error'
  | 'unknown-agent-failure';

export type AgentFailureOrigin = 'provider' | 'transport' | 'protocol' | 'runtime';

export type AgentFailure = {
  code: AgentFailureCode;
  origin: AgentFailureOrigin;
  message: string;
  retriable: boolean;
  httpStatus?: number;
  nativeName?: string;
};

export type AgentCompletedStopReason = 'stop' | 'length' | 'toolUse' | 'handled';

export type AssistantUsageMeasurement = {
  measurementId: string;
  sessionId: string;
  runId?: string;
  runtimeGenerationId?: string;
  messageId: string;
  modelId?: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extreme';
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  durationMs?: number;
  firstTokenMs?: number;
  timingScope?: 'request' | 'turn';
  reasoningTokens?: number;
  firstTokenKind?: 'reasoning' | 'content';
  stopReason?: string;
  recordedAt: string;
};

export type AgentPromptOutcome =
  | { status: 'completed'; stopReason: AgentCompletedStopReason }
  | { status: 'failed'; stopReason: 'error'; failure: AgentFailure }
  | { status: 'aborted'; stopReason: 'aborted'; message?: string };

export type AgentEvent =
  | { type: 'session/started'; sessionId: string }
  | { type: 'session/ended'; sessionId: string }
  | { type: 'session/aborted'; sessionId: string; messageId?: string; runId?: string }
  | {
      type: 'message/start';
      messageId: string;
      role: 'user' | 'assistant' | 'toolResult';
      backendMessageId?: string;
      runId?: string;
    }
  | { type: 'message/text_delta'; messageId: string; delta: string; runId?: string }
  | { type: 'message/thinking_delta'; messageId: string; delta: string; runId?: string }
  | { type: 'message/end'; messageId: string; runId?: string }
  | {
      type: 'tool/start';
      toolCallId: string;
      toolName: string;
      responseMessageId?: string;
      runId?: string;
      presentation?: ToolPresentation;
    }
  | {
      type: 'tool/update';
      toolCallId: string;
      delta: string;
      responseMessageId?: string;
      runId?: string;
      presentation?: ToolPresentation;
    }
  | {
      type: 'tool/end';
      toolCallId: string;
      isError: boolean;
      responseMessageId?: string;
      runId?: string;
      presentation?: ToolPresentation;
    }
  | {
      type: 'error';
      message: string;
      retriable?: boolean;
      runId?: string;
      failure?: AgentFailure;
    }
  | {
      type: 'usage/finalized';
      measurement: AssistantUsageMeasurement;
    };

export type AgentPluginMediaProposal = {
  directoryId: string;
  relativePath: string;
  kind: 'image' | 'video';
  importKey: string;
  prompt?: string;
  createdAt?: string;
};

export type AgentPluginAgentEmission = {
  type: 'agent';
  event: AgentEvent;
  media?: readonly AgentPluginMediaProposal[];
};

export type ExternalAgentMcpServerStatus = {
  id: string;
  state: 'connected' | 'disconnected' | 'error' | 'unknown';
  detail?: string;
};

export type AgentPluginEmission =
  | AgentPluginAgentEmission
  | { type: 'options'; options: SessionBackendOptions }
  | { type: 'title'; title: string }
  | { type: 'mcp-status'; servers: readonly ExternalAgentMcpServerStatus[]; observed: boolean }
  | { type: 'closed'; reason: string };

export type Scope =
  | { kind: 'plugin' }
  | { kind: 'session'; sessionId: string; runtimeGenerationId: string };

export type Frame =
  | { protocolVersion: 1; kind: 'request'; requestId: string; scope: Scope; method: string; params: unknown }
  | { protocolVersion: 1; kind: 'response'; requestId: string; scope: Scope; method: string; ok: true; result: unknown }
  | {
      protocolVersion: 1;
      kind: 'response';
      requestId: string;
      scope: Scope;
      method: string;
      ok: false;
      error: { code: string; message: string };
    }
  | {
      protocolVersion: 1;
      kind: 'event';
      scope: { kind: 'session'; sessionId: string; runtimeGenerationId: string };
      emission: AgentPluginEmission;
    };

export type AgentPluginCatalogEntry = {
  backendSessionId: string;
  title?: string;
  cwd?: string;
  activity?: string;
  isWorktree?: boolean;
  lastChangeUnixMs?: number;
  modelId?: string;
  autoApprove?: boolean;
  originKind?: string;
};

export type AcpPort = {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  onRequest(handler: (id: string | number, method: string, params: unknown) => Promise<unknown>): () => void;
  onExit?(handler: (reason: string) => void): () => void;
  dispose?(): void;
  pid?(): number | undefined;
};
