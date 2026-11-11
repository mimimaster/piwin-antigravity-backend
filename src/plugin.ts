import { resolveAntigravityBinary } from './binary.js';
import { DEFAULT_ANTIGRAVITY_OPTIONS } from './capabilities.js';
import { antigravityCliLaunch } from './cli-launch.js';
import { errFrame, okFrame, requestFrame } from './frames.js';
import { reconstructAntigravityHistory } from './history.js';
import {
  configureAntigravitySession,
  openAntigravitySession,
  runAntigravityPrompt,
  type SessionSlot,
} from './session-runner.js';
import {
  AGENT_ID,
  type AcpPort,
  type AgentPluginCatalogEntry,
  type Frame,
  type Scope,
} from './types.js';

export type HostIO = {
  write(frame: Frame): void;
  callHost(scope: Scope, method: string, params: unknown): Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class AntigravityPlugin {
  private hostBinaryPath: string | undefined;
  private hostCapabilities: { nativeCliLaunch?: boolean; nativeUserInput?: boolean } = {};
  private readonly sessions = new Map<string, SessionSlot>();
  private readonly acpClients = new Map<'antigravity' | 'antigravity-cli', AcpPort>();
  private agentVersion: string | undefined;

  constructor(
    private readonly deps: {
      io: HostIO;
      acp?: AcpPort;
      createAcp?: (input: { binaryPath: string; appDataDir: 'antigravity' | 'antigravity-cli' }) => AcpPort;
      pathExists?: (path: string) => boolean;
      fileExists?: (path: string) => boolean;
      env?: NodeJS.ProcessEnv;
      homeDir?: string;
      now?: () => string;
      probeBinary?: (binaryPath: string) => Promise<{ ok: true; version: string } | { ok: false }>;
      readHistoryFile?: (path: string) => string | undefined;
      readMediaFile?: (path: string) => Buffer | undefined;
    },
  ) {}

  async handle(frame: Frame): Promise<void> {
    if (frame.kind !== 'request') return;
    try {
      await this.dispatch(frame);
    } catch (error) {
      this.deps.io.write(
        errFrame(frame, 'backend-error', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async dispatch(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    switch (frame.method) {
      case 'plugin/initialize': {
        const params = asRecord(frame.params);
        const runtime = asRecord(params?.runtime);
        const caps = asRecord(params?.hostCapabilities);
        this.hostBinaryPath = typeof runtime?.binaryPath === 'string' ? runtime.binaryPath : undefined;
        this.hostCapabilities = {
          nativeCliLaunch: caps?.nativeCliLaunch === true,
          nativeUserInput: caps?.nativeUserInput === true,
        };
        this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, protocolVersion: 1, nativeObservation: true }));
        return;
      }
      case 'plugin/dispose': {
        for (const client of this.acpClients.values()) client.dispose?.();
        this.acpClients.clear();
        this.sessions.clear();
        this.deps.io.write(okFrame(frame, null));
        return;
      }
      case 'check':
        await this.check(frame);
        return;
      case 'catalog/list':
        await this.catalogList(frame);
        return;
      case 'catalog/usage':
        this.deps.io.write(okFrame(frame, []));
        return;
      case 'catalog/native-observe':
        await this.nativeObserve(frame);
        return;
      case 'catalog/rename':
      case 'catalog/delete':
        this.deps.io.write(errFrame(frame, 'unsupported', `${frame.method} is not supported by Antigravity ACP`));
        return;
      case 'session/new':
      case 'session/load':
      case 'session/resume':
        await openAntigravitySession({
          frame,
          io: this.deps.io,
          sessions: this.sessions,
          ensureAcp: (dir) => this.ensureAcp(dir),
          ...(this.agentVersion !== undefined ? { agentVersion: this.agentVersion } : {}),
          ...(this.deps.homeDir !== undefined ? { homeDir: this.deps.homeDir } : {}),
          ...(this.deps.fileExists !== undefined ? { fileExists: this.deps.fileExists } : {}),
          ...(this.deps.readHistoryFile !== undefined ? { readHistoryFile: this.deps.readHistoryFile } : {}),
        });
        return;
      case 'session/prompt':
        await this.prompt(frame);
        return;
      case 'session/cancel':
        await this.cancel(frame);
        return;
      case 'session/options':
      case 'session/model':
      case 'session/effort':
      case 'session/mode': {
        const slot = frame.scope.kind === 'session' ? this.sessions.get(frame.scope.sessionId) : undefined;
        await configureAntigravitySession({
          frame,
          io: this.deps.io,
          slot,
          ensureAcp: (dir) => this.ensureAcp(dir),
        });
        return;
      }
      case 'session/commands': {
        const slot = frame.scope.kind === 'session' ? this.sessions.get(frame.scope.sessionId) : undefined;
        this.deps.io.write(okFrame(frame, slot?.commands ?? []));
        return;
      }
      case 'session/cli-launch':
        this.cliLaunch(frame);
        return;
      case 'session/release':
        await this.releaseSession(frame);
        return;
      default:
        this.deps.io.write(errFrame(frame, 'unsupported', frame.method));
    }
  }

  private resolveBinary(): string | undefined {
    return resolveAntigravityBinary(this.hostBinaryPath, {
      ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
      ...(this.deps.pathExists !== undefined ? { pathExists: this.deps.pathExists } : {}),
      ...(this.deps.homeDir !== undefined ? { homeDir: this.deps.homeDir } : {}),
    });
  }

  private async ensureAcp(appDataDir: 'antigravity' | 'antigravity-cli' = 'antigravity'): Promise<AcpPort> {
    if (this.deps.acp !== undefined) {
      if (!this.acpClients.has(appDataDir)) {
        const initRes = asRecord(
          await this.deps.acp.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'piwin', version: '0.1.0' },
          }),
        );
        const agentInfo = asRecord(initRes?.agentInfo);
        if (typeof agentInfo?.version === 'string') this.agentVersion = agentInfo.version;
        this.acpClients.set(appDataDir, this.deps.acp);
      }
      return this.deps.acp;
    }

    const existing = this.acpClients.get(appDataDir);
    if (existing !== undefined) return existing;

    const binaryPath = this.resolveBinary();
    if (!binaryPath) throw new Error('Antigravity CLI (agy) executable not found');
    if (!this.deps.createAcp) throw new Error('Antigravity ACP factory is not configured');

    const client = this.deps.createAcp({ binaryPath, appDataDir });
    client.onExit?.(() => {
      this.acpClients.delete(appDataDir);
    });
    const initRes = asRecord(
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'piwin', version: '0.1.0' },
      }),
    );
    const agentInfo = asRecord(initRes?.agentInfo);
    if (typeof agentInfo?.version === 'string') this.agentVersion = agentInfo.version;
    this.acpClients.set(appDataDir, client);
    return client;
  }

  private async check(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    const binaryPath = this.resolveBinary();
    const checkedAt = (this.deps.now ?? (() => new Date().toISOString()))();
    if (!binaryPath) {
      this.deps.io.write(
        okFrame(frame, {
          agentId: AGENT_ID,
          state: 'not-installed',
          searched: [
            this.hostBinaryPath ?? 'agy',
            '/Applications/Gemini.app/Contents/Helpers/agy',
            '/Applications/Antigravity.app/Contents/Helpers/agy',
          ],
          checkedAt,
        }),
      );
      return;
    }
    const probe =
      this.deps.probeBinary === undefined
        ? { ok: true as const, version: this.agentVersion ?? '1.5.5' }
        : await this.deps.probeBinary(binaryPath);
    if (!probe.ok) {
      this.deps.io.write(
        okFrame(frame, {
          agentId: AGENT_ID,
          state: 'not-installed',
          searched: [binaryPath],
          checkedAt,
        }),
      );
      return;
    }
    this.agentVersion = probe.version;
    this.deps.io.write(
      okFrame(frame, {
        agentId: AGENT_ID,
        state: 'ready',
        binaryPath,
        version: probe.version,
        supportStatus: 'verified',
        checkedAt,
        nativeCli: { supported: true },
        options: DEFAULT_ANTIGRAVITY_OPTIONS,
      }),
    );
  }

  private async catalogList(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    const params = asRecord(frame.params);
    const cwd = typeof params?.cwd === 'string' && params.cwd.length > 0 ? params.cwd : undefined;
    const acp = await this.ensureAcp('antigravity');
    const raw = asRecord(await acp.request('session/list', cwd ? { cwd } : {}));
    const sessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
    const entries: AgentPluginCatalogEntry[] = [];
    for (const item of sessions) {
      const rec = asRecord(item);
      const backendSessionId = typeof rec?.sessionId === 'string' ? rec.sessionId : undefined;
      if (!backendSessionId) continue;
      const title = typeof rec?.title === 'string' && rec.title.trim().length > 0 ? rec.title.trim() : undefined;
      const itemCwd = typeof rec?.cwd === 'string' && rec.cwd.trim().length > 0 ? rec.cwd.trim() : undefined;
      const updatedAt = typeof rec?.updatedAt === 'string' ? Date.parse(rec.updatedAt) : Number.NaN;
      entries.push({
        backendSessionId,
        ...(title !== undefined ? { title } : {}),
        ...(itemCwd !== undefined ? { cwd: itemCwd } : {}),
        ...(Number.isFinite(updatedAt) ? { lastChangeUnixMs: updatedAt } : {}),
      });
    }
    this.deps.io.write(okFrame(frame, entries));
  }

  private async nativeObserve(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    const params = asRecord(frame.params);
    const backendSessionId = typeof params?.backendSessionId === 'string' ? params.backendSessionId.trim() : '';
    if (backendSessionId.length === 0) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'native session id required'));
      return;
    }
    const live = [...this.sessions.values()].find((slot) => slot.backendSessionId === backendSessionId);
    const reconstructed = reconstructAntigravityHistory({
      sessionId: backendSessionId,
      ...(this.deps.homeDir !== undefined ? { homeDir: this.deps.homeDir } : {}),
      ...(this.deps.readHistoryFile !== undefined ? { readFile: this.deps.readHistoryFile } : {}),
    });
    const activity: 'idle' | 'running' | 'unknown' = live?.runningPrompt
      ? 'running'
      : reconstructed.ok
        ? reconstructed.activity
        : live
          ? 'idle'
          : 'unknown';
    const replayEvents = reconstructed.ok ? reconstructed.events : live?.replay;
    this.deps.io.write(
      okFrame(frame, {
        backendSessionId,
        activity,
        ...(params?.includeHistory === true && replayEvents !== undefined ? { replayEvents } : {}),
      }),
    );
  }

  private async prompt(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required'));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (!slot) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'no session'));
      return;
    }
    const acp = await this.ensureAcp(slot.appDataDir);
    await runAntigravityPrompt({
      frame,
      io: this.deps.io,
      slot,
      acp,
      ...(this.deps.readMediaFile !== undefined ? { readMediaFile: this.deps.readMediaFile } : {}),
    });
  }

  private async cancel(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    if (frame.scope.kind === 'session') {
      const slot = this.sessions.get(frame.scope.sessionId);
      if (slot) {
        slot.cancelled = true;
        const acp = this.acpClients.get(slot.appDataDir) ?? this.deps.acp;
        acp?.notify('session/cancel', { sessionId: slot.backendSessionId });
      }
    }
    this.deps.io.write(okFrame(frame, null));
  }

  private cliLaunch(frame: Extract<Frame, { kind: 'request' }>): void {
    if (this.hostCapabilities.nativeCliLaunch !== true) {
      this.deps.io.write(errFrame(frame, 'unsupported', 'nativeCliLaunch was not negotiated'));
      return;
    }
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required'));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    const params = asRecord(frame.params);
    const binding = asRecord(params?.binding);
    const backendSessionId =
      slot?.backendSessionId ??
      (typeof binding?.backendSessionId === 'string' ? binding.backendSessionId.trim() : '');
    if (!backendSessionId) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'no session'));
      return;
    }
    this.deps.io.write(okFrame(frame, antigravityCliLaunch(backendSessionId)));
  }

  private async releaseSession(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    if (frame.scope.kind === 'session') {
      const slot = this.sessions.get(frame.scope.sessionId);
      if (slot) {
        this.sessions.delete(frame.scope.sessionId);
        const acp = this.acpClients.get(slot.appDataDir) ?? this.deps.acp;
        try {
          await acp?.request('session/close', { sessionId: slot.backendSessionId });
        } catch {
          // Best-effort session cleanup on release.
        }
      }
    }
    this.deps.io.write(okFrame(frame, null));
  }
}

export function createCallbackIo(
  write: (frame: Frame) => void,
  waiters: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>,
): HostIO {
  let seq = 0;
  return {
    write,
    callHost(scope, method, params) {
      const requestId = `cb-${(seq += 1)}`;
      return new Promise((resolve, reject) => {
        waiters.set(requestId, { resolve, reject });
        write(requestFrame(scope, requestId, method, params));
      });
    },
  };
}
