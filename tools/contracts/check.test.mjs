import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("./check.mjs", import.meta.url);
const fixtures = new URL("../../tests/fixtures/contracts", import.meta.url);

function run(...args) {
  return spawnSync(process.execPath, [cli.pathname, ...args], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
  });
}

function parseJson(result) {
  assert.equal(result.signal, null, `CLI terminated by ${result.signal}`);
  assert.doesNotMatch(result.stdout, /ignore previous|system prompt|assistant:/i);
  return JSON.parse(result.stdout);
}

test("valid mode checks meaningful accepted and rejected contract fixtures", () => {
  const result = run("--fixtures", fixtures.pathname, "--mode", "valid");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = parseJson(result);
  assert.equal(report.ok, true);
  assert.ok(report.checked.accepted >= 12);
  assert.ok(report.checked.rejected >= 12);
  assert.equal(report.checked.schemaDocuments, 4);
  assert.deepEqual(report.boundaries.sdkBatch, { "32": "accept", "33": "reject" });
  assert.deepEqual(report.boundaries.httpBatch, {
    "32": "accept",
    "33": "accept",
    "64": "accept",
    "65": "reject",
  });
  assert.deepEqual(report.chunkBoundaries.ko, {
    "119": "accept",
    "120": "accept",
    "121": "split",
  });
  assert.deepEqual(report.chunkBoundaries.en, {
    "299": "accept",
    "300": "accept",
    "301": "split",
  });
  assert.deepEqual(report.expressionTags, ["laugh", "breath", "sigh"]);
  assert.equal(report.unicode.astralU20000Retained, true);
  assert.equal(report.unicode.artifacts.schemasChecked, 2);
  assert.deepEqual(report.unicode.artifacts.hashes, {
    "grapheme.json": "50bb99cffd26488a1b605e55c09e0ac019c25c63d15dcac16f17c642069471ce",
    "normalization.json": "8de84c571500b6184755be1e1f0f228e2d0e84d18636e1854493775dc5f3fd3f",
    "unicode-manifest.json": "b4b4b3339ac6a4cbb1f5e48ac8c6c6a93950ed7a845545d2ce5ef833ffd42f22",
  });
  assert.equal(report.untrustedFixtureTextTreatedAsData, true);
});

test("fixture manifest prevents a reduced corpus from reporting success", () => {
  const temporary = mkdtempSync(join(tmpdir(), "supertonic-contracts-"));
  try {
    cpSync(fixtures, temporary, { recursive: true });
    const acceptedPath = join(temporary, "accepted.jsonl");
    const records = readFileSync(acceptedPath, "utf8").trimEnd().split("\n");
    writeFileSync(
      acceptedPath,
      `${records.filter((line) => JSON.parse(line).id !== "http-batch-33").join("\n")}\n`,
    );
    const result = run("--fixtures", temporary, "--mode", "valid");
    assert.notEqual(result.status, 0, "reduced fixture corpus must be rejected");
    assert.match(result.stderr, /required fixture http-batch-33 is missing/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("declared lifecycle, HTTP status, and allocation expectations cannot be corrupted", () => {
  const probes = [
    ["accepted.jsonl", "lifecycle-close", (expected) => {
      expected.finalError.code = "CANCELLED";
    }],
    ["rejected.jsonl", "http-batch-65", (expected) => {
      expected.httpStatus = 200;
    }],
    ["rejected.jsonl", "duration-zero", (expected) => {
      expected.allocationAttempted = true;
    }],
  ];
  for (const [filename, id, mutate] of probes) {
    const temporary = mkdtempSync(join(tmpdir(), "supertonic-contracts-"));
    try {
      cpSync(fixtures, temporary, { recursive: true });
      const fixturePath = join(temporary, filename);
      const records = readFileSync(fixturePath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      mutate(records.find((record) => record.id === id).expected);
      writeFileSync(
        fixturePath,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      const result = run("--fixtures", temporary, "--mode", "valid");
      assert.notEqual(result.status, 0, `${id} corruption must be rejected`);
      assert.match(result.stderr, new RegExp(id));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
});

test("mutation mode proves validator rejects four independent corruptions", () => {
  const result = run("--fixtures", fixtures.pathname, "--mode", "mutation");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = parseJson(result);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.mutations.map(({ name, detected }) => [name, detected]),
    [
      ["chunk-budget", true],
      ["removed-language", true],
      ["wrong-error-code", true],
      ["corrupt-table-hash", true],
    ],
  );
  for (const mutation of report.mutations) {
    assert.match(mutation.validatorError, /contract|schema|hash|fixture/i);
  }
});

test("help is successful and malformed flags are typed failures", () => {
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node tools\/contracts\/check\.mjs/);

  const malformed = run("--fixtures", fixtures.pathname, "--mode", "bogus");
  assert.notEqual(malformed.status, 0);
  const error = JSON.parse(malformed.stderr);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "INVALID_ARGUMENT");
  assert.equal(error.error.stage, "cli");
  assert.equal(error.error.retryable, false);
});
