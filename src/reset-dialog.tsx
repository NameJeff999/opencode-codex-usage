/** @jsxImportSource @opentui/solid */
import type { TuiDialogSelectProps, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { AccountChangedError, AuthExpiredError } from "./auth"
import { PendingResetError } from "./journal"
import { doctor, doctorText } from "./doctor"
import { availableCredits, resetCountLabel, resetExpiryLabel, snapshotText } from "./format"
import type { UsageController } from "./usage"
import type { ResetAttempt, ResetCredit, ResetCredits } from "./types"

export function createResetDialog(api: TuiPluginApi, usage: UsageController) {
  let disposed = false
  let owned = false
  let view = 0
  let active: AbortController | undefined
  const running = new Set<string>()
  let lastAccountKey = usage.accountKey()

  function close() {
    view++
    active?.abort()
    active = undefined
    if (owned) api.ui.dialog.clear()
    owned = false
  }

  // Replacements from another feature must not be overwritten by an old HTTP response.
  function select<Value>(props: TuiDialogSelectProps<Value>) {
    const id = ++view
    owned = true
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.replace(
      () => (
        <DialogSelect
          {...props}
          onSelect={(item) => {
            if (!disposed && owned && id === view) props.onSelect?.(item)
          }}
        />
      ),
      () => {
        if (id !== view) return
        owned = false
        view++
        active?.abort()
      },
    )
    return id
  }

  function message(title: string, text: string) {
    const id = ++view
    owned = true
    const DialogAlert = api.ui.DialogAlert
    api.ui.dialog.replace(
      () => (
        <DialogAlert
          title={title}
          message={text}
          onConfirm={() => {
            if (current(id)) close()
          }}
        />
      ),
      () => {
        if (id !== view) return
        owned = false
        view++
        active?.abort()
      },
    )
    return id
  }

  function current(id: number, accountKey?: string) {
    return !disposed && owned && view === id && (!accountKey || accountKey === usage.accountKey())
  }

  const offAccount = usage.onAccountChange(() => {
    const previous = lastAccountKey
    lastAccountKey = usage.accountKey()
    // Initial login discovery cannot invalidate a reset confirmation: none exists yet.
    if (!previous) return
    if (owned)
      api.ui.toast({ variant: "warning", message: "ChatGPT account changed. Reopen usage for the current account." })
    close()
  })

  async function open(mode: "resets" | "usage" | "doctor" = "resets") {
    if (disposed) return
    // Install ownership before awaiting, so closing/switching dialogs cancels the view.
    const id = select({
      title:
        mode === "doctor"
          ? "Checking Codex setup…"
          : mode === "usage"
            ? "Checking Codex account usage…"
            : "Checking banked resets…",
      options: [{ title: "Cancel", value: "cancel" }],
      skipFilter: true,
      onSelect: close,
    })
    if (mode === "doctor") {
      active = new AbortController()
      try {
        const report = await doctor({
          client: usage.client,
          surface: "tui",
          version: api.app?.version,
          permission: api.state?.config.permission,
          signal: active.signal,
        })
        if (current(id)) message("Codex setup diagnostics", doctorText(report))
      } catch {
        if (current(id)) message("Codex setup diagnostics", "Diagnostics were interrupted. Run codex-doctor again.")
      }
      return
    }
    await usage.syncContext()
    if (!current(id)) return
    const account = usage.account()
    if (account.status !== "ready") {
      message("Codex account usage", account.status === "expired" ? new AuthExpiredError().message : account.message)
      return
    }
    let unresolved: ResetAttempt | undefined
    try {
      if (mode === "resets") unresolved = usage.pendingReset(account.account.key)
    } catch (error) {
      message(
        "Reset recovery unavailable",
        error instanceof Error ? error.message : "Run codex-doctor to check recovery storage.",
      )
      return
    }
    if (mode === "resets" && unresolved) {
      if (running.has(account.account.key)) {
        message(
          "Codex reset in progress",
          "The previous request is still finishing. Reopen the picker when it completes.",
        )
      } else {
        retry(
          unresolved,
          "The previous reset outcome is unknown. Retry the same attempt to avoid spending another credit.",
        )
      }
      return
    }
    const next = await usage.refresh({ force: true })
    if (!current(id, account.account.key)) return
    if (!next) {
      showRefreshError(usage.error() ?? "Unable to refresh Codex usage.", mode)
      return
    }
    if (mode === "usage") {
      message(
        `${account.account.label} — usage`,
        `${snapshotText(next)}\n\nThese are account limits, independent of the selected model.\nUse /codex-reset to view and redeem banked credits.`,
      )
      return
    }
    if (!next.resets) {
      showRefreshError(next.resetError ?? "Reset availability is unknown.", mode)
      return
    }
    if (next.resets.availableCount <= 0) {
      message("Codex resets", "No banked usage resets are available for this account.")
      return
    }
    picker(next.resets, account.account.key, account.account.label)
  }

  function showRefreshError(error: string, mode: "usage" | "resets") {
    select({
      title: "Could not check Codex usage",
      options: [
        { title: "Try again", value: "retry", description: error },
        { title: "Close", value: "close" },
      ],
      current: "close",
      skipFilter: true,
      onSelect: (item) => {
        if (item.value === "retry") void open(mode)
        else close()
      },
    })
  }

  function picker(inventory: ResetCredits, accountKey: string, accountLabel: string) {
    const credits = availableCredits(inventory.credits, inventory.availableCount)
    select<ResetCredit | "next" | "cancel">({
      title: `${accountLabel} — ${resetCountLabel(inventory.availableCount)}`,
      options: [
        ...(credits.length
          ? credits.map((credit) => ({
              title: credit.title?.trim() || "Full reset",
              value: credit,
              description: `${resetExpiryLabel(credit)}. ${credit.description?.trim() || "Reset eligible usage limits."}`,
            }))
          : [
              {
                title: "Next available reset",
                value: "next" as const,
                description: "The service will select the next available credit.",
              },
            ]),
        { title: "Cancel", value: "cancel" },
      ],
      skipFilter: true,
      current: "cancel",
      onSelect: (item) => {
        if (item.value === "cancel") {
          close()
          return
        }
        confirmation(inventory, accountKey, accountLabel, item.value === "next" ? undefined : item.value)
      },
    })
  }

  function confirmation(inventory: ResetCredits, accountKey: string, label: string, credit?: ResetCredit) {
    const attempt: ResetAttempt = { accountKey, idempotencyKey: crypto.randomUUID(), creditId: credit?.id }
    select({
      title: "Use one banked reset?",
      options: [
        {
          title: "Yes, use reset",
          value: "use",
          description: `${label}. ${credit ? `${credit.title || "Full reset"} — ${resetExpiryLabel(credit)}` : "Use the next available credit."}`,
        },
        { title: "No, go back", value: "cancel" },
      ],
      current: "cancel",
      skipFilter: true,
      onSelect: (item) => {
        if (item.value === "cancel") {
          picker(inventory, accountKey, label)
          return
        }
        void consume(attempt)
      },
    })
  }

  async function consume(attempt: ResetAttempt) {
    if (running.has(attempt.accountKey)) return
    running.add(attempt.accountKey)
    active?.abort()
    active = new AbortController()
    const signal = active.signal
    const id = select({
      title: "Using a banked Codex reset…",
      options: [{ title: "Request in progress", value: "wait", disabled: true }],
      skipFilter: true,
    })
    try {
      const outcome = await usage.consume(attempt, signal)
      if (!current(id, attempt.accountKey)) return
      // Force a new request; a poll started before redemption cannot establish the new balance.
      const next = await usage.refresh({ force: true })
      if (!current(id, attempt.accountKey)) return
      if (outcome === "reset" || outcome === "already_redeemed") {
        const result =
          outcome === "reset"
            ? "Usage reset."
            : "This reset attempt already completed. No additional credit was consumed."
        const balance = next?.resets
          ? `${resetCountLabel(next.resets.availableCount)}.`
          : "The remaining balance could not be refreshed; refresh usage before using another reset."
        message("Codex usage reset", `${result} ${balance}`)
        return
      }
      message(
        "Codex resets",
        outcome === "nothing_to_reset"
          ? "Your current usage does not need a reset. No credit was consumed."
          : "That reset is no longer available. Reopen the picker to check your current balance.",
      )
    } catch (cause) {
      if (!current(id, attempt.accountKey)) return
      if (cause instanceof AccountChangedError) {
        await usage.syncContext()
        if (current(id)) message("ChatGPT account changed", cause.message)
        return
      }
      retry(
        cause instanceof PendingResetError ? cause.attempt : attempt,
        cause instanceof Error ? cause.message : "The request failed.",
      )
    } finally {
      running.delete(attempt.accountKey)
    }
  }

  function retry(attempt: ResetAttempt, error: string) {
    select({
      title: "Could not confirm the reset outcome",
      options: [
        { title: "Retry the same attempt", value: "retry", description: error },
        { title: "Close", value: "close", description: "Saved attempts remain available after restarting OpenCode." },
      ],
      current: "close",
      skipFilter: true,
      onSelect: (item) => {
        if (item.value === "retry") void consume(attempt)
        else close()
      },
    })
  }

  return {
    open: () => open(),
    openUsage: () => open("usage"),
    openDoctor: () => open("doctor"),
    dispose() {
      disposed = true
      offAccount()
      close()
    },
  }
}
