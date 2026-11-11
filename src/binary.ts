import { accessSync, constants, readdirSync, statSync } from 'node:fs';
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
 * Interactive `agy --conversation <id>` always operates against `~/.gemini/antigravity-cli`
 * (while importing non-empty trajectories from `~/.gemini/antigravity` on demand).
 *
 * Creating new sessions in `antigravity-cli` guarantees that brand-new 0-turn sessions
 * can be opened immediately in the embedded `agy --conversation <id>` terminal.
 * Existing sessions are resolved from `antigravity-cli` first, then `antigravity`.
 */
export function resolveAntigravityAppDataDir(
  sessionId: string | undefined,
  deps: { homeDir?: string; fileExists?: (path: string) => boolean } = {},
): 'antigravity' | 'antigravity-cli' {
  if (!sessionId) return 'antigravity-cli';
  const home = deps.homeDir ?? process.env.HOME ?? homedir();
  const exists = deps.fileExists ?? defaultFileExists;
  const cliDb = join(home, '.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`);
  if (exists(cliDb)) return 'antigravity-cli';
  const mainDb = join(home, '.gemini', 'antigravity', 'conversations', `${sessionId}.db`);
  if (exists(mainDb)) return 'antigravity';
  return 'antigravity-cli';
}

const UUID_DB_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i;

/**
 * Lists local conversation `.db` files in `~/.gemini/antigravity-cli/conversations`.
 * `agy acp` `session/list` omits 0-turn conversations (`step_count = 0`); supplementing
 * them prevents Host catalog sync from deleting newly created empty sessions.
 */
export function listCliConversationDbFiles(
  homeDir: string = process.env.HOME ?? homedir(),
): { backendSessionId: string; lastChangeUnixMs: number }[] {
  const dir = join(homeDir, '.gemini', 'antigravity-cli', 'conversations');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const results: { backendSessionId: string; lastChangeUnixMs: number }[] = [];
  for (const name of names) {
    const match = UUID_DB_PATTERN.exec(name);
    const id = match?.[1];
    if (!id) continue;
    try {
      const stat = statSync(join(dir, name));
      results.push({ backendSessionId: id, lastChangeUnixMs: Math.round(stat.mtimeMs) });
    } catch {
      // Ignore transient/deleted db files.
    }
  }
  return results;
}
