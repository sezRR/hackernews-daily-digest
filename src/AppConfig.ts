import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

export class InvalidConfig extends Schema.TaggedError<InvalidConfig>()("InvalidConfig", {
  setting: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Invalid ${this.setting}: ${this.reason}`;
  }
}

export interface DigestTime {
  readonly hour: number;
  readonly minute: number;
}

export interface AppSettings {
  readonly databasePath: string;
  readonly model: string;
  /** The Gmail account that sends the digest and whose mailbox is read for replies. */
  readonly gmailUser: string;
  readonly gmailAppPassword: Redacted.Redacted<string>;
  /** Display name on outgoing email. The address is always `gmailUser`. */
  readonly fromName: string;
  /** The only address that receives email, and the only one whose replies are answered. */
  readonly digestTo: string;
  readonly digestTime: DigestTime;
  readonly digestTimeZone: string;
  readonly maxStories: number;
  readonly minComments: number;
  readonly minAgeHours: number;
  /** Estimated input tokens per digest call. Lower-ranked comments are left out to fit. */
  readonly digestMaxInputTokens: number;
  /** Output tokens per digest call, reasoning included. */
  readonly digestMaxOutputTokens: number;
  /** Seconds between checks of the mailbox for replies. */
  readonly replyPollSeconds: number;
  /** IMAP folder to read replies from. Null means Gmail's All Mail, found by its special-use flag. */
  readonly imapMailbox: string | null;
  /** Tokens per UTC day that replies may spend before new questions are refused. */
  readonly chatDailyTokenLimit: number;
}

const parseDigestTime = (value: string) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match
    ? Effect.succeed<DigestTime>({ hour: Number(match[1]), minute: Number(match[2]) })
    : Effect.fail(new InvalidConfig({ setting: "DIGEST_TIME", reason: "expected HH:MM, 24-hour" }));
};

const checkTimeZone = (zone: string) =>
  Effect.try({
    try: () => {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return zone;
    },
    catch: () =>
      new InvalidConfig({ setting: "DIGEST_TIMEZONE", reason: `unknown time zone "${zone}"` }),
  });

const checkAddress = (setting: string, value: string) => {
  const address = value.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)
    ? Effect.succeed(address)
    : Effect.fail(new InvalidConfig({ setting, reason: "expected a plain email address" }));
};

const positive = (setting: string, value: number) =>
  value > 0
    ? Effect.succeed(value)
    : Effect.fail(new InvalidConfig({ setting, reason: "must be greater than 0" }));

/** Google shows app passwords in groups of four; the spaces aren't part of it. */
const normalizeAppPassword = (password: Redacted.Redacted<string>) => {
  const value = Redacted.value(password).replace(/\s+/g, "");
  return value.length === 16
    ? Effect.succeed(Redacted.make(value))
    : Effect.fail(
        new InvalidConfig({
          setting: "GMAIL_APP_PASSWORD",
          reason: "expected the 16-character app password from your Google account",
        }),
      );
};

export class AppConfig extends Context.Service<AppConfig, AppSettings>()(
  "hackernews-mcp/AppConfig",
) {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const gmailUser = yield* checkAddress("GMAIL_USER", yield* Config.String("GMAIL_USER"));
      const digestTo = yield* Config.option(Config.String("DIGEST_TO"));
      const imapMailbox = yield* Config.option(Config.String("IMAP_MAILBOX"));
      return AppConfig.of({
        databasePath: yield* Config.String("DATABASE_PATH").pipe(
          Config.withDefault("data/hackernews.db"),
        ),
        model: yield* Config.String("OPENAI_MODEL").pipe(Config.withDefault("gpt-6-luna")),
        gmailUser,
        gmailAppPassword: yield* normalizeAppPassword(
          yield* Config.Redacted("GMAIL_APP_PASSWORD"),
        ),
        fromName: yield* Config.String("DIGEST_FROM_NAME").pipe(Config.withDefault("HN digest")),
        digestTo: Option.isSome(digestTo)
          ? yield* checkAddress("DIGEST_TO", digestTo.value)
          : gmailUser,
        digestTime: yield* parseDigestTime(
          yield* Config.String("DIGEST_TIME").pipe(Config.withDefault("07:30")),
        ),
        digestTimeZone: yield* checkTimeZone(
          yield* Config.String("DIGEST_TIMEZONE").pipe(Config.withDefault("UTC")),
        ),
        maxStories: yield* Config.Int("DIGEST_MAX_STORIES").pipe(Config.withDefault(10)),
        minComments: yield* Config.Int("DIGEST_MIN_COMMENTS").pipe(Config.withDefault(10)),
        minAgeHours: yield* Config.Int("DIGEST_MIN_AGE_HOURS").pipe(Config.withDefault(3)),
        digestMaxInputTokens: yield* positive(
          "DIGEST_MAX_INPUT_TOKENS",
          yield* Config.Int("DIGEST_MAX_INPUT_TOKENS").pipe(Config.withDefault(40_000)),
        ),
        digestMaxOutputTokens: yield* positive(
          "DIGEST_MAX_OUTPUT_TOKENS",
          yield* Config.Int("DIGEST_MAX_OUTPUT_TOKENS").pipe(Config.withDefault(8_000)),
        ),
        replyPollSeconds: yield* Config.Int("REPLY_POLL_SECONDS").pipe(Config.withDefault(60)),
        imapMailbox: Option.isSome(imapMailbox) ? imapMailbox.value : null,
        chatDailyTokenLimit: yield* Config.Int("CHAT_DAILY_TOKEN_LIMIT").pipe(
          Config.withDefault(2_000_000),
        ),
      });
    }),
  );
}
