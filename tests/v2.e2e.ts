import { strict as assert } from "node:assert"
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { connect, readMessages, listSessions } from "../src/service"
import { join } from "node:path"
import { formatTurnTranscript } from "../src/memory"

assert(process.env.XDG_STATE_HOME === "/tmp/oc2-memsearch/state", "Run with the isolated memsearch environment")
const root = "/tmp/oc2-memsearch"
const client = await connect(true)
const log = async () => (await readFile("/tmp/mock-llm-50402.log", "utf8")).trim().split("\n").map((line) => JSON.parse(line))
const requests = await log()
const primary = requests.find((r) => r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes("MEMORY PROTOCOL")))
assert(primary, "context hook did not inject the protocol")
assert(JSON.stringify(primary).includes("MEMSEARCH_E2E_CONTEXT"), "recent memory missing")
assert(JSON.stringify(primary).includes("memsearch_search"), "search tool missing")
assert(JSON.stringify(primary).includes("memsearch_expand"), "expand tool missing")
assert(requests.some((r) => r.messages.some((m: { content: string }) => m.content.includes("<transcript>"))), "summary generation was not attempted")

const first = (await listSessions(client)).find((s) => s.location.directory.endsWith("/project"))!
assert(first)
const messages = await readMessages(client, first.id)
assert(messages.some((m) => m.type === "idle" && m.outcome === "succeeded"))

async function runTurn(directory: string, text: string, parentID?: string) {
  const session = await client.session.create({ location: { directory }, ...(parentID ? { parentID } : {}) })
  await client.session.prompt({ sessionID: session.id, text })
  await client.session.wait({ sessionID: session.id })
  await Bun.sleep(1000)
  return session
}

const other = join(root, "other-project")
await mkdir(other, { recursive: true })
const second = await runTurn(other, "Please verify the second directory records only one summary")
const toolSession = await runTurn(first.location.directory, 'CALL_TOOL execute {"code":"return await tools.memsearch_search({query: \'migration fixture\'})"}')
const toolTranscript = formatTurnTranscript(await readMessages(client, toolSession.id))
assert(toolTranscript.includes('"collection"') && toolTranscript.includes("migration fixture"), `search tool failed: ${toolTranscript}`)
const child = await runTurn(first.location.directory, "Please verify that subagent turns are not captured", first.id)
const originals = (await readdir(join(first.location.directory, ".memsearch/memory"))).filter((f) => f.endsWith(".md"))
const firstMemory = (await Promise.all(originals.map((f) => readFile(join(first.location.directory, ".memsearch/memory", f), "utf8")))).join("\n")
assert.equal(firstMemory.split(`<!-- session:${first.id} -->`).length - 1, 1)
assert(!firstMemory.includes(`<!-- session:${child.id} -->`), "child session captured")
assert(!firstMemory.includes(`<!-- session:${second.id} -->`), "other location captured")
const others = await readdir(join(other, ".memsearch/memory"))
const secondMemory = (await Promise.all(others.map((f) => readFile(join(other, ".memsearch/memory", f), "utf8")))).join("\n")
assert.equal(secondMemory.split(`<!-- session:${second.id} -->`).length - 1, 1)
await writeFile(join(root, "e2e-result.json"), JSON.stringify({ first: first.id, second: second.id, child: child.id, checks: "protocol, recent memory, tools, stateless generation, idle boundary, location isolation, one summary per turn, child skip" }, null, 2))
console.log("V2 end-to-end assertions passed")
