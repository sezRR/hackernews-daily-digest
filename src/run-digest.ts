#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { AppConfig } from "./AppConfig.js";
import { digestServices } from "./AppLive.js";
import { DigestJob, type TickOutcome } from "./DigestJob.js";
import { LoggerLive, logFailure } from "./logging.js";
import { Store } from "./Store.js";

// Cron runs this every 30 minutes. It sends today's digest once DIGEST_TIME has passed in
// DIGEST_TIMEZONE, retries after a failure, and otherwise exits. Every run logs one line, so
// the log shows that cron is running even on days nothing goes wrong.
// With --now it runs today's digest regardless of the time, to check keys after deploying.
const now = process.argv.includes("--now");

const describe = (outcome: TickOutcome, time: string): string => {
  switch (outcome) {
    case "not-due":
      return `not due until ${time}`;
    case "done":
      return "already sent or given up today, nothing to do";
    case "waiting-to-retry":
      return "the last attempt failed recently, waiting before the next one";
    case "sent":
      return "sent";
    case "already-sent":
      return "already sent";
    case "gave-up":
      return "gave up for today after repeated failures";
    case "retry-later":
      return "failed, will retry on a later run";
    case "crashed":
      return "crashed, will retry on a later run";
  }
};

Effect.gen(function* () {
  const config = yield* AppConfig;
  const job = yield* DigestJob;
  const store = yield* Store;
  const date = yield* job.today;
  const time = `${String(config.digestTime.hour).padStart(2, "0")}:${String(config.digestTime.minute).padStart(2, "0")} ${config.digestTimeZone}`;

  const outcome = now ? yield* job.run(date) : yield* job.tick;
  const line = `Digest ${date}: ${describe(outcome, time)}`;
  if (outcome === "sent") {
    const usage = yield* store.usage(date, "digest");
    yield* Effect.logInfo(`${line} (${usage.inputTokens} input, ${usage.outputTokens} output tokens)`);
  } else if (outcome === "retry-later" || outcome === "crashed" || outcome === "gave-up") {
    yield* Effect.logWarning(line);
  } else {
    yield* Effect.logInfo(line);
  }
}).pipe(
  Effect.provide(digestServices()),
  logFailure,
  Effect.provide(LoggerLive("digest")),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
