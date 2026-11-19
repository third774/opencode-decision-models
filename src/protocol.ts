import { extname } from "node:path";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = Array<JsonValue>;

export type MediaKind = "image" | "audio" | "video" | "pdf";

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface JsonPart {
  readonly type: "json";
  readonly value: JsonValue;
}

export interface FilePart {
  readonly type: "file";
  readonly data: string;
  readonly mime: string;
  readonly kind: MediaKind;
  readonly name?: string;
}

export type InputPart = TextPart | JsonPart | FilePart;

export interface PredicateQuestion {
  readonly type: "predicate";
  readonly name: string;
  readonly instructions: string;
  readonly criteria?: {
    readonly true?: string;
    readonly false?: string;
  };
}

export interface ChoiceOption {
  readonly value: string | boolean;
  readonly description?: string;
}

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly name: string;
  readonly instructions: string;
  readonly choices: ReadonlyArray<ChoiceOption>;
}

export interface ScoreLevel {
  readonly label: string;
  readonly description?: string;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly name: string;
  readonly instructions: string;
  readonly levels: ReadonlyArray<ScoreLevel>;
}

export type Question = PredicateQuestion | ChoiceQuestion | ScoreQuestion;

export interface PredicateAnswer {
  readonly type: "predicate";
  readonly name: string;
  readonly probability: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly name: string;
  readonly choice: string | boolean;
  readonly confidence: number;
  readonly probabilities: ReadonlyArray<{
    readonly value: string | boolean;
    readonly probability: number;
  }>;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly name: string;
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: ReadonlyArray<{
    readonly value: number;
    readonly label: string;
    readonly probability: number;
  }>;
}

export interface ErrorAnswer {
  readonly type: "error";
  readonly name: string;
  readonly reason: string;
  readonly message?: string;
}

export type NormalizedAnswer = PredicateAnswer | ChoiceAnswer | ScoreAnswer | ErrorAnswer;

export interface DecisionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cost?: number;
}

export interface EvaluationResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, NormalizedAnswer>>;
  readonly usage?: DecisionUsage;
}

export type BatchItemResult =
  | {
      readonly id: string;
      readonly index: number;
      readonly ok: true;
      readonly answers: Readonly<Record<string, NormalizedAnswer>>;
    }
  | {
      readonly id: string;
      readonly index: number;
      readonly ok: false;
      readonly error: string;
    };

export interface AvailableDecisionModel {
  readonly ref: string;
  readonly providerID: string;
  readonly id: string;
  readonly name: string;
  readonly input: ReadonlyArray<string>;
}

export interface PluginConfig {
  readonly defaultModel?: string;
  readonly injectInstructions: boolean;
  readonly defaultConcurrency: number;
}

export interface ParsedEvaluateRequest {
  readonly rawInput: unknown;
  readonly files: ReadonlyArray<string>;
  readonly questions: ReadonlyArray<Question>;
  readonly model?: string;
}

export interface ParsedBatchItem {
  readonly id: string;
  readonly rawInput: unknown;
  readonly files: ReadonlyArray<string>;
}

export interface ParsedBatchRequest {
  readonly items: ReadonlyArray<ParsedBatchItem>;
  readonly questions: ReadonlyArray<Question>;
  readonly model?: string;
  readonly concurrency: number;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 8;
export const MAX_CONCURRENCY = 20;

const MIME_BY_EXTENSION: Readonly<Record<string, { readonly mime: string; readonly kind: MediaKind }>> = {
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".pdf": { mime: "application/pdf", kind: "pdf" },
  ".mp3": { mime: "audio/mpeg", kind: "audio" },
  ".wav": { mime: "audio/wav", kind: "audio" },
  ".m4a": { mime: "audio/mp4", kind: "audio" },
  ".ogg": { mime: "audio/ogg", kind: "audio" },
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
  ".mov": { mime: "video/quicktime", kind: "video" },
};

const DEFAULT_MODEL_PREFERENCE: ReadonlyArray<string> = [
  "cloudflare-workers-ai/@cf/cloudflare/clef-flash",
  "cloudflare-workers-ai/@cf/cloudflare/clef",
  "cloudflare-workers-ai/@cf/cloudflare/clef-omni",
  "opencode/jev-1.13",
  "opencode/jev-1.13-free",
  "google/gemini-decision-1",
];

const AUDIO_VIDEO_MODEL_PREFERENCE: ReadonlyArray<string> = [
  "cloudflare-workers-ai/@cf/cloudflare/clef-omni",
  "google/gemini-decision-1",
];

const PDF_MODEL_PREFERENCE: ReadonlyArray<string> = ["google/gemini-decision-1"];

export function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prop(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

export function parsePluginConfig(raw: unknown): PluginConfig {
  if (!isRecord(raw)) {
    return { injectInstructions: true, defaultConcurrency: DEFAULT_CONCURRENCY };
  }

  const rawDefaultModel = prop(raw, "defaultModel");
  const defaultModel =
    typeof rawDefaultModel === "string" && rawDefaultModel.trim().length > 0
      ? rawDefaultModel.trim()
      : undefined;

  const rawInject = prop(raw, "injectInstructions");
  const injectInstructions = typeof rawInject === "boolean" ? rawInject : true;

  const rawConcurrency = prop(raw, "defaultConcurrency");
  const defaultConcurrency =
    typeof rawConcurrency === "number" && Number.isInteger(rawConcurrency) && rawConcurrency >= 1
      ? Math.min(rawConcurrency, MAX_CONCURRENCY)
      : DEFAULT_CONCURRENCY;

  return {
    ...(defaultModel === undefined ? {} : { defaultModel }),
    injectInstructions,
    defaultConcurrency,
  };
}

export function toJsonValue(value: unknown): ParseResult<JsonValue> {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return ok(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? ok(value) : fail("Numbers in JSON input must be finite.");
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const parsed = toJsonValue(item);
      if (!parsed.ok) return parsed;
      items.push(parsed.value);
    }
    return ok(items);
  }
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      const parsed = toJsonValue(entry);
      if (!parsed.ok) return parsed;
      result[key] = parsed.value;
    }
    return ok(result);
  }
  return fail(`Unsupported input value of type ${typeof value}.`);
}

function parseOptionalString(value: unknown, field: string): ParseResult<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string") return fail(`${field} must be a string.`);
  const trimmed = value.trim();
  return ok(trimmed.length === 0 ? undefined : trimmed);
}

function parseStringArray(value: unknown, field: string): ParseResult<ReadonlyArray<string>> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return fail(`${field} must be an array of file paths.`);
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return fail(`Every entry in ${field} must be a non-empty string.`);
    }
    items.push(entry);
  }
  return ok(items);
}

function parseQuestion(raw: unknown, index: number): ParseResult<Question> {
  if (!isRecord(raw)) return fail(`questions[${index}] must be an object.`);

  const type = prop(raw, "type");
  const name = prop(raw, "name");
  const instructions = prop(raw, "instructions");

  if (typeof name !== "string" || name.trim().length === 0) {
    return fail(`questions[${index}].name must be a non-empty string.`);
  }
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    return fail(`questions[${index}].instructions must be a non-empty string.`);
  }

  if (type === "predicate") {
    const rawCriteria = prop(raw, "criteria");
    if (rawCriteria === undefined) {
      return ok({ type: "predicate", name, instructions });
    }
    if (!isRecord(rawCriteria)) {
      return fail(`questions[${index}].criteria must be an object with optional true/false strings.`);
    }
    const trueText = parseOptionalString(prop(rawCriteria, "true"), `questions[${index}].criteria.true`);
    if (!trueText.ok) return trueText;
    const falseText = parseOptionalString(prop(rawCriteria, "false"), `questions[${index}].criteria.false`);
    if (!falseText.ok) return falseText;

    const criteria: { true?: string; false?: string } = {};
    if (trueText.value !== undefined) criteria.true = trueText.value;
    if (falseText.value !== undefined) criteria.false = falseText.value;
    return ok({ type: "predicate", name, instructions, criteria });
  }

  if (type === "choice") {
    const rawChoices = prop(raw, "choices");
    if (!Array.isArray(rawChoices) || rawChoices.length < 2) {
      return fail(`questions[${index}].choices must be an array with at least 2 options.`);
    }
    const choices: ChoiceOption[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rawChoices.length; i += 1) {
      const entry = rawChoices[i];
      if (!isRecord(entry)) {
        return fail(`questions[${index}].choices[${i}] must be an object.`);
      }
      const value = prop(entry, "value");
      if (typeof value !== "string" && typeof value !== "boolean") {
        return fail(`questions[${index}].choices[${i}].value must be a string or boolean.`);
      }
      const key = String(value);
      if (seen.has(key)) {
        return fail(`questions[${index}].choices has duplicate option "${key}".`);
      }
      seen.add(key);

      const description = parseOptionalString(
        prop(entry, "description"),
        `questions[${index}].choices[${i}].description`,
      );
      if (!description.ok) return description;

      choices.push(description.value === undefined ? { value } : { value, description: description.value });
    }
    return ok({ type: "choice", name, instructions, choices });
  }

  if (type === "score") {
    const rawLevels = prop(raw, "levels");
    if (!Array.isArray(rawLevels) || rawLevels.length < 2) {
      return fail(`questions[${index}].levels must be an array with at least 2 ordered levels.`);
    }
    const levels: ScoreLevel[] = [];
    for (let i = 0; i < rawLevels.length; i += 1) {
      const entry = rawLevels[i];
      if (!isRecord(entry)) {
        return fail(`questions[${index}].levels[${i}] must be an object.`);
      }
      const label = prop(entry, "label");
      if (typeof label !== "string" || label.trim().length === 0) {
        return fail(`questions[${index}].levels[${i}].label must be a non-empty string.`);
      }
      const description = parseOptionalString(
        prop(entry, "description"),
        `questions[${index}].levels[${i}].description`,
      );
      if (!description.ok) return description;

      levels.push(description.value === undefined ? { label } : { label, description: description.value });
    }
    return ok({ type: "score", name, instructions, levels });
  }

  return fail(`questions[${index}].type must be "predicate", "choice", or "score".`);
}

export function parseQuestions(raw: unknown): ParseResult<ReadonlyArray<Question>> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail("questions must be a non-empty array.");
  }
  const questions: Question[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = parseQuestion(raw[i], i);
    if (!parsed.ok) return parsed;
    if (seenNames.has(parsed.value.name)) {
      return fail(`Duplicate question name "${parsed.value.name}".`);
    }
    seenNames.add(parsed.value.name);
    questions.push(parsed.value);
  }
  return ok(questions);
}

export function parseEvaluateRequest(raw: unknown): ParseResult<ParsedEvaluateRequest> {
  if (!isRecord(raw)) return fail("Input must be an object.");

  const rawInput = prop(raw, "input");
  const files = parseStringArray(prop(raw, "files"), "files");
  if (!files.ok) return files;

  if (rawInput === undefined && files.value.length === 0) {
    return fail("Provide input, files, or both.");
  }

  const questions = parseQuestions(prop(raw, "questions"));
  if (!questions.ok) return questions;

  const model = parseOptionalString(prop(raw, "model"), "model");
  if (!model.ok) return model;

  return ok({
    rawInput,
    files: files.value,
    questions: questions.value,
    model: model.value,
  });
}

export function parseBatchRequest(
  raw: unknown,
  defaultConcurrency = DEFAULT_CONCURRENCY,
): ParseResult<ParsedBatchRequest> {
  if (!isRecord(raw)) return fail("Input must be an object.");

  const rawItems = prop(raw, "items");
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return fail("items must be a non-empty array.");
  }

  const items: ParsedBatchItem[] = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const entry = rawItems[i];
    if (!isRecord(entry)) {
      return fail(`items[${i}] must be an object with an input field (and optional id and files).`);
    }
    const idResult = parseOptionalString(prop(entry, "id"), `items[${i}].id`);
    if (!idResult.ok) return idResult;

    const filesResult = parseStringArray(prop(entry, "files"), `items[${i}].files`);
    if (!filesResult.ok) return filesResult;

    const rawInput = prop(entry, "input");
    if (rawInput === undefined && filesResult.value.length === 0) {
      return fail(`items[${i}] must include input, files, or both.`);
    }

    items.push({
      id: idResult.value ?? String(i),
      rawInput,
      files: filesResult.value,
    });
  }

  const questions = parseQuestions(prop(raw, "questions"));
  if (!questions.ok) return questions;

  const model = parseOptionalString(prop(raw, "model"), "model");
  if (!model.ok) return model;

  const rawConcurrency = prop(raw, "concurrency");
  let concurrency = defaultConcurrency;
  if (rawConcurrency !== undefined) {
    if (typeof rawConcurrency !== "number" || !Number.isInteger(rawConcurrency) || rawConcurrency < 1) {
      return fail("concurrency must be a positive integer.");
    }
    concurrency = Math.min(rawConcurrency, MAX_CONCURRENCY);
  }

  return ok({
    items,
    questions: questions.value,
    model: model.value,
    concurrency,
  });
}

export function parseInputParts(rawInput: unknown): ParseResult<ReadonlyArray<TextPart | JsonPart>> {
  if (rawInput === undefined) return ok([]);
  if (typeof rawInput === "string") {
    return ok([{ type: "text", text: rawInput }]);
  }
  if (Array.isArray(rawInput)) {
    const looksLikeExplicitParts =
      rawInput.length > 0 &&
      rawInput.every((item) => {
        if (!isRecord(item)) return false;
        const type = prop(item, "type");
        return type === "text" || type === "json";
      });

    if (looksLikeExplicitParts) {
      const parts: Array<TextPart | JsonPart> = [];
      for (let i = 0; i < rawInput.length; i += 1) {
        const entry = rawInput[i];
        if (!isRecord(entry)) continue;
        const type = prop(entry, "type");
        if (type === "text") {
          const text = prop(entry, "text");
          if (typeof text !== "string") return fail(`input[${i}].text must be a string.`);
          parts.push({ type: "text", text });
        } else {
          const parsed = toJsonValue(prop(entry, "value"));
          if (!parsed.ok) return fail(`input[${i}].value: ${parsed.error}`);
          parts.push({ type: "json", value: parsed.value });
        }
      }
      return ok(parts);
    }
  }

  const parsedJson = toJsonValue(rawInput);
  if (!parsedJson.ok) return parsedJson;
  return ok([{ type: "json", value: parsedJson.value }]);
}

export function resolveMediaType(
  filePath: string,
): ParseResult<{ readonly mime: string; readonly kind: MediaKind }> {
  const extension = extname(filePath).toLowerCase();
  const match = Object.getOwnPropertyDescriptor(MIME_BY_EXTENSION, extension)?.value;
  if (isRecord(match)) {
    const mime = prop(match, "mime");
    const kind = prop(match, "kind");
    if (
      typeof mime === "string" &&
      (kind === "image" || kind === "audio" || kind === "video" || kind === "pdf")
    ) {
      return ok({ mime, kind });
    }
  }
  const supported = Object.keys(MIME_BY_EXTENSION).join(", ");
  return fail(`Unsupported media extension "${extension || "(none)"}" for ${filePath}. Supported: ${supported}.`);
}

export function findModelBySelector(
  models: ReadonlyArray<AvailableDecisionModel>,
  selector: string,
): AvailableDecisionModel | undefined {
  const normalized = selector.trim().toLowerCase();
  if (normalized.length === 0) return undefined;

  const exactRef = models.find((model) => model.ref.toLowerCase() === normalized);
  if (exactRef !== undefined) return exactRef;

  const exactId = models.find((model) => model.id.toLowerCase() === normalized);
  if (exactId !== undefined) return exactId;

  const suffixMatch = models.find((model) => model.id.toLowerCase().endsWith(`/${normalized}`));
  if (suffixMatch !== undefined) return suffixMatch;

  if (normalized === "gemini") {
    return models.find((model) => model.id.toLowerCase().includes("gemini"));
  }
  if (normalized === "jev") {
    return models.find((model) => model.id.toLowerCase().includes("jev"));
  }

  return models.find(
    (model) =>
      model.ref.toLowerCase().includes(normalized) || model.name.toLowerCase().includes(normalized),
  );
}

export function selectDefaultModel(
  models: ReadonlyArray<AvailableDecisionModel>,
  mediaKinds: ReadonlySet<MediaKind>,
  options?: {
    readonly envDefault?: string;
    readonly configDefault?: string;
  },
): AvailableDecisionModel | undefined {
  if (mediaKinds.has("pdf")) {
    for (const ref of PDF_MODEL_PREFERENCE) {
      const match = findModelBySelector(models, ref);
      if (match !== undefined) return match;
    }
  }

  if (mediaKinds.has("audio") || mediaKinds.has("video")) {
    for (const ref of AUDIO_VIDEO_MODEL_PREFERENCE) {
      const match = findModelBySelector(models, ref);
      if (match !== undefined) return match;
    }
  }

  const envDefault = options?.envDefault?.trim();
  if (envDefault !== undefined && envDefault.length > 0) {
    const match = findModelBySelector(models, envDefault);
    if (match !== undefined) return match;
  }

  const configDefault = options?.configDefault?.trim();
  if (configDefault !== undefined && configDefault.length > 0) {
    const match = findModelBySelector(models, configDefault);
    if (match !== undefined) return match;
  }

  for (const ref of DEFAULT_MODEL_PREFERENCE) {
    const match = findModelBySelector(models, ref);
    if (match !== undefined) return match;
  }

  return models[0];
}

export function encodeSystemOneQuestions(questions: ReadonlyArray<Question>): JsonObject {
  const encoded: JsonObject = {};
  for (const question of questions) {
    if (question.type === "predicate") {
      const entry: JsonObject = {
        type: "noul",
        instructions: question.instructions,
      };
      if (question.criteria !== undefined) {
        const criteria: JsonObject = {};
        if (question.criteria.true !== undefined) criteria.true = question.criteria.true;
        if (question.criteria.false !== undefined) criteria.false = question.criteria.false;
        entry.criteria = criteria;
      }
      encoded[question.name] = entry;
    } else if (question.type === "choice") {
      const criteria: JsonObject = {};
      for (const choice of question.choices) {
        criteria[String(choice.value)] = choice.description ?? null;
      }
      encoded[question.name] = {
        type: "choice",
        instructions: question.instructions,
        criteria,
      };
    } else {
      const criteria: JsonArray = question.levels.map((level) =>
        level.description === undefined ? level.label : `${level.label}: ${level.description}`,
      );
      encoded[question.name] = {
        type: "score",
        instructions: question.instructions,
        criteria,
      };
    }
  }
  return encoded;
}

export function encodeGoogleQuestions(questions: ReadonlyArray<Question>): JsonObject {
  const encoded = encodeSystemOneQuestions(questions);
  for (const question of questions) {
    if (question.type === "predicate" && question.criteria !== undefined) {
      const criteria: JsonObject = {};
      if (question.criteria.true !== undefined) criteria.true_description = question.criteria.true;
      if (question.criteria.false !== undefined) criteria.false_description = question.criteria.false;
      encoded[question.name] = {
        type: "noul",
        instructions: question.instructions,
        criteria,
      };
    }
  }
  return encoded;
}

function readNumberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = prop(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function decodeSystemOneAnswer(question: Question, raw: unknown): NormalizedAnswer {
  if (!isRecord(raw)) {
    return {
      type: "error",
      name: question.name,
      reason: "invalid_response",
      message: "Answer was not an object.",
    };
  }

  const type = prop(raw, "type");
  if (type === "refusal" || type === "error") {
    const message = prop(raw, "message");
    const reason = prop(raw, "reason");
    return {
      type: "error",
      name: question.name,
      reason: typeof reason === "string" ? reason : "refusal",
      ...(typeof message === "string" ? { message } : {}),
    };
  }

  if (type === "noul" || type === "predicate") {
    const probability = readNumberField(raw, "noul") ?? readNumberField(raw, "probability");
    if (probability === undefined) {
      return {
        type: "error",
        name: question.name,
        reason: "invalid_response",
        message: "Missing predicate probability.",
      };
    }
    return { type: "predicate", name: question.name, probability };
  }

  if (type === "choice") {
    const rawChoice = prop(raw, "choice");
    const confidence = readNumberField(raw, "confidence") ?? 0;
    const rawProbabilities = prop(raw, "probabilities");
    const choices = question.type === "choice" ? question.choices : [];
    const resolveChoiceValue = (key: string): string | boolean =>
      choices.find((entry) => String(entry.value) === key)?.value ?? key;
    const rank = (key: string): number => {
      const index = choices.findIndex((entry) => String(entry.value) === key);
      return index === -1 ? choices.length : index;
    };

    const probabilities: Array<{ value: string | boolean; probability: number }> = [];
    if (isRecord(rawProbabilities)) {
      const entries = Object.entries(rawProbabilities).sort(([a], [b]) => rank(a) - rank(b));
      for (const [key, value] of entries) {
        if (typeof value === "number" && Number.isFinite(value)) {
          probabilities.push({ value: resolveChoiceValue(key), probability: value });
        }
      }
    }

    const choice =
      typeof rawChoice === "string" || typeof rawChoice === "boolean"
        ? resolveChoiceValue(String(rawChoice))
        : "";
    return {
      type: "choice",
      name: question.name,
      choice,
      confidence,
      probabilities,
    };
  }

  if (type === "score") {
    const score = readNumberField(raw, "score");
    const confidence = readNumberField(raw, "confidence") ?? 0;
    const rawProbabilities = prop(raw, "probabilities");
    const levels = question.type === "score" ? question.levels : [];

    const probabilities: Array<{ value: number; label: string; probability: number }> = [];
    if (isRecord(rawProbabilities)) {
      for (const [key, value] of Object.entries(rawProbabilities)) {
        const numericKey = Number(key);
        if (Number.isFinite(numericKey) && typeof value === "number" && Number.isFinite(value)) {
          probabilities.push({
            value: numericKey,
            label: levels[numericKey]?.label ?? key,
            probability: value,
          });
        }
      }
      probabilities.sort((a, b) => a.value - b.value);
    }

    if (score === undefined) {
      return {
        type: "error",
        name: question.name,
        reason: "invalid_response",
        message: "Missing score value.",
      };
    }

    return {
      type: "score",
      name: question.name,
      score,
      confidence,
      probabilities,
    };
  }

  return {
    type: "error",
    name: question.name,
    reason: "invalid_response",
    message: `Unexpected answer type "${String(type)}".`,
  };
}

export function unwrapSystemOneEnvelope(body: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(prop(body, "answers"))) return body;

  const result = prop(body, "result");
  if (!isRecord(result)) return undefined;
  if (isRecord(prop(result, "answers"))) return result;

  const nestedResult = prop(result, "result");
  if (isRecord(nestedResult) && isRecord(prop(nestedResult, "answers"))) return nestedResult;

  return undefined;
}

export function extractUsage(body: Readonly<Record<string, unknown>>): DecisionUsage | undefined {
  const usage = prop(body, "usage");
  if (!isRecord(usage)) return undefined;

  const inputTokens = readNumberField(usage, "input_tokens") ?? readNumberField(usage, "total_input_tokens");
  const outputTokens = readNumberField(usage, "output_tokens") ?? readNumberField(usage, "total_output_tokens");
  const cost = readNumberField(usage, "cost");

  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cost === undefined ? {} : { cost }),
  };
}

export function extractErrorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;

  const directMessage = prop(body, "message");
  if (typeof directMessage === "string" && directMessage.length > 0) return directMessage;

  const errorObj = prop(body, "error");
  if (isRecord(errorObj)) {
    const nested = prop(errorObj, "message");
    if (typeof nested === "string" && nested.length > 0) return nested;
  }

  const errors = prop(body, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (isRecord(first)) {
      const nested = prop(first, "message");
      if (typeof nested === "string" && nested.length > 0) return nested;
    }
  }

  return fallback;
}

function hasHeaderCaseInsensitive(headers: Readonly<Record<string, string>>, target: string): boolean {
  const lower = target.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/** Reads an API key from a stored OpenCode credential, supporting `key` and `oauth` credentials. */
export function resolveCredentialApiKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const type = prop(value, "type");
  if (type === "key") {
    const key = prop(value, "key");
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }
  if (type === "oauth") {
    const access = prop(value, "access");
    return typeof access === "string" && access.length > 0 ? access : undefined;
  }
  return undefined;
}

/** Candidate Workers AI URLs for a provider baseURL, preferring the documented AI Gateway run path. */
export function buildCloudflareCandidateUrls(
  baseURL: string,
  modelID: string,
): ReadonlyArray<string> {
  const base = baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (base.includes("gateway.ai.cloudflare.com")) {
    return [`${base}/run/${modelID}`, `${base}/${modelID}`];
  }
  return [`${base}/run/${modelID}`];
}

export function buildRequestHeaders(
  providerHeaders: Readonly<Record<string, string>> | undefined,
  apiKey: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (providerHeaders !== undefined) {
    for (const [key, value] of Object.entries(providerHeaders)) {
      headers[key] = value;
    }
  }
  if (apiKey !== undefined && apiKey.length > 0 && !hasHeaderCaseInsensitive(headers, "authorization")) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export function buildCloudflareRunBody(
  parts: ReadonlyArray<InputPart>,
  questions: ReadonlyArray<Question>,
): ParseResult<JsonObject> {
  const nonMedia: JsonArray = [];
  const images: JsonArray = [];
  const audio: JsonArray = [];
  const videos: JsonArray = [];

  for (const part of parts) {
    if (part.type === "text") {
      nonMedia.push(part.text);
    } else if (part.type === "json") {
      nonMedia.push(part.value);
    } else {
      const dataUrl = `data:${part.mime};base64,${part.data}`;
      if (part.kind === "image") {
        images.push(dataUrl);
      } else if (part.kind === "audio") {
        audio.push(dataUrl);
      } else if (part.kind === "video") {
        videos.push(dataUrl);
      } else {
        return fail("Cloudflare Clef models do not accept PDF files. Use google/gemini-decision-1 for PDFs.");
      }
    }
  }

  const state: JsonValue =
    nonMedia.length === 0 ? "" : nonMedia.length === 1 ? nonMedia[0] : nonMedia;

  const body: JsonObject = {
    state,
    questions: encodeSystemOneQuestions(questions),
  };
  if (images.length > 0) body.images = images;
  if (audio.length > 0) body.audio = audio;
  if (videos.length > 0) body.videos = videos;

  return ok(body);
}

export function buildGoogleDecisionsBody(
  modelID: string,
  parts: ReadonlyArray<InputPart>,
  questions: ReadonlyArray<Question>,
): JsonObject {
  const input: JsonArray = [];
  let previousWasText = false;

  for (const part of parts) {
    if (part.type === "text" || part.type === "json") {
      const rawText = part.type === "text" ? part.text : JSON.stringify(part.value);
      const text = previousWasText ? `\n${rawText}` : rawText;
      input.push({ type: "text", text });
      previousWasText = true;
    } else {
      const googleType = part.kind === "pdf" ? "document" : part.kind;
      input.push({
        type: googleType,
        mime_type: part.mime,
        data: part.data,
      });
      previousWasText = false;
    }
  }

  return {
    model: modelID,
    input,
    questions: encodeGoogleQuestions(questions),
  };
}

export function answersArrayToRecord(
  answers: ReadonlyArray<NormalizedAnswer>,
): Readonly<Record<string, NormalizedAnswer>> {
  const mapped: Record<string, NormalizedAnswer> = {};
  for (const answer of answers) {
    mapped[answer.name] = answer;
  }
  return mapped;
}
