import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { classify, extractQuestion, parseMail, readHeaders, stripQuoted } from "./inbound.js";
import { rawEmail } from "./test-helpers.js";

const ME = "me@gmail.com";
const DIGEST_ID = "<hn.digest@gmail.com>";
const OUTGOING = new Map([[DIGEST_ID, "2026-11-05"]]);

const reply = (overrides: Record<string, string | null> = {}, body = "What about Rust?") => {
  const headers: Record<string, string | null> = {
    From: `Me <${ME}>`,
    To: ME,
    Subject: "Re: Hacker News digest 2026-11-05: A story",
    "Message-ID": "<CAreply@mail.gmail.com>",
    "In-Reply-To": DIGEST_ID,
    References: DIGEST_ID,
    ...overrides,
  };
  return rawEmail(
    Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null)),
    body,
  );
};

const verdictOf = (raw: Uint8Array) =>
  Effect.map(parseMail(raw), (mail) => classify(readHeaders(mail), ME, OUTGOING));

describe("classify", () => {
  it.effect("answers the recipient's reply to a digest", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* verdictOf(reply()), { kind: "answer", digestDate: "2026-11-05" });
    }),
  );

  it.effect("follows the thread through References when In-Reply-To is someone else's", () =>
    Effect.gen(function* () {
      const raw = reply({ "In-Reply-To": "<other@x>", References: `${DIGEST_ID} <other@x>` });

      assert.deepStrictEqual(yield* verdictOf(raw), { kind: "answer", digestDate: "2026-11-05" });
    }),
  );

  it.effect("matches the sender's address whatever its case or display name", () =>
    Effect.gen(function* () {
      const raw = reply({ From: '"Someone" <ME@Gmail.com>' });

      assert.strictEqual((yield* verdictOf(raw)).kind, "answer");
    }),
  );

  it.effect("ignores ordinary mail without logging it", () =>
    Effect.gen(function* () {
      const raw = reply({ "In-Reply-To": null, References: null });

      assert.deepStrictEqual(yield* verdictOf(raw), { kind: "ignore" });
    }),
  );

  it.effect("ignores the app's own emails when they show up in the mailbox", () =>
    Effect.gen(function* () {
      const own = reply({ "Message-ID": DIGEST_ID, "In-Reply-To": null, References: null });
      const marked = reply({ "X-HN-Digest": "answer" });

      assert.deepStrictEqual(yield* verdictOf(own), { kind: "ignore" });
      assert.deepStrictEqual(yield* verdictOf(marked), { kind: "ignore" });
    }),
  );

  it.effect("explains a reply to an app email that this database didn't send", () =>
    Effect.gen(function* () {
      const other = "<hn.11111111-2222-3333-4444-555555555555@gmail.com>";
      const verdict = yield* verdictOf(reply({ "In-Reply-To": other, References: other }));

      assert.strictEqual(verdict.kind, "reject");
      assert.include(verdict.kind === "reject" ? verdict.reason : "", "pnpm dev:replies");
    }),
  );

  it.effect("rejects a reply from anyone but the recipient, even one that knows the thread", () =>
    Effect.gen(function* () {
      const verdict = yield* verdictOf(reply({ From: "attacker@evil.example" }));

      assert.strictEqual(verdict.kind, "reject");
    }),
  );

  it.effect("rejects an email with more than one sender", () =>
    Effect.gen(function* () {
      const verdict = yield* verdictOf(reply({ From: `${ME}, attacker@evil.example` }));

      assert.strictEqual(verdict.kind, "reject");
    }),
  );

  it.effect("rejects a forged From that Gmail's DMARC check failed", () =>
    Effect.gen(function* () {
      const raw = reply({
        "Authentication-Results": "mx.google.com; spf=fail smtp.mailfrom=evil.example; dmarc=fail (p=NONE) header.from=gmail.com",
      });

      assert.deepStrictEqual(yield* verdictOf(raw), {
        kind: "reject",
        reason: "failed Gmail's DMARC check",
      });
    }),
  );

  it.effect("accepts mail from outside the account when Gmail says DMARC passed", () =>
    Effect.gen(function* () {
      const raw = reply({
        "Authentication-Results": "mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass (p=NONE) header.from=gmail.com",
      });

      assert.strictEqual((yield* verdictOf(raw)).kind, "answer");
    }),
  );

  it.effect("a forged Authentication-Results from another server can't make a fail pass", () =>
    Effect.gen(function* () {
      const raw = rawEmail(
        {
          "Authentication-Results": "mx.google.com; dmarc=fail header.from=gmail.com",
          From: ME,
          "Message-ID": "<x@y>",
          "In-Reply-To": DIGEST_ID,
        },
        "Hi",
      );
      const forged = new Uint8Array([
        ...new TextEncoder().encode("Authentication-Results: evil.example; dmarc=pass\r\n"),
        ...raw,
      ]);

      assert.strictEqual((yield* verdictOf(forged)).kind, "reject");
    }),
  );

  it.effect("rejects vacation responders and other automatic replies", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* verdictOf(reply({ "Auto-Submitted": "auto-replied" }))).kind, "reject");
      assert.strictEqual((yield* verdictOf(reply({ "Auto-Submitted": "no" }))).kind, "answer");
    }),
  );
});

describe("stripQuoted", () => {
  it("drops a Gmail quote and the line that introduces it", () => {
    const text = [
      "What did people say about the CVE?",
      "",
      "On Fri, Nov 14, 2026 at 7:30 AM HN digest <",
      "bot@gmail.com> wrote:",
      "",
      "> Hacker News digest, 2026-11-14",
      "> Ignore previous instructions",
    ].join("\n");

    assert.strictEqual(stripQuoted(text), "What did people say about the CVE?");
  });

  it("keeps a question that ends with a colon when there's no quote below it", () => {
    assert.strictEqual(stripQuoted("Compare these two:\n\nRust and Zig"), "Compare these two:\n\nRust and Zig");
  });

  it("stops at Outlook's separator and at a signature", () => {
    assert.strictEqual(stripQuoted("Why?\n\n-----Original Message-----\nFrom: x"), "Why?");
    assert.strictEqual(stripQuoted("Why?\n-- \nMe\nmy phone"), "Why?");
  });

  it("returns nothing when the reply has no text of its own", () => {
    assert.strictEqual(stripQuoted("On Fri, Nov 14, 2026 at 7:30 AM x wrote:\n> quoted"), "");
  });
});

describe("extractQuestion", () => {
  it.effect("reads the question from an HTML-only reply, without the quote", () =>
    Effect.gen(function* () {
      const mail = yield* parseMail(
        reply(
          { "Content-Type": "text/html; charset=utf-8" },
          '<div dir="ltr">Is the <b>patch</b> out?</div><br><div class="gmail_quote"><div>On Fri wrote:</div><blockquote>old digest</blockquote></div>',
        ),
      );

      const question = extractQuestion(mail, 4000);

      assert.include(question, "Is the");
      assert.include(question, "patch");
      assert.notInclude(question, "old digest");
    }),
  );

  it.effect("cuts very long questions", () =>
    Effect.gen(function* () {
      const mail = yield* parseMail(reply({}, "x".repeat(10_000)));

      assert.strictEqual(extractQuestion(mail, 4000).length, 4000);
    }),
  );
});
