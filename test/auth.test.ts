import { expect, test } from "bun:test"
import { AuthExpiredError, AuthUnavailableError, accountRef, loadOpenAIAuth, readOpenAIAuth } from "../src/auth"
import { credential } from "./fixtures"

test("loads the ordinary OpenCode OAuth credential shape", async () => {
  const auth = credential()
  expect(await loadOpenAIAuth({ authContent: JSON.stringify({ openai: auth }) })).toEqual(auth)
})

test("distinguishes missing login from connected but expired credentials", async () => {
  await expect(loadOpenAIAuth({ authContent: "{}" })).rejects.toBeInstanceOf(AuthUnavailableError)
  const expired = credential("account-A", 1)
  expect(await readOpenAIAuth({ authContent: JSON.stringify({ openai: expired }) })).toEqual(expired)
  await expect(loadOpenAIAuth({ authContent: JSON.stringify({ openai: expired }) })).rejects.toBeInstanceOf(
    AuthExpiredError,
  )
})

test("identity survives token refresh but changes for a different account or user", () => {
  const auth = credential()
  const renewed = { ...auth, access: auth.access.replace("signature", "renewed-signature"), refresh: "new-refresh" }
  expect(accountRef(renewed)).toEqual(accountRef(auth))
  expect(accountRef(credential("account-B")).key).not.toBe(accountRef(auth).key)
  const otherUser = Buffer.from(JSON.stringify({ sub: "user-2" })).toString("base64url")
  expect(accountRef({ ...auth, access: `test.${otherUser}.signature` }).key).not.toBe(accountRef(auth).key)
  expect(JSON.stringify(accountRef(auth))).not.toContain(auth.access)
})

test("credentials without usable identity claims are conservatively invalidated on token change", () => {
  const auth = { ...credential(), access: "opaque-token" }
  expect(accountRef({ ...auth, access: "new-opaque-token" }).key).not.toBe(accountRef(auth).key)
})
