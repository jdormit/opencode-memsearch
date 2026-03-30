import { type Plugin, tool } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { readdir, readFile, appendFile, mkdir, writeFile, unlink } from "fs/promises"
import { join, basename, resolve } from "path"
import { tmpdir, homedir } from "os"

// --- Configuration ---

interface PluginConfig {
  /** Model ID used for summarization (e.g. "anthropic/claude-haiku-4-5") */
  summarization_model?: string
  /** Whether to auto-configure memsearch to use local embeddings (default: true) */
  auto_configure_embedding?: boolean
}

const DEFAULT_SUMMARIZATION_MODEL = "anthropic/claude-haiku-4-5"
const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "opencode", "memsearch.config.json")

async function loadJsonConfig(path: string): Promise<Partial<PluginConfig>> {
  try {
    const content = await readFile(path, "utf-8")
    return JSON.parse(content)
  } catch {
    return {}
  }
}

async function loadConfig(projectDir: string): Promise<PluginConfig> {
  const projectPath = join(projectDir, ".memsearch", "config.json")
  const globalConfig = await loadJsonConfig(GLOBAL_CONFIG_PATH)
  const projectConfig = await loadJsonConfig(projectPath)
  return { ...globalConfig, ...projectConfig }
}

function getSummarizationModel(config: PluginConfig): string {
  return (
    process.env.MEMSEARCH_SUMMARIZATION_MODEL ||
    config.summarization_model ||
    DEFAULT_SUMMARIZATION_MODEL
  )
}

function shouldAutoConfigureEmbedding(config: PluginConfig): boolean {
  const envVal = process.env.MEMSEARCH_AUTO_CONFIGURE_EMBEDDING
  if (envVal !== undefined) {
    return envVal !== "0" && envVal.toLowerCase() !== "false"
  }
  return config.auto_configure_embedding !== false
}

// --- Helpers ---

function deriveCollectionName(directory: string): string {
  const abs = resolve(directory)
  const sanitized = basename(abs)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40)
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8)
  return `ms_${sanitized}_${hash}`
}

function todayDate(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function nowTime(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

const SUMMARIZE_PROMPT = `You are a third-person note-taker. The attached file contains a transcript of ONE conversation turn between a human and an AI coding agent. Tool calls are labeled [Tool Call] and their results [Tool Result] or [Tool Error].

Your job is to record what happened as factual third-person notes. You are an EXTERNAL OBSERVER. Do NOT answer the human's question, do NOT give suggestions, do NOT offer help. ONLY record what occurred.

Output 2-6 bullet points, each starting with '- '. NOTHING else.

Rules:
- Write in third person: 'User asked...', 'Agent read file X', 'Agent ran command Y'
- First bullet: what the user asked or wanted (one sentence)
- Remaining bullets: what the agent did — tools called, files read/edited, commands run, key findings
- Be specific: mention file names, function names, tool names, and concrete outcomes
- Do NOT answer the human's question yourself — just note what was discussed
- Do NOT add any text before or after the bullet points
- Do NOT continue the conversation after the bullet points
- Do NOT ask follow-up questions
- STOP immediately after the last bullet point`

const TEMP_DIR = join(tmpdir(), "memsearch-plugin")

// --- Session state tracking ---

interface SessionState {
  directory: string
  memoryDir: string
  collectionName: string
  coldStartContext?: string
  isSummarizing: boolean
  lastSummarizedMessageCount: number
  headingWritten: boolean
}

// --- Plugin ---

const memsearchPlugin: Plugin = async ({ client, $, directory }) => {
  // Bail out immediately in subprocess summarization calls to prevent infinite recursion
  if (process.env.MEMSEARCH_DISABLE) {
    return {}
  }

  const sessions = new Map<string, SessionState>()

  // Detect memsearch binary
  let memsearchCmd: string[] | null = null

  async function detectMemsearch(): Promise<string[] | null> {
    try {
      await $`which memsearch`.quiet()
      return ["memsearch"]
    } catch {}
    try {
      await $`which uvx`.quiet()
      return ["uvx", "--from", "memsearch[local]", "memsearch"]
    } catch {}
    return null
  }

  async function ensureMemsearch(): Promise<string[] | null> {
    if (memsearchCmd) return memsearchCmd
    memsearchCmd = await detectMemsearch()
    return memsearchCmd
  }

  const MEMSEARCH_NOT_FOUND_ERROR =
    "memsearch is not installed. Tell the user to install it by running: pip install 'memsearch[local]' — or, if they have uv: uv tool install 'memsearch[local]'. See https://github.com/jdormit/opencode-memsearch for details."

  async function runMemsearch(
    args: string[],
    collectionName: string,
  ): Promise<string> {
    const cmd = memsearchCmd
    if (!cmd) return ""
    const fullArgs = [...cmd, ...args, "--collection", collectionName]
    try {
      return await $`${fullArgs}`.quiet().text()
    } catch {
      return ""
    }
  }

  async function getMemsearchConfig(
    key: string,
  ): Promise<string> {
    const cmd = memsearchCmd
    if (!cmd) return ""
    try {
      return (await $`${[...cmd, "config", "get", key]}`.quiet().text()).trim()
    } catch {
      return ""
    }
  }

  async function configureLocalEmbedding(): Promise<void> {
    const cmd = memsearchCmd
    if (!cmd) return
    const provider = await getMemsearchConfig("embedding.provider")
    if (provider !== "local") {
      try {
        await $`${[...cmd, "config", "set", "embedding.provider", "local"]}`.quiet()
      } catch {}
    }
  }

  // Watch singleton management
  async function stopWatch(memsearchDir: string): Promise<void> {
    const pidFile = join(memsearchDir, ".watch.pid")
    try {
      const pidStr = await readFile(pidFile, "utf-8")
      const pid = parseInt(pidStr.trim(), 10)
      if (pid) {
        try {
          process.kill(pid)
        } catch {}
      }
      await unlink(pidFile)
    } catch {}
  }

  async function startWatch(
    memoryDir: string,
    memsearchDir: string,
    collectionName: string,
  ): Promise<void> {
    const cmd = memsearchCmd
    if (!cmd) return

    const milvusUri = await getMemsearchConfig("milvus.uri")
    // Lite mode (local .db file): skip watch, file lock prevents concurrent access
    if (!milvusUri.startsWith("http") && !milvusUri.startsWith("tcp")) {
      return
    }

    await stopWatch(memsearchDir)

    const pidFile = join(memsearchDir, ".watch.pid")
    try {
      const watchProc = Bun.spawn(
        [...cmd, "watch", memoryDir, "--collection", collectionName],
        {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        },
      )
      await writeFile(pidFile, String(watchProc.pid))
    } catch {}
  }

  // Read cold-start context from recent memory files
  async function getRecentMemory(memoryDir: string): Promise<string> {
    try {
      const files = await readdir(memoryDir)
      const mdFiles = files
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 2)

      if (mdFiles.length === 0) return ""

      let context = "# Recent Memory\n\n"
      for (const f of mdFiles) {
        const content = await readFile(join(memoryDir, f), "utf-8")
        const lines = content.split("\n")
        const tail = lines.slice(-30).join("\n").trim()
        if (tail) {
          context += `## ${f}\n${tail}\n\n`
        }
      }
      return context
    } catch {
      return ""
    }
  }

  // Format the last turn of a conversation into a transcript for summarization
  function formatTurnTranscript(
    messages: { info: any; parts: any[] }[],
  ): string {
    // Find the last user message index
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "user") {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx === -1) return ""

    const turn = messages.slice(lastUserIdx)
    const lines: string[] = [
      "=== Transcript of a conversation turn between a human and an AI coding agent ===",
    ]

    for (const msg of turn) {
      const role = msg.info.role
      for (const part of msg.parts) {
        if (part.type === "text" && part.text?.trim()) {
          if (role === "user") {
            lines.push(`[Human]: ${part.text.trim()}`)
          } else if (role === "assistant") {
            lines.push(`[Assistant]: ${part.text.trim()}`)
          }
        } else if (part.type === "tool-invocation" || part.type === "tool_use") {
          const name = part.toolName || part.name || "unknown"
          const args = part.args || part.input || {}
          const argParts: string[] = []
          for (const [k, v] of Object.entries(args)) {
            let vStr = String(v)
            if (vStr.length > 120) vStr = vStr.slice(0, 120) + "..."
            argParts.push(`${k}=${vStr}`)
          }
          let argSummary = argParts.join(", ")
          if (argSummary.length > 400)
            argSummary = argSummary.slice(0, 400) + "..."
          lines.push(`[Tool Call]: ${name}(${argSummary})`)
        } else if (part.type === "tool-result" || part.type === "tool_result") {
          const output = String(part.output || part.content || "").slice(
            0,
            1000,
          )
          const isError = part.isError || part.is_error
          const label = isError ? "[Tool Error]" : "[Tool Result]"
          lines.push(`${label}: ${output}`)
        }
      }
    }

    return lines.join("\n")
  }

  // Summarize a transcript via `opencode run` in a separate process with plugins disabled
  async function summarizeTranscript(transcript: string, sessionID: string, turnIdx: number, model: string): Promise<string> {
    const tempFile = join(TEMP_DIR, `turn-${sessionID}-${turnIdx}.txt`)
    await mkdir(TEMP_DIR, { recursive: true })
    await writeFile(tempFile, transcript)

    try {
      const rawOutput = await $`opencode run -f ${tempFile} --model ${model} --format json ${SUMMARIZE_PROMPT}`
        .env({ ...process.env, MEMSEARCH_DISABLE: "1" })
        .nothrow()
        .quiet()
        .text()

      // Parse JSON event stream to extract text parts and session ID
      let summarizationSessionID: string | undefined
      const textParts: string[] = []

      for (const line of rawOutput.split("\n")) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (!summarizationSessionID && event.sessionID) {
            summarizationSessionID = event.sessionID
          }
          if (event.type === "text" && event.part?.text) {
            textParts.push(event.part.text)
          }
        } catch {
          // skip non-JSON lines (e.g. startup messages)
        }
      }

      // Clean up the summarization session so it doesn't clutter the session list
      if (summarizationSessionID) {
        try {
          await client.session.delete({ path: { id: summarizationSessionID } } as any)
        } catch {}
      }

      // Extract bullet lines from combined text
      const combined = textParts.join("")
      const bulletLines = combined
        .split("\n")
        .filter((l) => l.trimStart().startsWith("- "))
        .filter((l) => {
          const content = l.trimStart().slice(2) // strip "- "
          return content.startsWith("User ") || content.startsWith("Agent ")
        })
      return bulletLines.join("\n").trim()
    } finally {
      try {
        await unlink(tempFile)
      } catch {}
    }
  }

  // Fallback: create a concise summary without LLM
  function formatConciseSummary(
    messages: { info: any; parts: any[] }[],
  ): string {
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "user") {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx === -1) return ""

    const turn = messages.slice(lastUserIdx)
    const lines: string[] = []

    for (const msg of turn) {
      const role = msg.info.role
      for (const part of msg.parts) {
        if (part.type === "text" && part.text?.trim()) {
          if (role === "user") {
            const text = part.text.trim()
            lines.push(`- User asked: ${text.length > 200 ? text.slice(0, 200) + "..." : text}`)
          } else if (role === "assistant") {
            const text = part.text.trim()
            if (text.length > 0) {
              lines.push(`- Agent responded: ${text.length > 200 ? text.slice(0, 200) + "..." : text}`)
            }
          }
        } else if (part.type === "tool-invocation" || part.type === "tool_use") {
          const name = part.toolName || part.name || "unknown"
          const args = part.args || part.input || {}
          const keyArgs: string[] = []
          for (const [k, v] of Object.entries(args)) {
            const vStr = String(v)
            if (vStr.length <= 100) {
              keyArgs.push(`${k}=${vStr}`)
            } else {
              keyArgs.push(`${k}=${vStr.slice(0, 80)}...`)
            }
          }
          lines.push(`- Tool: ${name}(${keyArgs.join(", ").slice(0, 300)})`)
        }
      }
    }

    return lines.slice(0, 20).join("\n")
  }

  // --- Initialize ---
  await ensureMemsearch()
  const pluginConfig = await loadConfig(directory)
  const summarizationModel = getSummarizationModel(pluginConfig)

  if (memsearchCmd && shouldAutoConfigureEmbedding(pluginConfig)) {
    await configureLocalEmbedding()
  }

  return {
    // Event handler for session lifecycle
    event: async ({ event }) => {
      // --- Session Created ---
      if (event.type === "session.created") {
        const sessionInfo = (event as any).properties.info
        const sessionID: string = sessionInfo.id

        // Skip child/subagent sessions
        if (sessionInfo.parentID) return

        const sessionDir = sessionInfo.directory || directory
        const memsearchDir = join(sessionDir, ".memsearch")
        const memoryDir = join(memsearchDir, "memory")
        const collectionName = deriveCollectionName(sessionDir)

        // Ensure memsearch is available
        if (!memsearchCmd) {
          await ensureMemsearch()
        }

        // Ensure memory directory exists
        await mkdir(memoryDir, { recursive: true })

        // Store session state
        sessions.set(sessionID, {
          directory: sessionDir,
          memoryDir,
          collectionName,
          isSummarizing: false,
          lastSummarizedMessageCount: 0,
          headingWritten: false,
        })

        // Start watch singleton (server mode only)
        await startWatch(memoryDir, memsearchDir, collectionName)

        // One-time index for Lite mode
        const milvusUri = await getMemsearchConfig("milvus.uri")
        if (
          !milvusUri.startsWith("http") &&
          !milvusUri.startsWith("tcp")
        ) {
          // Fire and forget
          runMemsearch(["index", memoryDir], collectionName)
        }

        // Load cold-start context into session state for system prompt injection.
        // This avoids injecting a synthetic user message that would leak into
        // the title-generation model's context.
        const coldStart = await getRecentMemory(memoryDir)
        if (coldStart) {
          const state = sessions.get(sessionID)
          if (state) {
            state.coldStartContext = `<memsearch-context>\n# Recent Memory\n\n${coldStart}</memsearch-context>\n\nThe above is recent memory context from past sessions. Use the memsearch_search tool to search for more specific memories when needed.`
          }
        }
      }

      // --- Session Idle (agent finished responding) ---
      if (event.type === "session.status") {
        const props = (event as any).properties
        const sessionID: string = props.sessionID
        const status = props.status

        if (status.type !== "idle") return

        let state = sessions.get(sessionID)
        if (!state) {
          // Lazy registration: look up the session via SDK to check if it's
          // a real user session (not a child/subagent, and in our directory)
          try {
            const listResp = await client.session.list()
            const allSessions: any[] = (listResp as any).data || listResp || []
            const sessionInfo = allSessions.find((s: any) => s.id === sessionID)

            if (!sessionInfo) return
            if (sessionInfo.parentID) return

            const sessionDir = sessionInfo.directory || directory
            const memsearchDir = join(sessionDir, ".memsearch")
            const memoryDir = join(memsearchDir, "memory")
            const collectionName = deriveCollectionName(sessionDir)

            await mkdir(memoryDir, { recursive: true })

            state = {
              directory: sessionDir,
              memoryDir,
              collectionName,
              isSummarizing: false,
              lastSummarizedMessageCount: 0,
              headingWritten: false,
            }
            sessions.set(sessionID, state)
          } catch {
            return
          }
        }
        if (state.isSummarizing) return

        state.isSummarizing = true

        try {
          // Retrieve messages
          const messagesResp = await client.session.messages({
            path: { id: sessionID },
          })
          const messages = (messagesResp as any).data || messagesResp
          if (!Array.isArray(messages) || messages.length < 2) return

          // Skip if no new messages since last summary
          if (messages.length <= state.lastSummarizedMessageCount) return

          // Check if last user message is too short (greeting, etc.)
          let lastUserText = ""
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].info.role === "user") {
              for (const part of messages[i].parts) {
                if (part.type === "text" && part.text) {
                  lastUserText = part.text.trim()
                  break
                }
              }
              break
            }
          }
          if (lastUserText.length < 10) return

          // Format the last turn as a transcript
          const transcript = formatTurnTranscript(messages)
          if (!transcript || transcript.split("\n").length < 3) return

          // Summarize via LLM, fall back to raw extraction on failure
          let summary: string
          try {
            summary = await summarizeTranscript(transcript, sessionID, state.lastSummarizedMessageCount, summarizationModel)
          } catch {
            summary = ""
          }
          if (!summary) {
            summary = formatConciseSummary(messages)
          }
          if (!summary) return

          // Append to daily memory file
          const today = todayDate()
          const now = nowTime()
          const memoryFile = join(state.memoryDir, `${today}.md`)

          // Write session heading on first summary
          if (!state.headingWritten) {
            await appendFile(memoryFile, `\n## Session ${now}\n\n`)
            state.headingWritten = true
          }

          const entry = `### ${now}\n<!-- session:${sessionID} -->\n${summary}\n\n`
          await appendFile(memoryFile, entry)

          // Track that we've summarized up to this point
          state.lastSummarizedMessageCount = messages.length

          // Re-index
          runMemsearch(["index", state.memoryDir], state.collectionName)
        } catch {
          // Silently fail — memory capture is best-effort
        } finally {
          state.isSummarizing = false
        }
      }
    },

    // Custom tools for memory operations
    tool: {
      memsearch_search: tool({
        description:
          "Search past session memories using semantic search. Returns relevant memory chunks from previous conversations, including decisions made, bugs debugged, files edited, and other contextual information. Use this at the start of a session and whenever you encounter a topic that might have prior context.",
        args: {
          query: tool.schema
            .string()
            .describe(
              "Natural language search query describing what you want to recall from past sessions",
            ),
          top_k: tool.schema
            .number()
            .optional()
            .default(5)
            .describe("Number of results to return (default: 5)"),
        },
        async execute(args, context) {
          await ensureMemsearch()
          if (!memsearchCmd) {
            return MEMSEARCH_NOT_FOUND_ERROR
          }
          const collectionName = deriveCollectionName(context.directory)
          const raw = await runMemsearch(
            [
              "search",
              args.query,
              "--top-k",
              String(args.top_k ?? 5),
              "--json-output",
            ],
            collectionName,
          )
          if (!raw.trim()) {
            return "No results found."
          }
          try {
            const results = JSON.parse(raw)
            if (!Array.isArray(results) || results.length === 0) {
              return "No results found."
            }
            return JSON.stringify(results, null, 2)
          } catch {
            return raw
          }
        },
      }),

      memsearch_expand: tool({
        description:
          "Expand a memory search result to show its full context. Takes a chunk_hash from a memsearch_search result and returns the complete markdown section with surrounding content, plus guidance on how to dig deeper into the original session.",
        args: {
          chunk_hash: tool.schema
            .string()
            .describe(
              "The chunk_hash from a memsearch_search result to expand",
            ),
        },
        async execute(args, context) {
          await ensureMemsearch()
          if (!memsearchCmd) {
            return MEMSEARCH_NOT_FOUND_ERROR
          }
          const collectionName = deriveCollectionName(context.directory)
          const raw = await runMemsearch(
            ["expand", args.chunk_hash, "--json-output"],
            collectionName,
          )
          if (!raw.trim()) {
            return "Chunk not found."
          }
          try {
            const result = JSON.parse(raw)
            const lines: string[] = []

            // Main content
            lines.push(result.content || "")

            // Deep drill guidance
            lines.push("")
            lines.push("--- Deep drill ---")
            if (result.source) {
              lines.push(
                `Source file: ${result.source} (lines ${result.start_line}-${result.end_line})`,
              )
            }

            // Extract session IDs from content
            const sessionMatches = (result.content || "").matchAll(
              /<!-- session:(ses_[a-zA-Z0-9]+) -->/g,
            )
            const sessionIDs = [...new Set([...sessionMatches].map((m) => m[1]))]
            if (sessionIDs.length > 0) {
              lines.push(`Session IDs found: ${sessionIDs.join(", ")}`)
            }

            lines.push("To get more context:")
            if (result.source) {
              lines.push(
                `- Read the source file "${result.source}" with the Read tool around lines ${result.start_line}-${result.end_line} for surrounding entries`,
              )
              const memoryDir = result.source.replace(/\/[^/]+$/, "")
              lines.push(
                `- Search for a session ID in "${memoryDir}/" to find all entries from the same session`,
              )
            }

            return lines.join("\n")
          } catch {
            return raw
          }
        },
      }),
    },

    // Inject memory protocol and cold-start context into the system prompt.
    // Cold-start context is injected here (rather than as a synthetic user
    // message) so it doesn't leak into the title-generation model's context.
    "experimental.chat.system.transform": async (input, output) => {
      // Inject cold-start context for this session if available
      const sessionID = input.sessionID
      if (sessionID) {
        const state = sessions.get(sessionID)
        if (state?.coldStartContext) {
          output.system.push(state.coldStartContext)
        }
      }

      output.system.push(
        `MEMORY PROTOCOL:
1. Check the <memsearch-context> in the system prompt for recent memory from past sessions.
2. ALWAYS use the memsearch_search tool to search for relevant memories before starting work in a session. The injected context only contains the last 30 lines of the 2 most recent memory files — it is not comprehensive. The memsearch_search tool performs semantic search across ALL past memories and is much more thorough. You don't need to recall memories for every conversation turn, but you should check for relevant memories at the start of a session and whenever you encounter a topic that might have prior context — past decisions, debugging sessions, user preferences, or earlier work on the same files or features.
3. Search memory again whenever you encounter a topic that might have prior context — past decisions, debugging sessions, user preferences, or earlier work on the same files or features.
4. Use memsearch_expand to get full context for any relevant search results. It will also provide guidance on how to dig deeper into the original session data.
5. Memories are automatically recorded as you work — you do not need to write them manually.`,
      )
    },
  }
}

export default memsearchPlugin
