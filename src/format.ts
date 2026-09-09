import type { CodexSnapshot, ResetCredit, UsageBucket, UsageWindow } from "./types"

const minute = 60
const hour = 60 * minute
const day = 24 * hour

export function remainingPercent(window: UsageWindow) {
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))
}

export function durationLabel(windowSeconds: number, fallback: string) {
  const hours = windowSeconds / hour
  if (Math.abs(hours - 5) <= 0.5) return "5h"
  if (Math.abs(hours - 24 * 7) <= 12) return "weekly"
  return fallback
}

export function countdownLabel(resetsAt: number, now = Date.now()) {
  let seconds = Math.max(0, Math.floor(resetsAt - now / 1000))
  if (seconds === 0) return "due"
  const days = Math.floor(seconds / day)
  seconds %= day
  const hours = Math.floor(seconds / hour)
  seconds %= hour
  const minutes = Math.max(days || hours ? 0 : 1, Math.floor(seconds / minute))
  if (days) return `${days}d${hours ? `${hours}h` : ""}`
  if (hours) return `${hours}h${minutes ? `${minutes}m` : ""}`
  return `${minutes}m`
}

export function formatWindow(window: UsageWindow, fallback: string, now = Date.now()) {
  return `${durationLabel(window.windowSeconds, fallback)} ${remainingPercent(window)}% left (${countdownLabel(window.resetsAt, now)})`
}

export function formatCompactWindow(window: UsageWindow, fallback: string, now = Date.now()) {
  const label =
    durationLabel(window.windowSeconds, fallback) === "weekly" ? "wk" : durationLabel(window.windowSeconds, fallback)
  return `${label} ${remainingPercent(window)}% (${countdownLabel(window.resetsAt, now)})`
}

export function resetCountLabel(count: number) {
  return `${count} ${count === 1 ? "reset" : "resets"} banked`
}

export function resetExpiryLabel(credit: ResetCredit, locale?: string) {
  if (credit.expiresAt === undefined) return "Does not expire"
  return `Expires ${new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(credit.expiresAt * 1000))}`
}

export function availableCredits(input: ResetCredit[] | undefined, availableCount: number) {
  return (input ?? [])
    .filter((credit) => credit.status === "available")
    .sort((a, b) => (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER))
    .slice(0, Math.max(0, availableCount))
}

export function bucketLabel(bucket: UsageBucket) {
  return bucket.name || (bucket.id === "codex" ? "Codex" : bucket.id)
}

export function formatBucket(bucket: UsageBucket, now = Date.now()) {
  const windows = [
    bucket.primary && formatWindow(bucket.primary, "primary", now),
    bucket.secondary && formatWindow(bucket.secondary, "secondary", now),
  ].filter(Boolean)
  return `${bucketLabel(bucket)}: ${windows.join(" · ") || "Window usage unavailable"}${bucket.allowed === false ? " · limit reached" : ""}`
}

export function snapshotText(snapshot: CodexSnapshot, now = Date.now()) {
  const credits = snapshot.resets
  return [
    ...(snapshot.usage.planType ? [`Plan: ${snapshot.usage.planType}`] : []),
    ...snapshot.usage.buckets.map((bucket) => formatBucket(bucket, now)),
    credits ? resetCountLabel(credits.availableCount) : (snapshot.resetError ?? "Reset availability unavailable"),
  ].join("\n")
}
