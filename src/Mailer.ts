import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import nodemailer from "nodemailer";
import { AppConfig } from "./AppConfig.js";
import type { RenderedEmail } from "./email.js";

const SMTP_TIMEOUT_MS = 30_000;

/** Marks every email this app sends, so the reply reader never answers its own mail. */
export const APP_HEADER = "X-HN-Digest";

/** The shape of every Message-ID `newMessageId` makes, whichever database recorded it. */
export const isAppMessageId = (id: string): boolean => /^<hn\.[0-9a-f-]{36}@[^<>\s]+>$/.test(id);

export class MailError extends Schema.TaggedError<MailError>()("MailError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Sending email failed: ${this.reason}`;
  }
}

export type MailKind = "digest" | "answer" | "alert";

export interface Threading {
  readonly messageId: string;
  /** Message-ID of the email being answered. */
  readonly inReplyTo?: string;
  readonly references?: ReadonlyArray<string>;
}

/** What goes to the SMTP server. Kept as plain data so tests can check it without a server. */
export interface OutgoingMessage {
  readonly from: { readonly name: string; readonly address: string };
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: ReadonlyArray<string>;
  readonly headers: Readonly<Record<string, string>>;
}

/** The SMTP connection, separate from `Mailer` so tests can replace it. */
export class SmtpTransport extends Context.Service<
  SmtpTransport,
  { send(message: OutgoingMessage): Promise<unknown> }
>()("hackernews-mcp/SmtpTransport") {
  static readonly gmail = Layer.effect(
    SmtpTransport,
    Effect.map(AppConfig, (config) => {
      const transport = nodemailer.createTransport({
        host: "smtp.gmail.com",
        // 587 with STARTTLS rather than 465: some hosts, Hetzner Cloud among them, block
        // outgoing 465 and 25 by default. requireTLS refuses to continue unencrypted.
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: config.gmailUser, pass: Redacted.value(config.gmailAppPassword) },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      });
      return SmtpTransport.of({
        send: (message) =>
          transport.sendMail({
            ...message,
            references: message.references ? [...message.references] : undefined,
          }),
      });
    }),
  );
}

export class Mailer extends Context.Service<
  Mailer,
  {
    /** A fresh, unguessable Message-ID. Replies are only answered when they cite one of these. */
    readonly newMessageId: Effect.Effect<string>;
    /**
     * Sends to the configured recipient. There is deliberately no recipient parameter, so
     * nothing derived from Hacker News content or a reply can choose where email goes.
     */
    send(email: RenderedEmail, kind: MailKind, threading: Threading): Effect.Effect<void, MailError>;
  }
>()("hackernews-mcp/Mailer") {
  static readonly layerNoDeps = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const transport = yield* SmtpTransport;
      const domain = config.gmailUser.split("@")[1] ?? "localhost";

      return Mailer.of({
        newMessageId: Effect.sync(() => `<hn.${randomUUID()}@${domain}>`),
        send: (email, kind, threading) =>
          Effect.tryPromise({
            try: () =>
              transport.send({
                from: { name: config.fromName, address: config.gmailUser },
                to: config.digestTo,
                subject: email.subject,
                text: email.text,
                html: email.html,
                messageId: threading.messageId,
                ...(threading.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
                ...(threading.references ? { references: threading.references } : {}),
                headers: {
                  [APP_HEADER]: kind,
                  // RFC 3834: tells vacation responders not to answer, so mail can't loop.
                  "Auto-Submitted": kind === "answer" ? "auto-replied" : "auto-generated",
                },
              }),
            catch: (cause) =>
              new MailError({ reason: cause instanceof Error ? cause.message : String(cause) }),
          }).pipe(Effect.asVoid),
      });
    }),
  );

  static readonly layer = Mailer.layerNoDeps.pipe(Layer.provide(SmtpTransport.gmail));
}
