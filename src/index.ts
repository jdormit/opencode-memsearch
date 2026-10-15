import { Plugin } from "@opencode/plugin"
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { createCapture } from "./capture"
import {
  deriveCollectionName,
  formatConciseSummary,
  formatTurnTranscript,
  getUserText,
  summarizationModel,
  summarizeTranscript,
} from "./memory"
import { connect, readMessages } from "./service"
import {
  daemonPaths,
  daemonRequest,
  ensureDaemon,
  findMemsearchPython,
  shutdownLegacyDaemons,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-client"

const MEMORY_PROTOCOL = `MEMORY PROTOCOL:
1. Check the <memsearch-context> in the system prompt for recent memory from past sessions.
2. ALWAYS search for relevant memories before starting work in a session. The injected context only contains the last 30 lines of the 2 most recent memory files — it is not comprehensive. Search whenever you encounter a topic that might have prior context: past decisions, debugging sessions, user preferences, or earlier work on the same files or features.
3. Memory tools use Code Mode. Find memsearch_search and memsearch_expand in the catalog (use search discovery if needed), then call their exact catalog paths through execute. They are not direct model tools. Await and return the results: for example, execute({code: 'return await tools.memsearch_search({query: "topic to recall"})'}). Search returns {results, content, error?}; use a result's chunk_hash with tools.memsearch_expand to get full context and guidance on the original session. Expand returns {result?, sessionIDs, content, error?}. Check error before using results. Preserve content when presenting or retaining the full notes and guidance.
4. Memories are automatically recorded as you work — you do not need to write them manually.`

async function recentMemory(directory: string): Promise<string> {
  try {
    const files = (await readdir(directory))
      .filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 2)
    const entries = await Promise.all(files.map(async (file) => {
      const text = (await readFile(join(directory, file), "utf8"))
        .split("\n").slice(-30).join("\n").trim()
      return `## ${file}\n${text}`
    }))
    return entries.length ? `<memsearch-context>\n# Recent Memory\n\n${entries.join("\n\n")}\n</memsearch-context>` : ""
  } catch {
    return ""
  }
}

export default Plugin.define({
  id: "opencode-memsearch",
  async setup(ctx) {
    const directory = ctx.location.directory
    const memoryDir = join(directory, ".memsearch", "memory")
    const collection = deriveCollectionName(directory)
    const paths = daemonPaths()
    let startup: Promise<boolean> | undefined
    let python: string | null | undefined
    let legacyStopped: Promise<void> | undefined
    async function callDaemon(request: DaemonRequest): Promise<DaemonResponse | null> {
      startup ??= (async () => {
        python ??= await findMemsearchPython()
        if (!python) return false
        await (legacyStopped ??= shutdownLegacyDaemons())
        return ensureDaemon(python, paths)
      })().finally(() => { startup = undefined })
      if (!(await startup)) return null
      return daemonRequest(paths.socket, request, request.cmd === "index" ? 10 * 60_000 : undefined)
    }
    const indexMemory = () => callDaemon({ cmd: "index", collection, paths: [memoryDir] })
      .catch((error) => console.warn("memsearch: indexing failed", error))
    let client: Awaited<ReturnType<typeof connect>> | undefined
    const getClient = async () => client ??= await connect()
    const headings = new Set<string>()
    const capture = createCapture({
      directory,
      session: async (sessionID) => ctx.session.get({ sessionID }),
      messages: async (sessionID) => readMessages(await getClient(), sessionID),
      async save(sessionID, turn) {
        if (getUserText(turn).length < 10 || !turn.some((m) => m.type === "assistant")) return
        const transcript = formatTurnTranscript(turn)
        let summary = ""
        try {
          summary = await summarizeTranscript(ctx.generate, transcript, await summarizationModel(directory))
        } catch (error) {
          console.warn("memsearch: summarization failed; using transcript extract", error)
        }
        summary ||= formatConciseSummary(turn)
        if (!summary) return
        await mkdir(memoryDir, { recursive: true })
        const now = new Date()
        const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
        const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
        const key = `${day}:${sessionID}`
        const heading = headings.has(key) ? "" : `\n## Session ${time}\n\n`
        await appendFile(join(memoryDir, `${day}.md`), `${heading}### ${time}\n<!-- session:${sessionID} -->\n${summary}\n\n`)
        headings.add(key)
        void indexMemory()
      },
    })

    let initialIndexStarted = false
    await ctx.session.hook("context", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session.parentID || session.location.directory !== directory) return
      const memory = await recentMemory(memoryDir)
      if (memory && !initialIndexStarted) {
        initialIndexStarted = true
        void indexMemory()
      }
      if (memory) event.system.push({ type: "text", text: memory })
      event.system.push({ type: "text", text: MEMORY_PROTOCOL })
    })

    const failure = (response: DaemonResponse | null) => response ? `memsearch error: ${response.error}` : `memsearch is unavailable. Install it with uv tool install 'memsearch[onnx]'. See ${paths.log} for daemon errors.`
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memsearch_search",
        description: "Search past session memories using semantic search. Use at session start and whenever a topic might have prior context.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to recall from past sessions" },
            top_k: { type: "number", default: 5 },
          },
          required: ["query"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            results: { type: "array", items: { type: "object", additionalProperties: true } },
            content: { type: "string" },
            error: { type: "string" },
          },
          required: ["results", "content"],
          additionalProperties: false,
        },
        async execute(value) {
          const input = value as { query: string; top_k?: number }
          const response = await callDaemon({
            cmd: "search", collection, query: input.query, top_k: input.top_k ?? 5,
          })
          if (!response?.ok) {
            const content = failure(response)
            return { content, output: { results: [], content, error: content } }
          }
          const results = Array.isArray(response.results) ? response.results : []
          const content = results.length ? JSON.stringify(results, null, 2) : "No results found."
          return { content, output: { results, content } }
        },
      })
      editor.add({
        name: "memsearch_expand",
        description: "Expand a memory search result by chunk_hash to see its full context, source location, and session IDs.",
        input: {
          type: "object",
          properties: { chunk_hash: { type: "string" } },
          required: ["chunk_hash"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            result: { type: "object", additionalProperties: true },
            sessionIDs: { type: "array", items: { type: "string" } },
            content: { type: "string" },
            error: { type: "string" },
          },
          required: ["sessionIDs", "content"],
          additionalProperties: false,
        },
        async execute(value) {
          const input = value as { chunk_hash: string }
          const response = await callDaemon({ cmd: "expand", collection, chunk_hash: input.chunk_hash })
          if (!response?.ok) {
            const content = failure(response)
            return { content, output: { sessionIDs: [], content, error: content } }
          }
          const result = response.result as { content?: string; source?: string; start_line?: number; end_line?: number }
          const content = result.content || ""
          const matches = content.matchAll(/<!-- session:([^\s>]+)(?:\s+turn:[^>]+)? -->/g)
          const sessions = [...new Set([...matches].map((m) => m[1]))]
          const lines = [content, "", "--- Deep drill ---"]
          if (result.source) {
            lines.push(
              `Source file: ${result.source} (lines ${result.start_line}-${result.end_line})`,
              "Read the source file around those lines for surrounding entries, or search its directory for a session ID.",
            )
          }
          if (sessions.length) lines.push(`Session IDs found: ${sessions.join(", ")}`)
          const text = lines.join("\n")
          return { content: text, output: { result, sessionIDs: sessions, content: text } }
        },
      })
    })

    const controller = new AbortController()
    const pending = new Set<Promise<void>>()
    const subscription = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.execution.succeeded") continue
        const task = capture(event)
        pending.add(task)
        void task.finally(() => pending.delete(task))
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.warn("memsearch: event subscription failed", error)
    })
    return async () => {
      controller.abort()
      await subscription
      await Promise.all(pending)
    }
  },
})
