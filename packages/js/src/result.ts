import { SupertonicError } from "./errors.js"
import { concatenatePcm, roundSampleCount } from "./pcm.js"
import type { PipelineConfig, SynthesisChunk, SynthesisRequest, SynthesisResult } from "./types.js"

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
  const silenceSamples = roundSampleCount(config.sampleRate * request.silenceSeconds)
  const pcmFloat32 = concatenatePcm(chunks, silenceSamples)
  if (pcmFloat32.length / config.sampleRate > (config.maxMaterializedSeconds ?? 3600)) {
    throw new SupertonicError(
      "RESOURCE_EXHAUSTED",
      "materialized audio limit exceeded",
      "audio_admission",
      metadata.requestId,
      false,
    )
  }
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
