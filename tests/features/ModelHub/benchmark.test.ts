import { afterEach, describe, expect, it, vi } from "vitest"

import {
  calculateBenchmarkMetrics,
  runModelHubConnectivityCheck,
} from "~/features/ModelHub/benchmark"

afterEach(() => vi.restoreAllMocks())

describe("calculateBenchmarkMetrics", () => {
  it("calculates first-token latency from request start", () => {
    expect(
      calculateBenchmarkMetrics({
        requestStartedAt: 1_000,
        firstContentAt: 4_000,
        finishedAt: 5_000,
      }).firstTokenMs,
    ).toBe(3_000)
  })

  it("calculates token speed only from API completion tokens", () => {
    const result = calculateBenchmarkMetrics({
      requestStartedAt: 1_000,
      firstContentAt: 2_000,
      finishedAt: 4_000,
      completionTokens: 48,
    })
    expect(result.overallTokensPerSecond).toBe(16)
    expect(result.generationTokensPerSecond).toBe(24)
    expect(result.completionTokens).toBe(48)
  })

  it("does not estimate token speed without usage", () => {
    expect(
      calculateBenchmarkMetrics({
        requestStartedAt: 1_000,
        firstContentAt: 2_000,
        finishedAt: 4_000,
      }).overallTokensPerSecond,
    ).toBeUndefined()
  })

  it("marks a configured model missing while keeping the endpoint reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "other-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )
    await expect(
      runModelHubConnectivityCheck({
        baseUrl: "https://relay.example.com",
        apiKey: "secret",
        expectedModel: "target-model",
      }),
    ).resolves.toMatchObject({ status: "model-missing", modelCount: 1 })
  })

  it("normalizes a v1 base URL without duplicating the path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "target-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await runModelHubConnectivityCheck({
      baseUrl: "https://relay.example.com/v1/",
      apiKey: "secret",
      expectedModel: "target-model",
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://relay.example.com/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer secret" },
      }),
    )
  })
})
