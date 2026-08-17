import { Storage } from "@plasmohq/storage"

import {
  MODEL_HUB_STORAGE_KEYS,
  STORAGE_LOCKS,
} from "~/services/core/storageKeys"
import { withExtensionStorageWriteLock } from "~/services/core/storageWriteLock"

export type ModelHubBillingUnit =
  | "token-million"
  | "image"
  | "video-second"
  | "video-minute"
  | "request"
  | "unknown"

export interface ModelHubManualOverride {
  aliases: string[]
  manualMultiplier: number | null
  /** Manual balance snapshot for an offering when automatic balance data is unavailable or incorrect. */
  manualBalanceUsd?: number | null
  /** Manual price in the override's declared billing unit and currency (USD). */
  manualPriceUsd?: number | null
  manualBillingUnit?: ModelHubBillingUnit | null
  /** Optional manual per-token (1M tokens) input/output prices in USD. */
  manualInputPriceUsd?: number | null
  manualOutputPriceUsd?: number | null
  manualCurrency?: "USD" | "CNY" | null
  manualPriceNote?: string
  tags: string[]
  note: string
  updatedAt: number
}

export type ModelHubManualOverrideStore = Record<string, ModelHubManualOverride>

export function createModelHubGroupOverrideKey(
  accountId: string,
  groupName: string,
) {
  return `group:${encodeURIComponent(accountId)}:${encodeURIComponent(normalizeModelHubModelName(groupName))}`
}

export function createEmptyModelHubManualOverride(): Omit<
  ModelHubManualOverride,
  "updatedAt"
> {
  return {
    aliases: [],
    manualMultiplier: null,
    tags: [],
    note: "",
  }
}

export type ModelHubViewMode = "favorites" | "all"
export type ModelHubSortMode =
  | "name"
  | "multiplier-asc"
  | "multiplier-desc"
  | "balance-desc"
  | "price-asc"
  | "price-desc"
export type ModelHubModelType = "text" | "image" | "video" | "other"

export interface FavoriteModel {
  modelName: string
  normalizedName: string
  type: ModelHubModelType
}

export interface ModelHubPreferences {
  viewMode: ModelHubViewMode
  sortMode: ModelHubSortMode
  favoriteModels: FavoriteModel[]
  selectedTargetModel?: string
}

export interface ModelHubBenchmarkResult {
  status: "success" | "failed"
  testedAt: number
  responseHeadersMs?: number
  firstEventMs?: number
  firstTokenMs?: number
  totalDurationMs?: number
  generationDurationMs?: number
  completionTokens?: number
  tokenCountSource?: "usage" | "estimated"
  overallTokensPerSecond?: number
  generationTokensPerSecond?: number
  errorSummary?: string
}

export type ModelHubBenchmarkResultStore = Record<
  string,
  ModelHubBenchmarkResult
>

const storage = new Storage({ area: "local" })
export const MODEL_HUB_BENCHMARK_STORAGE_KEY = "model_hub_benchmark_results_v1"
export const MODEL_HUB_MANUAL_SOURCES_STORAGE_KEY =
  "model_hub_manual_sources_v1"

export interface ModelHubManualSourceModel {
  modelName: string
  normalizedName: string
  type: ModelHubModelType
  priceUsd?: number
  billingUnit?: ModelHubBillingUnit
}
export interface ModelHubManualSource {
  id: string
  profileId: string
  name: string
  normalizedBaseUrl: string
  groupName: string
  groupDescription?: string
  groupRatio?: number
  balanceUsd?: number
  models: ModelHubManualSourceModel[]
  createdAt: number
  updatedAt: number
}
export type ModelHubManualSourceStore = Record<string, ModelHubManualSource>

function normalizeOverride(value: unknown): ModelHubManualOverride | null {
  if (!value || typeof value !== "object") return null

  const raw = value as Partial<ModelHubManualOverride>
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.filter((item): item is string => typeof item === "string")
    : []
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((item): item is string => typeof item === "string")
    : []
  const manualMultiplier =
    typeof raw.manualMultiplier === "number" &&
    Number.isFinite(raw.manualMultiplier) &&
    raw.manualMultiplier >= 0
      ? raw.manualMultiplier
      : null
  const manualBalanceUsd =
    typeof raw.manualBalanceUsd === "number" &&
    Number.isFinite(raw.manualBalanceUsd) &&
    raw.manualBalanceUsd >= 0
      ? raw.manualBalanceUsd
      : null
  const manualBillingUnit =
    typeof raw.manualBillingUnit === "string" &&
    (raw.manualBillingUnit === "token-million" ||
      raw.manualBillingUnit === "image" ||
      raw.manualBillingUnit === "video-second" ||
      raw.manualBillingUnit === "video-minute" ||
      raw.manualBillingUnit === "request")
      ? raw.manualBillingUnit
      : null

  return {
    aliases: aliases.map((item) => item.trim()).filter(Boolean),
    manualMultiplier,
    ...(manualBalanceUsd !== null ? { manualBalanceUsd } : {}),
    ...(typeof raw.manualPriceUsd === "number" &&
    Number.isFinite(raw.manualPriceUsd) &&
    raw.manualPriceUsd >= 0
      ? { manualPriceUsd: raw.manualPriceUsd }
      : {}),
    ...(manualBillingUnit ? { manualBillingUnit } : {}),
    ...(typeof raw.manualInputPriceUsd === "number" &&
    Number.isFinite(raw.manualInputPriceUsd) &&
    raw.manualInputPriceUsd >= 0
      ? { manualInputPriceUsd: raw.manualInputPriceUsd }
      : {}),
    ...(typeof raw.manualOutputPriceUsd === "number" &&
    Number.isFinite(raw.manualOutputPriceUsd) &&
    raw.manualOutputPriceUsd >= 0
      ? { manualOutputPriceUsd: raw.manualOutputPriceUsd }
      : {}),
    ...(raw.manualCurrency === "CNY" || raw.manualCurrency === "USD"
      ? { manualCurrency: raw.manualCurrency }
      : {}),
    ...(typeof raw.manualPriceNote === "string" && raw.manualPriceNote.trim()
      ? { manualPriceNote: raw.manualPriceNote.trim() }
      : {}),
    tags: tags.map((item) => item.trim()).filter(Boolean),
    note: typeof raw.note === "string" ? raw.note : "",
    updatedAt:
      typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : Date.now(),
  }
}

export function normalizeModelHubModelName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

export function inferModelHubModelType(modelName: string): ModelHubModelType {
  const name = normalizeModelHubModelName(modelName)
  if (/image|dall-e|flux|midjourney|sdxl|stable-diffusion/.test(name))
    return "image"
  if (/video|sora|veo|runway|kling/.test(name)) return "video"
  return "text"
}

export function normalizeManualSource(
  value: unknown,
): ModelHubManualSource | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Partial<ModelHubManualSource>
  if (typeof raw.id !== "string" || typeof raw.profileId !== "string")
    return null
  if (typeof raw.name !== "string" || typeof raw.groupName !== "string")
    return null
  const seenModels = new Set<string>()
  const models = Array.isArray(raw.models)
    ? raw.models.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const model = item as Partial<ModelHubManualSourceModel>
        if (typeof model.modelName !== "string" || !model.modelName.trim())
          return []
        const modelName = model.modelName.trim()
        const normalizedName = normalizeModelHubModelName(modelName)
        if (!normalizedName || seenModels.has(normalizedName)) return []
        seenModels.add(normalizedName)
        const type: ModelHubModelType =
          model.type === "image" ||
          model.type === "video" ||
          model.type === "other"
            ? model.type
            : "text"
        const billingUnit = model.billingUnit
        return [
          {
            modelName,
            normalizedName,
            type,
            ...(typeof model.priceUsd === "number" &&
            Number.isFinite(model.priceUsd) &&
            model.priceUsd >= 0
              ? { priceUsd: model.priceUsd }
              : {}),
            ...(billingUnit === "token-million" ||
            billingUnit === "image" ||
            billingUnit === "video-second" ||
            billingUnit === "video-minute" ||
            billingUnit === "request" ||
            billingUnit === "unknown"
              ? { billingUnit }
              : {}),
          },
        ]
      })
    : []
  return {
    id: raw.id,
    profileId: raw.profileId,
    name: raw.name.trim(),
    normalizedBaseUrl:
      typeof raw.normalizedBaseUrl === "string"
        ? raw.normalizedBaseUrl.trim().replace(/\/+$/, "").toLowerCase()
        : "",
    groupName: raw.groupName.trim(),
    ...(typeof raw.groupDescription === "string" && raw.groupDescription.trim()
      ? { groupDescription: raw.groupDescription.trim() }
      : {}),
    ...(typeof raw.groupRatio === "number" &&
    Number.isFinite(raw.groupRatio) &&
    raw.groupRatio >= 0
      ? { groupRatio: raw.groupRatio }
      : {}),
    ...(typeof raw.balanceUsd === "number" &&
    Number.isFinite(raw.balanceUsd) &&
    raw.balanceUsd >= 0
      ? { balanceUsd: raw.balanceUsd }
      : {}),
    models,
    createdAt:
      typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now(),
    updatedAt:
      typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : Date.now(),
  }
}

function normalizeManualSourceStore(value: unknown): ModelHubManualSourceStore {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const normalized = normalizeManualSource(item)
      return normalized ? [[key, normalized]] : []
    }),
  )
}

function normalizeStore(value: unknown): ModelHubManualOverrideStore {
  if (!value || typeof value !== "object") return {}

  const store: ModelHubManualOverrideStore = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeOverride(item)
    if (normalized) store[key] = normalized
  }
  return store
}

function normalizeViewMode(value: unknown): ModelHubViewMode {
  return value === "all" || value === "groups" ? "all" : "favorites"
}

function normalizeSortMode(value: unknown): ModelHubSortMode {
  return value === "name" ||
    value === "multiplier-asc" ||
    value === "multiplier-desc" ||
    value === "balance-desc" ||
    value === "price-asc" ||
    value === "price-desc"
    ? value
    : "multiplier-asc"
}

function normalizeBenchmarkResult(
  value: unknown,
): ModelHubBenchmarkResult | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Partial<ModelHubBenchmarkResult>
  if (raw.status !== "success" && raw.status !== "failed") return null
  if (typeof raw.testedAt !== "number" || !Number.isFinite(raw.testedAt)) {
    return null
  }
  const number = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : undefined
  return {
    status: raw.status,
    testedAt: raw.testedAt,
    ...(number(raw.firstTokenMs) !== undefined
      ? { firstTokenMs: number(raw.firstTokenMs) }
      : {}),
    ...(number(raw.responseHeadersMs) !== undefined
      ? { responseHeadersMs: number(raw.responseHeadersMs) }
      : {}),
    ...(number(raw.firstEventMs) !== undefined
      ? { firstEventMs: number(raw.firstEventMs) }
      : {}),
    ...(number(raw.totalDurationMs) !== undefined
      ? { totalDurationMs: number(raw.totalDurationMs) }
      : {}),
    ...(number(raw.generationDurationMs) !== undefined
      ? { generationDurationMs: number(raw.generationDurationMs) }
      : {}),
    ...(raw.tokenCountSource === "usage" || raw.tokenCountSource === "estimated"
      ? { tokenCountSource: raw.tokenCountSource }
      : {}),
    ...(number(raw.overallTokensPerSecond) !== undefined
      ? { overallTokensPerSecond: number(raw.overallTokensPerSecond) }
      : {}),
    ...(number(raw.generationTokensPerSecond) !== undefined
      ? { generationTokensPerSecond: number(raw.generationTokensPerSecond) }
      : {}),
    ...(number(raw.completionTokens) !== undefined
      ? { completionTokens: number(raw.completionTokens) }
      : {}),
    ...(typeof raw.errorSummary === "string"
      ? { errorSummary: raw.errorSummary.slice(0, 180) }
      : {}),
  }
}

function normalizeBenchmarkStore(value: unknown): ModelHubBenchmarkResultStore {
  if (!value || typeof value !== "object") return {}
  const store: ModelHubBenchmarkResultStore = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeBenchmarkResult(item)
    if (normalized) store[key] = normalized
  }
  return store
}

export function normalizeModelHubPreferences(
  value: unknown,
): ModelHubPreferences {
  if (!value || typeof value !== "object") {
    return {
      viewMode: "favorites",
      sortMode: "multiplier-asc",
      favoriteModels: [],
    }
  }

  const raw = value as Record<string, unknown>
  const favoriteModels: FavoriteModel[] = []
  const seenFavorites = new Set<string>()
  if (Array.isArray(raw.favoriteModels)) {
    for (const item of raw.favoriteModels) {
      const modelName =
        typeof item === "string"
          ? item.trim()
          : item &&
              typeof item === "object" &&
              typeof (item as Partial<FavoriteModel>).modelName === "string"
            ? (item as Partial<FavoriteModel>).modelName!.trim()
            : ""
      const normalizedName = normalizeModelHubModelName(modelName)
      if (!normalizedName || seenFavorites.has(normalizedName)) continue
      const rawType =
        typeof item === "object" && item
          ? (item as Partial<FavoriteModel>).type
          : undefined
      favoriteModels.push({
        modelName,
        normalizedName,
        type:
          rawType === "image" || rawType === "video" || rawType === "other"
            ? rawType
            : inferModelHubModelType(modelName),
      })
      seenFavorites.add(normalizedName)
    }
  }
  const selectedTargetModel =
    typeof raw.selectedTargetModel === "string" &&
    raw.selectedTargetModel.trim()
      ? raw.selectedTargetModel.trim().toLowerCase()
      : undefined

  return {
    viewMode: normalizeViewMode(raw.viewMode),
    sortMode: normalizeSortMode(raw.sortMode),
    favoriteModels,
    ...(selectedTargetModel ? { selectedTargetModel } : {}),
  }
}

export async function getModelHubManualOverrides() {
  const raw = await storage.get(MODEL_HUB_STORAGE_KEYS.MANUAL_OVERRIDES)
  return normalizeStore(raw)
}

export async function saveModelHubManualOverride(
  offeringId: string,
  override: Omit<ModelHubManualOverride, "updatedAt">,
) {
  return withExtensionStorageWriteLock(STORAGE_LOCKS.MODEL_HUB, async () => {
    const current = await getModelHubManualOverrides()
    current[offeringId] = {
      ...override,
      updatedAt: Date.now(),
    }
    await storage.set(MODEL_HUB_STORAGE_KEYS.MANUAL_OVERRIDES, current)
    return current[offeringId]
  })
}

export async function removeModelHubManualOverride(offeringId: string) {
  return withExtensionStorageWriteLock(STORAGE_LOCKS.MODEL_HUB, async () => {
    const current = await getModelHubManualOverrides()
    delete current[offeringId]
    await storage.set(MODEL_HUB_STORAGE_KEYS.MANUAL_OVERRIDES, current)
  })
}

export async function getModelHubPreferences() {
  const raw = await storage.get(MODEL_HUB_STORAGE_KEYS.PREFERENCES)
  return normalizeModelHubPreferences(raw)
}

export async function saveModelHubPreferences(
  preferences: ModelHubPreferences,
) {
  return withExtensionStorageWriteLock(STORAGE_LOCKS.MODEL_HUB, async () => {
    const normalized = normalizeModelHubPreferences(preferences)
    await storage.set(MODEL_HUB_STORAGE_KEYS.PREFERENCES, normalized)
    return normalized
  })
}

export async function getModelHubBenchmarkResults() {
  const raw = await storage.get(MODEL_HUB_BENCHMARK_STORAGE_KEY)
  return normalizeBenchmarkStore(raw)
}

export async function saveModelHubBenchmarkResult(
  offeringKey: string,
  result: ModelHubBenchmarkResult,
) {
  return withExtensionStorageWriteLock(STORAGE_LOCKS.MODEL_HUB, async () => {
    const current = await getModelHubBenchmarkResults()
    current[offeringKey] = result
    await storage.set(MODEL_HUB_BENCHMARK_STORAGE_KEY, current)
    return result
  })
}

export async function getModelHubManualSources() {
  return normalizeManualSourceStore(
    await storage.get(MODEL_HUB_MANUAL_SOURCES_STORAGE_KEY),
  )
}

export async function saveModelHubManualSource(source: ModelHubManualSource) {
  return withExtensionStorageWriteLock(STORAGE_LOCKS.MODEL_HUB, async () => {
    const current = await getModelHubManualSources()
    const normalized = normalizeManualSource({
      ...source,
      updatedAt: Date.now(),
    })
    if (!normalized || normalized.models.length === 0) {
      throw new Error("Invalid Model Hub manual source")
    }
    current[source.id] = normalized
    await storage.set(MODEL_HUB_MANUAL_SOURCES_STORAGE_KEY, current)
    return current[source.id]
  })
}

export async function removeModelHubManualSource(sourceId: string) {
  return withExtensionStorageWriteLock(STORAGE_LOCKS.MODEL_HUB, async () => {
    const current = await getModelHubManualSources()
    delete current[sourceId]
    await storage.set(MODEL_HUB_MANUAL_SOURCES_STORAGE_KEY, current)
  })
}
