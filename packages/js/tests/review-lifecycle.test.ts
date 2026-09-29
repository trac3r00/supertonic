import { expect, test } from "bun:test"
import {
  createPipelineEngine,
  type InferenceAdapter,
  type PipelineConfig,
  type ProgressEvent,
  SupertonicError,
} from "../src/index.js"

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const config: PipelineConfig = {
  sampleRate: 10,
  baseChunkSize: 2,
  chunkCompressFactor: 2,
  latentDimension: 1,
  model: { name: "m", revision: "r" },
  provider: { configured: "cpu", actual: "cpu", dtype: "float32" },
}
const style = {
  style_ttl: { dims: [1, 1, 1], data: [1] },
  style_dp: { dims: [1, 1, 1], data: [1] },
}
const request = (text = "Hi.") => ({
  text,
  language: "en",
  voice_style: style,
  steps: 1,
  speed: 1,
  silence_seconds: 0,
  provider: "cpu",
  allow_fallback: false,
  seed: 42,
})

class Adapter implements InferenceAdapter<readonly string[], string> {
  loads = 0
  prepares = 0
  durations: readonly number[] = [0.3]
  latents: Float32Array[] = []
  masks: Float32Array[] = []
  async load(_signal: AbortSignal, _progress: (event: ProgressEvent) => void): Promise<void> {
    this.loads += 1
  }
  async prepareText(texts: readonly string[]): Promise<readonly string[]> {
    this.prepares += 1
    return texts
  }
  async predictDuration(): Promise<Float32Array> {
    return Float32Array.from(this.durations)
  }
  async encodeText(): Promise<string> {
    return "embedding"
  }
  async estimateVector(
    latent: Float32Array,
    _shape: readonly [number, number, number],
    mask: Float32Array,
  ): Promise<Float32Array> {
    this.masks.push(mask.slice())
    this.latents.push(latent.slice())
    return Float32Array.from(latent, () => 1)
  }
  async vocode(
    _latent: Float32Array,
    shape: readonly [number, number, number],
  ): Promise<readonly Float32Array[]> {
    return Array.from({ length: shape[0] }, () =>
      Float32Array.of(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5),
    )
  }
  capabilities() {
    return {
      configuredProvider: "cpu",
      actualProvider: "cpu",
      graphPlacement: null,
      device: "host",
      dtype: "float32",
      threadBudgets: {},
      cancellationGranularity: [],
      supportStatus: "implemented" as const,
    }
  }
  async close(): Promise<void> {}
}

function engine(
  adapter: Adapter,
  overrides: Partial<PipelineConfig> = {},
  extras: Record<string, unknown> = {},
) {
  return createPipelineEngine({
    adapter,
    config: { ...config, ...overrides },
    requestId: () => "r1",
    ...extras,
  })
}

test("close waits for public load to settle without reopening engine", async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  const adapter = new Adapter()
  let closed = false
  let loadSettled = false
  adapter.load = async () => {
    started.resolve()
    await release.promise
    loadSettled = true
  }
  adapter.close = async () => {
    if (!loadSettled) throw new Error("adapter closed during load")
    closed = true
  }
  const runtime = engine(adapter)
  const loading = runtime.load()
  await started.promise
  const closing = runtime.close()
  expect(closed).toBeFalse()
  release.resolve()
  await Promise.allSettled([loading, closing])
  expect(closed).toBeTrue()
  await expect(runtime.load()).rejects.toMatchObject({ code: "ENGINE_CLOSED" })
})

test("close from a synchronous loading progress callback waits for load to settle", async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  const adapter = new Adapter()
  let closing: Promise<void> | undefined
  let loadSettled = false
  let closed = false
  adapter.load = async (_signal, progress) => {
    progress({ kind: "loading", component: "graph", completed: 0, total: 1 })
    started.resolve()
    await release.promise
    loadSettled = true
  }
  adapter.close = async () => {
    if (!loadSettled) throw new Error("adapter closed during load")
    closed = true
  }
  const runtime = engine(
    adapter,
    {},
    {
      onProgress: () => {
        if (closing === undefined) closing = runtime.close()
      },
    },
  )
  const loading = runtime.load()
  await started.promise
  expect(closing).toBeDefined()
  release.resolve()
  await Promise.allSettled([loading])
  await closing
  expect(closed).toBeTrue()
})

test("batch checks normalized scalar support before loading", async () => {
  const adapter = new Adapter()
  const runtime = engine(adapter, {}, { supportedCodepoint: (cp: number) => cp !== 0x20000 })
  await expect(runtime.synthesizeBatch([request("Hi."), request("𠀀")])).rejects.toMatchObject({
    code: "UNSUPPORTED_CHARACTER",
    stage: "indexing",
  })
  expect(adapter.loads).toBe(0)
})

test("configured raw scalar limit applies to single and batch admission", async () => {
  const adapter = new Adapter()
  const runtime = engine(adapter, { maxRawScalars: 3 })
  await expect(runtime.synthesize(request("Four"))).rejects.toMatchObject({
    code: "RESOURCE_EXHAUSTED",
    stage: "text_admission",
  })
  await expect(runtime.synthesizeBatch([request("Hi"), request("Four")])).rejects.toMatchObject({
    code: "RESOURCE_EXHAUSTED",
    stage: "text_admission",
  })
  expect(adapter.loads).toBe(0)
})

test("capabilities fails after close", async () => {
  const runtime = engine(new Adapter())
  await runtime.close()
  expect(() => runtime.capabilities()).toThrowError(
    expect.objectContaining({ code: "ENGINE_CLOSED" }),
  )
})

test("provider selection and fallback are not silently ignored", async () => {
  const adapter = new Adapter()
  const runtime = engine(adapter)
  await expect(runtime.synthesize({ ...request(), provider: "cuda" })).rejects.toMatchObject({
    code: "PROVIDER_UNAVAILABLE",
  })
  await expect(
    runtime.synthesizeBatch([{ ...request(), provider: "cuda", allow_fallback: true }]),
  ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" })
  expect(adapter.loads).toBe(0)
})

test("mixed batch style, speed, step count, and seed cannot reuse the first item's settings", async () => {
  const adapter = new Adapter()
  const runtime = engine(adapter)
  const variants = [
    { ...request(), voice_style: { ...style, style_ttl: { ...style.style_ttl, data: [2] } } },
    { ...request(), voice_style: { ...style, style_dp: { ...style.style_dp, data: [2] } } },
    { ...request(), speed: 1.5 },
    { ...request(), steps: 2 },
    { ...request(), silence_seconds: 0.5 },
    { ...request(), seed: 43 },
  ]
  for (const other of variants) {
    await expect(runtime.synthesizeBatch([request(), other])).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      stage: "batch_admission",
    })
  }
  expect(adapter.loads).toBe(0)
})

test("duration mask is passed to denoiser and applied to padded tail each step", async () => {
  const adapter = new Adapter()
  adapter.durations = [0.7, 0.2]
  const runtime = engine(adapter, {}, { noise: { fill: (target: Float32Array) => target.fill(3) } })
  await runtime.synthesizeBatch([
    { ...request(), steps: 2 },
    { ...request("Hey."), steps: 2 },
  ])
  expect(adapter.masks).toEqual([Float32Array.of(1, 1, 1, 0), Float32Array.of(1, 1, 1, 0)])
  expect(adapter.latents).toEqual([
    Float32Array.of(3, 3, 3, 3, 3, 0, 3, 0),
    Float32Array.of(1, 1, 1, 1, 1, 0, 1, 0),
  ])
})

test("materialization stops collecting when the sample limit is exceeded", async () => {
  const adapter = new Adapter()
  const runtime = engine(adapter, { maxMaterializedSeconds: 0.5 })
  await expect(
    runtime.synthesize({
      ...request("One. Two. Three."),
      silence_seconds: 0.2,
      chunk_limit: 6,
    }),
  ).rejects.toMatchObject({
    code: "RESOURCE_EXHAUSTED",
    message: "materialized audio limit exceeded",
    stage: "audio_admission",
    requestId: "r1",
  })
  expect(adapter.prepares).toBe(2)
})

test("seed repeats default noise on the same engine", async () => {
  const adapter = new Adapter()
  const runtime = engine(adapter)
  await runtime.synthesize(request())
  await runtime.synthesize(request())
  await runtime.synthesize({ ...request(), seed: 43 })
  expect(adapter.latents).toHaveLength(3)
  expect(adapter.latents[0]).toEqual(adapter.latents[1] ?? new Float32Array())
  expect(adapter.latents[0]).not.toEqual(adapter.latents[2])
})

test("load errors retain their code with request metadata", async () => {
  const adapter = new Adapter()
  adapter.load = async () => {
    throw new Error("missing model")
  }
  const runtime = engine(adapter)
  await expect(runtime.synthesize(request())).rejects.toMatchObject({
    code: "INFERENCE_FAILED",
    stage: "load",
    requestId: "r1",
  })
  adapter.load = async () => {
    throw new SupertonicError("MODEL_NOT_FOUND", "missing", "model_load", "load", false)
  }
  await expect(runtime.synthesizeBatch([request()])).rejects.toMatchObject({
    code: "MODEL_NOT_FOUND",
    stage: "model_load",
    requestId: "r1",
  })
})
