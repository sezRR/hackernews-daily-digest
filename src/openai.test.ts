import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Analyst } from "./Analyst.js";
import { ChatService } from "./ChatService.js";
import { Store } from "./Store.js";
import { fakeHttp, testConfig } from "./test-helpers.js";
import { ChatToolkitHandlers } from "./tools.js";

/**
 * Runs the real OpenAI provider against a captured HTTP layer. These tests pin down the
 * request we'd send, since the rules for strict schemas fail at OpenAI, not at compile time.
 */
const openAi = (responseBody: unknown) => {
  const bodies: Array<any> = [];
  const urls: Array<string> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      urls.push(url.toString());
      const body = request.body;
      bodies.push(body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : null);
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(responseBody)));
    }),
  );
  const layer = OpenAiLanguageModel.layer({
    model: "gpt-6-luna",
    config: { store: false },
  }).pipe(
    Layer.provide(OpenAiClient.layer({ apiKey: Redacted.make("sk-test") })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { bodies, urls, layer };
};

const COMPLETED_RESPONSE = (text: string, cachedTokens = 0) => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "gpt-6-luna",
  status: "completed",
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: {},
  parallel_tool_calls: true,
  temperature: 1,
  tool_choice: "auto",
  tools: [],
  top_p: 1,
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 50,
    output_tokens: 5,
    total_tokens: 55,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});

/** OpenAI's strict mode requires this of every object in a schema, or it rejects the request. */
const assertStrictObjects = (schema: any, path = "$"): void => {
  if (schema === null || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => assertStrictObjects(entry, `${path}[${index}]`));
    return;
  }
  if (schema.type === "object" && schema.properties) {
    assert.strictEqual(schema.additionalProperties, false, `${path} allows additional properties`);
    assert.deepStrictEqual(
      [...(schema.required ?? [])].sort(),
      Object.keys(schema.properties).sort(),
      `${path} must require every property`,
    );
  }
  for (const [key, value] of Object.entries(schema)) {
    assertStrictObjects(value, `${path}.${key}`);
  }
};

const THREAD = {
  fetched_at: "t",
  failed_fetches: 0,
  item: {
    id: 1,
    type: "story",
    title: "T",
    url: "u",
    hn_url: "h",
    by: null,
    score: 1,
    comment_count: 1,
    time: null,
  },
  comments: [],
};

const ANALYSIS = JSON.stringify({
  overview: "Calm",
  important: [],
  stories: [{ story_id: 1, about: "A", opinion: "B", disagreement: null }],
});

it.live("digest analysis requests a strict schema from the Responses API, without storing", () => {
  const api = openAi(COMPLETED_RESPONSE(ANALYSIS));
  return Effect.gen(function* () {
    const analyst = yield* Analyst;

    const result = yield* analyst.analyze([THREAD]);

    assert.match(api.urls[0] ?? "", /\/responses$/);
    const body = api.bodies[0];
    assert.strictEqual(body.model, "gpt-6-luna");
    assert.strictEqual(body.store, false);
    assert.strictEqual(body.text.format.type, "json_schema");
    assert.strictEqual(body.text.format.strict, true);
    assertStrictObjects(body.text.format.schema);
    assert.isUndefined(body.tools?.[0]);
    // A one-off prompt: explicit mode with no breakpoints means no cache write is billed.
    assert.deepStrictEqual(body.prompt_cache_options, { mode: "explicit" });
    assert.strictEqual(body.max_output_tokens, 8_000);
    assert.notInclude(JSON.stringify(body.input), "prompt_cache_breakpoint");

    assert.strictEqual(result.analysis.stories[0]?.disagreement, null);
    assert.strictEqual(result.inputTokens, 50);
    assert.strictEqual(result.outputTokens, 5);
  }).pipe(Effect.provide(Analyst.layer.pipe(Layer.provide([api.layer, testConfig()]))));
});

it.live("digest analysis sends instructions in the developer role for this model", () => {
  const api = openAi(COMPLETED_RESPONSE(ANALYSIS));
  return Effect.gen(function* () {
    const analyst = yield* Analyst;

    yield* analyst.analyze([THREAD]);

    const roles = api.bodies[0].input.map((entry: { role: string }) => entry.role);
    assert.deepStrictEqual(roles, ["developer", "user"]);
  }).pipe(Effect.provide(Analyst.layer.pipe(Layer.provide([api.layer, testConfig()]))));
});

it.live("chat tools are strict function schemas that OpenAI will accept", () => {
  const api = openAi(COMPLETED_RESPONSE("hi"));
  const net = fakeHttp({ items: {} });
  const layer = ChatService.layer.pipe(
    Layer.provideMerge(ChatToolkitHandlers),
    Layer.provideMerge(net.layer),
    Layer.provideMerge(Store.layerAt(":memory:")),
    Layer.provideMerge(api.layer),
    Layer.provideMerge(testConfig()),
  );
  return Effect.gen(function* () {
    const chat = yield* ChatService;

    yield* chat.answer("2026-11-05", "Hi");

    // Replies keep OpenAI's default caching: their tool rounds re-send the same prompt.
    assert.isUndefined(api.bodies[0].prompt_cache_options);
    const tools = api.bodies[0].tools as ReadonlyArray<any>;
    assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), [
      "get_comments",
      "get_front_page",
    ]);
    for (const tool of tools) {
      assert.strictEqual(tool.type, "function");
      assert.strictEqual(tool.strict, true);
      assertStrictObjects(tool.parameters);
    }
  }).pipe(Effect.provide(layer));
});

it.live("reads cached input tokens from OpenAI's usage report into the reply budget", () => {
  const api = openAi(COMPLETED_RESPONSE("hi", 40));
  const net = fakeHttp({ items: {} });
  const layer = ChatService.layer.pipe(
    Layer.provideMerge(ChatToolkitHandlers),
    Layer.provideMerge(net.layer),
    Layer.provideMerge(Store.layerAt(":memory:")),
    Layer.provideMerge(api.layer),
    Layer.provideMerge(testConfig()),
  );
  return Effect.gen(function* () {
    const chat = yield* ChatService;
    const store = yield* Store;

    yield* chat.answer("2026-11-05", "Hi");

    const today = new Date().toISOString().slice(0, 10);
    assert.deepStrictEqual(yield* store.usage(today, "chat"), {
      inputTokens: 50,
      cachedInputTokens: 40,
      outputTokens: 5,
    });
    // 10 uncached + 5 output + 40 cached / 10
    assert.strictEqual(yield* store.usageTotal(today, "chat"), 19);
  }).pipe(Effect.provide(layer));
});
