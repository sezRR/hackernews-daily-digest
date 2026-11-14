import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Mailer, type OutgoingMessage, SmtpTransport } from "./Mailer.js";
import { testConfig } from "./test-helpers.js";

const EMAIL = { subject: "Subject", html: "<p>Hi</p>", text: "Hi" };

const harness = (failWith?: Error) => {
  const messages: Array<OutgoingMessage> = [];
  const transport = Layer.succeed(
    SmtpTransport,
    SmtpTransport.of({
      send: (message) => {
        messages.push(message);
        return failWith ? Promise.reject(failWith) : Promise.resolve({});
      },
    }),
  );
  return {
    messages,
    layer: Mailer.layerNoDeps.pipe(Layer.provide(transport), Layer.provide(testConfig())),
  };
};

it.effect("sends from the Gmail account to the configured recipient only", () => {
  const h = harness();
  return Effect.gen(function* () {
    const mailer = yield* Mailer;

    yield* mailer.send(EMAIL, "digest", { messageId: "<a@gmail.com>" });

    assert.deepStrictEqual(h.messages[0], {
      from: { name: "HN digest", address: "bot@gmail.com" },
      to: "me@gmail.com",
      subject: "Subject",
      text: "Hi",
      html: "<p>Hi</p>",
      messageId: "<a@gmail.com>",
      headers: { "X-HN-Digest": "digest", "Auto-Submitted": "auto-generated" },
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect("threads an answer onto the email it replies to", () => {
  const h = harness();
  return Effect.gen(function* () {
    const mailer = yield* Mailer;

    yield* mailer.send(EMAIL, "answer", {
      messageId: "<answer@gmail.com>",
      inReplyTo: "<question@gmail.com>",
      references: ["<digest@gmail.com>", "<question@gmail.com>"],
    });

    const message = h.messages[0];
    assert.strictEqual(message?.inReplyTo, "<question@gmail.com>");
    assert.deepStrictEqual(message?.references, ["<digest@gmail.com>", "<question@gmail.com>"]);
    assert.strictEqual(message?.headers["Auto-Submitted"], "auto-replied");
  }).pipe(Effect.provide(h.layer));
});

it.effect("makes unguessable Message-IDs on the sender's domain", () => {
  const h = harness();
  return Effect.gen(function* () {
    const mailer = yield* Mailer;

    const first = yield* mailer.newMessageId;
    const second = yield* mailer.newMessageId;

    assert.match(first, /^<hn\.[0-9a-f-]{36}@gmail\.com>$/);
    assert.notStrictEqual(first, second);
  }).pipe(Effect.provide(h.layer));
});

it.effect("turns an SMTP failure into a MailError", () => {
  const h = harness(new Error("535 Username and Password not accepted"));
  return Effect.gen(function* () {
    const mailer = yield* Mailer;

    const error = yield* mailer.send(EMAIL, "digest", { messageId: "<a@b>" }).pipe(Effect.flip);

    assert.strictEqual(error._tag, "MailError");
    assert.include(error.message, "535");
  }).pipe(Effect.provide(h.layer));
});
