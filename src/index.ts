import { Plugin } from "@opencode/plugin";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  answersArrayToRecord,
  buildCloudflareCandidateUrls,
  buildCloudflareRunBody,
  buildGoogleDecisionsBody,
  buildRequestHeaders,
  decodeSystemOneAnswer,
  extractErrorMessage,
  extractUsage,
  fail,
  findModelBySelector,
  isRecord,
  MAX_CONCURRENCY,
  MAX_FILE_BYTES,
  ok,
  parseBatchRequest,
  parseEvaluateRequest,
  parseInputParts,
  parsePluginConfig,
  prop,
  resolveCredentialApiKey,
  resolveMediaType,
  selectDefaultModel,
  unwrapSystemOneEnvelope,
  type AvailableDecisionModel,
  type BatchItemResult,
  type DecisionUsage,
  type EvaluationResult,
  type FilePart,
  type InputPart,
  type JsonValue,
  type MediaKind,
  type NormalizedAnswer,
  type ParseResult,
  type Question,
} from "./protocol.ts";

const SYSTEM_INSTRUCTIONS = `# Decision models (Code Mode)

Use \`tools.decision.*\` inside \`execute\` for fast yes/no predicates, classification, and rubric scoring without pulling large raw data into context.

- \`tools.decision.batch({ items, questions, model?, concurrency? })\`: filter, triage, or rank many items (MCP results, issues, comments, or commit logs) in parallel and return only the matching items.
- \`tools.decision.evaluate({ input, files?, questions, model? })\`: run a single structured or multimodal check (pass local media paths in \`files\`).
- \`tools.decision.models()\`: inspect enabled decision models, supported input modalities, and the default model.
- Each answer in \`answers[name]\` is \`{ type: "predicate", probability }\`, \`{ type: "choice", choice, confidence, probabilities }\`, or \`{ type: "score", score, confidence, probabilities }\`.
- Default model prefers \`clef-flash\` (or \`OPENCODE_DECISION_MODEL\`). Pass short aliases such as \`"clef-flash"\`, \`"clef"\`, \`"clef-omni"\`, \`"gemini-decision-1"\`, or \`"jev"\`.`;

const QUESTION_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        type: { const: "predicate" },
        name: { type: "string" },
        instructions: { type: "string" },
        criteria: {
          type: "object",
          properties: { true: { type: "string" }, false: { type: "string" } },
          additionalProperties: false,
        },
      },
      required: ["type", "name", "instructions"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "choice" },
        name: { type: "string" },
        instructions: { type: "string" },
        choices: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: {
              value: { oneOf: [{ type: "string" }, { type: "boolean" }] },
              description: { type: "string" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
      required: ["type", "name", "instructions", "choices"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "score" },
        name: { type: "string" },
        instructions: { type: "string" },
        levels: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
      },
      required: ["type", "name", "instructions", "levels"],
      additionalProperties: false,
    },
  ],
};

export default Plugin.define({
  id: "decision",
  async setup(ctx) {
    const config = parsePluginConfig(ctx.options);

    const listDecisionModels = async (): Promise<ReadonlyArray<AvailableDecisionModel>> => {
      const response = await ctx.model.list({ types: ["decision"] });
      return response.data
        .filter((model) => model.enabled)
        .map((model) => ({
          ref: `${model.providerID}/${model.id}`,
          providerID: model.providerID,
          id: model.id,
          name: model.name,
          input: [...model.capabilities.input],
        }));
    };

    const loadMediaFiles = async (
      filePaths: ReadonlyArray<string>,
      toolContext: {
        readonly sessionID: string;
        readonly agent: string;
        readonly messageID: string;
        readonly id: string;
      },
    ): Promise<ParseResult<ReadonlyArray<FilePart>>> => {
      const parts: FilePart[] = [];
      for (const rawPath of filePaths) {
        const resolvedPath = resolve(ctx.location.directory, rawPath);
        const mediaInfo = resolveMediaType(resolvedPath);
        if (!mediaInfo.ok) return mediaInfo;

        await ctx.permission.assert({
          sessionID: toolContext.sessionID,
          agent: toolContext.agent,
          source: { type: "tool", messageID: toolContext.messageID, id: toolContext.id },
          action: "read",
          resources: [resolvedPath],
          save: [resolvedPath],
        });

        const info = await stat(resolvedPath).catch(() => undefined);
        if (info === undefined || !info.isFile()) {
          return fail(`File not found: ${resolvedPath}`);
        }
        if (info.size > MAX_FILE_BYTES) {
          return fail(`File exceeds 10 MiB limit: ${resolvedPath}`);
        }

        const bytes = await readFile(resolvedPath);
        parts.push({
          type: "file",
          data: bytes.toString("base64"),
          mime: mediaInfo.value.mime,
          kind: mediaInfo.value.kind,
          name: basename(resolvedPath),
        });
      }
      return ok(parts);
    };

    const callDecisionModel = async (
      model: AvailableDecisionModel,
      parts: ReadonlyArray<InputPart>,
      questions: ReadonlyArray<Question>,
      signal: AbortSignal,
    ): Promise<EvaluationResult> => {
      const providerResponse = await ctx.provider.get({ providerID: model.providerID }).catch(() => undefined);
      const providerInfo = providerResponse?.data;
      const settings = providerInfo?.settings;
      const baseURL =
        settings !== undefined && typeof prop(settings, "baseURL") === "string"
          ? String(prop(settings, "baseURL")).replace(/\/+$/, "")
          : undefined;
      let apiKey =
        settings !== undefined && typeof prop(settings, "apiKey") === "string"
          ? String(prop(settings, "apiKey"))
          : undefined;

      // Providers connected through `/connect` keep their secret in OpenCode's credential
      // store instead of provider settings, so resolve the active credential as a fallback.
      if (apiKey === undefined || apiKey.length === 0) {
        const integrationID = providerInfo?.integrationID;
        if (integrationID !== undefined && integrationID.length > 0) {
          const connection = await ctx.integration.connection
            .active(integrationID)
            .catch(() => undefined);
          if (connection !== undefined) {
            const credential = await ctx.integration.connection
              .resolve(connection)
              .catch(() => undefined);
            apiKey = resolveCredentialApiKey(credential);
          }
        }
      }

      // Cloudflare AI Gateway proxies (for example .../workers-ai/v1) do not end in /ai/v1,
      // which OpenCode's built-in cloudflare-workers-ai decision route requires.
      if (model.providerID === "cloudflare-workers-ai" && baseURL !== undefined && !baseURL.endsWith("/ai/v1")) {
        const bodyResult = buildCloudflareRunBody(parts, questions);
        if (!bodyResult.ok) throw new Error(bodyResult.error);

        const candidateUrls = buildCloudflareCandidateUrls(baseURL, model.id);
        const headers = buildRequestHeaders(providerInfo?.headers, apiKey);

        let lastError = "Cloudflare Workers AI decision request failed.";
        for (let i = 0; i < candidateUrls.length; i += 1) {
          const response = await fetch(candidateUrls[i], {
            method: "POST",
            headers,
            body: JSON.stringify(bodyResult.value),
            signal,
          });
          const payload: unknown = await response.json().catch(() => undefined);
          if (response.status === 404 && i + 1 < candidateUrls.length) {
            lastError = extractErrorMessage(payload, `HTTP ${response.status}`);
            continue;
          }
          if (!response.ok) {
            throw new Error(extractErrorMessage(payload, `Cloudflare decision call failed with HTTP ${response.status}.`));
          }
          const envelope = unwrapSystemOneEnvelope(payload);
          if (envelope === undefined) {
            throw new Error("Cloudflare decision response did not contain an answers map.");
          }
          const rawAnswers = prop(envelope, "answers");
          if (!isRecord(rawAnswers)) {
            throw new Error("Cloudflare decision response answers field was not an object.");
          }
          const decoded = questions.map((question) => decodeSystemOneAnswer(question, prop(rawAnswers, question.name)));
          return {
            model: model.ref,
            answers: answersArrayToRecord(decoded),
            usage: extractUsage(envelope),
          };
        }
        throw new Error(lastError);
      }

      // Google via Cloudflare AI Gateway authenticates via provider headers (for example cf-access-token)
      // with an empty apiKey, which OpenCode's built-in Google decision route rejects.
      if (
        model.providerID === "google" &&
        baseURL !== undefined &&
        (apiKey === undefined || apiKey.length === 0) &&
        providerInfo?.headers !== undefined &&
        Object.keys(providerInfo.headers).length > 0
      ) {
        const headers = buildRequestHeaders(providerInfo.headers, undefined);
        const body = buildGoogleDecisionsBody(model.id, parts, questions);
        const response = await fetch(`${baseURL}/decisions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        const payload: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          throw new Error(extractErrorMessage(payload, `Google decision call failed with HTTP ${response.status}.`));
        }
        const envelope = unwrapSystemOneEnvelope(payload);
        if (envelope === undefined) {
          throw new Error("Google decision response did not contain an answers map.");
        }
        const rawAnswers = prop(envelope, "answers");
        if (!isRecord(rawAnswers)) {
          throw new Error("Google decision response answers field was not an object.");
        }
        const decoded = questions.map((question) => decodeSystemOneAnswer(question, prop(rawAnswers, question.name)));
        return {
          model: model.ref,
          answers: answersArrayToRecord(decoded),
          usage: extractUsage(envelope),
        };
      }

      type ApiInputPart =
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "json"; readonly value: JsonValue }
        | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string };

      const apiInput: Array<ApiInputPart> = parts.map((part): ApiInputPart => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "json") return { type: "json", value: part.value };
        return {
          type: "file",
          data: part.data,
          mime: part.mime,
          ...(part.name === undefined ? {} : { name: part.name }),
        };
      });

      const response = await ctx.experimental.generate.decisions(
        {
          model: { providerID: model.providerID, id: model.id },
          input: apiInput,
          questions,
        },
        { signal },
      );

      const normalized: NormalizedAnswer[] = response.answers.map((answer) => {
        if (answer.type === "predicate") {
          return { type: "predicate", name: answer.name, probability: answer.probability };
        }
        if (answer.type === "choice") {
          return {
            type: "choice",
            name: answer.name,
            choice: answer.choice,
            confidence: answer.confidence,
            probabilities: answer.probabilities,
          };
        }
        if (answer.type === "score") {
          return {
            type: "score",
            name: answer.name,
            score: answer.score,
            confidence: answer.confidence,
            probabilities: answer.probabilities,
          };
        }
        return {
          type: "error",
          name: answer.name,
          reason: answer.reason,
          ...(answer.message === undefined ? {} : { message: answer.message }),
        };
      });

      const usage: DecisionUsage | undefined =
        response.tokens === undefined && response.cost === undefined
          ? undefined
          : {
              ...(response.tokens?.input === undefined ? {} : { inputTokens: response.tokens.input }),
              ...(response.tokens?.output === undefined ? {} : { outputTokens: response.tokens.output }),
              ...(response.cost === undefined ? {} : { cost: response.cost }),
            };

      return {
        model: model.ref,
        answers: answersArrayToRecord(normalized),
        ...(usage === undefined ? {} : { usage }),
      };
    };

    const resolveTargetModel = async (
      requested: string | undefined,
      mediaKinds: ReadonlySet<MediaKind>,
    ): Promise<ParseResult<AvailableDecisionModel>> => {
      const models = await listDecisionModels();
      if (models.length === 0) {
        return fail("No enabled decision models are available.");
      }

      if (requested !== undefined) {
        const match = findModelBySelector(models, requested);
        if (match === undefined) {
          const available = models.map((model) => model.ref).join(", ");
          return fail(`Decision model "${requested}" was not found. Available: ${available}`);
        }
        return ok(match);
      }

      const fallback = selectDefaultModel(models, mediaKinds, {
        envDefault: process.env.OPENCODE_DECISION_MODEL,
        configDefault: config.defaultModel,
      });
      if (fallback === undefined) {
        return fail("No enabled decision models are available.");
      }
      return ok(fallback);
    };

    if (config.injectInstructions) {
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: SYSTEM_INSTRUCTIONS });
      });
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "decision",
        description:
          "Fast System One decision models (Clef Flash, Clef, Clef Omni, Jev, Gemini Decision 1) for structured predicates, classification, scoring, and multimodal checks inside Code Mode.",
      });

      editor.add({
        name: "models",
        description: "List enabled decision models, supported media modalities, and the active default model.",
        options: { namespace: "decision", codemode: true, pinned: true },
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            defaultModel: { oneOf: [{ type: "string" }, { type: "null" }] },
            models: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  providerID: { type: "string" },
                  id: { type: "string" },
                  name: { type: "string" },
                  input: { type: "array", items: { type: "string" } },
                },
                required: ["ref", "providerID", "id", "name", "input"],
              },
            },
          },
          required: ["defaultModel", "models"],
        },
        async execute() {
          const models = await listDecisionModels();
          const defaultModel = selectDefaultModel(models, new Set(), {
            envDefault: process.env.OPENCODE_DECISION_MODEL,
            configDefault: config.defaultModel,
          });
          return {
            output: {
              defaultModel: defaultModel?.ref ?? null,
              models,
            },
          };
        },
      });

      editor.add({
        name: "evaluate",
        description:
          'Evaluate one input (text, JSON, or media files) against typed questions. Returns answers keyed by question name. Supports aliases like "clef-flash", "clef", "clef-omni", "gemini-decision-1", and "jev".',
        options: { namespace: "decision", codemode: true, pinned: true },
        input: {
          type: "object",
          properties: {
            input: {
              description: "String, JSON value, or array of { type: 'text' | 'json', ... } parts.",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "Optional local media file paths (images, audio, video, or PDF).",
            },
            questions: {
              type: "array",
              minItems: 1,
              items: QUESTION_JSON_SCHEMA,
            },
            model: {
              type: "string",
              description: 'Optional model ref or alias (default: "clef-flash").',
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            model: { type: "string" },
            answers: { type: "object", additionalProperties: true },
            usage: { type: "object", additionalProperties: true },
          },
          required: ["model", "answers"],
        },
        async execute(rawInput, context) {
          const parsed = parseEvaluateRequest(rawInput);
          if (!parsed.ok) throw new Error(parsed.error);

          const textAndJsonParts = parseInputParts(parsed.value.rawInput);
          if (!textAndJsonParts.ok) throw new Error(textAndJsonParts.error);

          const fileParts = await loadMediaFiles(parsed.value.files, context);
          if (!fileParts.ok) throw new Error(fileParts.error);

          const allParts: ReadonlyArray<InputPart> = [...textAndJsonParts.value, ...fileParts.value];
          const mediaKinds = new Set<MediaKind>(fileParts.value.map((part) => part.kind));

          const targetModel = await resolveTargetModel(parsed.value.model, mediaKinds);
          if (!targetModel.ok) throw new Error(targetModel.error);

          const result = await callDecisionModel(
            targetModel.value,
            allParts,
            parsed.value.questions,
            context.signal,
          );
          return { output: result };
        },
      });

      editor.add({
        name: "batch",
        description:
          "Evaluate many items against the same typed questions with bounded concurrency (default 8, max 20) to filter, triage, or rank lists inside execute.",
        options: { namespace: "decision", codemode: true, pinned: true },
        input: {
          type: "object",
          properties: {
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  input: {},
                  files: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
            questions: {
              type: "array",
              minItems: 1,
              items: QUESTION_JSON_SCHEMA,
            },
            model: { type: "string" },
            concurrency: { type: "integer", minimum: 1, maximum: MAX_CONCURRENCY },
          },
          required: ["items", "questions"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            model: { type: "string" },
            results: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            usage: {
              type: "object",
              properties: {
                inputTokens: { type: "number" },
                outputTokens: { type: "number" },
                cost: { type: "number" },
              },
              required: ["inputTokens", "outputTokens", "cost"],
            },
          },
          required: ["model", "results", "usage"],
        },
        async execute(rawInput, context) {
          const parsed = parseBatchRequest(rawInput, config.defaultConcurrency);
          if (!parsed.ok) throw new Error(parsed.error);

          const mediaKinds = new Set<MediaKind>();
          for (const item of parsed.value.items) {
            for (const filePath of item.files) {
              const info = resolveMediaType(resolve(ctx.location.directory, filePath));
              if (!info.ok) throw new Error(info.error);
              mediaKinds.add(info.value.kind);
            }
          }

          const targetModel = await resolveTargetModel(parsed.value.model, mediaKinds);
          if (!targetModel.ok) throw new Error(targetModel.error);

          const results: Array<BatchItemResult | undefined> = new Array(parsed.value.items.length);
          let nextIndex = 0;
          let inputTokens = 0;
          let outputTokens = 0;
          let cost = 0;

          const worker = async (): Promise<void> => {
            while (!context.signal.aborted) {
              const index = nextIndex;
              if (index >= parsed.value.items.length) return;
              nextIndex += 1;

              const item = parsed.value.items[index];
              try {
                const textAndJsonParts = parseInputParts(item.rawInput);
                if (!textAndJsonParts.ok) {
                  results[index] = { id: item.id, index, ok: false, error: textAndJsonParts.error };
                  continue;
                }

                const fileParts = await loadMediaFiles(item.files, context);
                if (!fileParts.ok) {
                  results[index] = { id: item.id, index, ok: false, error: fileParts.error };
                  continue;
                }

                const evaluated = await callDecisionModel(
                  targetModel.value,
                  [...textAndJsonParts.value, ...fileParts.value],
                  parsed.value.questions,
                  context.signal,
                );

                inputTokens += evaluated.usage?.inputTokens ?? 0;
                outputTokens += evaluated.usage?.outputTokens ?? 0;
                cost += evaluated.usage?.cost ?? 0;
                results[index] = { id: item.id, index, ok: true, answers: evaluated.answers };
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                results[index] = { id: item.id, index, ok: false, error: message };
              }
            }
          };

          const workerCount = Math.min(parsed.value.concurrency, parsed.value.items.length);
          await Promise.all(Array.from({ length: workerCount }, () => worker()));

          const finalized: BatchItemResult[] = results.map((entry, index) =>
            entry ?? {
              id: parsed.value.items[index].id,
              index,
              ok: false,
              error: "Cancelled before evaluation.",
            },
          );

          return {
            output: {
              model: targetModel.value.ref,
              results: finalized,
              usage: { inputTokens, outputTokens, cost },
            },
          };
        },
      });
    });
  },
});
