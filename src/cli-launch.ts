export function antigravityCliLaunch(backendSessionId: string): {
  backendSessionId: string;
  args: readonly string[];
} {
  if (!backendSessionId || backendSessionId.trim().length === 0) {
    throw new Error('Cannot launch Antigravity CLI without a bound conversation ID');
  }
  return {
    backendSessionId,
    args: ['--conversation', backendSessionId],
  };
}
