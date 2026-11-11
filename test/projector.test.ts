import { describe, expect, it } from 'vitest';
import { DEFAULT_ANTIGRAVITY_OPTIONS } from '../src/capabilities.js';
import { AcpSessionProjector, normalizePermissionOptions } from '../src/projector.js';

describe('AcpSessionProjector', () => {
  it('projects thinking, assistant text, and Antigravity PascalCase tool calls', () => {
    const projector = new AcpSessionProjector(DEFAULT_ANTIGRAVITY_OPTIONS);
    projector.setRunId('run-42');

    const thought = projector.projectSessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Analyzing workspace...' },
    });
    expect(thought).toEqual([
      {
        type: 'agent',
        event: { type: 'message/start', messageId: 'agy-assistant-1', role: 'assistant', runId: 'run-42' },
      },
      {
        type: 'thinking',
        messageId: 'agy-assistant-1',
        delta: 'Analyzing workspace...',
        runId: 'run-42',
      },
    ]);

    const text = projector.projectSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Here is the result.' },
    });
    expect(text).toEqual([
      {
        type: 'agent',
        event: {
          type: 'message/text_delta',
          messageId: 'agy-assistant-1',
          delta: 'Here is the result.',
          runId: 'run-42',
        },
      },
    ]);

    const toolStart = projector.projectSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      name: 'run_command',
      title: 'List workspace files',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'ls -la', Cwd: '/repo' },
    });
    expect(toolStart).toEqual([
      {
        type: 'agent',
        event: { type: 'tool/start', toolCallId: 'tc-1', toolName: 'run_command', runId: 'run-42' },
      },
      {
        type: 'tool',
        toolCallId: 'tc-1',
        phase: 'start',
        status: 'in_progress',
        presentation: {
          kind: 'execute',
          label: 'List workspace files',
          command: 'ls -la',
          path: '/repo',
        },
        runId: 'run-42',
      },
    ]);

    const toolEnd = projector.projectSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      name: 'run_command',
      title: 'ls -la',
      kind: 'execute',
      status: 'completed',
      rawOutput: { output: 'README.md\npackage.json', exit_code: 0 },
    });
    expect(toolEnd).toEqual([
      {
        type: 'tool',
        toolCallId: 'tc-1',
        phase: 'end',
        status: 'completed',
        presentation: {
          kind: 'execute',
          label: 'ls -la',
          outputPreview: 'README.md\npackage.json',
        },
        runId: 'run-42',
      },
      {
        type: 'agent',
        event: { type: 'tool/end', toolCallId: 'tc-1', isError: false, runId: 'run-42' },
      },
    ]);

    expect(projector.flushActiveMessage()).toEqual([
      {
        type: 'agent',
        event: { type: 'message/end', messageId: 'agy-assistant-1', runId: 'run-42' },
      },
    ]);
  });

  it('normalizes ACP permission options', () => {
    const opts = normalizePermissionOptions([
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ]);
    expect(opts).toEqual([
      { optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', label: 'Deny', kind: 'reject_once' },
    ]);
  });
});
