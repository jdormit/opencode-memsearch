import type { SessionMessageInfo } from "@opencode/client"
import { splitIntoTurns } from "./memory"

interface CaptureEvent {
  id: string
  type: string
  data: { sessionID?: string }
  location?: { directory: string }
}

export function createCapture(deps: {
  directory: string
  session(id: string): Promise<{ parentID?: string; location: { directory: string } }>
  messages(id: string): Promise<SessionMessageInfo[]>
  save(id: string, turn: SessionMessageInfo[]): Promise<void>
}) {
  const queues = new Map<string, Promise<void>>()
  const seen = new Set<string>()
  return async (event: CaptureEvent) => {
    if (event.type !== "session.execution.succeeded" || !event.data.sessionID) return
    if (event.location && event.location.directory !== deps.directory) return
    if (seen.has(event.id)) return
    seen.add(event.id)
    const sessionID = event.data.sessionID
    const task = (queues.get(sessionID) ?? Promise.resolve()).then(async () => {
      const session = await deps.session(sessionID)
      if (session.parentID || session.location.directory !== deps.directory) return
      const messages = await deps.messages(sessionID)
      // Idle message IDs are derived from the execution event, so queued turns keep their own boundary.
      const end = messages.findIndex((message) => message.id === event.id.replace(/^evt_/, "msg_"))
      if (end < 0) return
      const turn = splitIntoTurns(messages.slice(0, end + 1)).at(-1)
      if (turn) await deps.save(sessionID, turn)
    }).catch((error) => {
      seen.delete(event.id)
      console.warn("memsearch: memory capture failed", error)
    })
    queues.set(sessionID, task)
    await task
    if (queues.get(sessionID) === task) queues.delete(sessionID)
  }
}
