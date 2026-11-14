import { Clock, Context, Duration, Effect, Layer, Ref, Schedule } from "effect";
import { AppConfig } from "./AppConfig.js";
import { ChatService, MAX_QUESTION_LENGTH } from "./ChatService.js";
import { renderAnswerEmail } from "./email.js";
import {
  classify,
  extractQuestion,
  type InboundHeaders,
  mentionedIds,
  parseMail,
  readHeaders,
} from "./inbound.js";
import { Mailbox } from "./Mailbox.js";
import { Mailer } from "./Mailer.js";
import { Store } from "./Store.js";

/** Kept short: a long thread would otherwise grow the header with every answer. */
const MAX_REFERENCES = 20;

export const NO_QUESTION =
  "I couldn't find a question in your reply. Write it above the quoted email and send it again.";
export const FAILED =
  "Sorry, I couldn't answer that: the model request failed. Reply again to retry.";

/** What one poll did, for the reader's own log lines. Null when the mailbox couldn't be read. */
export interface PollReport {
  readonly path: string;
  readonly newEmails: number;
  readonly answered: number;
}

interface Question {
  readonly uid: number;
  readonly headers: InboundHeaders & { readonly messageId: string };
  readonly digestDate: string;
}

const emails = (count: number) => `${count} new email${count === 1 ? "" : "s"}`;

/** e.g. "Checked: 2 new emails, no replies to answer". Counts only, never senders or subjects. */
export const checkLine = (report: PollReport): string =>
  `Checked: ${emails(report.newEmails)}, ${
    report.answered === 0
      ? "no replies to answer"
      : `answered ${report.answered} ${report.answered === 1 ? "reply" : "replies"}`
  }`;

export class Replies extends Context.Service<
  Replies,
  {
    /** Answers every new reply in the mailbox once. Never fails: problems are logged. */
    readonly poll: Effect.Effect<PollReport | null>;
  }
>()("hackernews-mcp/Replies") {
  static readonly layer = Layer.effect(
    Replies,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const mailbox = yield* Mailbox;
      const mailer = yield* Mailer;
      const store = yield* Store;
      const chat = yield* ChatService;

      /** Reads new mail inside one IMAP session. Model calls happen after it's closed. */
      const fetchQuestions = Effect.scoped(
        Effect.gen(function* () {
          const session = yield* mailbox.open;
          const cursor = yield* store.imapCursor(session.path);
          const start = { uidValidity: session.uidValidity, lastUid: session.uidNext - 1 };

          // First run, or Gmail renumbered the folder: start from now rather than answering history.
          if (cursor === null || cursor.uidValidity !== session.uidValidity) {
            yield* cursor === null
              ? Effect.logInfo(`Watching ${session.path} for replies, starting from its newest email`)
              : Effect.logWarning(`${session.path} was renumbered; skipping older mail`);
            return { path: session.path, cursor: start, newEmails: 0, questions: [], sources: new Map() };
          }

          const blocks = yield* session.headersAfter(cursor.lastUid);
          const parsed = yield* Effect.forEach(
            blocks.filter(({ draft }) => !draft),
            ({ uid, raw }) =>
              parseMail(raw).pipe(
                Effect.map((mail) => [{ uid, headers: readHeaders(mail) }]),
                // One malformed email mustn't block the mailbox: skip it and move on.
                Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as([]))),
              ),
          ).pipe(Effect.map((entries) => entries.flat()));
          const outgoing = yield* store.findOutgoing(
            parsed.flatMap(({ headers }) => mentionedIds(headers)),
          );

          const questions: Array<Question> = [];
          for (const { uid, headers } of parsed) {
            const verdict = classify(headers, config.digestTo, outgoing);
            if (verdict.kind === "reject") {
              yield* Effect.logWarning(`Not answering ${headers.messageId}: ${verdict.reason}`);
            }
            if (verdict.kind === "answer" && headers.messageId !== null) {
              questions.push({
                uid,
                headers: { ...headers, messageId: headers.messageId },
                digestDate: verdict.digestDate,
              });
            }
          }

          const sources = yield* session.sources(questions.map(({ uid }) => uid));
          return {
            path: session.path,
            cursor: {
              uidValidity: session.uidValidity,
              lastUid: Math.max(cursor.lastUid, ...blocks.map(({ uid }) => uid)),
            },
            newEmails: blocks.length,
            questions,
            sources: new Map(sources.map(({ uid, raw }) => [uid, raw])),
          };
        }),
      );

      const reply = Effect.fn("Replies.reply")(function* (question: Question, text: string) {
        const now = yield* Clock.currentTimeMillis;
        const messageId = yield* mailer.newMessageId;
        // Recorded first, so the poller recognizes its own answer when it shows up in the mailbox.
        yield* store.recordOutgoing(messageId, question.digestDate, "answer", now);
        yield* mailer.send(renderAnswerEmail(question.headers.subject, text), "answer", {
          messageId,
          inReplyTo: question.headers.messageId,
          references: [...question.headers.references, question.headers.messageId].slice(
            -MAX_REFERENCES,
          ),
        });
        yield* Effect.logInfo(`Sent a reply in the ${question.digestDate} digest thread`);
      });

      const answerOne = Effect.fn("Replies.answerOne")(function* (
        question: Question,
        raw: Uint8Array,
      ) {
        const text = extractQuestion(yield* parseMail(raw), MAX_QUESTION_LENGTH);
        const now = yield* Clock.currentTimeMillis;
        const claimed = yield* store.claimIncoming(question.headers.messageId, question.digestDate, now);
        if (!claimed) return;

        if (text.length === 0) return yield* reply(question, NO_QUESTION);
        yield* Effect.logInfo(`Answering a question about the ${question.digestDate} digest`);
        const answer = yield* chat.answer(question.digestDate, text).pipe(
          Effect.catchTag("BudgetExceeded", (error) => Effect.succeed(error.message)),
          Effect.catchTag("AnswerFailed", (error) =>
            Effect.logError(error.message).pipe(Effect.as(FAILED)),
          ),
        );
        yield* reply(question, answer);
      });

      const poll = Effect.gen(function* () {
        const { path, cursor, newEmails, questions, sources } = yield* fetchQuestions;
        let answered = 0;
        for (const question of questions) {
          const raw: Uint8Array | undefined = sources.get(question.uid);
          if (raw === undefined) continue;
          // Errors and defects alike stay with this one question, so the cursor still moves on.
          yield* answerOne(question, raw).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                answered++;
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logError(`Reply to ${question.headers.messageId} failed`, cause),
            ),
          );
        }
        // Saved last: if this run dies partway, the next one sees the same mail again, and
        // claimIncoming stops anything from being answered twice.
        yield* store.saveImapCursor(path, cursor);
        return { path, newEmails, answered } satisfies PollReport;
      }).pipe(
        Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as(null))),
        Effect.catchCause((cause) =>
          Effect.logError("Reply poll crashed", cause).pipe(Effect.as(null)),
        ),
      );

      return Replies.of({ poll });
    }),
  );

  /**
   * Polls for as long as the process runs, starting right away. Besides answers and
   * problems, it logs the first successful check and then a summary every hour, so a quiet
   * log still shows the reader is alive.
   */
  static readonly poller = Layer.effectDiscard(
    Effect.gen(function* () {
      const replies = yield* Replies;
      const config = yield* AppConfig;
      const pollsPerSummary = Math.max(1, Math.round(3600 / config.replyPollSeconds));
      const totals = yield* Ref.make({ polls: 0, failed: 0, newEmails: 0, answered: 0, connected: false });

      yield* Effect.logInfo(
        `Started. Checking ${config.gmailUser} every ${config.replyPollSeconds}s for replies from ${config.digestTo}`,
      );
      const pollAndReport = Effect.gen(function* () {
        const report = yield* replies.poll;
        const before = yield* Ref.get(totals);
        if (report !== null && !before.connected) {
          yield* Effect.logInfo(
            `First check of ${report.path} done. Checking every ${config.replyPollSeconds}s, with a summary each hour.`,
          );
        }
        // Only checks that found mail get a line, so quiet minutes stay out of the log.
        if (report !== null && report.newEmails > 0) yield* Effect.logInfo(checkLine(report));
        const now = {
          polls: before.polls + 1,
          failed: before.failed + (report === null ? 1 : 0),
          newEmails: before.newEmails + (report?.newEmails ?? 0),
          answered: before.answered + (report?.answered ?? 0),
          connected: before.connected || report !== null,
        };
        if (now.polls < pollsPerSummary) return yield* Ref.set(totals, now);
        yield* Effect.logInfo(
          `Last hour: ${now.polls} checks${now.failed > 0 ? ` (${now.failed} failed)` : ""}, ${now.newEmails} new emails, ${now.answered} replies answered`,
        );
        yield* Ref.set(totals, { polls: 0, failed: 0, newEmails: 0, answered: 0, connected: true });
      });
      yield* pollAndReport.pipe(
        Effect.repeat(Schedule.spaced(Duration.seconds(config.replyPollSeconds))),
        Effect.forkScoped,
      );
    }),
  );
}
