import { Cause, Effect, Layer, Logger } from "effect";

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Local time with the date and UTC offset, e.g. "2026-11-14 07:30:02 +00:00". Cron logs
 * span days, so the time alone isn't enough. The zone comes from TZ, which compose.yaml sets
 * from DIGEST_TIMEZONE so log times match the digest schedule.
 */
export const timestamp = (date: Date): string => {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
};

const LEVELS: Record<string, string> = {
  Fatal: "FATAL",
  Error: "ERROR",
  Warn: "WARN ",
  Info: "INFO ",
  Debug: "DEBUG",
  Trace: "TRACE",
};

const messageText = (message: unknown): string =>
  (Array.isArray(message) ? message : [message])
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .join(" ");

/** One line per entry, greppable by level and job: `grep ERROR /var/log/hn-digest.log`. */
export const formatLine = (job: string, options: Logger.Options<unknown>): string => {
  const line = `${timestamp(options.date)} ${LEVELS[options.logLevel] ?? options.logLevel} [${job}] ${messageText(options.message)}`;
  return options.cause.reasons.length === 0 ? line : `${line}\n${Cause.pretty(options.cause)}`;
};

/** Replaces Effect's default logger, whose lines carry the time but not the date. */
export const LoggerLive = (job: string) =>
  Logger.layer([Logger.make((options) => console.log(formatLine(job, options)))]);

/**
 * For entry points: logs a failure through `LoggerLive` before the process exits non-zero,
 * so errors in startup (a bad setting, say) land in the same log as everything else.
 */
export const logFailure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("Stopped with an error", cause),
    ),
  );
