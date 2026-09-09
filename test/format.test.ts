import { describe, expect, test } from "bun:test"
import { availableCredits, countdownLabel, formatWindow, remainingPercent, resetCountLabel } from "../src/format"

describe("usage formatting", () => {
  test("formats remaining usage and reset time", () => {
    const now = Date.UTC(2026, 6, 27, 12, 0, 0)
    const window = { usedPercent: 12.4, windowSeconds: 18_000, resetsAt: now / 1_000 + 7_500 }
    expect(remainingPercent(window)).toBe(88)
    expect(countdownLabel(window.resetsAt, now)).toBe("2h5m")
    expect(formatWindow(window, "usage", now)).toBe("5h 88% left (2h5m)")
  })

  test("uses singular and plural reset labels", () => {
    expect(resetCountLabel(1)).toBe("1 reset banked")
    expect(resetCountLabel(3)).toBe("3 resets banked")
  })
})

test("available credits are expiration ordered with non-expiring credits last", () => {
  const base = { resetType: "full", status: "available" as const, grantedAt: 1 }
  expect(
    availableCredits(
      [
        { ...base, id: "never" },
        { ...base, id: "later", expiresAt: 300 },
        { ...base, id: "used", status: "redeemed", expiresAt: 50 },
        { ...base, id: "first", expiresAt: 100 },
      ],
      3,
    ).map((credit) => credit.id),
  ).toEqual(["first", "later", "never"])
})
