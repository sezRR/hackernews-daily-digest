import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChatService } from "./ChatService.js";
import type { Digest } from "./Digest.js";
import { Store } from "./Store.js";
import { fakeHttp, fakeModel, finishPart, type TextStep, testConfig } from "./test-helpers.js";
import { ChatToolkitHandlers } from "./tools.js";

const DATE = "2026-11-05";
const TODAY = () => new Date().toISOString().slice(0, 10);

const text = (value: string) => ({ type: "text" as const, text: value });
const toolCall = (name: string, params: object) => ({
  type: "tool-call" as const,
  id: `call-${name}`,
  name,
  params,
  providerExecuted: false,
});

const HN = {
  items: {
    1: { id: 1, type: "story", title: "Story one", kids: [10] },
    10: { id: 10, by: "someone", text: "An interesting comment" },
  },
};

const DIGEST: Digest = {
  date: DATE,
  generated_at: "2026-11-05T07:30:00.000Z",
  model: "gpt-6-luna",
  overview: "A calm day.",
  important: [{ story_id: 1, why: "Patch now." }],
  ranking_source: "front_page_html",
  failed_fetches: 0,
  stories: [
    {
      rank: 1,
      id: 1,
      title: "Story one",
      url: "https://example.com/1",
      hn_url: "https://news.ycombinator.com/item?id=1",
      score: 100,
      comment_count: 50,
      about: "About one.",
      opinion: "People like it.",
      disagreement: null,
    },
  ],
};

const harness = (steps: ReadonlyArray<TextStep>, limit = 100_000) => {
  const net = fakeHttp(HN);
  const model = fakeModel({ steps });
  const layer = ChatService.layer.pipe(
    Layer.provideMerge(ChatToolkitHandlers),
    Layer.provideMerge(net.layer),
    Layer.provideMerge(Store.layerAt(":memory:")),
    Layer.provideMerge(model.layer),
    Layer.provideMerge(testConfig({ chatDailyTokenLimit: limit })),
  );
  return { net, model, layer };
};

const withDigest = Effect.gen(function* () {
  const store = yield* Store;
  yield* store.saveDigest(DATE, DIGEST);
});

const ask = (question: string) =>
  Effect.gen(function* () {
    const chat = yield* ChatService;
    return yield* chat.answer(DATE, question);
  });

describe("answers", () => {
  it.live("answers and stores both sides of the conversation", () => {
    const h = harness([[text("Hello there"), finishPart()]]);
    return Effect.gen(function* () {
      const store = yield* Store;

      const answer = yield* ask("Hi?");

      assert.strictEqual(answer, "Hello there");
      assert.deepStrictEqual(yield* store.threadMessages(DATE, 10), [
        { role: "user", content: "Hi?" },
        { role: "assistant", content: "Hello there" },
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("gives the model the digest it's about, and earlier messages from the same day", () => {
    const h = harness([
      [text("First"), finishPart()],
      [text("Second"), finishPart()],
    ]);
    return Effect.gen(function* () {
      yield* withDigest;

      yield* ask("One?");
      yield* ask("Two?");

      const prompt = JSON.stringify(h.model.requests[1]?.prompt);
      assert.include(prompt, "People like it.");
      assert.include(prompt, "Patch now.");
      assert.include(prompt, "One?");
      assert.include(prompt, "First");
      assert.notInclude(prompt, "example.com/1");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("keeps conversations about different days apart", () => {
    const h = harness([
      [text("First"), finishPart()],
      [text("Second"), finishPart()],
    ]);
    return Effect.gen(function* () {
      const chat = yield* ChatService;

      yield* chat.answer("2026-11-04", "Yesterday?");
      yield* chat.answer(DATE, "Today?");

      assert.notInclude(JSON.stringify(h.model.requests[1]?.prompt), "Yesterday?");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("tells the model that Hacker News content is untrusted", () => {
    const h = harness([[text("ok"), finishPart()]]);
    return Effect.gen(function* () {
      yield* ask("Hi?");

      assert.include(JSON.stringify(h.model.requests[0]?.prompt), "untrusted");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("removes links other than Hacker News threads from the answer", () => {
    const h = harness([
      [
        text("See https://news.ycombinator.com/item?id=10 and https://evil.example/?d=secret"),
        finishPart(),
      ],
    ]);
    return Effect.gen(function* () {
      const store = yield* Store;

      const answer = yield* ask("Links?");

      assert.include(answer, "https://news.ycombinator.com/item?id=10");
      assert.notInclude(answer, "evil.example");
      const stored = yield* store.threadMessages(DATE, 10);
      assert.notInclude(stored[1]?.content ?? "", "evil.example");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("tool loop", () => {
  it.live("runs a tool, gives the model its result, then answers", () => {
    const h = harness([
      [toolCall("get_comments", { item_id: 1 }), finishPart()],
      [text("They liked it"), finishPart()],
    ]);
    return Effect.gen(function* () {
      const answer = yield* ask("What do people think?");

      assert.strictEqual(answer, "They liked it");
      assert.strictEqual(h.model.requests.length, 2);
      assert.include(JSON.stringify(h.model.requests[1]?.prompt), "An interesting comment");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a failing tool is reported to the model instead of ending the answer", () => {
    const h = harness([
      [toolCall("get_comments", { item_id: 999 }), finishPart()],
      [text("I couldn't find that"), finishPart()],
    ]);
    return Effect.gen(function* () {
      const answer = yield* ask("Read 999");

      assert.strictEqual(answer, "I couldn't find that");
      assert.include(JSON.stringify(h.model.requests[1]?.prompt), "ItemNotFound");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("forces an answer on the last round, so a question can't loop forever", () => {
    const calls = Array.from({ length: 8 }, (): TextStep => [
      toolCall("get_comments", { item_id: 1 }),
      finishPart(),
    ]);
    const h = harness(calls);
    return Effect.gen(function* () {
      yield* ask("Keep going").pipe(Effect.ignore);

      assert.strictEqual(h.model.requests.length, 5);
      assert.strictEqual(h.model.requests[3]?.toolChoice, "auto");
      assert.strictEqual(h.model.requests[4]?.toolChoice, "none");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("budget", () => {
  it.live("records cached input separately and counts it as a tenth against the budget", () => {
    const h = harness([
      [toolCall("get_comments", { item_id: 1 }), finishPart(1000, 10)],
      [text("done"), finishPart(1200, 20, 1000)],
    ]);
    return Effect.gen(function* () {
      const store = yield* Store;

      yield* ask("Hi?");

      assert.deepStrictEqual(yield* store.usage(TODAY(), "chat"), {
        inputTokens: 2200,
        cachedInputTokens: 1000,
        outputTokens: 30,
      });
      // 1200 uncached input + 30 output + 1000 cached / 10
      assert.strictEqual(yield* store.usageTotal(TODAY(), "chat"), 1330);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("records tokens from every round", () => {
    const h = harness([
      [toolCall("get_comments", { item_id: 1 }), finishPart(100, 10)],
      [text("done"), finishPart(200, 20)],
    ]);
    return Effect.gen(function* () {
      const store = yield* Store;

      yield* ask("Hi?");

      assert.strictEqual(yield* store.usageTotal(TODAY(), "chat"), 330);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("refuses a new question once today's budget is used, before calling the model", () => {
    const h = harness([[text("never"), finishPart()]], 1000);
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.addUsage(TODAY(), "chat", {
        inputTokens: 900,
        cachedInputTokens: 0,
        outputTokens: 100,
      });

      const error = yield* ask("Hi?").pipe(Effect.flip);

      assert.strictEqual(error._tag, "BudgetExceeded");
      assert.strictEqual(h.model.requests.length, 0);
      assert.deepStrictEqual(yield* store.threadMessages(DATE, 10), []);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("stops the tool loop when the budget runs out mid-question", () => {
    const h = harness(
      [
        [toolCall("get_comments", { item_id: 1 }), finishPart(600, 500)],
        [text("never"), finishPart()],
      ],
      1000,
    );
    return Effect.gen(function* () {
      const error = yield* ask("Hi?").pipe(Effect.flip);

      assert.strictEqual(error._tag, "BudgetExceeded");
      assert.strictEqual(h.model.requests.length, 1);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("failures", () => {
  it.live("turns a model failure into AnswerFailed and stores nothing", () => {
    const h = harness([new Error("upstream exploded")]);
    return Effect.gen(function* () {
      const store = yield* Store;

      const error = yield* ask("Hi?").pipe(Effect.flip);

      assert.strictEqual(error._tag, "AnswerFailed");
      assert.deepStrictEqual(yield* store.threadMessages(DATE, 10), []);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("treats an empty answer as a failure", () => {
    const h = harness([[text("  "), finishPart()]]);
    return Effect.gen(function* () {
      const error = yield* ask("Hi?").pipe(Effect.flip);

      assert.strictEqual(error._tag, "AnswerFailed");
    }).pipe(Effect.provide(h.layer));
  });
});
