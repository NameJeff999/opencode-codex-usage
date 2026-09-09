import { CodexApiError, CodexClient } from "./api"
import { defaultConfigDirectory, isOurEntry, localEntry, parseConfig, readOptional } from "./setup"
import path from "node:path"
import pkg from "../package.json"

type Check = { name: string; status: "ok" | "warning" | "error" | "skipped"; detail: string }
export type DoctorOptions = {
  client?: CodexClient
  offline?: boolean
  signal?: AbortSignal
  version?: string
  surface?: "tui" | "server" | "cli"
  configDirectory?: string
  permission?: unknown
}

function permissionCheck(policy: unknown): Check {
  let rule = policy
  if (policy && typeof policy === "object") {
    const rules = policy as Record<string, unknown>
    rule = rules.codex_reset ?? rules["*"]
    if (rules.codex_reset === undefined && rule !== "deny") rule = "ask"
  } else if (policy !== "deny") rule = "ask"
  if (rule === "deny")
    return {
      name: "Reset permission",
      status: "warning",
      detail: "Reset redemption is denied by this policy. Keep it denied unless you intend to enable redemption.",
    }
  if (rule === "allow")
    return {
      name: "Reset permission",
      status: "warning",
      detail: "This policy allows redemption without a permission prompt. Set codex_reset to ask for confirmation.",
    }
  if (rule === "ask" || rule === undefined)
    return {
      name: "Reset permission",
      status: "ok",
      detail: "Confirmation is requested by default; more specific project or agent policies may override it.",
    }
  return {
    name: "Reset permission",
    status: "warning",
    detail: "Custom permission rules found. Check the effective codex_reset policy in OpenCode.",
  }
}

export async function doctor(options: DoctorOptions = {}) {
  const client = options.client ?? new CodexClient()
  const checks: Check[] = []
  checks.push({
    name: "Plugin",
    status: "ok",
    detail: `opencode-codex-usage ${pkg.version}; ${options.surface ?? "cli"} diagnostics`,
  })
  const version = options.version?.match(/^(\d+)\.(\d+)\.(\d+)$/)
  checks.push(
    !version
      ? {
          name: "OpenCode version",
          status: "warning",
          detail: "Host version unavailable. Run opencode --version; supported range is >=1.18.5 <2.",
        }
      : {
          name: "OpenCode version",
          status:
            Number(version[1]) === 1 &&
            (Number(version[2]) > 18 || (Number(version[2]) === 18 && Number(version[3]) >= 5))
              ? "ok"
              : "warning",
          detail: `${version[0]}; tested plugin API: 1.18.30`,
        },
  )
  const directory = options.configDirectory ?? defaultConfigDirectory()
  for (const kind of ["tui", "server"] as const) {
    const name = kind === "tui" ? "tui" : "opencode"
    try {
      const files = await Promise.all(
        ["json", "jsonc"].map((ext) => readOptional(path.join(directory, `${name}.${ext}`))),
      )
      const configs = files.filter((value): value is string => value !== undefined).map(parseConfig)
      const found = configs.some((config) =>
        (config.plugin as unknown[] | undefined)?.some((entry) => isOurEntry(entry, kind, localEntry(kind))),
      )
      checks.push({
        name: `${kind} configuration`,
        status: found || options.surface === kind ? "ok" : "warning",
        detail:
          options.surface === kind
            ? "This entry is running in the host."
            : found
              ? "Plugin entry found in the inspected configuration directory. Restart OpenCode after setup."
              : "Entry not found in the inspected directory. It may be configured in another scope; use setup to install it here.",
      })
      if (kind === "server" && options.permission === undefined)
        checks.push(permissionCheck(configs.at(-1)?.permission))
      if (configs.length > 1)
        checks.push({
          name: `${kind} configuration overlap`,
          status: "warning",
          detail: "Both JSON and JSONC files exist. Setup requires consolidation before making changes.",
        })
    } catch {
      checks.push({
        name: `${kind} configuration`,
        status: "error",
        detail: "Configuration cannot be read or parsed. Repair JSON/JSONC and check file permissions.",
      })
    }
  }
  if (options.permission !== undefined) checks.push(permissionCheck(options.permission))
  const account = await client.account()
  checks.push({
    name: "ChatGPT OAuth",
    status: account.status === "ready" ? "ok" : "error",
    detail:
      account.status === "ready"
        ? "A connected, unexpired ChatGPT login is available on this host."
        : account.status === "expired"
          ? "Access token expired. Let OpenCode refresh its ChatGPT login, or reconnect OpenAI with ChatGPT OAuth."
          : "ChatGPT OAuth is unavailable on this host. Connect OpenAI using ChatGPT OAuth in OpenCode.",
  })
  let pending = false
  try {
    pending = Boolean(client.journal.health(account.status === "disconnected" ? undefined : account.account.key))
    checks.push({
      name: "Reset recovery",
      status: pending ? "warning" : "ok",
      detail: pending
        ? "A saved reset has an unknown outcome. Use codex-reset or codex_reset to resume it; do not delete recovery data."
        : "Recovery database is readable and valid. New attempts must be saved successfully before redemption.",
    })
  } catch {
    checks.push({
      name: "Reset recovery",
      status: "error",
      detail:
        "Recovery storage is inaccessible or invalid. Check directory access and restore a known-good backup if needed. Preserve existing data; redemption stays blocked.",
    })
  }
  if (options.offline || account.status !== "ready") {
    checks.push({
      name: "ChatGPT endpoints",
      status: "skipped",
      detail: options.offline
        ? "Offline mode: no network requests made."
        : "Endpoint checks require an unexpired ChatGPT login.",
    })
  } else {
    const results = await Promise.allSettled([
      client.usage(account.account.key, options.signal),
      client.resetCredits(account.account.key, options.signal),
    ])
    const current = await client.account()
    const changed = current.status !== "ready" || current.account.key !== account.account.key
    results.forEach((result, index) => {
      const name = index === 0 ? "Usage endpoint" : "Reset inventory endpoint"
      if (changed)
        checks.push({ name, status: "warning", detail: "Login changed during diagnostics. Run the check again." })
      else if (result.status === "fulfilled")
        checks.push({ name, status: "ok", detail: "Read-only request succeeded and the response was understood." })
      else {
        const status = result.reason instanceof CodexApiError ? result.reason.status : undefined
        checks.push({
          name,
          status: "error",
          detail:
            status === 401
              ? "HTTP 401: refresh or reconnect the ChatGPT login."
              : status === 403
                ? "HTTP 403: access denied; check account eligibility or network restrictions."
                : status === 429
                  ? "HTTP 429: wait and retry later."
                  : "Request failed or response was unsupported. Check connectivity and plugin compatibility, then retry.",
        })
      }
    })
  }
  return { ok: !checks.some((check) => check.status === "error"), checks }
}

export function doctorText(report: Awaited<ReturnType<typeof doctor>>) {
  return report.checks.map((check) => `${check.status.toUpperCase()} · ${check.name}\n${check.detail}`).join("\n\n")
}
