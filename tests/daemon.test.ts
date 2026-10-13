import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawn, spawnSync } from "child_process"
import { mkdtemp, readFile, rm } from "fs/promises"
import { createConnection } from "net"
import { tmpdir } from "os"
import { join } from "path"
import {
  DAEMON_PROTOCOL,
  daemonPaths,
  daemonRequest,
  ensureDaemon,
  shutdownDaemon,
  type DaemonPaths,
} from "../src/daemon-client"

process.env.PYTHONPATH = join(import.meta.dir, "fixtures", "fake-memsearch")
const DAEMON_SCRIPT = join(import.meta.dir, "..", "scripts", "memsearch-daemon.py")

let dir: string
let paths: DaemonPaths

async function events(): Promise<string[]> {
  const text = await readFile(process.env.FAKE_MEMSEARCH_EVENTS!, "utf-8").catch(() => "")
  return text.split("\n").filter(Boolean)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "msd-"))
  paths = daemonPaths(join(dir, "daemon"))
  process.env.FAKE_MEMSEARCH_EVENTS = join(dir, "events.log")
  delete process.env.FAKE_MILVUS_FAIL
})

afterEach(async () => {
  await shutdownDaemon(paths)
  // Daemons still waiting for the lock would take over once it frees up.
  spawnSync("pkill", ["-f", dir])
  await rm(dir, { recursive: true, force: true })
})

test("starts a daemon that answers ping", async () => {
  expect(await ensureDaemon("python3", paths)).toBe(true)

  const pong = await daemonRequest(paths.socket, { cmd: "ping" })
  expect(pong).toMatchObject({ ok: true, protocol: DAEMON_PROTOCOL })
})

test("routes each request to the collection it names", async () => {
  expect(await ensureDaemon("python3", paths)).toBe(true)

  const a = await daemonRequest(paths.socket, { cmd: "search", collection: "ms_a", query: "q", top_k: 3 })
  const b = await daemonRequest(paths.socket, { cmd: "search", collection: "ms_b", query: "q" })
  expect(a).toMatchObject({ ok: true, results: [{ collection: "ms_a", top_k: 3 }] })
  expect(b).toMatchObject({ ok: true, results: [{ collection: "ms_b" }] })

  const indexed = await daemonRequest(paths.socket, { cmd: "index", collection: "ms_a", paths: ["/p/a"] })
  expect(indexed).toMatchObject({ ok: true, indexed: 1 })
  expect(await events()).toContain("index:ms_a:/p/a")
})

test("rejects requests without a collection", async () => {
  expect(await ensureDaemon("python3", paths)).toBe(true)

  const resp = await daemonRequest(paths.socket, { cmd: "search", query: "q" })
  expect(resp).toMatchObject({ ok: false })
})

test("loads the embedding model once for all collections", async () => {
  expect(await ensureDaemon("python3", paths)).toBe(true)

  await daemonRequest(paths.socket, { cmd: "search", collection: "ms_a", query: "q" })
  await daemonRequest(paths.socket, { cmd: "search", collection: "ms_b", query: "q" })
  expect((await events()).filter((e) => e.startsWith("load_provider"))).toHaveLength(1)
})

test("concurrent starts share a single daemon", async () => {
  const started = await Promise.all([ensureDaemon("python3", paths), ensureDaemon("python3", paths)])
  expect(started).toEqual([true, true])

  await daemonRequest(paths.socket, { cmd: "search", collection: "ms_a", query: "q" })
  expect((await events()).filter((e) => e.startsWith("load_provider"))).toHaveLength(1)
})

test("answers malformed requests with an error", async () => {
  expect(await ensureDaemon("python3", paths)).toBe(true)

  const resp = await new Promise<string>((resolve) => {
    const sock = createConnection({ path: paths.socket }, () => sock.write("not json\n"))
    let data = ""
    sock.on("data", (c) => (data += c))
    sock.on("close", () => resolve(data))
  })
  expect(JSON.parse(resp)).toMatchObject({ ok: false })
})

test("resets a collection without opening it for indexing", async () => {
  expect(await ensureDaemon("python3", paths)).toBe(true)

  expect(await daemonRequest(paths.socket, { cmd: "reset", collection: "ms_a" })).toMatchObject({ ok: true })
  expect(await events()).toContain("drop:ms_a")
  expect((await events()).filter((e) => e.startsWith("load_provider"))).toHaveLength(1)
})

test("shutdown waits until the daemon process has exited", async () => {
  expect(await ensureDaemon("python3", paths)).toBe(true)
  const { pid } = (await daemonRequest(paths.socket, { cmd: "ping" }))!

  await shutdownDaemon(paths)
  expect(() => process.kill(Number(pid), 0)).toThrow()
})

test("replaces a running daemon from an older plugin version", async () => {
  const old = spawn(
    "python3",
    [DAEMON_SCRIPT, "--socket", paths.socket, "--pid-file", paths.pidFile, "--version", "0.0.1"],
    { stdio: "ignore" },
  )
  while (!(await daemonRequest(paths.socket, { cmd: "ping" }, 500))) await Bun.sleep(100)

  expect(await ensureDaemon("python3", paths)).toBe(true)
  const pong = await daemonRequest(paths.socket, { cmd: "ping" })
  expect(pong?.pid).not.toBe(old.pid)
  expect(old.exitCode).toBe(0)
})

test("reports failure promptly when the daemon cannot open the database", async () => {
  process.env.FAKE_MILVUS_FAIL = "1"
  const start = Date.now()

  expect(await ensureDaemon("python3", paths)).toBe(false)
  expect(Date.now() - start).toBeLessThan(10_000)
})

test("returns no results for an empty collection", async () => {
  expect(await ensureDaemon("python3", paths)).toBe(true)

  const resp = await daemonRequest(paths.socket, { cmd: "search", collection: "empty_new_project", query: "q" })
  expect(resp).toEqual({ ok: true, results: [] })
})
