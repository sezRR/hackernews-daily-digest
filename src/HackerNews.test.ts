import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { CommentsParams, FrontPageParams } from "./domain.js";
import { HackerNews } from "./HackerNews.js";
import { FAIL, failOnce, fakeHttp, frontPageHtml, MISSING, type FakeHn } from "./test-helpers.js";

const FRONT_PAGE: FrontPageParams = { limit: 30, comments_per_story: 3, max_comment_chars: 500 };
const THREAD: CommentsParams = {
  item_id: 1,
  limit: 10,
  reply_depth: 1,
  replies_per_comment: 3,
  max_comment_chars: 2000,
};

const story = (id: number, extra: object = {}) => ({
  id,
  type: "story",
  title: `Story ${id}`,
  url: `https://example.com/${id}`,
  ...extra,
});

const comment = (id: number, text: string, extra: object = {}) => ({
  id,
  type: "comment",
  by: "user",
  time: 1700000000,
  text,
  ...extra,
});

const getFrontPage = (hn: FakeHn, params: Partial<FrontPageParams> = {}) => {
  const net = fakeHttp(hn);
  return HackerNews.use((service) => service.getFrontPage({ ...FRONT_PAGE, ...params })).pipe(
    Effect.provide(net.layer),
    Effect.map((result) => ({ result, net })),
  );
};

const getComments = (hn: FakeHn, params: Partial<CommentsParams> = {}) => {
  const net = fakeHttp(hn);
  return HackerNews.use((service) => service.getComments({ ...THREAD, ...params })).pipe(
    Effect.provide(net.layer),
    Effect.map((result) => ({ result, net })),
  );
};

const called = (calls: ReadonlyArray<string>, suffix: string) =>
  calls.filter((url) => url.endsWith(suffix)).length;

describe("front page ranking", () => {
  it.live("ranks stories by page order, not API order", () =>
    Effect.gen(function* () {
      const { result, net } = yield* getFrontPage({
        page: frontPageHtml([2, 1]),
        top: [1, 2],
        items: { 1: story(1), 2: story(2) },
      });

      assert.strictEqual(result.ranking_source, "front_page_html");
      assert.deepStrictEqual(
        result.stories.map((s) => [s.rank, s.id]),
        [
          [1, 2],
          [2, 1],
        ],
      );
      assert.strictEqual(called(net.calls, "/topstories.json"), 0);
    }),
  );

  it.live("falls back to API order when the page request fails", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage({
        page: 503,
        top: [1, 2],
        items: { 1: story(1), 2: story(2) },
      });

      assert.strictEqual(result.ranking_source, "api_topstories");
      assert.deepStrictEqual(
        result.stories.map((s) => s.id),
        [1, 2],
      );
    }),
  );

  it.live("never retries the page, to respect the crawl delay", () =>
    Effect.gen(function* () {
      const { net } = yield* getFrontPage({ page: 503, top: [1], items: { 1: story(1) } });

      assert.strictEqual(called(net.calls, "news.ycombinator.com/"), 1);
    }),
  );

  it.live("falls back to API order when the page markup has no story rows", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage({
        page: "<html>redesigned</html>",
        top: [1],
        items: { 1: story(1) },
      });

      assert.strictEqual(result.ranking_source, "api_topstories");
      assert.strictEqual(result.stories.length, 1);
    }),
  );

  it.live("fallback ranking stops at one page of stories", () =>
    Effect.gen(function* () {
      const top = Array.from({ length: 500 }, (_, i) => i + 1);
      const items = Object.fromEntries(top.map((id) => [id, story(id)]));
      const { result } = yield* getFrontPage({ page: 503, top, items });

      assert.strictEqual(result.stories.length, 30);
    }),
  );

  it.live("errors when neither the page nor the API ranking is available", () =>
    Effect.gen(function* () {
      const error = yield* getFrontPage({ page: 503, top: FAIL }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "HnRequestError");
      assert.include(error.message, "/topstories.json");
    }),
  );

  it.effect("re-reads the page only after the robots.txt crawl delay", () => {
    const net = fakeHttp({ page: frontPageHtml([1]), items: { 1: story(1) } });
    return Effect.gen(function* () {
      const service = yield* HackerNews;
      const pageFetches = () => called(net.calls, "news.ycombinator.com/");

      yield* service.getFrontPage(FRONT_PAGE);
      yield* TestClock.adjust("29 seconds");
      yield* service.getFrontPage(FRONT_PAGE);
      assert.strictEqual(pageFetches(), 1);

      yield* TestClock.adjust("2 seconds");
      yield* service.getFrontPage(FRONT_PAGE);
      assert.strictEqual(pageFetches(), 2);
    }).pipe(Effect.provide(net.layer));
  });

  it.effect("concurrent calls share a single page request", () => {
    const net = fakeHttp({ page: frontPageHtml([1]), items: { 1: story(1) } });
    return Effect.gen(function* () {
      const service = yield* HackerNews;

      yield* Effect.all([service.getFrontPage(FRONT_PAGE), service.getFrontPage(FRONT_PAGE)], {
        concurrency: "unbounded",
      });

      assert.strictEqual(called(net.calls, "news.ycombinator.com/"), 1);
    }).pipe(Effect.provide(net.layer));
  });

  it.effect("a failed page read is not cached", () => {
    const hn: { page: string | number; top: Array<number>; items: Record<number, unknown> } = {
      page: 503,
      top: [1],
      items: { 1: story(1) },
    };
    const net = fakeHttp(hn);
    return Effect.gen(function* () {
      const service = yield* HackerNews;

      const first = yield* service.getFrontPage(FRONT_PAGE);
      assert.strictEqual(first.ranking_source, "api_topstories");

      hn.page = frontPageHtml([1]);
      yield* TestClock.adjust("1 millis");
      const second = yield* service.getFrontPage(FRONT_PAGE);
      assert.strictEqual(second.ranking_source, "front_page_html");
    }).pipe(Effect.provide(net.layer));
  });
});

describe("front page content", () => {
  it.live("limit keeps the first stories", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage(
        {
          page: frontPageHtml([1, 2, 3]),
          items: { 1: story(1), 2: story(2), 3: story(3) },
        },
        { limit: 2 },
      );

      assert.deepStrictEqual(
        result.stories.map((s) => s.id),
        [1, 2],
      );
    }),
  );

  it.live("self posts link to their own thread and carry converted text", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage({
        page: frontPageHtml([1]),
        items: { 1: { id: 1, type: "story", title: "Ask HN: Why?", text: "Because&#x27;s why" } },
      });
      const post = result.stories[0];

      assert.strictEqual(post?.url, "https://news.ycombinator.com/item?id=1");
      assert.strictEqual(post?.hn_url, "https://news.ycombinator.com/item?id=1");
      assert.strictEqual(post?.text, "Because's why");
    }),
  );

  it.live("job posts with no comment fields still load", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage({
        page: frontPageHtml([1]),
        items: { 1: { id: 1, type: "job", title: "Hiring", url: "https://example.com/job" } },
      });
      const job = result.stories[0];

      assert.strictEqual(job?.type, "job");
      assert.strictEqual(job?.comment_count, null);
      assert.deepStrictEqual(job?.top_comments, []);
    }),
  );

  it.live("formats timestamps as ISO 8601", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage({
        page: frontPageHtml([1]),
        items: { 1: story(1, { time: 1700000000, kids: [10] }), 10: comment(10, "hi") },
      });

      assert.strictEqual(result.stories[0]?.time, "2023-11-14T22:13:20.000Z");
      assert.strictEqual(result.stories[0]?.top_comments[0]?.time, "2023-11-14T22:13:20.000Z");
    }),
  );

  it.live("skips deleted and dead comments and fills the limit from later ones", () =>
    Effect.gen(function* () {
      const { result, net } = yield* getFrontPage({
        page: frontPageHtml([1]),
        items: {
          1: story(1, { kids: [10, 11, 12, 13, 14, 15] }),
          10: comment(10, "gone", { deleted: true }),
          11: comment(11, "flagged", { dead: true }),
          12: comment(12, "first"),
          13: comment(13, "second"),
          14: comment(14, "third"),
          15: comment(15, "never needed"),
        },
      });

      assert.deepStrictEqual(
        result.stories[0]?.top_comments.map((c) => c.id),
        [12, 13, 14],
      );
      assert.strictEqual(called(net.calls, "/item/15.json"), 0);
    }),
  );

  it.live("zero comments per story requests no comments", () =>
    Effect.gen(function* () {
      const { result, net } = yield* getFrontPage(
        {
          page: frontPageHtml([1]),
          items: { 1: story(1, { kids: [10] }), 10: comment(10, "unused") },
        },
        { comments_per_story: 0 },
      );

      assert.deepStrictEqual(result.stories[0]?.top_comments, []);
      assert.strictEqual(called(net.calls, "/item/10.json"), 0);
    }),
  );

  it.live("marks only over-long comments as truncated", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage(
        {
          page: frontPageHtml([1]),
          items: {
            1: story(1, { kids: [10, 11] }),
            10: comment(10, "x".repeat(101)),
            11: comment(11, "y".repeat(100)),
          },
        },
        { max_comment_chars: 100 },
      );
      const [long, exact] = result.stories[0]?.top_comments ?? [];

      assert.strictEqual(long?.truncated, true);
      assert.strictEqual(long?.text, `${"x".repeat(100)}…`);
      assert.strictEqual(exact?.truncated, undefined);
      assert.strictEqual(exact?.text, "y".repeat(100));
    }),
  );

  it.live("truncating inside an emoji leaves well-formed text", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage(
        {
          page: frontPageHtml([1]),
          items: { 1: story(1, { kids: [10] }), 10: comment(10, "😀😀") },
        },
        { max_comment_chars: 1 },
      );

      assert.isTrue(result.stories[0]?.top_comments[0]?.text.isWellFormed());
    }),
  );

  it.live("never exceeds the concurrent request limit", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 30 }, (_, i) => i + 1);
      const items: Record<number, unknown> = {};
      for (const id of ids) {
        const kids = [1, 2, 3].map((n) => id * 100 + n);
        items[id] = story(id, { kids });
        for (const kid of kids) items[kid] = comment(kid, "text");
      }
      const { result, net } = yield* getFrontPage({ page: frontPageHtml(ids), items });

      assert.strictEqual(result.stories.length, 30);
      assert.strictEqual(result.failed_fetches, 0);
      assert.strictEqual(net.stats.peak, 16);
    }),
  );
});

describe("failures", () => {
  it.live("reports a failed comment and still returns the story", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage({
        page: frontPageHtml([1]),
        items: { 1: story(1, { kids: [10, 11] }), 10: FAIL, 11: comment(11, "ok") },
      });

      assert.strictEqual(result.failed_fetches, 1);
      assert.deepStrictEqual(
        result.stories[0]?.top_comments.map((c) => c.id),
        [11],
      );
    }),
  );

  it.live("a failed story leaves a rank gap and is reported", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage({
        page: frontPageHtml([1, 2, 3]),
        items: { 1: story(1), 2: FAIL, 3: story(3) },
      });

      assert.strictEqual(result.failed_fetches, 1);
      assert.deepStrictEqual(
        result.stories.map((s) => s.rank),
        [1, 3],
      );
    }),
  );

  it.live("an API response that fails to decode counts as a failed fetch", () =>
    Effect.gen(function* () {
      const { result } = yield* getFrontPage({
        page: frontPageHtml([1, 2]),
        items: { 1: story(1), 2: { id: "not a number" } },
      });

      assert.strictEqual(result.failed_fetches, 1);
      assert.strictEqual(result.stories.length, 1);
    }),
  );

  it.live("errors when no story at all could be loaded", () =>
    Effect.gen(function* () {
      const error = yield* getFrontPage({
        page: frontPageHtml([1, 2]),
        items: { 1: FAIL, 2: FAIL },
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "FrontPageUnavailable");
      assert.strictEqual(error.message, "Could not load any front page story (2 requests failed)");
    }),
  );

  it.live("retries a transient API failure and recovers", () =>
    Effect.gen(function* () {
      const { result, net } = yield* getFrontPage({
        page: frontPageHtml([1]),
        items: { 1: failOnce(story(1)) },
      });

      assert.strictEqual(result.failed_fetches, 0);
      assert.strictEqual(result.stories.length, 1);
      assert.strictEqual(called(net.calls, "/item/1.json"), 2);
    }),
  );

  it.live("gives up on a persistent failure after two retries", () =>
    Effect.gen(function* () {
      const { result, net } = yield* getFrontPage({
        page: frontPageHtml([1, 2]),
        items: { 1: FAIL, 2: story(2) },
      });

      assert.strictEqual(result.failed_fetches, 1);
      assert.strictEqual(called(net.calls, "/item/1.json"), 3);
    }),
  );

  it.live("does not retry a non-transient status", () =>
    Effect.gen(function* () {
      const { result, net } = yield* getFrontPage({
        page: frontPageHtml([1, 2]),
        items: { 1: MISSING, 2: story(2) },
      });

      assert.strictEqual(result.failed_fetches, 1);
      assert.strictEqual(called(net.calls, "/item/1.json"), 1);
    }),
  );
});

describe("getComments", () => {
  it.live("nests replies to the requested depth and caps them", () =>
    Effect.gen(function* () {
      const { result, net } = yield* getComments(
        {
          items: {
            1: story(1, { kids: [10], descendants: 5 }),
            10: comment(10, "top", { kids: [20, 21, 22] }),
            20: comment(20, "reply one", { kids: [30] }),
            21: comment(21, "reply two"),
            22: comment(22, "reply three"),
            30: comment(30, "nested"),
          },
        },
        { reply_depth: 1, replies_per_comment: 2 },
      );
      const top = result.comments[0];

      assert.strictEqual(result.item.comment_count, 5);
      assert.strictEqual(top?.reply_count, 3);
      assert.deepStrictEqual(
        top?.replies?.map((r) => r.id),
        [20, 21],
      );
      assert.strictEqual(top?.replies?.[0]?.reply_count, 1);
      assert.strictEqual(top?.replies?.[0]?.replies, undefined);
      assert.strictEqual(called(net.calls, "/item/30.json"), 0);
    }),
  );

  it.live("depth zero returns no replies", () =>
    Effect.gen(function* () {
      const { result } = yield* getComments(
        { items: { 1: story(1, { kids: [10] }), 10: comment(10, "top", { kids: [20] }) } },
        { reply_depth: 0 },
      );

      assert.strictEqual(result.comments[0]?.reply_count, 1);
      assert.strictEqual(result.comments[0]?.replies, undefined);
    }),
  );

  it.live("accepts a comment id to read its replies", () =>
    Effect.gen(function* () {
      const { result } = yield* getComments(
        { items: { 10: comment(10, "parent", { kids: [20] }), 20: comment(20, "child") } },
        { item_id: 10 },
      );

      assert.strictEqual(result.item.type, "comment");
      assert.strictEqual(result.item.text, "parent");
      assert.deepStrictEqual(
        result.comments.map((c) => c.text),
        ["child"],
      );
    }),
  );

  it.live("errors on an unknown id", () =>
    Effect.gen(function* () {
      const error = yield* getComments({ items: {} }, { item_id: 999 }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "ItemNotFound");
      assert.strictEqual(error.message, "No Hacker News item with id 999");
    }),
  );

  it.live("errors when the requested item itself cannot be fetched", () =>
    Effect.gen(function* () {
      const error = yield* getComments({ items: { 1: FAIL } }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "HnRequestError");
    }),
  );
});
