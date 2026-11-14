import { Effect, Layer, Redacted, Stream } from "effect";
import { AiError, LanguageModel, type Response as AiResponse } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AppConfig, type AppSettings } from "./AppConfig.js";
import type { RenderedEmail } from "./email.js";
import { HackerNews } from "./HackerNews.js";
import { type MailboxSession, Mailbox, MailboxError } from "./Mailbox.js";
import { MailError, Mailer, type MailKind, type Threading } from "./Mailer.js";

/** An item whose every request fails with HTTP 500. */
export const FAIL = Symbol("fail");
/** An item whose first request fails with HTTP 500, then returns `value`. */
export const failOnce = (value: unknown) => ({ failOnce: value });
/** An item whose request fails with HTTP 404. */
export const MISSING = Symbol("missing");

export interface FakeHn {
  /** Page HTML, or a status code to fail with. */
  readonly page?: string | number;
  readonly top?: ReadonlyArray<number> | typeof FAIL;
  readonly items?: Readonly<Record<number, unknown>>;
}

export const frontPageHtml = (ids: ReadonlyArray<number>): string => {
  const rows = ids.map((id) => `<tr class="athing submission" id="${id}"><td>story</td></tr>`);
  return `<html><table>${rows.join("")}</table></html>`;
};

/** Stands in for the network, recording requests and the peak number running at once. */
export const fakeHttp = (hn: FakeHn) => {
  const calls: Array<string> = [];
  const stats = { inFlight: 0, peak: 0 };
  const seenFailOnce = new Set<number>();

  const respond = (url: string): Response => {
    if (url === "https://news.ycombinator.com/") {
      const page = hn.page ?? "";
      return typeof page === "number" ? new Response("", { status: page }) : new Response(page);
    }
    if (url.endsWith("/topstories.json")) {
      return hn.top === FAIL
        ? new Response("", { status: 500 })
        : new Response(JSON.stringify(hn.top ?? []));
    }
    const id = Number(/\/item\/(\d+)\.json$/.exec(url)?.[1]);
    const item = hn.items?.[id] ?? null;
    if (item === FAIL) return new Response("", { status: 500 });
    if (item === MISSING) return new Response("", { status: 404 });
    if (typeof item === "object" && item !== null && "failOnce" in item) {
      if (!seenFailOnce.has(id)) {
        seenFailOnce.add(id);
        return new Response("", { status: 500 });
      }
      return new Response(JSON.stringify(item.failOnce));
    }
    return new Response(JSON.stringify(item));
  };

  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      calls.push(url.toString());
      stats.inFlight++;
      stats.peak = Math.max(stats.peak, stats.inFlight);
      yield* Effect.yieldNow;
      stats.inFlight--;
      return HttpClientResponse.fromWeb(request, respond(url.toString()));
    }),
  );

  return {
    calls,
    stats,
    /** The real `HackerNews` service running on this fake network. */
    layer: HackerNews.layerNoDeps.pipe(
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
  };
};

export const testSettings: AppSettings = {
  databasePath: ":memory:",
  model: "gpt-6-luna",
  gmailUser: "bot@gmail.com",
  gmailAppPassword: Redacted.make("abcdefghijklmnop"),
  fromName: "HN digest",
  digestTo: "me@gmail.com",
  digestTime: { hour: 8, minute: 0 },
  digestTimeZone: "UTC",
  maxStories: 10,
  minComments: 10,
  minAgeHours: 3,
  digestMaxInputTokens: 40_000,
  digestMaxOutputTokens: 8_000,
  replyPollSeconds: 60,
  imapMailbox: null,
  chatDailyTokenLimit: 100_000,
};

export const testConfig = (overrides: Partial<AppSettings> = {}) =>
  Layer.succeed(AppConfig, AppConfig.of({ ...testSettings, ...overrides }));

export const finishPart = (input = 100, output = 20, cached = 0) => ({
  type: "finish" as const,
  reason: "stop" as const,
  usage: {
    inputTokens: { total: input, ...(cached > 0 ? { cacheRead: cached } : {}) },
    outputTokens: { total: output },
  },
});

export type ModelStep = ReadonlyArray<AiResponse.StreamPartEncoded> | Error;
export type TextStep = ReadonlyArray<AiResponse.PartEncoded> | Error;

/**
 * A scripted model. `steps`, when given, holds one entry per text request. Otherwise
 * `generate` answers every text and structured-output request with JSON, or fails if it is
 * an Error. `stream` holds one entry per streaming request. Every request's options are kept.
 */
export const fakeModel = (script: {
  readonly generate?: unknown;
  readonly steps?: ReadonlyArray<TextStep>;
  readonly stream?: ReadonlyArray<ModelStep>;
}) => {
  const requests: Array<LanguageModel.ProviderOptions> = [];
  let streamIndex = 0;
  let stepIndex = 0;
  const modelError = (error: Error) =>
    AiError.make({
      module: "fake",
      method: "fake",
      reason: new AiError.UnknownError({ description: error.message }),
    });

  return {
    requests,
    layer: Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) => {
          requests.push(options);
          if (script.steps) {
            const step: TextStep = script.steps[stepIndex++] ?? [{ type: "text", text: "" }, finishPart()];
            return step instanceof Error ? Effect.fail(modelError(step)) : Effect.succeed([...step]);
          }
          return script.generate instanceof Error
            ? Effect.fail(modelError(script.generate))
            : Effect.succeed([
                { type: "text" as const, text: JSON.stringify(script.generate ?? {}) },
                finishPart(),
              ]);
        },
        streamText: (options) => {
          requests.push(options);
          const step: ModelStep = script.stream?.[streamIndex++] ?? [finishPart()];
          return step instanceof Error
            ? Stream.fail(modelError(step))
            : Stream.fromIterable(step);
        },
      }),
    ),
  };
};

export interface SentEmail {
  readonly email: RenderedEmail;
  readonly kind: MailKind;
  readonly threading: Threading;
}

/** Message-IDs come out as <id-1@test>, <id-2@test>, ... */
export const fakeMailer = (failures: ReadonlyArray<string> = []) => {
  const sent: Array<SentEmail> = [];
  const queue = [...failures];
  let nextId = 0;
  return {
    sent,
    layer: Layer.succeed(
      Mailer,
      Mailer.of({
        newMessageId: Effect.sync(() => `<id-${++nextId}@test>`),
        send: (email, kind, threading) => {
          const failure = queue.shift();
          if (failure !== undefined) return Effect.fail(new MailError({ reason: failure }));
          sent.push({ email, kind, threading });
          return Effect.void;
        },
      }),
    ),
  };
};

/** Builds a raw RFC 5322 email. Header values are used as given. */
export const rawEmail = (headers: Record<string, string>, body = ""): Uint8Array =>
  new TextEncoder().encode(
    `${Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n")}\r\n\r\n${body.replace(/\n/g, "\r\n")}`,
  );

export interface FakeFolder {
  path?: string;
  uidValidity?: string;
  /** Messages in the folder, by UID. */
  messages: Map<number, Uint8Array>;
  /** UIDs flagged as drafts. */
  drafts?: Set<number>;
  /** Set to make opening the folder fail. */
  failOpen?: string;
}

/** A mailbox in memory. Header fetches return the whole message, which the parser accepts. */
export const fakeMailbox = (folder: FakeFolder) => {
  const stats = { opened: 0, closed: 0, sourceFetches: [] as Array<ReadonlyArray<number>> };
  const session = (): MailboxSession => {
    const uids = [...folder.messages.keys()].sort((a, b) => a - b);
    return {
      path: folder.path ?? "[Gmail]/All Mail",
      uidValidity: folder.uidValidity ?? "1",
      uidNext: (uids.at(-1) ?? 0) + 1,
      headersAfter: (lastUid) =>
        Effect.succeed(
          uids
            .filter((uid) => uid > lastUid)
            .map((uid) => ({
              uid,
              raw: folder.messages.get(uid)!,
              draft: folder.drafts?.has(uid) ?? false,
            })),
        ),
      sources: (wanted) =>
        Effect.sync(() => {
          stats.sourceFetches.push(wanted);
          return wanted.flatMap((uid) => {
            const raw = folder.messages.get(uid);
            return raw ? [{ uid, raw }] : [];
          });
        }),
    };
  };
  return {
    stats,
    layer: Layer.succeed(
      Mailbox,
      Mailbox.of({
        open: Effect.acquireRelease(
          Effect.suspend(() => {
            if (folder.failOpen) return Effect.fail(new MailboxError({ reason: folder.failOpen }));
            stats.opened++;
            return Effect.succeed(session());
          }),
          () => Effect.sync(() => void stats.closed++),
        ),
      }),
    ),
  };
};
