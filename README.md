# piwin-antigravity-backend

Standalone **Antigravity (`agy`)** session backend extension for `piwin`, powered by `agy acp` (Agent Client Protocol over JSON-RPC 2.0 stdio) with native `agy` CLI terminal handoff (`agy --conversation <id>`).

## Features

- **Full ACP Session Lifecycle**: `session/new`, `session/load`, `session/resume`, `session/prompt`, `session/cancel`, and `session/list` over `agy acp`.
- **Shared Conversation Store**: Automatically targets `--app-data-dir antigravity` so sessions created in `piwin`, `Gemini.app` / `Antigravity.app`, and `agy` CLI share `~/.gemini/antigravity`.
- **Model, Thought Level & Mode Switching**:
  - Models: `gemini-4-argon` (Gemini 4 Argon), `gemini-3.8-flash` (Gemini 3.8 Flash), `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`
  - Thought levels (`effort`): `low`, `medium`, `high`
  - Modes: `default`, `accept-edits`, `auto`, `plan`
- **Rich Streaming Projections**: Streams live thinking deltas (`agent_thought_chunk`), assistant text deltas (`agent_message_chunk`), tool call cards (`CommandLine`, `Path`, `TargetFile`, `SearchDirectory`, `rawOutput`), slash commands, and interactive permission prompts (`session/request_permission`).
- **One-Click Native CLI Terminal**: Supports `session/cli-launch` (`agy --conversation <sessionId>`) and `catalog/native-observe` (`transcript.jsonl` + ACP replay).

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```
