import { tool, type Config, type ToolContext } from "@opencode-ai/plugin"
import { AccountChangedError, AuthExpiredError, AuthUnavailableError } from "./auth"
import { CodexClient } from "./api"
import { PendingResetError } from "./journal"
import { doctor } from "./doctor"
import { availableCredits, resetExpiryLabel, snapshotText } from "./format"
import type { AccountRef, ConsumeOutcome, ResetAttempt } from "./types"

type Attempt = {
  request: ResetAttempt
  sessionID: string
  messageID: string
  description: string
  outcome?: ConsumeOutcome
}

export function defaultResetPermission(config: Config) {
  const policy: unknown = config.permission
  // An explicit global deny or per-tool rule remains authoritative.
  if (policy === "deny") return
  if (policy && typeof policy === "object" && "*" in policy && policy["*"] === "deny") return
  if (policy && typeof policy === "object" && "codex_reset" in policy) return
  const rules = typeof policy === "string" ? { "*": policy } : (policy ?? {})
  // The v1 hook still uses legacy SDK types, while the host accepts named tool permissions.
  const target = config as unknown as { permission: Record<string, unknown> }
  target.permission = Object.assign({}, rules, { codex_reset: "ask" as const })
}

export function createServerTools(client = new CodexClient(), options: { permission?: () => unknown } = {}) {
  const attempts = new Map<string, Attempt>()
  const busy = new Set<string>()

  async function readyAccount(): Promise<AccountRef> {
    const state = await client.account()
    if (state.status === "disconnected") throw new AuthUnavailableError(state.message)
    if (state.status === "expired") throw new AuthExpiredError()
    return state.account
  }

  async function checkAccount(accountKey: string) {
    const current = await readyAccount()
    if (current.key !== accountKey) throw new AccountChangedError()
    return current
  }

  async function executeReset(args: { creditId?: string; retryId?: string }, context: ToolContext) {
    context.abort.throwIfAborted()
    const account = await readyAccount()
    if (busy.has(account.key)) throw new Error("A reset request is already in progress for this account.")
    busy.add(account.key)
    try {
      let retry = args.retryId
        ? attempts.get(args.retryId)
        : [...attempts.values()].find(
            (entry) => entry.sessionID === context.sessionID && entry.messageID === context.messageID,
          )
      if (args.retryId && !retry) {
        const saved = client.journal.get(args.retryId)
        if (saved)
          retry = {
            request: saved,
            sessionID: context.sessionID,
            messageID: context.messageID,
            description: `${account.label}: retry the saved reset attempt ${saved.idempotencyKey}. ${saved.creditId ? "Use the originally selected credit." : "Use the originally requested next credit."}`,
            outcome: saved.outcome === "reset" ? "already_redeemed" : saved.outcome,
          }
      }
      if (args.retryId && !retry)
        throw new Error("Unknown retry ID. Check current usage before starting a new reset attempt.")
      if (retry && retry.request.accountKey !== account.key) throw new AccountChangedError()
      if (retry && args.creditId !== undefined && args.creditId !== retry.request.creditId) {
        throw new Error("A retry must use the original credit. Omit creditId when retrying.")
      }
      const unresolved = client.journal.pending(account.key)
      if (!retry && unresolved) {
        return JSON.stringify({
          status: "retry_required",
          retryId: unresolved.idempotencyKey,
          message:
            "The previous attempt has an unknown outcome. Retry that attempt with this retryId; do not create a new one.",
        })
      }
      let attempt = retry
      if (!attempt) {
        const snapshot = await client.snapshot(account.key, context.abort)
        await checkAccount(account.key)
        if (!snapshot.resets) throw new Error(snapshot.resetError ?? "Reset availability is unknown. Try again later.")
        if (snapshot.resets.availableCount === 0) return "No banked resets are available. No credit was consumed."
        const credit = args.creditId
          ? availableCredits(snapshot.resets.credits, snapshot.resets.availableCount).find(
              (item) => item.id === args.creditId,
            )
          : undefined
        if (args.creditId && !credit)
          throw new Error("That credit is not in the current available inventory. Read codex_usage again.")
        attempt = {
          request: { accountKey: account.key, idempotencyKey: crypto.randomUUID(), creditId: credit?.id },
          sessionID: context.sessionID,
          messageID: context.messageID,
          description: `${account.label}: use ONE banked reset (${snapshot.resets.availableCount} available). ${credit ? `${credit.title || "Full reset"}. ${resetExpiryLabel(credit)}.` : "The service selects the next available credit."}`,
        }
      }

      if (!attempt.outcome) {
        // This is the stock Desktop/TUI permission UI. Never replace it with a model-supplied `confirm` Boolean.
        await context.ask({
          permission: "codex_reset",
          patterns: [attempt.description],
          always: [],
          metadata: {
            account: account.label,
            creditId: attempt.request.creditId,
            attemptId: attempt.request.idempotencyKey,
          },
        })
        context.abort.throwIfAborted()
        await checkAccount(attempt.request.accountKey)
        attempts.set(attempt.request.idempotencyKey, attempt)
        try {
          attempt.outcome = await client.consumeReset(attempt.request, context.abort)
        } catch (error) {
          if (error instanceof PendingResetError)
            return JSON.stringify({
              status: "retry_required",
              retryId: error.attempt.idempotencyKey,
              message: error.message,
            })
          if (error instanceof AccountChangedError || error instanceof AuthExpiredError) throw error
          return JSON.stringify({
            status: "unknown_outcome",
            retryId: attempt.request.idempotencyKey,
            message:
              "The reset outcome could not be confirmed. Retry codex_reset with the same retryId; never assume a credit was or was not consumed.",
          })
        }
      }

      const outcome = attempt.outcome
      let refreshed: string | undefined
      try {
        // A new pair of GETs always follows consumption; there is no shared pre-reset cache.
        const snapshot = await client.snapshot(attempt.request.accountKey, context.abort)
        await checkAccount(attempt.request.accountKey)
        refreshed = snapshotText(snapshot)
      } catch {
        refreshed = undefined
      }
      return JSON.stringify({
        outcome,
        retryId: attempt.request.idempotencyKey,
        message:
          outcome === "reset"
            ? "Usage reset."
            : outcome === "already_redeemed"
              ? "This attempt completed previously; no additional reset was consumed."
              : outcome === "nothing_to_reset"
                ? "No eligible usage window needed resetting. No credit was consumed."
                : "The selected reset is unavailable, or the account has no available reset credits.",
        usage: refreshed ?? null,
        ...(refreshed
          ? {}
          : { warning: "The reset outcome is known, but the latest balance is unavailable. Read codex_usage again." }),
      })
    } finally {
      busy.delete(account.key)
    }
  }

  return {
    codex_doctor: tool({
      description:
        "Diagnose this host's Codex usage plugin, ChatGPT OAuth, endpoint connectivity, configuration and saved reset recovery. Never redeems a reset or exposes credentials. Use offline to skip network checks.",
      args: { offline: tool.schema.boolean().optional().describe("Skip endpoint requests; inspect local setup only.") },
      async execute(args, context) {
        return JSON.stringify(
          await doctor({
            client,
            offline: args.offline,
            signal: context.abort,
            surface: "server",
            permission: options.permission?.(),
          }),
        )
      },
    }),
    codex_usage: tool({
      description:
        "Read the ChatGPT account's Codex usage limits and available banked resets from the OpenCode server's login. Read-only; never spends a reset. Report unknown or failed availability honestly. Does not require the currently selected model to be GPT.",
      args: {},
      async execute(_args, context) {
        const account = await readyAccount()
        const snapshot = await client.snapshot(account.key, context.abort)
        await checkAccount(account.key)
        const credits = snapshot.resets && availableCredits(snapshot.resets.credits, snapshot.resets.availableCount)
        return JSON.stringify({
          account: account.label,
          usage: snapshotText(snapshot),
          limits: snapshot.usage.buckets,
          bankedResets: snapshot.resets
            ? {
                availableCount: snapshot.resets.availableCount,
                credits: snapshot.resets.credits ? credits?.slice(0, 20) : null,
                detailsTruncated: Boolean(credits && credits.length > 20),
              }
            : null,
        })
      },
    }),
    codex_reset: tool({
      description:
        "Use ONE banked Codex reset only when the user explicitly asks. Requests OpenCode permission before redemption; never call automatically because usage is high. Optionally select a credit ID returned by codex_usage. If the outcome is unknown, retry with the returned retryId so the same idempotency key and account are reused. Never start a new attempt to work around an uncertain result.",
      args: {
        creditId: tool.schema
          .string()
          .min(1)
          .optional()
          .describe("Optional available credit ID from codex_usage. Omit to let the service select the next credit."),
        retryId: tool.schema
          .string()
          .min(1)
          .optional()
          .describe(
            "Retry ID returned by a previous codex_reset, including before a restart; preserves the original account and idempotency key.",
          ),
      },
      execute: executeReset,
    }),
  }
}
