export const LANGUAGES = [
  "en",
  "ko",
  "ja",
  "ar",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "es",
  "et",
  "fi",
  "fr",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "lt",
  "lv",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "tr",
  "uk",
  "vi",
  "na",
] as const

export type Language = (typeof LANGUAGES)[number]
export type QualityPreset = "fast" | "balanced" | "quality"
export type RuntimeTarget = "node" | "web" | "worker" | "http"

export type TensorData = {
  readonly dims: readonly [number, number, number]
  readonly data: Float32Array
}

export type VoiceStyle = {
  readonly styleTtl: TensorData
  readonly styleDp: TensorData
}

export type SynthesisRequest = {
  readonly text: string
  readonly language: Language
  readonly voiceStyle: VoiceStyle
  readonly preset?: QualityPreset
  readonly steps?: number
  readonly speed: number
  readonly silenceSeconds: number
  readonly provider: string
  readonly allowFallback: boolean
  readonly seed?: number
  readonly chunkLimit?: number
}

export type PreparedText = {
  readonly normalizedText: string
  readonly wrappedText: string
  readonly chunks: readonly string[]
  readonly normalizedCodepoints: readonly number[]
}

export type ModelMetadata = {
  readonly name: string
  readonly revision: string
}

export type ProviderMetadata = {
  readonly configured: string
  readonly actual: string
  readonly dtype: string
}

export type QualityMetadata = {
  readonly steps: number
  readonly speed: number
  readonly silenceSeconds: number
}

export type SynthesisItem = {
  readonly pcmFloat32: Float32Array
  readonly validSampleCount: number
  readonly durationSeconds: number
}

export type SynthesisResult = {
  readonly requestId: string
  readonly sampleRate: number
  readonly items: readonly SynthesisItem[]
  readonly model: ModelMetadata
  readonly provider: ProviderMetadata
  readonly quality: QualityMetadata
}

export type SynthesisChunk = SynthesisItem & {
  readonly requestId: string
  readonly sequence: number
  readonly final: boolean
}

export type ProgressEvent =
  | {
      readonly kind: "loading"
      readonly component: string
      readonly completed: number
      readonly total: number
    }
  | {
      readonly kind: "chunk"
      readonly sequence: number
      readonly completed: number
      readonly total: number
    }
  | {
      readonly kind: "denoising"
      readonly sequence: number
      readonly step: number
      readonly totalSteps: number
    }
  | { readonly kind: "completed"; readonly requestId: string }

export type Capabilities = {
  readonly configuredProvider: string
  readonly actualProvider: string
  readonly graphPlacement: string | null
  readonly device: string
  readonly dtype: string
  readonly threadBudgets: Readonly<Record<string, number>>
  readonly cancellationGranularity: readonly string[]
  readonly supportStatus: "implemented" | "unsupported"
}

export type PipelineConfig = {
  readonly sampleRate: number
  readonly baseChunkSize: number
  readonly chunkCompressFactor: number
  readonly latentDimension: number
  readonly model: ModelMetadata
  readonly provider: ProviderMetadata
  readonly maxRawScalars?: number
  readonly maxBatchItems?: number
  readonly maxPredictedSeconds?: number
  readonly maxMaterializedSeconds?: number
}

export type InferenceBatch<TPrepared, TEmbedding> = {
  readonly prepared: TPrepared
  readonly embedding: TEmbedding
}

export interface InferenceAdapter<TPrepared, TEmbedding> {
  load(signal: AbortSignal, progress: (event: ProgressEvent) => void): Promise<void>
  prepareText(texts: readonly string[], style: VoiceStyle, signal: AbortSignal): Promise<TPrepared>
  predictDuration(
    prepared: TPrepared,
    style: VoiceStyle,
    signal: AbortSignal,
  ): Promise<Float32Array>
  encodeText(prepared: TPrepared, style: VoiceStyle, signal: AbortSignal): Promise<TEmbedding>
  estimateVector(
    noisyLatent: Float32Array,
    latentShape: readonly [number, number, number],
    batch: InferenceBatch<TPrepared, TEmbedding>,
    style: VoiceStyle,
    step: number,
    totalSteps: number,
    signal: AbortSignal,
  ): Promise<Float32Array>
  vocode(
    latent: Float32Array,
    latentShape: readonly [number, number, number],
    signal: AbortSignal,
  ): Promise<readonly Float32Array[]>
  capabilities(): Capabilities
  close(): Promise<void>
}

export interface NoiseSource {
  fill(target: Float32Array): void
}

export interface PipelineEngine {
  load(signal?: AbortSignal): Promise<void>
  synthesize(input: unknown, signal?: AbortSignal): Promise<SynthesisResult>
  synthesizeBatch(input: unknown, signal?: AbortSignal): Promise<SynthesisResult>
  synthesizeChunks(input: unknown, signal?: AbortSignal): AsyncIterable<SynthesisChunk>
  capabilities(): Capabilities
  close(): Promise<void>
}

export type PipelineOptions<TPrepared, TEmbedding> = {
  readonly adapter: InferenceAdapter<TPrepared, TEmbedding>
  readonly config: PipelineConfig
  readonly noise?: NoiseSource
  readonly requestId?: () => string
  readonly onProgress?: (event: ProgressEvent) => void
  readonly supportedCodepoint?: (codepoint: number) => boolean
}
