import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { antigravityCliLaunch, ensureAntigravityCliSettings } from '../src/cli-launch.js';

describe('antigravityCliLaunch', () => {
  it('throws on empty or whitespace backendSessionId', () => {
    expect(() => antigravityCliLaunch('')).toThrow('Cannot launch Antigravity CLI');
    expect(() => antigravityCliLaunch('   ')).toThrow('Cannot launch Antigravity CLI');
  });

  it('builds CLI args with --conversation and ensures settings file exists', () => {
    const launch = antigravityCliLaunch('conv-123');
    expect(launch.backendSessionId).toBe('conv-123');
    expect(launch.args).toEqual(['--conversation', 'conv-123']);

    const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
  });
});
