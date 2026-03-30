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
2. Summarizes it into 2-6 bullet points using an LLM (Claude Haiku by default, [configurable](#summarization-model)) via `opencode run`
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

The script reads directly from the OpenCode SQLite database, summarizes each conversation turn, and writes the results to `.memsearch/memory/`. The seed script respects the same [configuration](#configuration) as the plugin (config file and environment variables).

## Configuration

The plugin can be configured via a JSON config file and/or environment variables. Environment variables take precedence over config file values, and project-level config takes precedence over global config.

### Config file

The plugin looks for config in two locations (highest precedence first):

1. **Project config**: `.memsearch/config.json` in your project root
2. **Global config**: `~/.config/opencode/memsearch.config.json`

Both files use the same schema. Values from the project config override the global config.

**Example:**

```json
{
  "summarization_model": "anthropic/claude-sonnet-4-5",
  "auto_configure_embedding": true
}
```

All fields are optional. The full schema:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `summarization_model` | `string` | `"anthropic/claude-haiku-4-5"` | The OpenCode model ID used to summarize conversation turns |
| `auto_configure_embedding` | `boolean` | `true` | Whether the plugin auto-configures memsearch to use local embeddings on startup |

### Summarization model

Each conversation turn is summarized by an LLM before being stored. By default, the plugin uses `anthropic/claude-haiku-4-5` — a fast, cheap model that produces good summaries.

To use a different model, set it in your config file:

```json
{
  "summarization_model": "anthropic/claude-sonnet-4-5"
}
```

Or override it with an environment variable:

```bash
export MEMSEARCH_SUMMARIZATION_MODEL="openai/gpt-4.1-mini"
```

The model must be available in your OpenCode configuration (i.e., you must have the provider configured and authenticated). Any model ID that works with `opencode run --model <id>` will work here.

### Milvus storage

The plugin uses [Milvus](https://milvus.io/) (via memsearch) as its vector database. There are two modes:

#### Local mode (default)

By default, memsearch uses **Milvus Lite**, which stores data in a local `.db` file (typically `~/.memsearch/milvus.db`). This requires no server setup — it just works.

In local mode, the plugin re-indexes the memory directory on session start (to pick up any memories written since the last session) and again after each new summary is appended. File locking prevents concurrent access issues, so no background watcher is needed.

#### Remote mode

For concurrent access from multiple sessions or machines, you can point memsearch at a remote Milvus server:

```bash
memsearch config set milvus.uri http://localhost:19530
```

In remote mode, the plugin starts a **file watcher** process that continuously re-indexes memory files whenever they change. The watcher runs as a background process with its PID stored in `.memsearch/.watch.pid`.

To switch back to local mode:

```bash
memsearch config set milvus.uri "~/.memsearch/milvus.db"
```

### Embedding provider

By default, the plugin auto-configures memsearch to use **local embeddings** (`embedding.provider = local`). This is important because memsearch's own default is `openai`, which would require an API key and make network requests for every index and search operation.

With local embeddings, the `all-MiniLM-L6-v2` model runs on your machine — no API calls needed for vector search.

To manage the embedding provider yourself (e.g., to use OpenAI embeddings or a custom endpoint), disable auto-configuration:

```json
{
  "auto_configure_embedding": false
}
```

Or via environment variable:

```bash
export MEMSEARCH_AUTO_CONFIGURE_EMBEDDING=false
```

Then configure memsearch directly:

```bash
# Example: use OpenAI embeddings
memsearch config set embedding.provider openai
memsearch config set embedding.api_key "env:OPENAI_API_KEY"

# Example: use a custom OpenAI-compatible endpoint
memsearch config set embedding.provider openai
memsearch config set embedding.base_url http://localhost:11434/v1
memsearch config set embedding.model nomic-embed-text
```

See the [memsearch documentation](https://github.com/nicobako/memsearch) for all available embedding options.

### Environment variables

| Variable | Description |
|----------|-------------|
| `MEMSEARCH_SUMMARIZATION_MODEL` | Override the model used for summarization (takes precedence over config file) |
| `MEMSEARCH_AUTO_CONFIGURE_EMBEDDING` | Set to `false` or `0` to disable automatic local embedding configuration |
| `MEMSEARCH_DISABLE` | Set to any value to disable the plugin entirely (used internally to prevent recursion during summarization) |

### Precedence

Configuration values are resolved in this order (highest precedence first):

1. Environment variables
2. Project config (`.memsearch/config.json`)
3. Global config (`~/.config/opencode/memsearch.config.json`)
4. Built-in defaults

## License

MIT
