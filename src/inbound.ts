import { Effect, Schema } from "effect";
import { type ParsedMail, simpleParser } from "mailparser";
import { APP_HEADER, isAppMessageId } from "./Mailer.js";

/** What the reply reader needs from an email's headers. */
export interface InboundHeaders {
  readonly messageId: string | null;
  /** Lowercased, and only when the email names exactly one sender. */
  readonly from: string | null;
  readonly subject: string | undefined;
  /** In-Reply-To first, then References, newest last. */
  readonly inReplyTo: ReadonlyArray<string>;
  readonly references: ReadonlyArray<string>;
  readonly sentByApp: boolean;
  readonly autoSubmitted: boolean;
  /** Set when the mail came from outside the account and Gmail's DMARC check didn't pass. */
  readonly failedDmarc: boolean;
}

export type Verdict =
  | { readonly kind: "answer"; readonly digestDate: string }
  | { readonly kind: "ignore" }
  | { readonly kind: "reject"; readonly reason: string };

export class UnreadableMail extends Schema.TaggedError<UnreadableMail>()("UnreadableMail", {
  reason: Schema.String,
}) {
  override get message() {
    return `Couldn't parse an email: ${this.reason}`;
  }
}

export const parseMail = (raw: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      simpleParser(Buffer.from(raw), {
        skipImageLinks: true,
        skipTextLinks: true,
        skipTextToHtml: true,
      }),
    catch: (cause) =>
      new UnreadableMail({ reason: cause instanceof Error ? cause.message : String(cause) }),
  });

const messageIds = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
  const joined = typeof value === "string" ? value : (value ?? []).join(" ");
  return Array.from(joined.matchAll(/<[^<>\s]+>/g), (match) => match[0]);
};

const headerLines = (mail: ParsedMail, key: string): ReadonlyArray<string> =>
  mail.headerLines.filter((line) => line.key === key).map((line) => line.line);

/**
 * Gmail adds `Authentication-Results: mx.google.com; ... dmarc=pass` to mail it receives from
 * outside. A header from anyone else proves nothing, so only Gmail's own are read, and only
 * a fail can count: a forged "pass" changes nothing.
 */
const dmarcFailed = (mail: ParsedMail): boolean => {
  const gmail = headerLines(mail, "authentication-results").filter((line) =>
    /^authentication-results:\s*mx\.google\.com\s*;/i.test(line),
  );
  return gmail.length > 0 && !gmail.some((line) => /\bdmarc=pass\b/i.test(line));
};

export const readHeaders = (mail: ParsedMail): InboundHeaders => {
  const senders = mail.from?.value ?? [];
  const autoSubmitted = headerLines(mail, "auto-submitted").some(
    (line) => !/^auto-submitted:\s*no\s*$/i.test(line),
  );
  return {
    messageId: messageIds(mail.messageId)[0] ?? null,
    from: senders.length === 1 ? (senders[0]?.address?.trim().toLowerCase() ?? null) : null,
    subject: mail.subject,
    inReplyTo: messageIds(mail.inReplyTo),
    references: messageIds(mail.references),
    sentByApp: headerLines(mail, APP_HEADER.toLowerCase()).length > 0,
    autoSubmitted,
    failedDmarc: dmarcFailed(mail),
  };
};

/** Every Message-ID an email mentions, to look up in one query. */
export const mentionedIds = (headers: InboundHeaders): ReadonlyArray<string> => [
  ...(headers.messageId ? [headers.messageId] : []),
  ...headers.inReplyTo,
  ...headers.references,
];

/**
 * Decides whether an email is a question to answer. The bar is: sent by the digest
 * recipient, and replying to a Message-ID this app generated. Those ids are random and only
 * ever sent to the recipient, so knowing one is the proof of being in the conversation.
 * Ordinary mail is ignored silently; mail that looks like a reply but fails a check is
 * rejected, and the reason is logged.
 */
export const classify = (
  headers: InboundHeaders,
  recipient: string,
  outgoing: ReadonlyMap<string, string>,
): Verdict => {
  if (headers.messageId === null) return { kind: "ignore" };
  if (headers.sentByApp || outgoing.has(headers.messageId)) return { kind: "ignore" };

  const thread = [...headers.inReplyTo, ...headers.references.toReversed()].find((id) =>
    outgoing.has(id),
  );
  if (thread === undefined) {
    // Looks like a reply to this app, but this database never sent that email. Usually a
    // reply to a `pnpm dev:test` email reaching the server's reader, or the other way round.
    return [...headers.inReplyTo, ...headers.references].some(isAppMessageId) &&
      headers.from === recipient
      ? {
          kind: "reject",
          reason:
            "it replies to a digest this database didn't send. Replies to `pnpm dev:test` emails are answered by `pnpm dev:replies`, not the server",
        }
      : { kind: "ignore" };
  }
  if (headers.from !== recipient) {
    return { kind: "reject", reason: `from ${headers.from ?? "no single sender"}, not the recipient` };
  }
  if (headers.autoSubmitted) return { kind: "reject", reason: "automatic reply" };
  if (headers.failedDmarc) return { kind: "reject", reason: "failed Gmail's DMARC check" };
  return { kind: "answer", digestDate: outgoing.get(thread) ?? "" };
};

const QUOTE_SEPARATOR = /^\s*(?:-{2,}\s*Original Message\s*-{2,}|_{10,}|-{2,} ?Forwarded message -{2,})\s*$/i;

/**
 * The reader's own words from a reply: everything above the quoted email, minus the
 * "On <date>, <someone> wrote:" line that clients put above a quote.
 */
export const stripQuoted = (text: string): string => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const quoteAt = lines.findIndex((line) => /^\s*>/.test(line) || QUOTE_SEPARATOR.test(line));
  const own = quoteAt === -1 ? lines : lines.slice(0, quoteAt);
  // "-- " starts a signature by convention.
  const signatureAt = own.findIndex((line) => line === "-- ");
  const body = signatureAt === -1 ? own : own.slice(0, signatureAt);

  while (body.length > 0 && body.at(-1)?.trim() === "") body.pop();
  if (quoteAt !== -1) {
    const lastBlank = body.findLastIndex((line) => line.trim() === "");
    const lastParagraph = body.slice(lastBlank + 1).join(" ").trim();
    if (lastParagraph.endsWith(":") && /\d/.test(lastParagraph) && body.length - lastBlank <= 4) {
      body.splice(lastBlank + 1);
    }
  }
  return body.join("\n").trim();
};

export const extractQuestion = (mail: ParsedMail, maxLength: number): string => {
  const text =
    mail.text ??
    (typeof mail.html === "string"
      ? mail.html
          .replace(/<div class="gmail_quote[\s\S]*$/i, "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<[^>]+>/g, "")
      : "");
  return stripQuoted(text).slice(0, maxLength).toWellFormed();
};
