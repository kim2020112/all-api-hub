import { describe, expect, it } from "vitest"

import { dedupeOfferingsByBusinessKey } from "~/features/ModelHub/dedupe"

describe("dedupeOfferingsByBusinessKey", () => {
  const createRow = (overrides: Record<string, unknown> = {}) => ({
    id: "row-a",
    sourceType: "account" as const,
    sourceId: "rotating-token-id",
    accountId: "stable-account-id",
    modelName: "gpt-4.1",
    groupName: "VIP",
    multiplier: null,
    balanceUsd: null,
    ...overrides,
  })

  it("merges duplicates for the same account, model, and group", () => {
    const first = createRow({ id: "a" })
    const duplicate = createRow({ id: "b", sourceId: "another-token-id" })

    expect(dedupeOfferingsByBusinessKey([first, duplicate])).toEqual([first])
  })

  it("normalizes group whitespace and casing in the business key", () => {
    const first = createRow({ id: "a", groupName: " VIP  Group " })
    const duplicate = createRow({ id: "b", groupName: "vip group" })

    expect(dedupeOfferingsByBusinessKey([first, duplicate])).toEqual([first])
  })

  it("keeps the most complete row using the documented winner order", () => {
    const balanceOnly = createRow({
      id: "z",
      balanceUsd: 10,
      lastSyncTime: 100,
    })
    const multiplier = createRow({ id: "y", multiplier: 0.5 })
    const priced = createRow({ id: "x", model: { model_name: "gpt-4.1" } })

    expect(
      dedupeOfferingsByBusinessKey([balanceOnly, multiplier, priced]),
    ).toEqual([priced])
  })
})
