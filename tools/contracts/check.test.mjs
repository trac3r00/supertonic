import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("./check.mjs", import.meta.url);
const fixtures = new URL("../../tests/fixtures/contracts", import.meta.url);
const terminalDependencies = new URL("../../contracts/v1/dependencies.json", import.meta.url);
const RUNTIMES = [
  "py",
  "nodejs",
  "web",
  "cpp",
  "rust",
  "go",
  "csharp",
  "java",
  "swift",
  "ios",
  "flutter",
];
const PACKAGE_PINS = {
  py: ["onnxruntime", "1.23.1"],
  nodejs: ["onnxruntime-node", "1.23.2"],
  web: ["onnxruntime-web", "1.23.2"],
  cpp: ["onnxruntime", "1.23.1"],
  rust: ["ort", "2.0.0-rc.13"],
  go: ["github.com/yalue/onnxruntime_go", "1.11.0"],
  csharp: ["Microsoft.ML.OnnxRuntime", "1.23.1"],
  java: ["com.microsoft.onnxruntime:onnxruntime", "1.23.1"],
  swift: ["onnxruntime", "1.23.1"],
  ios: ["onnxruntime", "1.23.1"],
  flutter: ["onnxruntime", "1.23.1"],
};
const BASELINE_COMMIT = "a41a310d122cecbac33faf22bfd21834621ea91c";
const GPU_WHEEL_SHA256 =
  "d76d1ac7a479ecc3ac54482eea4ba3b10d68e888a0f8b5f420f0bdf82c5eec59";

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

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeDependencyFixture() {
  const root = mkdtempSync(join(tmpdir(), "supertonic-dependencies-"));
  mkdirSync(join(root, "locks"));
  const resolutions = RUNTIMES.map((runtime) => {
    const [name, version] = PACKAGE_PINS[runtime];
    const path = `locks/${runtime}.lock`;
    const lockToken = `${name}@${version}`;
    const text = `runtime=${runtime}\n${lockToken}\n`;
    writeFileSync(join(root, path), text);
    return {
      runtime,
      environmentIds:
        runtime === "nodejs" ? ["node22", "node24"] : [`${runtime}-default`],
      lockfile: { path, sha256: sha256(text) },
      pins: [{ name, version, lockToken }],
      resolutionStatus: "lock_resolved",
      verification: {
        registry: "verified",
        lock: "verified",
        nativeBinary: "unverified",
        model: "unverified",
        hardware: "unverified",
      },
    };
  });
  const dependencies = {
    schemaVersion: 1,
    status: "complete",
    baseline: {
      sourceCommit: BASELINE_COMMIT,
      sourceWorktreeDirty: false,
    },
    producerFacts: {
      task6a: "complete",
      task6b: "complete",
      task6c: "complete",
    },
    producerEvidence: [
      { task: "task6a", path: ".omo/evidence/task-6a/facts.json", sha256: "1".repeat(64) },
      { task: "task6b", path: ".omo/evidence/task-6b/facts.json", sha256: "2".repeat(64) },
      { task: "task6c", path: ".omo/evidence/task-6c/facts.json", sha256: "3".repeat(64) },
    ],
    futureGpuCorrection: {
      id: "EC1",
      historicalPin: "onnxruntime-gpu==1.23.1",
      historicalStatus: "unpublished_404",
      intendedPin: "onnxruntime-gpu==1.23.2",
      wheel: {
        pythonTag: "cp311",
        platform: "manylinux_2_27_x86_64.manylinux_2_28_x86_64",
        sha256: GPU_WHEEL_SHA256,
        requiresPython: ">=3.10",
      },
      cpuBaselinePin: "onnxruntime==1.23.1",
      separateEnvironment: true,
      registryAvailability: "verified",
      physicalProviderQuality: "unverified",
      provenance: [
        ".omo/ulw-execute/plan-corrections.md",
        ".omo/ulw-execute/task-6-gpu-pin.md",
      ],
    },
    rustCorrection: {
      id: "EC2",
      selectedOrt: "2.0.0-rc.13",
      selectedOrtSys: "2.0.0-rc.13",
      selectedNdarray: "0.17.2",
      runtimeFamily: "1.28",
      apiVersion: 27,
      nativeArtifactIsolation: "task_scoped",
      rc7Status: "blocked_source_incompatible",
      modelQualification: "unverified",
      provenance: ".omo/evidence/task-6b/factreport-for-6d.md",
    },
    flutterCompatibility: {
      declaredSdk: "^3.5.0",
      effectiveDartSdk: ">=3.9.0 <4.0.0",
      effectiveFlutterSdk: ">=3.35.0",
      dart35Qualification: "unverified",
      flutterQualification: "unverified",
      provenance: ".omo/evidence/task-6c/correction1/flutter-facts.json",
    },
    environments: [
      { id: "node22", runtime: "nodejs", identity: "node-22" },
      { id: "node24", runtime: "nodejs", identity: "node-24" },
      ...RUNTIMES.filter((runtime) => runtime !== "nodejs").map((runtime) => ({
        id: `${runtime}-default`,
        runtime,
        identity: `${runtime}-default`,
      })),
    ],
    resolutions,
    nativeAbiConstraints: [
      {
        runtime: "go",
        binding: "github.com/yalue/onnxruntime_go",
        bindingVersion: "1.11.0",
        ortApiVersion: 18,
        requiredRuntimeVersion: "1.18.0",
      },
      {
        runtime: "rust",
        binding: "ort",
        bindingVersion: "2.0.0-rc.13",
        ortApiVersion: 27,
        requiredRuntimeVersion: "1.28",
        typedDependency: { name: "ndarray", version: "0.17.2" },
      },
    ],
    ortDistributions: [
      {
        environmentId: "node22",
        runtime: "nodejs",
        package: "onnxruntime-node",
        variant: "cpu",
      },
    ],
  };
  const path = join(root, "dependencies.json");
  writeJson(path, dependencies);
  return { root, path, dependencies };
}

function makePendingGpuCorrectionFixture() {
  const root = mkdtempSync(join(tmpdir(), "supertonic-pending-gpu-"));
  const path = join(root, "dependencies.json");
  const dependencies = {
    schemaVersion: 1,
    status: "pending_producer_facts",
    baseline: {
      sourceCommit: BASELINE_COMMIT,
      sourceWorktreeDirty: false,
    },
    producerFacts: {
      task6a: "pending",
      task6b: "pending",
      task6c: "pending",
    },
    environments: [],
    resolutions: [],
    nativeAbiConstraints: [],
    ortDistributions: [],
    futureGpuCorrection: {
      id: "EC1",
      historicalPin: "onnxruntime-gpu==1.23.1",
      historicalStatus: "unpublished_404",
      intendedPin: "onnxruntime-gpu==1.23.2",
      wheel: {
        pythonTag: "cp311",
        platform: "manylinux_2_27_x86_64.manylinux_2_28_x86_64",
        sha256: GPU_WHEEL_SHA256,
        requiresPython: ">=3.10",
      },
      cpuBaselinePin: "onnxruntime==1.23.1",
      separateEnvironment: true,
      registryAvailability: "verified",
      physicalProviderQuality: "unverified",
      provenance: [
        ".omo/ulw-execute/plan-corrections.md",
        ".omo/ulw-execute/task-6-gpu-pin.md",
      ],
    },
  };
  writeJson(path, dependencies);
  return { root, path, dependencies };
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

test("dependency flag validates resolved lock identities, pins, ABI, and node environments", () => {
  const fixture = makeDependencyFixture();
  try {
    const result = run("--dependencies", fixture.path);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = parseJson(result);
    assert.equal(report.ok, true);
    assert.equal(report.status, "complete");
    assert.deepEqual(report.runtimes, RUNTIMES);
    assert.deepEqual(report.nodeEnvironments, ["node22", "node24"]);
    assert.equal(report.nativeAbiConstraints.go.ortApiVersion, 18);
    assert.equal(report.nativeAbiConstraints.rust.ortApiVersion, 27);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dependency flag rejects stale, dirty, misleading, incompatible, and mixed-ORT states", () => {
  const mutations = [
    [
      "stale-lock-hash",
      (fixture) => {
        writeFileSync(join(fixture.root, "locks/py.lock"), "tampered\n");
      },
      2,
    ],
    [
      "missing-lockfile",
      (fixture) => {
        unlinkSync(join(fixture.root, "locks/py.lock"));
      },
      77,
    ],
    [
      "version-divergence",
      (fixture) => {
        fixture.dependencies.resolutions[0].pins[0].version = "9.9.9";
      },
      2,
    ],
    [
      "misleading-lock-token",
      (fixture) => {
        fixture.dependencies.resolutions[0].pins[0].lockToken = "misleading-token";
      },
      2,
    ],
    [
      "dirty-baseline",
      (fixture) => {
        fixture.dependencies.baseline.sourceWorktreeDirty = true;
      },
      2,
    ],
    [
      "wrong-baseline",
      (fixture) => {
        fixture.dependencies.baseline.sourceCommit = "b".repeat(40);
      },
      2,
    ],
    [
      "incomplete-producer-facts",
      (fixture) => {
        fixture.dependencies.producerFacts.task6a = "pending";
      },
      77,
    ],
    [
      "collapsed-node-identities",
      (fixture) => {
        fixture.dependencies.environments[1].identity = "node-22";
      },
      2,
    ],
    [
      "go-native-abi-mismatch",
      (fixture) => {
        fixture.dependencies.nativeAbiConstraints[0].ortApiVersion = 19;
      },
      2,
    ],
    [
      "mixed-ort-distributions",
      (fixture) => {
        fixture.dependencies.ortDistributions.push({
          environmentId: "node22",
          runtime: "nodejs",
          package: "onnxruntime-node-gpu",
          variant: "gpu",
        });
      },
      2,
    ],
    [
      "unicode-environment-identifier",
      (fixture) => {
        fixture.dependencies.environments[0].id = "node２２";
      },
      2,
    ],
  ];
  for (const [name, mutate, expectedStatus] of mutations) {
    const fixture = makeDependencyFixture();
    try {
      mutate(fixture);
      writeJson(fixture.path, fixture.dependencies);
      const result = run("--dependencies", fixture.path);
      assert.equal(
        result.status,
        expectedStatus,
        `${name}: ${result.stderr || result.stdout}`,
      );
      assert.match(
        result.stderr,
        /dependencies|lock|producer|node|ABI|ORT|baseline|identifier|environment/i,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("pending EC1 GPU correction preserves registry provenance without qualifying hardware", () => {
  const fixture = makePendingGpuCorrectionFixture();
  try {
    const result = run("--dependencies", fixture.path);
    assert.equal(result.status, 77, result.stderr || result.stdout);
    const error = JSON.parse(result.stderr);
    assert.equal(error.error.code, "PROVIDER_UNAVAILABLE");
    assert.match(error.error.message, /producer facts are not complete/);

    fixture.dependencies.futureGpuCorrection.intendedPin = "onnxruntime-gpu==1.23.1";
    writeJson(fixture.path, fixture.dependencies);
    const invalid = run("--dependencies", fixture.path);
    assert.equal(invalid.status, 2, invalid.stderr || invalid.stdout);
    assert.match(invalid.stderr, /intendedPin.*onnxruntime-gpu==1\.23\.2/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("checked-in terminal dependency contract preserves lock and qualification boundaries", () => {
  const result = run("--dependencies", terminalDependencies.pathname);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = parseJson(result);
  assert.equal(report.status, "complete");
  assert.deepEqual(report.runtimes, RUNTIMES);
  assert.equal(report.nativeAbiConstraints.rust.ortApiVersion, 27);
  assert.equal(report.nativeAbiConstraints.rust.requiredRuntimeVersion, "1.28");
  assert.equal(report.corrections.gpu.registryAvailability, "verified");
  assert.equal(report.corrections.gpu.physicalProviderQuality, "unverified");
  assert.equal(report.corrections.rust.modelQualification, "unverified");
  assert.deepEqual(report.flutterCompatibility, {
    declaredSdk: "^3.5.0",
    effectiveDartSdk: ">=3.9.0 <4.0.0",
    effectiveFlutterSdk: ">=3.35.0",
    dart35Qualification: "unverified",
    flutterQualification: "unverified",
    provenance: ".omo/evidence/task-6c/correction1/flutter-facts.json",
  });
  const cpp = report.checkedLocks.find(({ runtime }) => runtime === "cpp");
  assert.deepEqual(cpp.sourceFiles, ["../../cpp/CMakeLists.txt"]);
});
