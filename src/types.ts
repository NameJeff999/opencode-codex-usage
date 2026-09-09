export type OAuthCredential = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
}

/** A non-secret fingerprint. Never retain access/refresh tokens in UI or tool state. */
export type AccountRef = { key: string; label: string }

export type AccountState =
  | { status: "disconnected"; message: string }
  | { status: "ready"; account: AccountRef }
  | { status: "expired"; account: AccountRef }

export type UsageWindow = {
  usedPercent: number
  windowSeconds: number
  resetsAt: number
}

export type UsageBucket = {
  id: string
  name?: string
  modelSlug?: string
  allowed?: boolean
  primary?: UsageWindow
  secondary?: UsageWindow
}

export type CodexUsage = {
  planType?: string
  buckets: UsageBucket[]
  availableResets?: number
}

export type ResetCreditStatus = "available" | "redeeming" | "redeemed" | "unknown"

export type ResetCredit = {
  id: string
  resetType: string
  status: ResetCreditStatus
  grantedAt: number
  expiresAt?: number
  title?: string
  description?: string
}

export type ResetCredits = {
  availableCount: number
  /** Absent when only the compact usage summary is available. */
  credits?: ResetCredit[]
}

export type ConsumeOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"

export type ResetAttempt = {
  accountKey: string
  idempotencyKey: string
  creditId?: string
}

export type CodexSnapshot = {
  usage: CodexUsage
  resets?: ResetCredits
  resetError?: string
}
