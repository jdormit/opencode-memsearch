# opencode-memsearch

Persistent cross-session memory for [OpenCode](https://opencode.ai), powered by [memsearch](https://github.com/nicobako/memsearch).

This plugin gives your OpenCode agent long-term memory. It automatically summarizes each conversation turn and stores it in a local vector database. On session start, recent context is injected into the system prompt, and the agent can search all past memories with semantic search.

## Features

- **Automatic memory capture** — each conversation turn is summarized by an LLM and appended to daily memory files in `.memsearch/memory/`
- **Cold-start context** — the last 30 lines of the 2 most recent memory files are injected into the system prompt when a new session starts
- **Semantic search** — two custom tools (`memsearch_search` and `memsearch_expand`) let the agent search and drill into past memories
- **Per-project isolation** — memory collections are scoped by project directory
- **Local embeddings** — works with memsearch's ONNX or local embedding providers, so no API keys are needed for vector search
- **Daemon mode** — optional background daemon keeps the embedding model loaded in memory, reducing search latency from ~5-10s to ~50ms
- **Memory protocol** — a system prompt directive instructs the agent to check memory at session start and whenever it encounters a topic that might have prior context

## Prerequisites

You need the `memsearch` CLI installed with ONNX embeddings. The easiest way is via [uv](https://docs.astral.sh/uv/):

```bash
# Install uv (if you don't have it)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install memsearch with ONNX embeddings (recommended)
uv tool install 'memsearch[onnx]'

# Configure the ONNX embedding provider
memsearch config set embedding.provider onnx
```

Or install directly with pip:

```bash
pip install 'memsearch[onnx]'
memsearch config set embedding.provider onnx
```

The ONNX provider uses the `bge-m3` embedding model locally on your machine — no API keys or network requests needed for vector search. If you prefer a different embedding provider (e.g., OpenAI, a local `all-MiniLM-L6-v2` via `memsearch[local]`, or Ollama), see the [memsearch documentation](https://github.com/nicobako/memsearch) for configuration options.

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

## CLI

The package includes a CLI for utility tasks. It requires [Bun](https://bun.sh/) to run.

```bash
bunx opencode-memsearch --help
```

### Seed

Backfill memory from existing OpenCode sessions. This is useful when first installing the plugin on a project you've already been working on.

```bash
# Seed from the last 14 days of sessions (default)
bunx opencode-memsearch seed

# Seed from the last 30 days
bunx opencode-memsearch seed --days 30
```

Run the command from your project directory. It reads directly from the OpenCode SQLite database, summarizes each conversation turn, and writes the results to `.memsearch/memory/`. The seed command respects the same [configuration](#configuration) as the plugin (config file and environment variables).

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
  "use_daemon": true
}
```

All fields are optional. The full schema:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `summarization_model` | `string` | `"anthropic/claude-haiku-4-5"` | The OpenCode model ID used to summarize conversation turns |
| `use_daemon` | `boolean` | `true` | Whether to use a background daemon for faster search/index operations |

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

### Daemon mode

By default, the plugin starts a background daemon process that keeps the memsearch embedding model loaded in memory. This avoids the Python cold-start penalty (~5-10s) on every search, index, or expand operation — reducing latency to ~50ms.

The daemon:
- Starts automatically on session creation
- Listens on a Unix domain socket at `.memsearch/daemon.sock`
- Falls back to the CLI transparently if the daemon is unavailable
- Writes logs to `.memsearch/daemon.log`
- Stores its PID in `.memsearch/daemon.pid`

To disable the daemon and use the CLI for all operations:

```json
{
  "use_daemon": false
}
```

Or via environment variable:

```bash
export MEMSEARCH_USE_DAEMON=false
```

The daemon is most beneficial on machines where Python startup is slow (older hardware, CPU-only inference). On fast machines with NVMe storage, the difference may be negligible.

### Environment variables

| Variable | Description |
|----------|-------------|
| `MEMSEARCH_SUMMARIZATION_MODEL` | Override the model used for summarization (takes precedence over config file) |
| `MEMSEARCH_USE_DAEMON` | Set to `false` or `0` to disable the background daemon (uses CLI for all operations) |
| `MEMSEARCH_DISABLE` | Set to any value to disable the plugin entirely (used internally to prevent recursion during summarization) |

### Precedence

Configuration values are resolved in this order (highest precedence first):

1. Environment variables
2. Project config (`.memsearch/config.json`)
3. Global config (`~/.config/opencode/memsearch.config.json`)
4. Built-in defaults

## License

MIT
