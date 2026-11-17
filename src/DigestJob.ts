import { Clock, Context, DateTime, Duration, Effect, Layer } from "effect";
import { AnalysisError, Analyst, stripUrls } from "./Analyst.js";
import { AppConfig, type DigestTime } from "./AppConfig.js";
import type { Digest, DigestAnalysis, DigestStory, Important, Snapshot } from "./Digest.js";
import type { HnRequestError, FrontPageUnavailable, Story, Thread } from "./domain.js";
import { renderDigestEmail, renderFailureEmail } from "./email.js";
import { HackerNews } from "./HackerNews.js";
import { type MailError, Mailer } from "./Mailer.js";
import { Store } from "./Store.js";

/** After a failed attempt, the same run waits this long and tries again. */
export const RETRY_DELAY = Duration.minutes(30);
export const MAX_ATTEMPTS = 4;
/**
 * A run claims the day so a second process started at the same time exits instead of
 * sending a second digest. If the run dies without letting go, the claim lapses after this
 * long. A full run, four attempts 30 minutes apart, ends well within it.
 */
export const RUN_CLAIM_EXPIRY = Duration.hours(3);
/** How far from DIGEST_TIME a cron start can be before it's logged as a warning. */
const ON_TIME_TOLERANCE_MINUTES = 5;
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

/**
 * Minutes between a local time and DIGEST_TIME, the short way round midnight. Cron should
 * start the digest at DIGEST_TIME; a big gap means cron is reading the time in another zone.
 */
export const minutesFrom = (moment: LocalMoment, time: DigestTime): number => {
  const difference = moment.hour * 60 + moment.minute - (time.hour * 60 + time.minute);
  const wrapped = ((difference % 1440) + 1440) % 1440;
  return wrapped > 720 ? wrapped - 1440 : wrapped;
};

export const isOnTime = (moment: LocalMoment, time: DigestTime): boolean =>
  Math.abs(minutesFrom(moment, time)) <= ON_TIME_TOLERANCE_MINUTES;

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

export type RunOutcome = "sent" | "already-sent" | "already-running" | "gave-up";

export class DigestJob extends Context.Service<
  DigestJob,
  {
    /** Generates and sends the given day's digest, resuming whatever an earlier attempt finished. */
    run(date: string): Effect.Effect<RunOutcome, RunError>;
    /** Today's date and time in the configured time zone. */
    readonly now: Effect.Effect<LocalMoment>;
    /**
     * What cron runs at DIGEST_TIME: sends the day's digest, and after a failure waits
     * RETRY_DELAY and tries again, up to MAX_ATTEMPTS in all. Then it emails the error and
     * stops for the day. Never fails: every problem is logged. Returns "already-running",
     * doing nothing, while another run is working on the same day.
     */
    runWithRetries(date: string): Effect.Effect<RunOutcome>;
    /**
     * `make run`: builds a digest from the front page as it is now and sends it, even if
     * today's was already sent. It doesn't count as today's digest: nothing is marked sent or
     * seen, so the scheduled digest still goes out in full. Tried once; errors are returned.
     */
    readonly sendManually: Effect.Effect<{ readonly thread: string; readonly stories: number }, RunError>;
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

      /** Reads the front page and the selected threads. `skipSeen` drops stories already sent. */
      const collectSnapshot = Effect.fn("DigestJob.collectSnapshot")(function* (skipSeen: boolean) {
        const now = yield* Clock.currentTimeMillis;
        const frontPage = yield* hackerNews.getFrontPage(FRONT_PAGE_PARAMS);
        const seen = skipSeen
          ? yield* store.seenStoryIds(frontPage.stories.map((story) => story.id))
          : new Set<number>();
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
        return snapshot;
      });

      const fetchSnapshot = Effect.fn("DigestJob.fetchSnapshot")(function* (date: string) {
        const snapshot = yield* collectSnapshot(true);
        yield* store.saveSnapshot(date, snapshot);
        return snapshot;
      });

      /** One model call, no tools. Records the tokens it used under `date`. */
      const buildDigest = Effect.fn("DigestJob.buildDigest")(function* (date: string, snapshot: Snapshot) {
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
        return digest;
      });

      const analyze = Effect.fn("DigestJob.analyze")(function* (date: string, snapshot: Snapshot) {
        const digest = yield* buildDigest(date, snapshot);
        yield* store.saveDigest(date, digest);
        return digest;
      });

      const sendManually = Effect.fn("DigestJob.sendManually")(function* () {
        const at = yield* Clock.currentTimeMillis;
        const moment = localMoment(at, config.digestTimeZone);
        // Its own conversation, so replies get this email's stories as context.
        const thread = `${moment.date} manual ${String(moment.hour).padStart(2, "0")}:${String(moment.minute).padStart(2, "0")}`;

        const snapshot = yield* collectSnapshot(false);
        const digest = yield* buildDigest(moment.date, snapshot);
        // Not marked as seen: the scheduled digest can still include these stories.
        yield* store.saveDigest(thread, digest);
        const messageId = yield* mailer.newMessageId;
        yield* store.recordOutgoing(messageId, thread, "digest", at);
        yield* mailer.send(renderDigestEmail(digest), "digest", { messageId });
        yield* store.markSent(thread, messageId, yield* Clock.currentTimeMillis);
        return { thread, stories: digest.stories.length };
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
        yield* store.markSeen(date, digest.stories.map((story) => story.id));
        return "sent" as const;
      });

      const now = Effect.map(Clock.currentTimeMillis, (millis) =>
        localMoment(millis, config.digestTimeZone),
      );

      const handleFailure = Effect.fn("DigestJob.handleFailure")(function* (
        date: string,
        error: RunError,
      ) {
        yield* Effect.logError(`Digest ${date} failed: ${error.message}`);
        const attempts = yield* store.recordFailure(date, yield* Clock.currentTimeMillis, error.message);
        if (attempts < MAX_ATTEMPTS) {
          yield* Effect.logWarning(
            `Attempt ${attempts} of ${MAX_ATTEMPTS} failed. Trying again in ${Duration.format(RETRY_DELAY)}.`,
          );
          return "retry" as const;
        }

        yield* Effect.logError(`Giving up for today after ${attempts} attempts. Emailing the error.`);
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
        return "gave-up" as const;
      });

      const runWithRetries = (date: string): Effect.Effect<RunOutcome> =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const expiredBefore = startedAt - Duration.toMillis(RUN_CLAIM_EXPIRY);
          if (!(yield* store.claimRun(date, startedAt, expiredBefore))) return "already-running" as const;
          return yield* attemptUntilDone(date).pipe(Effect.ensuring(store.releaseRun(date, startedAt)));
        });

      const attemptUntilDone = (date: string): Effect.Effect<RunOutcome> =>
        Effect.gen(function* () {
          while (true) {
            const result = yield* run(date).pipe(
              Effect.map((outcome) => ({ outcome })),
              Effect.catch((error) => Effect.map(handleFailure(date, error), (next) => ({ next }))),
              // A defect counts as a failed attempt too, so it still retries and alerts.
              Effect.catchDefect((defect) =>
                Effect.logError("Digest attempt crashed", defect).pipe(
                  Effect.andThen(
                    handleFailure(
                      date,
                      new AnalysisError({ reason: `crashed: ${String(defect)}` }),
                    ),
                  ),
                  Effect.map((next) => ({ next })),
                ),
              ),
            );
            if ("outcome" in result) return result.outcome;
            if (result.next === "gave-up") return "gave-up" as const;
            yield* Effect.sleep(RETRY_DELAY);
          }
        });

      return DigestJob.of({ run, now, runWithRetries, sendManually: sendManually() });
    }),
  );
}
