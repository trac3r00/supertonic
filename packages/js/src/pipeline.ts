import { SupertonicError } from "./errors.js"
import { runInference } from "./inference.js"
import { parseSynthesisRequest } from "./request.js"
import { materializeResult } from "./result.js"
import { checkAbort, fillNormalNoise, toPublicError } from "./runtime-utils.js"
import type {
  InferenceAdapter,
  PipelineEngine,
  PipelineOptions,
  SynthesisChunk,
  SynthesisResult,
} from "./types.js"
import { prepareText } from "./unicode.js"

export function createPipelineEngine<TPrepared, TEmbedding>(
  options: PipelineOptions<TPrepared, TEmbedding>,
): PipelineEngine {
  const adapter: InferenceAdapter<TPrepared, TEmbedding> = options.adapter
  const progress = options.onProgress ?? (() => undefined)
  const makeRequestId = options.requestId ?? (() => crypto.randomUUID())
  const noise = options.noise?.fill ?? fillNormalNoise
  let state: "created" | "loading" | "ready" | "closing" | "closed" = "created"
  let loadPromise: Promise<void> | undefined
  let active = false
  let activeDone = Promise.resolve()
  let resolveActive: (() => void) | undefined
  let closePromise: Promise<void> | undefined
  const closeController = new AbortController()

  const ensureOpen = (requestId: string): void => {
    if (state === "closing" || state === "closed") {
      throw new SupertonicError("ENGINE_CLOSED", "engine is closed", "admission", requestId, false)
    }
  }

  const load = async (signal = new AbortController().signal): Promise<void> => {
    ensureOpen("load")
    checkAbort(signal, "load")
    if (state === "ready") return
    if (loadPromise !== undefined) return loadPromise
    state = "loading"
    loadPromise = adapter
      .load(AbortSignal.any([signal, closeController.signal]), progress)
      .then(() => {
        state = "ready"
      })
      .catch((error: unknown) => {
        state = "created"
        throw toPublicError(error, "load")
      })
      .finally(() => {
        loadPromise = undefined
      })
    return loadPromise
  }

  const enter = (requestId: string): void => {
    ensureOpen(requestId)
    if (active) {
      throw new SupertonicError(
        "RESOURCE_EXHAUSTED",
        "engine already has a running request",
        "admission",
        requestId,
        true,
      )
    }
    active = true
    activeDone = new Promise<void>((resolve) => {
      resolveActive = resolve
    })
  }

  const leave = (): void => {
    active = false
    resolveActive?.()
    resolveActive = undefined
  }

  const synthesizeChunks = async function* (
    input: unknown,
    externalSignal = new AbortController().signal,
  ): AsyncIterable<SynthesisChunk> {
    const requestId = makeRequestId()
    const request = parseSynthesisRequest(input, requestId)
    const preparedText = prepareText(request.text, request.language, requestId, request.chunkLimit)
    if (options.supportedCodepoint !== undefined) {
      for (const codepoint of preparedText.normalizedCodepoints) {
        if (!options.supportedCodepoint(codepoint)) {
          throw new SupertonicError(
            "UNSUPPORTED_CHARACTER",
            `unsupported scalar U+${codepoint.toString(16).toUpperCase()}`,
            "indexing",
            requestId,
            false,
          )
        }
      }
    }
    enter(requestId)
    const signal = AbortSignal.any([externalSignal, closeController.signal])
    try {
      checkAbort(signal, requestId)
      await load(signal)
      for (let sequence = 0; sequence < preparedText.chunks.length; sequence += 1) {
        checkAbort(signal, requestId)
        const text = preparedText.chunks[sequence]
        if (text === undefined) continue
        progress({
          kind: "chunk",
          sequence,
          completed: sequence,
          total: preparedText.chunks.length,
        })
        const item = (
          await runInference([request], [text], requestId, signal, sequence, {
            adapter,
            config: options.config,
            progress,
            noise,
          })
        )[0]
        if (item === undefined) {
          throw new SupertonicError(
            "INFERENCE_FAILED",
            "missing inference output",
            "audio_validation",
            requestId,
            false,
          )
        }
        yield { ...item, requestId, sequence, final: sequence === preparedText.chunks.length - 1 }
      }
      progress({ kind: "completed", requestId })
    } catch (error: unknown) {
      throw toPublicError(error, requestId)
    } finally {
      leave()
    }
  }

  const synthesize = async (input: unknown, signal?: AbortSignal): Promise<SynthesisResult> => {
    const chunks: Float32Array[] = []
    let metadata: SynthesisChunk | undefined
    for await (const chunk of synthesizeChunks(input, signal)) {
      chunks.push(chunk.pcmFloat32)
      metadata = chunk
    }
    return materializeResult(
      chunks,
      metadata,
      parseSynthesisRequest(input, metadata?.requestId ?? "request"),
      options.config,
    )
  }

  const synthesizeBatch = async (
    input: unknown,
    signal = new AbortController().signal,
  ): Promise<SynthesisResult> => {
    if (!Array.isArray(input) || input.length === 0) {
      throw new SupertonicError(
        "INVALID_ARGUMENT",
        "batch must be a nonempty array",
        "batch_admission",
        "batch",
        false,
      )
    }
    if (input.length > (options.config.maxBatchItems ?? 32)) {
      throw new SupertonicError(
        "RESOURCE_EXHAUSTED",
        "raw SDK batch exceeds limit",
        "batch_admission",
        "batch",
        false,
      )
    }
    const requestId = makeRequestId()
    const requests = input.map((item) => parseSynthesisRequest(item, requestId))
    const prepared = requests.map((request) =>
      prepareText(request.text, request.language, requestId, request.chunkLimit),
    )
    if (prepared.some((text) => text.chunks.length !== 1)) {
      throw new SupertonicError(
        "RESOURCE_EXHAUSTED",
        "raw SDK batch items must fit one chunk",
        "batch_admission",
        requestId,
        false,
      )
    }
    enter(requestId)
    try {
      await load(signal)
      const items = await runInference(
        requests,
        prepared.map((text) => text.chunks[0] ?? ""),
        requestId,
        signal,
        0,
        { adapter, config: options.config, progress, noise },
      )
      const first = requests[0]
      if (first === undefined)
        throw new SupertonicError(
          "INVALID_ARGUMENT",
          "empty batch",
          "batch_admission",
          requestId,
          false,
        )
      return {
        requestId,
        sampleRate: options.config.sampleRate,
        items,
        model: options.config.model,
        provider: options.config.provider,
        quality: {
          steps: first.steps ?? 8,
          speed: first.speed,
          silenceSeconds: first.silenceSeconds,
        },
      }
    } catch (error: unknown) {
      throw toPublicError(error, requestId)
    } finally {
      leave()
    }
  }

  const close = (): Promise<void> => {
    if (state === "closed") return Promise.resolve()
    if (closePromise !== undefined) return closePromise
    state = "closing"
    closeController.abort()
    closePromise = activeDone
      .then(() => adapter.close())
      .then(() => {
        state = "closed"
      })
    return closePromise
  }

  return {
    load,
    synthesize,
    synthesizeBatch,
    synthesizeChunks,
    capabilities: () => adapter.capabilities(),
    close,
  }
}
