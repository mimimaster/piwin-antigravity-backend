import { describe, expect, it } from 'vitest';
import { extractUserRequestText, reconstructAntigravityHistory } from '../src/history.js';

describe('reconstructAntigravityHistory', () => {
  it('extracts <USER_REQUEST> inner text and reconstructs thinking + tool calls + content', () => {
    expect(
      extractUserRequestText('<USER_REQUEST>\nHello Antigravity!\n</USER_REQUEST>\n<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>'),
    ).toBe('Hello Antigravity!');

    const jsonl = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        content: '<USER_REQUEST>\nBuild an ACP extension\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        thinking: 'Checking contracts first.',
        content: 'I will build the extension.',
        tool_calls: [{ name: 'read_file', args: { Path: '/repo/README.md' } }],
      }),
    ].join('\n');

    const res = reconstructAntigravityHistory({
      sessionId: 'sess-123',
      homeDir: '/Users/demo',
      readFile: (p) =>
        p.includes('sess-123/.system_generated/logs/transcript.jsonl') ? jsonl : undefined,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.activity).toBe('idle');
    expect(JSON.stringify(res.events)).toContain('Build an ACP extension');
    expect(JSON.stringify(res.events)).toContain('Checking contracts first.');
    expect(JSON.stringify(res.events)).toContain('I will build the extension.');
    expect(JSON.stringify(res.events)).toContain('read_file');
  });
});
