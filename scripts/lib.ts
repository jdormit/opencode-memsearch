/**
 * lib.ts — Shared utilities for opencode-memsearch CLI scripts.
 *
 * Contains helpers used by both the seed and reindex commands:
 * database access, collection name derivation, memsearch detection, etc.
 */

import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { basename, join, resolve } from "path"
import { homedir } from "os"
import { $ } from "bun"
import {
  daemonPaths,
  daemonRequest,
  ensureDaemon,
  findMemsearchPython,
  type DaemonPaths,
  type DaemonRequest,
  type DaemonResponse,
} from "../src/daemon-client"

// --- Constants ---

export const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")

// --- Database types ---

export interface DbSession {
  id: string
  directory: string
  title: string
  parent_id: string | null
  time_created: number
  time_updated: number
}

// --- Helpers ---

export function deriveCollectionName(directory: string): string {
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

// --- Database access ---

export function listSessionsFromDb(db: Database, cutoffMs: number): DbSession[] {
  return db.query<DbSession, [number]>(`
    SELECT id, directory, title, parent_id, time_created, time_updated
    FROM session
    WHERE time_created >= ?
      AND parent_id IS NULL
    ORDER BY time_created ASC
  `).all(cutoffMs)
}

export function listDistinctDirectories(db: Database): string[] {
  const rows = db.query<{ directory: string }, []>(`
    SELECT DISTINCT directory
    FROM session
    WHERE parent_id IS NULL
    ORDER BY directory ASC
  `).all()
  return rows.map((r) => r.directory)
}

// --- Memsearch detection ---

export async function detectMemsearch(): Promise<string[]> {
  try {
    await $`which memsearch`.quiet()
    return ["memsearch"]
  } catch {}
  throw new Error(
    "memsearch is not installed. Install it by running: uv tool install 'memsearch[onnx]' — or with pip: pip install 'memsearch[onnx]'. See https://github.com/jdormit/opencode-memsearch for details."
  )
}

/**
 * Start the plugin's shared daemon. All database access goes through it,
 * because Milvus Lite lets only one process open the database.
 */
export async function startPluginDaemon(): Promise<DaemonPaths> {
  const python = await findMemsearchPython()
  if (!python) throw new Error("Could not find the Python interpreter memsearch is installed into.")
  const paths = daemonPaths()
  if (!(await ensureDaemon(python, paths))) {
    throw new Error(`The memsearch daemon failed to start. See ${paths.log}.`)
  }
  return paths
}

/** Send a request to the daemon, throwing if it fails. */
export async function callPluginDaemon(
  paths: DaemonPaths,
  request: DaemonRequest,
): Promise<DaemonResponse> {
  const resp = await daemonRequest(paths.socket, request, 60 * 60_000)
  if (!resp) throw new Error(`Got no response from the memsearch daemon. See ${paths.log}.`)
  if (!resp.ok) throw new Error(String(resp.error))
  return resp
}
