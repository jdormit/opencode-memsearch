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

export { deriveCollectionName } from "../src/memory"
export { connect, listSessions, readMessages } from "../src/service"

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
