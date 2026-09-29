import { SupertonicError } from "./errors.js"
import { concatenatePcm, roundSampleCount } from "./pcm.js"
import type { PipelineConfig, SynthesisChunk, SynthesisRequest, SynthesisResult } from "./types.js"

// Per-request materialized PCM ceiling in samples, shared by single and batch synthesis.
export function materializedSampleLimit(config: PipelineConfig, requestId: string): number {
  const configuredLimit = config.maxMaterializedSeconds ?? 3600
  if (!Number.isFinite(configuredLimit) || configuredLimit < 0) {
    throw new SupertonicError(
      "INVALID_ARGUMENT",
      "materialized audio limit must be finite and nonnegative",
      "audio_validation",
      requestId,
      false,
    )
  }
  return Math.min(configuredLimit, 3600) * config.sampleRate
}

export function materializeResult(
  chunks: readonly Float32Array[],
  metadata: SynthesisChunk | undefined,
  request: SynthesisRequest,
  config: PipelineConfig,
): SynthesisResult {
  if (metadata === undefined) {
    throw new SupertonicError(
      "INFERENCE_FAILED",
      "no audio chunks emitted",
      "audio_validation",
      "request",
      false,
    )
  }
  const maxSamples = materializedSampleLimit(config, metadata.requestId)
  const silenceSamples = roundSampleCount(config.sampleRate * request.silenceSeconds)
  let totalSamples = 0
  for (let index = 0; index < chunks.length; index += 1) {
    totalSamples += (index === 0 ? 0 : silenceSamples) + (chunks[index]?.length ?? 0)
    if (totalSamples > maxSamples) {
      throw new SupertonicError(
        "RESOURCE_EXHAUSTED",
        "materialized audio limit exceeded",
        "audio_admission",
        metadata.requestId,
        false,
      )
    }
  }
  const pcmFloat32 = concatenatePcm(chunks, silenceSamples)
  return {
    requestId: metadata.requestId,
    sampleRate: config.sampleRate,
    items: [
      {
        pcmFloat32,
        validSampleCount: pcmFloat32.length,
        durationSeconds: pcmFloat32.length / config.sampleRate,
      },
    ],
    model: config.model,
    provider: config.provider,
    quality: {
      steps: request.steps ?? 8,
      speed: request.speed,
      silenceSeconds: request.silenceSeconds,
    },
  }
}
