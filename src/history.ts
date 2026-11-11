import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionEmission } from './types.js';

export type AntigravityHistoryResult =
  | { ok: true; events: SessionEmission[]; activity: 'idle' | 'running' | 'unknown' }
  | { ok: false; reason: string };

const MAX_LINE_CHARS = 512 * 1024;
const MAX_EVENTS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readUtf8(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function extractUserRequestText(rawContent: string): string {
  const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && typeof match[1] === 'string') {
    return match[1].trim();
  }
  return rawContent.trim();
}

export function antigravityTranscriptCandidates(
  sessionId: string,
  homeDir: string = process.env.HOME ?? homedir(),
): readonly string[] {
  return [
    join(homeDir, '.gemini', 'antigravity', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
    join(homeDir, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
  ];
}

export function reconstructAntigravityHistory(input: {
  sessionId: string;
  homeDir?: string;
  readFile?: (path: string) => string | undefined;
}): AntigravityHistoryResult {
  if (!input.sessionId || input.sessionId.trim().length === 0) {
    return { ok: false, reason: 'native session id required' };
  }
  const reader = input.readFile ?? readUtf8;
  let body: string | undefined;
  for (const candidate of antigravityTranscriptCandidates(input.sessionId, input.homeDir)) {
    body = reader(candidate);
    if (body !== undefined) break;
  }
  if (body === undefined) {
    return { ok: false, reason: 'native transcript unavailable' };
  }

  const events: SessionEmission[] = [];
  let lastStatus: string | undefined;
  let seq = 1;

  for (const raw of body.split('\n')) {
    if (events.length >= MAX_EVENTS) break;
    const line = raw.trim();
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      const rec = asRecord(parsed);
      if (!rec) continue;
      record = rec;
    } catch {
      continue;
    }

    const stepIndex = typeof record.step_index === 'number' ? record.step_index : seq++;
    if (typeof record.status === 'string') {
      lastStatus = record.status;
    }

    if (record.type === 'USER_INPUT' && typeof record.content === 'string') {
      const text = extractUserRequestText(record.content);
      if (text.length === 0) continue;
      const messageId = `agy-hist-user-${stepIndex}`;
      events.push(
        { type: 'agent', event: { type: 'message/start', messageId, role: 'user' } },
        { type: 'agent', event: { type: 'message/text_delta', messageId, delta: text } },
        { type: 'agent', event: { type: 'message/end', messageId } },
      );
      continue;
    }

    if (record.type === 'PLANNER_RESPONSE') {
      const thinking = typeof record.thinking === 'string' ? record.thinking.trim() : '';
      const content = typeof record.content === 'string' ? record.content.trim() : '';
      const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      if (thinking.length === 0 && content.length === 0 && toolCalls.length === 0) continue;

      const messageId = `agy-hist-assistant-${stepIndex}`;
      if (thinking.length > 0 || content.length > 0) {
        events.push({ type: 'agent', event: { type: 'message/start', messageId, role: 'assistant' } });
        if (thinking.length > 0) {
          events.push({ type: 'thinking', messageId, delta: thinking });
        }
        if (content.length > 0) {
          events.push({ type: 'agent', event: { type: 'message/text_delta', messageId, delta: content } });
        }
        events.push({ type: 'agent', event: { type: 'message/end', messageId } });
      }
      let toolIdx = 0;
      for (const rawTool of toolCalls) {
        const tool = asRecord(rawTool);
        if (!tool || typeof tool.name !== 'string') continue;
        const toolCallId = `agy-hist-tool-${stepIndex}-${toolIdx++}`;
        events.push(
          { type: 'agent', event: { type: 'tool/start', toolCallId, toolName: tool.name } },
          { type: 'agent', event: { type: 'tool/end', toolCallId, isError: record.status === 'ERROR' } },
        );
      }
    }
  }

  if (events.length === 0) {
    return { ok: false, reason: 'native transcript empty' };
  }

  const activity: 'idle' | 'running' | 'unknown' =
    lastStatus === 'IN_PROGRESS' || lastStatus === 'RUNNING' || lastStatus === 'PENDING'
      ? 'running'
      : lastStatus === 'DONE' || lastStatus === 'ERROR' || lastStatus === 'CANCELLED'
        ? 'idle'
        : 'unknown';

  return { ok: true, events: events.slice(0, MAX_EVENTS), activity };
}
