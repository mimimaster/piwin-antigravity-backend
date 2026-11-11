import { describe, expect, it } from 'vitest';
import {
  isUnusableAntigravityProbe,
  resolveAntigravityAppDataDir,
  resolveAntigravityBinary,
} from '../src/binary.js';

describe('resolveAntigravityBinary', () => {
  it('prefers explicit hostBinaryPath when executable exists', () => {
    const bin = resolveAntigravityBinary('/custom/agy', {
      pathExists: (p) => p === '/custom/agy',
      env: { PATH: '' },
    });
    expect(bin).toBe('/custom/agy');
  });

  it('discovers /Applications/Gemini.app/Contents/Helpers/agy when not on PATH', () => {
    const bin = resolveAntigravityBinary('agy', {
      pathExists: (p) => p === '/Applications/Gemini.app/Contents/Helpers/agy',
      env: { PATH: '/usr/bin:/bin' },
      homeDir: '/Users/demo',
    });
    expect(bin).toBe('/Applications/Gemini.app/Contents/Helpers/agy');
  });

  it('honors AGY_CLI environment override', () => {
    const bin = resolveAntigravityBinary(undefined, {
      pathExists: (p) => p === '/opt/agy/bin/agy',
      env: { AGY_CLI: '/opt/agy/bin/agy', PATH: '' },
    });
    expect(bin).toBe('/opt/agy/bin/agy');
  });

  it('detects unusable stderr probes', () => {
    expect(isUnusableAntigravityProbe({ stderr: 'zsh: command not found: agy' })).toBe(true);
    expect(isUnusableAntigravityProbe({ stderr: '' })).toBe(false);
  });

  it('defaults app-data-dir to antigravity-cli for new sessions and falls back to antigravity for IDE sessions', () => {
    expect(resolveAntigravityAppDataDir(undefined)).toBe('antigravity-cli');
    expect(
      resolveAntigravityAppDataDir('sess-cli', {
        homeDir: '/Users/demo',
        fileExists: (p) => p === '/Users/demo/.gemini/antigravity-cli/conversations/sess-cli.db',
      }),
    ).toBe('antigravity-cli');
    expect(
      resolveAntigravityAppDataDir('sess-main', {
        homeDir: '/Users/demo',
        fileExists: (p) => p === '/Users/demo/.gemini/antigravity/conversations/sess-main.db',
      }),
    ).toBe('antigravity');
  });
});
