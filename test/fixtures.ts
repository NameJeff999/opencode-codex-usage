import type { OAuthCredential } from "../src/types"

export function credential(account = "account-A", expires = Date.now() + 3_600_000): OAuthCredential {
  const payload = Buffer.from(
    JSON.stringify({ sub: "user-1", "https://api.openai.com/auth": { chatgpt_account_id: account } }),
  ).toString("base64url")
  return {
    type: "oauth",
    access: `test.${payload}.signature`,
    refresh: "synthetic-refresh",
    accountId: account,
    expires,
  }
}

export function usagePayload(used = 40, resets = 2) {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: used < 100,
      primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
    },
    rate_limit_reset_credits: { available_count: resets },
  }
}

export function creditPayload() {
  return {
    id: "credit-1",
    status: "available",
    reset_type: "codex_rate_limits",
    granted_at: "2026-07-01T00:00:00Z",
    expires_at: "2027-01-01T13:30:00Z",
    title: "Full reset",
    description: "Reset eligible Codex limits.",
  }
}

export function inventoryPayload(count = 2) {
  return { available_count: count, credits: count ? [creditPayload()] : [] }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export async function until(condition: () => boolean) {
  for (let tick = 0; tick < 200; tick++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Expected condition did not occur")
}

export const events = { on: () => () => {} }
