/* eslint-disable jsdoc/require-jsdoc */

import type { ModelListSourceIdentity } from "../ModelList/modelManagementSources"
import {
  normalizeModelHubModelName,
  type FavoriteModel,
  type ModelHubBillingUnit,
  type ModelHubManualSource,
  type ModelHubModelType,
} from "./storage"

export interface AccountOfferingProjection {
  id: string
  sourceType: "account"
  accountId: string
  sourceId: string
  sourceIdentity?: ModelListSourceIdentity
  tokenId?: number
  modelName: string
  normalizedName: string
  type: ModelHubModelType
  providerName: string
  groupName: string
  groupIsFallback?: boolean
  groupDescription?: string
  groupRatio: number | null
  balanceUsd: number | null
  balanceKnown?: boolean
  updatedAt: number
}

export interface ManualOfferingProjection {
  id: string
  sourceType: "manual"
  manualSourceId: string
  profileId: string
  modelName: string
  normalizedName: string
  type: ModelHubModelType
  providerName: string
  groupName: string
  groupDescription?: string
  baseUrl: string
  groupRatio: number | null
  balanceUsd: number | null
  priceUsd?: number
  billingUnit?: ModelHubBillingUnit
  updatedAt: number
}

export type AllModelRow = AccountOfferingProjection | ManualOfferingProjection

export interface AggregatedModelCatalogRow {
  id: string
  modelName: string
  normalizedName: string
  type: ModelHubModelType
  accountSourceCount: number
  manualSourceCount: number
  providerCount: number
  groupCount: number
  lowestPriceUsd: number | null
  updatedAt: number
  offerings: AllModelRow[]
}

const identityPart = (value: string) =>
  encodeURIComponent(value.trim().toLowerCase().replace(/\s+/g, " "))

export function projectManualSourceOfferings(
  sources: readonly ModelHubManualSource[],
): ManualOfferingProjection[] {
  const rows = new Map<string, ManualOfferingProjection>()
  for (const source of sources) {
    for (const model of source.models) {
      const normalizedName = normalizeModelHubModelName(model.modelName)
      const id = `manual:${identityPart(source.id)}:${identityPart(source.groupName)}:${identityPart(normalizedName)}`
      if (rows.has(id)) continue
      rows.set(id, {
        id,
        sourceType: "manual",
        manualSourceId: source.id,
        profileId: source.profileId,
        modelName: model.modelName,
        normalizedName,
        type: model.type,
        providerName: source.name,
        groupName: source.groupName,
        ...(source.groupDescription
          ? { groupDescription: source.groupDescription }
          : {}),
        baseUrl: source.normalizedBaseUrl,
        groupRatio: source.groupRatio ?? null,
        balanceUsd: source.balanceUsd ?? null,
        ...(model.priceUsd !== undefined ? { priceUsd: model.priceUsd } : {}),
        ...(model.billingUnit ? { billingUnit: model.billingUnit } : {}),
        updatedAt: source.updatedAt,
      })
    }
  }
  return [...rows.values()]
}

export function buildAllModelRows(
  accountOfferings: readonly AccountOfferingProjection[],
  manualSources: readonly ModelHubManualSource[],
): AllModelRow[] {
  return [...accountOfferings, ...projectManualSourceOfferings(manualSources)]
}

export function aggregateModelCatalogRows(
  rows: readonly AllModelRow[],
  resolvePriceUsd: (row: AllModelRow) => number | null,
): AggregatedModelCatalogRow[] {
  const grouped = new Map<string, AllModelRow[]>()
  for (const row of rows) {
    const current = grouped.get(row.normalizedName) ?? []
    current.push(row)
    grouped.set(row.normalizedName, current)
  }

  return [...grouped.entries()].map(([normalizedName, offerings]) => {
    const providers = new Set(
      offerings.map((row) => `${row.sourceType}:${row.providerName}`),
    )
    const groups = new Set(
      offerings.map(
        (row) => `${row.sourceType}:${row.providerName}:${row.groupName}`,
      ),
    )
    const prices = offerings
      .map(resolvePriceUsd)
      .filter(
        (value): value is number => value !== null && Number.isFinite(value),
      )

    return {
      id: `model:${identityPart(normalizedName)}`,
      modelName: offerings[0]?.modelName ?? normalizedName,
      normalizedName,
      type: offerings[0]?.type ?? "other",
      accountSourceCount: new Set(
        offerings
          .filter((row) => row.sourceType === "account")
          .map((row) => row.accountId),
      ).size,
      manualSourceCount: new Set(
        offerings
          .filter((row) => row.sourceType === "manual")
          .map((row) => row.manualSourceId),
      ).size,
      providerCount: providers.size,
      groupCount: groups.size,
      lowestPriceUsd: prices.length ? Math.min(...prices) : null,
      updatedAt: Math.max(0, ...offerings.map((row) => row.updatedAt)),
      offerings,
    }
  })
}

export function buildFavoriteAccountCandidates<
  T extends AccountOfferingProjection,
>(accountOfferings: readonly T[], favorites: readonly FavoriteModel[]): T[] {
  const names = new Set(favorites.map((favorite) => favorite.normalizedName))
  return accountOfferings.filter((row) => names.has(row.normalizedName))
}

export function filterAllModelRows(
  rows: readonly AllModelRow[],
  filters: {
    search: string
    source: "all" | "account" | "manual"
    type: "all" | ModelHubModelType
  },
) {
  const query = filters.search.trim().toLowerCase()
  return rows.filter((row) => {
    if (filters.source !== "all" && row.sourceType !== filters.source)
      return false
    if (filters.type !== "all" && row.type !== filters.type) return false
    return (
      !query ||
      row.modelName.toLowerCase().includes(query) ||
      row.providerName.toLowerCase().includes(query) ||
      row.groupName.toLowerCase().includes(query)
    )
  })
}
