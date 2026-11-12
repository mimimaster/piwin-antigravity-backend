import { describe, expect, it } from 'vitest';
import { antigravityCapabilities, DEFAULT_ANTIGRAVITY_OPTIONS } from '../src/capabilities.js';
import { parseAcpOptions, splitCombinedModelAndEffort } from '../src/options.js';
import { SESSION_BACKEND_OPERATIONS } from '../src/types.js';

describe('options & capabilities contracts', () => {
  it('populates all 24 SESSION_BACKEND_OPERATIONS in antigravityCapabilities()', () => {
    const caps = antigravityCapabilities();
    expect(caps.agentId).toBe('antigravity');
    expect(caps.nativeCli).toEqual({ supported: true });
    for (const op of SESSION_BACKEND_OPERATIONS) {
      expect(caps.operations[op]).toBeDefined();
      expect(typeof caps.operations[op].supported).toBe('boolean');
    }
    for (const model of DEFAULT_ANTIGRAVITY_OPTIONS.models) {
      expect(model.label.length).toBeGreaterThan(0);
    }
  });

  it('splits combined model and effort suffixes except gpt-oss-120b-medium', () => {
    expect(splitCombinedModelAndEffort('gemini-4-argon-high')).toEqual({
      baseModelId: 'gemini-4-argon',
      effortId: 'high',
    });
    expect(splitCombinedModelAndEffort('gpt-oss-120b-medium')).toEqual({
      baseModelId: 'gpt-oss-120b-medium',
    });
  });

  it('parses real Antigravity ACP session/new payload into exact SessionBackendOptions with label fields', () => {
    const parsed = parseAcpOptions({
      models: {
        currentModelId: 'gemini-4-carbon-medium',
        availableModels: [
          { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
          { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
          { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
          { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
          { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
        ],
      },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default', description: 'Prompts for permission' },
          { id: 'auto', name: 'Auto', description: 'YOLO mode' },
          { id: 'plan', name: 'Plan', description: 'Read-only mode' },
        ],
      },
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'gemini-4-carbon',
          options: [
            { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
            { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
            { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
          ],
        },
        {
          id: 'thought_level',
          category: 'thought_level',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
        {
          id: 'mode',
          category: 'mode',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'auto', name: 'Auto' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });

    expect(parsed.agentId).toBe('antigravity');
    expect(parsed.currentModelId).toBe('gemini-4-carbon');
    expect(parsed.currentEffortId).toBe('medium');
    expect(parsed.currentModeId).toBe('default');
    expect(parsed.modeConfirmed).toBe(true);
    expect(parsed.autoApprove).toBe(false);
    expect(parsed.commands).toEqual([]);
    expect(parsed.models[0]).toEqual({
      id: 'gemini-4-carbon',
      label: 'Gemini 4 Carbon',
      contextTokens: 1_048_576,
      efforts: ['low', 'medium', 'high'],
    });
    expect(parsed.models[2]).toEqual({
      id: 'gpt-oss-120b-medium',
      label: 'GPT-OSS 120B (Medium)',
      contextTokens: 128_000,
    });
  });
});
