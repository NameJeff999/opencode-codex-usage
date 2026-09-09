import { ResetJournal } from "../src/journal"
import { expect, test } from "bun:test"
import type { Config, ToolContext, ToolResult } from "@opencode-ai/plugin"
import { CodexClient } from "../src/api"
import { createServerTools, defaultResetPermission } from "../src/server-tools"
import { credential, deferred, inventoryPayload, until, usagePayload } from "./fixtures"

function context(ask: ToolContext["ask"] = async () => {}, messageID = "message-1"): ToolContext {
  return {
    sessionID: "session-1",
    messageID,
    agent: "build",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata() {},
    ask,
  }
}

function json(result: ToolResult) {
  return JSON.parse(typeof result === "string" ? result : result.output)
}

test("default policy requests reset permission while preserving explicit rules", () => {
  const config: Config = {}
  defaultResetPermission(config)
  expect(config.permission as unknown).toEqual({ codex_reset: "ask" })
  const explicit = { permission: { codex_reset: "deny" } } as unknown as Config
  defaultResetPermission(explicit)
  expect(explicit.permission as unknown).toEqual({ codex_reset: "deny" })
  const denied = { permission: "deny" } as unknown as Config
  defaultResetPermission(denied)
  expect(denied.permission as unknown).toBe("deny")
  const wildcard = { permission: { "*": "deny" } } as unknown as Config
  defaultResetPermission(wildcard)
  expect(wildcard.permission as unknown).toEqual({ "*": "deny" })
})

test("desktop usage is read-only and reports all quotas without credentials", async () => {
  const auth = credential()
  let posts = 0
  const tools = createServerTools(
    new CodexClient({
      journal: new ResetJournal(":memory:"),
      loadAuth: async () => auth,
      fetch: async (url, init) => {
        if (init?.method === "POST") posts++
        return Response.json(
          String(url).endsWith("/usage")
            ? {
                ...usagePayload(),
                additional_rate_limits: [
                  { metered_feature: "separate", limit_name: "Separate quota", rate_limit: null },
                ],
              }
            : inventoryPayload(),
        )
      },
    }),
  )
  const result = await tools.codex_usage.execute({}, context())
  expect(result).toContain("Separate quota")
  expect(result).toContain('"availableCount":2')
  expect(result).not.toContain(auth.access)
  expect(result).not.toContain(auth.refresh)
  expect(posts).toBe(0)
})

test("denying desktop permission prevents redemption", async () => {
  let posts = 0
  const tools = createServerTools(
    new CodexClient({
      journal: new ResetJournal(":memory:"),
      loadAuth: async () => credential(),
      fetch: async (url, init) => {
        if (init?.method === "POST") posts++
        return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
      },
    }),
  )
  await expect(
    tools.codex_reset.execute(
      {},
      context(async () => {
        throw new Error("permission denied")
      }),
    ),
  ).rejects.toThrow("permission denied")
  expect(posts).toBe(0)
})

test("account switch while the desktop approval is open prevents redemption", async () => {
  let auth = credential("A")
  let posts = 0
  let asked = false
  const approval = deferred<void>()
  const tools = createServerTools(
    new CodexClient({
      journal: new ResetJournal(":memory:"),
      loadAuth: async () => auth,
      fetch: async (url, init) => {
        if (init?.method === "POST") posts++
        return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
      },
    }),
  )
  const result = tools.codex_reset.execute(
    {},
    context(async () => {
      asked = true
      await approval.promise
    }),
  )
  await until(() => asked)
  auth = credential("B")
  approval.resolve()
  await expect(result).rejects.toThrow("account changed")
  expect(posts).toBe(0)
})

test("desktop uncertain retries keep the same key and selected credit, then refresh both endpoints", async () => {
  const bodies: string[] = []
  let readsAfterConsume = 0
  const tools = createServerTools(
    new CodexClient({
      journal: new ResetJournal(":memory:"),
      loadAuth: async () => credential(),
      fetch: async (url, init) => {
        if (init?.method === "POST") {
          bodies.push(String(init.body))
          if (bodies.length === 1) throw new Error("connection lost")
          return Response.json({ code: "already_redeemed" })
        }
        if (bodies.length >= 2) readsAfterConsume++
        return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
      },
    }),
  )
  const first = json(await tools.codex_reset.execute({ creditId: "credit-1" }, context()))
  expect(first.status).toBe("unknown_outcome")
  const retry = json(await tools.codex_reset.execute({ retryId: first.retryId }, context(undefined, "message-2")))
  expect(retry.outcome).toBe("already_redeemed")
  expect(bodies[1]).toBe(bodies[0])
  expect(JSON.parse(bodies[0]).credit_id).toBe("credit-1")
  expect(readsAfterConsume).toBe(2)
})

test("desktop does not generate a new attempt when an earlier outcome is unknown", async () => {
  let posts = 0
  const tools = createServerTools(
    new CodexClient({
      journal: new ResetJournal(":memory:"),
      loadAuth: async () => credential(),
      fetch: async (url, init) => {
        if (init?.method === "POST") {
          posts++
          throw new Error("lost")
        }
        return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
      },
    }),
  )
  const first = json(await tools.codex_reset.execute({}, context()))
  const second = json(await tools.codex_reset.execute({}, context(undefined, "message-2")))
  expect(second.status).toBe("retry_required")
  expect(second.retryId).toBe(first.retryId)
  expect(posts).toBe(1)
})

test("a duplicate completed tool call in one message does not consume twice", async () => {
  let posts = 0
  const tools = createServerTools(
    new CodexClient({
      journal: new ResetJournal(":memory:"),
      loadAuth: async () => credential(),
      fetch: async (url, init) => {
        if (init?.method === "POST") {
          posts++
          return Response.json({ code: "reset" })
        }
        return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
      },
    }),
  )
  await tools.codex_reset.execute({}, context())
  await tools.codex_reset.execute({}, context())
  expect(posts).toBe(1)
})

test("unknown inventory does not become zero or request permission", async () => {
  let approvals = 0
  const tools = createServerTools(
    new CodexClient({
      journal: new ResetJournal(":memory:"),
      loadAuth: async () => credential(),
      fetch: async (url) =>
        String(url).endsWith("/usage")
          ? Response.json({ plan_type: "plus", rate_limit: null })
          : new Response(null, { status: 503 }),
    }),
  )
  await expect(
    tools.codex_reset.execute(
      {},
      context(async () => {
        approvals++
      }),
    ),
  ).rejects.toThrow("unavailable")
  expect(approvals).toBe(0)
})
