import { z } from "zod"
import graphemeJson from "./data/grapheme.json" with { type: "json" }
import normalizationJson from "./data/normalization.json" with { type: "json" }

const rangeSchema = z.tuple([z.number().int(), z.number().int(), z.string()])
const graphemeSchema = z.object({
  unicode_version: z.literal("15.1.0"),
  uax29_revision: z.literal(43),
  properties: z.object({
    Grapheme_Cluster_Break: z.array(rangeSchema),
    Extended_Pictographic: z.array(rangeSchema),
    Indic_Conjunct_Break: z.array(rangeSchema),
  }),
})
const normalizationSchema = z.object({
  unicode_version: z.literal("15.1.0"),
  normalization_form: z.literal("NFKD"),
  decomposition_mappings: z.array(z.tuple([z.number().int(), z.array(z.number().int())])),
  canonical_combining_classes: z.array(z.tuple([z.number().int(), z.number().int()])),
  hangul: z.object({
    s_base: z.number().int(),
    l_base: z.number().int(),
    v_base: z.number().int(),
    t_base: z.number().int(),
    l_count: z.number().int(),
    v_count: z.number().int(),
    t_count: z.number().int(),
    n_count: z.number().int(),
    s_count: z.number().int(),
  }),
})

const grapheme = graphemeSchema.parse(graphemeJson)
const normalization = normalizationSchema.parse(normalizationJson)
const decompositions = new Map(normalization.decomposition_mappings)
const combiningClasses = new Map(normalization.canonical_combining_classes)
const gcbRanges = grapheme.properties.Grapheme_Cluster_Break
const pictographicRanges = grapheme.properties.Extended_Pictographic
const incbRanges = grapheme.properties.Indic_Conjunct_Break

function propertyAt(
  codepoint: number,
  ranges: readonly (readonly [number, number, string])[],
): string {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const range = ranges[middle]
    if (range === undefined) break
    if (codepoint < range[0]) high = middle - 1
    else if (codepoint > range[1]) low = middle + 1
    else return range[2]
  }
  return "Other"
}

function decomposeScalar(codepoint: number, output: number[]): void {
  const hangul = normalization.hangul
  const sIndex = codepoint - hangul.s_base
  if (sIndex >= 0 && sIndex < hangul.s_count) {
    const l = hangul.l_base + Math.floor(sIndex / hangul.n_count)
    const v = hangul.v_base + Math.floor((sIndex % hangul.n_count) / hangul.t_count)
    const tIndex = sIndex % hangul.t_count
    output.push(l, v)
    if (tIndex !== 0) output.push(hangul.t_base + tIndex)
    return
  }
  const mapping = decompositions.get(codepoint)
  if (mapping === undefined) {
    output.push(codepoint)
    return
  }
  for (const scalar of mapping) decomposeScalar(scalar, output)
}

export function normalizeNfkd151(text: string): string {
  const decomposed: number[] = []
  for (const character of text) {
    const codepoint = character.codePointAt(0)
    if (codepoint !== undefined) decomposeScalar(codepoint, decomposed)
  }
  for (let index = 1; index < decomposed.length; index += 1) {
    let current = index
    const currentClass = combiningClasses.get(decomposed[current] ?? 0) ?? 0
    if (currentClass === 0) continue
    while (current > 0) {
      const previousClass = combiningClasses.get(decomposed[current - 1] ?? 0) ?? 0
      if (previousClass === 0 || previousClass <= currentClass) break
      const previous = decomposed[current - 1]
      const value = decomposed[current]
      if (previous === undefined || value === undefined) break
      decomposed[current - 1] = value
      decomposed[current] = previous
      current -= 1
    }
  }
  const parts: string[] = []
  for (let index = 0; index < decomposed.length; index += 8192) {
    parts.push(String.fromCodePoint(...decomposed.slice(index, index + 8192)))
  }
  return parts.join("")
}

function shouldBreak(codepoints: readonly number[], index: number): boolean {
  const left = codepoints[index - 1]
  const right = codepoints[index]
  if (left === undefined || right === undefined) return true
  const leftGcb = propertyAt(left, gcbRanges)
  const rightGcb = propertyAt(right, gcbRanges)
  if (leftGcb === "CR" && rightGcb === "LF") return false
  if (["Control", "CR", "LF"].includes(leftGcb) || ["Control", "CR", "LF"].includes(rightGcb))
    return true
  if (leftGcb === "L" && ["L", "V", "LV", "LVT"].includes(rightGcb)) return false
  if (["LV", "V"].includes(leftGcb) && ["V", "T"].includes(rightGcb)) return false
  if (["LVT", "T"].includes(leftGcb) && rightGcb === "T") return false
  if (["Extend", "ZWJ", "SpacingMark"].includes(rightGcb) || leftGcb === "Prepend") return false
  if (propertyAt(right, incbRanges) === "Consonant") {
    let cursor = index - 1
    let linkerSeen = false
    while (cursor >= 0) {
      const value = codepoints[cursor]
      if (value === undefined) break
      const property = propertyAt(value, incbRanges)
      if (property === "Linker") linkerSeen = true
      else if (property === "Consonant") return !linkerSeen
      else if (property !== "Extend") break
      cursor -= 1
    }
  }
  if (propertyAt(right, pictographicRanges) === "Yes" && leftGcb === "ZWJ") {
    let cursor = index - 2
    while (cursor >= 0 && propertyAt(codepoints[cursor] ?? 0, gcbRanges) === "Extend") cursor -= 1
    if (cursor >= 0 && propertyAt(codepoints[cursor] ?? 0, pictographicRanges) === "Yes")
      return false
  }
  if (leftGcb === "Regional_Indicator" && rightGcb === "Regional_Indicator") {
    let count = 0
    let cursor = index - 1
    while (cursor >= 0 && propertyAt(codepoints[cursor] ?? 0, gcbRanges) === "Regional_Indicator") {
      count += 1
      cursor -= 1
    }
    return count % 2 === 0
  }
  return true
}

export function splitGraphemes151(text: string): readonly string[] {
  const codepoints = Array.from(text, (character) => character.codePointAt(0) ?? 0)
  if (codepoints.length === 0) return []
  const result: string[] = []
  let start = 0
  for (let index = 1; index < codepoints.length; index += 1) {
    if (shouldBreak(codepoints, index)) {
      result.push(String.fromCodePoint(...codepoints.slice(start, index)))
      start = index
    }
  }
  result.push(String.fromCodePoint(...codepoints.slice(start)))
  return result
}
