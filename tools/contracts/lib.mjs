import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import normalization from "../../contracts/v1/normalization.json" with { type: "json" };
import grapheme from "../../contracts/v1/grapheme.json" with { type: "json" };

export const EXPECTED_LANGUAGES = [
  "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et",
  "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl",
  "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na",
];

export const EXPECTED_ERROR_CODES = [
  "INVALID_ARGUMENT", "UNSUPPORTED_LANGUAGE", "UNSUPPORTED_CHARACTER",
  "STYLE_MISMATCH", "MODEL_NOT_FOUND", "MODEL_CORRUPT",
  "MODEL_INCOMPATIBLE", "PROVIDER_UNAVAILABLE", "RESOURCE_EXHAUSTED",
  "CANCELLED", "DEADLINE_EXCEEDED", "ENGINE_CLOSED", "INFERENCE_FAILED",
  "WORKER_EXITED", "TRANSPORT_ERROR",
];

export const RUNTIME_NAMES = [
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
export const DEPENDENCY_BASELINE_COMMIT = "a41a310d122cecbac33faf22bfd21834621ea91c";
const EC1_GPU_CORRECTION = {
  historicalPin: "onnxruntime-gpu==1.23.1",
  intendedPin: "onnxruntime-gpu==1.23.2",
  cpuBaselinePin: "onnxruntime==1.23.1",
  wheelSha256: "d76d1ac7a479ecc3ac54482eea4ba3b10d68e888a0f8b5f420f0bdf82c5eec59",
};
const EC2_RUST_CORRECTION = {
  ort: "2.0.0-rc.13",
  ortSys: "2.0.0-rc.13",
  ndarray: "0.17.2",
  runtimeFamily: "1.28",
  apiVersion: 27,
};
const FLUTTER_COMPATIBILITY = {
  declaredSdk: "^3.5.0",
  effectiveDartSdk: ">=3.9.0 <4.0.0",
  effectiveFlutterSdk: ">=3.35.0",
};

const EXPRESSION_TAGS = ["laugh", "breath", "sigh"];
const EXPRESSION_PATTERN = /<(laugh|breath|sigh)>/gy;
const EMOJI_PATTERN =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u2600-\u26FF\u2700-\u27BF\u{1F1E6}-\u{1F1FF}]+/gu;

export class ContractValidationError extends Error {
  constructor(message, path = "$") {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
    this.path = path;
  }
}

export class DependencyPrerequisiteError extends ContractValidationError {}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new ContractValidationError(
          `invalid JSONL record ${index + 1}: ${error.message}`,
          path,
        );
      }
    });
}

function isType(value, type) {
  switch (type) {
    case "array": return Array.isArray(value);
    case "integer": return Number.isInteger(value);
    case "null": return value === null;
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: return typeof value === type;
  }
}

export function validateSchema(value, schema, path = "$") {
  if (schema.const !== undefined && value !== schema.const) {
    throw new ContractValidationError(`must equal ${JSON.stringify(schema.const)}`, path);
  }
  if (schema.enum && !schema.enum.some((entry) => entry === value)) {
    throw new ContractValidationError(`must be one of ${schema.enum.join(", ")}`, path);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => isType(value, type))) {
      throw new ContractValidationError(`must have type ${types.join("|")}`, path);
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      throw new ContractValidationError(`must have at least ${schema.minLength} scalars`, path);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      throw new ContractValidationError(`must match ${schema.pattern}`, path);
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ContractValidationError("must be finite", path);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new ContractValidationError(`must be >= ${schema.minimum}`, path);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new ContractValidationError(`must be <= ${schema.maximum}`, path);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new ContractValidationError(`must contain at least ${schema.minItems} items`, path);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new ContractValidationError(`must contain at most ${schema.maxItems} items`, path);
    }
    if (schema.items) {
      value.forEach((entry, index) => validateSchema(entry, schema.items, `${path}[${index}]`));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        throw new ContractValidationError(`missing required property ${key}`, path);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          throw new ContractValidationError(`unexpected property ${key}`, path);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateSchema(value[key], propertySchema, `${path}.${key}`);
      }
    }
  }
  return true;
}

function exactArray(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ContractValidationError(`${label} contract mismatch`);
  }
}

export function validateContract(contract, schema) {
  validateSchema(contract, schema);
  exactArray(contract.inputs.languages, EXPECTED_LANGUAGES, "language");
  exactArray(contract.inputs.expressionTags, EXPRESSION_TAGS, "expression tag");
  exactArray(contract.errors.codes, EXPECTED_ERROR_CODES, "error code");
  if (contract.limits.sdkRawBatchItems !== 32 ||
      contract.limits.httpCompatibilityBatchItems !== 64) {
    throw new ContractValidationError("SDK32/HTTP64 batch contract mismatch");
  }
  if (contract.text.chunkScalarBudgets.ko !== 120 ||
      contract.text.chunkScalarBudgets.ja !== 120 ||
      contract.text.chunkScalarBudgets.default !== 300) {
    throw new ContractValidationError("chunk budget contract mismatch");
  }
  if (contract.inputs.defaults.steps !== 8 ||
      contract.inputs.defaults.speed !== 1.05 ||
      contract.inputs.defaults.silenceSeconds !== 0.3) {
    throw new ContractValidationError("default synthesis parameters mismatch");
  }
  if (JSON.stringify(contract.inputs.presets) !==
      JSON.stringify({ fast: 5, balanced: 8, quality: 12 })) {
    throw new ContractValidationError("quality preset contract mismatch");
  }
  if (contract.audio.maxRetainedStreamingChunks !== 2 ||
      contract.lifecycle.runningRequestsPerEngine !== 1 ||
      contract.lifecycle.serviceQueueLimitFormula !== "2*worker_count") {
    throw new ContractValidationError("bounded lifecycle contract mismatch");
  }
  return true;
}

function requireDependency(condition, message, path = "$dependencies") {
  if (!condition) throw new ContractValidationError(message, path);
}

function requireUnique(values, label, path = "$dependencies") {
  if (new Set(values).size !== values.length) {
    throw new ContractValidationError(`duplicate ${label}`, path);
  }
}

function environmentById(environments) {
  const entries = environments.map((environment) => [environment.id, environment]);
  requireUnique(entries.map(([id]) => id), "environment identifier", "$dependencies.environments");
  return new Map(entries);
}

function validateNodeEnvironments(environments) {
  const byId = environmentById(environments);
  const node22 = byId.get("node22");
  const node24 = byId.get("node24");
  requireDependency(node22 !== undefined, "node22 environment is required");
  requireDependency(node24 !== undefined, "node24 environment is required");
  requireDependency(node22.runtime === "nodejs", "node22 must identify nodejs");
  requireDependency(node24.runtime === "nodejs", "node24 must identify nodejs");
  requireDependency(node22.identity !== node24.identity, "node22 and node24 identities must differ");
  return byId;
}

function validateNativeAbiConstraints(constraints) {
  const expected = new Map([
    [
      "go",
      {
        binding: "github.com/yalue/onnxruntime_go",
        bindingVersion: "1.11.0",
        ortApiVersion: 18,
        requiredRuntimeVersion: "1.18.0",
      },
    ],
    [
      "rust",
      {
        binding: "ort",
        bindingVersion: EC2_RUST_CORRECTION.ort,
        ortApiVersion: EC2_RUST_CORRECTION.apiVersion,
        requiredRuntimeVersion: EC2_RUST_CORRECTION.runtimeFamily,
      },
    ],
  ]);
  requireUnique(
    constraints.map((constraint) => constraint.runtime),
    "native ABI runtime",
    "$dependencies.nativeAbiConstraints",
  );
  for (const [runtime, required] of expected) {
    const actual = constraints.find((constraint) => constraint.runtime === runtime);
    requireDependency(actual !== undefined, `${runtime} native ABI constraint is required`);
    for (const [field, value] of Object.entries(required)) {
      requireDependency(
        actual[field] === value,
        `${runtime} native ABI ${field} mismatch`,
        "$dependencies.nativeAbiConstraints",
      );
    }
  }
  const rust = constraints.find((constraint) => constraint.runtime === "rust");
  requireDependency(rust.typedDependency !== undefined, "rust ndarray typed dependency is required");
  requireDependency(
    rust.typedDependency.name === "ndarray" &&
      rust.typedDependency.version === EC2_RUST_CORRECTION.ndarray,
    "rust ndarray typed dependency mismatch",
    "$dependencies.nativeAbiConstraints",
  );
}

function validateOrtDistributions(distributions, environments) {
  const variantsByEnvironment = new Map();
  for (const distribution of distributions) {
    requireDependency(
      environments.has(distribution.environmentId),
      `ORT distribution references unknown environment ${distribution.environmentId}`,
      "$dependencies.ortDistributions",
    );
    const variants = variantsByEnvironment.get(distribution.environmentId) ?? new Set();
    variants.add(distribution.variant);
    variantsByEnvironment.set(distribution.environmentId, variants);
  }
  for (const [environmentId, variants] of variantsByEnvironment) {
    requireDependency(
      !(variants.has("cpu") && variants.has("gpu")),
      `mixed CPU and GPU ORT distributions in environment ${environmentId}`,
      "$dependencies.ortDistributions",
    );
  }
}

function validateFutureGpuCorrection(correction) {
  if (correction === undefined) return;
  requireDependency(
    correction.historicalPin === EC1_GPU_CORRECTION.historicalPin &&
      correction.historicalStatus === "unpublished_404",
    "GPU correction historical 1.23.1 404 provenance mismatch",
    "$dependencies.futureGpuCorrection",
  );
  requireDependency(
    correction.intendedPin === EC1_GPU_CORRECTION.intendedPin,
    "GPU correction intended pin mismatch",
    "$dependencies.futureGpuCorrection",
  );
  requireDependency(
    correction.cpuBaselinePin === EC1_GPU_CORRECTION.cpuBaselinePin &&
      correction.separateEnvironment === true,
    "GPU correction CPU baseline or environment separation mismatch",
    "$dependencies.futureGpuCorrection",
  );
  requireDependency(
    correction.wheel.sha256 === EC1_GPU_CORRECTION.wheelSha256 &&
      correction.registryAvailability === "verified" &&
      correction.physicalProviderQuality === "unverified",
    "GPU correction registry or qualification state mismatch",
    "$dependencies.futureGpuCorrection",
  );
}

function validateRustCorrection(correction) {
  requireDependency(correction !== undefined, "EC2 rust correction is required");
  requireDependency(
    correction.id === "EC2" &&
      correction.selectedOrt === EC2_RUST_CORRECTION.ort &&
      correction.selectedOrtSys === EC2_RUST_CORRECTION.ortSys &&
      correction.selectedNdarray === EC2_RUST_CORRECTION.ndarray,
    "EC2 resolved Rust dependency identity mismatch",
    "$dependencies.rustCorrection",
  );
  requireDependency(
    correction.runtimeFamily === EC2_RUST_CORRECTION.runtimeFamily &&
      correction.apiVersion === EC2_RUST_CORRECTION.apiVersion &&
      correction.nativeArtifactIsolation === "task_scoped" &&
      correction.rc7Status === "blocked_source_incompatible" &&
      correction.modelQualification === "unverified",
    "EC2 native/model verification state mismatch",
    "$dependencies.rustCorrection",
  );
}

function validateFlutterCompatibility(compatibility) {
  requireDependency(compatibility !== undefined, "Flutter compatibility facts are required");
  requireDependency(
    compatibility.declaredSdk === FLUTTER_COMPATIBILITY.declaredSdk &&
      compatibility.effectiveDartSdk === FLUTTER_COMPATIBILITY.effectiveDartSdk &&
      compatibility.effectiveFlutterSdk === FLUTTER_COMPATIBILITY.effectiveFlutterSdk &&
      compatibility.dart35Qualification === "unverified" &&
      compatibility.flutterQualification === "unverified",
    "Flutter declaration, effective lock, or qualification facts mismatch",
    "$dependencies.flutterCompatibility",
  );
}

function validateProducerEvidence(evidence) {
  requireUnique(
    evidence.map((entry) => entry.task),
    "producer evidence task",
    "$dependencies.producerEvidence",
  );
  exactArray(
    evidence.map((entry) => entry.task),
    ["task6a", "task6b", "task6c"],
    "producer evidence",
  );
}

async function validateResolvedLocks(resolutions, environments, dependenciesPath) {
  requireUnique(
    resolutions.map((resolution) => resolution.runtime),
    "runtime resolution",
    "$dependencies.resolutions",
  );
  const checked = [];
  for (const resolution of resolutions) {
    requireDependency(
      resolution.environmentIds.every((environmentId) => environments.has(environmentId)),
      `resolution ${resolution.runtime} references an unknown environment`,
      "$dependencies.resolutions",
    );
    requireUnique(
      resolution.environmentIds,
      `${resolution.runtime} environment reference`,
      "$dependencies.resolutions",
    );
    requireUnique(
      resolution.pins.map((pin) => pin.name),
      `${resolution.runtime} pinned package`,
      "$dependencies.resolutions",
    );
    const files = [
      resolution.lockfile,
      ...(resolution.additionalLockfiles ?? []),
      ...(resolution.sourceFiles ?? []),
    ];
    requireUnique(
      files.map((file) => file.path),
      `${resolution.runtime} dependency file`,
      "$dependencies.resolutions",
    );
    const lockTexts = [];
    for (const file of files) {
      const lockPath = resolve(dirname(dependenciesPath), file.path);
      let lockBytes;
      try {
        lockBytes = await readFile(lockPath);
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          throw new DependencyPrerequisiteError(
            `required lockfile is unavailable for ${resolution.runtime}`,
            "$dependencies.resolutions",
          );
        }
        throw error;
      }
      verifyHash(lockBytes, file.sha256, file.path);
      lockTexts.push(lockBytes.toString("utf8"));
    }
    const lockText = lockTexts.join("\n");
    for (const pin of resolution.pins) {
      if (pin.version !== null && pin.version !== undefined) {
        requireDependency(
          pin.lockToken.includes(pin.version),
          `pinned version is absent from lock token for ${pin.name}`,
          "$dependencies.resolutions",
        );
      } else {
        requireDependency(
          pin.requirement !== undefined,
          `unresolved pin is missing an explicit requirement for ${pin.name}`,
          "$dependencies.resolutions",
        );
      }
      requireDependency(
        lockText.includes(pin.lockToken),
        `pinned lock token is absent for ${pin.name}`,
        "$dependencies.resolutions",
      );
    }
    checked.push({
      runtime: resolution.runtime,
      lockfiles: [
        resolution.lockfile.path,
        ...(resolution.additionalLockfiles ?? []).map((file) => file.path),
      ],
      sourceFiles: (resolution.sourceFiles ?? []).map((file) => file.path),
      resolutionStatus: resolution.resolutionStatus,
      verification: resolution.verification,
    });
  }
  return checked;
}

export async function validateDependencies(dependencies, schema, dependenciesPath, runtime = "all") {
  requireDependency(runtime === "all" || RUNTIME_NAMES.includes(runtime), "unknown dependency runtime");
  validateSchema(dependencies, schema, "$dependencies");
  validateFutureGpuCorrection(dependencies.futureGpuCorrection);
  const pendingFacts = Object.values(dependencies.producerFacts).some(
    (status) => status !== "complete",
  );
  if (dependencies.status === "pending_producer_facts") {
    requireDependency(pendingFacts, "pending dependency contract has no missing producer facts");
    requireDependency(
      dependencies.environments.length === 0 &&
        dependencies.resolutions.length === 0 &&
        dependencies.nativeAbiConstraints.length === 0 &&
        dependencies.ortDistributions.length === 0,
      "pending dependency contract must not contain incomplete resolution metadata",
    );
    throw new DependencyPrerequisiteError("dependency producer facts are not complete");
  }
  if (pendingFacts) {
    throw new DependencyPrerequisiteError("dependency producer facts are not complete");
  }
  validateProducerEvidence(dependencies.producerEvidence);
  validateRustCorrection(dependencies.rustCorrection);
  validateFlutterCompatibility(dependencies.flutterCompatibility);
  requireDependency(
    dependencies.baseline.sourceWorktreeDirty === false,
    "dependency baseline was captured from a dirty worktree",
    "$dependencies.baseline",
  );
  requireDependency(
    dependencies.baseline.sourceCommit === DEPENDENCY_BASELINE_COMMIT,
    "dependency baseline commit mismatch",
    "$dependencies.baseline",
  );
  const resolutions = dependencies.resolutions;
  exactArray(
    resolutions.map((resolution) => resolution.runtime),
    RUNTIME_NAMES,
    "dependency runtime",
  );
  const environments = validateNodeEnvironments(dependencies.environments);
  const selected = runtime === "all"
    ? resolutions
    : resolutions.filter((resolution) => resolution.runtime === runtime);
  const checkedLocks = await validateResolvedLocks(selected, environments, dependenciesPath);
  validateNativeAbiConstraints(dependencies.nativeAbiConstraints);
  validateOrtDistributions(dependencies.ortDistributions, environments);
  return {
    runtimes: selected.map((resolution) => resolution.runtime),
    checkedLocks,
    nodeEnvironments: ["node22", "node24"],
    nativeAbiConstraints: {
      go: dependencies.nativeAbiConstraints.find((constraint) => constraint.runtime === "go"),
      rust: dependencies.nativeAbiConstraints.find((constraint) => constraint.runtime === "rust"),
    },
    corrections: {
      gpu: {
        registryAvailability: dependencies.futureGpuCorrection.registryAvailability,
        physicalProviderQuality: dependencies.futureGpuCorrection.physicalProviderQuality,
      },
      rust: {
        modelQualification: dependencies.rustCorrection.modelQualification,
      },
    },
    flutterCompatibility: dependencies.flutterCompatibility,
  };
}

const decompositions = new Map(normalization.decomposition_mappings);
const combiningClasses = new Map(normalization.canonical_combining_classes);
const gcbRanges = grapheme.properties.Grapheme_Cluster_Break;
const pictographicRanges = grapheme.properties.Extended_Pictographic;
const incbRanges = grapheme.properties.Indic_Conjunct_Break;

function propertyAt(codepoint, ranges) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [start, end, value] = ranges[middle];
    if (codepoint < start) high = middle - 1;
    else if (codepoint > end) low = middle + 1;
    else return value;
  }
  return "Other";
}

function decomposeScalar(codepoint, output) {
  const hangul = normalization.hangul;
  const index = codepoint - hangul.s_base;
  if (index >= 0 && index < hangul.s_count) {
    output.push(hangul.l_base + Math.floor(index / hangul.n_count));
    output.push(hangul.v_base + Math.floor((index % hangul.n_count) / hangul.t_count));
    if (index % hangul.t_count) output.push(hangul.t_base + index % hangul.t_count);
    return;
  }
  const mapping = decompositions.get(codepoint);
  if (mapping) for (const scalar of mapping) decomposeScalar(scalar, output);
  else output.push(codepoint);
}

function normalizeNfkd151(text) {
  const scalars = [];
  for (const character of text) decomposeScalar(character.codePointAt(0), scalars);
  for (let index = 1; index < scalars.length; index++) {
    let current = index;
    const currentClass = combiningClasses.get(scalars[current]) ?? 0;
    if (currentClass === 0) continue;
    while (current > 0) {
      const previousClass = combiningClasses.get(scalars[current - 1]) ?? 0;
      if (previousClass === 0 || previousClass <= currentClass) break;
      [scalars[current - 1], scalars[current]] = [scalars[current], scalars[current - 1]];
      current--;
    }
  }
  return scalars.map((scalar) => String.fromCodePoint(scalar)).join("");
}

function shouldBreak(scalars, index) {
  const left = scalars[index - 1];
  const right = scalars[index];
  const leftGcb = propertyAt(left, gcbRanges);
  const rightGcb = propertyAt(right, gcbRanges);
  if (leftGcb === "CR" && rightGcb === "LF") return false;
  if (["Control", "CR", "LF"].includes(leftGcb) ||
      ["Control", "CR", "LF"].includes(rightGcb)) return true;
  if (leftGcb === "L" && ["L", "V", "LV", "LVT"].includes(rightGcb)) return false;
  if (["LV", "V"].includes(leftGcb) && ["V", "T"].includes(rightGcb)) return false;
  if (["LVT", "T"].includes(leftGcb) && rightGcb === "T") return false;
  if (["Extend", "ZWJ", "SpacingMark"].includes(rightGcb) || leftGcb === "Prepend") return false;
  if (propertyAt(right, incbRanges) === "Consonant") {
    let cursor = index - 1;
    let linkerSeen = false;
    while (cursor >= 0) {
      const property = propertyAt(scalars[cursor], incbRanges);
      if (property === "Linker") linkerSeen = true;
      else if (property === "Consonant") return !linkerSeen;
      else if (property !== "Extend") break;
      cursor--;
    }
  }
  if (propertyAt(right, pictographicRanges) === "Yes" && leftGcb === "ZWJ") {
    let cursor = index - 2;
    while (cursor >= 0 && propertyAt(scalars[cursor], gcbRanges) === "Extend") cursor--;
    if (cursor >= 0 && propertyAt(scalars[cursor], pictographicRanges) === "Yes") return false;
  }
  if (leftGcb === "Regional_Indicator" && rightGcb === "Regional_Indicator") {
    let count = 0;
    let cursor = index - 1;
    while (cursor >= 0 && propertyAt(scalars[cursor], gcbRanges) === "Regional_Indicator") {
      count++;
      cursor--;
    }
    return count % 2 === 0;
  }
  return true;
}

function splitGraphemes151(text) {
  const scalars = Array.from(text, (character) => character.codePointAt(0));
  const result = [];
  let start = 0;
  for (let index = 1; index < scalars.length; index++) {
    if (shouldBreak(scalars, index)) {
      result.push(scalars.slice(start, index).map((scalar) => String.fromCodePoint(scalar)).join(""));
      start = index;
    }
  }
  if (scalars.length) {
    result.push(scalars.slice(start).map((scalar) => String.fromCodePoint(scalar)).join(""));
  }
  return result;
}

// Scans only the cluster starting at offset; offset is always a cluster boundary, so the
// lookback rules never need scalars before it.
function firstGrapheme151(text, offset) {
  const scalars = [];
  let end = offset;
  while (end < text.length) {
    const scalar = text.codePointAt(end);
    scalars.push(scalar);
    if (scalars.length > 1 && shouldBreak(scalars, scalars.length - 1)) break;
    end += scalar > 0xffff ? 2 : 1;
  }
  return text.slice(offset, end);
}

function replacementNormalize(text) {
  let result = normalizeNfkd151(text).replace(EMOJI_PATTERN, "");
  const replacements = new Map([
    ["–", "-"], ["‑", "-"], ["—", "-"], ["_", " "],
    ["“", "\""], ["”", "\""], ["‘", "'"], ["’", "'"],
    ["´", "'"], ["`", "'"], ["[", " "], ["]", " "], ["|", " "],
    ["/", " "], ["#", " "], ["→", " "], ["←", " "],
  ]);
  for (const [source, target] of replacements) result = result.replaceAll(source, target);
  result = result.replace(/[♥☆♡©\\]/gu, "");
  result = result.replaceAll("@", " at ")
    .replaceAll("e.g.,", "for example, ")
    .replaceAll("i.e.,", "that is, ");
  result = result.replace(/ ([,.!?;:])/gu, "$1").replace(/ '/gu, "'");
  while (result.includes("\"\"")) result = result.replaceAll("\"\"", "\"");
  while (result.includes("''")) result = result.replaceAll("''", "'");
  result = result.replace(/\s+/gu, " ").trim();
  if (result.length === 0) return "";
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/u.test(result)) result += ".";
  return result;
}

function scalarLength(text) {
  return [...text].length;
}

function textUnits(text) {
  const units = [];
  for (let offset = 0; offset < text.length;) {
    EXPRESSION_PATTERN.lastIndex = offset;
    const match = EXPRESSION_PATTERN.exec(text);
    if (match && match.index === offset) {
      units.push({ text: match[0], width: scalarLength(match[0]), indivisible: true });
      offset += match[0].length;
      continue;
    }
    const segment = firstGrapheme151(text, offset);
    units.push({ text: segment, width: scalarLength(segment), indivisible: true });
    offset += segment.length;
  }
  return units;
}

function chunkWithinSentence(text, budget) {
  const units = textUnits(text);
  const chunks = [];
  let current = "";
  let width = 0;
  let lastWhitespaceIndex = -1;
  let widthAtWhitespace = 0;
  for (const unit of units) {
    if (unit.width > budget) {
      throw new ContractValidationError("indivisible text unit exceeds chunk budget");
    }
    if (width + unit.width <= budget) {
      current += unit.text;
      width += unit.width;
      if (/^\s+$/u.test(unit.text)) {
        lastWhitespaceIndex = current.length - unit.text.length;
        widthAtWhitespace = width - unit.width;
      }
      continue;
    }
    if (lastWhitespaceIndex >= 0) {
      const before = current.slice(0, lastWhitespaceIndex).trim();
      const after = current.slice(lastWhitespaceIndex).trimStart();
      if (before) chunks.push(before);
      current = after + unit.text;
      width = width - widthAtWhitespace - 1 + unit.width;
    } else {
      if (current) chunks.push(current);
      current = unit.text;
      width = unit.width;
    }
    lastWhitespaceIndex = -1;
    widthAtWhitespace = 0;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function splitSentences(text) {
  const abbreviations = new Set([
    "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "Ph.D.", "etc.",
    "e.g.", "i.e.", "vs.", "Inc.", "Ltd.", "Co.", "Corp.", "St.", "Ave.",
    "Blvd.",
  ]);
  const sentences = [];
  let start = 0;
  for (const match of text.matchAll(/\s+/gu)) {
    const prefix = text.slice(start, match.index);
    if (!/[.!?]$/u.test(prefix)) continue;
    const finalToken = prefix.match(/(?:^|\s)(\S+)$/u)?.[1];
    if (abbreviations.has(finalToken) || /^[A-Z]\.$/u.test(finalToken ?? "")) continue;
    sentences.push(prefix);
    start = match.index + match[0].length;
  }
  const remainder = text.slice(start);
  if (remainder) sentences.push(remainder);
  return sentences;
}

export function chunkNormalizedText(text, budget) {
  if (!Number.isInteger(budget) || budget < 1) {
    throw new ContractValidationError("chunk budget must be a positive integer");
  }
  const chunks = [];
  let current = "";
  for (const sentence of splitSentences(text)) {
    const sentenceWidth = scalarLength(sentence);
    if (sentenceWidth <= budget) {
      const combined = current ? `${current} ${sentence}` : sentence;
      if (scalarLength(combined) <= budget) {
        current = combined;
      } else {
        if (current) chunks.push(current);
        current = sentence;
      }
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    const pieces = chunkWithinSentence(sentence, budget);
    chunks.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? "";
  }
  if (current) chunks.push(current);
  return chunks;
}

export function evaluateText(input, contract) {
  const { text, language } = input;
  if (!contract.inputs.languages.includes(language)) {
    return { errorCode: "UNSUPPORTED_LANGUAGE", errorStage: "language_validation" };
  }
  if (typeof text !== "string" || text.length === 0) {
    return { errorCode: "INVALID_ARGUMENT", errorStage: "text_validation" };
  }
  if (scalarLength(text) > contract.limits.rawUnicodeScalarsPerItem) {
    return { errorCode: "RESOURCE_EXHAUSTED", errorStage: "raw_text_validation" };
  }
  const normalizedText = replacementNormalize(text);
  const normalizedCodepoints = [...normalizedText].map((character) => character.codePointAt(0));
  const details = {
    normalizedText,
    normalizedCodepoints,
    wrappedText: `<${language}>${normalizedText}</${language}>`,
    expressionTokens: [...normalizedText.matchAll(/<(?:laugh|breath|sigh)>/gu)].map(([token]) => token),
    graphemes: splitGraphemes151(normalizeNfkd151(text)),
    boundary: normalizedCodepoints.length,
    ...(language === "na" ? { transcriptionLanguageHint: "en", preserveText: true } : {}),
    treatedAsData: true,
  };
  if (normalizedText.length === 0) {
    return { ...details, errorCode: "INVALID_ARGUMENT", errorStage: "preprocess" };
  }
  if (normalizedCodepoints.some((codepoint) => codepoint > 0xffff)) {
    return {
      ...details,
      retainedBeforeRejection: true,
      errorCode: "UNSUPPORTED_CHARACTER",
      errorStage: "indexing",
    };
  }
  const budget = input.chunkLimit ??
    (language === "ko" || language === "ja"
      ? contract.text.chunkScalarBudgets[language]
      : contract.text.chunkScalarBudgets.default);
  try {
    return {
      ...details,
      chunks: chunkNormalizedText(normalizedText, budget),
    };
  } catch {
    return { ...details, errorCode: "RESOURCE_EXHAUSTED", errorStage: "chunking" };
  }
}

function styleError(input) {
  for (const key of ["style_ttl", "style_dp"]) {
    const tensor = input[key];
    if (!tensor || !Array.isArray(tensor.dims) || tensor.dims.length !== 3 ||
        tensor.dims.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) {
      return "STYLE_MISMATCH";
    }
    const product = tensor.dims.reduce((total, dimension) => total * dimension, 1);
    if (!Number.isSafeInteger(product) || !Array.isArray(tensor.data) ||
        tensor.data.length !== product ||
        tensor.data.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return "STYLE_MISMATCH";
    }
  }
  return null;
}

export function evaluateFixture(fixture, contract) {
  const { input, kind } = fixture;
  if (kind === "text") return evaluateText(input, contract);
  if (kind === "batch") {
    const limit = input.surface === "sdk"
      ? contract.limits.sdkRawBatchItems
      : contract.limits.httpCompatibilityBatchItems;
    return input.itemCount <= limit
      ? { accepted: true, httpStatus: input.surface === "http_compat" ? 200 : undefined,
          execution: input.surface === "http_compat" ? "serialized_bounded_admission" : undefined }
      : {
          errorCode: input.surface === "sdk" ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT",
          errorStage: input.surface === "sdk" ? "batch_admission" : "http_schema",
          httpStatus: input.surface === "http_compat" ? 422 : undefined,
        };
  }
  if (kind === "request") {
    if (input.steps !== undefined &&
        (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 100)) {
      return { errorCode: "INVALID_ARGUMENT", errorStage: "request_validation" };
    }
    for (const [key, minimum, maximum] of [
      ["speed", 0.7, 2],
      ["silence_seconds", 0, 5],
    ]) {
      if (input[key] !== undefined &&
          (typeof input[key] !== "number" || !Number.isFinite(input[key]) ||
           input[key] < minimum || input[key] > maximum)) {
        return { errorCode: "INVALID_ARGUMENT", errorStage: "request_validation" };
      }
    }
    const effectiveSteps = input.steps ??
      contract.inputs.presets[input.preset ?? "balanced"];
    return {
      effectiveSteps,
      effectiveSpeed: input.speed ?? contract.inputs.defaults.speed,
      effectiveSilenceSeconds:
        input.silence_seconds ?? contract.inputs.defaults.silenceSeconds,
    };
  }
  if (kind === "style") {
    const errorCode = styleError(input);
    return errorCode ? { errorCode, errorStage: "style_validation" } : {};
  }
  if (kind === "duration") {
    return typeof input.modelDurationSeconds !== "number" ||
      !Number.isFinite(input.modelDurationSeconds) ||
      input.modelDurationSeconds <= 0
      ? { errorCode: "INFERENCE_FAILED", errorStage: "duration_validation", allocationAttempted: false }
      : { accepted: true };
  }
  if (kind === "audio") {
    const count = input.actualSamples.length;
    return {
      validSampleCount: count,
      durationSeconds: count / input.sampleRate,
      retainedSamples: input.actualSamples,
      silenceSamplesBetweenChunks: Math.round(input.sampleRate * input.silenceSeconds),
      silenceInsertions: Math.max(0, input.chunkCount - 1),
    };
  }
  if (kind === "lifecycle") {
    return {
      closeResults: input.actions.filter((action) => action === "close").map(() => "ok"),
      queuedCancelled: true,
      waitsForNativeOperation: true,
      finalError: {
        code: "ENGINE_CLOSED",
        message: "engine is closed",
        stage: "admission",
        request_id: "fixture-request",
        retryable: false,
      },
    };
  }
  if (kind === "provider") {
    if (input.failure) {
      return {
        fallbackAttempted: false,
        errorCode: input.failure,
        errorStage: "model_load",
      };
    }
    if (!input.available && !input.allowFallback) {
      return { errorCode: "PROVIDER_UNAVAILABLE", errorStage: "provider_selection" };
    }
    return {
      actual: input.available ? input.configured : "cpu",
      dtype: input.fallbackDtype ?? input.artifactDtype,
      fallbackCause: input.available ? undefined : "PROVIDER_UNAVAILABLE",
    };
  }
  if (kind === "capabilities") return { schemaValid: true };
  throw new ContractValidationError(`unsupported fixture kind ${kind}`);
}

const EXPECTED_FIELDS = {
  text: ["error", "normalizedText", "normalizedCodepoints", "chunks", "wrappedText",
    "tokenIds", "expressionTokens", "graphemes", "boundary", "transcriptionLanguageHint",
    "preserveText", "retainedBeforeRejection", "treatedAsData"],
  request: ["error", "effectiveSteps", "effectiveSpeed", "effectiveSilenceSeconds"],
  batch: ["error", "accepted", "httpStatus", "execution"],
  style: ["error"],
  duration: ["error", "accepted", "allocationAttempted"],
  audio: ["validSampleCount", "durationSeconds", "retainedSamples",
    "silenceSamplesBetweenChunks", "silenceInsertions"],
  lifecycle: ["closeResults", "finalError", "queuedCancelled", "waitsForNativeOperation"],
  provider: ["error", "fallbackAttempted", "actual", "dtype", "fallbackCause"],
  capabilities: ["schemaValid"],
};

function compareExpected(fixture, actual, errorSchema) {
  const expected = fixture.expected;
  for (const key of Object.keys(expected)) {
    if (!EXPECTED_FIELDS[fixture.kind].includes(key)) {
      throw new ContractValidationError(`unexpected ${fixture.kind} expectation ${key}`, fixture.id);
    }
  }
  if (expected.error) {
    validateSchema(expected.error, errorSchema, `${fixture.id}.expected.error`);
    if (actual.errorCode !== expected.error.code) {
      throw new ContractValidationError(
        `fixture expected ${expected.error.code} but validator produced ${actual.errorCode ?? "success"}`,
        fixture.id,
      );
    }
    // Messages are prose; every other public error field is machine-consumed.
    const actualError = { stage: actual.errorStage, request_id: "fixture-request", retryable: false };
    for (const [field, value] of Object.entries(actualError)) {
      if (expected.error[field] !== value) {
        throw new ContractValidationError(
          `fixture error ${field} mismatch; expected ${JSON.stringify(expected.error[field])}, got ${JSON.stringify(value)}`,
          fixture.id,
        );
      }
    }
  } else if (actual.errorCode) {
    throw new ContractValidationError(
      `fixture unexpectedly rejected with ${actual.errorCode}`,
      fixture.id,
    );
  }
  if (expected.finalError !== undefined) {
    validateSchema(expected.finalError, errorSchema, `${fixture.id}.expected.finalError`);
  }
  if (expected.tokenIds !== undefined) {
    const mappings = fixture.contractModel?.unicodeIndexerKnownTokenIds;
    if (!mappings) throw new ContractValidationError("tokenIds require model indexer mappings", fixture.id);
    actual.tokenIds = [...actual.wrappedText].map((character) => {
      const codepoint = String(character.codePointAt(0));
      if (!Object.hasOwn(mappings, codepoint)) {
        throw new ContractValidationError(
          `no pinned token mapping for U+${Number(codepoint).toString(16).toUpperCase()}`,
          fixture.id,
        );
      }
      return mappings[codepoint];
    });
  }
  for (const [key, value] of Object.entries(expected)) {
    if (key !== "error" && JSON.stringify(actual[key]) !== JSON.stringify(value)) {
      throw new ContractValidationError(
        `fixture ${key} mismatch; expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`,
        fixture.id,
      );
    }
  }
}

export function validateFixtures(fixtures, fixtureSchema, errorSchema, contract) {
  for (const fixture of fixtures) {
    validateSchema(fixture, fixtureSchema, fixture.id ?? "$fixture");
    compareExpected(
      { ...fixture, contractModel: contract.model },
      evaluateFixture(fixture, contract),
      errorSchema,
    );
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyHash(bytes, expectedHash, label = "artifact") {
  const actual = sha256(bytes);
  if (actual !== expectedHash) {
    throw new ContractValidationError(
      `${label} hash mismatch: expected ${expectedHash}, got ${actual}`,
    );
  }
  return actual;
}

function isScalar(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff);
}

function validateSortedPairs(entries, label, validateEntry) {
  let previous = -1;
  for (const [index, entry] of entries.entries()) {
    validateEntry(entry, `${label}[${index}]`);
    if (entry[0] <= previous) {
      throw new ContractValidationError(`${label} must be strictly sorted`);
    }
    previous = entry[0];
  }
}

function validateNormalizationTable(table, schema) {
  validateSchema(table, schema, "$normalization");
  if (JSON.stringify(table.scalar_range) !== JSON.stringify([0, 0x10ffff])) {
    throw new ContractValidationError("normalization scalar_range mismatch");
  }
  validateSortedPairs(
    table.decomposition_mappings,
    "decomposition_mappings",
    (entry, path) => {
      if (entry.length !== 2 || !isScalar(entry[0]) || !Array.isArray(entry[1]) ||
          entry[1].length === 0 || entry[1].some((scalar) => !isScalar(scalar))) {
        throw new ContractValidationError("invalid direct decomposition mapping", path);
      }
    },
  );
  validateSortedPairs(
    table.canonical_combining_classes,
    "canonical_combining_classes",
    (entry, path) => {
      if (entry.length !== 2 || !isScalar(entry[0]) ||
          !Number.isInteger(entry[1]) || entry[1] <= 0 || entry[1] > 255) {
        throw new ContractValidationError("invalid combining-class entry", path);
      }
    },
  );
}

function validateGraphemeTable(table, schema) {
  validateSchema(table, schema, "$grapheme");
  const allowed = {
    Grapheme_Cluster_Break: new Set([
      "CR", "LF", "Control", "Extend", "ZWJ", "Regional_Indicator",
      "Prepend", "SpacingMark", "L", "V", "T", "LV", "LVT",
    ]),
    Extended_Pictographic: new Set(["Yes"]),
    Indic_Conjunct_Break: new Set(["Consonant", "Extend", "Linker"]),
  };
  for (const [property, ranges] of Object.entries(table.properties)) {
    let previousEnd = -1;
    for (const [index, entry] of ranges.entries()) {
      const [start, end, value] = entry;
      if (entry.length !== 3 || !isScalar(start) || !isScalar(end) ||
          start > end || start <= previousEnd || !allowed[property].has(value)) {
        throw new ContractValidationError(
          `invalid or overlapping ${property} range`,
          `${property}[${index}]`,
        );
      }
      previousEnd = end;
    }
  }
  const ruleIds = new Set(table.rules.map(({ id }) => id));
  for (const required of ["GB3", "GB9c", "GB11", "GB999"]) {
    if (!ruleIds.has(required)) {
      throw new ContractValidationError(`grapheme rules missing ${required}`);
    }
  }
}

export async function validateUnicodeArtifacts(
  contractRoot,
  manifestSchema,
  normalizationSchema,
  graphemeSchema,
) {
  const manifestPath = resolve(contractRoot, "unicode-manifest.json");
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "pending", checked: 0 };
    throw error;
  }
  validateSchema(manifest, manifestSchema, "$unicodeManifest");
  const tables = {
    "normalization.json": await readJson(resolve(contractRoot, "normalization.json")),
    "grapheme.json": await readJson(resolve(contractRoot, "grapheme.json")),
  };
  validateNormalizationTable(tables["normalization.json"], normalizationSchema);
  validateGraphemeTable(tables["grapheme.json"], graphemeSchema);
  let checked = 0;
  const hashes = { "unicode-manifest.json": sha256(await readFile(manifestPath)) };
  for (const [path, expectedHash] of Object.entries(manifest.generated_files)) {
    const artifactPath = resolve(dirname(manifestPath), path);
    hashes[path] = verifyHash(await readFile(artifactPath), expectedHash, path);
    checked += 1;
  }
  return { status: "verified", checked, schemasChecked: 2, hashes };
}
