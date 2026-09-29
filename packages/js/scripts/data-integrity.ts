import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"

const hashSchema = z.object({
  format: z.literal("supertonic.runtime-js.data.v1"),
  hashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
})

// Keep this set in sync with the files copied by scripts/build.ts.
const packagedPaths = [
  "contract.json",
  "normalization.json",
  "grapheme.json",
  "unicode-manifest.json",
  "models/supertonic-3.json",
] as const

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

// Every allowed path must be a regular file reached without links, so a link at an allowed
// name cannot make verification hash bytes outside the data directory.
async function assertRegularFile(directory: string, relativePath: string): Promise<void> {
  let current = directory
  for (const component of relativePath.split("/")) {
    current = join(current, component)
    const entry = await lstat(current)
    if (entry.isSymbolicLink()) {
      throw new DataVerificationError(`packaged data path contains a link: ${relativePath}`)
    }
  }
  if (!(await lstat(current)).isFile()) {
    throw new DataVerificationError(`packaged data path is not a file: ${relativePath}`)
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

export async function verifyDataDirectory(directory: string): Promise<void> {
  // A linked root would make every relative component check pass for data stored elsewhere.
  const root = await lstat(directory)
  if (root.isSymbolicLink()) {
    throw new DataVerificationError(`packaged data directory is a link: ${directory}`)
  }
  if (!root.isDirectory()) {
    throw new DataVerificationError(`packaged data path is not a directory: ${directory}`)
  }
  const sourceHashes = hashSchema.parse(
    JSON.parse(await readFile(resolve(directory, "source-hashes.json"), "utf8")),
  )
  const actualPaths = Object.keys(sourceHashes.hashes)
  if (
    actualPaths.length !== packagedPaths.length ||
    actualPaths.some((path) => !packagedPaths.includes(path as (typeof packagedPaths)[number]))
  ) {
    throw new DataVerificationError("source hashes must contain exactly the packaged data paths")
  }
  for (const [relativePath, expected] of Object.entries(sourceHashes.hashes)) {
    await assertRegularFile(directory, relativePath)
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
