import {
  AccountChangedError,
  AuthExpiredError,
  AuthUnavailableError,
  accountRef,
  authHeaders,
  readOpenAIAuth,
} from "./auth"
import { ResetJournal } from "./journal"
import type {
  AccountState,
  CodexSnapshot,
  CodexUsage,
  ConsumeOutcome,
  OAuthCredential,
  ResetAttempt,
  ResetCredit,
  ResetCredits,
  UsageBucket,
  UsageWindow,
} from "./types"

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api"

type Fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>
type AuthLoader = () => Promise<OAuthCredential>

export class CodexApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "CodexApiError"
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function parseWindow(value: unknown): UsageWindow | undefined {
  const input = record(value)
  if (!input) return
  const usedPercent = number(input.used_percent)
  const windowSeconds = number(input.limit_window_seconds)
  const resetsAt = number(input.reset_at)
  if (usedPercent === undefined || windowSeconds === undefined || windowSeconds <= 0 || resetsAt === undefined) return
  return { usedPercent, windowSeconds, resetsAt }
}

function parseBucket(id: string, value: unknown, name?: string, modelSlug?: string): UsageBucket {
  const limit = record(value)
  return {
    id,
    ...(name ? { name } : {}),
    ...(modelSlug ? { modelSlug } : {}),
    ...(typeof limit?.allowed === "boolean" ? { allowed: limit.allowed } : {}),
    ...(parseWindow(limit?.primary_window) ? { primary: parseWindow(limit?.primary_window) } : {}),
    ...(parseWindow(limit?.secondary_window) ? { secondary: parseWindow(limit?.secondary_window) } : {}),
  }
}

function count(value: unknown) {
  const result = number(value)
  return result !== undefined && Number.isSafeInteger(result) ? Math.max(0, result) : undefined
}

export function parseUsage(value: unknown): CodexUsage {
  const input = record(value)
  if (
    !input ||
    !(
      "rate_limit" in input ||
      "plan_type" in input ||
      "rate_limit_reset_credits" in input ||
      "additional_rate_limits" in input
    )
  ) {
    throw new CodexApiError("Invalid Codex usage response")
  }
  const resetCredits = record(input.rate_limit_reset_credits)
  const buckets = [parseBucket("codex", input.rate_limit)]
  for (const value of Array.isArray(input.additional_rate_limits) ? input.additional_rate_limits : []) {
    const extra = record(value)
    const id = text(extra?.metered_feature)
    if (!id || buckets.some((bucket) => bucket.id === id)) continue
    buckets.push(parseBucket(id, extra?.rate_limit, text(extra?.limit_name), text(extra?.normal_model_slug)))
  }
  return {
    ...(text(input.plan_type) ? { planType: text(input.plan_type) } : {}),
    buckets,
    ...(count(resetCredits?.available_count) !== undefined
      ? { availableResets: count(resetCredits?.available_count) }
      : {}),
  }
}

function parseTimestamp(value: unknown) {
  const input = text(value)
  if (!input || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) return
  const millis = Date.parse(input)
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : undefined
}

function parseCreditStatus(value: unknown): ResetCredit["status"] {
  return value === "available" || value === "redeeming" || value === "redeemed" ? value : "unknown"
}

function parseCredit(value: unknown): ResetCredit | undefined {
  const input = record(value)
  if (!input) return
  const id = text(input.id)
  const grantedAt = parseTimestamp(input.granted_at)
  const expiresAt = parseTimestamp(input.expires_at)
  if (!id || grantedAt === undefined || (input.expires_at != null && expiresAt === undefined)) {
    throw new CodexApiError("Invalid reset credit details")
  }
  return {
    id,
    resetType: text(input.reset_type) ?? "unknown",
    status: parseCreditStatus(input.status),
    grantedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(text(input.title) ? { title: text(input.title) } : {}),
    ...(text(input.description) ? { description: text(input.description) } : {}),
  }
}

export function parseResetCredits(value: unknown): ResetCredits {
  const input = record(value)
  if (!input) throw new CodexApiError("Invalid reset credit response")
  const availableCount = count(input.available_count)
  if (availableCount === undefined) throw new CodexApiError("Reset credit count is unavailable")
  if (!Array.isArray(input.credits)) throw new CodexApiError("Reset credit details are unavailable")
  const credits = input.credits.map((item) => {
    const credit = parseCredit(item)
    if (!credit) throw new CodexApiError("Invalid reset credit details")
    return credit
  })
  return { availableCount, credits }
}

export function parseConsumeOutcome(value: unknown): ConsumeOutcome {
  const code = record(value)?.code
  if (code === "reset" || code === "nothing_to_reset" || code === "no_credit" || code === "already_redeemed") {
    return code
  }
  throw new CodexApiError("Invalid reset outcome")
}

export class CodexClient {
  readonly journal: ResetJournal
  constructor(
    private readonly options: {
      fetch?: Fetch
      loadAuth?: AuthLoader
      baseUrl?: string
      journal?: ResetJournal
    } = {},
  ) {
    this.journal = options.journal ?? new ResetJournal()
  }

  async account(): Promise<AccountState> {
    try {
      const auth = await (this.options.loadAuth ?? readOpenAIAuth)()
      return {
        status: !auth.access || auth.expires <= Date.now() ? "expired" : "ready",
        account: accountRef(auth),
      }
    } catch (error) {
      return {
        status: "disconnected",
        message: error instanceof AuthUnavailableError ? error.message : "Unable to read the OpenCode ChatGPT login",
      }
    }
  }

  async usage(accountKey: string, signal?: AbortSignal) {
    return parseUsage(await this.request("/wham/usage", { method: "GET" }, 10_000, accountKey, signal))
  }

  async resetCredits(accountKey: string, signal?: AbortSignal) {
    return parseResetCredits(
      await this.request("/wham/rate-limit-reset-credits", { method: "GET" }, 5_000, accountKey, signal),
    )
  }

  async snapshot(accountKey: string, signal?: AbortSignal): Promise<CodexSnapshot> {
    const [usage, details] = await Promise.allSettled([
      this.usage(accountKey, signal),
      this.resetCredits(accountKey, signal),
    ])
    if (usage.status === "rejected") throw usage.reason
    if (details.status === "fulfilled") return { usage: usage.value, resets: details.value }
    if (details.reason instanceof AccountChangedError || details.reason instanceof AuthExpiredError)
      throw details.reason
    signal?.throwIfAborted()
    if (usage.value.availableResets !== undefined) {
      return { usage: usage.value, resets: { availableCount: usage.value.availableResets } }
    }
    return { usage: usage.value, resetError: "Reset availability is unavailable. Try refreshing again." }
  }

  async consumeReset(input: ResetAttempt, signal?: AbortSignal) {
    if (!input.idempotencyKey.trim()) throw new CodexApiError("Idempotency key must not be empty")
    if (input.creditId !== undefined && !input.creditId.trim()) throw new CodexApiError("Credit ID must not be empty")
    signal?.throwIfAborted()
    const account = await this.account()
    if (account.status === "disconnected" || account.account.key !== input.accountKey) throw new AccountChangedError()
    if (account.status === "expired") throw new AuthExpiredError()
    signal?.throwIfAborted()
    // Commit the exact account/credit/key before the HTTP request can leave this process.
    const stored = this.journal.begin(input)
    if (stored.outcome) return stored.outcome === "reset" ? "already_redeemed" : stored.outcome
    const outcome = parseConsumeOutcome(
      await this.request(
        "/wham/rate-limit-reset-credits/consume",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redeem_request_id: input.idempotencyKey,
            ...(input.creditId ? { credit_id: input.creditId } : {}),
          }),
        },
        10_000,
        input.accountKey,
        signal,
      ),
    )
    this.journal.complete(input, outcome)
    return outcome
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    expectedAccount: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted()
    const auth = await (this.options.loadAuth ?? readOpenAIAuth)()
    if (!expectedAccount || accountRef(auth).key !== expectedAccount) throw new AccountChangedError()
    if (!auth.access || auth.expires <= Date.now()) throw new AuthExpiredError()
    signal?.throwIfAborted()
    const headers = authHeaders(auth)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl ?? CHATGPT_BASE_URL}${path}`, {
        ...init,
        headers,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      })
      if (!response.ok) throw new CodexApiError(`ChatGPT request failed (${response.status})`, response.status)
      return await response.json()
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CodexApiError) throw error
      if (controller.signal.aborted) throw new CodexApiError("ChatGPT request timed out")
      throw new CodexApiError("ChatGPT request failed")
    } finally {
      clearTimeout(timeout)
    }
  }
}
