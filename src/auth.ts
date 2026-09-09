import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { xdgData } from "xdg-basedir"
import type { AccountRef, OAuthCredential } from "./types"

export class AuthUnavailableError extends Error {
  constructor(message = "OpenAI ChatGPT OAuth is not connected") {
    super(message)
    this.name = "AuthUnavailableError"
  }
}

export class AuthExpiredError extends Error {
  constructor() {
    super(
      "ChatGPT is connected, but its access token expired. Send a request through OpenCode to refresh it, then try again.",
    )
    this.name = "AuthExpiredError"
  }
}

export class AccountChangedError extends Error {
  constructor() {
    super("The ChatGPT account changed. Reopen usage and confirm a reset for the current account.")
    this.name = "AccountChangedError"
  }
}

export function defaultAuthPath() {
  const data = xdgData ?? path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "auth.json")
}

function parseCredential(value: unknown): OAuthCredential | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (input.type !== "oauth") return
  if (typeof input.access !== "string" || typeof input.refresh !== "string" || typeof input.expires !== "number") {
    return
  }
  if (!Number.isFinite(input.expires) || input.expires < 0) return
  return {
    type: "oauth",
    access: input.access,
    refresh: input.refresh,
    expires: input.expires,
    ...(typeof input.accountId === "string" ? { accountId: input.accountId } : {}),
  }
}

export function parseOpenAIAuth(value: unknown): OAuthCredential | undefined {
  if (!value || typeof value !== "object") return
  return parseCredential((value as Record<string, unknown>).openai)
}

export async function readOpenAIAuth(
  input: {
    authPath?: string
    authContent?: string
  } = {},
): Promise<OAuthCredential> {
  let raw: unknown
  const content = input.authContent ?? process.env.OPENCODE_AUTH_CONTENT
  try {
    raw = JSON.parse(content ?? (await readFile(input.authPath ?? defaultAuthPath(), "utf8")))
  } catch {
    throw new AuthUnavailableError()
  }

  const auth = parseOpenAIAuth(raw)
  if (!auth) throw new AuthUnavailableError()
  return auth
}

export async function loadOpenAIAuth(input: Parameters<typeof readOpenAIAuth>[0] & { now?: number } = {}) {
  const auth = await readOpenAIAuth(input)
  if (!auth.access || auth.expires <= (input.now ?? Date.now())) throw new AuthExpiredError()
  return auth
}

export function accountRef(auth: OAuthCredential): AccountRef {
  let claims: Record<string, unknown> = {}
  try {
    claims = JSON.parse(Buffer.from(auth.access.split(".")[1] ?? "", "base64url").toString()) ?? {}
  } catch {
    // Older credentials without identity claims are invalidated on every token change.
  }
  const details = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined
  const user = details?.chatgpt_user_id ?? claims.sub
  const account = auth.accountId || details?.chatgpt_account_id || claims.chatgpt_account_id
  const identity =
    typeof user === "string" && typeof account === "string"
      ? JSON.stringify([account, user])
      : JSON.stringify([auth.accountId ?? "", auth.access])
  return {
    key: createHash("sha256").update(identity).digest("hex"),
    label: typeof account === "string" && account ? `ChatGPT account …${account.slice(-6)}` : "ChatGPT account",
  }
}

export function authHeaders(auth: OAuthCredential) {
  const headers = new Headers({
    authorization: `Bearer ${auth.access}`,
    accept: "application/json",
  })
  if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)
  return headers
}
