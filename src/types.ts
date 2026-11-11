/** Plugin-local copies of Host wire shapes. Keep in sync with @piwin/contracts protocol v1. */

export const PROTOCOL_VERSION = 1 as const;
export const AGENT_ID = 'antigravity';

export type Scope =
  | { kind: 'plugin' }
  | { kind: 'session'; sessionId: string; runtimeGenerationId: string };

export type Frame =
  | { protocolVersion: 1; kind: 'request'; requestId: string; scope: Scope; method: string; params: unknown }
  | { protocolVersion: 1; kind: 'response'; requestId: string; scope: Scope; method: string; ok: true; result: unknown }
  | { protocolVersion: 1; kind: 'response'; requestId: string; scope: Scope; method: string; ok: false; error: { code: string; message: string } }
  | { protocolVersion: 1; kind: 'event'; scope: { kind: 'session'; sessionId: string; runtimeGenerationId: string }; emission: unknown };

export type AgentEvent =
  | { type: 'session/started'; sessionId: string }
  | { type: 'message/start'; messageId: string; role: 'user' | 'assistant' | 'toolResult'; backendMessageId?: string; runId?: string }
  | { type: 'message/text_delta'; messageId: string; delta: string; runId?: string }
  | { type: 'message/end'; messageId: string; runId?: string }
  | { type: 'tool/start'; toolCallId: string; toolName: string; runId?: string }
  | { type: 'tool/end'; toolCallId: string; isError: boolean; runId?: string }
  | { type: 'session/aborted'; sessionId: string; messageId?: string; runId?: string };

export type PermissionOption = {
  optionId: string;
  label: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

export type ToolPresentation = {
  kind?: string;
  label?: string;
  command?: string;
  path?: string;
  outputPreview?: string;
};

export type BackendModelOption = {
  id: string;
  name: string;
  description?: string;
  efforts?: readonly string[];
  currentEffortId?: string;
};

export type BackendModeOption = {
  id: string;
  name: string;
  description?: string;
};

export type SessionBackendOptions = {
  models: readonly BackendModelOption[];
  currentModelId?: string;
  efforts: readonly string[];
  currentEffortId?: string;
  modes: readonly BackendModeOption[];
  currentModeId?: string;
};

export type SlashCommandDescriptor = {
  name: string;
  description: string;
  inputHint?: string;
};

export type SessionEmission =
  | { type: 'agent'; event: AgentEvent }
  | { type: 'thinking'; messageId: string; delta: string; runId?: string }
  | { type: 'tool'; toolCallId: string; phase: 'start' | 'update' | 'end'; status: 'pending' | 'in_progress' | 'completed' | 'failed'; presentation?: ToolPresentation; runId?: string }
  | { type: 'plan'; entries: readonly { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: 'high' | 'medium' | 'low' }[]; runId?: string }
  | { type: 'options'; options: SessionBackendOptions }
  | { type: 'commands'; commands: readonly SlashCommandDescriptor[] }
  | { type: 'session_info'; title?: string; updatedAt?: string }
  | { type: 'usage'; used: number; size: number; cost?: { amount: number; currency: string } }
  | { type: 'terminal_released'; backendSessionId: string; reason: string };

export type AgentPluginCatalogEntry = {
  backendSessionId: string;
  title?: string;
  cwd?: string;
  lastChangeUnixMs?: number;
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
