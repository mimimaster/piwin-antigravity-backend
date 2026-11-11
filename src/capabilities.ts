import type { BackendModeOption, BackendModelOption, SessionBackendOptions } from './types.js';

export const DEFAULT_ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'] as const;

export const DEFAULT_ANTIGRAVITY_MODELS: readonly BackendModelOption[] = [
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    description: 'Antigravity flagship Gemini 4 Argon model with configurable thought level',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
    currentEffortId: 'medium',
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'Fast multimodal Gemini 3.8 Flash model with configurable thought level',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
    currentEffortId: 'medium',
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    description: 'Claude Opus 5.5 on Antigravity',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
    currentEffortId: 'medium',
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    description: 'Claude Sonnet 5.5 on Antigravity',
    efforts: DEFAULT_ANTIGRAVITY_EFFORTS,
    currentEffortId: 'medium',
  },
  {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B (Medium)',
    description: 'Open-weight 120B model on Antigravity',
  },
];

export const DEFAULT_ANTIGRAVITY_MODES: readonly BackendModeOption[] = [
  { id: 'default', name: 'Default', description: 'Prompts for permission on dangerous operations' },
  { id: 'accept-edits', name: 'Accept Edits', description: 'Automatically accepts file edit operations' },
  { id: 'auto', name: 'Auto', description: 'Automatically approves all tool calls (YOLO mode)' },
  { id: 'plan', name: 'Plan', description: 'Read-only mode; creates plans without modifying files' },
];

export const DEFAULT_ANTIGRAVITY_OPTIONS: SessionBackendOptions = {
  models: DEFAULT_ANTIGRAVITY_MODELS,
  currentModelId: 'gemini-4-argon',
  efforts: [...DEFAULT_ANTIGRAVITY_EFFORTS],
  currentEffortId: 'medium',
  modes: DEFAULT_ANTIGRAVITY_MODES,
  currentModeId: 'default',
};

export function antigravityCapabilities() {
  const yes = { supported: true as const };
  return {
    agentId: 'antigravity',
    session: {
      create: yes,
      load: yes,
      resume: yes,
      fork: { supported: false as const, reason: 'Antigravity ACP does not expose session/fork' },
      close: yes,
    },
    controls: {
      prompt: yes,
      cancel: yes,
      setModel: yes,
      setEffort: yes,
      setMode: yes,
      slashCommands: yes,
      images: yes,
    },
    nativeCli: { supported: true as const },
  };
}
