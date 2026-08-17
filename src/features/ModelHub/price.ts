/**
 * ModelHub 价格解析工具（纯函数，无 React 依赖）
 *
 * 展示优先级（由用户规格定义，从高到低）：
 *   1. 手工价格覆盖（manualPriceUsd / manualInputPriceUsd / manualOutputPriceUsd）
 *   2. 中转站精确价格（CHANNEL_PRICING + exact 或其他 exact 来源）
 *   3. 官方倍率估算（OFFICIAL_RATE_ESTIMATE + estimated）
 *   4. 仅倍率（可算出价格，但无来源标记）
 *   5. 完全未知（价格未知）
 *
 * 计价单位推断（ModelBillingUnit）：
 *   - 手工单位手动指定优先；
 *   - quota_type = token 固定 token-million；
 *   - quota_type = per-call 时先用 ModelMetadata.modalities.output
 *     推断 image / video / audio，无法确认一律回退 request（「每次」），
 *     绝不擅自显示「每张」。
 */

import { UI_CONSTANTS } from "~/constants/ui"
import {
  MODEL_PRICE_PRECISION_KINDS,
  MODEL_PRICE_SOURCE_KINDS,
  type ModelPriceMetadata,
  type ModelPricing,
} from "~/services/modelList/pricingModel"
import type { ModelMetadata } from "~/services/models/modelMetadata/types"
import {
  formatPriceCompact,
  isTokenBillingType,
  resolvePriceAmount,
} from "~/services/models/utils/modelPricing"
import type { CurrencyType } from "~/types"

import { adaptModelListPrice } from "./modelListPriceAdapter"
import type { ModelHubBillingUnit, ModelHubManualOverride } from "./storage"

export type ModelHubPriceStatus =
  | "manual"
  | "exact"
  | "estimated"
  | "unavailable"

export interface ModelHubPriceView {
  /** 主价格文本，如 $0.50（数值部分已按显示货币换算） */
  primaryText: string
  /** 单位后缀，如 "/M tokens"、"/张"、"/秒"、"/次"、"" */
  unitText: string
  /** 原始美元数值（用于排序），无价格时为 null */
  usdAmount: number | null
  /** 价格状态标记 */
  status: ModelHubPriceStatus
  /** 计价单位 */
  billingUnit: ModelHubBillingUnit
  /** 按次/按 token 的计费模式 */
  billingMode: "token" | "per-call"
  /** 是否展示估算标记 */
  isEstimated: boolean
  /** 手工备注（仅手工价格存在时） */
  manualNote?: string
  inputUsd?: number
  outputUsd?: number
}

const MODEL_HUB_UNIT_SUFFIX: Record<ModelHubBillingUnit, string> = {
  "token-million": "/M",
  image: "/张",
  "video-second": "/秒",
  "video-minute": "/分钟",
  request: "/次",
  unknown: "",
}

export const MODEL_HUB_DISPLAY_UNITS: ReadonlyArray<{
  value: ModelHubBillingUnit
  label: string
}> = [
  { value: "token-million", label: "$ / 1M tokens" },
  { value: "image", label: "$ / 张" },
  { value: "video-second", label: "$ / 秒" },
  { value: "video-minute", label: "$ / 分钟" },
  { value: "request", label: "$ / 次" },
]

export function formatModelHubUnit(unit: ModelHubBillingUnit): string {
  return MODEL_HUB_UNIT_SUFFIX[unit]
}

export function isManualOverridden(override?: ModelHubManualOverride | null) {
  if (!override) return false
  return (
    (typeof override.manualPriceUsd === "number" &&
      Number.isFinite(override.manualPriceUsd) &&
      override.manualPriceUsd >= 0) ||
    (typeof override.manualInputPriceUsd === "number" &&
      Number.isFinite(override.manualInputPriceUsd) &&
      override.manualInputPriceUsd >= 0) ||
    (typeof override.manualOutputPriceUsd === "number" &&
      Number.isFinite(override.manualOutputPriceUsd) &&
      override.manualOutputPriceUsd >= 0)
  )
}

/**
 * 从模型元数据推断 per-call 计价单位。
 * 不确定时回退 request（「每次」），绝不猜「每张」。
 */
export function inferBillingUnitFromMetadata(
  metadata: ModelMetadata | undefined,
  manualFallback: ModelHubBillingUnit,
): ModelHubBillingUnit {
  const outputModalities = metadata?.modalities?.output ?? []
  if (outputModalities.includes("image")) return "image"
  if (outputModalities.includes("video")) return "video-second"
  if (outputModalities.includes("audio")) return "request"
  return manualFallback
}

interface ManualUsdPrices {
  single?: number
  input?: number
  output?: number
}

function resolveManualUsdPrices(
  override: ModelHubManualOverride,
  cnyPerUsd: number,
): ManualUsdPrices {
  const sourceCurrency = override.manualCurrency === "CNY" ? "CNY" : "USD"
  const exchangeRate =
    Number.isFinite(cnyPerUsd) && cnyPerUsd > 0
      ? cnyPerUsd
      : UI_CONSTANTS.EXCHANGE_RATE.DEFAULT
  const toUsd = (value: number | null | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return undefined
    }
    return sourceCurrency === "CNY" ? value / exchangeRate : value
  }

  const single = toUsd(override.manualPriceUsd)
  const input = toUsd(override.manualInputPriceUsd)
  const output = toUsd(override.manualOutputPriceUsd)
  return {
    ...(single !== undefined ? { single } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}

/** 解析手工价格的美元金额；数字或 {input, output} 对象均支持。 */
export function resolveManualUsdAmount(
  override: ModelHubManualOverride,
  cnyPerUsd: number = UI_CONSTANTS.EXCHANGE_RATE.DEFAULT,
): number | null {
  const prices = resolveManualUsdPrices(override, cnyPerUsd)
  const values = [prices.single, prices.input, prices.output].filter(
    (value): value is number => value !== undefined,
  )
  return values.length > 0 ? Math.max(...values) : null
}

/**
 * 依据数据情况取价格状态：
 *   手工覆盖存在 -> manual
 *   precision exact -> exact
 *   estimated     -> estimated
 *   否则          -> unavailable
 */
export function getModelHubPriceStatus(params: {
  hasManualOverride: boolean
  priceMetadata?: ModelPriceMetadata
}): ModelHubPriceStatus {
  const { hasManualOverride, priceMetadata } = params
  if (hasManualOverride) return "manual"
  if (priceMetadata?.source === MODEL_PRICE_SOURCE_KINDS.NONE) {
    return "unavailable"
  }
  if (priceMetadata?.precision === MODEL_PRICE_PRECISION_KINDS.EXACT) {
    return "exact"
  }
  if (priceMetadata?.precision === MODEL_PRICE_PRECISION_KINDS.ESTIMATED) {
    return "estimated"
  }
  return "unavailable"
}

/**
 * ModelHub 价格解析主入口。
 * 输入一个模型定价数据 + 有效分组倍率 + 可选手工覆盖 + 可选元数据，输出展示视图。
 */
export function resolveModelHubPrice(params: {
  model?: ModelPricing
  groupMultiplier: number
  modelMultiplierOverride?: number | null
  override?: ModelHubManualOverride | null
  metadata?: ModelMetadata
  currency?: CurrencyType
  cnyPerUsd?: number
}): ModelHubPriceView {
  const {
    model,
    groupMultiplier,
    modelMultiplierOverride,
    override,
    metadata,
    currency = "USD",
    cnyPerUsd = UI_CONSTANTS.EXCHANGE_RATE.DEFAULT,
  } = params

  const hasManual = isManualOverridden(override)
  const manualPrices =
    hasManual && override
      ? resolveManualUsdPrices(override, cnyPerUsd)
      : undefined
  const manualUsd =
    hasManual && override ? resolveManualUsdAmount(override, cnyPerUsd) : null
  const manualUnit =
    hasManual && override?.manualBillingUnit ? override.manualBillingUnit : null
  const status = getModelHubPriceStatus({
    hasManualOverride: hasManual,
    priceMetadata: model?.price_metadata,
  })

  const billingMode =
    model && isTokenBillingType(model.quota_type) ? "token" : "per-call"

  const toDisplay = (usd: number) =>
    resolvePriceAmount(usd, currency, cnyPerUsd)

  // 1) 手工价格优先
  if (hasManual && override && manualUsd !== null) {
    const resolvedUnit =
      manualUnit ??
      (billingMode === "token"
        ? "token-million"
        : inferBillingUnitFromMetadata(metadata, "request"))
    return {
      primaryText:
        resolvedUnit === "token-million" && manualPrices
          ? formatPriceCompact(
              toDisplay(manualPrices.input ?? manualPrices.single ?? manualUsd),
              currency,
            )
          : formatPriceCompact(toDisplay(manualUsd), currency),
      unitText: formatModelHubUnit(resolvedUnit),
      usdAmount: manualUsd,
      status: "manual",
      billingUnit: resolvedUnit,
      billingMode,
      isEstimated: false,
      ...(override.manualPriceNote?.trim()
        ? { manualNote: override.manualPriceNote.trim() }
        : {}),
      ...(manualPrices!.input !== undefined
        ? { inputUsd: manualPrices!.input }
        : manualPrices!.single !== undefined && resolvedUnit === "token-million"
          ? { inputUsd: manualPrices!.single }
          : {}),
      ...(manualPrices!.output !== undefined
        ? { outputUsd: manualPrices!.output }
        : {}),
    }
  }

  if (!model) {
    return {
      primaryText: "",
      unitText: "",
      usdAmount: null,
      status: "unavailable",
      billingUnit: "unknown",
      billingMode,
      isEstimated: false,
    }
  }

  // 2) 非手工：复用统一价格计算
  const adapted = adaptModelListPrice(
    model,
    groupMultiplier,
    modelMultiplierOverride,
  )

  if (!adapted) {
    const unit =
      billingMode === "token"
        ? "token-million"
        : inferBillingUnitFromMetadata(metadata, "unknown")
    return {
      primaryText: "",
      unitText: "",
      usdAmount: null,
      status: "unavailable",
      billingUnit: unit,
      billingMode,
      isEstimated: false,
    }
  }

  const automaticStatus = status === "unavailable" ? "exact" : status

  if (billingMode === "token") {
    const input = adapted.inputUsd
    const output = adapted.outputUsd
    const hasInput = input !== undefined && Number.isFinite(input)
    const hasOutput = output !== undefined && Number.isFinite(output)
    return {
      primaryText: hasInput
        ? formatPriceCompact(toDisplay(input), currency)
        : "",
      unitText: formatModelHubUnit("token-million"),
      usdAmount: hasInput ? input : null,
      status: automaticStatus,
      billingUnit: "token-million",
      billingMode: "token",
      isEstimated: automaticStatus === "estimated",
      ...(hasInput ? { inputUsd: input } : {}),
      ...(hasOutput ? { outputUsd: output } : {}),
    }
  }

  // per-call
  if (adapted.perCallUsd !== undefined) {
    const amount = adapted.perCallUsd
    const unit = manualUnit ?? inferBillingUnitFromMetadata(metadata, "request")
    const primaryText = formatPriceCompact(toDisplay(amount), currency)

    return {
      primaryText,
      unitText: formatModelHubUnit(unit),
      usdAmount: amount,
      status: automaticStatus,
      billingUnit: unit,
      billingMode: "per-call",
      isEstimated: automaticStatus === "estimated",
    }
  }

  return {
    primaryText: "",
    unitText: "",
    usdAmount: null,
    status: "unavailable",
    billingUnit: "unknown",
    billingMode,
    isEstimated: false,
  }
}
