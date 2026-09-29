import { SupertonicError } from "./errors.js"

export function roundSampleCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new SupertonicError(
      "INVALID_ARGUMENT",
      "sample count must be finite and nonnegative",
      "audio_validation",
      "audio",
      false,
    )
  }
  return Math.floor(value + 0.5)
}

export function retainValidPcm(
  actual: Float32Array,
  predictedSamples: number,
  requestId: string,
): Float32Array {
  if (!Number.isSafeInteger(predictedSamples) || predictedSamples <= 0) {
    throw new SupertonicError(
      "INFERENCE_FAILED",
      "invalid predicted sample count",
      "duration_validation",
      requestId,
      false,
    )
  }
  const validCount = Math.min(actual.length, predictedSamples)
  const result = actual.slice(0, validCount)
  for (const sample of result) {
    if (!Number.isFinite(sample)) {
      throw new SupertonicError(
        "INFERENCE_FAILED",
        "model emitted nonfinite PCM",
        "audio_validation",
        requestId,
        false,
      )
    }
  }
  return result
}

export function concatenatePcm(
  chunks: readonly Float32Array[],
  silenceSamples: number,
): Float32Array {
  if (!Number.isSafeInteger(silenceSamples) || silenceSamples < 0) {
    throw new SupertonicError(
      "INVALID_ARGUMENT",
      "silence sample count must be a nonnegative safe integer",
      "audio_validation",
      "audio",
      false,
    )
  }
  const total =
    chunks.reduce((sum, chunk) => sum + chunk.length, 0) +
    Math.max(0, chunks.length - 1) * silenceSamples
  if (!Number.isSafeInteger(total)) {
    throw new SupertonicError(
      "RESOURCE_EXHAUSTED",
      "materialized PCM is too large",
      "audio_admission",
      "audio",
      false,
    )
  }
  const output = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length + silenceSamples
  }
  return output
}

export function encodePcm16Wav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const output = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(output.buffer)
  const write = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index))
  }
  write(0, "RIFF")
  view.setUint32(4, 36 + pcm.length * 2, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, pcm.length * 2, true)
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index] ?? 0
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + index * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true)
  }
  return output
}
