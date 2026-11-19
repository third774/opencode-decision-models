import { describe, expect, it } from "bun:test";
import {
  buildCloudflareCandidateUrls,
  buildCloudflareRunBody,
  buildGoogleDecisionsBody,
  buildRequestHeaders,
  decodeSystemOneAnswer,
  findModelBySelector,
  parseBatchRequest,
  parseEvaluateRequest,
  parseInputParts,
  parsePluginConfig,
  resolveCredentialApiKey,
  resolveMediaType,
  selectDefaultModel,
  unwrapSystemOneEnvelope,
  type AvailableDecisionModel,
  type Question,
} from "../src/protocol.ts";

const SAMPLE_MODELS: ReadonlyArray<AvailableDecisionModel> = [
  {
    ref: "google/gemini-decision-1",
    providerID: "google",
    id: "gemini-decision-1",
    name: "Gemini Decision 1",
    input: ["text", "image", "audio", "video", "pdf"],
  },
  {
    ref: "cloudflare-workers-ai/@cf/cloudflare/clef-omni",
    providerID: "cloudflare-workers-ai",
    id: "@cf/cloudflare/clef-omni",
    name: "Clef Omni",
    input: ["text", "image", "audio", "video"],
  },
  {
    ref: "cloudflare-workers-ai/@cf/cloudflare/clef",
    providerID: "cloudflare-workers-ai",
    id: "@cf/cloudflare/clef",
    name: "Clef",
    input: ["text", "image"],
  },
  {
    ref: "cloudflare-workers-ai/@cf/cloudflare/clef-flash",
    providerID: "cloudflare-workers-ai",
    id: "@cf/cloudflare/clef-flash",
    name: "Clef Flash",
    input: ["text", "image"],
  },
];

describe("parsePluginConfig", () => {
  it("uses defaults for empty or invalid input", () => {
    expect(parsePluginConfig(undefined)).toEqual({
      injectInstructions: true,
      defaultConcurrency: 8,
    });
  });

  it("parses valid options and clamps concurrency", () => {
    expect(
      parsePluginConfig({
        defaultModel: "clef",
        injectInstructions: false,
        defaultConcurrency: 99,
      }),
    ).toEqual({
      defaultModel: "clef",
      injectInstructions: false,
      defaultConcurrency: 20,
    });
  });
});

describe("request parsing", () => {
  it("accepts predicate, choice, and score questions", () => {
    const parsed = parseEvaluateRequest({
      input: "API returned 500",
      questions: [
        { type: "predicate", name: "is_bug", instructions: "Is this a bug?" },
        {
          type: "choice",
          name: "area",
          instructions: "Which area?",
          choices: [{ value: "api" }, { value: "ui" }],
        },
        {
          type: "score",
          name: "severity",
          instructions: "How severe?",
          levels: [{ label: "Low" }, { label: "High" }],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects duplicate question names", () => {
    const parsed = parseEvaluateRequest({
      input: "text",
      questions: [
        { type: "predicate", name: "q1", instructions: "First?" },
        { type: "predicate", name: "q1", instructions: "Second?" },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it("assigns index IDs in batch requests when omitted", () => {
    const parsed = parseBatchRequest({
      items: [{ input: "first" }, { id: "custom", input: "second" }],
      questions: [{ type: "predicate", name: "ok", instructions: "Is it ok?" }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.items.map((item) => item.id)).toEqual(["0", "custom"]);
    }
  });
});

describe("input and media helpers", () => {
  it("wraps strings as text parts and objects as json parts", () => {
    const textResult = parseInputParts("hello");
    expect(textResult).toEqual({ ok: true, value: [{ type: "text", text: "hello" }] });

    const jsonResult = parseInputParts({ ticket: 42 });
    expect(jsonResult).toEqual({ ok: true, value: [{ type: "json", value: { ticket: 42 } }] });
  });

  it("recognizes supported media extensions and rejects unknown ones", () => {
    expect(resolveMediaType("/tmp/shot.png")).toEqual({
      ok: true,
      value: { mime: "image/png", kind: "image" },
    });
    expect(resolveMediaType("/tmp/doc.pdf")).toEqual({
      ok: true,
      value: { mime: "application/pdf", kind: "pdf" },
    });
    expect(resolveMediaType("/tmp/.env").ok).toBe(false);
  });
});

describe("model selection", () => {
  it("resolves short aliases and full refs", () => {
    expect(findModelBySelector(SAMPLE_MODELS, "clef-flash")?.ref).toBe(
      "cloudflare-workers-ai/@cf/cloudflare/clef-flash",
    );
    expect(findModelBySelector(SAMPLE_MODELS, "clef")?.ref).toBe(
      "cloudflare-workers-ai/@cf/cloudflare/clef",
    );
    expect(findModelBySelector(SAMPLE_MODELS, "gemini")?.ref).toBe("google/gemini-decision-1");
  });

  it("prefers clef-flash by default, clef-omni for audio/video, and gemini for pdf", () => {
    expect(selectDefaultModel(SAMPLE_MODELS, new Set())?.ref).toBe(
      "cloudflare-workers-ai/@cf/cloudflare/clef-flash",
    );
    expect(selectDefaultModel(SAMPLE_MODELS, new Set(["video"]))?.ref).toBe(
      "cloudflare-workers-ai/@cf/cloudflare/clef-omni",
    );
    expect(selectDefaultModel(SAMPLE_MODELS, new Set(["pdf"]))?.ref).toBe("google/gemini-decision-1");
  });

  it("gives envDefault precedence over configDefault", () => {
    expect(
      selectDefaultModel(SAMPLE_MODELS, new Set(), {
        envDefault: "clef",
        configDefault: "gemini-decision-1",
      })?.ref,
    ).toBe("cloudflare-workers-ai/@cf/cloudflare/clef");
  });
});

describe("protocol encoding and decoding", () => {
  const questions: ReadonlyArray<Question> = [
    {
      type: "predicate",
      name: "urgent",
      instructions: "Is this urgent?",
      criteria: { true: "Production outage", false: "Routine" },
    },
    {
      type: "choice",
      name: "team",
      instructions: "Route ticket",
      choices: [
        { value: "billing", description: "Payments" },
        { value: "infra", description: "Servers" },
      ],
    },
    {
      type: "score",
      name: "impact",
      instructions: "Rate impact",
      levels: [{ label: "Low" }, { label: "High" }],
    },
  ];

  it("encodes Cloudflare Run body with root-level images", () => {
    const encoded = buildCloudflareRunBody(
      [
        { type: "text", text: "Check screenshot" },
        { type: "file", data: "QUJD", mime: "image/png", kind: "image" },
      ],
      questions,
    );
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(encoded.value.state).toBe("Check screenshot");
      expect(encoded.value.images).toEqual(["data:image/png;base64,QUJD"]);
    }
  });

  it("rejects PDFs for Cloudflare Clef models", () => {
    const encoded = buildCloudflareRunBody(
      [{ type: "file", data: "QUJD", mime: "application/pdf", kind: "pdf" }],
      questions,
    );
    expect(encoded.ok).toBe(false);
  });

  it("encodes Google Decisions body with true_description/false_description and PDF documents", () => {
    const body = buildGoogleDecisionsBody(
      "gemini-decision-1",
      [
        { type: "text", text: "Inspect PDF" },
        { type: "file", data: "QUJD", mime: "application/pdf", kind: "pdf" },
      ],
      questions,
    );
    expect(body.model).toBe("gemini-decision-1");
    expect(body.input).toEqual([
      { type: "text", text: "Inspect PDF" },
      { type: "document", mime_type: "application/pdf", data: "QUJD" },
    ]);
  });

  it("decodes System One answers and unwraps nested envelopes", () => {
    const raw = {
      result: {
        answers: {
          urgent: { type: "noul", noul: 0.91 },
          team: {
            type: "choice",
            choice: "infra",
            confidence: 0.85,
            probabilities: { infra: 0.92, billing: 0.08 },
          },
          impact: {
            type: "score",
            score: 0.88,
            confidence: 0.72,
            probabilities: { "0": 0.12, "1": 0.88 },
          },
        },
      },
    };
    const envelope = unwrapSystemOneEnvelope(raw);
    expect(envelope).toBeDefined();

    const predicate = decodeSystemOneAnswer(questions[0], raw.result.answers.urgent);
    expect(predicate).toEqual({ type: "predicate", name: "urgent", probability: 0.91 });

    const choice = decodeSystemOneAnswer(questions[1], raw.result.answers.team);
    expect(choice).toEqual({
      type: "choice",
      name: "team",
      choice: "infra",
      confidence: 0.85,
      probabilities: [
        { value: "billing", probability: 0.08 },
        { value: "infra", probability: 0.92 },
      ],
    });

    const score = decodeSystemOneAnswer(questions[2], raw.result.answers.impact);
    expect(score).toEqual({
      type: "score",
      name: "impact",
      score: 0.88,
      confidence: 0.72,
      probabilities: [
        { value: 0, label: "Low", probability: 0.12 },
        { value: 1, label: "High", probability: 0.88 },
      ],
    });
  });

  it("preserves existing authorization headers when building request headers", () => {
    expect(buildRequestHeaders({ Authorization: "Bearer custom" }, "ignored")).toEqual({
      "content-type": "application/json",
      Authorization: "Bearer custom",
    });
    expect(buildRequestHeaders({ "cf-access-token": "tok" }, "secret")).toEqual({
      "content-type": "application/json",
      "cf-access-token": "tok",
      authorization: "Bearer secret",
    });
  });

  it("resolves stored key and oauth credentials into API keys", () => {
    expect(resolveCredentialApiKey({ type: "key", key: "cf-token" })).toBe("cf-token");
    expect(
      resolveCredentialApiKey({ type: "oauth", access: "access-token", refresh: "r", expires: 1 }),
    ).toBe("access-token");
    expect(resolveCredentialApiKey({ type: "key", key: "" })).toBeUndefined();
    expect(resolveCredentialApiKey({ type: "external" })).toBeUndefined();
    expect(resolveCredentialApiKey(undefined)).toBeUndefined();
  });

  it("prefers the AI Gateway run path and falls back to the model path", () => {
    expect(
      buildCloudflareCandidateUrls(
        "https://gateway.ai.cloudflare.com/v1/account/gateway/workers-ai/v1",
        "@cf/cloudflare/clef-flash",
      ),
    ).toEqual([
      "https://gateway.ai.cloudflare.com/v1/account/gateway/workers-ai/run/@cf/cloudflare/clef-flash",
      "https://gateway.ai.cloudflare.com/v1/account/gateway/workers-ai/@cf/cloudflare/clef-flash",
    ]);
    expect(
      buildCloudflareCandidateUrls("https://api.cloudflare.com/client/v4/accounts/a/ai/v1/", "@cf/cloudflare/clef"),
    ).toEqual(["https://api.cloudflare.com/client/v4/accounts/a/ai/run/@cf/cloudflare/clef"]);
  });
});
