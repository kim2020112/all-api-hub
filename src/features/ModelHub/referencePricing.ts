import type { ProductCanonicalModel } from "~/services/modelList/pricingModel"

export interface TextPriceReferenceCandidate {
  sourceId: string
  normalizedName: string
  groupRatio: number | null
  model: ProductCanonicalModel
  resolvedInputUsd: number | null
}

export interface TextPriceReference {
  inputUsdPerMillionAt1x: number
  outputUsdPerMillionAt1x: number
  sampleCount: number
}

interface ReferenceCandidate {
  input: number
  output: number
}

function selectConsensus(values: readonly ReferenceCandidate[]) {
  const buckets = new Map<
    string,
    { count: number; input: number; output: number }
  >()
  for (const value of values) {
    const key = value.input.toFixed(4)
    const current = buckets.get(key) ?? {
      count: 0,
      input: value.input,
      output: value.output,
    }
    current.count += 1
    current.output = value.output
    buckets.set(key, current)
  }
  return [...buckets.values()].sort(
    (left, right) => right.count - left.count || left.input - right.input,
  )[0]
}

export function buildTextPriceReferenceIndex(
  candidates: readonly TextPriceReferenceCandidate[],
) {
  const groupedBySource = new Map<string, ReferenceCandidate[]>()
  for (const candidate of candidates) {
    if (candidate.model.quota_type !== 0) continue
    const ratio = candidate.groupRatio
    const hasResolvedBase =
      typeof candidate.resolvedInputUsd === "number" &&
      candidate.resolvedInputUsd > 0 &&
      typeof ratio === "number" &&
      ratio > 0
    const input = hasResolvedBase
      ? candidate.resolvedInputUsd! / ratio!
      : candidate.model.model_ratio * 2
    const output = input * candidate.model.completion_ratio
    if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output)) {
      continue
    }
    const sourceKey = `${candidate.normalizedName}:${candidate.sourceId}`
    const values = groupedBySource.get(sourceKey) ?? []
    values.push({ input, output })
    groupedBySource.set(sourceKey, values)
  }

  const grouped = new Map<string, ReferenceCandidate[]>()
  for (const [sourceKey, values] of groupedBySource) {
    const selected = selectConsensus(values)
    if (!selected) continue
    const separatorIndex = sourceKey.lastIndexOf(":")
    const name = sourceKey.slice(0, separatorIndex)
    const sourceValues = grouped.get(name) ?? []
    sourceValues.push(selected)
    grouped.set(name, sourceValues)
  }

  const result = new Map<string, TextPriceReference>()
  for (const [name, values] of grouped) {
    const selected = selectConsensus(values)
    if (selected) {
      result.set(name, {
        inputUsdPerMillionAt1x: selected.input,
        outputUsdPerMillionAt1x: selected.output,
        sampleCount: selected.count,
      })
    }
  }
  return result
}

export function createReferenceEstimatedPrice(
  reference: TextPriceReference,
  groupRatio: number,
) {
  return {
    inputUsd: reference.inputUsdPerMillionAt1x * groupRatio,
    outputUsd: reference.outputUsdPerMillionAt1x * groupRatio,
  }
}
