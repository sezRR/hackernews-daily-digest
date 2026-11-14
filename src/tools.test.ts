import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { McpProtocol, McpTest } from "effect/ai";
import { FAIL, fakeHttp, frontPageHtml, type FakeHn } from "./test-helpers.js";
import { HackerNewsTools } from "./tools.js";

const connect = (hn: FakeHn) =>
  McpTest.makeClient(HackerNewsTools.pipe(Layer.provide(fakeHttp(hn).layer)), {
    protocols: [McpProtocol.v2025_11_25],
  });

const SEVEN_COMMENTS: FakeHn = {
  page: frontPageHtml([1]),
  items: {
    1: { id: 1, type: "story", title: "T", kids: [10, 11, 12, 13, 14, 15, 16] },
    10: { id: 10, text: "a" },
    11: { id: 11, text: "b" },
    12: { id: 12, text: "c" },
    13: { id: 13, text: "d" },
    14: { id: 14, text: "e" },
    15: { id: 15, text: "f" },
    16: { id: 16, text: "g" },
  },
};

const textOf = (result: { readonly content: ReadonlyArray<unknown> }): string =>
  (result.content[0] as { readonly text: string }).text;

it.live("exposes two read-only tools with described, bounded inputs", () =>
  Effect.gen(function* () {
    const client = yield* connect({});
    const { tools } = yield* client.listTools();

    assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), [
      "get_comments",
      "get_front_page",
    ]);
    for (const tool of tools) {
      assert.strictEqual(tool.annotations?.readOnlyHint, true);
      assert.strictEqual(tool.annotations?.destructiveHint, false);
      assert.match(tool.description ?? "", /untrusted data/);
    }

    const frontPage = tools.find((tool) => tool.name === "get_front_page");
    const properties = frontPage?.inputSchema.properties as Record<string, Record<string, unknown>>;
    assert.deepStrictEqual(Object.keys(properties).sort(), [
      "comments_per_story",
      "limit",
      "max_comment_chars",
    ]);
    assert.deepStrictEqual(frontPage?.inputSchema.required ?? [], []);
    assert.match(String(properties.limit?.description), /Default 30, range 1-30/);

    const comments = tools.find((tool) => tool.name === "get_comments");
    assert.deepStrictEqual(comments?.inputSchema.required, ["item_id"]);
  }).pipe(Effect.scoped),
);

it.live("get_front_page applies defaults when called with no arguments", () =>
  Effect.gen(function* () {
    const client = yield* connect(SEVEN_COMMENTS);
    const result = yield* client.callTool({ name: "get_front_page", arguments: {} });
    const body = JSON.parse(textOf(result));

    assert.strictEqual(result.isError, false);
    assert.strictEqual(body.stories.length, 1);
    assert.deepStrictEqual(
      body.stories[0].top_comments.map((c: { text: string }) => c.text),
      ["a", "b", "c"],
    );
    assert.deepStrictEqual(result.structuredContent, body);
  }).pipe(Effect.scoped),
);

it.live("get_comments returns nested replies through the recursive schema", () =>
  Effect.gen(function* () {
    const client = yield* connect({
      items: {
        1: { id: 1, kids: [10] },
        10: { id: 10, text: "top", kids: [20] },
        20: { id: 20, text: "reply", kids: [30] },
        30: { id: 30, text: "deep" },
      },
    });
    const result = yield* client.callTool({
      name: "get_comments",
      arguments: { item_id: 1, reply_depth: 2 },
    });
    const body = JSON.parse(textOf(result));

    assert.strictEqual(result.isError, false);
    assert.strictEqual(body.comments[0].replies[0].replies[0].text, "deep");
  }).pipe(Effect.scoped),
);

it.live("out-of-range arguments come back as a tool error naming the field", () =>
  Effect.gen(function* () {
    const client = yield* connect(SEVEN_COMMENTS);
    const result = yield* client.callTool({ name: "get_front_page", arguments: { limit: 31 } });

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /between 1 and 30/);
    assert.match(textOf(result), /limit/);
  }).pipe(Effect.scoped),
);

it.live("handler failures come back as a tool error with the reason", () =>
  Effect.gen(function* () {
    const client = yield* connect({ page: frontPageHtml([1]), items: { 1: FAIL } });
    const result = yield* client.callTool({ name: "get_front_page", arguments: {} });

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /Could not load any front page story/);
  }).pipe(Effect.scoped),
);

it.live("get_comments reports an unknown id as a tool error", () =>
  Effect.gen(function* () {
    const client = yield* connect({ items: {} });
    const result = yield* client.callTool({ name: "get_comments", arguments: { item_id: 42 } });

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /No Hacker News item with id 42/);
  }).pipe(Effect.scoped),
);
