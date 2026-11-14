import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { AppConfig } from "./AppConfig.js";
import { type Digest, DigestJson, type Snapshot, SnapshotJson } from "./Digest.js";

export type DigestStatus = "pending" | "ready" | "sent" | "failed";
export type ChatRole = "user" | "assistant";
export type UsageKind = "digest" | "chat";
/** Sent emails that a reply can thread onto. Failure alerts aren't recorded, so replies to them are ignored. */
export type OutgoingKind = "digest" | "answer";

export interface DigestRow {
  readonly date: string;
  readonly status: DigestStatus;
  readonly snapshot: Snapshot | null;
  readonly digest: Digest | null;
  readonly attempts: number;
  readonly lastAttemptAt: number | null;
  readonly lastError: string | null;
}

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  /** The part of `inputTokens` read from OpenAI's prompt cache. */
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

/** Cached input is billed at a tenth of the normal input price. */
const CACHED_INPUT_WEIGHT_DIVISOR = 10;

/** Where reading the mailbox stopped. A new UIDVALIDITY means old UIDs no longer apply. */
export interface ImapCursor {
  readonly uidValidity: string;
  readonly lastUid: number;
}

const Migrations = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_initial": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE digests (
          date TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          snapshot TEXT,
          digest TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_attempt_at INTEGER,
          last_error TEXT,
          email_id TEXT,
          sent_at INTEGER
        )
      `;
      yield* sql`
        CREATE TABLE digest_stories (
          story_id INTEGER PRIMARY KEY,
          digest_date TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          story_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `;
      yield* sql`CREATE INDEX chat_messages_story ON chat_messages (story_id, id)`;
      yield* sql`
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE token_usage (
          day TEXT NOT NULL,
          kind TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, kind)
        )
      `;
    }),
    // The web app is gone: chat now happens by email, threaded on Message-IDs.
    "0002_email_chat": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE sessions`;
      yield* sql`DROP TABLE chat_messages`;
      yield* sql`
        CREATE TABLE outgoing_messages (
          message_id TEXT PRIMARY KEY,
          digest_date TEXT NOT NULL,
          kind TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `;
      yield* sql`CREATE INDEX outgoing_messages_digest ON outgoing_messages (digest_date, kind)`;
      yield* sql`
        CREATE TABLE incoming_messages (
          message_id TEXT PRIMARY KEY,
          digest_date TEXT NOT NULL,
          received_at INTEGER NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE thread_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          digest_date TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `;
      yield* sql`CREATE INDEX thread_messages_digest ON thread_messages (digest_date, id)`;
      yield* sql`
        CREATE TABLE imap_cursor (
          mailbox TEXT PRIMARY KEY,
          uid_validity TEXT NOT NULL,
          last_uid INTEGER NOT NULL
        )
      `;
    }),
    "0003_cached_tokens": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE token_usage ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0`;
    }),
  }),
});

const decodeSnapshot = Schema.decodeUnknownEffect(SnapshotJson);
const encodeSnapshot = Schema.encodeEffect(SnapshotJson);
const decodeDigest = Schema.decodeUnknownEffect(DigestJson);
const encodeDigest = Schema.encodeEffect(DigestJson);

export class Store extends Context.Service<
  Store,
  {
    getDigestRow(date: string): Effect.Effect<DigestRow | null>;
    saveSnapshot(date: string, snapshot: Snapshot): Effect.Effect<void>;
    /** Saves the finished digest and marks its stories as seen, atomically. */
    saveDigest(date: string, digest: Digest): Effect.Effect<void>;
    /** `messageId` goes in the old `email_id` column, which held Resend's id before. */
    markSent(date: string, messageId: string, at: number): Effect.Effect<void>;
    recordFailure(date: string, at: number, error: string): Effect.Effect<number>;
    markFailed(date: string): Effect.Effect<void>;
    seenStoryIds(ids: ReadonlyArray<number>): Effect.Effect<ReadonlySet<number>>;
    digestMessageId(date: string): Effect.Effect<string | null>;
    recordOutgoing(
      messageId: string,
      digestDate: string,
      kind: OutgoingKind,
      at: number,
    ): Effect.Effect<void>;
    /** Which of these Message-IDs this app sent, mapped to the digest each belongs to. */
    findOutgoing(messageIds: ReadonlyArray<string>): Effect.Effect<ReadonlyMap<string, string>>;
    /** Records an incoming reply. False if it was already recorded, so it's never answered twice. */
    claimIncoming(messageId: string, digestDate: string, at: number): Effect.Effect<boolean>;
    threadMessages(digestDate: string, limit: number): Effect.Effect<ReadonlyArray<ChatMessage>>;
    addThreadMessage(
      digestDate: string,
      role: ChatRole,
      content: string,
      at: number,
    ): Effect.Effect<void>;
    imapCursor(mailbox: string): Effect.Effect<ImapCursor | null>;
    saveImapCursor(mailbox: string, cursor: ImapCursor): Effect.Effect<void>;
    addUsage(day: string, kind: UsageKind, usage: TokenUsage): Effect.Effect<void>;
    /**
     * Tokens spent that day, weighted by price: cached input counts as a tenth of a token,
     * so the budget tracks cost rather than raw size.
     */
    usageTotal(day: string, kind: UsageKind): Effect.Effect<number>;
    usage(day: string, kind: UsageKind): Effect.Effect<TokenUsage>;
  }
>()("hackernews-mcp/Store") {
  static readonly layerNoDeps = Layer.effect(
    Store,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const upsertRow = (date: string) =>
        sql`INSERT INTO digests (date, status) VALUES (${date}, 'pending') ON CONFLICT (date) DO NOTHING`;

      return Store.of({
        getDigestRow: (date) =>
          Effect.gen(function* () {
            const rows = yield* sql<{
              date: string;
              status: DigestStatus;
              snapshot: string | null;
              digest: string | null;
              attempts: number;
              last_attempt_at: number | null;
              last_error: string | null;
            }>`SELECT date, status, snapshot, digest, attempts, last_attempt_at, last_error
               FROM digests WHERE date = ${date}`;
            const row = rows[0];
            if (row === undefined) return null;
            return {
              date: row.date,
              status: row.status,
              snapshot: row.snapshot === null ? null : yield* decodeSnapshot(row.snapshot),
              digest: row.digest === null ? null : yield* decodeDigest(row.digest),
              attempts: row.attempts,
              lastAttemptAt: row.last_attempt_at,
              lastError: row.last_error,
            } satisfies DigestRow;
          }).pipe(Effect.orDie),

        saveSnapshot: (date, snapshot) =>
          Effect.gen(function* () {
            const encoded = yield* encodeSnapshot(snapshot);
            yield* upsertRow(date);
            yield* sql`UPDATE digests SET snapshot = ${encoded} WHERE date = ${date}`;
          }).pipe(Effect.orDie),

        saveDigest: (date, digest) =>
          Effect.gen(function* () {
            const encoded = yield* encodeDigest(digest);
            yield* upsertRow(date);
            yield* sql`UPDATE digests SET digest = ${encoded}, status = 'ready' WHERE date = ${date}`;
            for (const story of digest.stories) {
              yield* sql`
                INSERT INTO digest_stories (story_id, digest_date) VALUES (${story.id}, ${date})
                ON CONFLICT (story_id) DO NOTHING
              `;
            }
          }).pipe(sql.withTransaction, Effect.orDie),

        markSent: (date, messageId, at) =>
          sql`UPDATE digests SET status = 'sent', email_id = ${messageId}, sent_at = ${at}, last_error = NULL
              WHERE date = ${date}`.pipe(Effect.asVoid, Effect.orDie),

        recordFailure: (date, at, error) =>
          Effect.gen(function* () {
            yield* upsertRow(date);
            yield* sql`UPDATE digests SET attempts = attempts + 1, last_attempt_at = ${at}, last_error = ${error}
                       WHERE date = ${date}`;
            const rows = yield* sql<{ attempts: number }>`SELECT attempts FROM digests WHERE date = ${date}`;
            return rows[0]?.attempts ?? 0;
          }).pipe(Effect.orDie),

        markFailed: (date) =>
          sql`UPDATE digests SET status = 'failed' WHERE date = ${date}`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),

        seenStoryIds: (ids) =>
          ids.length === 0
            ? Effect.succeed(new Set<number>())
            : sql<{ story_id: number }>`
                SELECT story_id FROM digest_stories WHERE ${sql.in("story_id", ids)}
              `.pipe(
                Effect.map((rows) => new Set(rows.map((row) => row.story_id))),
                Effect.orDie,
              ),

        digestMessageId: (date) =>
          sql<{ message_id: string }>`
            SELECT message_id FROM outgoing_messages
            WHERE digest_date = ${date} AND kind = 'digest' ORDER BY created_at LIMIT 1
          `.pipe(
            Effect.map((rows) => rows[0]?.message_id ?? null),
            Effect.orDie,
          ),

        recordOutgoing: (messageId, digestDate, kind, at) =>
          sql`INSERT INTO outgoing_messages (message_id, digest_date, kind, created_at)
              VALUES (${messageId}, ${digestDate}, ${kind}, ${at})`.pipe(Effect.asVoid, Effect.orDie),

        findOutgoing: (messageIds) =>
          messageIds.length === 0
            ? Effect.succeed(new Map<string, string>())
            : sql<{ message_id: string; digest_date: string }>`
                SELECT message_id, digest_date FROM outgoing_messages
                WHERE ${sql.in("message_id", messageIds)}
              `.pipe(
                Effect.map((rows) => new Map(rows.map((row) => [row.message_id, row.digest_date]))),
                Effect.orDie,
              ),

        claimIncoming: (messageId, digestDate, at) =>
          sql<{ message_id: string }>`
            INSERT INTO incoming_messages (message_id, digest_date, received_at)
            VALUES (${messageId}, ${digestDate}, ${at})
            ON CONFLICT (message_id) DO NOTHING
            RETURNING message_id
          `.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.orDie,
          ),

        threadMessages: (digestDate, limit) =>
          sql<{ role: ChatRole; content: string }>`
            SELECT role, content FROM (
              SELECT * FROM thread_messages WHERE digest_date = ${digestDate}
              ORDER BY id DESC LIMIT ${limit}
            ) ORDER BY id ASC
          `.pipe(
            Effect.map((rows) => rows.map((row) => ({ role: row.role, content: row.content }))),
            Effect.orDie,
          ),

        addThreadMessage: (digestDate, role, content, at) =>
          sql`INSERT INTO thread_messages (digest_date, role, content, created_at)
              VALUES (${digestDate}, ${role}, ${content}, ${at})`.pipe(Effect.asVoid, Effect.orDie),

        imapCursor: (mailbox) =>
          sql<{ uid_validity: string; last_uid: number }>`
            SELECT uid_validity, last_uid FROM imap_cursor WHERE mailbox = ${mailbox}
          `.pipe(
            Effect.map((rows) => {
              const row = rows[0];
              return row === undefined
                ? null
                : { uidValidity: row.uid_validity, lastUid: row.last_uid };
            }),
            Effect.orDie,
          ),

        saveImapCursor: (mailbox, cursor) =>
          sql`
            INSERT INTO imap_cursor (mailbox, uid_validity, last_uid)
            VALUES (${mailbox}, ${cursor.uidValidity}, ${cursor.lastUid})
            ON CONFLICT (mailbox) DO UPDATE SET
              uid_validity = excluded.uid_validity,
              last_uid = excluded.last_uid
          `.pipe(Effect.asVoid, Effect.orDie),

        addUsage: (day, kind, { inputTokens, cachedInputTokens, outputTokens }) =>
          sql`
            INSERT INTO token_usage (day, kind, input_tokens, cached_input_tokens, output_tokens)
            VALUES (${day}, ${kind}, ${inputTokens}, ${Math.min(cachedInputTokens, inputTokens)}, ${outputTokens})
            ON CONFLICT (day, kind) DO UPDATE SET
              input_tokens = input_tokens + excluded.input_tokens,
              cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
              output_tokens = output_tokens + excluded.output_tokens
          `.pipe(Effect.asVoid, Effect.orDie),

        usageTotal: (day, kind) =>
          sql<{ total: number }>`
            SELECT input_tokens - cached_input_tokens + output_tokens
              + cached_input_tokens / ${CACHED_INPUT_WEIGHT_DIVISOR} AS total
            FROM token_usage WHERE day = ${day} AND kind = ${kind}
          `.pipe(
            Effect.map((rows) => rows[0]?.total ?? 0),
            Effect.orDie,
          ),

        usage: (day, kind) =>
          sql<{ input_tokens: number; cached_input_tokens: number; output_tokens: number }>`
            SELECT input_tokens, cached_input_tokens, output_tokens FROM token_usage
            WHERE day = ${day} AND kind = ${kind}
          `.pipe(
            Effect.map((rows) => ({
              inputTokens: rows[0]?.input_tokens ?? 0,
              cachedInputTokens: rows[0]?.cached_input_tokens ?? 0,
              outputTokens: rows[0]?.output_tokens ?? 0,
            })),
            Effect.orDie,
          ),
      });
    }),
  );

  /** An isolated, migrated database. Used by tests and anywhere the path is known up front. */
  static readonly layerAt = (filename: string) =>
    Store.layerNoDeps.pipe(
      Layer.provideMerge(Migrations),
      Layer.provideMerge(SqliteClient.layer({ filename })),
    );

  static readonly layer = Layer.unwrap(
    Effect.map(AppConfig, (config) => {
      // SQLite creates the file but not its folder, e.g. data/ on a fresh checkout.
      if (config.databasePath !== ":memory:") {
        mkdirSync(dirname(config.databasePath), { recursive: true });
      }
      return Store.layerAt(config.databasePath);
    }),
  );
}
