import type { ProductCanonicalModel } from "~/services/modelList/pricingModel"
import { calculateModelPrice } from "~/services/models/utils/modelPricing"

export interface ModelHubAdaptedPrice {
  inputUsd?: number
  outputUsd?: number
  cacheReadUsd?: number
  cacheWriteUsd?: number
  perCallUsd?: number
}

/** Applies Model List's canonical pricing formula to one concrete group offering. */
export function adaptModelListPrice(
  model: ProductCanonicalModel,
  groupMultiplier: number,
  modelMultiplierOverride?: number | null,
): ModelHubAdaptedPrice | null {
  const pricedModel =
    typeof modelMultiplierOverride === "number" &&
    Number.isFinite(modelMultiplierOverride) &&
    modelMultiplierOverride > 0
      ? { ...model, model_ratio: modelMultiplierOverride }
      : model
  const calculated = calculateModelPrice(pricedModel, groupMultiplier)
  if (calculated.kind === "unavailable") return null
  if (calculated.kind === "token") {
    const prices = calculated.usdPerMillionTokens
    return {
      inputUsd: prices.input,
      outputUsd: prices.output,
      ...(prices.cacheRead !== undefined
        ? { cacheReadUsd: prices.cacheRead }
        : {}),
      ...(prices.cacheWrite !== undefined
        ? { cacheWriteUsd: prices.cacheWrite }
        : {}),
    }
  }

  const price = calculated.usdPerCall
  return {
    perCallUsd:
      typeof price === "number" ? price : Math.max(price.input, price.output),
  }
}
