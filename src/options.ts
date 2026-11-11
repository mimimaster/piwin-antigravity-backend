import {
  DEFAULT_ANTIGRAVITY_EFFORTS,
  DEFAULT_ANTIGRAVITY_MODES,
  DEFAULT_ANTIGRAVITY_OPTIONS,
} from './capabilities.js';
import {
  AGENT_ID,
  type BackendModelOption,
  type BackendOption,
  type BackendSlashCommand,
  type SessionBackendOptions,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const EFFORT_SUFFIXES = ['low', 'medium', 'high'] as const;

export function splitCombinedModelAndEffort(rawModelId: string): {
  baseModelId: string;
  effortId?: string;
} {
  if (rawModelId === 'gpt-oss-120b-medium') {
    return { baseModelId: rawModelId };
  }
  for (const effort of EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (rawModelId.endsWith(suffix)) {
      return {
        baseModelId: rawModelId.slice(0, -suffix.length),
        effortId: effort,
      };
    }
  }
  return { baseModelId: rawModelId };
}

export function parseAcpCommands(rawCommands: unknown): BackendSlashCommand[] {
  if (!Array.isArray(rawCommands)) return [];
  const commands: BackendSlashCommand[] = [];
  for (const rawCmd of rawCommands) {
    const cmd = asRecord(rawCmd);
    if (!cmd || typeof cmd.name !== 'string' || cmd.name.trim().length === 0) continue;
    const name = cmd.name.trim();
    const description =
      typeof cmd.description === 'string' && cmd.description.trim().length > 0
        ? cmd.description.trim()
        : undefined;
    const inputRec = asRecord(cmd.input);
    const inputHint =
      typeof inputRec?.hint === 'string' && inputRec.hint.trim().length > 0
        ? inputRec.hint.trim()
        : undefined;
    commands.push({
      name,
      ...(description !== undefined ? { description } : {}),
      ...(inputHint !== undefined ? { inputHint } : {}),
    });
  }
  return commands;
}

export function parseAcpOptions(
  payload: unknown,
  fallback: SessionBackendOptions = DEFAULT_ANTIGRAVITY_OPTIONS,
): SessionBackendOptions {
  const rec = asRecord(payload);
  if (!rec) return fallback;

  const configOptions = Array.isArray(rec.configOptions) ? rec.configOptions : [];
  const availableModelsBlock = asRecord(rec.models);
  const availableModels = Array.isArray(availableModelsBlock?.availableModels)
    ? availableModelsBlock.availableModels
    : [];

  let currentModelId: string | undefined;
  let currentEffortId: string | undefined;
  let currentModeId: string | undefined;
  const efforts: string[] = [];
  const models: BackendModelOption[] = [];
  const modes: BackendOption[] = [];

  const modelEffortsMap = new Map<string, string[]>();
  for (const item of availableModels) {
    const entry = asRecord(item);
    const modelId = typeof entry?.modelId === 'string' ? entry.modelId : undefined;
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
    if (!cfg || typeof cfg.id !== 'string') continue;
    const opts = Array.isArray(cfg.options) ? cfg.options : [];
    const currentValue = typeof cfg.currentValue === 'string' ? cfg.currentValue : undefined;

    if (cfg.id === 'thought_level' || cfg.category === 'thought_level') {
      if (currentValue) currentEffortId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord(rawOpt);
        const value = typeof opt?.value === 'string' ? opt.value : undefined;
        if (value && !efforts.includes(value)) efforts.push(value);
      }
    }
  }

  for (const rawConfig of configOptions) {
    const cfg = asRecord(rawConfig);
    if (!cfg || typeof cfg.id !== 'string') continue;
    const opts = Array.isArray(cfg.options) ? cfg.options : [];
    const currentValue = typeof cfg.currentValue === 'string' ? cfg.currentValue : undefined;

    if (cfg.id === 'model' || cfg.category === 'model') {
      if (currentValue) currentModelId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord(rawOpt);
        const id = typeof opt?.value === 'string' ? opt.value : undefined;
        if (!id) continue;
        const label =
          typeof opt?.name === 'string' && opt.name.trim().length > 0
            ? opt.name.trim()
            : typeof opt?.label === 'string' && opt.label.trim().length > 0
              ? opt.label.trim()
              : id;
        const description = typeof opt?.description === 'string' ? opt.description : undefined;
        const fallbackModel = fallback.models.find((m) => m.id === id);
        const knownEfforts =
          modelEffortsMap.get(id) ??
          (id === 'gpt-oss-120b-medium'
            ? undefined
            : efforts.length > 0
              ? efforts
              : fallbackModel?.efforts
                ? [...fallbackModel.efforts]
                : [...DEFAULT_ANTIGRAVITY_EFFORTS]);
        models.push({
          id,
          label,
          ...(description !== undefined ? { description } : {}),
          ...(knownEfforts && knownEfforts.length > 0 ? { efforts: knownEfforts } : {}),
        });
      }
    } else if (cfg.id === 'mode' || cfg.category === 'mode') {
      if (currentValue) currentModeId = currentValue;
      for (const rawOpt of opts) {
        const opt = asRecord(rawOpt);
        const id = typeof opt?.value === 'string' ? opt.value : undefined;
        if (!id) continue;
        const label =
          typeof opt?.name === 'string' && opt.name.trim().length > 0
            ? opt.name.trim()
            : typeof opt?.label === 'string' && opt.label.trim().length > 0
              ? opt.label.trim()
              : id;
        const description = typeof opt?.description === 'string' ? opt.description : undefined;
        modes.push({
          id,
          label,
          ...(description !== undefined ? { description } : {}),
        });
      }
    }
  }

  if (models.length === 0 && availableModels.length > 0) {
    const seen = new Set<string>();
    for (const item of availableModels) {
      const entry = asRecord(item);
      const rawId = typeof entry?.modelId === 'string' ? entry.modelId : undefined;
      if (!rawId) continue;
      const { baseModelId } = splitCombinedModelAndEffort(rawId);
      if (seen.has(baseModelId)) continue;
      seen.add(baseModelId);
      const rawName = typeof entry?.name === 'string' ? entry.name : baseModelId;
      const label = rawName.replace(/\s*\((Low|Medium|High)\)\s*$/i, '').trim() || baseModelId;
      const description = typeof entry?.description === 'string' ? entry.description : undefined;
      const knownEfforts = modelEffortsMap.get(baseModelId);
      models.push({
        id: baseModelId,
        label,
        ...(description !== undefined ? { description } : {}),
        ...(knownEfforts && knownEfforts.length > 0 ? { efforts: knownEfforts } : {}),
      });
    }
  }

  if (!currentModelId && typeof availableModelsBlock?.currentModelId === 'string') {
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
      const id = typeof m?.id === 'string' ? m.id : undefined;
      if (!id) continue;
      const label =
        typeof m?.name === 'string' && m.name.trim().length > 0
          ? m.name.trim()
          : typeof m?.label === 'string' && m.label.trim().length > 0
            ? m.label.trim()
            : id;
      const description = typeof m?.description === 'string' ? m.description : undefined;
      modes.push({
        id,
        label,
        ...(description !== undefined ? { description } : {}),
      });
    }
  }
  if (!currentModeId && typeof modesBlock?.currentModeId === 'string') {
    currentModeId = modesBlock.currentModeId;
  }

  const finalModels = models.length > 0 ? models : fallback.models;
  const finalModes = modes.length > 0 ? modes : fallback.modes.length > 0 ? fallback.modes : DEFAULT_ANTIGRAVITY_MODES;
  const resolvedModelId = currentModelId ?? fallback.currentModelId;
  const activeModel = finalModels.find((m) => m.id === resolvedModelId);
  const activeModelEfforts = activeModel?.efforts ?? [];
  const resolvedEffortId =
    activeModelEfforts.length > 0
      ? currentEffortId && activeModelEfforts.includes(currentEffortId)
        ? currentEffortId
        : fallback.currentEffortId && activeModelEfforts.includes(fallback.currentEffortId)
          ? fallback.currentEffortId
          : activeModelEfforts[0]
      : undefined;
  const resolvedModeId = currentModeId ?? fallback.currentModeId;
  const commands = Array.isArray(rec.availableCommands)
    ? parseAcpCommands(rec.availableCommands)
    : fallback.commands;

  return {
    agentId: AGENT_ID,
    models: finalModels,
    ...(resolvedModelId !== undefined ? { currentModelId: resolvedModelId } : {}),
    ...(resolvedEffortId !== undefined ? { currentEffortId: resolvedEffortId } : {}),
    modes: finalModes,
    ...(resolvedModeId !== undefined ? { currentModeId: resolvedModeId } : {}),
    modeConfirmed: true,
    autoApprove: resolvedModeId === 'auto',
    commands,
  };
}
