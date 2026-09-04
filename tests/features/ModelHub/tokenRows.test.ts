import { describe, expect, it } from "vitest"

import {
  createTokenBoundOfferingId,
  findCompatibleOfferingTokens,
  resolveTokenBoundGroupName,
} from "~/features/ModelHub/tokenRows"
import type { AccountToken } from "~/types"

const token = (id: number, group: string): AccountToken =>
  ({
    id,
    accountId: "account-1",
    accountName: "Example",
    group,
    status: 1,
    model_limits_enabled: false,
    model_limits: "",
  }) as AccountToken

describe("Model Hub token rows", () => {
  it("treats an explicit default group as a real group", () => {
    const matches = findCompatibleOfferingTokens(
      [token(1, "default"), token(2, "vip")],
      {
        groupName: "default",
        modelName: "gpt-5.6-sol",
      },
    )

    expect(matches.map((item) => item.id)).toEqual([1])
  })

  it("uses token groups when catalog group metadata is unavailable", () => {
    const tokens = [token(1, "default"), token(2, "vip")]
    const matches = findCompatibleOfferingTokens(tokens, {
      groupName: "默认分组",
      groupIsFallback: true,
      modelName: "gpt-5.6-sol",
    })

    expect(matches.map((item) => item.id)).toEqual([1, 2])
    expect(
      matches.map((item) =>
        resolveTokenBoundGroupName(
          { groupName: "默认分组", groupIsFallback: true },
          item,
        ),
      ),
    ).toEqual(["default", "vip"])
  })

  it("keeps token-bound row identities independent", () => {
    expect(createTokenBoundOfferingId("offering", 1)).not.toBe(
      createTokenBoundOfferingId("offering", 2),
    )
  })
})
