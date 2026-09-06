import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyDataDirectory } from "./data-integrity.js"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageRoot, "../..")
const sourceData = resolve(packageRoot, "src/data")
const distributionData = resolve(packageRoot, "dist/data")
const files = [
  "contract.json",
  "normalization.json",
  "grapheme.json",
  "unicode-manifest.json",
  "models/supertonic-3.json",
] as const

await rm(resolve(packageRoot, "dist"), { recursive: true, force: true })
await rm(sourceData, { recursive: true, force: true })

const hashes: Record<string, string> = {}
for (const relativePath of files) {
  const source = resolve(repositoryRoot, "contracts/v1", relativePath)
  const destination = resolve(sourceData, relativePath)
  await mkdir(dirname(destination), { recursive: true })
  const bytes = await readFile(source)
  hashes[relativePath] = createHash("sha256").update(bytes).digest("hex")
  await writeFile(destination, bytes)
}

const compiler = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
  cwd: packageRoot,
  stdout: "inherit",
  stderr: "inherit",
})
const exitCode = await compiler.exited
if (exitCode !== 0) {
  process.exit(exitCode)
}

await mkdir(distributionData, { recursive: true })
await cp(sourceData, distributionData, { recursive: true })
await writeFile(
  resolve(distributionData, "source-hashes.json"),
  `${JSON.stringify({ format: "supertonic.runtime-js.data.v1", hashes }, null, 2)}\n`,
)
await verifyDataDirectory(distributionData)
