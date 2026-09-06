import { SupertonicError } from "./errors.js"
import { LANGUAGES, type Language, type PreparedText } from "./types.js"
import { normalizeNfkd151, splitGraphemes151 } from "./unicode-data.js"

const expressionPattern = /<(?:laugh|breath|sigh)>/y

function isLanguage(value: string): value is Language {
  return LANGUAGES.some((language) => language === value)
}

function units(text: string): readonly string[] {
  const result: string[] = []
  let index = 0
  while (index < text.length) {
    expressionPattern.lastIndex = index
    const match = expressionPattern.exec(text)
    if (match !== null) {
      result.push(match[0])
      index = expressionPattern.lastIndex
      continue
    }
    const character = text[index]
    if (character === undefined) break
    const grapheme = splitGraphemes151(text.slice(index))[0]
    if (grapheme === undefined) break
    result.push(grapheme)
    index += grapheme.length
  }
  return result
}

function unitCost(unit: string): number {
  return /^<(?:laugh|breath|sigh)>$/.test(unit) ? 1 : Array.from(unit).length
}

function hardSplit(text: string, limit: number, requestId: string): readonly string[] {
  const result: string[] = []
  let current = ""
  let cost = 0
  for (const unit of units(text)) {
    const nextCost = unitCost(unit)
    if (nextCost > limit) {
      throw new SupertonicError(
        "RESOURCE_EXHAUSTED",
        "indivisible text unit exceeds chunk limit",
        "chunking",
        requestId,
        false,
      )
    }
    if (cost + nextCost > limit && current !== "") {
      result.push(current)
      current = ""
      cost = 0
    }
    current += unit
    cost += nextCost
  }
  if (current !== "") result.push(current)
  return result
}

export function chunkNormalizedText(
  text: string,
  limit: number,
  requestId: string,
): readonly string[] {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ""
  for (const sentence of sentences) {
    const candidate = current === "" ? sentence : `${current} ${sentence}`
    if (units(candidate).reduce((sum, unit) => sum + unitCost(unit), 0) <= limit) {
      current = candidate
      continue
    }
    if (current !== "") chunks.push(current)
    const words = sentence.split(/\s+/)
    current = ""
    for (const word of words) {
      const wordCandidate = current === "" ? word : `${current} ${word}`
      if (units(wordCandidate).reduce((sum, unit) => sum + unitCost(unit), 0) <= limit) {
        current = wordCandidate
      } else {
        if (current !== "") chunks.push(current)
        const pieces = hardSplit(word, limit, requestId)
        chunks.push(...pieces.slice(0, -1))
        current = pieces[pieces.length - 1] ?? ""
      }
    }
  }
  if (current !== "") chunks.push(current)
  return chunks
}

export function prepareText(
  text: string,
  language: string,
  requestId = "request",
  chunkLimit?: number,
): PreparedText {
  if (!isLanguage(language)) {
    throw new SupertonicError(
      "UNSUPPORTED_LANGUAGE",
      `unsupported language: ${language}`,
      "language_validation",
      requestId,
      false,
    )
  }
  let normalized = normalizeNfkd151(text)
  normalized = normalized
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu,
      "",
    )
    .replace(/[–‑—]/g, "-")
    .replace(/_/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’´`]/g, "'")
    .replace(/[[\]|/#→←]/g, " ")
    .replace(/[♥☆♡©\\]/g, "")
    .replace(/@/g, " at ")
    .replace(/e\.g\.,/g, "for example, ")
    .replace(/i\.e\.,/g, "that is, ")
    .replace(/\s+([,.!?;:'])/g, "$1")
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, " ")
    .trim()
  if (normalized === "") {
    throw new SupertonicError(
      "INVALID_ARGUMENT",
      "text is empty after preprocessing",
      "preprocess",
      requestId,
      false,
    )
  }
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(normalized)) normalized += "."
  const limit = chunkLimit ?? (language === "ko" || language === "ja" ? 120 : 300)
  const chunks = chunkNormalizedText(normalized, limit, requestId)
  return {
    normalizedText: normalized,
    wrappedText: `<${language}>${normalized}</${language}>`,
    chunks,
    normalizedCodepoints: Array.from(normalized, (character) => character.codePointAt(0) ?? 0),
  }
}
