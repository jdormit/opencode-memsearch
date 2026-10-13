import { execFile, spawn } from "child_process"
import { readFileSync } from "fs"
import { mkdir, open, readFile } from "fs/promises"
import { createConnection } from "net"
import { homedir } from "os"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { promisify } from "util"

/** Bump whenever the request/response format changes. Must match PROTOCOL in the daemon. */
export const DAEMON_PROTOCOL = 2

/** Daemon exit code meaning another daemon holds the lock. */
const EXIT_LOCKED = 3

export type DaemonRequest = Record<string, unknown>
export type DaemonResponse = Record<string, unknown>

export interface DaemonPaths {
  dir: string
  socket: string
  pidFile: string
  log: string
}

export function daemonPaths(dir: string = join(homedir(), ".memsearch", "daemon")): DaemonPaths {
  return {
    dir,
    socket: join(dir, "daemon.sock"),
    pidFile: join(dir, "daemon.pid"),
    log: join(dir, "daemon.log"),
  }
}

/** Both src/ and the bundled dist/ sit next to scripts/ and package.json. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const DAEMON_SCRIPT = join(PACKAGE_ROOT, "scripts", "memsearch-daemon.py")
const PACKAGE_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8")).version
  } catch {
    return "0.0.0"
  }
})()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number)
  const pb = b.split("-")[0].split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff) return diff
  }
  return 0
}

/**
 * Send one newline-terminated JSON request and read the JSON reply.
 * Resolves to null if the daemon is unreachable, times out, or replies with something unreadable.
 */
export function daemonRequest(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs: number = 30_000,
): Promise<DaemonResponse | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false

    const finish = (parse: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (!parse) return resolve(null)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")))
      } catch {
        resolve(null)
      }
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    // Don't half-close with end(): Bun closes both directions and drops the reply.
    const sock = createConnection({ path: socketPath }, () => {
      sock.write(JSON.stringify(request) + "\n")
    })
    sock.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    sock.on("end", () => finish(true))
    sock.on("close", () => finish(true))
    sock.on("error", () => finish(false))
  })
}

async function ping(paths: DaemonPaths): Promise<DaemonResponse | null> {
  const resp = await daemonRequest(paths.socket, { cmd: "ping" }, 5_000)
  return resp?.ok ? resp : null
}

/** A daemon from a newer plugin version is fine as long as it speaks our protocol. */
function isCurrent(pong: DaemonResponse | null): boolean {
  return (
    pong?.protocol === DAEMON_PROTOCOL &&
    compareVersions(String(pong.version ?? "0"), PACKAGE_VERSION) >= 0
  )
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isRunning(pid) && Date.now() < deadline) await sleep(100)
}

/** Stop the daemon and wait for its process to exit, which is when it releases the database. */
export async function shutdownDaemon(paths: DaemonPaths = daemonPaths()): Promise<void> {
  const pong = await ping(paths)
  if (!pong) return
  await daemonRequest(paths.socket, { cmd: "shutdown" }, 3_000)
  if (pong.pid) await waitForExit(Number(pong.pid))
}

/**
 * Shut down per-project daemons left by plugin versions before the shared daemon.
 * Each holds the Milvus Lite database open, which stops the shared daemon from opening it.
 */
export async function shutdownLegacyDaemons(): Promise<void> {
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)("ps", ["-A", "-ww", "-o", "pid=,command="]))
  } catch {
    return
  }
  const legacy = stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+) .*memsearch-daemon\.py --socket (.+?) --collection /))
    .filter((m): m is RegExpMatchArray => !!m)
  await Promise.all(
    legacy.map(async ([, pid, socket]) => {
      await daemonRequest(socket, { cmd: "shutdown" }, 3_000)
      await waitForExit(Number(pid))
    }),
  )
}

/**
 * Find the Python interpreter memsearch is installed into, via the shebang of
 * the `memsearch` CLI (works for uv tools, virtualenvs and system Python).
 */
export async function findMemsearchPython(): Promise<string | null> {
  const run = promisify(execFile)
  const canImport = (py: string) =>
    run(py, ["-c", "import memsearch"]).then(
      () => true,
      () => false,
    )

  try {
    const { stdout } = await run("which", ["memsearch"])
    const firstLine = (await readFile(stdout.trim(), "utf-8")).split("\n")[0]
    if (firstLine.startsWith("#!")) {
      const shebang = firstLine.slice(2).trim()
      if (await canImport(shebang)) return shebang
    }
  } catch {}

  for (const py of ["python3", "python"]) {
    if (await canImport(py)) return py
  }
  return null
}

/**
 * Make sure a compatible shared daemon is running, starting or replacing it
 * if needed. Resolves to whether it is ready.
 */
export async function ensureDaemon(
  pythonPath: string,
  paths: DaemonPaths = daemonPaths(),
  timeoutMs: number = 60_000,
): Promise<boolean> {
  const pong = await ping(paths)
  if (isCurrent(pong)) return true
  if (pong) await shutdownDaemon(paths)

  await mkdir(paths.dir, { recursive: true, mode: 0o700 })

  let exitCode: number | null | undefined
  const log = await open(paths.log, "a")
  try {
    const proc = spawn(
      pythonPath,
      [
        DAEMON_SCRIPT,
        "--socket", paths.socket,
        "--pid-file", paths.pidFile,
        "--version", PACKAGE_VERSION,
      ],
      { cwd: paths.dir, detached: true, stdio: ["ignore", log.fd, log.fd] },
    )
    proc.on("exit", (code) => {
      exitCode = code
    })
    proc.on("error", () => {
      exitCode = -1
    })
    proc.unref()
  } finally {
    await log.close()
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(250)
    if (isCurrent(await ping(paths))) return true
    if (exitCode !== undefined && exitCode !== EXIT_LOCKED) return false
  }
  return false
}
