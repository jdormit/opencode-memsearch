import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { listSessions, readMessages } from "../src/service"

test("reads every history and session page without a directory filter", async () => {
  const requests: URL[] = []
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url)
    requests.push(url)
    const second = url.searchParams.get("cursor") === "page2"
    return Response.json({ data: [{ id: second ? "second" : "first", type: "user", text: "fixture" }], cursor: { next: second ? null : "page2" } })
  } })
  try {
    const client = OpenCode.make({ baseUrl: server.url.toString() })
    expect((await listSessions(client)).map((s) => s.id)).toEqual(["first", "second"])
    expect((await readMessages(client, "session-with-an-opaque-id")).map((m) => m.id)).toEqual(["first", "second"])
    expect(requests[0].searchParams.get("order")).toBe("asc")
    expect(requests[0].searchParams.has("directory")).toBe(false)
    expect(requests[1].searchParams.get("cursor")).toBe("page2")
    expect(requests[1].searchParams.has("order")).toBe(false)
    expect(requests[2].pathname).toBe("/api/session/session-with-an-opaque-id/message")
  } finally { server.stop(true) }
})
