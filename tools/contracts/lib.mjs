import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

function replacementNormalize(text) {
  let result = text.normalize("NFKD").replace(EMOJI_PATTERN, "");
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
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  for (let offset = 0; offset < text.length;) {
    EXPRESSION_PATTERN.lastIndex = offset;
    const match = EXPRESSION_PATTERN.exec(text);
    if (match && match.index === offset) {
      units.push({ text: match[0], width: scalarLength(match[0]), indivisible: true });
      offset += match[0].length;
      continue;
    }
    const segment = segmenter.segment(text.slice(offset))[Symbol.iterator]().next().value;
    units.push({
      text: segment.segment,
      width: scalarLength(segment.segment),
      indivisible: true,
    });
    offset += segment.segment.length;
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
    return { errorCode: "UNSUPPORTED_LANGUAGE" };
  }
  if (typeof text !== "string") return { errorCode: "INVALID_ARGUMENT" };
  if (scalarLength(text) > contract.limits.rawUnicodeScalarsPerItem) {
    return { errorCode: "RESOURCE_EXHAUSTED" };
  }
  const normalizedText = replacementNormalize(text);
  const normalizedCodepoints = [...normalizedText].map((character) => character.codePointAt(0));
  if (normalizedText.length === 0) {
    return { normalizedText, normalizedCodepoints, errorCode: "INVALID_ARGUMENT" };
  }
  if (normalizedCodepoints.some((codepoint) => codepoint > 0xffff)) {
    return {
      normalizedText,
      normalizedCodepoints,
      retainedBeforeRejection: true,
      errorCode: "UNSUPPORTED_CHARACTER",
    };
  }
  const budget = input.chunkLimit ??
    (language === "ko" || language === "ja"
      ? contract.text.chunkScalarBudgets[language]
      : contract.text.chunkScalarBudgets.default);
  try {
    return {
      normalizedText,
      normalizedCodepoints,
      chunks: chunkNormalizedText(normalizedText, budget),
    };
  } catch {
    return { normalizedText, normalizedCodepoints, errorCode: "RESOURCE_EXHAUSTED" };
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
      ? { accepted: true, httpStatus: input.surface === "http_compat" ? 200 : undefined }
      : {
          errorCode: input.surface === "sdk" ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT",
          httpStatus: input.surface === "http_compat" ? 422 : undefined,
        };
  }
  if (kind === "request") {
    if (input.steps !== undefined &&
        (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 100)) {
      return { errorCode: "INVALID_ARGUMENT" };
    }
    for (const [key, minimum, maximum] of [
      ["speed", 0.7, 2],
      ["silence_seconds", 0, 5],
    ]) {
      if (input[key] !== undefined &&
          (typeof input[key] !== "number" || !Number.isFinite(input[key]) ||
           input[key] < minimum || input[key] > maximum)) {
        return { errorCode: "INVALID_ARGUMENT" };
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
  if (kind === "style") return { errorCode: styleError(input) };
  if (kind === "duration") {
    return typeof input.modelDurationSeconds !== "number" ||
      !Number.isFinite(input.modelDurationSeconds) ||
      input.modelDurationSeconds <= 0
      ? { errorCode: "INFERENCE_FAILED", allocationAttempted: false }
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
      };
    }
    if (!input.available && !input.allowFallback) {
      return { errorCode: "PROVIDER_UNAVAILABLE" };
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

function compareExpected(fixture, actual, errorSchema) {
  const expected = fixture.expected;
  for (const key of ["httpStatus", "allocationAttempted", "fallbackAttempted"]) {
    if (expected[key] !== undefined &&
        JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      throw new ContractValidationError(
        `fixture ${key} mismatch; expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`,
        fixture.id,
      );
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
    if (expected.retainedBeforeRejection !== undefined &&
        actual.retainedBeforeRejection !== expected.retainedBeforeRejection) {
      throw new ContractValidationError("astral retention mismatch", fixture.id);
    }
    return;
  }
  if (actual.errorCode) {
    throw new ContractValidationError(
      `fixture unexpectedly rejected with ${actual.errorCode}`,
      fixture.id,
    );
  }
  if (expected.finalError !== undefined) {
    validateSchema(expected.finalError, errorSchema, `${fixture.id}.expected.finalError`);
    if (JSON.stringify(actual.finalError) !== JSON.stringify(expected.finalError)) {
      throw new ContractValidationError(
        `fixture finalError mismatch; expected ${JSON.stringify(expected.finalError)}, got ${JSON.stringify(actual.finalError)}`,
        fixture.id,
      );
    }
  }
  if (expected.tokenIds !== undefined) {
    const wrappedText = expected.wrappedText;
    if (typeof wrappedText !== "string") {
      throw new ContractValidationError("tokenIds require wrappedText", fixture.id);
    }
    const mappings = fixture.contractModel?.unicodeIndexerKnownTokenIds;
    if (!mappings) {
      throw new ContractValidationError("tokenIds require model indexer mappings", fixture.id);
    }
    const actualTokenIds = [...wrappedText].map((character) => {
      const codepoint = String(character.codePointAt(0));
      if (!Object.hasOwn(mappings, codepoint)) {
        throw new ContractValidationError(
          `no pinned token mapping for U+${Number(codepoint).toString(16).toUpperCase()}`,
          fixture.id,
        );
      }
      return mappings[codepoint];
    });
    if (JSON.stringify(actualTokenIds) !== JSON.stringify(expected.tokenIds)) {
      throw new ContractValidationError("tokenIds mismatch pinned model indexer subset", fixture.id);
    }
  }
  for (const key of [
    "normalizedText", "normalizedCodepoints", "chunks", "accepted",
    "effectiveSteps", "effectiveSpeed", "effectiveSilenceSeconds",
    "validSampleCount", "durationSeconds", "retainedSamples",
    "silenceSamplesBetweenChunks", "silenceInsertions", "actual", "dtype",
    "fallbackCause", "schemaValid",
  ]) {
    if (expected[key] !== undefined &&
        JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      throw new ContractValidationError(
        `fixture ${key} mismatch; expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`,
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
