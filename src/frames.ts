import type { AgentPluginEmission, Frame, Scope } from './types.js';
import { PROTOCOL_VERSION } from './types.js';

export function parseFrame(line: string): Frame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (rec.protocolVersion !== PROTOCOL_VERSION) return undefined;
  if (rec.kind === 'request') {
    if (typeof rec.requestId !== 'string' || typeof rec.method !== 'string') return undefined;
    return rec as Frame;
  }
  if (rec.kind === 'response' || rec.kind === 'event') return rec as Frame;
  return undefined;
}

export function requestFrame(scope: Scope, requestId: string, method: string, params: unknown): Frame {
  return { protocolVersion: PROTOCOL_VERSION, kind: 'request', scope, requestId, method, params };
}

export function okFrame(request: Extract<Frame, { kind: 'request' }>, result: unknown): Frame {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'response',
    scope: request.scope,
    requestId: request.requestId,
    method: request.method,
    ok: true,
    result,
  };
}

export function errFrame(request: Extract<Frame, { kind: 'request' }>, code: string, message: string): Frame {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'response',
    scope: request.scope,
    requestId: request.requestId,
    method: request.method,
    ok: false,
    error: { code, message },
  };
}

export function eventFrame(scope: Extract<Scope, { kind: 'session' }>, emission: AgentPluginEmission): Frame {
  return { protocolVersion: PROTOCOL_VERSION, kind: 'event', scope, emission };
}

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}
