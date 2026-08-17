import { describe, expect, it } from "vitest"

import { dedupeModelCatalogFailures } from "~/features/ModelHub/catalogFailures"

describe("dedupeModelCatalogFailures", () => {
  it("keeps the newest failure for each source", () => {
    const failures = dedupeModelCatalogFailures([
      {
        sourceType: "account",
        sourceId: "a",
        sourceName: "A",
        stage: "models",
        message: "old",
        failedAt: 1,
      },
      {
        sourceType: "account",
        sourceId: "a",
        sourceName: "A",
        stage: "pricing",
        message: "new",
        failedAt: 2,
      },
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toBe("new")
  })
})
