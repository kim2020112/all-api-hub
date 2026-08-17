import { describe, expect, it } from "vitest"

import {
  createModelHubGroupKey,
  createModelHubOfferingKey,
  resolveEffectiveGroupRatio,
} from "~/features/ModelHub/offeringIdentity"

describe("Model Hub offering identity and group ratio", () => {
  it("prefers manual group ratio and never falls back to model ratio", () => {
    expect(
      resolveEffectiveGroupRatio({
        manualGroupRatio: 0.2,
        automaticGroupRatio: 0.1,
      }),
    ).toBe(0.2)
    expect(resolveEffectiveGroupRatio({ automaticGroupRatio: null })).toBeNull()
  })

  it("keeps group and offering keys distinct and stable", () => {
    expect(
      createModelHubGroupKey({
        sourceType: "account",
        stableSourceId: "a",
        groupName: " Default ",
      }),
    ).toBe("account:a:default")
    expect(
      createModelHubOfferingKey({
        sourceType: "account",
        stableSourceId: "a",
        modelName: "GPT 5",
        groupName: " Default ",
      }),
    ).toBe("account:a:gpt%205:default")
  })
})
