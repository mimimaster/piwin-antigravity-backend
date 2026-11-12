import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Ensures ~/.gemini/antigravity-cli/settings.json exists so that interactive
 * CLI launches skip the first-run onboarding color-scheme wizard.
 */
export function ensureAntigravityCliSettings(): void {
  try {
    const dir = path.join(os.homedir(), '.gemini', 'antigravity-cli');
    const settingsFile = path.join(dir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsFile, '{}\n', { encoding: 'utf8', mode: 0o600 });
    }
  } catch {
    // Best effort: ignore filesystem permissions issues
  }
}

export function antigravityCliLaunch(backendSessionId: string): {
  backendSessionId: string;
  args: readonly string[];
} {
  if (!backendSessionId || backendSessionId.trim().length === 0) {
    throw new Error('Cannot launch Antigravity CLI without a bound conversation ID');
  }
  ensureAntigravityCliSettings();
  return {
    backendSessionId,
    args: ['--conversation', backendSessionId],
  };
}
