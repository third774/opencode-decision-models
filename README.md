# opencode-decision-models

An OpenCode V2 server plugin that exposes System One decision models (Cloudflare Clef, Clef Flash, Clef Omni, TypeSafe Jev, and Google Gemini Decision 1) as Code Mode tools inside `execute`.

Decision models evaluate an input against typed `predicate`, `choice`, and `score` questions in a single forward pass with `0` generated output tokens. Inside OpenCode Code Mode (`execute`), an agent can fetch dozens or hundreds of items from MCP servers, classify or filter them in parallel, and return only the matching items to its context window.

## Setup for Coding Agents

If a user gives you this repository URL (`https://github.com/third774/opencode-decision-models`) and asks you to set it up in OpenCode, follow these steps:

### 1. Install the plugin

Prefer adding the plugin to the user's OpenCode configuration (`~/.config/opencode/opencode.jsonc` for global setup, or `opencode.jsonc` in the current project):

```sh
opencode plugin add github:third774/opencode-decision-models
```

Or add it manually to the `plugins` array in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:third774/opencode-decision-models"
  ]
}
```

To customize options, use the object form instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:third774/opencode-decision-models",
      "options": {
        "defaultModel": "clef-flash",
        "injectInstructions": true,
        "defaultConcurrency": 8
      }
    }
  ]
}
```

### 2. Verify that at least one decision model is available

Check enabled decision models in the running OpenCode server:

```sh
opencode api get '/api/model?types=decision'
```

If that list already includes one or more enabled models (for example `cloudflare-workers-ai/@cf/cloudflare/clef-flash`, `google/gemini-decision-1`, or `opencode/jev-1.13`), no extra provider configuration is required.

If the list is empty, ask the user to connect a provider that serves decision models (for example, Cloudflare Workers AI / Cloudflare AI Gateway, OpenCode Console for `jev-1.13`, or Google AI) via `/connect`.

### 3. Reload and verify

Reload OpenCode configuration (for example with `/reload` in the TUI or `opencode api post /api/location/reload`) and confirm the plugin is loaded:

```sh
opencode plugin list
```

Verify that `decision` appears in the output. Then run a smoke test inside `execute`:

```js
const models = await tools.decision.models();
const check = await tools.decision.evaluate({
  input: "Checkout returns HTTP 500 across all regions.",
  questions: [
    {
      type: "predicate",
      name: "is_outage",
      instructions: "Does this describe a production outage?",
    },
  ],
});
return { models, check };
```

No `AGENTS.md` edit is required: by default, the plugin injects concise usage instructions automatically through OpenCode's session `context` hook.

## Tools

All tools are registered under the `decision` namespace with `codemode: true` and `pinned: true` so they stay inside `execute` and never expand the direct tool list.

### `tools.decision.models()`

Returns all enabled decision models, their supported input modalities, and the active default model.

```js
const { defaultModel, models } = await tools.decision.models();
```

### `tools.decision.evaluate({ input, files?, questions, model? })`

Evaluates one input (a string, a JSON value, or an array of `{ type: "text" | "json", ... }` parts) plus optional local media `files` (images, audio, video, or PDFs) against one or more typed questions.

```js
const res = await tools.decision.evaluate({
  input: "Remove auth check on /api/admin/export to fix timeout",
  questions: [
    {
      type: "predicate",
      name: "security_risk",
      instructions: "Does this introduce a security risk?",
    },
    {
      type: "choice",
      name: "category",
      instructions: "Classify the risk.",
      choices: [
        { value: "none", description: "No security risk" },
        { value: "auth", description: "Auth or authorization bypass" },
        { value: "secret_leak", description: "Exposes secrets or tokens" },
      ],
    },
    {
      type: "score",
      name: "severity",
      instructions: "Rate review priority.",
      levels: [
        { label: "Routine" },
        { label: "Caution" },
        { label: "Blocker" },
      ],
    },
  ],
});

// Answers are keyed by question name:
res.answers.security_risk.probability; // 0..1
res.answers.category.choice;           // "auth"
res.answers.severity.score;            // 0..(levels.length - 1)
```

### `tools.decision.batch({ items, questions, model?, concurrency? })`

Evaluates an array of items against the same questions with bounded concurrency (default `8`, maximum `20`) and cooperative cancellation.

```js
const batch = await tools.decision.batch({
  items: issues.map((issue) => ({ id: issue.id, input: issue })),
  questions: [
    {
      type: "predicate",
      name: "is_regression",
      instructions: "Does this issue describe a regression after a recent deploy?",
    },
  ],
});

return batch.results
  .filter((r) => r.ok && r.answers.is_regression.probability >= 0.7)
  .map((r) => ({ id: r.id, prob: r.answers.is_regression.probability }));
```

## Model Selection

Pass `model` as a full `providerID/modelID` reference or as a short alias (`"clef-flash"`, `"clef"`, `"clef-omni"`, `"gemini-decision-1"`, `"gemini"`, or `"jev"`).

When `model` is omitted, the plugin resolves the default in this order:

1. Media requirements: PDF inputs prefer `google/gemini-decision-1`; audio or video inputs prefer `cloudflare-workers-ai/@cf/cloudflare/clef-omni` then `google/gemini-decision-1`.
2. `OPENCODE_DECISION_MODEL` environment variable (useful for per-machine overrides).
3. `options.defaultModel` in `opencode.json(c)`.
4. Built-in preference order: `clef-flash` -> `clef` -> `clef-omni` -> `jev-1.13` -> `jev-1.13-free` -> `gemini-decision-1` -> first enabled decision model.

## Configuration Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultModel` | `string` | Auto-selected | Default model reference or alias when `model` and `OPENCODE_DECISION_MODEL` are not set. |
| `injectInstructions` | `boolean` | `true` | Injects a short instruction block into session context so models know when to use `tools.decision.*`. |
| `defaultConcurrency` | `number` | `8` | Default maximum parallel requests for `tools.decision.batch` (`1` to `20`). |

## Provider Routing

- Uses OpenCode's existing provider configuration and credentials—no separate API keys are required.
- Supports Cloudflare AI Gateway proxies (including Workers AI `/workers-ai/run/<model>` and header-authenticated Google Decisions endpoints) as well as standard OpenCode decision providers through `ctx.experimental.generate.decisions`.
- When a provider has no `settings.apiKey`, the plugin resolves the active credential for its integration, so accounts connected with `/connect` (for example Cloudflare Workers AI) also work through an AI Gateway proxy.
- Local `files` passed to `evaluate` or `batch` are checked with OpenCode's `read` permission (`ctx.permission.assert`), restricted to media extensions (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.pdf`, `.mp3`, `.wav`, `.m4a`, `.ogg`, `.mp4`, `.webm`, `.mov`), and capped at 10 MiB per file.

## Development

```sh
bun install
bun run typecheck
bun test
```

## License

MIT
