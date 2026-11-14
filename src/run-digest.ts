#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Duration, Effect } from "effect";
import { AppConfig } from "./AppConfig.js";
import { digestServices } from "./AppLive.js";
import { DigestJob, isOnTime, MAX_ATTEMPTS, minutesFrom, RETRY_DELAY } from "./DigestJob.js";
import { LoggerLive, logFailure } from "./logging.js";
import { Store } from "./Store.js";

// Sends today's digest now. Cron starts it at DIGEST_TIME in DIGEST_TIMEZONE (see
// `make cron-set`) with --scheduled. After a failure it waits and tries again in the same
// run, then emails the error if every attempt fails. Already sent today: it does nothing.
//
// With --manual (`make run`) it always sends a digest of the front page as it is now, and
// leaves today's scheduled digest alone: nothing is marked sent or seen. Tried once.
const scheduled = process.argv.includes("--scheduled");
const manual = process.argv.includes("--manual");

const pad = (value: number) => String(value).padStart(2, "0");

Effect.gen(function* () {
  const config = yield* AppConfig;
  const job = yield* DigestJob;
  const store = yield* Store;
  const now = yield* job.now;
  const at = `${pad(now.hour)}:${pad(now.minute)} ${config.digestTimeZone}`;
  const expected = `${pad(config.digestTime.hour)}:${pad(config.digestTime.minute)}`;

  if (manual) {
    yield* Effect.logInfo(
      `Manual digest: sending now (${at}). Today's ${expected} digest isn't affected and still goes out.`,
    );
    const before = yield* store.usage(now.date, "digest");
    const result = yield* job.sendManually;
    const after = yield* store.usage(now.date, "digest");
    yield* Effect.logInfo(
      `Manual digest: sent ${result.stories} stories (${after.inputTokens - before.inputTokens} input, ${after.outputTokens - before.outputTokens} output tokens). Replies to it are answered.`,
    );
    return;
  }

  yield* Effect.logInfo(
    `Digest ${now.date}: starting at ${at}${scheduled ? " (cron)" : ""}. Up to ${MAX_ATTEMPTS} attempts, ${Duration.format(RETRY_DELAY)} apart.`,
  );
  if (scheduled && !isOnTime(now, config.digestTime)) {
    const off = minutesFrom(now, config.digestTime);
    yield* Effect.logWarning(
      `Cron started this ${Math.abs(off)} minutes ${off > 0 ? "after" : "before"} DIGEST_TIME (${expected}). ` +
        "Cron is probably using another time zone: run `make cron-set` again and read what it says.",
    );
  }

  const outcome = yield* job.runWithRetries(now.date);
  if (outcome === "sent") {
    const usage = yield* store.usage(now.date, "digest");
    yield* Effect.logInfo(
      `Digest ${now.date}: sent (${usage.inputTokens} input, ${usage.outputTokens} output tokens)`,
    );
  } else if (outcome === "already-sent") {
    yield* Effect.logInfo(`Digest ${now.date}: already sent today, nothing to do`);
  } else {
    yield* Effect.logError(`Digest ${now.date}: gave up after ${MAX_ATTEMPTS} attempts`);
  }
}).pipe(
  Effect.provide(digestServices()),
  logFailure,
  Effect.provide(LoggerLive("digest")),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
