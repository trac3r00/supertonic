import { describe, expect, test } from "bun:test"
import {
  concatenatePcm,
  createPipelineEngine,
  type InferenceAdapter,
  type ProgressEvent,
  parseSynthesisRequest,
  prepareText,
  roundSampleCount,
  SupertonicError,
} from "../src/index.js"
import { checkAcceptedTextFixtures } from "./fixture-check.js"
import { registerLifecycleCases } from "./lifecycle-cases.js"

class DeterministicAdapter implements InferenceAdapter<readonly string[], string> {
  loadCount = 0
  prepareCount = 0
  inferCount = 0
  closeCount = 0
  durationSeconds = 0.3
  wave = new Float32Array([0.25, -0.5, 0.125])

  async load(): Promise<void> {
    this.loadCount += 1
  }

  async prepareText(texts: readonly string[]): Promise<readonly string[]> {
    this.prepareCount += 1
    return texts
  }

  async predictDuration(prepared: readonly string[]): Promise<Float32Array> {
    this.inferCount += 1
    return new Float32Array(prepared.map(() => this.durationSeconds))
  }

  async encodeText(): Promise<string> {
    return "embedding"
  }

  async estimateVector(noisyLatent: Float32Array): Promise<Float32Array> {
    return noisyLatent.slice()
  }

  async vocode(): Promise<readonly Float32Array[]> {
    return [this.wave]
  }

  capabilities() {
    return {
      configuredProvider: "cpu",
      actualProvider: "cpu",
      graphPlacement: null,
      device: "host",
      dtype: "float32",
      threadBudgets: { intraOp: 1 },
      cancellationGranularity: ["before_chunk", "between_denoising"],
      supportStatus: "implemented" as const,
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1
  }
}

function validRequest(text = "Hello.") {
  return {
    text,
    language: "en",
    voice_style: {
      style_ttl: { dims: [1, 2, 2], data: [0, 0.1, 0.2, 0.3] },
      style_dp: { dims: [1, 2, 2], data: [0, -0.1, -0.2, -0.3] },
    },
    steps: 2,
    speed: 1,
    silence_seconds: 0.25,
    provider: "cpu",
    allow_fallback: false,
    seed: 17,
  }
}

describe("shared pure pipeline", () => {
  test("passes every committed accepted text contract fixture", async () => {
    expect(await checkAcceptedTextFixtures()).toBeGreaterThan(0)
  })

  test("uses committed positive half-up sample rounding", () => {
    expect(roundSampleCount(2.5)).toBe(3)
    expect(roundSampleCount(3.5)).toBe(4)
  })

  test("rejects malformed silence sample counts before PCM allocation", () => {
    const chunks = [Float32Array.of(1), Float32Array.of(2)]
    for (const silenceSamples of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => concatenatePcm(chunks, silenceSamples)).toThrow(SupertonicError)
      try {
        concatenatePcm(chunks, silenceSamples)
      } catch (error) {
        expect(error).toMatchObject({
          code: "INVALID_ARGUMENT",
          stage: "audio_validation",
        })
      }
    }
  })

  test("parses contract fixtures and preserves explicit step precedence", () => {
    const parsed = parseSynthesisRequest({ ...validRequest(), preset: "quality", steps: 7 }, "r1")
    expect(parsed.steps).toBe(7)
    expect(parsed.voiceStyle.styleTtl.data).toBeInstanceOf(Float32Array)
  })

  test("normalizes with pinned Unicode data and chunks sentence-first", () => {
    const prepared = prepareText("Hi—Bob @ home", "en", "r2")
    expect(prepared.normalizedText).toBe("Hi-Bob at home.")
    expect(prepared.wrappedText).toBe("<en>Hi-Bob at home.</en>")
    expect(prepared.normalizedCodepoints).toEqual([
      72, 105, 45, 66, 111, 98, 32, 97, 116, 32, 104, 111, 109, 101, 46,
    ])
    expect(prepareText("One. Two three.", "en", "r3").chunks).toEqual(["One. Two three."])
    expect(prepareText("One. Two three.", "en", "r4", 12).chunks).toEqual(["One.", "Two three."])
  })

  test("runs one coherent DI inference flow with owned valid PCM", async () => {
    const adapter = new DeterministicAdapter()
    const progress: ProgressEvent[] = []
    const engine = createPipelineEngine({
      adapter,
      config: {
        sampleRate: 10,
        baseChunkSize: 2,
        chunkCompressFactor: 2,
        latentDimension: 1,
        model: { name: "Supertone/supertonic-3", revision: "724fb5" },
        provider: { configured: "cpu", actual: "cpu", dtype: "float32" },
      },
      noise: { fill: (target) => target.fill(0.5) },
      requestId: () => "deterministic-request",
      onProgress: (event) => progress.push(event),
    })
    const result = await engine.synthesize(validRequest())
    expect(result.requestId).toBe("deterministic-request")
    expect(result.items[0]?.pcmFloat32).toEqual(new Float32Array([0.25, -0.5, 0.125]))
    expect(result.items[0]?.validSampleCount).toBe(3)
    expect(result.items[0]?.durationSeconds).toBe(0.3)
    expect(result.quality.steps).toBe(2)
    expect(adapter.loadCount).toBe(1)
    expect(adapter.inferCount).toBe(1)
    expect(progress.some((event) => event.kind === "denoising")).toBeTrue()
  })

  test("rejects malformed requests before model creation", async () => {
    const adapter = new DeterministicAdapter()
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
    await expect(engine.synthesize({ ...validRequest(), language: "zh" })).rejects.toMatchObject({
      code: "UNSUPPORTED_LANGUAGE",
      stage: "language_validation",
    })
    expect(adapter.loadCount).toBe(0)
    expect(adapter.prepareCount).toBe(0)
    expect(adapter.inferCount).toBe(0)
  })

  test("closed engines fail with a typed lifecycle error", async () => {
    const adapter = new DeterministicAdapter()
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
    await engine.close()
    await engine.close()
    await expect(engine.synthesize(validRequest())).rejects.toBeInstanceOf(SupertonicError)
    await expect(engine.synthesize(validRequest())).rejects.toMatchObject({ code: "ENGINE_CLOSED" })
    expect(adapter.closeCount).toBe(1)
  })

  test("reports malformed style as STYLE_MISMATCH before model creation", async () => {
    const adapter = new DeterministicAdapter()
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
    const malformed = validRequest()
    malformed.voice_style.style_ttl.data.pop()
    await expect(engine.synthesize(malformed)).rejects.toMatchObject({
      code: "STYLE_MISMATCH",
      stage: "style_validation",
    })
    expect(adapter.loadCount).toBe(0)
  })

  test("honors cancellation before adapter load", async () => {
    const adapter = new DeterministicAdapter()
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
    const controller = new AbortController()
    controller.abort()
    await expect(engine.synthesize(validRequest(), controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    })
    expect(adapter.loadCount).toBe(0)
  })

  test("rejects unsupported post-normalization scalars before model creation", async () => {
    const adapter = new DeterministicAdapter()
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
      supportedCodepoint: (codepoint) => codepoint !== 0x20000,
    })
    await expect(engine.synthesize(validRequest("𠀀"))).rejects.toMatchObject({
      code: "UNSUPPORTED_CHARACTER",
      stage: "indexing",
    })
    expect(adapter.loadCount).toBe(0)
  })

  test("rejects invalid model duration before latent allocation", async () => {
    const adapter = new DeterministicAdapter()
    adapter.durationSeconds = 0
    let allocationCount = 0
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
      noise: {
        fill: () => {
          allocationCount += 1
        },
      },
    })
    await expect(engine.synthesize(validRequest())).rejects.toMatchObject({
      code: "INFERENCE_FAILED",
      stage: "duration_validation",
    })
    expect(allocationCount).toBe(0)
  })

  test("does not report all-zero ordinary speech as success", async () => {
    const adapter = new DeterministicAdapter()
    adapter.wave = new Float32Array([0, 0, 0])
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
    await expect(engine.synthesize(validRequest())).rejects.toMatchObject({
      code: "INFERENCE_FAILED",
      stage: "audio_validation",
    })
  })
})

registerLifecycleCases()
