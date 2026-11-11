import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createAcpStdio } from './acp-stdio.js';
import { isUnusableAntigravityProbe } from './binary.js';
import { parseFrame } from './frames.js';
import { AntigravityPlugin, createCallbackIo } from './plugin.js';
import type { Frame } from './types.js';

const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const write = (frame: Frame): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};
const io = createCallbackIo(write, waiters);

const plugin = new AntigravityPlugin({
  io,
  createAcp: ({ binaryPath, appDataDir }) => createAcpStdio({ binaryPath, appDataDir }),
  probeBinary(binaryPath) {
    return new Promise((resolve) => {
      const child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', () => {
        resolve({ ok: false });
      });
      child.on('close', (code) => {
        if (code !== 0 || isUnusableAntigravityProbe({ stderr })) {
          resolve({ ok: false });
          return;
        }
        const firstLine = stdout.trim().split('\n')[0]?.trim() ?? '';
        const match = firstLine.match(/(\d+\.\d+\.\d+)/);
        resolve({ ok: true, version: match?.[1] ?? (firstLine || 'unknown') });
      });
    });
  },
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const frame = parseFrame(line);
  if (frame === undefined) return;
  if (frame.kind === 'response') {
    const pending = waiters.get(frame.requestId);
    if (pending === undefined) return;
    waiters.delete(frame.requestId);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error.message));
    return;
  }
  void plugin.handle(frame);
});
