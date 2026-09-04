/* eslint-disable jsdoc/require-jsdoc */

interface ModelHubBenchmarkMetrics {
  responseHeadersMs?: number
  firstEventMs?: number
  firstTokenMs?: number
  totalDurationMs?: number
  generationDurationMs?: number
  completionTokens?: number
  tokenCountSource?: "usage" | "estimated"
  overallTokensPerSecond?: number
  generationTokensPerSecond?: number
}

export function calculateBenchmarkMetrics(params: {
  requestStartedAt: number
  responseHeadersAt?: number
  firstEventAt?: number
  firstContentAt?: number
  finishedAt: number
  completionTokens?: number
  tokenCountSource?: "usage" | "estimated"
}): ModelHubBenchmarkMetrics {
  const duration = (start: number, end: number | undefined) =>
    end === undefined ? undefined : Math.max(0, end - start)
  const totalDurationMs = duration(params.requestStartedAt, params.finishedAt)
  const generationDurationMs = duration(
    params.firstContentAt ?? params.finishedAt,
    params.finishedAt,
  )
  const validTokens =
    typeof params.completionTokens === "number" &&
    Number.isFinite(params.completionTokens) &&
    params.completionTokens > 0
      ? params.completionTokens
      : undefined
  const perSecond = (tokens: number | undefined, ms: number | undefined) =>
    tokens !== undefined && ms !== undefined && ms > 0
      ? tokens / (ms / 1000)
      : undefined
  return {
    ...(duration(params.requestStartedAt, params.responseHeadersAt) !==
    undefined
      ? {
          responseHeadersMs: duration(
            params.requestStartedAt,
            params.responseHeadersAt,
          ),
        }
      : {}),
    ...(duration(params.requestStartedAt, params.firstEventAt) !== undefined
      ? { firstEventMs: duration(params.requestStartedAt, params.firstEventAt) }
      : {}),
    ...(duration(params.requestStartedAt, params.firstContentAt) !== undefined
      ? {
          firstTokenMs: duration(
            params.requestStartedAt,
            params.firstContentAt,
          ),
        }
      : {}),
    ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
    ...(params.firstContentAt !== undefined &&
    generationDurationMs !== undefined
      ? { generationDurationMs }
      : {}),
    ...(validTokens !== undefined ? { completionTokens: validTokens } : {}),
    ...(validTokens !== undefined && params.tokenCountSource
      ? { tokenCountSource: params.tokenCountSource }
      : {}),
    ...(validTokens !== undefined && totalDurationMs !== undefined
      ? { overallTokensPerSecond: perSecond(validTokens, totalDurationMs) }
      : {}),
    ...(validTokens !== undefined && params.firstContentAt !== undefined
      ? {
          generationTokensPerSecond: perSecond(
            validTokens,
            generationDurationMs,
          ),
        }
      : {}),
  }
}

interface ParsedBenchmarkSseEvent {
  text: string
  isText: boolean
  completionTokens?: number
}

function parseBenchmarkSseData(
  data: string,
): ParsedBenchmarkSseEvent | null {
  if (!data.trim() || data.trim() === "[DONE]") return null
  try {
    const payload = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown } }>
      usage?: Record<string, unknown>
    }
    const text = (payload.choices ?? [])
      .map((choice) =>
        typeof choice.delta?.content === "string" ? choice.delta.content : "",
      )
      .join("")
    const usage = payload.usage ?? {}
    const tokenCandidate = [
      usage.completion_tokens,
      usage.output_tokens,
      usage.completionTokens,
    ].find((value) => typeof value === "number")
    return {
      text,
      isText: text.trim().length > 0,
      ...(typeof tokenCandidate === "number"
        ? { completionTokens: tokenCandidate }
        : {}),
    }
  } catch {
    return null
  }
}

/** Limited, protocol-aware fallback for the fixed numeric benchmark response. */
function estimateNumericBenchmarkTokens(text: string): number | null {
  const normalized = text.trim()
  if (!/^1(?: \d{1,2}){1,79}$/.test(normalized)) return null
  const values = normalized.split(" ").map(Number)
  if (
    values.length !== 80 ||
    values.some((value, index) => value !== index + 1)
  ) {
    return null
  }
  return values.length
}

function completionEndpoint(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, "")
  return /\/v1$/i.test(trimmed)
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`
}

export async function runModelHubBenchmark(params: {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  now?: () => number
}): Promise<ModelHubBenchmarkMetrics> {
  const now = params.now ?? (() => performance.now())
  const requestBody = {
    model: params.model,
    messages: [
      {
        role: "user",
        content:
          "请从1连续输出到80，数字之间只使用一个空格分隔，不要解释，不要换行。",
      },
    ],
    stream: true,
    max_tokens: 256,
    temperature: 0,
  }
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? 60_000,
  )
  try {
    let response: Response | null = null
    let requestStartedAt = now()
    for (const includeUsage of [true, false]) {
      requestStartedAt = now()
      response = await fetch(completionEndpoint(params.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          includeUsage
            ? { ...requestBody, stream_options: { include_usage: true } }
            : requestBody,
        ),
        signal: controller.signal,
      })
      if (response.ok) break
      if (includeUsage && response.status !== 400 && response.status !== 422) {
        throw new Error(`HTTP ${response.status}`)
      }
    }
    if (!response?.ok || !response.body)
      throw new Error(`HTTP ${response?.status ?? 0}`)
    const responseHeadersAt = now()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let firstEventAt: number | undefined
    let firstContentAt: number | undefined
    let completionTokens: number | undefined
    let output = ""
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = done ? "" : lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const event = parseBenchmarkSseData(line.slice(5).trim())
        if (!event) continue
        firstEventAt ??= now()
        if (event.isText) {
          firstContentAt ??= now()
          output += event.text
        }
        if (event.completionTokens !== undefined)
          completionTokens = event.completionTokens
      }
      if (done) break
    }
    const estimated =
      completionTokens === undefined
        ? estimateNumericBenchmarkTokens(output)
        : null
    return calculateBenchmarkMetrics({
      requestStartedAt,
      responseHeadersAt,
      firstEventAt,
      firstContentAt,
      finishedAt: now(),
      completionTokens: completionTokens ?? estimated ?? undefined,
      tokenCountSource:
        completionTokens !== undefined
          ? "usage"
          : estimated !== null
            ? "estimated"
            : undefined,
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function runModelHubConnectivityCheck(params: {
  baseUrl: string
  apiKey: string
  expectedModel?: string
  timeoutMs?: number
}): Promise<{
  status: "reachable" | "model-missing"
  modelCount?: number
  errorSummary?: string
}> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? 5_000,
  )
  try {
    const base = params.baseUrl.replace(/\/+$/, "")
    const modelsEndpoint = /\/v1$/i.test(base)
      ? `${base}/models`
      : `${base}/v1/models`
    const headers = { Authorization: `Bearer ${params.apiKey}` }
    const request = (endpoint: string) =>
      fetch(endpoint, { headers, cache: "no-store", signal: controller.signal })
    const expected = params.expectedModel?.trim()
    const response = await request(modelsEndpoint)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = (await response.json()) as { data?: unknown[] }
    const modelIds = Array.isArray(payload.data)
      ? payload.data.flatMap((item) => {
          if (!item || typeof item !== "object") return []
          const id = (item as { id?: unknown }).id
          return typeof id === "string" ? [id.toLowerCase()] : []
        })
      : []
    const expectedNormalized = expected?.toLowerCase()
    if (
      expectedNormalized &&
      modelIds.length > 0 &&
      !modelIds.includes(expectedNormalized)
    ) {
      return {
        status: "model-missing",
        modelCount: modelIds.length,
        errorSummary: `模型 ${expected} 不在接口目录中`,
      }
    }
    return {
      status: "reachable",
      ...(Array.isArray(payload.data)
        ? { modelCount: payload.data.length }
        : {}),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function sanitizeBenchmarkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/(?:sk|key|token)-[a-z0-9_-]{8,}/gi, "[已脱敏]")
    .replace(/Bearer\s+\S+/gi, "Bearer [已脱敏]")
    .slice(0, 180)
}
