/** Minimal shape required by business-key dedup. */
interface DedupeableOffering {
  id: string
  sourceType: "account" | "profile"
  sourceId: string
  accountId?: string
  modelName: string
  groupName: string
  multiplier: number | null
  balanceUsd: number | null
  lastSyncTime?: number
  model?: { model_name: string } | null
}

function normalizeForDedup(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

function createBusinessKey(row: DedupeableOffering): string {
  const identity =
    row.sourceType === "account" ? row.accountId ?? row.sourceId : row.sourceId
  return [
    row.sourceType,
    identity,
    normalizeForDedup(row.modelName),
    normalizeForDedup(row.groupName),
  ]
    .map((v) => encodeURIComponent(v))
    .join(":")
}

/**
 * Scores a row for winner selection.
 * Higher score = better candidate to keep.
 * Priority: has price model > has multiplier > has balance > newer lastSyncTime.
 */
function compareRows(left: DedupeableOffering, right: DedupeableOffering) {
  const leftHasPrice = Boolean(left.model)
  const rightHasPrice = Boolean(right.model)
  if (leftHasPrice !== rightHasPrice) return leftHasPrice ? 1 : -1
  const leftHasMultiplier = left.multiplier !== null
  const rightHasMultiplier = right.multiplier !== null
  if (leftHasMultiplier !== rightHasMultiplier)
    return leftHasMultiplier ? 1 : -1
  const leftHasBalance = left.balanceUsd !== null
  const rightHasBalance = right.balanceUsd !== null
  if (leftHasBalance !== rightHasBalance) return leftHasBalance ? 1 : -1
  const syncDifference = (left.lastSyncTime ?? 0) - (right.lastSyncTime ?? 0)
  if (syncDifference !== 0) return syncDifference
  return right.id.localeCompare(left.id)
}

/**
 * Deduplicates offering rows by business identity.
 *
 * Business key = sourceType + stable account/profile id + normalizedModelName + normalizedGroupName.
 * For accounts with multiple tokens/identities, accountId is the stable account id,
 * while sourceId varies per token — so business key collapses them.
 *
 * Winner selection: has price model > has multiplier > has balance > newer lastSyncTime > stable id.
 */
export function dedupeOfferingsByBusinessKey<T extends DedupeableOffering>(
  rows: readonly T[],
): T[] {
  const byKey = new Map<string, T>()

  for (const row of rows) {
    const key = createBusinessKey(row)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, row)
      continue
    }

    if (compareRows(row, existing) > 0) {
      byKey.set(key, row)
    }
  }

  return Array.from(byKey.values())
}
