# opencode-memsearch

Persistent cross-session memory for [OpenCode](https://opencode.ai), powered by [memsearch](https://github.com/nicobako/memsearch).

This plugin gives your OpenCode agent long-term memory. It automatically summarizes each conversation turn and stores it in a local vector database. On session start, recent context is injected into the system prompt, and the agent can search all past memories with semantic search.

## Features

- **Automatic memory capture** — each conversation turn is summarized by an LLM and appended to daily memory files in `.memsearch/memory/`
- **Cold-start context** — the last 30 lines of the 2 most recent memory files are injected into the system prompt when a new session starts
- **Semantic search** — two custom tools (`memsearch_search` and `memsearch_expand`) let the agent search and drill into past memories
- **Per-project isolation** — memory collections are scoped by project directory
- **Local embeddings** — uses memsearch's local embedding provider, so no API calls are needed for vector search
- **Memory protocol** — a system prompt directive instructs the agent to check memory at session start and whenever it encounters a topic that might have prior context

## Prerequisites

You need the `memsearch` CLI installed. The easiest way is via [uv](https://docs.astral.sh/uv/):

```bash
# Install uv (if you don't have it)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install memsearch with local embeddings
uv tool install 'memsearch[local]'
```

Or install directly with pip:

```bash
pip install 'memsearch[local]'
```

If `memsearch` is not installed, the plugin's tools will return a clear error message asking the agent to tell you to install it.

## Install

Add `opencode-memsearch` to the plugin list in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-memsearch"]
}
```

This can go in either:
- `opencode.json` in your project root (project-level)
- `~/.config/opencode/opencode.json` (global)

OpenCode will install the npm package automatically on startup.

## How it works

### Memory capture

When the agent finishes responding (session goes idle), the plugin:

1. Extracts the last conversation turn (user message + agent response)
2. Summarizes it into 2-6 bullet points using Claude Haiku via `opencode run`
3. Appends the summary to `.memsearch/memory/YYYY-MM-DD.md`
4. Re-indexes the memory directory into the vector database

Summaries are written in third person (e.g. "User asked about...", "Agent edited file X...") and include specific file names, function names, and outcomes.

### Memory recall

On session start, the plugin:

1. Reads the tail of the 2 most recent memory files and injects them into the system prompt as `<memsearch-context>`
2. Adds a MEMORY PROTOCOL to the system prompt instructing the agent to use `memsearch_search` at session start and whenever relevant

The agent can also search memories on demand:

- **`memsearch_search`** — semantic search across all past memory chunks. Returns ranked results with content previews and chunk hashes.
- **`memsearch_expand`** — expand a specific chunk to see full context, source file location, and session IDs for deeper investigation.

### Storage

Memory data is stored per-project in `.memsearch/`:

```
your-project/
  .memsearch/
    memory/
      2025-03-28.md    # Daily memory summaries
      2025-03-27.md
      ...
```

You should add `.memsearch/` to your `.gitignore`.

## Seed script

The repo includes a seed script (`scripts/seed-memories.ts`) that can backfill memory from existing OpenCode sessions. This is useful when first installing the plugin on a project you've already been working on:

```bash
# Seed from the last 14 days of sessions (default)
bun run scripts/seed-memories.ts

# Seed from the last 30 days
bun run scripts/seed-memories.ts --days 30
```

The script reads directly from the OpenCode SQLite database, summarizes each conversation turn with Claude Haiku, and writes the results to `.memsearch/memory/`.

## Configuration

The plugin auto-configures memsearch to use local embeddings. If you want to use a remote Milvus instance instead of the default local database, configure it via the memsearch CLI:

```bash
memsearch config set milvus.uri http://localhost:19530
```

In remote mode, the plugin starts a file watcher process that automatically re-indexes memory files when they change.

## Environment variables

| Variable | Description |
|----------|-------------|
| `MEMSEARCH_DISABLE` | Set to any value to disable the plugin (used internally to prevent recursion during summarization) |

## License

MIT
