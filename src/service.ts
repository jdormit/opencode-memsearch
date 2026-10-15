import { OpenCode, type OpenCodeClient, type SessionMessageInfo, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

export async function connect(start = false): Promise<OpenCodeClient> {
  let endpoint = await Service.discover()
  if (!endpoint && start) {
    await promisify(execFile)("opencode", ["service", "start"])
    endpoint = await Service.discover()
  }
  if (!endpoint) throw new Error("OpenCode 2 service is unavailable. Run opencode service start.")
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
}

export async function listSessions(client: OpenCodeClient): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = []
  let cursor: string | undefined
  do {
    const page = await client.session.list({ limit: 200, ...(cursor ? { cursor } : { order: "asc" }) })
    sessions.push(...page.data)
    cursor = page.cursor.next ?? undefined
  } while (cursor)
  return sessions
}

export async function readMessages(client: OpenCodeClient, sessionID: string): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = []
  let cursor: string | undefined
  do {
    const page = await client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "asc" }) })
    messages.push(...page.data)
    cursor = page.cursor.next ?? undefined
  } while (cursor)
  return messages
}
