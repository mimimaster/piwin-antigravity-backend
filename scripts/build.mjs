import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const outfile = join(root, 'dist', 'agent.mjs');
await mkdir(dirname(outfile), { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['node:sqlite'],
  logLevel: 'silent',
});

const bytes = await readFile(outfile);
const sha256 = createHash('sha256').update(bytes).digest('hex');

const declaration = {
  schemaVersion: 1,
  id: 'antigravity',
  name: 'Antigravity',
  description: pkg.description,
  icon: { kind: 'brand', id: 'antigravity' },
  version: pkg.version,
  minHostVersion: '0.0.0',
  protocol: 'piwin-agent-stdio',
  protocolVersion: 1,
  minHostProtocolVersion: 1,
  platforms: ['darwin', 'win32', 'linux'],
  verifiedCliVersions: ['1.5.5'],
  helpUrl: 'https://idx.dev',
  artifact: {
    format: 'node-esm',
    entrypoint: 'dist/agent.mjs',
    sha256,
    byteSize: bytes.byteLength,
  },
  compatibleRevisions: [
    '27e6ee94bc267fd35d1fe277921449161f0dfb7aa7abc34a1be27d1539aae554',
    'd56d746e57a13f7d84372760a33b42650ba3d85be035b8fbe9c21364f2855eb3',
    '7649e50e1c8d4d007daa4c462dd46e47cb4d744030629da3eb34265c4eebacf6',
    'ca27eb2f25d3291e7a25140c4c2bf5026015bbff2b958c839acb0946744dfd28',
    'df3cf50729a5146c3e0e0064a9f13ad03cb3a1eb87fbbb3cac8bd72d95098f72',
  ],
  unversionedBindingCompatible: true,
  outputDirectories: [
    {
      id: 'images',
      base: 'working-directory',
      relativePath: '.piwin-antigravity/images',
      kind: 'image',
    },
  ],
};

await writeFile(join(root, 'piwin.json'), `${JSON.stringify({ sessionBackend: declaration }, null, 2)}\n`);
process.stdout.write(`${sha256} ${bytes.byteLength}\n`);
