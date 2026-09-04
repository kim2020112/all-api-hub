import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  aggregateModelCatalogRows,
  buildAllModelRows,
  buildFavoriteAccountCandidates,
  filterAllModelRows,
  projectManualSourceOfferings,
  type AccountOfferingProjection,
} from "~/features/ModelHub/modelHubData"
import {
  createModelHubTestResultKey,
  getModelHubBenchmarkResults,
  getModelHubManualOverrides,
  getModelHubManualSources,
  getModelHubTestGroups,
  normalizeManualSource,
  normalizeModelHubPreferences,
  normalizeModelHubSourceUrl,
  normalizeModelHubTestGroups,
  removeModelHubManualSource,
  removeModelHubTestBenchmarkResults,
  saveModelHubBenchmarkResults,
  saveModelHubManualOverride,
  saveModelHubManualSource,
  updateModelHubTestGroups,
  type ModelHubManualSource,
} from "~/features/ModelHub/storage"

const storageData = new Map<string, unknown>()

vi.mock("@plasmohq/storage", () => ({
  Storage: class {
    async get(key: string) {
      return storageData.get(key)
    }
    async set(key: string, value: unknown) {
      storageData.set(key, value)
    }
  },
}))

const accountRow: AccountOfferingProjection = {
  id: "account:a:vip:gpt-5",
  sourceType: "account",
  accountId: "a",
  sourceId: "token-a",
  modelName: "GPT-5",
  normalizedName: "gpt-5",
  type: "text",
  providerName: "Account A",
  groupName: "VIP",
  groupRatio: 0,
  balanceUsd: 0,
  updatedAt: 10,
}

const manualSource: ModelHubManualSource = {
  id: "manual-a",
  profileId: "profile-a",
  name: "Manual A",
  normalizedBaseUrl: "https://manual.example.com",
  groupName: "VIP",
  groupRatio: 0,
  balanceUsd: 0,
  models: [
    {
      modelName: "GPT-5",
      normalizedName: "gpt-5",
      type: "text",
      priceUsd: 0,
      billingUnit: "request",
    },
    { modelName: "Flux Pro", normalizedName: "flux pro", type: "image" },
  ],
  createdAt: 1,
  updatedAt: 20,
}

describe("Model Hub data flow", () => {
  beforeEach(() => storageData.clear())

  it("builds common-model candidates from accounts only", () => {
    const candidates = buildFavoriteAccountCandidates(
      [accountRow],
      [{ modelName: "GPT-5", normalizedName: "gpt-5", type: "text" }],
    )
    expect(candidates).toEqual([accountRow])
    expect(projectManualSourceOfferings([manualSource])).toHaveLength(2)
  })

  it("projects manual models only into all-model rows with stable unique keys", () => {
    const rows = buildAllModelRows([accountRow], [manualSource])
    expect(rows.map((row) => row.sourceType)).toEqual([
      "account",
      "manual",
      "manual",
    ])
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
  })

  it("aggregates duplicate offerings into one model catalog row", () => {
    const rows = buildAllModelRows([accountRow], [manualSource])
    const catalog = aggregateModelCatalogRows(rows, (row) =>
      row.sourceType === "manual" ? row.priceUsd ?? null : 0.5,
    )

    expect(catalog).toHaveLength(2)
    expect(catalog.find((row) => row.normalizedName === "gpt-5")).toMatchObject(
      {
        accountSourceCount: 1,
        manualSourceCount: 1,
        providerCount: 2,
        groupCount: 2,
        lowestPriceUsd: 0,
      },
    )
  })

  it("filters all-model rows by source and saved type", () => {
    const rows = buildAllModelRows([accountRow], [manualSource])
    expect(
      filterAllModelRows(rows, {
        search: "",
        source: "manual",
        type: "image",
      }).map((row) => row.modelName),
    ).toEqual(["Flux Pro"])
    expect(
      filterAllModelRows(rows, {
        search: "account a",
        source: "account",
        type: "all",
      }),
    ).toEqual([accountRow])
  })

  it("migrates legacy favorites, saves type, de-duplicates names, and migrates groups view", () => {
    const preferences = normalizeModelHubPreferences({
      viewMode: "groups",
      favoriteModels: [
        " GPT-5 ",
        "gpt-5",
        { modelName: "Flux Pro", type: "image" },
      ],
    })
    expect(preferences.viewMode).toBe("all")
    expect(preferences.favoriteModels).toEqual([
      { modelName: "GPT-5", normalizedName: "gpt-5", type: "text" },
      { modelName: "Flux Pro", normalizedName: "flux pro", type: "image" },
    ])
    expect(preferences.sortMode).toBe("multiplier-asc")
    expect(preferences.excludedSourceUrls).toEqual([])
    expect(preferences.selectedTokenIds).toEqual({})
  })

  it("normalizes and de-duplicates excluded source URLs", () => {
    expect(normalizeModelHubSourceUrl(" HTTPS://Relay.Example.com/// ")).toBe(
      "https://relay.example.com",
    )
    expect(
      normalizeModelHubPreferences({
        excludedSourceUrls: [
          "https://relay.example.com/",
          " HTTPS://RELAY.EXAMPLE.COM ",
          "",
        ],
      }).excludedSourceUrls,
    ).toEqual(["https://relay.example.com"])
  })

  it("preserves only valid selected token ids", () => {
    expect(
      normalizeModelHubPreferences({
        selectedTokenIds: {
          "account:a:default:gpt-5": 12,
          invalid: -1,
          decimal: 1.5,
          text: "3",
        },
      }).selectedTokenIds,
    ).toEqual({ "account:a:default:gpt-5": 12 })
  })

  it("migrates test groups with a selected model and stable result key", () => {
    const groups = normalizeModelHubTestGroups({
      "account:a:vip": {
        providerName: "Account A",
        groupName: "VIP",
        sourceType: "account",
        sourceId: "a",
        models: [{ modelName: "GPT-5", enabled: true }],
      },
    })
    expect(groups["account:a:vip"].selectedModel).toBe("gpt-5")
    expect(createModelHubTestResultKey("account:a:vip", " GPT-5 ")).toBe(
      "test:account%3Aa%3Avip:gpt-5",
    )
  })

  it("drops legacy archived test groups when normalizing", () => {
    const groups = normalizeModelHubTestGroups({
      "account:a:vip": {
        providerName: "Account A",
        groupName: "VIP",
        sourceType: "account",
        sourceId: "a",
        models: [{ modelName: "GPT-5", enabled: true }],
      },
      "account:b:vip": {
        providerName: "Account B",
        groupName: "VIP",
        sourceType: "account",
        sourceId: "b",
        models: [{ modelName: "GPT-5", enabled: true }],
        archived: true,
      },
    })
    expect(Object.keys(groups)).toEqual(["account:a:vip"])
    expect(groups["account:a:vip"]).not.toHaveProperty("archived")
  })

  it("persists test group deletion", async () => {
    await updateModelHubTestGroups(() => ({
      "account:a:vip": {
        id: "account:a:vip",
        sourceType: "account",
        sourceId: "a",
        providerName: "Account A",
        baseUrl: "https://a.example.com",
        groupName: "VIP",
        groupRatio: null,
        priceUsd: null,
        balanceUsd: null,
        models: [
          {
            modelName: "GPT-5",
            normalizedName: "gpt-5",
            type: "text",
            enabled: true,
          },
        ],
        selectedModel: "gpt-5",
        order: 0,
        updatedAt: 1,
      },
    }))

    const remaining = await updateModelHubTestGroups((current) => {
      const next = { ...current }
      delete next["account:a:vip"]
      return next
    })

    expect(remaining).toEqual({})
    expect(await getModelHubTestGroups()).toEqual({})
  })

  it("removes only the deleted group's benchmark results", async () => {
    const result = { status: "success", testedAt: 5 } as const
    await saveModelHubBenchmarkResults({
      [createModelHubTestResultKey("account:a:vip", "gpt-5")]: result,
      [createModelHubTestResultKey("account:a:vip", "claude-4")]: result,
      [createModelHubTestResultKey("account:b:vip", "gpt-5")]: result,
      "account:a:vip:gpt-5": result,
    })

    const next = await removeModelHubTestBenchmarkResults(["account:a:vip"])

    expect(Object.keys(next).sort()).toEqual([
      "account:a:vip:gpt-5",
      createModelHubTestResultKey("account:b:vip", "gpt-5"),
    ])
    expect(await getModelHubBenchmarkResults()).toEqual(next)
  })

  it("preserves multiplier sorting and zero-valued manual multipliers", async () => {
    expect(
      normalizeModelHubPreferences({ sortMode: "multiplier-asc" }).sortMode,
    ).toBe("multiplier-asc")

    await saveModelHubManualOverride("offering-a", {
      aliases: [],
      manualMultiplier: 0,
      tags: [],
      note: "",
    })
    expect((await getModelHubManualOverrides())["offering-a"]).toMatchObject({
      manualMultiplier: 0,
    })
  })

  it("normalizes source models and accepts zero-valued ratio, balance, and price", () => {
    const normalized = normalizeManualSource({
      ...manualSource,
      models: [
        manualSource.models[0],
        { ...manualSource.models[0], modelName: " gpt-5 " },
      ],
    })
    expect(normalized).toMatchObject({ groupRatio: 0, balanceUsd: 0 })
    expect(normalized?.models).toHaveLength(1)
    expect(normalized?.models[0]).toMatchObject({
      normalizedName: "gpt-5",
      priceUsd: 0,
    })
  })

  it("saves, edits, reads, and deletes manual sources independently", async () => {
    await saveModelHubManualSource(manualSource)
    expect((await getModelHubManualSources())[manualSource.id].name).toBe(
      "Manual A",
    )
    await saveModelHubManualSource({ ...manualSource, name: "Manual B" })
    expect((await getModelHubManualSources())[manualSource.id].name).toBe(
      "Manual B",
    )
    await removeModelHubManualSource(manualSource.id)
    expect(await getModelHubManualSources()).toEqual({})
  })

  it("does not subscribe to or auto-load all credential profiles", () => {
    const source = readFileSync(
      new URL("../../../src/features/ModelHub/ModelHub.tsx", import.meta.url),
      "utf8",
    )
    expect(source).not.toContain("useApiCredentialProfiles")
    expect(source).not.toContain("loadProfileCatalog")
    expect(source).not.toContain("profiles.map")
    expect(source).not.toContain("quality")
  })
})
