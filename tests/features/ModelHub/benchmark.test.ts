import { describe, expect, it } from "vitest"

import { calculateBenchmarkMetrics } from "~/features/ModelHub/benchmark"

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
})
