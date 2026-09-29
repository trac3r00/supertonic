import { SupertonicError } from "./errors.js"

export function checkAbort(signal: AbortSignal, requestId: string): void {
  if (signal.aborted) {
    throw new SupertonicError("CANCELLED", "request cancelled", "cancellation", requestId, false)
  }
}

export function fillNormalNoise(target: Float32Array, seed?: number): void {
  let state = seed ?? 0
  const random =
    seed === undefined
      ? Math.random
      : () => {
          state = (state + 0x6d2b79f5) | 0
          let value = Math.imul(state ^ (state >>> 15), 1 | state)
          value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
          return ((value ^ (value >>> 14)) >>> 0) / 0x100000000
        }
  for (let index = 0; index < target.length; index += 2) {
    const u1 = Math.max(Number.EPSILON, random())
    const u2 = random()
    const radius = Math.sqrt(-2 * Math.log(u1))
    target[index] = radius * Math.cos(2 * Math.PI * u2)
    if (index + 1 < target.length) target[index + 1] = radius * Math.sin(2 * Math.PI * u2)
  }
}

export function toPublicError(
  error: unknown,
  requestId: string,
  stage = "inference",
): SupertonicError {
  if (error instanceof SupertonicError) {
    if (error.requestId !== "load" || requestId === "load") return error
    return new SupertonicError(error.code, error.message, error.stage, requestId, error.retryable, {
      cause: error.cause ?? error,
    })
  }
  const message = error instanceof Error ? error.message : "unknown inference failure"
  return new SupertonicError("INFERENCE_FAILED", message, stage, requestId, false, {
    cause: error,
  })
}
