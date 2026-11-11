import { describe, expect, it } from 'vitest';
import { parseAcpOptions, splitCombinedModelAndEffort } from '../src/options.js';

describe('options parser', () => {
  it('splits combined model and effort suffixes except gpt-oss-120b-medium', () => {
    expect(splitCombinedModelAndEffort('gemini-4-argon-high')).toEqual({
      baseModelId: 'gemini-4-argon',
      effortId: 'high',
    });
    expect(splitCombinedModelAndEffort('gpt-oss-120b-medium')).toEqual({
      baseModelId: 'gpt-oss-120b-medium',
    });
  });

  it('parses real Antigravity ACP session/new payload into SessionBackendOptions', () => {
    const parsed = parseAcpOptions({
      models: {
        currentModelId: 'gemini-4-argon-medium',
        availableModels: [
          { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
          { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
          { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
          { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
        ],
      },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default', description: 'Prompts for permission' },
          { id: 'plan', name: 'Plan', description: 'Read-only mode' },
        ],
      },
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'gemini-4-argon',
          options: [
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
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });

    expect(parsed.currentModelId).toBe('gemini-4-argon');
    expect(parsed.currentEffortId).toBe('medium');
    expect(parsed.currentModeId).toBe('default');
    expect(parsed.efforts).toEqual(['low', 'medium', 'high']);
    expect(parsed.models[0]).toMatchObject({
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      efforts: ['low', 'medium', 'high'],
    });
    expect(parsed.models[1]?.efforts).toBeUndefined();
  });
});
