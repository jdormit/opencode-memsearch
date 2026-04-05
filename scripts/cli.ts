#!/usr/bin/env bun
/**
 * opencode-memsearch CLI — utilities for the opencode-memsearch plugin.
 *
 * Usage:
 *   bunx opencode-memsearch <command> [options]
 *
 * Requires Bun (https://bun.sh/) to run.
 */

import { seed } from "./seed-memories"

const HELP = `opencode-memsearch — CLI utilities for the opencode-memsearch plugin

Usage:
  opencode-memsearch <command> [options]

Commands:
  seed    Backfill memory from existing OpenCode sessions

Options:
  --help, -h    Show this help message

Run 'opencode-memsearch <command> --help' for command-specific help.`

const SEED_HELP = `Seed memsearch memory files from recent OpenCode sessions.

Reads session data from the OpenCode SQLite database, summarizes each
conversation turn via an LLM, and writes the results to .memsearch/memory/.
Run this from your project directory.

Usage:
  opencode-memsearch seed [--days <n>]

Options:
  --days <n>    Number of days of history to process (default: 14)
  --help, -h    Show this help message`

function parseSeedArgs(args: string[]): { days: number } {
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

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP)
    process.exit(0)
  }

  switch (command) {
    case "seed": {
      const subArgs = args.slice(1)
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        console.log(SEED_HELP)
        process.exit(0)
      }
      const { days } = parseSeedArgs(subArgs)
      await seed({ days })
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      console.error()
      console.log(HELP)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
