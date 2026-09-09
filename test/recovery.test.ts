import { test, expect } from "bun:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResetJournal, RecoveryError, PendingResetError } from "../src/journal"
import { CodexClient } from "../src/api"
import { accountRef } from "../src/auth"
import { createServerTools } from "../src/server-tools"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { credential, inventoryPayload, usagePayload } from "./fixtures"

function context(sessionID = "session-1"): ToolContext {
  return {
    sessionID,
    messageID: crypto.randomUUID(),
    agent: "build",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}
const json = (result: ToolResult) => JSON.parse(typeof result === "string" ? result : result.output)

test("restart recovers the exact account/key/credit and cached success prevents a second redemption", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-recovery-"))
  const filename = path.join(directory, "resets.sqlite")
  let journal = new ResetJournal(filename)
  const auth = credential()
  const bodies: string[] = []
  const fetcher = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.method === "POST") {
      bodies.push(String(init.body))
      const observer = new ResetJournal(filename)
      try {
        expect(observer.pending(accountRef(auth).key)?.idempotencyKey).toBe(
          JSON.parse(String(init.body)).redeem_request_id,
        )
      } finally {
        observer.close()
      }
      if (bodies.length === 1) throw new Error("connection lost after server accepted request")
      return Response.json({ code: "already_redeemed" })
    }
    return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
  }
  try {
    let tools = createServerTools(new CodexClient({ journal, loadAuth: async () => auth, fetch: fetcher }))
    const first = json(await tools.codex_reset.execute({ creditId: "credit-1" }, context()))
    expect(first.status).toBe("unknown_outcome")
    journal.close()
    journal = new ResetJournal(filename)
    tools = createServerTools(new CodexClient({ journal, loadAuth: async () => auth, fetch: fetcher }))
    const blocked = json(await tools.codex_reset.execute({}, context("another-session")))
    expect(blocked.status).toBe("retry_required")
    expect(blocked.retryId).toBe(first.retryId)
    let approvals = 0
    const approval = context("another-session")
    approval.ask = async () => {
      approvals++
    }
    const retried = json(await tools.codex_reset.execute({ retryId: first.retryId }, approval))
    expect(approvals).toBe(1)
    expect(retried.outcome).toBe("already_redeemed")
    expect(bodies[1]).toBe(bodies[0])
    journal.close()
    journal = new ResetJournal(filename)
    tools = createServerTools(new CodexClient({ journal, loadAuth: async () => auth, fetch: fetcher }))
    await tools.codex_reset.execute({ retryId: first.retryId }, context())
    expect(bodies.length).toBe(2)
    const stored = await readFile(filename)
    expect(stored.includes(Buffer.from(auth.access))).toBe(false)
    expect(stored.includes(Buffer.from(auth.refresh))).toBe(false)
  } finally {
    journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("independent instances cannot reserve different pending requests for the same account", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-recovery-"))
  const filename = path.join(directory, "resets.sqlite")
  const one = new ResetJournal(filename)
  const two = new ResetJournal(filename)
  const attempt = { accountKey: "account-hash", idempotencyKey: "request-1", creditId: "credit-1" }
  try {
    one.begin(attempt)
    expect(() => two.begin({ ...attempt, idempotencyKey: "request-2" })).toThrow(PendingResetError)
    expect(() => two.begin({ ...attempt, accountKey: "other-account" })).toThrow(RecoveryError)
    expect(() => two.begin({ ...attempt, creditId: "other-credit" })).toThrow(RecoveryError)
    two.complete(attempt, "reset")
    one.begin({ ...attempt, idempotencyKey: "request-2" })
    expect(two.pending(attempt.accountKey)?.idempotencyKey).toBe("request-2")
  } finally {
    one.close()
    two.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("corrupt storage blocks POST without deleting recovery data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-recovery-"))
  const filename = path.join(directory, "resets.sqlite")
  const journal = new ResetJournal(filename)
  const auth = credential()
  let posts = 0
  try {
    await writeFile(filename, "damaged recovery data")
    const client = new CodexClient({
      journal,
      loadAuth: async () => auth,
      fetch: async () => {
        posts++
        return Response.json({ code: "reset" })
      },
    })
    await expect(
      client.consumeReset({ accountKey: accountRef(auth).key, idempotencyKey: "new-request" }),
    ).rejects.toThrow(RecoveryError)
    expect(posts).toBe(0)
    expect(await readFile(filename, "utf8")).toBe("damaged recovery data")
  } finally {
    journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("process exit immediately after reservation leaves a recoverable attempt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-recovery-"))
  const filename = path.join(directory, "resets.sqlite")
  const journal = new ResetJournal(filename)
  try {
    const code = `import { ResetJournal } from ${JSON.stringify(path.resolve("src/journal.ts"))}; new ResetJournal(process.argv[1]).begin({accountKey:"crash-account",idempotencyKey:"crash-request"}); process.exit(17)`
    const child = Bun.spawn([process.execPath, "-e", code, filename], { stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(17)
    expect(journal.pending("crash-account")?.idempotencyKey).toBe("crash-request")
  } finally {
    journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})
