#!/usr/bin/env bun
/**
 * seed-memories.ts — Seed memsearch memory files from recent OpenCode sessions.
 *
 * Usage:
 *   npx opencode-memsearch-seed [--days 14]
 *
 * Requires Bun (https://bun.sh/) to run.
 *
 * This script:
 * 1. Reads session + message data directly from the OpenCode SQLite database
 * 2. For each session, formats each conversation turn as a transcript
 * 3. Summarizes each turn via `opencode run` (model is configurable, see README)
 * 4. Writes summaries to .memsearch/memory/YYYY-MM-DD.md files per project
 * 5. Indexes all memory files with memsearch
 */

import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { appendFile, mkdir, readFile, writeFile, unlink } from "fs/promises"
import { join, basename, resolve } from "path"
import { homedir, tmpdir } from "os"
import { $ } from "bun"

// --- Configuration ---

interface PluginConfig {
  /** Model ID used for summarization (e.g. "anthropic/claude-haiku-4-5") */
  summarization_model?: string
  /** Whether to use the daemon for faster search/index (default: true) */
  use_daemon?: boolean
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

// --- Config ---

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

const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")
const TEMP_DIR = join(tmpdir(), "memsearch-seed")

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

function formatDate(epochMs: number): string {
  const d = new Date(epochMs)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function parseArgs(): { days: number } {
  const args = process.argv.slice(2)
  let days = 14
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1], 10)
      if (isNaN(days) || days < 1) {
        console.error("Invalid --days value, using default 14")
        days = 14
      }
    }
  }
  return { days }
}

// --- Database types ---

interface DbSession {
  id: string
  directory: string
  title: string
  parent_id: string | null
  time_created: number
  time_updated: number
}

interface DbMessage {
  id: string
  session_id: string
  time_created: number
  data: string // JSON
}

interface DbPart {
  id: string
  message_id: string
  time_created: number
  data: string // JSON
}

// --- Database access ---

function listSessionsFromDb(db: Database, cutoffMs: number): DbSession[] {
  return db.query<DbSession, [number]>(`
    SELECT id, directory, title, parent_id, time_created, time_updated
    FROM session
    WHERE time_created >= ?
      AND parent_id IS NULL
    ORDER BY time_created ASC
  `).all(cutoffMs)
}

function getSessionMessages(
  db: Database,
  sessionId: string,
): { info: any; parts: any[] }[] {
  // Get messages
  const dbMessages = db.query<DbMessage, [string]>(`
    SELECT id, session_id, time_created, data
    FROM message
    WHERE session_id = ?
    ORDER BY time_created ASC
  `).all(sessionId)

  if (dbMessages.length === 0) return []

  // Get all parts for this session in one query
  const dbParts = db.query<DbPart, [string]>(`
    SELECT id, message_id, time_created, data
    FROM part
    WHERE session_id = ?
    ORDER BY time_created ASC
  `).all(sessionId)

  // Group parts by message_id
  const partsByMessage = new Map<string, any[]>()
  for (const p of dbParts) {
    if (!partsByMessage.has(p.message_id)) partsByMessage.set(p.message_id, [])
    partsByMessage.get(p.message_id)!.push(JSON.parse(p.data))
  }

  // Assemble messages with their parts
  return dbMessages.map((m) => ({
    info: JSON.parse(m.data),
    parts: partsByMessage.get(m.id) || [],
  }))
}

// --- Message processing ---

function splitIntoTurns(
  messages: { info: any; parts: any[] }[],
): { info: any; parts: any[] }[][] {
  const turns: { info: any; parts: any[] }[][] = []
  let current: { info: any; parts: any[] }[] = []

  for (const msg of messages) {
    if (msg.info.role === "user" && current.length > 0) {
      turns.push(current)
      current = []
    }
    current.push(msg)
  }
  if (current.length > 0) {
    turns.push(current)
  }

  return turns
}

function formatTurnTranscript(
  turn: { info: any; parts: any[] }[],
): string {
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
        const output = String(part.output || part.content || "").slice(0, 1000)
        const isError = part.isError || part.is_error
        const label = isError ? "[Tool Error]" : "[Tool Result]"
        lines.push(`${label}: ${output}`)
      }
    }
  }

  return lines.join("\n")
}

function formatConciseSummary(
  turn: { info: any; parts: any[] }[],
): string {
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

function getUserText(turn: { info: any; parts: any[] }[]): string {
  for (const msg of turn) {
    if (msg.info.role === "user") {
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          return part.text.trim()
        }
      }
    }
  }
  return ""
}

// Detect memsearch command
async function detectMemsearch(): Promise<string[]> {
  try {
    await $`which memsearch`.quiet()
    return ["memsearch"]
  } catch {}
  throw new Error(
    "memsearch is not installed. Install it by running: uv tool install 'memsearch[onnx]' — or with pip: pip install 'memsearch[onnx]'. See https://github.com/jdormit/opencode-memsearch for details."
  )
}

// Summarize a transcript via `opencode run`
async function summarizeWithOpencode(transcript: string, tempFile: string, model: string): Promise<string> {
  // Write transcript to temp file
  await writeFile(tempFile, transcript)

  try {
    // Disable all plugins during summarization to avoid memsearch plugin
    // interfering with the LLM output (e.g. injecting "[memsearch] Memory available")
    const rawOutput = await $`opencode run -f ${tempFile} --model ${model} ${SUMMARIZE_PROMPT}`
      .env({ ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [] }) })
      .nothrow()
      .quiet()
      .text()

    // Parse output: only keep bullet lines that start with "User " or "Agent "
    // (matching the third-person format from the prompt). The agent sometimes
    // appends conversational junk like "- Do you want me to..." which we discard.
    const lines = rawOutput.split("\n")
    const bulletLines = lines
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

// --- Main ---

async function main() {
  const { days } = parseArgs()
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

  console.log(`Seeding memories from the last ${days} days...`)
  console.log()

  // Setup
  const memsearchCmd = await detectMemsearch()
  console.log(`Using memsearch: ${memsearchCmd.join(" ")}`)

  // Load config from cwd (the project root the seed script is run from)
  const config = await loadConfig(process.cwd())
  const summarizationModel = getSummarizationModel(config)
  console.log(`Summarization model: ${summarizationModel}`)

  await mkdir(TEMP_DIR, { recursive: true })

  // Open database (read-only)
  const db = new Database(DB_PATH, { readonly: true })

  try {
    // List sessions
    const allSessions = listSessionsFromDb(db, cutoff)
    console.log(`Found ${allSessions.length} sessions in the last ${days} days.`)
    console.log()

    if (allSessions.length === 0) {
      console.log("No sessions to process.")
      return
    }

    // Group by directory for display
    const byDir = new Map<string, DbSession[]>()
    for (const s of allSessions) {
      if (!byDir.has(s.directory)) byDir.set(s.directory, [])
      byDir.get(s.directory)!.push(s)
    }

    console.log(`Projects:`)
    for (const [dir, sessions] of byDir) {
      console.log(`  ${dir} (${sessions.length} sessions)`)
    }
    console.log()

    // Track which memory dirs we need to index at the end
    const memoryDirs = new Map<string, string>() // memoryDir -> collectionName

    let sessionNum = 0
    let totalTurns = 0
    let totalSummarized = 0

    for (const session of allSessions) {
      sessionNum++
      const sessionDir = session.directory
      const memsearchDir = join(sessionDir, ".memsearch")
      const memoryDir = join(memsearchDir, "memory")
      const collectionName = deriveCollectionName(sessionDir)
      memoryDirs.set(memoryDir, collectionName)

      await mkdir(memoryDir, { recursive: true })

      const titleDisplay = session.title.length > 50
        ? session.title.slice(0, 50) + "..."
        : session.title

      // Read messages from DB
      const messages = getSessionMessages(db, session.id)

      if (messages.length < 2) {
        console.log(`  [${sessionNum}/${allSessions.length}] "${titleDisplay}" — ${messages.length} messages, skipping`)
        continue
      }

      // Split into turns
      const turns = splitIntoTurns(messages)
      const substantiveTurns = turns.filter((t) => {
        const userText = getUserText(t)
        return userText.length >= 10 && t.length >= 2
      })

      if (substantiveTurns.length === 0) {
        console.log(`  [${sessionNum}/${allSessions.length}] "${titleDisplay}" — no substantive turns, skipping`)
        continue
      }

      console.log(`  [${sessionNum}/${allSessions.length}] "${titleDisplay}" — ${substantiveTurns.length} turns`)

      const sessionDate = formatDate(session.time_created)
      const sessionTime = formatTime(session.time_created)
      const memoryFile = join(memoryDir, `${sessionDate}.md`)

      // Write session heading
      await appendFile(memoryFile, `\n## Session ${sessionTime} — ${session.title}\n\n`)

      // Process each turn
      for (let turnIdx = 0; turnIdx < substantiveTurns.length; turnIdx++) {
        const turn = substantiveTurns[turnIdx]
        totalTurns++

        const turnTime = turn[0].info.time?.created
          ? formatTime(turn[0].info.time.created)
          : sessionTime

        const transcript = formatTurnTranscript(turn)
        if (!transcript || transcript.split("\n").length < 3) continue

        // Summarize via opencode run (separate process per turn, no memory accumulation)
        const tempFile = join(TEMP_DIR, `turn-${sessionNum}-${turnIdx}.txt`)
        let summary = ""
        try {
          summary = await summarizeWithOpencode(transcript, tempFile, summarizationModel)
          if (summary) totalSummarized++
        } catch {
          // LLM failed
        }

        if (!summary) {
          summary = formatConciseSummary(turn)
        }

        if (!summary) continue

        const entry = `### ${turnTime}\n<!-- session:${session.id} -->\n${summary}\n\n`
        await appendFile(memoryFile, entry)

        // Print progress on long sessions
        if (substantiveTurns.length > 5 && (turnIdx + 1) % 5 === 0) {
          process.stdout.write(`    (${turnIdx + 1}/${substantiveTurns.length} turns)\n`)
        }
      }
    }

    console.log()
    console.log(`Processed ${totalTurns} turns, summarized ${totalSummarized} with LLM.`)
    console.log()

    // Index all memory directories
    for (const [memDir, collectionName] of memoryDirs) {
      console.log(`Indexing ${memDir} (collection: ${collectionName})...`)
      try {
        const fullArgs = [...memsearchCmd, "index", memDir, "--collection", collectionName]
        await $`${fullArgs}`.nothrow().quiet()
        console.log(`  Done.`)
      } catch (err) {
        console.error(`  Failed to index: ${err}`)
      }
    }

    console.log()
    console.log("Seeding complete!")
  } finally {
    db.close()
    // Clean up temp dir
    try {
      await $`rm -rf ${TEMP_DIR}`.nothrow().quiet()
    } catch {}
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
