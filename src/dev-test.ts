#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Clock, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { AppConfig } from "./AppConfig.js";
import { digestServices } from "./AppLive.js";
import { DigestJob } from "./DigestJob.js";
import { renderDigestEmail } from "./email.js";
import { LoggerLive, logFailure } from "./logging.js";
import { Mailer, SmtpTransport } from "./Mailer.js";
import { sampleDigest } from "./sample-digest.js";
import { Store } from "./Store.js";

// `pnpm dev:test` sends today's digest from this machine, right now, with the settings in
// .env. It always uses its own database, so it can't touch a production one, and it starts
// the day over each time, so every run sends. Subjects start with "[test]".
//
// `pnpm dev:test --sample` sends a fixed sample digest instead: no Hacker News requests and
// no model call, for checking the design and Gmail delivery for free.
//
// Reply to the email and run `pnpm dev:replies` to test answers against the same database.
const DEV_DATABASE_PATH = "data/dev.db";
process.env.DATABASE_PATH = DEV_DATABASE_PATH;

const sample = process.argv.includes("--sample");

const TestTransport = Layer.effect(
  SmtpTransport,
  Effect.map(SmtpTransport, (gmail) =>
    SmtpTransport.of({ send: (message) => gmail.send({ ...message, subject: `[test] ${message.subject}` }) }),
  ),
).pipe(Layer.provide(SmtpTransport.gmail));

/** Forgets today's digest, and which stories were sent, so the run behaves like a first one. */
const startDayOver = (date: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM digests WHERE date = ${date}`;
    yield* sql`DELETE FROM digest_stories`;
    // A new Message-ID each run: Gmail can drop a second email that reuses one.
    yield* sql`DELETE FROM outgoing_messages WHERE digest_date = ${date} AND kind = 'digest'`;
    yield* sql`DELETE FROM token_usage WHERE day = ${date} AND kind = 'digest'`;
  }).pipe(Effect.orDie);

const real = Effect.gen(function* () {
  const config = yield* AppConfig;
  const job = yield* DigestJob;
  const store = yield* Store;
  const date = (yield* job.now).date;

  yield* startDayOver(date);
  yield* Effect.logInfo(`Building today's digest (${date}) from the live front page. This calls ${config.model}.`);
  yield* job.run(date);
  const usage = yield* store.usage(date, "digest");
  yield* Effect.logInfo(
    `Sent "[test] ..." to ${config.digestTo} (${usage.inputTokens} input, ${usage.outputTokens} output tokens).`,
  );
}).pipe(Effect.provide(digestServices(TestTransport)));

const sampleRun = Effect.gen(function* () {
  const config = yield* AppConfig;
  const store = yield* Store;
  const mailer = yield* Mailer;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: config.digestTimeZone }).format(
    new Date(yield* Clock.currentTimeMillis),
  );
  const digest = sampleDigest(date);

  yield* startDayOver(date);
  yield* store.saveDigest(date, digest);
  const messageId = yield* mailer.newMessageId;
  yield* store.recordOutgoing(messageId, date, "digest", yield* Clock.currentTimeMillis);
  yield* mailer.send(renderDigestEmail(digest), "digest", { messageId });
  yield* store.markSent(date, messageId, yield* Clock.currentTimeMillis);
  yield* Effect.logInfo(`Sent the sample digest to ${config.digestTo}.`);
}).pipe(
  Effect.provide(
    Mailer.layerNoDeps.pipe(
      Layer.provideMerge(TestTransport),
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(AppConfig.layer),
    ),
  ),
);

(sample ? sampleRun : real).pipe(
  Effect.andThen(Effect.logInfo("Reply to it, then run `pnpm dev:replies` to get an answer.")),
  logFailure,
  Effect.provide(LoggerLive("dev-test")),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
