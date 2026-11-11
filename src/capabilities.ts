import {
  AGENT_ID,
  type BackendModelOption,
  type BackendOption,
  type SessionBackendCapabilities,
  type SessionBackendOperation,
  type SessionBackendOperationSupport,
  type SessionBackendOptions,
} from './types.js';

export const DEFAULT_ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'] as const;

export const DEFAULT_ANTIGRAVITY_MODELS: readonly BackendModelOption[] = [
  {
    id: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    description: 'Antigravity flagship Gemini 4 Carbon model with configurable thought level',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    description: 'Antigravity Gemini 4 Argon model with configurable thought level',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    description: 'Fast multimodal Gemini 3.8 Flash model with configurable thought level',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    description: 'Claude Opus 5.5 on Antigravity',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    description: 'Claude Sonnet 5.5 on Antigravity',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
  },
  {
    id: 'gpt-oss-120b-medium',
    label: 'GPT-OSS 120B (Medium)',
    description: 'Open-weight 120B model on Antigravity',
  },
];

export const DEFAULT_ANTIGRAVITY_MODES: readonly BackendOption[] = [
  { id: 'default', label: 'Default', description: 'Prompts for permission on dangerous operations' },
  { id: 'accept-edits', label: 'Accept Edits', description: 'Automatically accepts file edit operations' },
  { id: 'auto', label: 'Auto', description: 'Automatically approves all tool calls (YOLO mode)' },
  { id: 'plan', label: 'Plan', description: 'Read-only mode; creates plans without modifying files' },
];

export const DEFAULT_ANTIGRAVITY_OPTIONS: SessionBackendOptions = {
  agentId: AGENT_ID,
  models: DEFAULT_ANTIGRAVITY_MODELS,
  currentModelId: 'gemini-4-carbon',
  currentEffortId: 'medium',
  modes: DEFAULT_ANTIGRAVITY_MODES,
  currentModeId: 'default',
  modeConfirmed: true,
  autoApprove: false,
  commands: [],
};

const SUPPORTED: SessionBackendOperationSupport = { supported: true };

function unsupported(reason: string): SessionBackendOperationSupport {
  return { supported: false, reason };
}

export function antigravityCapabilities(): SessionBackendCapabilities {
  const operations: Record<SessionBackendOperation, SessionBackendOperationSupport> = {
    prompt: SUPPORTED,
    cancel: SUPPORTED,
    queue: SUPPORTED,
    intervene: unsupported('Antigravity ACP does not expose mid-turn interventions'),
    setModel: SUPPORTED,
    setEffort: SUPPORTED,
    setMode: SUPPORTED,
    slashCommands: SUPPORTED,
    fileReferences: SUPPORTED,
    images: SUPPORTED,
    rename: SUPPORTED,
    delete: unsupported('Antigravity conversations live in ~/.gemini; archive in piwin to hide'),
    archive: SUPPORTED,
    pin: SUPPORTED,
    export: SUPPORTED,
    fork: unsupported('Antigravity ACP does not support session branching'),
    rewind: unsupported('Antigravity owns conversation history natively'),
    duplicate: unsupported('Antigravity ACP does not support duplicating trajectories'),
    pause: unsupported('Antigravity runs can be cancelled, not paused'),
    compact: unsupported('Antigravity manages context compaction automatically'),
    conversationTree: unsupported('Antigravity sessions have a linear transcript'),
    coldStorage: unsupported('Antigravity manages its own trajectory database'),
    hostSubagents: unsupported('Antigravity runs its own subagents internally'),
    hostTools: unsupported('Antigravity executes its own built-in and MCP tools'),
  };
  return {
    agentId: AGENT_ID,
    operations,
    nativeCli: SUPPORTED,
  };
}
