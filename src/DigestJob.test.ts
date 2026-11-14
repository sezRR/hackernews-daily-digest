import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Analyst, stripUrls } from "./Analyst.js";
import type { Story } from "./domain.js";
import {
  buildDigestStories,
  buildImportant,
  DigestJob,
  isDue,
  localMoment,
  selectStories,
} from "./DigestJob.js";
import { Store } from "./Store.js";
import {
  fakeHttp,
  fakeMailer,
  fakeModel,
  frontPageHtml,
  testConfig,
} from "./test-helpers.js";

const NOV_5_09_00 = Date.UTC(2026, 10, 5, 9, 0);
const NOV_5_07_00 = Date.UTC(2026, 10, 5, 7, 0);
const NOV_6_09_00 = Date.UTC(2026, 10, 6, 9, 0);
const THIRTY_MINUTES = 30 * 60 * 1000;
const RETRY_GAP = 25 * 60 * 1000;

describe("schedule", () => {
  it("uses the configured time zone for both date and time", () => {
    const moment = localMoment(Date.UTC(2026, 10, 5, 22, 30), "Asia/Tokyo");

    assert.deepStrictEqual(moment, { date: "2026-11-06", hour: 7, minute: 30 });
  });

  it("reports midnight as hour 0", () => {
    assert.strictEqual(localMoment(Date.UTC(2026, 10, 5, 0, 5), "UTC").hour, 0);
  });

  it("is due from the configured minute onward", () => {
    const time = { hour: 8, minute: 30 };

    assert.isFalse(isDue({ date: "d", hour: 8, minute: 29 }, time));
    assert.isTrue(isDue({ date: "d", hour: 8, minute: 30 }, time));
    assert.isTrue(isDue({ date: "d", hour: 23, minute: 0 }, time));
    assert.isFalse(isDue({ date: "d", hour: 7, minute: 59 }, time));
  });
});

const frontPageStory = (id: number, overrides: Partial<Story> = {}): Story => ({
  rank: id,
  id,
  type: "story",
  title: `Story ${id}`,
  url: `https://example.com/${id}`,
  hn_url: `https://news.ycombinator.com/item?id=${id}`,
  by: "user",
  score: 100,
  comment_count: 50,
  time: new Date(NOV_5_09_00 - 6 * 3_600_000).toISOString(),
  top_comments: [],
  ...overrides,
});

describe("selectStories", () => {
  const rules = { maxStories: 2, minComments: 10, minAgeHours: 3 };
  const ids = (stories: ReadonlyArray<Story>) => stories.map((story) => story.id);

  it("skips stories already sent", () => {
    const stories = [frontPageStory(1), frontPageStory(2)];

    assert.deepStrictEqual(ids(selectStories(stories, new Set([1]), NOV_5_09_00, rules)), [2]);
  });

  it("skips job posts", () => {
    const stories = [frontPageStory(1, { type: "job" })];

    assert.deepStrictEqual(selectStories(stories, new Set(), NOV_5_09_00, rules), []);
  });

  it("skips threads with too few comments or no comment count", () => {
    const stories = [
      frontPageStory(1, { comment_count: 9 }),
      frontPageStory(2, { comment_count: null }),
      frontPageStory(3, { comment_count: 10 }),
    ];

    assert.deepStrictEqual(ids(selectStories(stories, new Set(), NOV_5_09_00, rules)), [3]);
  });

  it("skips threads too young to have settled opinions, and stories with no time", () => {
    const stories = [
      frontPageStory(1, { time: new Date(NOV_5_09_00 - 2 * 3_600_000).toISOString() }),
      frontPageStory(2, { time: null }),
      frontPageStory(3, { time: new Date(NOV_5_09_00 - 3 * 3_600_000).toISOString() }),
    ];

    assert.deepStrictEqual(ids(selectStories(stories, new Set(), NOV_5_09_00, rules)), [3]);
  });

  it("keeps page order up to the limit", () => {
    const stories = [frontPageStory(3), frontPageStory(1), frontPageStory(2)];

    assert.deepStrictEqual(ids(selectStories(stories, new Set(), NOV_5_09_00, rules)), [3, 1]);
  });
});

describe("buildDigestStories", () => {
  const thread = (id: number) => ({
    rank: id,
    thread: {
      fetched_at: "t",
      failed_fetches: 0,
      item: {
        id,
        type: "story",
        title: `Story ${id}`,
        url: "https://example.com",
        hn_url: `https://news.ycombinator.com/item?id=${id}`,
        by: null,
        score: 1,
        comment_count: 1,
        time: null,
      },
      comments: [],
    },
  });

  it("ignores story ids the model invented", () => {
    const stories = buildDigestStories([thread(1)], {
      overview: "o",
      important: [],
      stories: [
        { story_id: 999, about: "fake", opinion: "fake", disagreement: null },
        { story_id: 1, about: "real", opinion: "real", disagreement: null },
      ],
    });

    assert.strictEqual(stories.length, 1);
    assert.strictEqual(stories[0]?.about, "real");
  });

  it("keeps a story the model skipped, without a summary", () => {
    const stories = buildDigestStories([thread(1)], { overview: "o", important: [], stories: [] });

    assert.strictEqual(stories[0]?.id, 1);
    assert.strictEqual(stories[0]?.opinion, null);
  });

  it("removes URLs the model wrote, in every field", () => {
    const stories = buildDigestStories([thread(1)], {
      overview: "o",
      important: [],
      stories: [
        {
          story_id: 1,
          about: "See https://evil.example/a",
          opinion: "Visit www.evil.example now",
          disagreement: "http://evil.example?x=1",
        },
      ],
    });

    for (const text of [stories[0]?.about, stories[0]?.opinion, stories[0]?.disagreement]) {
      assert.notInclude(text ?? "", "evil.example");
    }
  });

  it("keeps important picks only for stories in the digest, once each, at most three", () => {
    const stories = buildDigestStories([1, 2, 3, 4].map(thread), null);
    const important = buildImportant(stories, {
      overview: "o",
      stories: [],
      important: [
        { story_id: 999, why: "invented" },
        { story_id: 2, why: "Patch now, see https://evil.example" },
        { story_id: 2, why: "again" },
        { story_id: 1, why: "a" },
        { story_id: 3, why: "b" },
        { story_id: 4, why: "c" },
      ],
    });

    assert.deepStrictEqual(
      important.map((entry) => entry.story_id),
      [2, 1, 3],
    );
    assert.notInclude(important[0]?.why ?? "", "evil.example");
  });

  it("stripUrls leaves ordinary text alone", () => {
    assert.strictEqual(stripUrls("Rust vs C, per the kernel docs."), "Rust vs C, per the kernel docs.");
  });
});

const ANALYSIS = {
  overview: "Lively day.",
  important: [{ story_id: 1, why: "It matters." }],
  stories: [{ story_id: 1, about: "About one.", opinion: "Mostly positive.", disagreement: null }],
};

const hnStory = {
  id: 1,
  type: "story",
  title: "Story one",
  url: "https://example.com/1",
  score: 200,
  descendants: 40,
  time: Math.floor((NOV_5_09_00 - 6 * 3_600_000) / 1000),
  kids: [10],
};

const HN = {
  page: frontPageHtml([1]),
  items: { 1: hnStory, 10: { id: 10, by: "someone", text: "A real comment", time: 1 } },
};

const harness = (options: { generate?: unknown; mailFailures?: ReadonlyArray<string> } = {}) => {
  const net = fakeHttp(HN);
  const model = fakeModel({ generate: options.generate ?? ANALYSIS });
  const mail = fakeMailer(options.mailFailures);
  const layer = DigestJob.layer.pipe(
    Layer.provideMerge(Analyst.layer),
    Layer.provideMerge(mail.layer),
    Layer.provideMerge(net.layer),
    Layer.provideMerge(Store.layerAt(":memory:")),
    Layer.provideMerge(model.layer),
    Layer.provideMerge(testConfig()),
  );
  const itemFetches = () => net.calls.filter((url) => url.includes("/item/")).length;
  return { net, model, mail, layer, itemFetches };
};

describe("run", () => {
  it.effect("fetches, analyzes, stores and emails a digest", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;
      const store = yield* Store;

      const outcome = yield* job.run("2026-11-05");

      assert.strictEqual(outcome, "sent");
      assert.strictEqual(h.mail.sent.length, 1);
      assert.strictEqual(h.mail.sent[0]?.kind, "digest");
      assert.include(h.mail.sent[0]?.email.html ?? "", "Mostly positive.");
      assert.include(h.mail.sent[0]?.email.html ?? "", "It matters.");

      const messageId = h.mail.sent[0]?.threading.messageId ?? "";
      assert.strictEqual(yield* store.digestMessageId("2026-11-05"), messageId);
      assert.deepStrictEqual(yield* store.findOutgoing([messageId]), new Map([[messageId, "2026-11-05"]]));

      const row = yield* store.getDigestRow("2026-11-05");
      assert.strictEqual(row?.status, "sent");
      assert.strictEqual(row?.digest?.stories[0]?.title, "Story one");
      assert.strictEqual(row?.digest?.model, "gpt-6-luna");
      assert.deepStrictEqual(row?.digest?.important, [{ story_id: 1, why: "It matters." }]);
      assert.strictEqual(row?.snapshot?.threads[0]?.thread.comments[0]?.text, "A real comment");
      assert.strictEqual(yield* store.usageTotal("2026-11-05", "digest"), 120);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("running twice sends once and spends nothing more", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;

      yield* job.run("2026-11-05");
      const fetches = h.itemFetches();
      const outcome = yield* job.run("2026-11-05");

      assert.strictEqual(outcome, "already-sent");
      assert.strictEqual(h.mail.sent.length, 1);
      assert.strictEqual(h.model.requests.length, 1);
      assert.strictEqual(h.itemFetches(), fetches);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a failed send resumes without fetching or analyzing again", () => {
    const h = harness({ mailFailures: ["smtp down"] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;
      const store = yield* Store;

      const error = yield* job.run("2026-11-05").pipe(Effect.flip);
      assert.strictEqual(error._tag, "MailError");
      const fetches = h.itemFetches();
      const firstId = yield* store.digestMessageId("2026-11-05");

      assert.strictEqual(yield* job.run("2026-11-05"), "sent");
      assert.strictEqual(h.itemFetches(), fetches);
      assert.strictEqual(h.model.requests.length, 1);
      // Same Message-ID on the retry, so a reply to either copy is recognized.
      assert.strictEqual(h.mail.sent[0]?.threading.messageId, firstId);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a failed analysis retries from the saved comments", () => {
    const failing = harness({ generate: new Error("model unavailable") });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;
      const store = yield* Store;

      const error = yield* job.run("2026-11-05").pipe(Effect.flip);
      assert.strictEqual(error._tag, "AnalysisError");
      assert.strictEqual(failing.mail.sent.length, 0);

      const row = yield* store.getDigestRow("2026-11-05");
      assert.strictEqual(row?.status, "pending");
      assert.isNotNull(row?.snapshot);

      const fetches = failing.itemFetches();
      yield* job.run("2026-11-05").pipe(Effect.flip);
      assert.strictEqual(failing.itemFetches(), fetches);
      assert.strictEqual(failing.model.requests.length, 2);
    }).pipe(Effect.provide(failing.layer));
  });

  it.effect("a story isn't marked as seen until its digest is saved", () => {
    const failing = harness({ generate: new Error("model unavailable") });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;
      const store = yield* Store;

      yield* job.run("2026-11-05").pipe(Effect.flip);

      assert.strictEqual((yield* store.seenStoryIds([1])).size, 0);
    }).pipe(Effect.provide(failing.layer));
  });

  it.effect("the next day skips stories already sent, and pays for no model call", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;

      yield* job.run("2026-11-05");
      yield* TestClock.setTime(NOV_6_09_00);
      assert.strictEqual(yield* job.run("2026-11-06"), "sent");

      assert.strictEqual(h.model.requests.length, 1);
      assert.strictEqual(h.mail.sent.length, 2);
      assert.include(h.mail.sent[1]?.email.subject ?? "", "nothing new");
      assert.notStrictEqual(h.mail.sent[1]?.threading.messageId, h.mail.sent[0]?.threading.messageId);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("sends the model no tools, so injected text can't trigger actions", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;

      yield* job.run("2026-11-05");

      assert.deepStrictEqual(h.model.requests[0]?.tools, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("drops author names and links from what the model sees", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;

      yield* job.run("2026-11-05");

      const prompt = JSON.stringify(h.model.requests[0]?.prompt);
      assert.include(prompt, "A real comment");
      assert.notInclude(prompt, "someone");
      assert.notInclude(prompt, "example.com/1");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("tick", () => {
  it.effect("does nothing before the digest time", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_07_00);
      const job = yield* DigestJob;

      assert.strictEqual(yield* job.tick, "not-due");

      assert.strictEqual(h.mail.sent.length, 0);
      assert.strictEqual(h.net.calls.length, 0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("catches up when started after the digest time, then stays quiet", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;

      assert.strictEqual(yield* job.tick, "sent");
      assert.strictEqual(yield* job.tick, "done");

      assert.strictEqual(h.mail.sent.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("waits between attempts after a failure", () => {
    const h = harness({ mailFailures: ["down"] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;
      const store = yield* Store;

      assert.strictEqual(yield* job.tick, "retry-later");
      assert.strictEqual((yield* store.getDigestRow("2026-11-05"))?.attempts, 1);

      yield* TestClock.adjust(RETRY_GAP - 1000);
      assert.strictEqual(yield* job.tick, "waiting-to-retry");
      assert.strictEqual((yield* store.getDigestRow("2026-11-05"))?.attempts, 1);
      assert.strictEqual(h.mail.sent.length, 0);

      yield* TestClock.adjust(1000);
      assert.strictEqual(yield* job.tick, "sent");
      assert.strictEqual(h.mail.sent.length, 1);
      assert.strictEqual((yield* store.getDigestRow("2026-11-05"))?.status, "sent");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("gives up after four attempts, alerts once, and tries again tomorrow", () => {
    const h = harness({ generate: new Error("model unavailable") });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;
      const store = yield* Store;

      for (let attempt = 0; attempt < 6; attempt++) {
        yield* job.tick;
        yield* TestClock.adjust(THIRTY_MINUTES);
      }

      assert.strictEqual(h.model.requests.length, 4);
      assert.strictEqual((yield* store.getDigestRow("2026-11-05"))?.status, "failed");
      assert.strictEqual(h.mail.sent.length, 1);
      assert.include(h.mail.sent[0]?.email.subject ?? "", "failed");
      assert.include(h.mail.sent[0]?.email.text ?? "", "model unavailable");
      assert.strictEqual(h.mail.sent[0]?.kind, "alert");
      // Alerts aren't threads to chat in, so replies to them are ignored.
      const alertId = h.mail.sent[0]?.threading.messageId ?? "";
      assert.strictEqual((yield* store.findOutgoing([alertId])).size, 0);

      yield* TestClock.setTime(NOV_6_09_00);
      yield* job.tick;
      assert.strictEqual(h.model.requests.length, 5);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a tick that fails entirely still leaves the scheduler alive", () => {
    const h = harness({ generate: new Error("model unavailable") });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;

      const exit = yield* Effect.exit(job.tick);

      assert.strictEqual(exit._tag, "Success");
      assert.deepStrictEqual(exit._tag === "Success" ? exit.value : null, "retry-later");
    }).pipe(Effect.provide(h.layer));
  });
});
