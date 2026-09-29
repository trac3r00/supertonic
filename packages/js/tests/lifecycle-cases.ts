import { expect, test } from "bun:test"
import { createPipelineEngine, type InferenceAdapter } from "../src/index.js"

class SlowAdapter implements InferenceAdapter<readonly string[], string> {
  closeCount = 0
  startedResolve: (() => void) | undefined
  releaseResolve: (() => void) | undefined
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })
  readonly release = new Promise<void>((resolve) => {
    this.releaseResolve = resolve
  })

  async load(): Promise<void> {}
  async prepareText(texts: readonly string[]): Promise<readonly string[]> {
    return texts
  }
  async predictDuration(): Promise<Float32Array> {
    return new Float32Array([0.3])
  }
  async encodeText(): Promise<string> {
    return "embedding"
  }
  async estimateVector(noisyLatent: Float32Array): Promise<Float32Array> {
    this.startedResolve?.()
    await this.release
    return noisyLatent.slice()
  }
  async vocode(): Promise<readonly Float32Array[]> {
    return [new Float32Array([0.1, 0.2, 0.3])]
  }
  capabilities() {
    return {
      configuredProvider: "cpu",
      actualProvider: "cpu",
      graphPlacement: null,
      device: "host",
      dtype: "float32",
      threadBudgets: {},
      cancellationGranularity: ["between_denoising"],
      supportStatus: "implemented" as const,
    }
  }
  async close(): Promise<void> {
    this.closeCount += 1
  }
}

const rawStyle = {
  style_ttl: { dims: [1, 2, 2], data: [0, 0, 0, 0] },
  style_dp: { dims: [1, 2, 2], data: [0, 0, 0, 0] },
}

export function registerLifecycleCases(): void {
  test("close cancels cooperatively and waits for the active native operation", async () => {
    const adapter = new SlowAdapter()
    const engine = createPipelineEngine({
      adapter,
      config: {
        sampleRate: 10,
        baseChunkSize: 2,
        chunkCompressFactor: 2,
        latentDimension: 1,
        model: { name: "m", revision: "r" },
        provider: { configured: "cpu", actual: "cpu", dtype: "float32" },
      },
    })
    const synthesis = engine.synthesize({
      text: "Hello.",
      language: "en",
      voice_style: rawStyle,
      steps: 1,
      speed: 1,
      silence_seconds: 0,
      provider: "cpu",
      allow_fallback: false,
    })
    await adapter.started
    const closing = engine.close()
    let secondCloseResolved = false
    const closingAgain = engine.close().then(() => {
      secondCloseResolved = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(adapter.closeCount).toBe(0)
    expect(secondCloseResolved).toBeFalse()
    adapter.releaseResolve?.()
    const [synthesisResult, closeResult, secondCloseResult] = await Promise.allSettled([
      synthesis,
      closing,
      closingAgain,
    ])
    expect(synthesisResult.status).toBe("rejected")
    expect(closeResult.status).toBe("fulfilled")
    expect(secondCloseResult.status).toBe("fulfilled")
    expect(adapter.closeCount).toBe(1)
  })
}
