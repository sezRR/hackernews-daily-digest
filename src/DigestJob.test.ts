import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Analyst, stripUrls } from "./Analyst.js";
import type { Story } from "./domain.js";
import {
  buildDigestStories,
  buildImportant,
  DigestJob,
  isOnTime,
  localMoment,
  minutesFrom,
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
const NOV_6_09_00 = Date.UTC(2026, 10, 6, 9, 0);
const THIRTY_MINUTES = 30 * 60 * 1000;

describe("schedule", () => {
  it("uses the configured time zone for both date and time", () => {
    const moment = localMoment(Date.UTC(2026, 10, 5, 22, 30), "Asia/Tokyo");

    assert.deepStrictEqual(moment, { date: "2026-11-06", hour: 7, minute: 30 });
  });

  it("reports midnight as hour 0", () => {
    assert.strictEqual(localMoment(Date.UTC(2026, 10, 5, 0, 5), "UTC").hour, 0);
  });

  it("measures how far a start time is from DIGEST_TIME, the short way round midnight", () => {
    const time = { hour: 7, minute: 30 };
    const at = (hour: number, minute: number) => ({ date: "d", hour, minute });

    assert.strictEqual(minutesFrom(at(7, 30), time), 0);
    assert.strictEqual(minutesFrom(at(8, 30), time), 60);
    assert.strictEqual(minutesFrom(at(6, 30), time), -60);
    assert.strictEqual(minutesFrom(at(23, 30), { hour: 0, minute: 10 }), -40);
  });

  it("counts a start within five minutes as on time", () => {
    const time = { hour: 7, minute: 30 };

    assert.isTrue(isOnTime({ date: "d", hour: 7, minute: 30 }, time));
    assert.isTrue(isOnTime({ date: "d", hour: 7, minute: 35 }, time));
    assert.isFalse(isOnTime({ date: "d", hour: 8, minute: 30 }, time));
    assert.isFalse(isOnTime({ date: "d", hour: 6, minute: 30 }, time));
  });

  it("an hour's gap is what a cron ignoring CRON_TZ produces in Lisbon's summer", () => {
    // Server on UTC, cron fires 07:30 UTC, which is 08:30 in Lisbon in July.
    const moment = localMoment(Date.UTC(2026, 6, 1, 7, 30), "Europe/Lisbon");

    assert.isFalse(isOnTime(moment, { hour: 7, minute: 30 }));
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

/**
 * Lets a forked run get as far as its retry sleep: TestClock.adjust only fires sleeps that
 * have already started. Waits for the given number of failed attempts, then a little more.
 */
const untilAttempts = (date: string, attempts: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    for (let i = 0; i < 10_000; i++) {
      if (((yield* store.getDigestRow(date))?.attempts ?? 0) >= attempts) break;
      yield* Effect.yieldNow;
    }
    for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
  });

describe("runWithRetries", () => {
  it.effect("sends on the first attempt", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;

      assert.strictEqual(yield* job.runWithRetries("2026-11-05"), "sent");
      assert.strictEqual(h.mail.sent.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does nothing when today's digest was already sent", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;

      yield* job.runWithRetries("2026-11-05");
      assert.strictEqual(yield* job.runWithRetries("2026-11-05"), "already-sent");
      assert.strictEqual(h.mail.sent.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("after a failure, waits 30 minutes in the same run and tries again", () => {
    const h = harness({ mailFailures: ["down"] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;
      const store = yield* Store;

      const fiber = yield* Effect.forkChild(job.runWithRetries("2026-11-05"));
      yield* untilAttempts("2026-11-05", 1);
      yield* TestClock.adjust(THIRTY_MINUTES - 1000);
      assert.strictEqual(h.mail.sent.length, 0);
      assert.strictEqual((yield* store.getDigestRow("2026-11-05"))?.attempts, 1);

      yield* TestClock.adjust(1000);
      assert.strictEqual(yield* Fiber.join(fiber), "sent");
      assert.strictEqual(h.mail.sent.length, 1);
      // The retry reused the saved digest instead of calling the model again.
      assert.strictEqual(h.model.requests.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("gives up after four attempts, alerts once, and runs normally the next day", () => {
    const h = harness({ generate: new Error("model unavailable") });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOV_5_09_00);
      const job = yield* DigestJob;
      const store = yield* Store;

      const fiber = yield* Effect.forkChild(job.runWithRetries("2026-11-05"));
      for (let attempt = 1; attempt < 4; attempt++) {
        yield* untilAttempts("2026-11-05", attempt);
        yield* TestClock.adjust(THIRTY_MINUTES);
      }
      assert.strictEqual(yield* Fiber.join(fiber), "gave-up");

      assert.strictEqual(h.model.requests.length, 4);
      assert.strictEqual((yield* store.getDigestRow("2026-11-05"))?.status, "failed");
      assert.strictEqual(h.mail.sent.length, 1);
      assert.strictEqual(h.mail.sent[0]?.kind, "alert");
      assert.include(h.mail.sent[0]?.email.text ?? "", "model unavailable");
      // Alerts aren't threads to chat in, so replies to them are ignored.
      const alertId = h.mail.sent[0]?.threading.messageId ?? "";
      assert.strictEqual((yield* store.findOutgoing([alertId])).size, 0);

      // Running again the same day doesn't retry or alert twice.
      assert.strictEqual(yield* job.runWithRetries("2026-11-05"), "gave-up");
      assert.strictEqual(h.mail.sent.length, 1);

      yield* TestClock.setTime(NOV_6_09_00);
      yield* Effect.forkChild(job.runWithRetries("2026-11-06"));
      yield* untilAttempts("2026-11-06", 1);
      assert.strictEqual(h.model.requests.length, 5);
    }).pipe(Effect.provide(h.layer));
  });
});
