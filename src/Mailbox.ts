import { Context, Effect, Layer, Redacted, Schema, type Scope } from "effect";
import { ImapFlow } from "imapflow";
import { AppConfig } from "./AppConfig.js";
import { APP_HEADER } from "./Mailer.js";

/** At most this many new emails are looked at per poll, so a long outage catches up in steps. */
const BATCH_SIZE = 500;
/** A reply's text comes first in the message; this cuts off large attachments. */
const MAX_SOURCE_BYTES = 1_000_000;

const HEADER_FIELDS = [
  "from",
  "subject",
  "message-id",
  "in-reply-to",
  "references",
  "auto-submitted",
  "authentication-results",
  APP_HEADER.toLowerCase(),
];

export class MailboxError extends Schema.TaggedError<MailboxError>()("MailboxError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Reading the mailbox failed: ${this.reason}`;
  }
}

export interface RawMessage {
  readonly uid: number;
  readonly raw: Uint8Array;
}

export interface HeaderBlock extends RawMessage {
  /** Gmail keeps drafts in All Mail. A reply still being written must not be answered. */
  readonly draft: boolean;
}

/** One connection to one folder, opened read-only so nothing is ever marked as read. */
export interface MailboxSession {
  readonly path: string;
  readonly uidValidity: string;
  readonly uidNext: number;
  /** Selected headers of up to `BATCH_SIZE` emails with a UID above `lastUid`, oldest first. */
  headersAfter(lastUid: number): Effect.Effect<ReadonlyArray<HeaderBlock>, MailboxError>;
  sources(uids: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<RawMessage>, MailboxError>;
}

const toMailboxError = (cause: unknown) =>
  new MailboxError({ reason: cause instanceof Error ? cause.message : String(cause) });

export class Mailbox extends Context.Service<
  Mailbox,
  { readonly open: Effect.Effect<MailboxSession, MailboxError, Scope.Scope> }
>()("hackernews-mcp/Mailbox") {
  static readonly gmail = Layer.effect(
    Mailbox,
    Effect.map(AppConfig, (config) => {
      const connect = Effect.tryPromise({
        try: async () => {
          const client = new ImapFlow({
            host: "imap.gmail.com",
            port: 993,
            secure: true,
            auth: { user: config.gmailUser, pass: Redacted.value(config.gmailAppPassword) },
            logger: false,
          });
          // Without a listener, a dropped connection would crash the process.
          client.on("error", () => {});
          try {
            await client.connect();
            const path =
              config.imapMailbox ??
              (await client.list()).find((folder) => folder.specialUse === "\\All")?.path ??
              "INBOX";
            const lock = await client.getMailboxLock(path, { readOnly: true });
            return { client, lock, path };
          } catch (error) {
            client.close();
            throw error;
          }
        },
        catch: toMailboxError,
      });

      const open = Effect.acquireRelease(connect, ({ client, lock }) =>
        Effect.promise(async () => {
          lock.release();
          await client.logout().catch(() => client.close());
        }),
      ).pipe(
        Effect.flatMap(({ client, path }) =>
          Effect.gen(function* () {
            const mailbox = client.mailbox;
            if (mailbox === false) return yield* new MailboxError({ reason: `${path} isn't open` });

            const fetch = (range: string, query: Parameters<ImapFlow["fetchAll"]>[1]) =>
              Effect.tryPromise({
                try: () => client.fetchAll(range, { ...query, uid: true }, { uid: true }),
                catch: toMailboxError,
              });

            return {
              path,
              uidValidity: mailbox.uidValidity.toString(),
              uidNext: mailbox.uidNext,
              headersAfter: (lastUid) => {
                const last = Math.min(lastUid + BATCH_SIZE, mailbox.uidNext - 1);
                if (last <= lastUid) return Effect.succeed([]);
                return fetch(`${lastUid + 1}:${last}`, { headers: HEADER_FIELDS, flags: true }).pipe(
                  Effect.map((messages) =>
                    messages
                      .filter((message) => message.uid > lastUid && message.headers !== undefined)
                      .map((message) => ({
                        uid: message.uid,
                        raw: message.headers!,
                        draft: message.flags?.has("\\Draft") ?? false,
                      }))
                      .sort((a, b) => a.uid - b.uid),
                  ),
                );
              },
              sources: (uids) =>
                uids.length === 0
                  ? Effect.succeed([])
                  : fetch(uids.join(","), { source: { maxLength: MAX_SOURCE_BYTES } }).pipe(
                      Effect.map((messages) =>
                        messages.flatMap((message) =>
                          message.source ? [{ uid: message.uid, raw: message.source }] : [],
                        ),
                      ),
                    ),
            } satisfies MailboxSession;
          }),
        ),
      );

      return Mailbox.of({ open });
    }),
  );
}
