import { z } from "zod"
import { SupertonicError } from "./errors.js"
import {
  LANGUAGES,
  type Language,
  type QualityPreset,
  type SynthesisRequest,
  type TensorData,
  type VoiceStyle,
} from "./types.js"

const tensorSchema = z
  .object({
    dims: z.tuple([
      z.number().int().positive(),
      z.number().int().positive(),
      z.number().int().positive(),
    ]),
    data: z.array(z.number().finite()),
  })
  .strict()

const styleSchema = z
  .object({
    style_ttl: tensorSchema,
    style_dp: tensorSchema,
  })
  .strict()

const requestSchema = z
  .object({
    text: z.string(),
    language: z.string(),
    voice_style: styleSchema,
    preset: z.enum(["fast", "balanced", "quality"]).optional(),
    steps: z.number().int().min(1).max(100).optional(),
    speed: z.number().finite().min(0.7).max(2).default(1.05),
    silence_seconds: z.number().finite().min(0).max(5).default(0.3),
    provider: z.string().min(1).default("auto"),
    allow_fallback: z.boolean().default(false),
    seed: z.number().int().optional(),
    chunk_limit: z.number().int().positive().optional(),
  })
  .strict()

const PRESET_STEPS: Readonly<Record<QualityPreset, number>> = {
  fast: 5,
  balanced: 8,
  quality: 12,
}

function isLanguage(value: string): value is Language {
  return LANGUAGES.some((language) => language === value)
}

function parseTensor(
  value: z.infer<typeof tensorSchema>,
  requestId: string,
  label: string,
): TensorData {
  const expected = value.dims[0] * value.dims[1] * value.dims[2]
  if (!Number.isSafeInteger(expected) || expected !== value.data.length) {
    throw new SupertonicError(
      "STYLE_MISMATCH",
      `${label} data length does not match dimensions`,
      "style_validation",
      requestId,
      false,
    )
  }
  return { dims: value.dims, data: new Float32Array(value.data) }
}

function parseStyle(value: z.infer<typeof styleSchema>, requestId: string): VoiceStyle {
  const styleTtl = parseTensor(value.style_ttl, requestId, "style_ttl")
  const styleDp = parseTensor(value.style_dp, requestId, "style_dp")
  if (styleTtl.dims[0] !== styleDp.dims[0]) {
    throw new SupertonicError(
      "STYLE_MISMATCH",
      "style batch dimensions differ",
      "style_validation",
      requestId,
      false,
    )
  }
  return { styleTtl, styleDp }
}

export function parseSynthesisRequest(input: unknown, requestId = "request"): SynthesisRequest {
  const result = requestSchema.safeParse(input)
  if (!result.success) {
    const styleIssue = result.error.issues.find(
      (issue) => issue.path[0] === "voice_style" && issue.path.length > 1,
    )
    const invalidStyle = styleIssue !== undefined
    // Report the issue that selected the code and stage, so all three describe one problem.
    throw new SupertonicError(
      invalidStyle ? "STYLE_MISMATCH" : "INVALID_ARGUMENT",
      (styleIssue ?? result.error.issues[0])?.message ?? "invalid synthesis request",
      invalidStyle ? "style_validation" : "request_validation",
      requestId,
      false,
      { cause: result.error },
    )
  }
  if (!isLanguage(result.data.language)) {
    throw new SupertonicError(
      "UNSUPPORTED_LANGUAGE",
      `unsupported language: ${result.data.language}`,
      "language_validation",
      requestId,
      false,
    )
  }
  const rawScalarCount = Array.from(result.data.text).length
  if (rawScalarCount > 16_384) {
    throw new SupertonicError(
      "RESOURCE_EXHAUSTED",
      "raw text exceeds 16384 Unicode scalars",
      "text_admission",
      requestId,
      false,
    )
  }
  const preset = result.data.preset ?? "balanced"
  return {
    text: result.data.text,
    language: result.data.language,
    voiceStyle: parseStyle(result.data.voice_style, requestId),
    preset,
    steps: result.data.steps ?? PRESET_STEPS[preset],
    speed: result.data.speed,
    silenceSeconds: result.data.silence_seconds,
    provider: result.data.provider,
    allowFallback: result.data.allow_fallback,
    ...(result.data.seed === undefined ? {} : { seed: result.data.seed }),
    ...(result.data.chunk_limit === undefined ? {} : { chunkLimit: result.data.chunk_limit }),
  }
}
