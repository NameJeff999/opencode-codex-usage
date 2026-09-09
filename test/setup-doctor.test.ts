import { test, expect } from "bun:test"
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setup, parseConfig } from "../src/setup"
import { doctor } from "../src/doctor"
import { ResetJournal } from "../src/journal"
import { CodexClient } from "../src/api"
import { credential, usagePayload } from "./fixtures"

test("setup preserves JSONC comments, unrelated plugins and deny permissions; backup and rerun are safe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-setup-"))
  try {
    const file = path.join(directory, "opencode.jsonc")
    const original = '{\n // keep my settings\n "plugin": ["other-plugin",],\n "permission": {"*":"deny"},\n}\n'
    await writeFile(file, original)
    const preview = await setup({ directory, tui: true, server: true, dryRun: true })
    expect(preview.every((plan) => plan.changed)).toBe(true)
    expect(await readdir(directory)).toEqual(["opencode.jsonc"])
    const applied = await setup({ directory, tui: true, server: true })
    const updated = await readFile(file, "utf8")
    expect(updated).toContain("// keep my settings")
    expect(parseConfig(updated).permission).toEqual({ "*": "deny" })
    expect((parseConfig(updated).plugin as string[])[0]).toBe("other-plugin")
    expect(await readFile(applied.find((plan) => plan.backup)!.backup!, "utf8")).toBe(original)
    const again = await setup({ directory, tui: true, server: true })
    expect(again.every((plan) => !plan.changed)).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("invalid second configuration prevents setup from changing the first", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-setup-"))
  try {
    await writeFile(path.join(directory, "opencode.json"), '{"plugin":42}')
    await expect(setup({ directory, tui: true, server: true })).rejects.toThrow("array")
    expect(await readdir(directory)).toEqual(["opencode.json"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("doctor distinguishes expired login and offline mode without a request or credential disclosure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-doctor-"))
  const auth = credential("account-private", Date.now() - 1000)
  let requests = 0
  const journal = new ResetJournal(":memory:")
  try {
    const report = await doctor({
      configDirectory: directory,
      offline: true,
      version: "1.18.30",
      client: new CodexClient({
        journal,
        loadAuth: async () => auth,
        fetch: async () => {
          requests++
          throw new Error("never called")
        },
      }),
    })
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.name === "ChatGPT OAuth")?.detail).toContain("expired")
    expect(report.checks.find((check) => check.name === "ChatGPT endpoints")?.status).toBe("skipped")
    expect(requests).toBe(0)
    expect(JSON.stringify(report)).not.toContain(auth.access)
    expect(JSON.stringify(report)).not.toContain(auth.accountId!)
    expect(JSON.stringify(report)).not.toContain(directory)
  } finally {
    journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("doctor checks inventory independently of compact count and never redeems", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-doctor-"))
  const methods: string[] = []
  const journal = new ResetJournal(":memory:")
  try {
    const report = await doctor({
      configDirectory: directory,
      permission: { codex_reset: "deny" },
      client: new CodexClient({
        journal,
        loadAuth: async () => credential(),
        fetch: async (url, init) => {
          methods.push(init?.method ?? "GET")
          return String(url).endsWith("/usage") ? Response.json(usagePayload()) : new Response(null, { status: 403 })
        },
      }),
    })
    expect(methods).toEqual(["GET", "GET"])
    expect(report.checks.find((check) => check.name === "Usage endpoint")?.status).toBe("ok")
    expect(report.checks.find((check) => check.name === "Reset inventory endpoint")?.detail).toContain("403")
    expect(report.checks.find((check) => check.name === "Reset permission")?.detail).toContain("denied")
  } finally {
    journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})
