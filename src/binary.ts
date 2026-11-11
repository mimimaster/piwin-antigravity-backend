import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type BinaryProbeDeps = {
  env?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
  homeDir?: string;
};

function defaultExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultFileExists(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAntigravityBinary(
  hostBinaryPath: string | undefined,
  deps: BinaryProbeDeps = {},
): string | undefined {
  const exists = deps.pathExists ?? defaultExists;
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();

  if (hostBinaryPath && hostBinaryPath !== 'agy' && exists(hostBinaryPath)) {
    return hostBinaryPath;
  }
  const envOverride = env.AGY_CLI ?? env.ANTIGRAVITY_CLI;
  if (envOverride && exists(envOverride)) {
    return envOverride;
  }
  const pathVar = env.PATH ?? '';
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const name of ['agy', 'agy.exe']) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  const fallbackPaths = [
    '/Applications/Gemini.app/Contents/Helpers/agy',
    '/Applications/Antigravity.app/Contents/Helpers/agy',
    '/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
    join(home, '.gemini', 'antigravity', 'bin', 'agy'),
    join(home, '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
  ];
  for (const candidate of fallbackPaths) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export function isUnusableAntigravityProbe(input: { stderr: string }): boolean {
  const text = input.stderr.toLowerCase();
  return text.includes('command not found') || text.includes('no such file or directory');
}

/**
 * Antigravity stores IDE / Gemini.app conversations in `~/.gemini/antigravity/conversations/<id>.db`,
 * whereas standalone `agy` CLI defaults to `~/.gemini/antigravity-cli/conversations/<id>.db`.
 * Defaulting to `antigravity` shares sessions with Gemini.app / Antigravity IDE, while falling back to
 * `antigravity-cli` when loading a session that exists only in the CLI store.
 */
export function resolveAntigravityAppDataDir(
  sessionId: string | undefined,
  deps: { homeDir?: string; fileExists?: (path: string) => boolean } = {},
): 'antigravity' | 'antigravity-cli' {
  if (!sessionId) return 'antigravity';
  const home = deps.homeDir ?? process.env.HOME ?? homedir();
  const exists = deps.fileExists ?? defaultFileExists;
  const mainDb = join(home, '.gemini', 'antigravity', 'conversations', `${sessionId}.db`);
  if (exists(mainDb)) return 'antigravity';
  const cliDb = join(home, '.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`);
  if (exists(cliDb)) return 'antigravity-cli';
  return 'antigravity';
}
