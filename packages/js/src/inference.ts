import { SupertonicError } from "./errors.js"
import { retainValidPcm } from "./pcm.js"
import { checkAbort } from "./runtime-utils.js"
import type {
  InferenceAdapter,
  PipelineConfig,
  ProgressEvent,
  SynthesisItem,
  SynthesisRequest,
} from "./types.js"

type InferenceOptions<TPrepared, TEmbedding> = {
  readonly adapter: InferenceAdapter<TPrepared, TEmbedding>
  readonly config: PipelineConfig
  readonly progress: (event: ProgressEvent) => void
  readonly noise: (target: Float32Array) => void
}

export async function runInference<TPrepared, TEmbedding>(
  requests: readonly SynthesisRequest[],
  texts: readonly string[],
  requestId: string,
  signal: AbortSignal,
  sequence: number,
  options: InferenceOptions<TPrepared, TEmbedding>,
): Promise<readonly SynthesisItem[]> {
  checkAbort(signal, requestId)
  const first = requests[0]
  if (first === undefined) {
    throw new SupertonicError(
      "INVALID_ARGUMENT",
      "empty inference batch",
      "batch_admission",
      requestId,
      false,
    )
  }
  const prepared = await options.adapter.prepareText(
    texts.map(
      (text, index) =>
        `<${requests[index]?.language ?? first.language}>${text}</${requests[index]?.language ?? first.language}>`,
    ),
    first.voiceStyle,
    signal,
  )
  const rawDuration = await options.adapter.predictDuration(prepared, first.voiceStyle, signal)
  if (rawDuration.length !== requests.length) {
    throw new SupertonicError(
      "INFERENCE_FAILED",
      "duration batch size mismatch",
      "duration_validation",
      requestId,
      false,
    )
  }
  const predictedSamples: number[] = []
  let maxSamples = 0
  for (const raw of rawDuration) {
    const duration = raw / first.speed
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > (options.config.maxPredictedSeconds ?? 60)
    ) {
      throw new SupertonicError(
        "INFERENCE_FAILED",
        "invalid model duration",
        "duration_validation",
        requestId,
        false,
      )
    }
    const samples = Math.floor(duration * options.config.sampleRate)
    if (!Number.isSafeInteger(samples) || samples <= 0) {
      throw new SupertonicError(
        "INFERENCE_FAILED",
        "invalid predicted sample count",
        "duration_validation",
        requestId,
        false,
      )
    }
    predictedSamples.push(samples)
    maxSamples = Math.max(maxSamples, samples)
  }
  const chunkSize = options.config.baseChunkSize * options.config.chunkCompressFactor
  const latentLength = Math.ceil(maxSamples / chunkSize)
  const latentChannels = options.config.latentDimension * options.config.chunkCompressFactor
  const latentShape: readonly [number, number, number] = [
    requests.length,
    latentChannels,
    latentLength,
  ]
  let latent: Float32Array<ArrayBufferLike> = new Float32Array(
    requests.length * latentChannels * latentLength,
  )
  options.noise(latent)
  const embedding = await options.adapter.encodeText(prepared, first.voiceStyle, signal)
  const totalSteps = first.steps ?? 8
  for (let step = 0; step < totalSteps; step += 1) {
    checkAbort(signal, requestId)
    options.progress({ kind: "denoising", sequence, step, totalSteps })
    const next = await options.adapter.estimateVector(
      latent,
      latentShape,
      { prepared, embedding },
      first.voiceStyle,
      step,
      totalSteps,
      signal,
    )
    if (next.length !== latent.length) {
      throw new SupertonicError(
        "INFERENCE_FAILED",
        "denoised latent shape mismatch",
        "denoising",
        requestId,
        false,
      )
    }
    latent = next
  }
  checkAbort(signal, requestId)
  const waves = await options.adapter.vocode(latent, latentShape, signal)
  if (waves.length !== requests.length) {
    throw new SupertonicError(
      "INFERENCE_FAILED",
      "vocoder batch size mismatch",
      "audio_validation",
      requestId,
      false,
    )
  }
  return waves.map((wave, index) => {
    const pcmFloat32 = retainValidPcm(wave, predictedSamples[index] ?? 0, requestId)
    if (!pcmFloat32.some((sample) => sample !== 0)) {
      throw new SupertonicError(
        "INFERENCE_FAILED",
        "model emitted all-zero PCM for nonempty speech",
        "audio_validation",
        requestId,
        false,
      )
    }
    return {
      pcmFloat32,
      validSampleCount: pcmFloat32.length,
      durationSeconds: pcmFloat32.length / options.config.sampleRate,
    }
  })
}
