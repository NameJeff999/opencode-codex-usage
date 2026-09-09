import { ResetJournal } from "../src/journal"
import { expect, test } from "bun:test"
import { CodexClient } from "../src/api"
import { createUsageController } from "../src/usage"
import { credential, deferred, events, inventoryPayload, until, usagePayload } from "./fixtures"

test("account usage works without guessing the host's selected model", async () => {
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => credential(),
    fetch: async (url) => Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload()),
  })
  const controller = createUsageController({ event: events }, { client, background: false })
  try {
    await controller.ready
    expect(controller.hasOAuth()).toBe(true)
    expect(controller.snapshot()?.resets?.availableCount).toBe(2)
  } finally {
    controller.dispose()
  }
})

test("account switch clears the previous balance and discards an in-flight response", async () => {
  let auth = credential("A")
  let gets = 0
  const old = deferred<Response>()
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => auth,
    fetch: async (url) => {
      if (!String(url).endsWith("/usage")) return Response.json(inventoryPayload())
      gets++
      if (gets === 2) return old.promise
      return Response.json(usagePayload(gets === 1 ? 90 : 10))
    },
  })
  const controller = createUsageController({ event: events }, { client, background: false })
  try {
    await controller.ready
    const previous = controller.refresh()
    await until(() => gets === 2)
    auth = credential("B")
    await controller.syncContext()
    expect(controller.snapshot()).toBeUndefined()
    const next = await controller.refresh()
    expect(next?.usage.buckets[0].primary?.usedPercent).toBe(10)
    old.resolve(Response.json(usagePayload(99)))
    await previous
    expect(controller.snapshot()?.usage.buckets[0].primary?.usedPercent).toBe(10)
  } finally {
    old.resolve(Response.json(usagePayload()))
    controller.dispose()
  }
})

test("post-reset forced refresh issues a new GET and cannot be overwritten by a pre-reset poll", async () => {
  let gets = 0
  let consumed = false
  const old = deferred<Response>()
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => credential(),
    fetch: async (url, init) => {
      if (init?.method === "POST") {
        consumed = true
        return Response.json({ code: "reset" })
      }
      if (!String(url).endsWith("/usage")) return Response.json(inventoryPayload(consumed ? 1 : 2))
      gets++
      if (gets === 2) return old.promise
      return Response.json(usagePayload(consumed ? 0 : 100))
    },
  })
  const controller = createUsageController({ event: events }, { client, background: false })
  try {
    await controller.ready
    const poll = controller.refresh()
    await until(() => gets === 2)
    await controller.consume({ accountKey: controller.accountKey()!, idempotencyKey: "same-attempt" })
    const refreshed = await controller.refresh({ force: true })
    expect(gets).toBe(3)
    expect(refreshed?.resets?.availableCount).toBe(1)
    old.resolve(Response.json(usagePayload(100)))
    await poll
    expect(controller.snapshot()?.usage.buckets[0].primary?.usedPercent).toBe(0)
  } finally {
    old.resolve(Response.json(usagePayload()))
    controller.dispose()
  }
})

test("failed refresh marks an old snapshot stale until a successful refresh", async () => {
  let fail = false
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => credential(),
    fetch: async (url) =>
      fail
        ? new Response(null, { status: 503 })
        : Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload()),
  })
  const controller = createUsageController({ event: events }, { client, background: false })
  try {
    await controller.ready
    fail = true
    await controller.refresh()
    expect(controller.stale()).toBe(true)
    expect(controller.error()).toContain("503")
    fail = false
    await controller.refresh()
    expect(controller.stale()).toBe(false)
    expect(controller.error()).toBeUndefined()
  } finally {
    controller.dispose()
  }
})

test("expired credentials remain connected and recover without a model change", async () => {
  let auth = credential("A", 1)
  let gets = 0
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => auth,
    fetch: async (url) => {
      gets++
      return Response.json(String(url).endsWith("/usage") ? usagePayload() : inventoryPayload())
    },
  })
  const controller = createUsageController({ event: events }, { client, background: false })
  try {
    await controller.ready
    expect(controller.hasOAuth()).toBe(true)
    expect(controller.account().status).toBe("expired")
    expect(controller.error()).toContain("expired")
    expect(gets).toBe(0)
    auth = credential("A")
    expect(await controller.syncContext()).toBe(true)
    await controller.refresh()
    expect(controller.snapshot()?.resets?.availableCount).toBe(2)
    expect(controller.error()).toBeUndefined()
  } finally {
    controller.dispose()
  }
})

test("disposal cancels a request and does not publish its late result", async () => {
  const response = deferred<Response>()
  let started = false
  let signal: AbortSignal | undefined
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => credential(),
    fetch: async (url, init) => {
      if (!String(url).endsWith("/usage")) return Response.json(inventoryPayload())
      started = true
      signal = init?.signal ?? undefined
      return response.promise
    },
  })
  const controller = createUsageController({ event: events }, { client, background: false })
  await until(() => started)
  controller.dispose()
  expect(signal?.aborted).toBe(true)
  response.resolve(Response.json(usagePayload()))
  await controller.ready
  expect(controller.snapshot()).toBeUndefined()
})
