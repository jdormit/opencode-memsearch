import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { formatTurnTranscript, splitIntoTurns, summarizeTranscript } from "../src/memory"
import { createCapture } from "../src/capture"

const messages = [
  { id: "u1", type: "user", text: "Please inspect the source" },
  { id: "a1", type: "assistant", content: [
    { type: "tool", name: "read", state: { status: "completed", input: { path: "src/index.ts" }, content: [{ type: "text", text: "source contents" }] } },
    { type: "tool", name: "bash", state: { status: "error", input: { command: "false" }, error: { type: "failed", message: "exit 1" } } },
    { type: "text", text: "Found the issue" },
  ] },
  { id: "u2", type: "user", text: "Also check the tests" },
  { id: "msg_e1", type: "idle", outcome: "succeeded" },
  { id: "u3", type: "user", text: "Please implement the fix" },
  { id: "a2", type: "assistant", content: [{ type: "text", text: "Fixed" }] },
  { id: "msg_e2", type: "idle", outcome: "succeeded" },
] as SessionMessageInfo[]

test("formats V2 tools, nested input, results, errors and steered prompts", () => {
  const turns = splitIntoTurns(messages)
  expect(turns).toHaveLength(2)
  const text = formatTurnTranscript(turns[0])
  expect(text).toContain('[Tool Call]: read({"path":"src/index.ts"})')
  expect(text).toContain("[Tool Result]: source contents")
  expect(text).toContain('"message":"exit 1"')
  expect(text).toContain("Also check the tests")
  expect(text).not.toContain("Please implement")
})

test("summarization uses stateless generation with configured model and variant", async () => {
  let input: unknown
  const summary = await summarizeTranscript({ text: async (value) => {
    input = value
    return { text: "Preamble\n- User requested a fix\n- Agent read src/index.ts\n- Do you want help?" }
  } }, "TRANSCRIPT", "openrouter/vendor/model#fast")
  expect(input).toMatchObject({ model: { providerID: "openrouter", id: "vendor/model", variant: "fast" } })
  expect((input as { prompt: string }).prompt).toContain("TRANSCRIPT")
  expect(summary).toBe("- User requested a fix\n- Agent read src/index.ts")
})

test("capture filters locations and children, deduplicates events, and queues distinct turns", async () => {
  const captured: string[] = []
  const capture = createCapture({ directory: "/project", session: async (id) => ({ parentID: id === "child" ? "parent" : undefined, location: { directory: "/project" } }),
    messages: async () => messages,
    save: async (_id, turn) => { await Bun.sleep(5); captured.push(formatTurnTranscript(turn)) },
  })
  const event = (id: string, sessionID = "main", directory = "/project") => ({ id: `evt_${id}`, type: "session.execution.succeeded", data: { sessionID }, location: { directory } })
  await Promise.all([capture(event("e1")), capture(event("e1")), capture(event("e2")), capture(event("child-end", "child")), capture(event("other-end", "other", "/other"))])
  expect(captured).toHaveLength(2)
  expect(captured[0]).toContain("Also check the tests")
  expect(captured[0]).not.toContain("Please implement")
  expect(captured[1]).toContain("Please implement")
})

test("failed and incomplete turns are not seeded", () => {
  expect(splitIntoTurns([{ type: "user", text: "Request" }, { type: "idle", outcome: "failed" }, { type: "user", text: "Pending" }] as SessionMessageInfo[])).toEqual([])
})
