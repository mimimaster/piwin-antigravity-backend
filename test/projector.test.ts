import { describe, expect, it } from 'vitest';
import { DEFAULT_ANTIGRAVITY_OPTIONS } from '../src/capabilities.js';
import {
  AcpSessionProjector,
  normalizePermissionOptions,
  parseAntigravityPermissionPrompt,
} from '../src/projector.js';

describe('AcpSessionProjector', () => {
  it('projects thinking, assistant text, and Antigravity PascalCase tool calls into valid AgentPluginEmission frames', () => {
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
        type: 'agent',
        event: {
          type: 'message/thinking_delta',
          messageId: 'agy-assistant-1',
          delta: 'Analyzing workspace...',
          runId: 'run-42',
        },
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
    expect(toolStart).toMatchObject([
      {
        type: 'agent',
        event: { type: 'message/end', messageId: 'agy-assistant-1', runId: 'run-42' },
      },
      {
        type: 'agent',
        event: {
          type: 'tool/start',
          toolCallId: 'tc-1',
          toolName: 'run_command',
          responseMessageId: 'agy-assistant-1',
          runId: 'run-42',
          presentation: {
            kind: 'shell',
            title: 'List workspace files',
            routedToolName: 'run_command',
            command: 'ls -la',
            targetPaths: ['/repo'],
          },
        },
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
    expect(toolEnd).toMatchObject([
      {
        type: 'agent',
        event: {
          type: 'tool/end',
          toolCallId: 'tc-1',
          isError: false,
          responseMessageId: 'agy-assistant-1',
          runId: 'run-42',
          presentation: {
            kind: 'shell',
            title: 'ls -la',
            exitCode: 0,
            output: { text: 'README.md\npackage.json' },
          },
        },
      },
    ]);
  });

  it('normalizes ACP permission prompts to @piwin/contracts PermissionRequestContext', () => {
    const opts = normalizePermissionOptions([
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ]);
    expect(opts).toEqual([
      { optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', label: 'Deny', kind: 'reject_once' },
    ]);

    const prompt = parseAntigravityPermissionPrompt(
      {
        toolCall: {
          name: 'run_command',
          title: 'Run git status',
          kind: 'execute',
          rawInput: { CommandLine: 'git status' },
        },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      },
      'run-9',
    );
    expect(prompt).toMatchObject({
      action: 'Run git status',
      detail: 'git status',
      runId: 'run-9',
      context: {
        kind: 'git',
        summary: 'Run git status',
        command: 'git status',
        backendAgentId: 'antigravity',
      },
    });
  });
});
