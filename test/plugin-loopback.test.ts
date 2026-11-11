import { describe, expect, it } from 'vitest';
import { parseFrame } from '../src/frames.js';
import { AntigravityPlugin, createCallbackIo } from '../src/plugin.js';
import type { AcpPort, Frame } from '../src/types.js';

const sessionScope = { kind: 'session' as const, sessionId: 'host-sess-1', runtimeGenerationId: 'gen-1' };

function req(
  method: string,
  params: unknown,
  scope: Frame extends never ? never : object = { kind: 'plugin' },
): Extract<Frame, { kind: 'request' }> {
  return { protocolVersion: 1, kind: 'request', requestId: `r-${method}`, scope: scope as never, method, params };
}

describe('AntigravityPlugin full loopback', () => {
  it('handles initialize, check, catalog/list, session/new, prompt, permission, cancel, model/effort/mode, cli-launch, and load', async () => {
    const written: Frame[] = [];
    const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const io = createCallbackIo((frame) => written.push(frame), waiters);

    const permissionDecisions = ['allow_once'];
    let permissionIdx = 0;
    const origCallHost = io.callHost.bind(io);
    io.callHost = async (scope, method, params) => {
      if (method === 'permission/request') {
        const optionId = permissionDecisions[permissionIdx++] ?? 'reject_once';
        return { optionId };
      }
      return origCallHost(scope, method, params);
    };

    const noteHandlers = new Set<(method: string, params: unknown) => void>();
    let reqHandler: ((id: string | number, method: string, params: unknown) => Promise<unknown>) | undefined;
    const notificationsSent: string[] = [];
    let currentModel = 'gemini-4-argon';
    let currentEffort = 'medium';
    let currentMode = 'default';

    const mockAcp: AcpPort = {
      async request(method, params) {
        const rec = (params ?? {}) as Record<string, unknown>;
        if (method === 'initialize') {
          return {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.5' },
          };
        }
        if (method === 'session/list') {
          return {
            sessions: [
              {
                sessionId: 'agy-conv-1',
                title: 'Antigravity Demo Session',
                cwd: '/work',
                updatedAt: '2026-11-11T12:00:00Z',
              },
            ],
          };
        }
        if (method === 'session/new') {
          for (const h of noteHandlers) {
            h('session/update', {
              sessionId: 'agy-conv-1',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'plan', description: 'Create a detailed plan' }],
              },
            });
          }
          return {
            sessionId: 'agy-conv-1',
            configOptions: [
              {
                id: 'model',
                currentValue: currentModel,
                options: [
                  { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
                  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
                ],
              },
              {
                id: 'thought_level',
                currentValue: currentEffort,
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                ],
              },
              {
                id: 'mode',
                currentValue: currentMode,
                options: [
                  { value: 'default', name: 'Default' },
                  { value: 'plan', name: 'Plan' },
                ],
              },
            ],
          };
        }
        if (method === 'session/load') {
          for (const h of noteHandlers) {
            h('session/update', {
              sessionId: 'agy-conv-1',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'Prior user question' },
              },
            });
            h('session/update', {
              sessionId: 'agy-conv-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Prior Antigravity answer' },
              },
            });
          }
          return {
            sessionId: 'agy-conv-1',
            configOptions: [],
          };
        }
        if (method === 'session/prompt') {
          for (const h of noteHandlers) {
            h('session/update', {
              sessionId: 'agy-conv-1',
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Thinking with Gemini 4 Argon...' },
              },
            });
          }
          if (reqHandler) {
            await reqHandler(1, 'session/request_permission', {
              sessionId: 'agy-conv-1',
              toolCall: {
                toolCallId: 'tc-perm-1',
                name: 'run_command',
                title: 'Run git status',
                rawInput: { CommandLine: 'git status' },
              },
              options: [
                { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
              ],
            });
          }
          for (const h of noteHandlers) {
            h('session/update', {
              sessionId: 'agy-conv-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'AGY_RESPONSE_OK' },
              },
            });
          }
          return { stopReason: 'end_turn' };
        }
        if (method === 'session/set_config_option') {
          if (rec.configId === 'model' && typeof rec.value === 'string') currentModel = rec.value;
          if (rec.configId === 'thought_level' && typeof rec.value === 'string') currentEffort = rec.value;
          return {
            configOptions: [
              { id: 'model', currentValue: currentModel, options: [{ value: currentModel, name: currentModel }] },
              {
                id: 'thought_level',
                currentValue: currentEffort,
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          };
        }
        if (method === 'session/set_mode') {
          if (typeof rec.modeId === 'string') currentMode = rec.modeId;
          return {};
        }
        if (method === 'session/close') {
          return {};
        }
        throw new Error(`Unexpected ACP method: ${method}`);
      },
      notify(method) {
        notificationsSent.push(method);
      },
      onNotification(handler) {
        noteHandlers.add(handler);
        return () => {
          noteHandlers.delete(handler);
        };
      },
      onRequest(handler) {
        reqHandler = handler;
        return () => {
          if (reqHandler === handler) reqHandler = undefined;
        };
      },
    };

    const plugin = new AntigravityPlugin({
      io,
      acp: mockAcp,
      pathExists: (p) => p === '/Applications/Gemini.app/Contents/Helpers/agy',
      env: { PATH: '' },
      now: () => '2026-11-11T12:00:00Z',
    });

    await plugin.handle(
      req('plugin/initialize', {
        agentId: 'antigravity',
        pluginRevision: 'rev-1',
        hostProtocolVersion: 1,
        runtime: { binaryPath: 'agy' },
        hostCapabilities: { nativeCliLaunch: true, nativeUserInput: true },
      }),
    );
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: { agentId: 'antigravity', protocolVersion: 1, nativeObservation: true },
    });

    await plugin.handle(req('check', { refresh: true }));
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: {
        agentId: 'antigravity',
        state: 'ready',
        binaryPath: '/Applications/Gemini.app/Contents/Helpers/agy',
        nativeCli: { supported: true },
      },
    });

    await plugin.handle(req('catalog/list', { cwd: '/work' }));
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: [
        {
          backendSessionId: 'agy-conv-1',
          title: 'Antigravity Demo Session',
          cwd: '/work',
        },
      ],
    });

    await plugin.handle(req('session/new', { cwd: '/work', binding: { agentId: 'antigravity' } }, sessionScope));
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: {
        backendSessionId: 'agy-conv-1',
        options: {
          currentModelId: 'gemini-4-argon',
          currentEffortId: 'medium',
          currentModeId: 'default',
        },
      },
    });

    await plugin.handle(req('session/commands', {}, sessionScope));
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: [{ name: 'plan', description: 'Create a detailed plan' }],
    });

    await plugin.handle(
      req('session/prompt', { runId: 'run-1', input: { text: 'Hello Antigravity' } }, sessionScope),
    );
    expect(permissionIdx).toBe(1);
    expect(JSON.stringify(written)).toContain('Thinking with Gemini 4 Argon...');
    expect(JSON.stringify(written)).toContain('AGY_RESPONSE_OK');

    await plugin.handle(req('session/model', { modelId: 'gemini-3.8-flash' }, sessionScope));
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: { currentModelId: 'gemini-3.8-flash' },
    });

    await plugin.handle(req('session/effort', { effortId: 'high' }, sessionScope));
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: { currentEffortId: 'high' },
    });

    await plugin.handle(req('session/mode', { modeId: 'plan' }, sessionScope));
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: { currentModeId: 'plan' },
    });

    await plugin.handle(req('session/cancel', {}, sessionScope));
    expect(notificationsSent).toContain('session/cancel');

    await plugin.handle(
      req('session/cli-launch', { cwd: '/work', binding: { agentId: 'antigravity' } }, sessionScope),
    );
    expect(written.at(-1)).toMatchObject({
      ok: true,
      result: {
        backendSessionId: 'agy-conv-1',
        args: ['--conversation', 'agy-conv-1'],
      },
    });

    const loadScope = { kind: 'session' as const, sessionId: 'host-sess-2', runtimeGenerationId: 'gen-2' };
    await plugin.handle(
      req(
        'session/load',
        { cwd: '/work', binding: { agentId: 'antigravity', backendSessionId: 'agy-conv-1' } },
        loadScope,
      ),
    );
    const loaded = written.at(-1) as Extract<Frame, { kind: 'response'; ok: true }>;
    expect(loaded.ok).toBe(true);
    expect(JSON.stringify((loaded.result as { replayEvents: unknown[] }).replayEvents)).toContain(
      'Prior Antigravity answer',
    );

    expect(parseFrame(JSON.stringify(req('check', {})))?.kind).toBe('request');
  });
});
