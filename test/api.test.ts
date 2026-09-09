import { ResetJournal } from "../src/journal"
import { describe, expect, test } from "bun:test"
import { CodexApiError, CodexClient, parseConsumeOutcome, parseResetCredits, parseUsage } from "../src/api"
import type { OAuthCredential } from "../src/types"
import { AccountChangedError, accountRef } from "../src/auth"
import { credential, creditPayload, inventoryPayload, usagePayload } from "./fixtures"

const auth: OAuthCredential = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  accountId: "account-1",
}

describe("Codex API parsing", () => {
  test("parses usage windows and banked resets", () => {
    expect(
      parseUsage({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 23.6, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 75, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
        },
        rate_limit_reset_credits: { available_count: 2 },
      }),
    ).toEqual({
      planType: "plus",
      buckets: [
        {
          id: "codex",
          primary: { usedPercent: 23.6, windowSeconds: 18_000, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 75, windowSeconds: 604_800, resetsAt: 1_800_500_000 },
        },
      ],
      availableResets: 2,
    })
  })

  test("parses reset credits while preserving unknown statuses", () => {
    expect(
      parseResetCredits({
        available_count: 1,
        credits: [
          {
            id: "credit-1",
            reset_type: "full",
            status: "future-status",
            granted_at: "2026-07-01T00:00:00Z",
            expires_at: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    ).toEqual({
      availableCount: 1,
      credits: [
        {
          id: "credit-1",
          resetType: "full",
          status: "unknown",
          grantedAt: 1_782_864_000,
          expiresAt: 1_785_542_400,
        },
      ],
    })
  })

  test("rejects an unknown consume outcome", () => {
    expect(() => parseConsumeOutcome({ code: "unexpected" })).toThrow(CodexApiError)
  })
})

test("consume sends auth, account, JSON, and redemption identifiers", async () => {
  let request: Request | undefined
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => auth,
    fetch: async (input, init) => {
      request = new Request(input, init)
      return Response.json({ code: "reset" })
    },
    baseUrl: "https://example.test",
  })

  await expect(
    client.consumeReset({ accountKey: accountRef(auth).key, idempotencyKey: "attempt-1", creditId: "credit-1" }),
  ).resolves.toBe("reset")
  expect(request?.url).toBe("https://example.test/wham/rate-limit-reset-credits/consume")
  expect(request?.headers.get("authorization")).toBe("Bearer access-token")
  expect(request?.headers.get("chatgpt-account-id")).toBe("account-1")
  expect(request?.headers.get("content-type")).toBe("application/json")
  expect(await request?.json()).toEqual({ redeem_request_id: "attempt-1", credit_id: "credit-1" })
})

test("preserves additional quota identities, names, model metadata and backend permission", () => {
  const usage = parseUsage({
    ...usagePayload(),
    additional_rate_limits: [
      {
        metered_feature: "codex_other",
        limit_name: "Other model quota",
        normal_model_slug: "gpt-example",
        rate_limit: {
          allowed: false,
          secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 2_000_000_100 },
        },
      },
    ],
  })
  expect(usage.buckets[1]).toEqual({
    id: "codex_other",
    name: "Other model quota",
    modelSlug: "gpt-example",
    allowed: false,
    secondary: { usedPercent: 100, windowSeconds: 604800, resetsAt: 2_000_000_100 },
  })
})

test("malformed expiry cannot become a non-expiring credit", () => {
  expect(() =>
    parseResetCredits({ available_count: 1, credits: [{ ...creditPayload(), expires_at: "broken" }] }),
  ).toThrow("Invalid reset credit")
})

test("successful detailed inventory overrides the compact reset count", async () => {
  const auth = credential()
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => auth,
    fetch: async (url) => Response.json(String(url).endsWith("/usage") ? usagePayload(20, 5) : inventoryPayload(1)),
  })
  expect((await client.snapshot(accountRef(auth).key)).resets?.availableCount).toBe(1)
})

test("details failure falls back to a fresh compact count, but unknown remains unknown", async () => {
  const auth = credential()
  let summary: unknown = usagePayload(20, 3)
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => auth,
    fetch: async (url) =>
      String(url).endsWith("/usage") ? Response.json(summary) : new Response(null, { status: 503 }),
  })
  expect((await client.snapshot(accountRef(auth).key)).resets).toEqual({ availableCount: 3 })
  summary = { plan_type: "plus", rate_limit: null }
  const unknown = await client.snapshot(accountRef(auth).key)
  expect(unknown.resets).toBeUndefined()
  expect(unknown.resetError).toContain("unavailable")
})

test("account change prevents sending a redemption, even when identity was checked earlier", async () => {
  const auth = credential("B")
  let calls = 0
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => auth,
    fetch: async () => {
      calls++
      return Response.json({ code: "reset" })
    },
  })
  await expect(
    client.consumeReset({ accountKey: accountRef(credential("A")).key, idempotencyKey: "attempt" }),
  ).rejects.toBeInstanceOf(AccountChangedError)
  expect(calls).toBe(0)
})

test("an aborted confirmation never sends a redemption request", async () => {
  const auth = credential()
  let calls = 0
  const client = new CodexClient({
    journal: new ResetJournal(":memory:"),
    loadAuth: async () => auth,
    fetch: async () => {
      calls++
      return Response.json({ code: "reset" })
    },
  })
  await expect(
    client.consumeReset({ accountKey: accountRef(auth).key, idempotencyKey: "attempt" }, AbortSignal.abort()),
  ).rejects.toThrow()
  expect(calls).toBe(0)
})

test("accepts all four documented backend outcomes", () => {
  for (const code of ["reset", "already_redeemed", "no_credit", "nothing_to_reset"] as const)
    expect(parseConsumeOutcome({ code })).toBe(code)
})
