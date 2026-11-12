import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentPluginRequestUsage } from './types.js';

const nodeRequire = createRequire(import.meta.url);

const PLANNER_RESPONSE_STEP_TYPE = 15;

type ProtobufFieldValue = number | Uint8Array;

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | undefined {
  let result = 0n;
  let shift = 0n;
  let pos = start;
  while (pos < bytes.length) {
    const byte = bytes[pos];
    if (byte === undefined) return undefined;
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: Number(result), next: pos };
    }
    shift += 7n;
    if (shift > 63n) return undefined;
  }
  return undefined;
}

function decodeProtobufFields(bytes: Uint8Array): Map<number, ProtobufFieldValue> {
  const fields = new Map<number, ProtobufFieldValue>();
  let pos = 0;
  while (pos < bytes.length) {
    const tag = readVarint(bytes, pos);
    if (!tag) break;
    pos = tag.next;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x07;
    if (fieldNumber <= 0) break;
    if (wireType === 0) {
      const val = readVarint(bytes, pos);
      if (!val) break;
      pos = val.next;
      fields.set(fieldNumber, val.value);
    } else if (wireType === 2) {
      const len = readVarint(bytes, pos);
      if (!len || len.value < 0 || len.next + len.value > bytes.length) break;
      fields.set(fieldNumber, bytes.subarray(len.next, len.next + len.value));
      pos = len.next + len.value;
    } else if (wireType === 1) {
      if (pos + 8 > bytes.length) break;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > bytes.length) break;
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function decodeTimestampMs(value: ProtobufFieldValue | undefined): number | undefined {
  if (!(value instanceof Uint8Array)) return undefined;
  const fields = decodeProtobufFields(value);
  const seconds = fields.get(1);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const nanosRaw = fields.get(2);
  const nanos = typeof nanosRaw === 'number' && Number.isFinite(nanosRaw) && nanosRaw > 0 ? nanosRaw : 0;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

function asNonNegativeInt(value: ProtobufFieldValue | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

/**
 * Decode one `steps.metadata` (`StepMetadata`) protobuf blob from an
 * Antigravity conversation SQLite database (`step_type = 15`).
 */
export function parseAntigravityStepMetadataUsage(input: {
  sessionId: string;
  stepIndex: number;
  metadata: Uint8Array;
  fallbackModelId?: string;
}): AgentPluginRequestUsage | undefined {
  const top = decodeProtobufFields(input.metadata);
  const createdAtMs = decodeTimestampMs(top.get(1));
  const modelUsageBytes = top.get(9);
  if (createdAtMs === undefined || !(modelUsageBytes instanceof Uint8Array)) {
    return undefined;
  }

  const usage = decodeProtobufFields(modelUsageBytes);
  const promptTokens = asNonNegativeInt(usage.get(2));
  const completionTokens = asNonNegativeInt(usage.get(3));
  const cacheWriteTokens = asNonNegativeInt(usage.get(4));
  const cacheReadTokens = asNonNegativeInt(usage.get(5));
  const reasoningTokens = asNonNegativeInt(usage.get(9));

  const totalTokens =
    (promptTokens ?? 0) +
    (completionTokens ?? 0) +
    (cacheReadTokens ?? 0) +
    (cacheWriteTokens ?? 0);
  if (totalTokens <= 0) return undefined;

  const rawRequestId = usage.get(7);
  const decodedRequestId =
    rawRequestId instanceof Uint8Array ? Buffer.from(rawRequestId).toString('utf8').trim() : '';
  const requestId =
    decodedRequestId.length > 0 ? decodedRequestId : `${input.sessionId}:step-${input.stepIndex}`;

  const firstTokenAtMs = decodeTimestampMs(top.get(6));
  const completedAtMs = decodeTimestampMs(top.get(7));
  const firstTokenMs =
    firstTokenAtMs !== undefined && firstTokenAtMs >= createdAtMs
      ? firstTokenAtMs - createdAtMs
      : undefined;
  const durationMs =
    completedAtMs !== undefined && completedAtMs >= createdAtMs
      ? completedAtMs - createdAtMs
      : undefined;
  const firstTokenKind: 'reasoning' | 'content' =
    reasoningTokens !== undefined && reasoningTokens > 0 ? 'reasoning' : 'content';
  const modelId = input.fallbackModelId?.trim();

  return {
    requestId,
    backendSessionId: input.sessionId,
    ...(modelId ? { modelId } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...(firstTokenMs !== undefined || durationMs !== undefined ? { firstTokenKind } : {}),
    recordedAt: new Date(createdAtMs).toISOString(),
  };
}

function isSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    !sessionId.includes('/') &&
    !sessionId.includes('\\') &&
    !sessionId.includes('..')
  );
}

/**
 * Read per-request usage history for an Antigravity conversation from its
 * native SQLite trajectory store under `~/.gemini/{antigravity-cli,antigravity}/conversations/`.
 */
export async function readAntigravitySessionRequestUsage(input: {
  sessionId: string;
  homeDir?: string;
  from?: string;
  fallbackModelId?: string;
  fileExists?: (path: string) => boolean;
}): Promise<AgentPluginRequestUsage[]> {
  const sessionId = input.sessionId.trim();
  if (!isSafeSessionId(sessionId)) return [];

  const home = input.homeDir ?? homedir();
  const checkExists = input.fileExists ?? existsSync;
  const candidates = [
    join(home, '.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`),
    join(home, '.gemini', 'antigravity', 'conversations', `${sessionId}.db`),
  ];
  const dbPath = candidates.find((candidate) => checkExists(candidate));
  if (!dbPath) return [];

  const fromMs = input.from !== undefined ? Date.parse(input.from) : Number.NaN;

  try {
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare('SELECT idx, metadata FROM steps WHERE step_type = ? ORDER BY idx ASC')
        .all(PLANNER_RESPONSE_STEP_TYPE) as Array<{
        idx?: unknown;
        metadata?: unknown;
      }>;
      const seenIds = new Set<string>();
      const results: AgentPluginRequestUsage[] = [];
      for (const row of rows) {
        if (!(row.metadata instanceof Uint8Array)) continue;
        const stepIndex = typeof row.idx === 'number' && Number.isFinite(row.idx) ? row.idx : 0;
        const parsed = parseAntigravityStepMetadataUsage({
          sessionId,
          stepIndex,
          metadata: row.metadata,
          ...(input.fallbackModelId !== undefined ? { fallbackModelId: input.fallbackModelId } : {}),
        });
        if (!parsed || seenIds.has(parsed.requestId)) continue;
        if (Number.isFinite(fromMs) && Date.parse(parsed.recordedAt) < fromMs) continue;
        seenIds.add(parsed.requestId);
        results.push(parsed);
      }
      return results;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
