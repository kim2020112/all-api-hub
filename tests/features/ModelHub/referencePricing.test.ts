import { describe, expect, it } from "vitest"

import {
  buildTextPriceReferenceIndex,
  createReferenceEstimatedPrice,
} from "~/features/ModelHub/referencePricing"
import {
  MODEL_PRICE_PRECISION_KINDS,
  MODEL_PRICE_SOURCE_KINDS,
  type ModelPricePrecisionKind,
  type ProductCanonicalModel,
} from "~/services/modelList/pricingModel"

const model = (
  ratio: number,
  precision: ModelPricePrecisionKind = MODEL_PRICE_PRECISION_KINDS.ESTIMATED,
): ProductCanonicalModel => ({
  model_name: "gpt-5.6-sol",
  quota_type: 0,
  model_ratio: ratio,
  model_price: 0,
  completion_ratio: 4,
  enable_groups: ["default"],
  supported_endpoint_types: [],
  price_metadata: {
    source: MODEL_PRICE_SOURCE_KINDS.OFFICIAL_RATE_ESTIMATE,
    precision,
  },
})

describe("Model Hub text reference pricing", () => {
  it("prefers an exact normalized base over an anomalous first ratio", () => {
    const index = buildTextPriceReferenceIndex([
      {
        sourceId: "noisy-provider",
        normalizedName: "gpt-5.6-sol",
        groupRatio: 0.5,
        model: model(37.5),
        resolvedInputUsd: 37.5,
      },
      {
        sourceId: "trusted-provider",
        normalizedName: "gpt-5.6-sol",
        groupRatio: 1,
        model: model(2.5, MODEL_PRICE_PRECISION_KINDS.EXACT),
        resolvedInputUsd: 5,
      },
    ])
    const reference = index.get("gpt-5.6-sol")!
    expect(reference.inputUsdPerMillionAt1x).toBe(5)
    expect(createReferenceEstimatedPrice(reference, 0.15).inputUsd).toBe(0.75)
  })

  it("gives each account one vote when one account exposes many anomalous groups", () => {
    const candidates = [
      ...Array.from({ length: 4 }, () => ({
        sourceId: "noisy-provider",
        normalizedName: "gpt-5.6-sol",
        groupRatio: 0.5,
        model: model(37.5, MODEL_PRICE_PRECISION_KINDS.EXACT),
        resolvedInputUsd: 37.5,
      })),
      ...["dasu", "sevnx", "uselunora"].map((sourceId) => ({
        sourceId,
        normalizedName: "gpt-5.6-sol",
        groupRatio: 0.1,
        model: model(2.5),
        resolvedInputUsd: 0.5,
      })),
    ]
    const reference =
      buildTextPriceReferenceIndex(candidates).get("gpt-5.6-sol")!
    expect(reference.inputUsdPerMillionAt1x).toBe(5)
    expect(createReferenceEstimatedPrice(reference, 0.15).inputUsd).toBe(0.75)
  })
})
