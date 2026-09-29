import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { verifyDataDirectory } from "../scripts/data-integrity.js"
import { parseSynthesisRequest, prepareText } from "../src/index.js"
import { materializeResult } from "../src/result.js"
import { normalizeNfkd151 } from "../src/unicode-data.js"

const request = parseSynthesisRequest({
  text: "Hello.",
  language: "en",
  voice_style: {
    style_ttl: { dims: [1, 1, 1], data: [0] },
    style_dp: { dims: [1, 1, 1], data: [0] },
  },
})
const config = {
  sampleRate: 10,
  baseChunkSize: 2,
  chunkCompressFactor: 2,
  latentDimension: 1,
  model: { name: "m", revision: "r" },
  provider: { configured: "cpu", actual: "cpu", dtype: "float32" },
}
const metadata = {
  requestId: "r",
  sequence: 0,
  final: true,
  pcmFloat32: Float32Array.of(1),
  validSampleCount: 1,
  durationSeconds: 0.1,
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

async function withDataDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "supertonic-data-"))
  try {
    const files = {
      "contract.json": "contract",
      "grapheme.json": "grapheme",
      "normalization.json": "normalization",
      "unicode-manifest.json": "manifest",
      "models/supertonic-3.json": "model",
    }
    await Bun.write(
      join(directory, "unicode-manifest.json"),
      JSON.stringify({
        unicode_version: "15.1.0",
        uax29_revision: 43,
        generated_files: {
          "grapheme.json": hash(files["grapheme.json"]),
          "normalization.json": hash(files["normalization.json"]),
        },
      }),
    )
    for (const [name, value] of Object.entries(files)) {
      if (name === "unicode-manifest.json") continue
      await Bun.write(join(directory, name), value)
    }
    const hashes = Object.fromEntries(
      await Promise.all(
        Object.keys(files).map(async (name) => [
          name,
          hash(await Bun.file(join(directory, name)).text()),
        ]),
      ),
    )
    await writeFile(
      join(directory, "source-hashes.json"),
      JSON.stringify({ format: "supertonic.runtime-js.data.v1", hashes }),
    )
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("review regressions", () => {
  test("rejects materialized sample overflow before visiting subsequent chunks", () => {
    const chunks = [new Float32Array(11), new Float32Array(1)]
    Object.defineProperty(chunks, 1, {
      get: () => {
        throw new Error("visited excess chunk")
      },
    })
    expect(() =>
      materializeResult(
        chunks,
        metadata,
        { ...request, silenceSeconds: 0 },
        { ...config, maxMaterializedSeconds: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "RESOURCE_EXHAUSTED", stage: "audio_admission" }))
  })

  test("caps materialization at 3600 seconds and rejects invalid configured limits", () => {
    const chunk = new Float32Array(3601)
    expect(() =>
      materializeResult(
        [chunk],
        metadata,
        { ...request, silenceSeconds: 0 },
        { ...config, sampleRate: 1, maxMaterializedSeconds: 4000 },
      ),
    ).toThrow(expect.objectContaining({ code: "RESOURCE_EXHAUSTED" }))
    for (const maxMaterializedSeconds of [Number.NaN, Infinity, -1]) {
      expect(() =>
        materializeResult([Float32Array.of(1)], metadata, request, {
          ...config,
          maxMaterializedSeconds,
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }))
    }
  })

  test("normalizes admitted text whose NFKD expansion exceeds the engine argument limit", () => {
    const text = "\uFDFA".repeat(8_000)
    expect(normalizeNfkd151(text)).toBe("صلى الله عليه وسلم".repeat(8_000))
    const node = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        'import { normalizeNfkd151 } from "./src/unicode-data.ts"; console.log(normalizeNfkd151("\\uFDFA".repeat(8000)).length)',
      ],
      { cwd: join(import.meta.dir, ".."), encoding: "utf8" },
    )
    expect(node.status).toBe(0)
    expect(node.stdout.trim()).toBe("144000")
  })

  test("charges expression tags by their normalized scalar length", () => {
    expect(() => prepareText("<laugh>", "en", "r", 6)).toThrow(
      expect.objectContaining({ code: "RESOURCE_EXHAUSTED", stage: "chunking" }),
    )
    expect(prepareText("<laugh>", "en", "r", 7).chunks).toEqual(["<laugh>", "."])
    expect(prepareText("<laugh>", "en", "r", 8).chunks).toEqual(["<laugh>."])
  })

  test("classifies malformed nested voice styles as style errors", () => {
    const base = {
      text: "Hello.",
      language: "en",
      voice_style: {
        style_ttl: { dims: [1, 1, 1], data: [0] },
        style_dp: { dims: [1, 1, 1], data: [0] },
      },
    }
    for (const style_ttl of [
      { dims: [1, 1], data: [0] },
      { dims: [1, 1, 1], data: [Infinity] },
    ]) {
      expect(() =>
        parseSynthesisRequest({ ...base, voice_style: { ...base.voice_style, style_ttl } }, "r"),
      ).toThrow(
        expect.objectContaining({
          code: "STYLE_MISMATCH",
          stage: "style_validation",
          requestId: "r",
        }),
      )
    }
    expect(() => parseSynthesisRequest({ ...base, steps: 0 }, "r")).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", stage: "request_validation" }),
    )
  })

  test("rejects missing and escaping paths in the packaged data hash set", async () => {
    await withDataDirectory(async (directory) => {
      const path = join(directory, "source-hashes.json")
      const source = await Bun.file(path).json()
      delete source.hashes["models/supertonic-3.json"]
      await writeFile(path, JSON.stringify(source))
      await expect(verifyDataDirectory(directory)).rejects.toThrow()
      source.hashes["models/supertonic-3.json"] = hash("model")
      const outside = join(directory, "..", `${basename(directory)}-escaped.json`)
      try {
        await writeFile(outside, "irrelevant")
        source.hashes[`../${basename(outside)}`] = hash("irrelevant")
        await writeFile(path, JSON.stringify(source))
        await expect(verifyDataDirectory(directory)).rejects.toThrow()
      } finally {
        await rm(outside, { force: true })
      }
    })
  })
})
