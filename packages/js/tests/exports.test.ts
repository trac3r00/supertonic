import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let temporaryDirectory = ""

async function run(command: readonly string[], cwd = packageRoot) {
  const process = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function collectImports(entry: string): Promise<readonly string[]> {
  const pending = [entry]
  const visited = new Set<string>()
  const imports: string[] = []
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || visited.has(current)) continue
    visited.add(current)
    const source = await readFile(current, "utf8")
    for (const match of source.matchAll(/(?:from\\s+|import\\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      imports.push(specifier)
      if (specifier.startsWith(".")) pending.push(resolve(dirname(current), specifier))
    }
  }
  return imports
}

beforeAll(async () => {
  const build = await run(["bun", "run", "build"])
  expect(build.exitCode, build.stderr).toBe(0)
  temporaryDirectory = await mkdtemp(join(tmpdir(), "supertonic-js-exports-"))
})

afterAll(async () => {
  if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true })
})

describe("distribution exports", () => {
  test("all public subpaths load from built artifacts", async () => {
    for (const subpath of ["index", "node", "web", "worker", "http"]) {
      const module = await import(pathToFileURL(resolve(packageRoot, `dist/${subpath}.js`)).href)
      expect(typeof module.createPipelineEngine).toBe("function")
    }
  })

  test("browser graph denies Node builtins and native ORT", async () => {
    const imports = await collectImports(resolve(packageRoot, "dist/web.js"))
    expect(imports.filter((value) => value.startsWith("node:"))).toEqual([])
    expect(imports.filter((value) => value.includes("onnxruntime-node"))).toEqual([])
  })

  test("declarations expose lifecycle, error, progress, and chunk contracts", async () => {
    const declarations = await Promise.all(
      (await readdir(resolve(packageRoot, "dist")))
        .filter((name) => name.endsWith(".d.ts"))
        .map((name) => readFile(resolve(packageRoot, "dist", name), "utf8")),
    )
    const joined = declarations.join("\n")
    for (const symbol of [
      "PipelineEngine",
      "SupertonicError",
      "ProgressEvent",
      "SynthesisChunk",
      "InferenceAdapter",
    ]) {
      expect(joined).toContain(symbol)
    }
    expect(joined).not.toContain("@ts-ignore")
    expect(joined).not.toContain("any")
  })

  test("built data is package-local and the CLI follows contract rounding", async () => {
    const manifestPath = resolve(packageRoot, "dist/data/source-hashes.json")
    const manifest = await readFile(manifestPath, "utf8")
    expect(manifest).toContain("supertonic.runtime-js.data.v1")
    expect(manifest).not.toContain(relative(packageRoot, resolve(packageRoot, "../..")))
    const cli = await run(["node", "dist/cli.js", "round-samples", "2.5"])
    expect(cli.exitCode, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toEqual({ samples: 3 })
  })

  test("packaged data verification rejects a stale Unicode table", async () => {
    const staleData = resolve(temporaryDirectory, "data")
    await cp(resolve(packageRoot, "dist/data"), staleData, { recursive: true })
    await writeFile(resolve(staleData, "normalization.json"), "{}\n")
    const verification = await run(["bun", "run", "scripts/verify-data.ts", staleData])
    expect(verification.exitCode).not.toBe(0)
    expect(verification.stderr).toContain("hash mismatch")
  })
})
