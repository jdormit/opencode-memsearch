/**
 * reindex.ts — Re-index all memsearch memory files from scratch.
 *
 * This module exports a `reindex` function used by the CLI (cli.ts).
 *
 * Useful when switching embedding providers (e.g. memsearch[local] -> memsearch[onnx])
 * without needing to re-run the expensive LLM-based seed process. The memory markdown
 * files are the source of truth; this command just rebuilds the vector index from them.
 *
 * What it does:
 * 1. Discovers all project directories from the OpenCode SQLite database
 * 2. For each project with existing .memsearch/memory/ files:
 *    a. Resets the memsearch collection (drops the old vector data)
 *    b. Re-indexes the memory markdown files with the current embedding provider
 */

import { Database } from "bun:sqlite"
import { readdir } from "fs/promises"
import { join } from "path"
import { $ } from "bun"

import {
  DB_PATH,
  deriveCollectionName,
  detectMemsearch,
  listDistinctDirectories,
} from "./lib"

// --- Helpers ---

async function hasMemoryFiles(memoryDir: string): Promise<boolean> {
  try {
    const files = await readdir(memoryDir)
    return files.some((f) => f.endsWith(".md"))
  } catch {
    return false
  }
}

// --- Main ---

export async function reindex(opts: { dryRun: boolean }) {
  const { dryRun } = opts

  if (dryRun) {
    console.log("DRY RUN — no changes will be made.\n")
  }

  // Setup
  const memsearchCmd = await detectMemsearch()
  console.log(`Using memsearch: ${memsearchCmd.join(" ")}`)

  // Open database (read-only)
  const db = new Database(DB_PATH, { readonly: true })

  try {
    // Discover all project directories
    const allDirs = listDistinctDirectories(db)
    console.log(`Found ${allDirs.length} project directories in the OpenCode database.`)
    console.log()

    // Filter to directories that have memory files
    const targets: { directory: string; memoryDir: string; collectionName: string }[] = []

    for (const dir of allDirs) {
      const memoryDir = join(dir, ".memsearch", "memory")
      if (await hasMemoryFiles(memoryDir)) {
        targets.push({
          directory: dir,
          memoryDir,
          collectionName: deriveCollectionName(dir),
        })
      }
    }

    if (targets.length === 0) {
      console.log("No projects with memory files found. Nothing to reindex.")
      return
    }

    console.log(`Projects with memory files (${targets.length}):`)
    for (const t of targets) {
      console.log(`  ${t.directory}`)
      console.log(`    collection: ${t.collectionName}`)
      console.log(`    memory dir: ${t.memoryDir}`)
    }
    console.log()

    if (dryRun) {
      console.log("DRY RUN — would reset and reindex the above collections.")
      return
    }

    // Reset and reindex each collection
    let succeeded = 0
    let failed = 0

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]
      const label = `[${i + 1}/${targets.length}]`

      console.log(`${label} ${t.directory}`)

      // Reset the collection
      console.log(`${label}   Resetting collection ${t.collectionName}...`)
      try {
        const resetArgs = [...memsearchCmd, "reset", "--collection", t.collectionName, "--yes"]
        await $`${resetArgs}`.nothrow().quiet()
      } catch (err) {
        console.error(`${label}   Failed to reset: ${err}`)
        failed++
        continue
      }

      // Re-index the memory files
      console.log(`${label}   Indexing ${t.memoryDir}...`)
      try {
        const indexArgs = [...memsearchCmd, "index", t.memoryDir, "--collection", t.collectionName, "--force"]
        const output = await $`${indexArgs}`.nothrow().quiet().text()
        if (output.trim()) {
          console.log(`${label}   ${output.trim()}`)
        }
        succeeded++
      } catch (err) {
        console.error(`${label}   Failed to index: ${err}`)
        failed++
      }
    }

    console.log()
    console.log(`Reindex complete: ${succeeded} succeeded, ${failed} failed.`)
  } finally {
    db.close()
  }
}
