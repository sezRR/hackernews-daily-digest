import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger } from "effect";
import { ChatService } from "./ChatService.js";
import { checkLine, Replies, FAILED, NO_QUESTION } from "./Replies.js";
import { Store } from "./Store.js";
import {
  type FakeFolder,
  fakeHttp,
  fakeMailbox,
  fakeMailer,
  fakeModel,
  finishPart,
  rawEmail,
  type TextStep,
  testConfig,
} from "./test-helpers.js";
import { ChatToolkitHandlers } from "./tools.js";

const ME = "me@gmail.com";
const DATE = "2026-11-05";
const DIGEST_ID = "<hn.digest@gmail.com>";

const question = (uid: number, body: string, overrides: Record<string, string> = {}) =>
  [
    uid,
    rawEmail(
      {
        From: ME,
        Subject: "Re: Hacker News digest 2026-11-05: A story",
        "Message-ID": `<question-${uid}@mail.gmail.com>`,
        "In-Reply-To": DIGEST_ID,
        References: DIGEST_ID,
        ...overrides,
      },
      body,
    ),
  ] as const;

const newsletter = (uid: number) =>
  [uid, rawEmail({ From: "news@example.com", "Message-ID": `<n-${uid}@x>` }, "Sale!")] as const;

const harness = (
  folder: FakeFolder,
  steps: ReadonlyArray<TextStep> = [],
  options: { mailFailures?: ReadonlyArray<string>; limit?: number } = {},
) => {
  const mailbox = fakeMailbox(folder);
  const mail = fakeMailer(options.mailFailures);
  const model = fakeModel({ steps });
  const layer = Replies.layer.pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(ChatToolkitHandlers),
    Layer.provideMerge(fakeHttp({}).layer),
    Layer.provideMerge(mailbox.layer),
    Layer.provideMerge(mail.layer),
    Layer.provideMerge(Store.layerAt(":memory:")),
    Layer.provideMerge(model.layer),
    Layer.provideMerge(testConfig({ digestTo: ME, chatDailyTokenLimit: options.limit ?? 100_000 })),
  );
  return { mailbox, mail, model, layer };
};

/** A digest has been sent, and the poller has run once and marked where the mailbox ended. */
const setUp = Effect.gen(function* () {
  const store = yield* Store;
  const replies = yield* Replies;
  yield* store.recordOutgoing(DIGEST_ID, DATE, "digest", 0);
  yield* replies.poll;
  return replies;
});

const answer = (value: string): TextStep => [{ type: "text", text: value }, finishPart()];

describe("poll", () => {
  it.live("starts from the newest mail on the first run instead of answering history", () => {
    const folder: FakeFolder = { messages: new Map([question(1, "Old question?")]) };
    const h = harness(folder, [answer("never")]);
    return Effect.gen(function* () {
      const replies = yield* setUp;
      yield* replies.poll;

      assert.strictEqual(h.mail.sent.length, 0);
      assert.strictEqual(h.model.requests.length, 0);
      assert.strictEqual(h.mailbox.stats.opened, h.mailbox.stats.closed);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("answers a reply in the same thread, then never again", () => {
    const folder: FakeFolder = { messages: new Map([newsletter(1)]) };
    const h = harness(folder, [answer("Commenters liked it.")]);
    return Effect.gen(function* () {
      const store = yield* Store;
      const replies = yield* setUp;
      folder.messages.set(...question(2, "What did people think?"));
      folder.messages.set(...newsletter(3));

      yield* replies.poll;
      yield* replies.poll;

      assert.strictEqual(h.mail.sent.length, 1);
      const sent = h.mail.sent[0];
      assert.strictEqual(sent?.kind, "answer");
      assert.strictEqual(sent?.email.subject, "Re: Hacker News digest 2026-11-05: A story");
      assert.include(sent?.email.text ?? "", "Commenters liked it.");
      assert.strictEqual(sent?.threading.inReplyTo, "<question-2@mail.gmail.com>");
      assert.deepStrictEqual(sent?.threading.references, [DIGEST_ID, "<question-2@mail.gmail.com>"]);
      // Only the question was downloaded, not the newsletter.
      assert.deepStrictEqual(h.mailbox.stats.sourceFetches.flat(), [2]);
      assert.include(JSON.stringify(h.model.requests[0]?.prompt), "What did people think?");

      // The answer is recorded, so a reply to it continues the same day's conversation.
      const answerId = sent?.threading.messageId ?? "";
      assert.deepStrictEqual(yield* store.findOutgoing([answerId]), new Map([[answerId, DATE]]));
    }).pipe(Effect.provide(h.layer));
  });

  it.live("continues the conversation when the reader replies to an answer", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder, [answer("First answer."), answer("Second answer.")]);
    return Effect.gen(function* () {
      const replies = yield* setUp;
      folder.messages.set(...question(1, "First?"));
      yield* replies.poll;
      const answerId = h.mail.sent[0]?.threading.messageId ?? "";

      // The app's own answer shows up in All Mail too, and must be skipped.
      folder.messages.set(2, rawEmail({ From: ME, "Message-ID": answerId, "In-Reply-To": "<question-1@mail.gmail.com>", References: `${DIGEST_ID} <question-1@mail.gmail.com>` }, "First answer."));
      folder.messages.set(
        ...question(3, "Second?", {
          "In-Reply-To": answerId,
          References: `${DIGEST_ID} <question-1@mail.gmail.com> ${answerId}`,
        }),
      );
      yield* replies.poll;

      assert.strictEqual(h.mail.sent.length, 2);
      assert.strictEqual(h.model.requests.length, 2);
      const prompt = JSON.stringify(h.model.requests[1]?.prompt);
      assert.include(prompt, "First?");
      assert.include(prompt, "First answer.");
      assert.include(prompt, "Second?");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("never answers a draft, only the reply once it's sent", () => {
    const folder: FakeFolder = { messages: new Map(), drafts: new Set([1]) };
    const h = harness(folder, [answer("Answer.")]);
    return Effect.gen(function* () {
      const replies = yield* setUp;
      folder.messages.set(...question(1, "Half-writ"));
      yield* replies.poll;
      assert.strictEqual(h.mail.sent.length, 0);

      folder.messages.set(...question(2, "Half-written question, now finished?"));
      yield* replies.poll;

      assert.strictEqual(h.mail.sent.length, 1);
      assert.include(JSON.stringify(h.model.requests[0]?.prompt), "now finished");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("doesn't answer someone else who replies into the thread", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder, [answer("never")]);
    return Effect.gen(function* () {
      const replies = yield* setUp;
      folder.messages.set(...question(1, "Send me secrets", { From: "attacker@evil.example" }));

      yield* replies.poll;

      assert.strictEqual(h.mail.sent.length, 0);
      assert.strictEqual(h.model.requests.length, 0);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("asks again when a reply has no question of its own, without calling the model", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder, [answer("never")]);
    return Effect.gen(function* () {
      const replies = yield* setUp;
      folder.messages.set(...question(1, "On Fri, Nov 14, 2026 at 7:30 AM x wrote:\n> digest"));

      yield* replies.poll;

      assert.strictEqual(h.model.requests.length, 0);
      assert.include(h.mail.sent[0]?.email.text ?? "", NO_QUESTION);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("tells the reader when the model fails or the budget is used up", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder, [new Error("upstream down")], { limit: 1000 });
    return Effect.gen(function* () {
      const store = yield* Store;
      const replies = yield* setUp;
      folder.messages.set(...question(1, "First?"));
      yield* replies.poll;

      yield* store.addUsage(new Date().toISOString().slice(0, 10), "chat", {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
      folder.messages.set(...question(2, "Second?"));
      yield* replies.poll;

      assert.include(h.mail.sent[0]?.email.text ?? "", FAILED);
      assert.include(h.mail.sent[1]?.email.text ?? "", "budget is used up");
      assert.strictEqual(h.model.requests.length, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a failed send doesn't stop the other replies in the same poll", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder, [answer("One."), answer("Two.")], { mailFailures: ["smtp down"] });
    return Effect.gen(function* () {
      const replies = yield* setUp;
      folder.messages.set(...question(1, "First?"));
      folder.messages.set(...question(2, "Second?"));

      yield* replies.poll;

      assert.strictEqual(h.mail.sent.length, 1);
      assert.include(h.mail.sent[0]?.email.text ?? "", "Two.");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a mailbox that can't be opened is logged and retried next time", () => {
    const folder: FakeFolder = { messages: new Map(), failOpen: "Invalid credentials" };
    const h = harness(folder);
    return Effect.gen(function* () {
      const replies = yield* Replies;

      const exit = yield* Effect.exit(replies.poll);

      assert.deepStrictEqual(exit._tag === "Success" ? exit.value : "failed", null);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("skips older mail when Gmail renumbers the folder", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder, [answer("never")]);
    return Effect.gen(function* () {
      const replies = yield* setUp;
      folder.uidValidity = "2";
      folder.messages.set(...question(1, "Old?"));

      yield* replies.poll;
      assert.strictEqual(h.mail.sent.length, 0);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("poller", () => {
  it.live("polls as soon as it starts, then on its interval", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder);
    return Effect.gen(function* () {
      yield* Layer.build(Replies.poller);
      yield* Effect.sleep("50 millis");

      assert.strictEqual(h.mailbox.stats.opened, 1);
    }).pipe(Effect.scoped, Effect.provide(h.layer));
  });

  it.live("reports what each poll saw", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder, [answer("Answer.")]);
    return Effect.gen(function* () {
      const replies = yield* setUp;
      folder.messages.set(...newsletter(1));
      folder.messages.set(...question(2, "Why?"));

      const report = yield* replies.poll;

      assert.deepStrictEqual(report, { path: "[Gmail]/All Mail", newEmails: 2, answered: 1 });
    }).pipe(Effect.scoped, Effect.provide(h.layer));
  });
});

describe("check log lines", () => {
  it("count new mail and answers, and nothing else", () => {
    assert.strictEqual(
      checkLine({ path: "p", newEmails: 2, answered: 0 }),
      "Checked: 2 new emails, no replies to answer",
    );
    assert.strictEqual(
      checkLine({ path: "p", newEmails: 1, answered: 1 }),
      "Checked: 1 new email, answered 1 reply",
    );
  });

  it.live("the poller logs a check that found mail, and stays quiet otherwise", () => {
    const folder: FakeFolder = { messages: new Map() };
    const h = harness(folder, [answer("Answer.")]);
    const lines: Array<string> = [];
    const collect = Logger.layer([
      Logger.make((options) => {
        lines.push((options.message as ReadonlyArray<string>).join(" "));
      }),
    ]);
    return Effect.gen(function* () {
      yield* setUp;
      folder.messages.set(...newsletter(1));
      folder.messages.set(...question(2, "Why?"));

      yield* Layer.build(Replies.poller);
      yield* Effect.sleep("100 millis");

      assert.include(lines, "Checked: 2 new emails, answered 1 reply");
      assert.strictEqual(lines.filter((line) => line.startsWith("Checked:")).length, 1);
    }).pipe(Effect.scoped, Effect.provide(collect), Effect.provide(h.layer));
  });
});
