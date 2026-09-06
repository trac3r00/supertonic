import { z } from "zod"
import { prepareText } from "../src/index.js"

const textFixtureSchema = z.object({
  kind: z.literal("text"),
  input: z.object({
    text: z.string(),
    language: z.string(),
    chunkLimit: z.number().int().positive().optional(),
  }),
  expected: z.object({
    normalizedText: z.string(),
    normalizedCodepoints: z.array(z.number().int()),
    chunks: z.array(z.string()),
  }),
})

export async function checkAcceptedTextFixtures(): Promise<number> {
  const fixtureUrl = new URL("../../../tests/fixtures/contracts/accepted.jsonl", import.meta.url)
  const lines = (await Bun.file(fixtureUrl).text()).trim().split("\n")
  let checked = 0
  for (const line of lines) {
    const parsed = textFixtureSchema.safeParse(JSON.parse(line))
    if (!parsed.success) continue
    const actual = prepareText(
      parsed.data.input.text,
      parsed.data.input.language,
      "fixture",
      parsed.data.input.chunkLimit,
    )
    if (
      actual.normalizedText !== parsed.data.expected.normalizedText ||
      JSON.stringify(actual.normalizedCodepoints) !==
        JSON.stringify(parsed.data.expected.normalizedCodepoints) ||
      JSON.stringify(actual.chunks) !== JSON.stringify(parsed.data.expected.chunks)
    ) {
      throw new Error(`accepted text fixture mismatch: ${line}`)
    }
    checked += 1
  }
  return checked
}
