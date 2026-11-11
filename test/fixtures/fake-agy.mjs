#!/usr/bin/env node
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('Antigravity CLI 1.5.5\n');
  process.exit(0);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'Antigravity ACP Server', version: '1.5.5' },
        },
      })}\n`,
    );
  } else if (msg.method === 'session/new') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: 'agy_fake_session_1',
          configOptions: [
            {
              id: 'model',
              currentValue: 'gemini-4-argon',
              options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }],
            },
          ],
        },
      })}\n`,
    );
  } else if (msg.method === 'session/close') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
  }
});
