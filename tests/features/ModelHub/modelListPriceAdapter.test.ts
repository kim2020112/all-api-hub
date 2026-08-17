import { describe, expect, it } from "vitest"

import { adaptModelListPrice } from "~/features/ModelHub/modelListPriceAdapter"
import { resolveModelHubPrice } from "~/features/ModelHub/price"
import type { ProductCanonicalModel } from "~/services/modelList/pricingModel"

describe("adaptModelListPrice", () => {
  const model: ProductCanonicalModel = {
    model_name: "gpt-5.6-sol",
    quota_type: 0,
    model_ratio: 2.5,
    model_price: 0,
    completion_ratio: 6,
    enable_groups: ["default", "gpt plus"],
    supported_endpoint_types: [],
  }

  it("uses Model List's ratio formula for the concrete group", () => {
    expect(adaptModelListPrice(model, 0.1)).toMatchObject({
      inputUsd: 0.5,
      outputUsd: 3,
    })
  })

  it("does not reuse the best group price for another group", () => {
    expect(adaptModelListPrice(model, 0.4)?.inputUsd).toBe(2)
  })

  it("allows the offering-level manual model multiplier", () => {
    expect(adaptModelListPrice(model, 0.1, 2)?.inputUsd).toBe(0.4)
  })

  it("treats account ratio pricing as authoritative when legacy responses omit metadata", () => {
    expect(resolveModelHubPrice({ model, groupMultiplier: 0.1 })).toMatchObject(
      {
        primaryText: "$0.5000",
        unitText: "/M",
        usdAmount: 0.5,
        status: "exact",
        isEstimated: false,
        inputUsd: 0.5,
        outputUsd: 3,
      },
    )
  })

  it("shows only manual input price while retaining output detail", () => {
    expect(
      resolveModelHubPrice({
        model,
        groupMultiplier: 0.1,
        override: {
          aliases: [],
          manualMultiplier: null,
          manualInputPriceUsd: 0.4,
          manualOutputPriceUsd: 2.4,
          manualBillingUnit: "token-million",
          tags: [],
          note: "",
          updatedAt: 1,
        },
      }),
    ).toMatchObject({ primaryText: "$0.4000", inputUsd: 0.4, outputUsd: 2.4 })
  })
})
