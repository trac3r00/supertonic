import { SupertonicError } from "./errors.js"

export function checkAbort(signal: AbortSignal, requestId: string): void {
  if (signal.aborted) {
    throw new SupertonicError("CANCELLED", "request cancelled", "cancellation", requestId, false)
  }
}

export function fillNormalNoise(target: Float32Array): void {
  for (let index = 0; index < target.length; index += 2) {
    const u1 = Math.max(Number.EPSILON, Math.random())
    const u2 = Math.random()
    const radius = Math.sqrt(-2 * Math.log(u1))
    target[index] = radius * Math.cos(2 * Math.PI * u2)
    if (index + 1 < target.length) target[index + 1] = radius * Math.sin(2 * Math.PI * u2)
  }
}

export function toPublicError(error: unknown, requestId: string): SupertonicError {
  if (error instanceof SupertonicError) return error
  const message = error instanceof Error ? error.message : "unknown inference failure"
  return new SupertonicError("INFERENCE_FAILED", message, "inference", requestId, false, {
    cause: error,
  })
}
