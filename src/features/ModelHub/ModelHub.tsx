import {
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Star,
  Trash2,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import toast from "react-hot-toast"

import { CCSwitchExportDialog } from "~/components/CCSwitchExportDialog"
import {
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Modal,
  Spinner,
} from "~/components/ui"
import {
  createExportAccount,
  createExportToken,
} from "~/features/ApiCredentialProfiles/utils/exportShims"
import { KEY_MANAGEMENT_ALL_ACCOUNTS_VALUE } from "~/features/KeyManagement/constants"
import { useKeyManagement } from "~/features/KeyManagement/hooks/useKeyManagement"
import { formatQuota } from "~/features/KeyManagement/utils"
import { useAccountData } from "~/hooks/useAccountData"
import {
  createDisplayAccountApiContext,
  resolveDisplayAccountTokenForSecret,
} from "~/services/accounts/utils/apiServiceRequest"
import type { UserGroupInfo } from "~/services/accountTokens/tokenProvisioningModel"
import { apiCredentialProfilesStorage } from "~/services/apiCredentialProfiles/apiCredentialProfilesStorage"
import { fetchApiCredentialModelIds } from "~/services/apiCredentialProfiles/modelCatalog"
import type { ProductCanonicalModel } from "~/services/modelList/pricingModel"
import { isTokenCompatibleWithModel } from "~/services/models/utils/tokenModelCompatibility"
import { API_TYPES } from "~/services/verification/aiApiVerification"
import type { AccountToken, ApiToken, DisplaySiteData } from "~/types"

import { useModelData } from "../ModelList/hooks/useModelData"
import {
  createAllAccountsSource,
  type ModelListGroupSemantics,
} from "../ModelList/modelManagementSources"
import { runModelHubBenchmark, sanitizeBenchmarkError } from "./benchmark"
import { dedupeOfferingsByBusinessKey } from "./dedupe"
import {
  aggregateModelCatalogRows,
  buildAllModelRows,
  type AccountOfferingProjection,
  type AggregatedModelCatalogRow,
  type AllModelRow,
  type ManualOfferingProjection,
} from "./modelHubData"
import { createModelHubOfferingKey } from "./offeringIdentity"
import { resolveModelHubPrice, type ModelHubPriceView } from "./price"
import {
  buildTextPriceReferenceIndex,
  createReferenceEstimatedPrice,
} from "./referencePricing"
import {
  createEmptyModelHubManualOverride,
  createModelHubGroupOverrideKey,
  getModelHubBenchmarkResults,
  getModelHubManualOverrides,
  getModelHubManualSources,
  getModelHubPreferences,
  inferModelHubModelType,
  normalizeModelHubModelName,
  normalizeModelHubSourceUrl,
  removeModelHubManualOverride,
  removeModelHubManualSource,
  saveModelHubBenchmarkResult,
  saveModelHubManualOverride,
  saveModelHubManualSource,
  saveModelHubPreferences,
  type FavoriteModel,
  type ModelHubBenchmarkResultStore,
  type ModelHubBillingUnit,
  type ModelHubManualOverride,
  type ModelHubManualOverrideStore,
  type ModelHubManualSource,
  type ModelHubManualSourceModel,
  type ModelHubModelType,
  type ModelHubViewMode,
} from "./storage"

type TypeFilter = "all" | ModelHubModelType
type AllSection = "catalog" | "manual"
type AllSort = "model" | "price" | "updated"
type FavoriteSort = "price" | "ratio" | "balance" | "first-token" | "speed"

interface AccountOffering extends AccountOfferingProjection {
  model: ProductCanonicalModel
  baseUrl: string
  balanceKnown: boolean
  exchangeRate?: number
  groupRatioSource: "automatic" | "manual" | "unavailable"
  multiplier: number | null
  accountUsername: string
  compatibleTokens?: AccountToken[]
  selectedToken?: AccountToken
  selectedTokenUsable?: boolean
}

type FavoriteOffering = AccountOffering | ManualOfferingProjection

interface ManualModelDraft {
  id: string
  modelName: string
  type: ModelHubModelType
  priceUsd: string
  billingUnit: ModelHubBillingUnit
}

const TYPE_OPTIONS: Array<[ModelHubModelType, string]> = [
  ["text", "文本"],
  ["image", "图片"],
  ["video", "视频"],
  ["other", "其他"],
]
const BILLING_OPTIONS: Array<[ModelHubBillingUnit, string]> = [
  ["token-million", "百万 Token"],
  ["image", "图片"],
  ["video-second", "视频秒"],
  ["video-minute", "视频分钟"],
  ["request", "请求"],
  ["unknown", "未知"],
]
const CATALOG_PAGE_SIZE = 50
const GENERIC_GROUP_NAMES = new Set(["", "default", "通用", "默认分组"])

function isGenericGroup(groupName: string) {
  return GENERIC_GROUP_NAMES.has(normalizeModelHubModelName(groupName))
}

function compatibleTokensForOffering(
  tokens: readonly AccountToken[],
  offering: Pick<AccountOffering, "groupName" | "modelName">,
) {
  return tokens.filter((token) =>
    isTokenCompatibleWithModel(token, {
      id: offering.modelName,
      enableGroups: isGenericGroup(offering.groupName)
        ? undefined
        : [offering.groupName],
    }),
  )
}

function isTokenExpired(token: AccountToken) {
  return token.expired_time > 0 && token.expired_time <= Date.now() / 1000
}

function isTokenQuotaExhausted(token: AccountToken) {
  return !token.unlimited_quota && token.remain_quota <= 0
}

function isTokenUsable(token: AccountToken) {
  return !isTokenExpired(token) && !isTokenQuotaExhausted(token)
}

function selectOfferingToken(
  tokens: AccountToken[],
  preferredTokenId: number | undefined,
) {
  const preferred = tokens.find((token) => token.id === preferredTokenId)
  if (preferred && isTokenUsable(preferred)) return preferred
  return (
    [...tokens]
      .filter(isTokenUsable)
      .sort(
        (left, right) =>
          Number(right.unlimited_quota) - Number(left.unlimited_quota) ||
          right.remain_quota - left.remain_quota,
      )[0] ??
    preferred ??
    tokens[0]
  )
}

function groupsForModel(
  model: ProductCanonicalModel,
  semantics: ModelListGroupSemantics,
) {
  const groups = Array.from(
    new Set(model.enable_groups.map((group) => group.trim()).filter(Boolean)),
  )
  return groups.length
    ? groups
    : [semantics === "account-or-runtime-key" ? "默认分组" : "通用"]
}

function nonNegative(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function randomId(prefix: string) {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function maskSecret(value: string) {
  if (value.length <= 12) return `${value.slice(0, 3)}*****${value.slice(-2)}`
  return `${value.slice(0, 7)}********${value.slice(-4)}`
}

function typeLabel(type: ModelHubModelType) {
  return TYPE_OPTIONS.find(([value]) => value === type)?.[1] ?? "其他"
}

function formatDate(value: number) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatRatio(value: number | null) {
  return value === null ? "--" : `${value.toFixed(2)}x`
}

function formatBalance(value: number | null, known = true) {
  return known && value !== null ? `$${value.toFixed(2)}` : "--"
}

function balanceTextClass(value: number | null, known = true) {
  if (!known || value === null) return "text-gray-500"
  if (value > 10) return "text-emerald-600 dark:text-emerald-400"
  if (value > 1) return "text-amber-600 dark:text-amber-400"
  return "text-red-600 dark:text-red-400"
}

function ModelHub() {
  const { enabledAccounts, enabledDisplayData: accounts } = useAccountData()
  const [isConfigLoading, setIsConfigLoading] = useState(true)
  const [excludedSourceUrls, setExcludedSourceUrls] = useState<Set<string>>(
    new Set(),
  )
  const includedAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          !excludedSourceUrls.has(normalizeModelHubSourceUrl(account.baseUrl)),
      ),
    [accounts, excludedSourceUrls],
  )
  const selectedSource = useMemo(() => createAllAccountsSource(), [])
  const {
    pricingContexts,
    isLoading: accountModelsLoading,
    loadPricingData,
    accountQueryStates,
  } = useModelData({
    selectedSource,
    accounts: isConfigLoading ? [] : includedAccounts,
  })

  const [viewMode, setViewMode] = useState<ModelHubViewMode>("favorites")
  const [favorites, setFavorites] = useState<FavoriteModel[]>([])
  const [manualSources, setManualSources] = useState<ModelHubManualSource[]>([])
  const [overrides, setOverrides] = useState<ModelHubManualOverrideStore>({})
  const [benchmarks, setBenchmarks] = useState<ModelHubBenchmarkResultStore>({})
  const [isSourceManagerOpen, setIsSourceManagerOpen] = useState(false)
  const [selectedTokenIds, setSelectedTokenIds] = useState<
    Record<string, number>
  >({})
  const [favoriteType, setFavoriteType] = useState<TypeFilter>("text")
  const [selectedFavoriteName, setSelectedFavoriteName] = useState("")
  const [favoriteSearch, setFavoriteSearch] = useState("")
  const [favoriteSort, setFavoriteSort] = useState<FavoriteSort>("ratio")
  const [favoriteTag, setFavoriteTag] = useState("all")
  const [selectedOfferingIds, setSelectedOfferingIds] = useState<Set<string>>(
    new Set(),
  )
  const [batchTagMode, setBatchTagMode] = useState<"add" | "remove" | null>(
    null,
  )
  const [search, setSearch] = useState("")
  const [allSection, setAllSection] = useState<AllSection>("catalog")
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all")
  const [allSort, setAllSort] = useState<AllSort>("model")
  const [catalogPage, setCatalogPage] = useState(1)
  const [expandedModelNames, setExpandedModelNames] = useState<Set<string>>(
    new Set(),
  )
  const [expandedManualSourceIds, setExpandedManualSourceIds] = useState<
    Set<string>
  >(new Set())
  const [showAccountFailures, setShowAccountFailures] = useState(false)
  const [favoriteDraft, setFavoriteDraft] = useState<{
    modelName: string
    type: ModelHubModelType
  } | null>(null)
  const [editingAccountRow, setEditingAccountRow] =
    useState<AccountOffering | null>(null)
  const [editingManualSource, setEditingManualSource] = useState<
    ModelHubManualSource | "new" | null
  >(null)
  const [deletingSource, setDeletingSource] =
    useState<ModelHubManualSource | null>(null)
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set())
  const [groupInfoByAccount, setGroupInfoByAccount] = useState<
    Record<string, Record<string, UserGroupInfo>>
  >({})
  const requestedGroupInfoAccountIds = useRef(new Set<string>())
  const [batchTestRows, setBatchTestRows] = useState<FavoriteOffering[] | null>(
    null,
  )
  const [batchTestProgress, setBatchTestProgress] = useState<{
    completed: number
    total: number
  } | null>(null)
  const [ccSwitch, setCCSwitch] = useState<{
    account: DisplaySiteData
    token: ApiToken
    modelName: string
  } | null>(null)
  const keyManagementRouteParams = useMemo(
    () => ({ accountId: KEY_MANAGEMENT_ALL_ACCOUNTS_VALUE }),
    [],
  )
  const {
    tokenInventories,
    tokens: accountTokens,
    tokenLoadProgress,
    failedAccounts: keyLoadFailures,
    retryFailedAccounts: retryFailedKeyAccounts,
  } = useKeyManagement(keyManagementRouteParams)

  useEffect(() => {
    let active = true
    void Promise.all([
      getModelHubPreferences(),
      getModelHubManualSources(),
      getModelHubManualOverrides(),
      getModelHubBenchmarkResults(),
    ])
      .then(([preferences, sources, storedOverrides, storedBenchmarks]) => {
        if (!active) return
        setViewMode(preferences.viewMode)
        setFavorites(preferences.favoriteModels)
        setExcludedSourceUrls(new Set(preferences.excludedSourceUrls))
        setSelectedTokenIds(preferences.selectedTokenIds)
        setManualSources(Object.values(sources))
        setOverrides(storedOverrides)
        setBenchmarks(storedBenchmarks)
      })
      .finally(() => active && setIsConfigLoading(false))
    return () => {
      active = false
    }
  }, [])

  const accountOfferings = useMemo<AccountOffering[]>(() => {
    const displayById = new Map(
      includedAccounts.map((account) => [account.id, account]),
    )
    const rawById = new Map(
      enabledAccounts.map((account) => [account.id, account]),
    )
    const rows: AccountOffering[] = []
    const favoriteNames = new Set(
      favorites.map((favorite) => favorite.normalizedName),
    )
    for (const context of pricingContexts) {
      const account = displayById.get(context.account.id) ?? context.account
      const raw = rawById.get(account.id)
      const tokenId =
        context.sourceIdentity && "tokenId" in context.sourceIdentity
          ? context.sourceIdentity.tokenId
          : undefined
      for (const model of context.pricing.data ?? []) {
        const normalizedName = normalizeModelHubModelName(model.model_name)
        if (viewMode === "favorites" && !favoriteNames.has(normalizedName)) {
          continue
        }
        for (const groupName of groupsForModel(
          model,
          selectedSource.groupSemantics,
        )) {
          const id = createModelHubOfferingKey({
            sourceType: "account",
            stableSourceId: account.id,
            modelName: model.model_name,
            groupName,
          })
          const automatic =
            typeof context.pricing.group_ratio[groupName] === "number"
              ? context.pricing.group_ratio[groupName]
              : null
          const groupOverrideKey = createModelHubGroupOverrideKey(
            account.id,
            groupName,
          )
          const manual =
            overrides[groupOverrideKey]?.manualMultiplier ??
            overrides[id]?.manualMultiplier ??
            null
          const groupRatio = manual ?? automatic
          rows.push({
            id,
            sourceType: "account",
            accountId: account.id,
            sourceId: context.sourceIdentity?.id ?? account.id,
            ...(tokenId !== undefined ? { tokenId } : {}),
            modelName: model.model_name,
            normalizedName,
            type: inferModelHubModelType(model.model_name),
            providerName: account.name,
            accountUsername: account.username,
            groupName,
            ...(groupInfoByAccount[account.id]?.[groupName]?.desc
              ? {
                  groupDescription:
                    groupInfoByAccount[account.id][groupName].desc,
                }
              : {}),
            groupRatio,
            groupRatioSource:
              manual !== null
                ? "manual"
                : automatic !== null
                  ? "automatic"
                  : "unavailable",
            multiplier: groupRatio,
            balanceUsd: account.balance.USD,
            balanceKnown: Boolean(
              raw?.last_sync_time || account.last_sync_time,
            ),
            updatedAt: raw?.last_sync_time ?? account.last_sync_time ?? 0,
            model,
            baseUrl: account.baseUrl,
            exchangeRate: raw?.exchange_rate,
          })
        }
      }
    }
    return dedupeOfferingsByBusinessKey(rows)
  }, [
    enabledAccounts,
    favorites,
    groupInfoByAccount,
    includedAccounts,
    overrides,
    pricingContexts,
    selectedSource.groupSemantics,
    viewMode,
  ])

  const favoriteByName = useMemo(
    () =>
      new Map(favorites.map((favorite) => [favorite.normalizedName, favorite])),
    [favorites],
  )
  const allRows = useMemo(
    () => buildAllModelRows(accountOfferings, manualSources),
    [accountOfferings, manualSources],
  )
  const visibleFavorites = useMemo(
    () =>
      favorites.filter(
        (favorite) => favoriteType === "all" || favorite.type === favoriteType,
      ),
    [favoriteType, favorites],
  )
  const activeFavorite =
    visibleFavorites.find(
      (favorite) => favorite.normalizedName === selectedFavoriteName,
    ) ?? visibleFavorites[0]
  const favoriteRows = useMemo(() => {
    const names = new Set(favorites.map((favorite) => favorite.normalizedName))
    const accountById = new Map(accountOfferings.map((row) => [row.id, row]))
    return allRows
      .filter((row) => names.has(row.normalizedName))
      .map((row) =>
        row.sourceType === "account" ? accountById.get(row.id) ?? row : row,
      ) as FavoriteOffering[]
  }, [accountOfferings, allRows, favorites])
  const activeFavoriteRows = useMemo(
    () =>
      activeFavorite
        ? favoriteRows.filter(
            (row) => row.normalizedName === activeFavorite.normalizedName,
          )
        : [],
    [activeFavorite, favoriteRows],
  )
  const relevantKeyAccounts = useMemo(() => {
    if (viewMode !== "favorites" || !activeFavorite) return []
    const accountIds = new Set(
      pricingContexts
        .filter((context) =>
          context.pricing.data.some(
            (model) =>
              normalizeModelHubModelName(model.model_name) ===
              activeFavorite.normalizedName,
          ),
        )
        .map((context) => context.account.id),
    )
    return includedAccounts.filter((account) => accountIds.has(account.id))
  }, [activeFavorite, includedAccounts, pricingContexts, viewMode])
  const tokensByAccount = useMemo(() => {
    const result = new Map<string, AccountToken[]>()
    for (const token of accountTokens) {
      const current = result.get(token.accountId) ?? []
      current.push(token)
      result.set(token.accountId, current)
    }
    return result
  }, [accountTokens])

  const actionableFavoriteRows = useMemo<FavoriteOffering[]>(
    () =>
      activeFavoriteRows.flatMap<FavoriteOffering>((row) => {
        if (row.sourceType === "manual") return [row]
        const inventory = tokenInventories[row.accountId]
        if (inventory?.status !== "loaded") return []
        const tokens = compatibleTokensForOffering(
          tokensByAccount.get(row.accountId) ?? [],
          row,
        )
        if (tokens.length === 0) return []
        const selectedToken = selectOfferingToken(
          tokens,
          selectedTokenIds[row.id],
        )
        return [
          {
            ...row,
            compatibleTokens: tokens,
            selectedToken,
            selectedTokenUsable: selectedToken
              ? isTokenUsable(selectedToken)
              : false,
          },
        ]
      }),
    [activeFavoriteRows, selectedTokenIds, tokenInventories, tokensByAccount],
  )

  useEffect(() => {
    let active = true
    let settled = false
    const requestedAccountIds = requestedGroupInfoAccountIds.current
    const relevantAccountIds = new Set(
      actionableFavoriteRows.flatMap((row) =>
        row.sourceType === "account" ? [row.accountId] : [],
      ),
    )
    const targetAccounts = includedAccounts.filter(
      (account) =>
        relevantAccountIds.has(account.id) &&
        !requestedAccountIds.has(account.id),
    )
    targetAccounts.forEach((account) => requestedAccountIds.add(account.id))
    if (targetAccounts.length === 0) return undefined
    void Promise.all(
      targetAccounts.map(async (account) => {
        try {
          const context = createDisplayAccountApiContext(account)
          const groups = await context.keyManagement?.userGroups?.fetch(
            context.request,
          )
          return { accountId: account.id, groups: groups ?? {}, success: true }
        } catch {
          return { accountId: account.id, groups: {}, success: false }
        }
      }),
    ).then((results) => {
      if (!active) return
      settled = true
      const successfulEntries = results
        .filter((result) => result.success)
        .map((result) => [result.accountId, result.groups] as const)
      results
        .filter((result) => !result.success)
        .forEach((result) => requestedAccountIds.delete(result.accountId))
      if (successfulEntries.length > 0) {
        setGroupInfoByAccount((current) => ({
          ...current,
          ...Object.fromEntries(successfulEntries),
        }))
      }
    })
    return () => {
      active = false
      if (!settled) {
        targetAccounts.forEach((account) =>
          requestedAccountIds.delete(account.id),
        )
      }
    }
  }, [actionableFavoriteRows, includedAccounts])
  const availableFavoriteTags = useMemo(
    () =>
      Array.from(
        new Set(
          actionableFavoriteRows.flatMap(
            (row) => overrides[row.id]?.tags ?? [],
          ),
        ),
      ).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [actionableFavoriteRows, overrides],
  )

  useEffect(() => {
    setSelectedOfferingIds(new Set())
    setFavoriteTag("all")
  }, [activeFavorite?.normalizedName])

  const accountFailures = accountQueryStates.filter((state) => state.hasError)
  const isInitialAccountLoading =
    accountModelsLoading && pricingContexts.length === 0
  const isLoading = isConfigLoading || isInitialAccountLoading
  const isBackgroundRefreshing =
    accountModelsLoading && pricingContexts.length > 0

  const persistFavorites = useCallback(
    async (next: FavoriteModel[]) => {
      const saved = await saveModelHubPreferences({
        viewMode,
        sortMode: "name",
        favoriteModels: next,
        excludedSourceUrls: [...excludedSourceUrls],
        selectedTokenIds,
      })
      setFavorites(saved.favoriteModels)
    },
    [excludedSourceUrls, selectedTokenIds, viewMode],
  )

  const changeView = (next: ModelHubViewMode) => {
    setViewMode(next)
    void saveModelHubPreferences({
      viewMode: next,
      sortMode: "name",
      favoriteModels: favorites,
      excludedSourceUrls: [...excludedSourceUrls],
      selectedTokenIds,
    })
  }

  const saveExcludedSources = async (next: Set<string>) => {
    const saved = await saveModelHubPreferences({
      viewMode,
      sortMode: "multiplier-asc",
      favoriteModels: favorites,
      excludedSourceUrls: [...next],
      selectedTokenIds,
    })
    setExcludedSourceUrls(new Set(saved.excludedSourceUrls))
    requestedGroupInfoAccountIds.current.clear()
    setGroupInfoByAccount({})
    setIsSourceManagerOpen(false)
  }

  const selectTokenForOffering = async (
    offeringId: string,
    tokenId: number,
  ) => {
    const next = { ...selectedTokenIds, [offeringId]: tokenId }
    setSelectedTokenIds(next)
    await saveModelHubPreferences({
      viewMode,
      sortMode: "multiplier-asc",
      favoriteModels: favorites,
      excludedSourceUrls: [...excludedSourceUrls],
      selectedTokenIds: next,
    })
  }

  const toggleFavorite = (
    row: Pick<AllModelRow, "modelName" | "normalizedName" | "type">,
  ) => {
    if (favoriteByName.has(row.normalizedName)) {
      void persistFavorites(
        favorites.filter(
          (favorite) => favorite.normalizedName !== row.normalizedName,
        ),
      )
      return
    }
    setFavoriteDraft({ modelName: row.modelName, type: row.type })
  }

  const saveFavoriteDraft = () => {
    if (!favoriteDraft) return
    const normalizedName = normalizeModelHubModelName(favoriteDraft.modelName)
    void persistFavorites([
      ...favorites.filter((item) => item.normalizedName !== normalizedName),
      {
        modelName: favoriteDraft.modelName.trim(),
        normalizedName,
        type: favoriteDraft.type,
      },
    ])
    setFavoriteDraft(null)
  }

  const updateFavoriteType = (
    favorite: FavoriteModel,
    type: ModelHubModelType,
  ) => {
    void persistFavorites(
      favorites.map((item) =>
        item.normalizedName === favorite.normalizedName
          ? { ...item, type }
          : item,
      ),
    )
  }

  const rawPriceForAccount = useCallback(
    (row: AccountOffering): ModelHubPriceView =>
      resolveModelHubPrice({
        model: row.model,
        groupMultiplier: row.groupRatio ?? 1,
        override: overrides[row.id],
        currency: "USD",
        cnyPerUsd: row.exchangeRate,
      }),
    [overrides],
  )
  const textPriceReferences = useMemo(
    () =>
      buildTextPriceReferenceIndex(
        accountOfferings.map((row) => ({
          sourceId: row.accountId,
          normalizedName: row.normalizedName,
          groupRatio: row.groupRatio,
          model: row.model,
          resolvedInputUsd: rawPriceForAccount(row).inputUsd ?? null,
        })),
      ),
    [accountOfferings, rawPriceForAccount],
  )
  const priceForAccount = useCallback(
    (row: AccountOffering): ModelHubPriceView => rawPriceForAccount(row),
    [rawPriceForAccount],
  )
  const editingAccountPrice = useMemo(
    () => (editingAccountRow ? priceForAccount(editingAccountRow) : null),
    [editingAccountRow, priceForAccount],
  )
  const editingAccountOverride = useMemo(
    () =>
      editingAccountRow
        ? {
            ...(overrides[editingAccountRow.id] ??
              createEmptyModelHubManualOverride()),
            manualMultiplier:
              overrides[
                createModelHubGroupOverrideKey(
                  editingAccountRow.accountId,
                  editingAccountRow.groupName,
                )
              ]?.manualMultiplier ??
              overrides[editingAccountRow.id]?.manualMultiplier ??
              null,
            updatedAt: overrides[editingAccountRow.id]?.updatedAt ?? Date.now(),
          }
        : undefined,
    [editingAccountRow, overrides],
  )
  const priceForManual = useCallback(
    (
      row: Extract<AllModelRow, { sourceType: "manual" }>,
    ): ModelHubPriceView => {
      if (row.priceUsd !== undefined) {
        const unit = row.billingUnit ?? "unknown"
        return {
          primaryText: `$${row.priceUsd.toFixed(4)}`,
          unitText:
            unit === "token-million"
              ? "/M"
              : unit === "image"
                ? "/张"
                : unit === "video-second"
                  ? "/秒"
                  : unit === "video-minute"
                    ? "/分钟"
                    : unit === "request"
                      ? "/次"
                      : "",
          usdAmount: row.priceUsd,
          status: "manual",
          billingUnit: unit,
          billingMode: unit === "token-million" ? "token" : "per-call",
          isEstimated: false,
        }
      }
      const reference = textPriceReferences.get(row.normalizedName)
      if (row.type === "text" && reference && row.groupRatio !== null) {
        const estimated = createReferenceEstimatedPrice(
          reference,
          row.groupRatio,
        )
        return {
          primaryText: `$${estimated.inputUsd.toFixed(4)}`,
          unitText: "/M",
          usdAmount: estimated.inputUsd,
          status: "estimated",
          billingUnit: "token-million",
          billingMode: "token",
          isEstimated: true,
          inputUsd: estimated.inputUsd,
          outputUsd: estimated.outputUsd,
          manualNote: `参考基准 $${reference.inputUsdPerMillionAt1x.toFixed(4)}/M × ${row.groupRatio.toFixed(2)}x`,
        }
      }
      return {
        primaryText: "",
        unitText: "",
        usdAmount: null,
        status: "unavailable",
        billingUnit: "unknown",
        billingMode: row.type === "text" ? "token" : "per-call",
        isEstimated: false,
      }
    },
    [textPriceReferences],
  )
  const priceForOffering = useCallback(
    (row: FavoriteOffering) =>
      row.sourceType === "account" ? priceForAccount(row) : priceForManual(row),
    [priceForAccount, priceForManual],
  )
  const accountOfferingById = useMemo(
    () => new Map(accountOfferings.map((row) => [row.id, row])),
    [accountOfferings],
  )
  const catalogRows = useMemo(() => {
    if (viewMode !== "all" || allSection !== "catalog") return []
    const query = search.trim().toLowerCase()
    const aggregated = aggregateModelCatalogRows(allRows, (row) => {
      if (row.sourceType === "manual") return priceForManual(row).usdAmount
      const account = accountOfferingById.get(row.id)
      return account ? priceForAccount(account).usdAmount : null
    }).map((row) => ({
      ...row,
      type: favoriteByName.get(row.normalizedName)?.type ?? row.type,
    }))

    return aggregated
      .filter((row) => {
        if (typeFilter !== "all" && row.type !== typeFilter) return false
        if (!query) return true
        return (
          row.modelName.toLowerCase().includes(query) ||
          row.offerings.some(
            (offering) =>
              offering.providerName.toLowerCase().includes(query) ||
              offering.groupName.toLowerCase().includes(query),
          )
        )
      })
      .sort((left, right) => {
        if (allSort === "updated") return right.updatedAt - left.updatedAt
        if (allSort === "price") {
          return (
            (left.lowestPriceUsd ?? Number.POSITIVE_INFINITY) -
              (right.lowestPriceUsd ?? Number.POSITIVE_INFINITY) ||
            left.modelName.localeCompare(right.modelName)
          )
        }
        return left.modelName.localeCompare(right.modelName)
      })
  }, [
    accountOfferingById,
    allRows,
    allSort,
    favoriteByName,
    priceForAccount,
    priceForManual,
    search,
    typeFilter,
    allSection,
    viewMode,
  ])
  const catalogPageCount = Math.max(
    1,
    Math.ceil(catalogRows.length / CATALOG_PAGE_SIZE),
  )
  const pagedCatalogRows = useMemo(
    () =>
      catalogRows.slice(
        (catalogPage - 1) * CATALOG_PAGE_SIZE,
        catalogPage * CATALOG_PAGE_SIZE,
      ),
    [catalogPage, catalogRows],
  )
  useEffect(() => setCatalogPage(1), [allSort, search, typeFilter])
  useEffect(() => {
    if (catalogPage > catalogPageCount) setCatalogPage(catalogPageCount)
  }, [catalogPage, catalogPageCount])
  const filteredManualSources = useMemo(() => {
    const query = search.trim().toLowerCase()
    return manualSources
      .filter(
        (source) =>
          !query ||
          source.name.toLowerCase().includes(query) ||
          source.groupName.toLowerCase().includes(query) ||
          source.normalizedBaseUrl.toLowerCase().includes(query) ||
          source.models.some((model) =>
            model.modelName.toLowerCase().includes(query),
          ),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [manualSources, search])
  const sortedActiveFavoriteRows = useMemo(() => {
    const query = favoriteSearch.trim().toLowerCase()
    const rows = actionableFavoriteRows.filter((row) => {
      const matchesSearch =
        !query ||
        row.providerName.toLowerCase().includes(query) ||
        row.groupName.toLowerCase().includes(query)
      const matchesTag =
        favoriteTag === "all" || overrides[row.id]?.tags.includes(favoriteTag)
      return matchesSearch && matchesTag
    })
    return [...rows].sort((left, right) => {
      if (favoriteSort === "ratio") {
        return (
          (left.groupRatio ?? Number.POSITIVE_INFINITY) -
          (right.groupRatio ?? Number.POSITIVE_INFINITY)
        )
      }
      if (favoriteSort === "balance") {
        return (right.balanceUsd ?? -1) - (left.balanceUsd ?? -1)
      }
      if (favoriteSort === "first-token") {
        return (
          (benchmarks[left.id]?.firstTokenMs ?? Number.POSITIVE_INFINITY) -
          (benchmarks[right.id]?.firstTokenMs ?? Number.POSITIVE_INFINITY)
        )
      }
      if (favoriteSort === "speed") {
        return (
          (benchmarks[right.id]?.overallTokensPerSecond ?? -1) -
          (benchmarks[left.id]?.overallTokensPerSecond ?? -1)
        )
      }
      return (
        (priceForOffering(left).usdAmount ?? Number.POSITIVE_INFINITY) -
        (priceForOffering(right).usdAmount ?? Number.POSITIVE_INFINITY)
      )
    })
  }, [
    actionableFavoriteRows,
    benchmarks,
    favoriteSearch,
    favoriteSort,
    favoriteTag,
    overrides,
    priceForOffering,
  ])

  const saveAccountOverride = async (
    row: AccountOffering,
    override: Omit<ModelHubManualOverride, "updatedAt">,
  ) => {
    const groupKey = createModelHubGroupOverrideKey(
      row.accountId,
      row.groupName,
    )
    const offeringOverride = { ...override, manualMultiplier: null }
    const groupOverride = {
      ...createEmptyModelHubManualOverride(),
      manualMultiplier: override.manualMultiplier,
    }
    const [savedOffering, savedGroup] = await Promise.all([
      saveModelHubManualOverride(row.id, offeringOverride),
      saveModelHubManualOverride(groupKey, groupOverride),
    ])
    setOverrides((current) => ({
      ...current,
      [row.id]: savedOffering,
      [groupKey]: savedGroup,
    }))
    setEditingAccountRow(null)
  }

  const clearAccountOverride = async (row: AccountOffering) => {
    const groupKey = createModelHubGroupOverrideKey(
      row.accountId,
      row.groupName,
    )
    await Promise.all([
      removeModelHubManualOverride(row.id),
      removeModelHubManualOverride(groupKey),
    ])
    setOverrides((current) => {
      const next = { ...current }
      delete next[row.id]
      delete next[groupKey]
      return next
    })
    setEditingAccountRow(null)
  }

  const applyBatchTags = async (tags: string[], mode: "add" | "remove") => {
    const selectedRows = actionableFavoriteRows.filter((row) =>
      selectedOfferingIds.has(row.id),
    )
    const updates = await Promise.all(
      selectedRows.map(async (row) => {
        const current = overrides[row.id] ?? createEmptyModelHubManualOverride()
        const nextTags =
          mode === "add"
            ? Array.from(new Set([...current.tags, ...tags]))
            : current.tags.filter((tag) => !tags.includes(tag))
        const saved = await saveModelHubManualOverride(row.id, {
          ...current,
          manualMultiplier: null,
          tags: nextTags,
        })
        return [row.id, saved] as const
      }),
    )
    setOverrides((current) => ({ ...current, ...Object.fromEntries(updates) }))
    setBatchTagMode(null)
    toast.success(mode === "add" ? "标签已批量添加" : "标签已批量移除")
  }

  const keyInventoryProgress = useMemo(() => {
    const inventories = relevantKeyAccounts.map(
      (account) => tokenInventories[account.id],
    )
    const relevantAccountIds = new Set(
      relevantKeyAccounts.map((account) => account.id),
    )
    return {
      total: relevantKeyAccounts.length,
      completed: inventories.filter(
        (inventory) => inventory?.status === "loaded",
      ).length,
      loading: inventories.some(
        (inventory) =>
          !inventory ||
          inventory.status === "idle" ||
          inventory.status === "loading",
      ),
      errors: keyLoadFailures.filter((failure) =>
        relevantAccountIds.has(failure.accountId),
      ),
      globalProgress: tokenLoadProgress,
    }
  }, [
    keyLoadFailures,
    relevantKeyAccounts,
    tokenInventories,
    tokenLoadProgress,
  ])

  const benchmarkAccount = async (row: AccountOffering) => {
    if (row.type !== "text" || testingIds.has(row.id)) return
    const account = accounts.find((item) => item.id === row.accountId)
    if (!account) return
    setTestingIds((current) => new Set(current).add(row.id))
    try {
      if (!row.selectedToken) throw new Error("该分组尚未创建 API 密钥")
      if (!row.selectedTokenUsable) throw new Error("当前密钥已过期或额度耗尽")
      const token = await resolveDisplayAccountTokenForSecret(
        account,
        row.selectedToken,
      )
      const metrics = await runModelHubBenchmark({
        baseUrl: account.baseUrl,
        apiKey: token.key,
        model: row.modelName,
      })
      const result = {
        status: "success" as const,
        testedAt: Date.now(),
        ...metrics,
      }
      await saveModelHubBenchmarkResult(row.id, result)
      setBenchmarks((current) => ({ ...current, [row.id]: result }))
      toast.success("测试完成")
    } catch (error) {
      const result = {
        status: "failed" as const,
        testedAt: Date.now(),
        errorSummary: sanitizeBenchmarkError(error),
      }
      await saveModelHubBenchmarkResult(row.id, result)
      setBenchmarks((current) => ({ ...current, [row.id]: result }))
      toast.error(result.errorSummary)
    } finally {
      setTestingIds((current) => {
        const next = new Set(current)
        next.delete(row.id)
        return next
      })
    }
  }

  const benchmarkManual = async (
    row: Extract<AllModelRow, { sourceType: "manual" }>,
  ) => {
    if (testingIds.has(row.id)) return
    setTestingIds((current) => new Set(current).add(row.id))
    try {
      const profile = await apiCredentialProfilesStorage.getProfileById(
        row.profileId,
      )
      if (!profile)
        throw new Error(
          `手动来源“${row.providerName}”对应的 API Credential Profile 不存在`,
        )
      const metrics = await runModelHubBenchmark({
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        model: row.modelName,
      })
      const result = {
        status: "success" as const,
        testedAt: Date.now(),
        ...metrics,
      }
      await saveModelHubBenchmarkResult(row.id, result)
      setBenchmarks((current) => ({ ...current, [row.id]: result }))
      toast.success("测试完成")
    } catch (error) {
      const result = {
        status: "failed" as const,
        testedAt: Date.now(),
        errorSummary: sanitizeBenchmarkError(error),
      }
      await saveModelHubBenchmarkResult(row.id, result)
      setBenchmarks((current) => ({ ...current, [row.id]: result }))
      toast.error(result.errorSummary)
    } finally {
      setTestingIds((current) => {
        const next = new Set(current)
        next.delete(row.id)
        return next
      })
    }
  }

  const exportManual = async (
    row: Extract<AllModelRow, { sourceType: "manual" }>,
  ) => {
    const profile = await apiCredentialProfilesStorage.getProfileById(
      row.profileId,
    )
    if (!profile) {
      toast.error(
        `手动来源“${row.providerName}”对应的 API Credential Profile 不存在，无法导入 CCS`,
      )
      return
    }
    setCCSwitch({
      account: createExportAccount(profile),
      token: createExportToken(profile),
      modelName: row.modelName,
    })
  }

  const benchmarkOffering = (row: FavoriteOffering) =>
    row.sourceType === "account" ? benchmarkAccount(row) : benchmarkManual(row)

  const exportOffering = (row: FavoriteOffering) => {
    if (row.sourceType === "manual") return exportManual(row)
    const account = accounts.find((item) => item.id === row.accountId)
    if (!account || !row.selectedToken) {
      toast.error("该分组没有可导出的账号密钥")
      return
    }
    if (!row.selectedTokenUsable) {
      toast.error("当前密钥已过期或额度耗尽")
      return
    }
    setCCSwitch({ account, token: row.selectedToken, modelName: row.modelName })
  }

  const editOffering = (row: FavoriteOffering) => {
    if (row.sourceType === "account") {
      setEditingAccountRow(row)
      return
    }
    const source = manualSources.find((item) => item.id === row.manualSourceId)
    if (source) setEditingManualSource(source)
  }

  const confirmBatchTest = async () => {
    const rows = batchTestRows?.filter((row) => row.type === "text") ?? []
    if (!rows.length) return
    setBatchTestProgress({ completed: 0, total: rows.length })
    let cursor = 0
    const worker = async () => {
      while (cursor < rows.length) {
        const row = rows[cursor]
        cursor += 1
        await benchmarkOffering(row)
        setBatchTestProgress((current) =>
          current ? { ...current, completed: current.completed + 1 } : current,
        )
      }
    }
    await Promise.all([worker(), worker()])
    setBatchTestProgress(null)
    setBatchTestRows(null)
    toast.success(`批量测试完成，共 ${rows.length} 项`)
  }

  const handleManualSaved = (saved: ModelHubManualSource) => {
    setManualSources((current) => [
      ...current.filter((item) => item.id !== saved.id),
      saved,
    ])
    setEditingManualSource(null)
  }

  const confirmDeleteManual = async () => {
    if (!deletingSource) return
    await removeModelHubManualSource(deletingSource.id)
    setManualSources((current) =>
      current.filter((source) => source.id !== deletingSource.id),
    )
    setDeletingSource(null)
    toast.success("手动来源已删除，API Credential Profile 已保留")
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
            模型筛选
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            选择常用模型，快速比较账号分组与价格
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            leftIcon={<Settings2 />}
            onClick={() => setIsSourceManagerOpen(true)}
          >
            来源管理 {includedAccounts.length}/{accounts.length}
          </Button>
          <div className="flex rounded-md border border-gray-200 p-1 dark:border-gray-700">
            <Button
              size="sm"
              variant={viewMode === "favorites" ? "default" : "ghost"}
              onClick={() => changeView("favorites")}
            >
              常用模型{" "}
              <span className="ml-1 opacity-70">{favorites.length}</span>
            </Button>
            <Button
              size="sm"
              variant={viewMode === "all" ? "default" : "ghost"}
              onClick={() => changeView("all")}
            >
              全部模型
            </Button>
          </div>
        </div>
      </div>

      {isBackgroundRefreshing && (
        <div className="text-xs text-gray-500">
          账号模型正在后台更新，已加载结果可先使用。
        </div>
      )}

      {viewMode === "favorites" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-500">模型类型</span>
            {([["all", "全部"]] as Array<[TypeFilter, string]>)
              .concat(TYPE_OPTIONS)
              .map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={favoriteType === value ? "secondary" : "ghost"}
                  onClick={() => setFavoriteType(value)}
                >
                  {label}
                </Button>
              ))}
            <Button
              className="ml-auto"
              size="sm"
              variant="ghost"
              leftIcon={<RefreshCw />}
              onClick={() => void loadPricingData()}
            >
              刷新账号模型
            </Button>
          </div>
          {visibleFavorites.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/40">
              <span className="text-xs text-gray-500">收藏模型</span>
              {visibleFavorites.map((favorite) => (
                <Button
                  key={favorite.normalizedName}
                  size="sm"
                  variant={
                    activeFavorite?.normalizedName === favorite.normalizedName
                      ? "default"
                      : "ghost"
                  }
                  onClick={() =>
                    setSelectedFavoriteName(favorite.normalizedName)
                  }
                >
                  {favorite.modelName}
                </Button>
              ))}
            </div>
          )}
          {accountFailures.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {accountFailures.length}{" "}
                  个账号目录或价格加载失败，不影响其余候选。
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAccountFailures((value) => !value)}
                >
                  {showAccountFailures ? "收起详情" : "查看详情"}
                </Button>
              </div>
              {showAccountFailures && (
                <div className="mt-1 text-xs">
                  {accountFailures
                    .map(
                      (state) =>
                        `${state.account.name}：${state.errorMessage ?? "加载失败"}`,
                    )
                    .join("；")}
                </div>
              )}
            </div>
          )}
          {isConfigLoading ||
          (allSection === "catalog" && isInitialAccountLoading) ? (
            <Loading />
          ) : favorites.length === 0 ? (
            <Empty>尚未收藏模型，可到全部模型中收藏。</Empty>
          ) : !activeFavorite ? (
            <Empty>当前类型下没有收藏模型。</Empty>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-gray-500">当前模型</span>
                <strong className="text-gray-900 dark:text-white">
                  {activeFavorite.modelName}
                </strong>
                <select
                  className="h-8 rounded border border-gray-300 bg-white px-2 text-xs dark:border-gray-700 dark:bg-gray-900"
                  value={activeFavorite.type}
                  onChange={(event) =>
                    updateFavoriteType(
                      activeFavorite,
                      event.target.value as ModelHubModelType,
                    )
                  }
                >
                  {TYPE_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="取消收藏"
                  onClick={() => toggleFavorite({ ...activeFavorite })}
                >
                  <Star className="fill-amber-400 text-amber-500" />
                </Button>
                <label className="relative ml-auto min-w-56 flex-1 sm:max-w-sm">
                  <Search className="absolute top-2.5 left-3 h-4 w-4 text-gray-400" />
                  <Input
                    className="pl-9"
                    value={favoriteSearch}
                    onChange={(event) => setFavoriteSearch(event.target.value)}
                    placeholder="搜索中转站或分组"
                  />
                </label>
                <SelectControl
                  value={favoriteSort}
                  onChange={(value) => setFavoriteSort(value as FavoriteSort)}
                  options={[
                    ["price", "价格最低"],
                    ["ratio", "分组倍率最低"],
                    ["first-token", "首字最快"],
                    ["speed", "输出速度最快"],
                    ["balance", "余额最多"],
                  ]}
                />
              </div>
              {availableFavoriteTags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-gray-500">标签筛选</span>
                  {["all", ...availableFavoriteTags].map((tag) => (
                    <Button
                      key={tag}
                      size="sm"
                      variant={favoriteTag === tag ? "secondary" : "ghost"}
                      onClick={() => setFavoriteTag(tag)}
                    >
                      {tag === "all" ? "全部" : tag}
                    </Button>
                  ))}
                </div>
              )}
              {keyInventoryProgress.total > 0 &&
                (keyInventoryProgress.loading ||
                  keyInventoryProgress.errors.length > 0) && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900/40">
                    {keyInventoryProgress.loading && (
                      <span>
                        正在检查相关账号的密钥分组，已确认{" "}
                        {keyInventoryProgress.completed}/
                        {keyInventoryProgress.total}
                      </span>
                    )}
                    {keyInventoryProgress.errors.length > 0 && (
                      <span className="text-amber-700 dark:text-amber-400">
                        {keyInventoryProgress.errors.length} 个账号密钥加载失败
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void retryFailedKeyAccounts()}
                    >
                      重试
                    </Button>
                    {showAccountFailures &&
                      keyInventoryProgress.errors.map((failure) => (
                        <span
                          key={failure.accountId}
                          className="w-full text-xs"
                        >
                          {failure.accountName}：
                          {failure.errorMessage ?? "密钥加载失败"}
                        </span>
                      ))}
                    {keyInventoryProgress.errors.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setShowAccountFailures((value) => !value)
                        }
                      >
                        {showAccountFailures ? "收起详情" : "查看详情"}
                      </Button>
                    )}
                  </div>
                )}
              {selectedOfferingIds.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/30">
                  <span>已选择 {selectedOfferingIds.size} 项</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setBatchTestRows(
                        actionableFavoriteRows.filter((row) =>
                          selectedOfferingIds.has(row.id),
                        ),
                      )
                    }
                  >
                    批量测试
                  </Button>
                  <Button size="sm" onClick={() => setBatchTagMode("add")}>
                    添加标签
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setBatchTagMode("remove")}
                  >
                    移除标签
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedOfferingIds(new Set())}
                  >
                    取消选择
                  </Button>
                </div>
              )}
              {sortedActiveFavoriteRows.length === 0 ? (
                <Empty>
                  {keyInventoryProgress.loading
                    ? "正在检查可用密钥分组。"
                    : "当前没有已配置有效密钥的账号分组或手动 API 来源。"}
                </Empty>
              ) : (
                <FavoriteTable
                  rows={sortedActiveFavoriteRows}
                  prices={priceForOffering}
                  benchmarks={benchmarks}
                  testingIds={testingIds}
                  selectedIds={selectedOfferingIds}
                  onSelectionChange={setSelectedOfferingIds}
                  overrides={overrides}
                  onTest={benchmarkOffering}
                  onExport={exportOffering}
                  onEdit={editOffering}
                  onTokenChange={(row, tokenId) =>
                    void selectTokenForOffering(row.id, tokenId)
                  }
                />
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex w-fit rounded-md border border-gray-200 p-1 dark:border-gray-700">
            <Button
              size="sm"
              variant={allSection === "catalog" ? "secondary" : "ghost"}
              onClick={() => setAllSection("catalog")}
            >
              模型目录
            </Button>
            <Button
              size="sm"
              variant={allSection === "manual" ? "secondary" : "ghost"}
              onClick={() => setAllSection("manual")}
            >
              手动 API 来源{" "}
              <span className="ml-1 opacity-70">{manualSources.length}</span>
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-64 flex-1">
              <Search className="absolute top-2.5 left-3 h-4 w-4 text-gray-400" />
              <Input
                className="pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={
                  allSection === "catalog"
                    ? "搜索模型、中转站或分组"
                    : "搜索手动来源、URL、分组或模型"
                }
              />
            </label>
            {allSection === "catalog" ? (
              <>
                <SelectControl
                  value={typeFilter}
                  onChange={(value) => setTypeFilter(value as TypeFilter)}
                  options={[["all", "全部类型"], ...TYPE_OPTIONS]}
                />
                <SelectControl
                  value={allSort}
                  onChange={(value) => setAllSort(value as AllSort)}
                  options={[
                    ["model", "模型名称"],
                    ["price", "最低价格"],
                    ["updated", "最近更新"],
                  ]}
                />
              </>
            ) : (
              <Button
                leftIcon={<Plus />}
                onClick={() => setEditingManualSource("new")}
              >
                手动添加 API 来源
              </Button>
            )}
          </div>
          {allSection === "catalog" && accountFailures.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {accountFailures.length}{" "}
                  个账号目录加载失败，模型目录仍展示其他可用账号。
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAccountFailures((value) => !value)}
                >
                  {showAccountFailures ? "收起详情" : "查看详情"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadPricingData()}
                >
                  重新加载
                </Button>
              </div>
              {showAccountFailures && (
                <div className="mt-2 space-y-1 text-xs">
                  {accountFailures.map((state) => (
                    <div key={state.account.id}>
                      <a
                        className="font-medium hover:underline"
                        href={state.account.baseUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {state.account.name}
                      </a>
                      ：{state.errorMessage ?? "加载失败"}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {isLoading ? (
            <Loading />
          ) : allSection === "catalog" ? (
            catalogRows.length === 0 ? (
              <Empty>没有符合条件的模型。</Empty>
            ) : (
              <div className="space-y-3">
                <CatalogTable
                  rows={pagedCatalogRows}
                  accountRows={accountOfferings}
                  favoriteNames={
                    new Set(
                      favorites.map((favorite) => favorite.normalizedName),
                    )
                  }
                  prices={priceForAccount}
                  manualPrices={priceForManual}
                  expandedNames={expandedModelNames}
                  onToggleExpanded={(name) =>
                    setExpandedModelNames((current) => {
                      const next = new Set(current)
                      if (next.has(name)) next.delete(name)
                      else next.add(name)
                      return next
                    })
                  }
                  onToggleFavorite={toggleFavorite}
                />
                <div className="flex items-center justify-between text-sm text-gray-500">
                  <span>
                    共 {catalogRows.length} 个模型，第 {catalogPage}/
                    {catalogPageCount} 页
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={catalogPage <= 1}
                      onClick={() => setCatalogPage((page) => page - 1)}
                    >
                      上一页
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={catalogPage >= catalogPageCount}
                      onClick={() => setCatalogPage((page) => page + 1)}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              </div>
            )
          ) : filteredManualSources.length === 0 ? (
            <Empty>还没有手动 API 来源。</Empty>
          ) : (
            <ManualSourcesTable
              sources={filteredManualSources}
              rows={allRows.filter(
                (row): row is Extract<AllModelRow, { sourceType: "manual" }> =>
                  row.sourceType === "manual",
              )}
              favoriteNames={
                new Set(favorites.map((favorite) => favorite.normalizedName))
              }
              testingIds={testingIds}
              prices={priceForManual}
              expandedIds={expandedManualSourceIds}
              onToggleExpanded={(id) =>
                setExpandedManualSourceIds((current) => {
                  const next = new Set(current)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onToggleFavorite={toggleFavorite}
              onTest={benchmarkManual}
              onExport={exportManual}
              onEdit={setEditingManualSource}
              onDelete={setDeletingSource}
            />
          )}
        </>
      )}

      <FavoriteTypeDialog
        draft={favoriteDraft}
        onChange={setFavoriteDraft}
        onClose={() => setFavoriteDraft(null)}
        onSave={saveFavoriteDraft}
      />
      <AccountOverrideDialog
        row={editingAccountRow}
        currentPrice={editingAccountPrice}
        override={editingAccountOverride}
        onClose={() => setEditingAccountRow(null)}
        onSave={saveAccountOverride}
        onClear={clearAccountOverride}
      />
      <BatchTagDialog
        mode={batchTagMode}
        suggestions={availableFavoriteTags}
        onClose={() => setBatchTagMode(null)}
        onApply={applyBatchTags}
      />
      <BatchTestDialog
        rows={batchTestRows}
        progress={batchTestProgress}
        onClose={() => !batchTestProgress && setBatchTestRows(null)}
        onConfirm={() => void confirmBatchTest()}
      />
      <ManualSourceDialog
        source={editingManualSource}
        onClose={() => setEditingManualSource(null)}
        onSaved={handleManualSaved}
      />
      <SourceManagerDialog
        isOpen={isSourceManagerOpen}
        accounts={accounts}
        excludedSourceUrls={excludedSourceUrls}
        onClose={() => setIsSourceManagerOpen(false)}
        onSave={saveExcludedSources}
      />
      <Modal
        isOpen={deletingSource !== null}
        onClose={() => setDeletingSource(null)}
        title="删除手动 API 来源"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeletingSource(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDeleteManual()}
            >
              删除来源
            </Button>
          </div>
        }
      >
        <p className="text-sm text-gray-600">
          将删除“{deletingSource?.name}”及其全部模型行。关联的 API Credential
          Profile 会保留。
        </p>
      </Modal>
      {ccSwitch && (
        <CCSwitchExportDialog
          isOpen
          onClose={() => setCCSwitch(null)}
          account={ccSwitch.account}
          token={ccSwitch.token}
          initialModel={ccSwitch.modelName}
        />
      )}
    </div>
  )
}

function SourceManagerDialog({
  isOpen,
  accounts,
  excludedSourceUrls,
  onClose,
  onSave,
}: {
  isOpen: boolean
  accounts: DisplaySiteData[]
  excludedSourceUrls: Set<string>
  onClose: () => void
  onSave: (urls: Set<string>) => void | Promise<void>
}) {
  const [search, setSearch] = useState("")
  const [draft, setDraft] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (isOpen) {
      setDraft(new Set(excludedSourceUrls))
      setSearch("")
    }
  }, [excludedSourceUrls, isOpen])

  const sources = useMemo(() => {
    const byUrl = new Map<
      string,
      { url: string; names: Set<string>; accountCount: number }
    >()
    for (const account of accounts) {
      const url = normalizeModelHubSourceUrl(account.baseUrl)
      if (!url) continue
      const current = byUrl.get(url) ?? {
        url,
        names: new Set<string>(),
        accountCount: 0,
      }
      current.names.add(account.name)
      current.accountCount += 1
      byUrl.set(url, current)
    }
    const query = search.trim().toLowerCase()
    return [...byUrl.values()]
      .filter(
        (source) =>
          !query ||
          source.url.includes(query) ||
          [...source.names].some((name) => name.toLowerCase().includes(query)),
      )
      .sort((left, right) =>
        [...left.names][0].localeCompare([...right.names][0], "zh-CN"),
      )
  }, [accounts, search])

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="模型筛选来源管理"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void onSave(draft)}>保存</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-500">
          关闭聚合站等无须比较的来源，仅影响模型筛选页面。
        </p>
        <div className="flex gap-2">
          <label className="relative flex-1">
            <Search className="absolute top-2.5 left-3 h-4 w-4 text-gray-400" />
            <Input
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索中转站或 URL"
            />
          </label>
          <Button variant="outline" onClick={() => setDraft(new Set())}>
            全部参与
          </Button>
        </div>
        <div className="max-h-[55vh] divide-y divide-gray-200 overflow-y-auto rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
          {sources.map((source) => {
            const enabled = !draft.has(source.url)
            return (
              <label
                key={source.url}
                className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                <Checkbox
                  checked={enabled}
                  onCheckedChange={(checked) => {
                    const next = new Set(draft)
                    if (checked === true) next.delete(source.url)
                    else next.add(source.url)
                    setDraft(next)
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">
                    {[...source.names].join(" / ")}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {source.url} · {source.accountCount} 个账号
                  </span>
                </span>
                <Badge variant={enabled ? "secondary" : "outline"}>
                  {enabled ? "参与筛选" : "已排除"}
                </Badge>
              </label>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

function FavoriteTable({
  rows,
  prices,
  benchmarks,
  testingIds,
  selectedIds,
  onSelectionChange,
  overrides,
  onTest,
  onExport,
  onEdit,
  onTokenChange,
}: {
  rows: FavoriteOffering[]
  prices: (row: FavoriteOffering) => ModelHubPriceView
  benchmarks: ModelHubBenchmarkResultStore
  testingIds: Set<string>
  selectedIds: Set<string>
  onSelectionChange: (ids: Set<string>) => void
  overrides: ModelHubManualOverrideStore
  onTest: (row: FavoriteOffering) => void
  onExport: (row: FavoriteOffering) => void
  onEdit: (row: FavoriteOffering) => void
  onTokenChange: (row: AccountOffering, tokenId: number) => void
}) {
  const priceHeader =
    rows[0]?.type === "text" ? "输入价格" : rows[0] ? "调用价格" : "价格"

  return (
    <Table
      tableClassName="table-fixed min-w-[1100px]"
      columnWidths={[
        "44px",
        "170px",
        "200px",
        "210px",
        "76px",
        "96px",
        "56px",
        "60px",
        "170px",
      ]}
      headers={[
        "选择",
        "中转站/账号",
        "分组",
        "使用密钥",
        "分组倍率",
        priceHeader,
        "首字",
        "速度",
        "管理",
      ]}
    >
      {rows.map((row) => {
        const price = prices(row)
        const benchmark = benchmarks[row.id]
        const selectedToken =
          row.sourceType === "account" ? row.selectedToken : undefined
        const compatibleTokens =
          row.sourceType === "account" ? row.compatibleTokens ?? [] : []
        const usableTokenCount = compatibleTokens.filter(isTokenUsable).length
        const accountTokenUnavailable =
          row.sourceType === "account" && !row.selectedTokenUsable
        return (
          <tr
            key={row.id}
            className="border-t border-gray-100 dark:border-gray-800"
          >
            <Cell>
              <Checkbox
                checked={selectedIds.has(row.id)}
                disabled={accountTokenUnavailable}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds)
                  if (checked === true) next.add(row.id)
                  else next.delete(row.id)
                  onSelectionChange(next)
                }}
              />
            </Cell>
            <Cell>
              <div className="max-w-52 space-y-1">
                {row.baseUrl ? (
                  <a
                    className="block truncate font-medium text-blue-600 hover:underline"
                    href={row.baseUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={row.providerName}
                  >
                    {row.providerName}
                  </a>
                ) : (
                  <span className="block truncate" title={row.providerName}>
                    {row.providerName}
                  </span>
                )}
                <p className="truncate text-xs text-gray-500">
                  {row.sourceType === "account"
                    ? `${row.accountUsername || "未命名账号"} · 账号 `
                    : "手动来源 · "}
                  <span
                    className={balanceTextClass(
                      row.balanceUsd,
                      row.sourceType === "account"
                        ? row.balanceKnown
                        : row.balanceUsd !== null,
                    )}
                    title={
                      row.sourceType === "account"
                        ? `账号余额 ${formatBalance(row.balanceUsd, row.balanceKnown)}`
                        : `手动来源余额 ${formatBalance(row.balanceUsd, row.balanceUsd !== null)}`
                    }
                  >
                    {formatBalance(
                      row.balanceUsd,
                      row.sourceType === "account"
                        ? row.balanceKnown
                        : row.balanceUsd !== null,
                    )}
                  </span>
                </p>
              </div>
            </Cell>
            <Cell>
              <div className="max-w-full min-w-0 space-y-1 overflow-hidden">
                <div className="flex min-w-0 flex-wrap gap-1">
                  <Badge
                    className="max-w-full min-w-0"
                    variant="secondary"
                    title={row.groupName}
                  >
                    <span className="truncate">{row.groupName}</span>
                  </Badge>
                  {row.sourceType === "manual" && (
                    <Badge variant="outline">手动 API</Badge>
                  )}
                  {(overrides[row.id]?.tags ?? []).map((tag) => (
                    <Badge
                      key={tag}
                      className="max-w-full min-w-0"
                      variant="outline"
                      title={tag}
                    >
                      <span className="truncate">{tag}</span>
                    </Badge>
                  ))}
                </div>
                {row.groupDescription && (
                  <p
                    className="truncate text-xs text-gray-500"
                    title={row.groupDescription}
                  >
                    {row.groupDescription}
                  </p>
                )}
              </div>
            </Cell>
            <Cell>
              {row.sourceType === "account" ? (
                <div className="max-w-full min-w-0 space-y-1 overflow-hidden">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <KeyRound className="h-3.5 w-3.5 shrink-0" />
                    {compatibleTokens.length > 1 ? (
                      <select
                        className="h-7 min-w-0 flex-1 truncate rounded border border-gray-300 bg-white px-1.5 text-xs dark:border-gray-700 dark:bg-gray-900"
                        value={selectedToken?.id ?? ""}
                        title={selectedToken?.name}
                        onChange={(event) =>
                          onTokenChange(row, Number(event.target.value))
                        }
                      >
                        {compatibleTokens.map((token) => (
                          <option
                            key={token.id}
                            value={token.id}
                            disabled={
                              usableTokenCount > 0 && !isTokenUsable(token)
                            }
                          >
                            {token.name || `密钥 ${token.id}`} ·{" "}
                            {formatQuota(
                              token.remain_quota,
                              token.unlimited_quota,
                            )}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className="truncate text-sm font-medium"
                        title={selectedToken?.name}
                      >
                        {selectedToken?.name ||
                          (selectedToken ? `密钥 ${selectedToken.id}` : "--")}
                      </span>
                    )}
                  </div>
                  {selectedToken && (
                    <p
                      className={`truncate text-xs ${row.selectedTokenUsable ? "text-gray-500" : "text-red-600"}`}
                      title={
                        isTokenExpired(selectedToken)
                          ? "密钥已过期"
                          : `已用 ${formatQuota(selectedToken.used_quota, false)} · ${isTokenQuotaExhausted(selectedToken) ? "额度耗尽" : `剩余 ${formatQuota(selectedToken.remain_quota, selectedToken.unlimited_quota)}`}${compatibleTokens.length > 1 ? ` · ${usableTokenCount} 个可用密钥` : ""}`
                      }
                    >
                      {isTokenExpired(selectedToken)
                        ? "密钥已过期"
                        : `已用 ${formatQuota(selectedToken.used_quota, false)} · ${isTokenQuotaExhausted(selectedToken) ? "额度耗尽" : `剩余 ${formatQuota(selectedToken.remain_quota, selectedToken.unlimited_quota)}`}${compatibleTokens.length > 1 ? ` · ${usableTokenCount} 个可用` : ""}`}
                    </p>
                  )}
                </div>
              ) : (
                <span className="text-xs text-gray-500">手动 API</span>
              )}
            </Cell>
            <Cell>{formatRatio(row.groupRatio)}</Cell>
            <Cell>
              <Price value={price} />
            </Cell>
            <Cell>
              {benchmark?.status === "failed" ? (
                <span
                  className="cursor-help text-red-600 dark:text-red-400"
                  title={benchmark.errorSummary ?? "测试失败"}
                >
                  失败
                </span>
              ) : benchmark?.firstTokenMs !== undefined ? (
                `${(benchmark.firstTokenMs / 1000).toFixed(1)} s`
              ) : (
                "--"
              )}
            </Cell>
            <Cell>
              {benchmark?.overallTokensPerSecond !== undefined
                ? `${Math.round(benchmark.overallTokensPerSecond)} t/s`
                : "--"}
            </Cell>
            <Cell>
              <div className="flex gap-0.5 whitespace-nowrap">
                <Button
                  className="px-2"
                  size="sm"
                  variant="ghost"
                  loading={testingIds.has(row.id)}
                  disabled={row.type !== "text" || accountTokenUnavailable}
                  onClick={() => onTest(row)}
                >
                  测试
                </Button>
                <Button
                  className="px-2"
                  size="sm"
                  variant="ghost"
                  disabled={accountTokenUnavailable}
                  onClick={() => onExport(row)}
                >
                  导入 CCS
                </Button>
                <Button
                  className="px-2"
                  size="sm"
                  variant="ghost"
                  onClick={() => onEdit(row)}
                >
                  编辑
                </Button>
              </div>
            </Cell>
          </tr>
        )
      })}
    </Table>
  )
}

function CatalogTable({
  rows,
  accountRows,
  favoriteNames,
  prices,
  manualPrices,
  expandedNames,
  onToggleExpanded,
  onToggleFavorite,
}: {
  rows: AggregatedModelCatalogRow[]
  accountRows: AccountOffering[]
  favoriteNames: Set<string>
  prices: (row: AccountOffering) => ModelHubPriceView
  manualPrices: (
    row: Extract<AllModelRow, { sourceType: "manual" }>,
  ) => ModelHubPriceView
  expandedNames: Set<string>
  onToggleExpanded: (normalizedName: string) => void
  onToggleFavorite: (
    row: Pick<AllModelRow, "modelName" | "normalizedName" | "type">,
  ) => void
}) {
  const accountById = new Map(accountRows.map((row) => [row.id, row]))
  return (
    <Table
      headers={[
        "收藏",
        "模型",
        "类型",
        "来源",
        "可用分组",
        "最低价格",
        "更新时间",
        "操作",
      ]}
    >
      {rows.flatMap((row) => {
        const isFavorite = favoriteNames.has(row.normalizedName)
        const expanded = expandedNames.has(row.normalizedName)
        const sourceText = [
          row.accountSourceCount ? `${row.accountSourceCount} 个账号` : "",
          row.manualSourceCount ? `${row.manualSourceCount} 个手动来源` : "",
        ]
          .filter(Boolean)
          .join(" + ")
        const main = (
          <tr
            key={row.id}
            className="border-t border-gray-100 dark:border-gray-800"
          >
            <Cell>
              <Button
                size="icon-xs"
                variant="ghost"
                title={isFavorite ? "取消收藏" : "收藏"}
                onClick={() => onToggleFavorite(row)}
              >
                <Star
                  className={isFavorite ? "fill-amber-400 text-amber-500" : ""}
                />
              </Button>
            </Cell>
            <Cell>
              <span className="font-medium text-gray-900 dark:text-white">
                {row.modelName}
              </span>
            </Cell>
            <Cell>
              <Badge variant="outline">{typeLabel(row.type)}</Badge>
            </Cell>
            <Cell>{sourceText || "--"}</Cell>
            <Cell>{row.groupCount}</Cell>
            <Cell>
              {row.lowestPriceUsd === null
                ? "价格未知"
                : `$${row.lowestPriceUsd.toFixed(4)} 起`}
            </Cell>
            <Cell>{row.updatedAt ? formatDate(row.updatedAt) : "--"}</Cell>
            <Cell>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onToggleExpanded(row.normalizedName)}
              >
                {expanded ? "收起来源" : `查看来源 ${row.offerings.length}`}
              </Button>
            </Cell>
          </tr>
        )
        if (!expanded) return [main]
        const details = (
          <tr
            key={`${row.id}:details`}
            className="bg-gray-50/70 dark:bg-gray-900/40"
          >
            <td colSpan={8} className="px-4 py-2">
              <div className="divide-y divide-gray-200 dark:divide-gray-700">
                {row.offerings.map((offering) => {
                  const account =
                    offering.sourceType === "account"
                      ? accountById.get(offering.id)
                      : undefined
                  const price = account
                    ? prices(account)
                    : offering.sourceType === "manual"
                      ? manualPrices(offering)
                      : null
                  const priceText = price?.primaryText
                    ? `${price.primaryText}${price.unitText ?? ""}${price.isEstimated ? "（估算）" : ""}`
                    : "价格未知"
                  return (
                    <div
                      key={offering.id}
                      className="grid gap-2 py-2 text-xs text-gray-600 sm:grid-cols-[minmax(150px,1fr)_minmax(130px,1fr)_80px_110px_140px] dark:text-gray-300"
                    >
                      <span className="font-medium">
                        {offering.providerName}
                      </span>
                      <span>{offering.groupName}</span>
                      <span>{formatRatio(offering.groupRatio)}</span>
                      <span>
                        {offering.sourceType === "account"
                          ? "账号自动"
                          : "手动 API"}
                      </span>
                      <span>{priceText}</span>
                    </div>
                  )
                })}
              </div>
            </td>
          </tr>
        )
        return [main, details]
      })}
    </Table>
  )
}

function ManualSourcesTable({
  sources,
  rows,
  favoriteNames,
  testingIds,
  prices,
  expandedIds,
  onToggleExpanded,
  onToggleFavorite,
  onTest,
  onExport,
  onEdit,
  onDelete,
}: {
  sources: ModelHubManualSource[]
  rows: Array<Extract<AllModelRow, { sourceType: "manual" }>>
  favoriteNames: Set<string>
  testingIds: Set<string>
  prices: (
    row: Extract<AllModelRow, { sourceType: "manual" }>,
  ) => ModelHubPriceView
  expandedIds: Set<string>
  onToggleExpanded: (sourceId: string) => void
  onToggleFavorite: (
    row: Pick<AllModelRow, "modelName" | "normalizedName" | "type">,
  ) => void
  onTest: (row: Extract<AllModelRow, { sourceType: "manual" }>) => void
  onExport: (row: Extract<AllModelRow, { sourceType: "manual" }>) => void
  onEdit: (source: ModelHubManualSource) => void
  onDelete: (source: ModelHubManualSource) => void
}) {
  const rowsBySource = new Map<
    string,
    Array<Extract<AllModelRow, { sourceType: "manual" }>>
  >()
  for (const row of rows) {
    const current = rowsBySource.get(row.manualSourceId) ?? []
    current.push(row)
    rowsBySource.set(row.manualSourceId, current)
  }
  return (
    <Table
      headers={[
        "来源名称",
        "API 地址",
        "分组",
        "模型数",
        "倍率",
        "余额",
        "更新时间",
        "操作",
      ]}
    >
      {sources.flatMap((source) => {
        const expanded = expandedIds.has(source.id)
        const sourceRows = rowsBySource.get(source.id) ?? []
        const main = (
          <tr
            key={source.id}
            className="border-t border-gray-100 dark:border-gray-800"
          >
            <Cell>
              <span className="font-medium text-gray-900 dark:text-white">
                {source.name}
              </span>
            </Cell>
            <Cell>
              <a
                className="text-blue-600 hover:underline"
                href={source.normalizedBaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                {source.normalizedBaseUrl}
              </a>
            </Cell>
            <Cell>
              <div className="max-w-64 space-y-1">
                <Badge variant="secondary">{source.groupName}</Badge>
                {source.groupDescription && (
                  <p
                    className="truncate text-xs text-gray-500"
                    title={source.groupDescription}
                  >
                    {source.groupDescription}
                  </p>
                )}
              </div>
            </Cell>
            <Cell>{source.models.length}</Cell>
            <Cell>{formatRatio(source.groupRatio ?? null)}</Cell>
            <Cell>
              {formatBalance(
                source.balanceUsd ?? null,
                source.balanceUsd !== undefined,
              )}
            </Cell>
            <Cell>{formatDate(source.updatedAt)}</Cell>
            <Cell>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onToggleExpanded(source.id)}
                >
                  {expanded ? "收起模型" : "查看模型"}
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="编辑来源"
                  onClick={() => onEdit(source)}
                >
                  <Pencil />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="删除来源"
                  onClick={() => onDelete(source)}
                >
                  <Trash2 />
                </Button>
              </div>
            </Cell>
          </tr>
        )
        if (!expanded) return [main]
        const details = (
          <tr
            key={`${source.id}:models`}
            className="bg-gray-50/70 dark:bg-gray-900/40"
          >
            <td colSpan={8} className="px-4 py-2">
              <div className="divide-y divide-gray-200 dark:divide-gray-700">
                {sourceRows.map((row) => {
                  const isFavorite = favoriteNames.has(row.normalizedName)
                  const price = prices(row)
                  return (
                    <div
                      key={row.id}
                      className="grid items-center gap-2 py-2 text-xs sm:grid-cols-[32px_minmax(180px,1fr)_80px_150px_240px]"
                    >
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title={isFavorite ? "取消收藏" : "收藏"}
                        onClick={() => onToggleFavorite(row)}
                      >
                        <Star
                          className={
                            isFavorite ? "fill-amber-400 text-amber-500" : ""
                          }
                        />
                      </Button>
                      <span className="font-medium">{row.modelName}</span>
                      <span>{typeLabel(row.type)}</span>
                      <span>
                        {price.primaryText
                          ? `${price.primaryText}${price.unitText}${price.isEstimated ? "（估算）" : ""}`
                          : row.type === "text"
                            ? "无法估算"
                            : "价格未填写"}
                      </span>
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={testingIds.has(row.id)}
                          disabled={row.type !== "text"}
                          onClick={() => onTest(row)}
                        >
                          测试
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onExport(row)}
                        >
                          导入 CCS
                        </Button>
                      </span>
                    </div>
                  )
                })}
              </div>
            </td>
          </tr>
        )
        return [main, details]
      })}
    </Table>
  )
}

function FavoriteTypeDialog({
  draft,
  onChange,
  onClose,
  onSave,
}: {
  draft: { modelName: string; type: ModelHubModelType } | null
  onChange: (draft: { modelName: string; type: ModelHubModelType }) => void
  onClose: () => void
  onSave: () => void
}) {
  return (
    <Modal
      isOpen={draft !== null}
      onClose={onClose}
      title="收藏模型"
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onSave}>收藏</Button>
        </div>
      }
    >
      <FormField
        label="模型类型"
        description={`为 ${draft?.modelName ?? ""} 选择计费分类`}
      >
        <select
          className="h-9 w-full rounded border border-gray-300 bg-white px-3 dark:border-gray-700 dark:bg-gray-900"
          value={draft?.type ?? "text"}
          onChange={(event) =>
            draft &&
            onChange({
              ...draft,
              type: event.target.value as ModelHubModelType,
            })
          }
        >
          {TYPE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </FormField>
    </Modal>
  )
}

function AccountOverrideDialog({
  row,
  currentPrice,
  override,
  onClose,
  onSave,
  onClear,
}: {
  row: AccountOffering | null
  currentPrice: ModelHubPriceView | null
  override?: ModelHubManualOverride
  onClose: () => void
  onSave: (
    row: AccountOffering,
    value: Omit<ModelHubManualOverride, "updatedAt">,
  ) => Promise<void>
  onClear: (row: AccountOffering) => Promise<void>
}) {
  const [ratio, setRatio] = useState("")
  const [input, setInput] = useState("")
  const [output, setOutput] = useState("")
  const [perCallPrice, setPerCallPrice] = useState("")
  const [billingUnit, setBillingUnit] =
    useState<ModelHubBillingUnit>("token-million")
  const [tags, setTags] = useState("")
  const [ratioDirty, setRatioDirty] = useState(false)
  const [inputDirty, setInputDirty] = useState(false)
  const [outputDirty, setOutputDirty] = useState(false)
  const [perCallPriceDirty, setPerCallPriceDirty] = useState(false)
  const [billingUnitDirty, setBillingUnitDirty] = useState(false)
  useEffect(() => {
    const resolvedBillingUnit =
      override?.manualBillingUnit ??
      (currentPrice?.billingMode === "per-call"
        ? currentPrice.billingUnit
        : "token-million")
    setRatio(
      override?.manualMultiplier?.toString() ??
        row?.groupRatio?.toString() ??
        "",
    )
    setInput(
      override?.manualInputPriceUsd?.toString() ??
        currentPrice?.inputUsd?.toString() ??
        "",
    )
    setOutput(
      override?.manualOutputPriceUsd?.toString() ??
        currentPrice?.outputUsd?.toString() ??
        "",
    )
    setPerCallPrice(
      override?.manualPriceUsd?.toString() ??
        (currentPrice?.billingMode === "per-call"
          ? currentPrice.usdAmount?.toString() ?? ""
          : ""),
    )
    setBillingUnit(resolvedBillingUnit)
    setTags(override?.tags.join(", ") ?? "")
    setRatioDirty(false)
    setInputDirty(false)
    setOutputDirty(false)
    setPerCallPriceDirty(false)
    setBillingUnitDirty(false)
  }, [currentPrice, override, row])
  const isTokenPrice = billingUnit === "token-million"
  const billingUnitOptions =
    row?.type === "image"
      ? BILLING_OPTIONS.filter(([value]) =>
          ["image", "request", "token-million"].includes(value),
        )
      : row?.type === "video"
        ? BILLING_OPTIONS.filter(([value]) =>
            [
              "video-second",
              "video-minute",
              "request",
              "token-million",
            ].includes(value),
          )
        : row?.type === "other"
          ? BILLING_OPTIONS.filter(([value]) =>
              ["request", "token-million"].includes(value),
            )
          : [["token-million", "百万 Token"]]
  const save = () => {
    if (!row) return
    const manualInput = inputDirty
      ? nonNegative(input)
      : override?.manualInputPriceUsd
    const manualOutput = outputDirty
      ? nonNegative(output)
      : override?.manualOutputPriceUsd
    const manualPerCallPrice = perCallPriceDirty
      ? nonNegative(perCallPrice)
      : override?.manualPriceUsd
    const hasTokenPriceOverride =
      manualInput !== undefined || manualOutput !== undefined
    const hasPerCallPriceOverride = manualPerCallPrice !== undefined
    void onSave(row, {
      aliases: override?.aliases ?? [],
      manualMultiplier: ratioDirty
        ? nonNegative(ratio) ?? null
        : override?.manualMultiplier ?? null,
      manualPriceUsd: isTokenPrice ? null : manualPerCallPrice ?? null,
      manualInputPriceUsd: isTokenPrice ? manualInput ?? null : null,
      manualOutputPriceUsd: isTokenPrice ? manualOutput ?? null : null,
      manualBillingUnit:
        isTokenPrice && hasTokenPriceOverride
          ? "token-million"
          : !isTokenPrice && (hasPerCallPriceOverride || billingUnitDirty)
            ? billingUnit
            : null,
      tags: tags
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
      note: override?.note ?? "",
    })
  }
  return (
    <Modal
      isOpen={row !== null}
      onClose={onClose}
      title="编辑账号模型"
      size="md"
      footer={
        <div className="flex w-full justify-between">
          <Button variant="ghost" onClick={() => row && void onClear(row)}>
            清除修正
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button onClick={save}>保存</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">分组设置</h3>
          <FormField
            label="分组倍率"
            description="修改后作用于该账号的整个分组"
          >
            <Input
              value={ratio}
              onChange={(e) => {
                setRatio(e.target.value)
                setRatioDirty(true)
              }}
              inputMode="decimal"
            />
          </FormField>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">模型价格</h3>
          {row?.type !== "text" && (
            <FormField label="计费单位">
              <select
                className="h-9 w-full rounded border border-gray-300 bg-white px-3 dark:border-gray-700 dark:bg-gray-900"
                value={billingUnit}
                onChange={(event) => {
                  setBillingUnit(event.target.value as ModelHubBillingUnit)
                  setBillingUnitDirty(true)
                }}
              >
                {billingUnitOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          {isTokenPrice ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="输入价格（USD / 百万 Token）">
                <Input
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value)
                    setInputDirty(true)
                  }}
                  inputMode="decimal"
                />
              </FormField>
              <FormField label="输出价格（USD / 百万 Token）">
                <Input
                  value={output}
                  onChange={(e) => {
                    setOutput(e.target.value)
                    setOutputDirty(true)
                  }}
                  inputMode="decimal"
                />
              </FormField>
            </div>
          ) : (
            <FormField label="调用价格（USD）">
              <Input
                value={perCallPrice}
                onChange={(e) => {
                  setPerCallPrice(e.target.value)
                  setPerCallPriceDirty(true)
                }}
                inputMode="decimal"
              />
            </FormField>
          )}
        </div>
        <div>
          <FormField label="标签">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  )
}

function BatchTagDialog({
  mode,
  suggestions,
  onClose,
  onApply,
}: {
  mode: "add" | "remove" | null
  suggestions: string[]
  onClose: () => void
  onApply: (tags: string[], mode: "add" | "remove") => Promise<void>
}) {
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  useEffect(() => setValue(""), [mode])
  const tags = value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return (
    <Modal
      isOpen={mode !== null}
      onClose={onClose}
      title={mode === "add" ? "批量添加标签" : "批量移除标签"}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            loading={saving}
            disabled={tags.length === 0}
            onClick={() => {
              if (!mode || tags.length === 0) return
              setSaving(true)
              void onApply(tags, mode).finally(() => setSaving(false))
            }}
          >
            确定
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="标签" description="多个标签使用逗号分隔">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="例如：福利, 稳定"
          />
        </FormField>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {suggestions.map((tag) => (
              <Button
                key={tag}
                size="sm"
                variant="ghost"
                onClick={() =>
                  setValue((current) =>
                    current.trim() ? `${current}, ${tag}` : tag,
                  )
                }
              >
                {tag}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function BatchTestDialog({
  rows,
  progress,
  onClose,
  onConfirm,
}: {
  rows: FavoriteOffering[] | null
  progress: { completed: number; total: number } | null
  onClose: () => void
  onConfirm: () => void
}) {
  const testable = rows?.filter((row) => row.type === "text") ?? []
  return (
    <Modal
      isOpen={rows !== null}
      onClose={onClose}
      title="批量测试确认"
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            disabled={Boolean(progress)}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            disabled={testable.length === 0 || Boolean(progress)}
            onClick={onConfirm}
          >
            确认测试 {testable.length} 项
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
        <p>
          将向 {testable.length}{" "}
          个候选来源分别发送一次真实请求，测试会产生实际费用。
        </p>
        <p>请求并发数限制为 2；缺少可用密钥的来源会记录为失败。</p>
        {progress && (
          <div className="rounded-md bg-blue-50 px-3 py-2 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
            正在测试 {progress.completed}/{progress.total}
          </div>
        )}
      </div>
    </Modal>
  )
}

function ManualSourceDialog({
  source,
  onClose,
  onSaved,
}: {
  source: ModelHubManualSource | "new" | null
  onClose: () => void
  onSaved: (source: ModelHubManualSource) => void
}) {
  const existing = source && source !== "new" ? source : null
  const [name, setName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [groupName, setGroupName] = useState("")
  const [groupDescription, setGroupDescription] = useState("")
  const [groupRatio, setGroupRatio] = useState("")
  const [balance, setBalance] = useState("")
  const [models, setModels] = useState<ManualModelDraft[]>([])
  const [isDetecting, setIsDetecting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    if (!source) return
    void (async () => {
      const profile = existing
        ? await apiCredentialProfilesStorage.getProfileById(existing.profileId)
        : null
      setName(existing?.name ?? "")
      setBaseUrl(profile?.baseUrl ?? existing?.normalizedBaseUrl ?? "")
      setApiKey(profile?.apiKey ?? "")
      setGroupName(existing?.groupName ?? "通用")
      setGroupDescription(existing?.groupDescription ?? "")
      setGroupRatio(existing?.groupRatio?.toString() ?? "")
      setBalance(existing?.balanceUsd?.toString() ?? "")
      setModels(
        existing?.models.map((model) => ({
          id: randomId("model"),
          modelName: model.modelName,
          type: model.type,
          priceUsd: model.priceUsd?.toString() ?? "",
          billingUnit: model.billingUnit ?? "unknown",
        })) ?? [],
      )
      setError(
        profile || !existing
          ? ""
          : `来源“${existing.name}”对应的 API Credential Profile 不存在，请重新填写 API Key 后保存`,
      )
    })()
  }, [existing, source])

  const credential = async () => {
    const profile = existing
      ? await apiCredentialProfilesStorage.getProfileById(existing.profileId)
      : null
    const key = apiKey.trim() || profile?.apiKey || ""
    if (!name.trim() || !baseUrl.trim() || !key || !groupName.trim())
      throw new Error("中转站名称、API 地址、API Key 和分组名称为必填项")
    return { profile, key }
  }
  const detect = async () => {
    setIsDetecting(true)
    setError("")
    try {
      const { profile, key } = await credential()
      const modelIds = await fetchApiCredentialModelIds({
        apiType: profile?.apiType ?? API_TYPES.OPENAI_COMPATIBLE,
        baseUrl,
        apiKey: key,
      })
      const current = new Map(
        models.map((model) => [
          normalizeModelHubModelName(model.modelName),
          model,
        ]),
      )
      setModels(
        modelIds.map(
          (modelName) =>
            current.get(normalizeModelHubModelName(modelName)) ?? {
              id: randomId("model"),
              modelName,
              type: inferModelHubModelType(modelName),
              priceUsd: "",
              billingUnit: "unknown",
            },
        ),
      )
      toast.success(`已获取 ${modelIds.length} 个模型`)
    } catch (cause) {
      setError(
        `检测来源“${name || "未命名"}”（${baseUrl || "未填写 URL"}）失败：${sanitizeBenchmarkError(cause)}`,
      )
    } finally {
      setIsDetecting(false)
    }
  }
  const save = async () => {
    setIsSaving(true)
    setError("")
    try {
      const { profile, key } = await credential()
      const normalizedModels = new Map<string, ModelHubManualSourceModel>()
      for (const model of models) {
        const modelName = model.modelName.trim()
        const normalizedName = normalizeModelHubModelName(modelName)
        if (!normalizedName) continue
        normalizedModels.set(normalizedName, {
          modelName,
          normalizedName,
          type: model.type,
          ...(nonNegative(model.priceUsd) !== undefined
            ? { priceUsd: nonNegative(model.priceUsd) }
            : {}),
          billingUnit: model.billingUnit,
        })
      }
      if (!normalizedModels.size) throw new Error("至少需要一个模型")
      const savedProfile = profile
        ? await apiCredentialProfilesStorage.updateProfile(profile.id, {
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          })
        : await apiCredentialProfilesStorage.createProfile({
            name: name.trim(),
            apiType: API_TYPES.OPENAI_COMPATIBLE,
            baseUrl: baseUrl.trim(),
            apiKey: key,
            tagIds: [],
            notes: "Model Hub 手动来源",
          })
      const now = Date.now()
      const saved = await saveModelHubManualSource({
        id: existing?.id ?? randomId("model-hub-source"),
        profileId: savedProfile.id,
        name: name.trim(),
        normalizedBaseUrl: savedProfile.baseUrl
          .toLowerCase()
          .replace(/\/+$/, ""),
        groupName: groupName.trim(),
        ...(groupDescription.trim()
          ? { groupDescription: groupDescription.trim() }
          : {}),
        ...(groupRatio.trim() ? { groupRatio: nonNegative(groupRatio) } : {}),
        ...(balance.trim() ? { balanceUsd: nonNegative(balance) } : {}),
        models: [...normalizedModels.values()],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      onSaved(saved)
      toast.success(existing ? "手动来源已更新" : "手动来源已添加")
    } catch (cause) {
      setError(sanitizeBenchmarkError(cause))
    } finally {
      setIsSaving(false)
    }
  }
  const addModel = () =>
    setModels((current) => [
      ...current,
      {
        id: randomId("model"),
        modelName: "",
        type: "text",
        priceUsd: "",
        billingUnit: "unknown",
      },
    ])
  return (
    <Modal
      isOpen={source !== null}
      onClose={onClose}
      title={existing ? "编辑手动 API 来源" : "手动添加 API 来源"}
      size="xl"
      footer={
        <div className="flex w-full justify-between">
          <Button
            variant="secondary"
            leftIcon={<RefreshCw />}
            loading={isDetecting}
            onClick={() => void detect()}
          >
            检测并获取模型
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button loading={isSaving} onClick={() => void save()}>
              保存来源
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="中转站名称 *">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label="API 地址 *">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com"
            />
          </FormField>
          <FormField
            label="API Key *"
            description={apiKey ? `当前密钥：${maskSecret(apiKey)}` : undefined}
          >
            <Input
              type="password"
              revealable
              revealLabels={{ show: "显示完整密钥", hide: "隐藏完整密钥" }}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
            />
          </FormField>
          <FormField label="分组名称 *">
            <Input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
          </FormField>
          <div className="sm:col-span-2">
            <FormField
              label="分组备注"
              description="常用模型列表中只显示一行，悬停查看全文"
            >
              <Input
                value={groupDescription}
                onChange={(e) => setGroupDescription(e.target.value)}
                placeholder="例如：原生模型、低延迟、每日补量"
              />
            </FormField>
          </div>
          <FormField label="分组倍率">
            <Input
              value={groupRatio}
              onChange={(e) => setGroupRatio(e.target.value)}
              inputMode="decimal"
              placeholder="可空，允许 0"
            />
          </FormField>
          <FormField label="中转站余额（USD）">
            <Input
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              inputMode="decimal"
              placeholder="可空，允许 0"
            />
          </FormField>
        </div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">模型列表</h3>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Plus />}
            onClick={addModel}
          >
            添加模型
          </Button>
        </div>
        <div className="space-y-2">
          {models.map((model) => (
            <div
              key={model.id}
              className="grid gap-2 rounded border border-gray-200 p-2 sm:grid-cols-[minmax(180px,1fr)_110px_130px_140px_32px] dark:border-gray-700"
            >
              <Input
                value={model.modelName}
                onChange={(e) =>
                  setModels((current) =>
                    current.map((item) =>
                      item.id === model.id
                        ? { ...item, modelName: e.target.value }
                        : item,
                    ),
                  )
                }
                placeholder="模型名称"
              />
              <select
                className="h-9 rounded border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                value={model.type}
                onChange={(e) =>
                  setModels((current) =>
                    current.map((item) =>
                      item.id === model.id
                        ? { ...item, type: e.target.value as ModelHubModelType }
                        : item,
                    ),
                  )
                }
              >
                {TYPE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Input
                value={model.priceUsd}
                onChange={(e) =>
                  setModels((current) =>
                    current.map((item) =>
                      item.id === model.id
                        ? { ...item, priceUsd: e.target.value }
                        : item,
                    ),
                  )
                }
                inputMode="decimal"
                placeholder="价格（可选）"
              />
              <select
                className="h-9 rounded border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                value={model.billingUnit}
                onChange={(e) =>
                  setModels((current) =>
                    current.map((item) =>
                      item.id === model.id
                        ? {
                            ...item,
                            billingUnit: e.target.value as ModelHubBillingUnit,
                          }
                        : item,
                    ),
                  )
                }
              >
                {BILLING_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Button
                size="icon-xs"
                variant="ghost"
                title="删除模型"
                onClick={() =>
                  setModels((current) =>
                    current.filter((item) => item.id !== model.id),
                  )
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

function Table({
  headers,
  children,
  tableClassName,
  columnWidths,
}: {
  headers: string[]
  children: ReactNode
  tableClassName?: string
  columnWidths?: string[]
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
      <table
        className={`w-full text-left text-sm ${tableClassName ?? "min-w-[980px]"}`}
      >
        {columnWidths && (
          <colgroup>
            {columnWidths.map((width, index) => (
              <col key={`${index}-${width}`} style={{ width }} />
            ))}
          </colgroup>
        )}
        <thead className="bg-gray-50 text-xs text-gray-500 dark:bg-gray-900">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-3 py-3 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
function Cell({ children }: { children: ReactNode }) {
  return (
    <td className="px-3 py-3 align-middle text-gray-700 dark:text-gray-200">
      {children}
    </td>
  )
}
function Price({ value }: { value: ModelHubPriceView }) {
  const billingLabel =
    value.billingMode === "token"
      ? "中转站标注：按量计费"
      : "中转站标注：按次计费"
  const sourceLabel =
    value.status === "manual"
      ? "手动修正价格"
      : value.isEstimated
        ? "官方倍率估算价格"
        : value.status === "exact"
          ? "中转站模型目录价格"
          : "价格未知"
  const title = [sourceLabel, billingLabel, value.manualNote]
    .filter(Boolean)
    .join(" · ")
  return (
    <span title={title}>
      {value.primaryText ? `${value.primaryText}${value.unitText ?? ""}` : "--"}
      {value.isEstimated && (
        <span className="ml-1 text-xs text-gray-400">估</span>
      )}
    </span>
  )
}
function Loading() {
  return (
    <div className="flex min-h-48 items-center justify-center">
      <Spinner />
    </div>
  )
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-gray-300 px-4 text-center text-sm text-gray-500 dark:border-gray-700">
      {children}
    </div>
  )
}
function SelectControl({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: string[][]
}) {
  return (
    <select
      className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-900"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  )
}

export default ModelHub
