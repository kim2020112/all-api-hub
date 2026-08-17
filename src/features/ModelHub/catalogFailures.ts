export interface ModelCatalogFailure {
  sourceType: "account" | "profile"
  sourceId: string
  sourceName: string
  baseUrl?: string
  stage: "models" | "pricing" | "groups"
  message: string
  failedAt: number
}

export function dedupeModelCatalogFailures(
  failures: readonly ModelCatalogFailure[],
) {
  const latest = new Map<string, ModelCatalogFailure>()
  for (const failure of failures) {
    const key = `${failure.sourceType}:${failure.sourceId}`
    const previous = latest.get(key)
    if (!previous || previous.failedAt <= failure.failedAt) {
      latest.set(key, failure)
    }
  }
  return Array.from(latest.values()).sort(
    (left, right) => right.failedAt - left.failedAt,
  )
}
