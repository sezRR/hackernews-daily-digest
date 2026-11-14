import { assert, describe, it } from "@effect/vitest";
import { buildAnalysisPrompt, estimateTokens, fitToTokenLimit } from "./Analyst.js";
import type { Comment, Thread } from "./domain.js";

const comment = (id: number, chars = 900): Comment => ({
  id,
  by: null,
  time: null,
  text: `${id}:${"x".repeat(chars)}`,
  reply_count: 0,
});

const thread = (id: number, commentCount: number, chars?: number): Thread => ({
  fetched_at: "t",
  failed_fetches: 0,
  item: {
    id,
    type: "story",
    title: `Story ${id}`,
    url: "u",
    hn_url: "h",
    by: null,
    score: 1,
    comment_count: commentCount,
    time: null,
  },
  comments: Array.from({ length: commentCount }, (_, index) => comment(id * 100 + index, chars)),
});

const commentIds = (threads: ReadonlyArray<Thread>) =>
  threads.map((entry) => entry.comments.map((item) => item.id));

describe("fitToTokenLimit", () => {
  it("leaves a prompt that already fits untouched", () => {
    const threads = [thread(1, 3), thread(2, 3)];

    const fitted = fitToTokenLimit(threads, 40_000);

    assert.strictEqual(fitted.droppedComments, 0);
    assert.deepStrictEqual(commentIds(fitted.threads), commentIds(threads));
  });

  it("gets under the limit by dropping the lowest-ranked comments of the largest threads", () => {
    const threads = [thread(1, 10), thread(2, 3)];
    const big = threads[0]!;
    const limit = estimateTokens([{ ...big, comments: big.comments.slice(0, 4) }, threads[1]!]);

    const fitted = fitToTokenLimit(threads, limit);

    assert.isAtMost(fitted.estimatedTokens, limit);
    assert.strictEqual(fitted.droppedComments, 6);
    // Top-ranked comments stay; the short thread isn't touched.
    assert.deepStrictEqual(commentIds(fitted.threads), [
      [100, 101, 102, 103],
      [200, 201, 202],
    ]);
  });

  it("keeps every story with at least its top comment, even over the limit", () => {
    const fitted = fitToTokenLimit([thread(1, 5), thread(2, 5)], 1);

    assert.deepStrictEqual(commentIds(fitted.threads), [[100], [200]]);
    assert.isAbove(fitted.estimatedTokens, 1);
  });

  it("its running estimate matches a full recount", () => {
    const fitted = fitToTokenLimit([thread(1, 10), thread(2, 7), thread(3, 2)], 5_000);

    assert.strictEqual(fitted.estimatedTokens, estimateTokens(fitted.threads));
    assert.isAtMost(fitted.estimatedTokens, 5_000);
  });

  it("doesn't change the threads it was given, so the saved snapshot stays whole", () => {
    const threads = [thread(1, 5)];

    fitToTokenLimit(threads, 1);

    assert.strictEqual(threads[0]?.comments.length, 5);
  });

  it("overestimates rather than underestimates: about 3 characters per token", () => {
    const threads = [thread(1, 10)];
    const chars = buildAnalysisPrompt(threads).length;

    assert.isAtLeast(estimateTokens(threads), Math.ceil(chars / 3));
  });
});
