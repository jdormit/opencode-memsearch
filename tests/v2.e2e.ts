import { strict as assert } from "node:assert"
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { connect, readMessages } from "../src/service"

assert(process.env.XDG_STATE_HOME === "/tmp/oc2-memsearch/state", "Run with the isolated memsearch environment")
const root = "/tmp/oc2-memsearch"
const client = await connect(true)
const log = async (): Promise<any[]> => (await readFile("/tmp/mock-llm-50402.log", "utf8").catch(() => ""))
  .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
const before = (await log()).length

async function runTurn(directory: string, text: string, parentID?: string) {
  await mkdir(directory, { recursive: true })
  const session = await client.session.create({ location: { directory }, ...(parentID ? { parentID } : {}) })
  await client.session.prompt({ sessionID: session.id, text })
  await client.session.wait({ sessionID: session.id })
  await Bun.sleep(1000)
  return session
}

const project = join(root, "project")
const fixture = join(project, ".memsearch/memory/2099-01-01.md")
await mkdir(join(project, ".memsearch/memory"), { recursive: true })
await writeFile(fixture, "# Fixture memory\n<!-- session:opaque-session-id turn:0 -->\n- User requested MEMSEARCH_E2E_CONTEXT.\n- Agent inspected the fixture.\n")
const first = await runTurn(project, "Please record a useful test conversation about the memsearch migration")
const requests = (await log()).slice(before)
const primary = requests.find((r) => r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes("MEMORY PROTOCOL")))
assert(primary, "context hook did not inject the protocol")
assert(JSON.stringify(primary).includes("MEMSEARCH_E2E_CONTEXT"), "recent memory missing")
const instructions = primary.messages.filter((m: { role: string }) => m.role === "system").map((m: { content: string }) => m.content).join("\n")
for (const path of ["tools.memsearch_search", "tools.memsearch_expand"]) {
  assert(instructions.includes(path), `catalog path missing: ${path}`)
}
assert(instructions.includes("They are not direct model tools"), "memory protocol does not explain Code Mode")
const direct = primary.tools.map((t: { function: { name: string } }) => t.function.name)
assert(direct.includes("execute"))
assert(!direct.includes("memsearch_search") && !direct.includes("memsearch_expand"), "memory tools exposed directly")
assert(requests.some((r) => r.messages.some((m: { content: string }) => m.content.includes("<transcript>"))), "summary generation was not attempted")
assert((await readMessages(client, first.id)).some((m) => m.type === "idle" && m.outcome === "succeeded"))

const other = join(root, "other-project")
const second = await runTurn(other, "Please verify the second directory records only one summary")
const code = `const search = await tools.memsearch_search({query: "migration fixture"}); if (search.error) throw new Error(search.error); const expand = await tools.memsearch_expand({chunk_hash: search.results[0].chunk_hash}); const missing = await tools.memsearch_expand({chunk_hash: "missing"}); return {search, expand, missing}`
const toolSession = await runTurn(project, `CALL_TOOL execute ${JSON.stringify({ code })}`)
const messages = await readMessages(client, toolSession.id)
const execute = messages.flatMap((m) => m.type === "assistant" ? m.content : [])
  .find((part) => part.type === "tool" && part.name === "execute")
assert(execute?.type === "tool" && execute.state.status === "completed", "execute failed")
const toolText = execute.state.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
const result = JSON.parse(toolText)
assert.equal(result.search.results[0].chunk_hash, "fixture-chunk")
assert(result.search.content.includes("migration fixture"))
assert(result.expand.result.content.includes("MEMSEARCH_E2E_CONTEXT"))
assert.deepEqual(result.expand.sessionIDs, ["opaque-session-id"])
assert(result.expand.content.includes("--- Deep drill ---"))
assert(result.expand.content.includes("Source file:"))
assert(result.missing.error.includes("Chunk not found"))
assert.equal(result.missing.content, result.missing.error)

const child = await runTurn(project, "Please verify that subagent turns are not captured", first.id)
async function memory(directory: string) {
  const dir = join(directory, ".memsearch/memory")
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"))
  return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("\n")
}
const firstMemory = await memory(project)
assert.equal(firstMemory.split(`<!-- session:${first.id} -->`).length - 1, 1)
assert(!firstMemory.includes(`<!-- session:${child.id} -->`), "child session captured")
assert(!firstMemory.includes(`<!-- session:${second.id} -->`), "other location captured")
assert.equal((await memory(other)).split(`<!-- session:${second.id} -->`).length - 1, 1)
await writeFile(join(root, "e2e-result.json"), JSON.stringify({ first: first.id, second: second.id, child: child.id, catalog: ["tools.memsearch_search", "tools.memsearch_expand"], checks: "context, Code Mode catalog, real execute search/expand, structured results, preserved text, error result, stateless generation, location isolation, child skip" }, null, 2))
console.log("V2 end-to-end assertions passed; catalog: tools.memsearch_search, tools.memsearch_expand")
