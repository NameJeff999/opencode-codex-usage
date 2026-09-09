import { watch, type FSWatcher } from "node:fs"
import path from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { CodexClient } from "./api"
import { AccountChangedError, AuthExpiredError, defaultAuthPath, readOpenAIAuth } from "./auth"
import type { AccountState, CodexSnapshot, ResetAttempt } from "./types"

export type UsageController = ReturnType<typeof createUsageController>

export function createUsageController(
  api: Pick<TuiPluginApi, "event">,
  options: {
    client?: CodexClient
    refreshIntervalMs?: number
    contextIntervalMs?: number
    authPath?: string
    /** Disable background work in deterministic integration tests. */
    background?: boolean
  } = {},
) {
  const client = options.client ?? new CodexClient({ loadAuth: () => readOpenAIAuth({ authPath: options.authPath }) })
  const [account, setAccount] = createSignal<AccountState>({
    status: "disconnected",
    message: "Checking ChatGPT login…",
  })
  const [snapshot, setSnapshot] = createSignal<CodexSnapshot>()
  const [refreshing, setRefreshing] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [updatedAt, setUpdatedAt] = createSignal<number>()
  const accountListeners = new Set<() => void>()
  let disposed = false
  let generation = 0
  let sequence = 0
  let needsRefresh = false
  let contextPromise: Promise<boolean> | undefined
  let pending: { abort: AbortController; promise: Promise<CodexSnapshot | undefined> } | undefined

  function accountKey() {
    const value = account()
    return value.status === "disconnected" ? undefined : value.account.key
  }

  function invalidate() {
    generation++
    sequence++
    pending?.abort.abort()
    pending = undefined
    setRefreshing(false)
  }

  function syncContext(): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    if (contextPromise) return contextPromise
    contextPromise = client
      .account()
      .then((next) => {
        if (disposed) return false
        const previous = account()
        const changed = accountKey() !== (next.status === "disconnected" ? undefined : next.account.key)
        const statusChanged = next.status !== previous.status
        if (changed || statusChanged) invalidate()
        setAccount(next)
        if (changed) {
          setSnapshot(undefined)
          setUpdatedAt(undefined)
          for (const listener of accountListeners) listener()
        }
        if (next.status === "expired") setError(new AuthExpiredError().message)
        if (next.status === "disconnected") setError(next.message)
        if (next.status === "ready" && (changed || statusChanged)) setError(undefined)
        if (next.status === "ready" && (changed || statusChanged)) needsRefresh = true
        return changed || statusChanged
      })
      .finally(() => {
        contextPromise = undefined
      })
    return contextPromise
  }

  async function refresh(options: { force?: boolean } = {}): Promise<CodexSnapshot | undefined> {
    await syncContext()
    const current = account()
    if (disposed || current.status !== "ready") return
    if (pending && !options.force) return pending.promise
    needsRefresh = false
    pending?.abort.abort()
    const request = ++sequence
    const epoch = generation
    const abort = new AbortController()
    setRefreshing(true)
    const promise = client
      .snapshot(current.account.key, abort.signal)
      .then(async (value) => {
        // Check identity again even if the filesystem watcher has not fired yet.
        await syncContext()
        if (disposed || request !== sequence || epoch !== generation) return
        setSnapshot(value)
        setUpdatedAt(Date.now())
        setError(undefined)
        return value
      })
      .catch(async (cause: unknown) => {
        if (cause instanceof AccountChangedError || cause instanceof AuthExpiredError) await syncContext()
        if (!disposed && request === sequence && epoch === generation) {
          setError(cause instanceof Error ? cause.message : "Unable to load Codex usage")
        }
        return undefined
      })
      .finally(() => {
        if (!disposed && request === sequence) {
          pending = undefined
          setRefreshing(false)
        }
      })
    pending = { abort, promise }
    return promise
  }

  let watcher: FSWatcher | undefined
  let contextTimer: ReturnType<typeof setInterval> | undefined
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let offIdle: (() => void) | undefined
  if (options.background !== false) {
    const file = options.authPath ?? defaultAuthPath()
    const sync = () =>
      void syncContext().then(() => {
        if (needsRefresh) void refresh()
      })
    try {
      watcher = watch(path.dirname(file), (_event, name) => {
        if (!name || name.toString() === path.basename(file)) sync()
      })
    } catch {
      // Polling remains the fallback when the directory does not exist yet.
    }
    contextTimer = setInterval(sync, options.contextIntervalMs ?? 1_000)
    refreshTimer = setInterval(() => void refresh(), options.refreshIntervalMs ?? 60_000)
    offIdle = api.event.on("session.idle", () => {
      void refresh()
    })
  }
  const ready = refresh()

  return {
    ready,
    account,
    accountKey,
    snapshot,
    refreshing,
    error,
    updatedAt,
    hasOAuth: () => account().status !== "disconnected",
    stale: () => Boolean(snapshot() && (error() || account().status !== "ready")),
    refresh,
    syncContext,
    pendingReset: (key: string) => client.journal.pending(key),
    client,
    async consume(attempt: ResetAttempt, signal?: AbortSignal) {
      await syncContext()
      if (disposed || attempt.accountKey !== accountKey()) throw new AccountChangedError()
      return client.consumeReset(attempt, signal)
    },
    onAccountChange(listener: () => void) {
      accountListeners.add(listener)
      return () => {
        accountListeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      invalidate()
      clearInterval(contextTimer)
      clearInterval(refreshTimer)
      offIdle?.()
      watcher?.close()
      accountListeners.clear()
    },
  }
}
