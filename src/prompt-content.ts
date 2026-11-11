import { readFileSync } from 'node:fs';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export type AcpPromptBlocksResult =
  | { ok: true; blocks: AcpPromptBlock[] }
  | { ok: false; reason: string };

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Builds ACP prompt content blocks from text + Host media attachments.
 * Passes images as native ACP `{ type: 'image', mimeType, data }` blocks without injecting
 * file paths or base64 strings into the text prompt.
 */
export function buildAcpPromptBlocks(
  text: string,
  attachments: unknown,
  readFile: (path: string) => Buffer | undefined = readBytes,
): AcpPromptBlocksResult {
  const blocks: AcpPromptBlock[] = [];
  if (text.length > 0 || !Array.isArray(attachments) || attachments.length === 0) {
    blocks.push({ type: 'text', text });
  }
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { ok: true, blocks };
  }
  for (const item of attachments) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec.kind !== 'media') continue;
    const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType : '';
    const contentKind = rec.contentKind;
    const isImage =
      contentKind === 'image' || (contentKind === undefined && mimeType.toLowerCase().startsWith('image/'));
    if (!isImage) continue;
    if (typeof rec.path !== 'string' || rec.path.length === 0) {
      return { ok: false, reason: 'image attachment is missing a Host media path' };
    }
    const bytes = readFile(rec.path);
    if (bytes === undefined) {
      return { ok: false, reason: 'image attachment could not be read' };
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'image attachment exceeds 8 MiB' };
    }
    blocks.push({
      type: 'image',
      mimeType: mimeType || 'image/png',
      data: bytes.toString('base64'),
    });
  }
  return { ok: true, blocks };
}
