export function normalizeOfferingIdentityPart(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

export function createModelHubOfferingKey(params: {
  sourceType: "account" | "profile"
  stableSourceId: string
  modelName: string
  groupName: string
}) {
  return [
    params.sourceType,
    params.stableSourceId,
    normalizeOfferingIdentityPart(params.modelName),
    normalizeOfferingIdentityPart(params.groupName),
  ]
    .map(encodeURIComponent)
    .join(":")
}

export function createModelHubGroupKey(params: {
  sourceType: "account" | "profile"
  stableSourceId: string
  groupName: string
}) {
  return [
    params.sourceType,
    params.stableSourceId,
    normalizeOfferingIdentityPart(params.groupName),
  ]
    .map(encodeURIComponent)
    .join(":")
}

function validRatio(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null
}

export function resolveEffectiveGroupRatio(params: {
  manualGroupRatio?: number | null
  automaticGroupRatio?: number | null
}) {
  return (
    validRatio(params.manualGroupRatio) ??
    validRatio(params.automaticGroupRatio)
  )
}
