import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AntigravityPlugin, createCallbackIo } from '../src/plugin.js';
import type { Frame } from '../src/types.js';
import {
  parseAntigravityStepMetadataUsage,
  readAntigravitySessionRequestUsage,
} from '../src/usage.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

function encodeVarint(value: number): number[] {
  let rem = BigInt(value);
  const out: number[] = [];
  while (rem >= 0x80n) {
    out.push(Number((rem & 0x7fn) | 0x80n));
    rem >>= 7n;
  }
  out.push(Number(rem));
  return out;
}

function encodeVarintField(fieldNumber: number, value: number): number[] {
  return [...encodeVarint((fieldNumber << 3) | 0), ...encodeVarint(value)];
}

function encodeBytesField(fieldNumber: number, payload: Uint8Array): number[] {
  return [...encodeVarint((fieldNumber << 3) | 2), ...encodeVarint(payload.length), ...payload];
}

function encodeTimestamp(seconds: number, nanos = 0): Uint8Array {
  return Uint8Array.from([
    ...encodeVarintField(1, seconds),
    ...(nanos > 0 ? encodeVarintField(2, nanos) : []),
  ]);
}

function buildStepMetadata(input: {
  createdAtSec: number;
  firstTokenAtSec?: number;
  completedAtSec?: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  requestId?: string;
}): Uint8Array {
  const modelUsage = Uint8Array.from([
    ...encodeVarintField(1, 1437),
    ...encodeVarintField(2, input.promptTokens),
    ...encodeVarintField(3, input.completionTokens),
    ...(input.cacheWriteTokens !== undefined ? encodeVarintField(4, input.cacheWriteTokens) : []),
    ...(input.cacheReadTokens !== undefined ? encodeVarintField(5, input.cacheReadTokens) : []),
    ...(input.requestId !== undefined
      ? encodeBytesField(7, Buffer.from(input.requestId, 'utf8'))
      : []),
    ...(input.reasoningTokens !== undefined ? encodeVarintField(9, input.reasoningTokens) : []),
  ]);

  return Uint8Array.from([
    ...encodeBytesField(1, encodeTimestamp(input.createdAtSec, 250_000_000)),
    ...(input.firstTokenAtSec !== undefined
      ? encodeBytesField(6, encodeTimestamp(input.firstTokenAtSec, 500_000_000))
      : []),
    ...(input.completedAtSec !== undefined
      ? encodeBytesField(7, encodeTimestamp(input.completedAtSec, 750_000_000))
      : []),
    ...encodeBytesField(9, modelUsage),
  ]);
}

describe('Antigravity SQLite usage telemetry', () => {
  it('decodes StepMetadata protobuf token split, cache read, reasoning, and stream clocks', () => {
    const metadata = buildStepMetadata({
      createdAtSec: 1_762_900_000,
      firstTokenAtSec: 1_762_900_002,
      completedAtSec: 1_762_900_006,
      promptTokens: 3552,
      completionTokens: 289,
      cacheReadTokens: 24372,
      reasoningTokens: 136,
      requestId: 'bot-d4083c40-bf18-4095-995d-41ea6f31a495',
    });

    const parsed = parseAntigravityStepMetadataUsage({
      sessionId: 'conv-1',
      stepIndex: 4,
      metadata,
      fallbackModelId: 'gemini-4-carbon',
    });

    expect(parsed).toEqual({
      requestId: 'bot-d4083c40-bf18-4095-995d-41ea6f31a495',
      backendSessionId: 'conv-1',
      modelId: 'gemini-4-carbon',
      promptTokens: 3552,
      completionTokens: 289,
      cacheReadTokens: 24372,
      reasoningTokens: 136,
      totalTokens: 28213,
      firstTokenMs: 2250,
      durationMs: 6500,
      firstTokenKind: 'reasoning',
      recordedAt: new Date(1_762_900_000 * 1000 + 250).toISOString(),
    });
  });

  it('reads and deduplicates step_type=15 rows from ~/.gemini/antigravity-cli/conversations/<id>.db via catalog/usage', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'piwin-agy-usage-'));
    try {
      const convDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations');
      mkdirSync(convDir, { recursive: true });
      const dbPath = join(convDir, 'agy-session-42.db');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');
      const insert = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
      insert.run(1, 14, Buffer.from([0x08, 0x01]));
      insert.run(
        2,
        15,
        buildStepMetadata({
          createdAtSec: 1_762_900_100,
          firstTokenAtSec: 1_762_900_101,
          completedAtSec: 1_762_900_104,
          promptTokens: 2000,
          completionTokens: 150,
          cacheReadTokens: 18000,
          reasoningTokens: 50,
          requestId: 'bot-req-1',
        }),
      );
      insert.run(
        3,
        15,
        buildStepMetadata({
          createdAtSec: 1_762_900_100,
          promptTokens: 2000,
          completionTokens: 150,
          cacheReadTokens: 18000,
          requestId: 'bot-req-1',
        }),
      );
      insert.run(
        4,
        15,
        buildStepMetadata({
          createdAtSec: 1_762_900_200,
          firstTokenAtSec: 1_762_900_202,
          completedAtSec: 1_762_900_208,
          promptTokens: 1200,
          completionTokens: 300,
          cacheReadTokens: 20000,
          requestId: 'bot-req-2',
        }),
      );
      db.close();

      const direct = await readAntigravitySessionRequestUsage({
        sessionId: 'agy-session-42',
        homeDir: tempHome,
        fallbackModelId: 'gemini-4-argon',
      });
      expect(direct).toHaveLength(2);
      expect(direct[0]?.requestId).toBe('bot-req-1');
      expect(direct[1]?.requestId).toBe('bot-req-2');
      expect(direct[1]?.totalTokens).toBe(21500);

      const written: Frame[] = [];
      const io = createCallbackIo((frame) => written.push(frame), new Map());
      const plugin = new AntigravityPlugin({ io, homeDir: tempHome });

      await plugin.handle({
        protocolVersion: 1,
        kind: 'request',
        requestId: 'u-1',
        scope: { kind: 'plugin' },
        method: 'catalog/usage',
        params: {
          from: new Date(1_762_900_150 * 1000).toISOString(),
          sessions: [
            {
              backendSessionId: 'agy-session-42',
              workingDirectory: '/work',
              modelId: 'gemini-4-argon',
            },
          ],
        },
      });

      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        kind: 'response',
        ok: true,
        result: [
          {
            requestId: 'bot-req-2',
            backendSessionId: 'agy-session-42',
            modelId: 'gemini-4-argon',
            promptTokens: 1200,
            completionTokens: 300,
            cacheReadTokens: 20000,
            totalTokens: 21500,
          },
        ],
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
