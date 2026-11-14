import { Clock, Context, DateTime, Duration, Effect, Layer } from "effect";
import { AnalysisError, Analyst, stripUrls } from "./Analyst.js";
import { AppConfig, type DigestTime } from "./AppConfig.js";
import type { Digest, DigestAnalysis, DigestStory, Important, Snapshot } from "./Digest.js";
import type { HnRequestError, FrontPageUnavailable, Story, Thread } from "./domain.js";
import { renderDigestEmail, renderFailureEmail } from "./email.js";
import { HackerNews } from "./HackerNews.js";
import { type MailError, Mailer } from "./Mailer.js";
import { Store } from "./Store.js";

/**
 * Cron runs a tick every 30 minutes. The gap is a little shorter so that a failure partway
 * through one run doesn't push the retry back by a whole extra slot.
 */
const RETRY_INTERVAL = Duration.toMillis(Duration.minutes(25));
const MAX_ATTEMPTS = 4;
const MAX_IMPORTANT = 3;

const FRONT_PAGE_PARAMS = { limit: 30, comments_per_story: 0, max_comment_chars: 500 };
const THREAD_PARAMS = { limit: 10, reply_depth: 1, replies_per_comment: 3, max_comment_chars: 1000 };

type RunError = HnRequestError | FrontPageUnavailable | AnalysisError | MailError;

export interface LocalMoment {
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
}

export const localMoment = (nowMillis: number, timeZone: string): LocalMoment => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(nowMillis));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
    minute: Number(part("minute")),
  };
};

export const isDue = (moment: LocalMoment, time: DigestTime): boolean =>
  moment.hour > time.hour || (moment.hour === time.hour && moment.minute >= time.minute);

export interface SelectionRules {
  readonly maxStories: number;
  readonly minComments: number;
  readonly minAgeHours: number;
}

/** Skips stories already sent, job posts, and threads too young or quiet to have real opinions. */
export const selectStories = (
  stories: ReadonlyArray<Story>,
  seen: ReadonlySet<number>,
  nowMillis: number,
  rules: SelectionRules,
): ReadonlyArray<Story> =>
  stories
    .filter((story) => {
      if (seen.has(story.id) || story.type !== "story") return false;
      if ((story.comment_count ?? 0) < rules.minComments) return false;
      const postedAt = story.time === null ? Number.NaN : Date.parse(story.time);
      return nowMillis - postedAt >= rules.minAgeHours * 3_600_000;
    })
    .slice(0, rules.maxStories);

/** Merges model output into stories, ignoring any story_id the model invented. */
export const buildDigestStories = (
  threads: ReadonlyArray<{ readonly rank: number; readonly thread: Thread }>,
  analysis: DigestAnalysis | null,
): ReadonlyArray<DigestStory> =>
  threads.map(({ rank, thread: { item } }) => {
    const entry = analysis?.stories.find((candidate) => candidate.story_id === item.id);
    return {
      rank,
      id: item.id,
      title: item.title ?? `Story ${item.id}`,
      url: item.url,
      hn_url: item.hn_url,
      score: item.score,
      comment_count: item.comment_count,
      about: entry ? stripUrls(entry.about) : null,
      opinion: entry ? stripUrls(entry.opinion) : null,
      disagreement: entry?.disagreement ? stripUrls(entry.disagreement) : null,
    };
  });

/** The model's picks, limited to stories in this digest and with URLs removed. */
export const buildImportant = (
  stories: ReadonlyArray<DigestStory>,
  analysis: DigestAnalysis | null,
): ReadonlyArray<Important> => {
  const ids = new Set(stories.map((story) => story.id));
  const picked = new Set<number>();
  return (analysis?.important ?? [])
    .filter((entry) => {
      if (!ids.has(entry.story_id) || picked.has(entry.story_id)) return false;
      picked.add(entry.story_id);
      return true;
    })
    .slice(0, MAX_IMPORTANT)
    .map((entry) => ({ story_id: entry.story_id, why: stripUrls(entry.why) }));
};

export type TickOutcome =
  | "not-due"
  | "done"
  | "waiting-to-retry"
  | "sent"
  | "already-sent"
  | "gave-up"
  | "retry-later"
  | "crashed";

export class DigestJob extends Context.Service<
  DigestJob,
  {
    /** Generates and sends the given day's digest, resuming whatever an earlier attempt finished. */
    run(date: string): Effect.Effect<"sent" | "already-sent" | "gave-up", RunError>;
    /** Today's date in the configured time zone. */
    readonly today: Effect.Effect<string>;
    /** One scheduler step: runs today's digest if it's due and not done. Never fails. */
    readonly tick: Effect.Effect<TickOutcome>;
  }
>()("hackernews-mcp/DigestJob") {
  static readonly layer = Layer.effect(
    DigestJob,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const hackerNews = yield* HackerNews;
      const analyst = yield* Analyst;
      const mailer = yield* Mailer;
      const store = yield* Store;

      const fetchSnapshot = Effect.fn("DigestJob.fetchSnapshot")(function* (date: string) {
        const now = yield* Clock.currentTimeMillis;
        const frontPage = yield* hackerNews.getFrontPage(FRONT_PAGE_PARAMS);
        const seen = yield* store.seenStoryIds(frontPage.stories.map((story) => story.id));
        const selected = selectStories(frontPage.stories, seen, now, config);

        const results = yield* Effect.forEach(
          selected,
          (story) =>
            hackerNews.getComments({ ...THREAD_PARAMS, item_id: story.id }).pipe(
              Effect.map((thread) => ({ rank: story.rank, thread })),
              Effect.catch((error) =>
                Effect.logWarning(`Skipping story ${story.id}: ${error.message}`).pipe(
                  Effect.as(null),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        const threads = results.filter((entry) => entry !== null);
        const snapshot: Snapshot = {
          fetched_at: DateTime.formatIso(DateTime.makeUnsafe(now)),
          ranking_source: frontPage.ranking_source,
          failed_fetches:
            frontPage.failed_fetches +
            threads.reduce((sum, { thread }) => sum + thread.failed_fetches, 0) +
            (results.length - threads.length),
          threads,
        };
        yield* store.saveSnapshot(date, snapshot);
        return snapshot;
      });

      const analyze = Effect.fn("DigestJob.analyze")(function* (date: string, snapshot: Snapshot) {
        const now = yield* Clock.currentTimeMillis;
        const generatedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
        const base = {
          date,
          generated_at: generatedAt,
          ranking_source: snapshot.ranking_source,
          failed_fetches: snapshot.failed_fetches,
        };

        // Nothing to summarize, so don't pay for a model call.
        let digest: Digest = {
          ...base,
          model: null,
          overview: null,
          important: [],
          stories: [],
        };
        if (snapshot.threads.length > 0) {
          const result = yield* analyst.analyze(snapshot.threads.map(({ thread }) => thread));
          yield* store.addUsage(date, "digest", result);
          const stories = buildDigestStories(snapshot.threads, result.analysis);
          digest = {
            ...base,
            model: config.model,
            overview: stripUrls(result.analysis.overview),
            important: buildImportant(stories, result.analysis),
            stories,
          };
        }
        yield* store.saveDigest(date, digest);
        return digest;
      });

      const run = Effect.fn("DigestJob.run")(function* (date: string) {
        const row = yield* store.getDigestRow(date);
        if (row?.status === "sent") return "already-sent" as const;
        if (row?.status === "failed") return "gave-up" as const;

        const snapshot = row?.snapshot ?? (yield* fetchSnapshot(date));
        const digest = row?.digest ?? (yield* analyze(date, snapshot));
        // A retry reuses the Message-ID, so replies to either copy land in the same thread,
        // and Gmail can drop the copy if an earlier attempt did go out.
        let messageId = yield* store.digestMessageId(date);
        if (messageId === null) {
          messageId = yield* mailer.newMessageId;
          yield* store.recordOutgoing(messageId, date, "digest", yield* Clock.currentTimeMillis);
        }
        yield* mailer.send(renderDigestEmail(digest), "digest", { messageId });
        yield* store.markSent(date, messageId, yield* Clock.currentTimeMillis);
        return "sent" as const;
      });

      const today = Effect.map(Clock.currentTimeMillis, (now) =>
        localMoment(now, config.digestTimeZone).date,
      );

      const handleFailure = Effect.fn("DigestJob.handleFailure")(function* (
        date: string,
        error: RunError,
      ) {
        yield* Effect.logError(`Digest ${date} failed: ${error.message}`);
        const now = yield* Clock.currentTimeMillis;
        const attempts = yield* store.recordFailure(date, now, error.message);
        if (attempts < MAX_ATTEMPTS) return;

        yield* store.markFailed(date);
        yield* mailer
          .send(renderFailureEmail(date, attempts, error.message), "alert", {
            messageId: yield* mailer.newMessageId,
          })
          .pipe(
            Effect.catch((mailError) =>
              Effect.logError(`Could not send failure alert: ${mailError.message}`),
            ),
          );
      });

      const tick = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const moment = localMoment(now, config.digestTimeZone);
        if (!isDue(moment, config.digestTime)) return "not-due" as const;

        const row = yield* store.getDigestRow(moment.date);
        if (row?.status === "sent" || row?.status === "failed") return "done" as const;
        if (row?.lastAttemptAt != null && now - row.lastAttemptAt < RETRY_INTERVAL) {
          return "waiting-to-retry" as const;
        }

        return yield* run(moment.date).pipe(
          Effect.catch((error) =>
            handleFailure(moment.date, error).pipe(Effect.as("retry-later" as const)),
          ),
        );
      }).pipe(
        // A defect must not stop the next run, or tomorrow's digest.
        Effect.catchCause((cause) =>
          Effect.logError("Digest tick crashed", cause).pipe(Effect.as("crashed" as const)),
        ),
      );

      return DigestJob.of({ run, today, tick });
    }),
  );
}
