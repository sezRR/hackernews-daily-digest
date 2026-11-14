#!/usr/bin/env node
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Effect, Layer, Logger, Runtime } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HackerNews } from "./HackerNews.js";
import { HackerNewsTools } from "./tools.js";

const INTERRUPTED_EXIT_CODE = 130;

const ServerLive = McpServer.layerStdio({
  name: "hackernews",
  version: "0.1.0",
  protocols: [
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2025_03_26,
    McpProtocol.v2024_11_05,
  ],
  registrations: HackerNewsTools.pipe(Layer.provide(HackerNews.layer)),
}).pipe(Layer.provide(NodeStdio.layer));

Layer.launch(ServerLive).pipe(
  // Reported here because runMain's own reporting would sit outside LogToStderr below.
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
  ),
  // stdout carries the MCP protocol, so every log line has to go to stderr.
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({
    disableErrorReporting: true,
    // A client ends a session by closing stdin, which arrives as an interruption. That is
    // a normal shutdown, not a crash.
    teardown: (exit, onExit) =>
      Runtime.defaultTeardown(exit, (code) => onExit(code === INTERRUPTED_EXIT_CODE ? 0 : code)),
  }),
);
