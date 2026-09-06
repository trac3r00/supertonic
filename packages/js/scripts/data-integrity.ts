import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"

const hashSchema = z.object({
  format: z.literal("supertonic.runtime-js.data.v1"),
  hashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
})

const unicodeManifestSchema = z.object({
  unicode_version: z.literal("15.1.0"),
  uax29_revision: z.literal(43),
  generated_files: z.object({
    "grapheme.json": z.string().regex(/^[0-9a-f]{64}$/),
    "normalization.json": z.string().regex(/^[0-9a-f]{64}$/),
  }),
})

export class DataVerificationError extends Error {
  readonly name = "DataVerificationError"
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

export async function verifyDataDirectory(directory: string): Promise<void> {
  const sourceHashes = hashSchema.parse(
    JSON.parse(await readFile(resolve(directory, "source-hashes.json"), "utf8")),
  )
  for (const [relativePath, expected] of Object.entries(sourceHashes.hashes)) {
    const actual = await sha256(resolve(directory, relativePath))
    if (actual !== expected) {
      throw new DataVerificationError(`hash mismatch for ${relativePath}: ${actual} != ${expected}`)
    }
  }
  const unicodeManifest = unicodeManifestSchema.parse(
    JSON.parse(await readFile(resolve(directory, "unicode-manifest.json"), "utf8")),
  )
  for (const relativePath of ["grapheme.json", "normalization.json"] as const) {
    const actual = await sha256(resolve(directory, relativePath))
    const expected = unicodeManifest.generated_files[relativePath]
    if (actual !== expected) {
      throw new DataVerificationError(
        `Unicode manifest hash mismatch for ${relativePath}: ${actual} != ${expected}`,
      )
    }
  }
}
