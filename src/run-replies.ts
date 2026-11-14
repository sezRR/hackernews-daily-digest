#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { replyServices } from "./AppLive.js";
import { LoggerLive, logFailure } from "./logging.js";
import { Replies } from "./Replies.js";

// Checks the mailbox every REPLY_POLL_SECONDS and answers replies to the digest by email.
Layer.launch(Replies.poller.pipe(Layer.provide(replyServices()))).pipe(
  logFailure,
  Effect.provide(LoggerLive("replies")),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
