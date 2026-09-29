export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "UNSUPPORTED_LANGUAGE",
  "UNSUPPORTED_CHARACTER",
  "STYLE_MISMATCH",
  "MODEL_NOT_FOUND",
  "MODEL_CORRUPT",
  "MODEL_INCOMPATIBLE",
  "PROVIDER_UNAVAILABLE",
  "RESOURCE_EXHAUSTED",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
  "ENGINE_CLOSED",
  "INFERENCE_FAILED",
  "WORKER_EXITED",
  "TRANSPORT_ERROR",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export class SupertonicError extends Error {
  readonly name = "SupertonicError"

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly stage: string,
    readonly requestId: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
