import type { Digest, DigestStory } from "./Digest.js";

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  /** The plain-text alternative. Mail apps show the HTML; spam filters expect both. */
  readonly text: string;
}

const SUBJECT_TITLE_LENGTH = 60;
const PREHEADER_LENGTH = 140;

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Story ids are integers from a validated schema, so these links can't carry anything else.
const threadUrl = (story: DigestStory) => `https://news.ycombinator.com/item?id=${story.id}`;

const REPLY_HINT = "Reply to this email to ask about any of these stories.";

const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, " ").trim();

const subjectFor = (digest: Digest): string => {
  const top = digest.stories[0];
  if (top === undefined) return `Hacker News digest ${digest.date}: nothing new`;
  const title = oneLine(top.title);
  const short =
    title.length > SUBJECT_TITLE_LENGTH
      ? `${title.slice(0, SUBJECT_TITLE_LENGTH).toWellFormed().trimEnd()}…`
      : title;
  return `Hacker News digest ${digest.date}: ${short}`;
};

const count = (value: number | null) => (value ?? 0).toLocaleString("en-US");
const plural = (value: number | null, word: string) =>
  `${count(value)} ${word}${value === 1 ? "" : "s"}`;

/** "2026-11-14" as "Friday 14 November". The digest date is already in the reader's zone. */
export const longDate = (date: string): string => {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
};

// Tokens. Light is the default; the dark values apply where mail apps honour
// prefers-color-scheme (Apple Mail, iOS, Outlook for Mac). Gmail recolours on its own.
const PAPER = "#eceff3";
const CARD = "#ffffff";
const INK = "#1b2333";
const MUTED = "#5b6577";
const RULE = "#e3e7ee";
const SIGNAL = "#ff6600";
const TINT = "#fff1e7";
const LINK = "#a63c00";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',Times,serif";

const STYLE = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
a{text-decoration:none}
@media (max-width:620px){.pad{padding-left:18px!important;padding-right:18px!important}.rank{width:30px!important;font-size:18px!important}}
@media (prefers-color-scheme:dark){
.bg{background:#12161d!important}.card{background:#1a2029!important}
.ink{color:#e7eaf0!important}.muted{color:#a2acbc!important}.link{color:#ff9a57!important}
.tint{background:#2b2018!important}.rule{border-color:#2b3340!important}.track{background:#2b3340!important}
}
</style>`;

const para = (text: string, options: { size?: number; color?: string; cls?: string; margin?: string } = {}) =>
  `<p class="${options.cls ?? "ink"}" style="margin:${options.margin ?? "0 0 12px"};font-family:${SERIF};font-size:${options.size ?? 16}px;line-height:1.6;color:${options.color ?? INK}">${text}</p>`;

const small = (text: string) =>
  `<p class="muted" style="margin:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.5;color:${MUTED}">${text}</p>`;

/**
 * The frame every email shares: grey page, one white column, an orange rule across the top.
 * `preheader` is the line inboxes show next to the subject.
 */
const shell = (options: { title: string; preheader: string; body: string; footer: string }) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(options.title)}</title>${STYLE}</head>
<body class="bg" style="margin:0;padding:0;background:${PAPER};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(options.preheader)}${"&#8199;&#65279;&#847; ".repeat(40)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:24px 8px">
<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${CARD};border-radius:6px;overflow:hidden">
<tr><td style="height:4px;line-height:4px;font-size:0;background:${SIGNAL}">&nbsp;</td></tr>
<tr><td class="pad" style="padding:28px 32px 8px">${options.body}</td></tr>
<tr><td class="pad" style="padding:8px 32px 28px">${options.footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;

/** Model picks, kept only when they name a story in this digest, in the model's order. */
const importantStories = (digest: Digest) =>
  digest.important.flatMap((entry) => {
    const story = digest.stories.find((candidate) => candidate.id === entry.story_id);
    return story ? [{ story, why: entry.why }] : [];
  });

const importantHtml = (digest: Digest): string => {
  const entries = importantStories(digest);
  if (entries.length === 0) return "";
  const items = entries
    .map(
      ({ story, why }, index) =>
        `<p style="margin:${index === 0 ? "0" : "14px"} 0 0;font-family:${SANS};font-size:16px;line-height:1.35;font-weight:700"><a class="ink" href="${escapeHtml(threadUrl(story))}" style="color:${INK}">${escapeHtml(oneLine(story.title))}</a></p>` +
        para(escapeHtml(why), { size: 15, margin: "4px 0 0" }),
    )
    .join("");
  return `<table role="presentation" class="tint" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;background:${TINT};border-radius:4px"><tr><td style="padding:16px 18px 18px;border-left:3px solid ${SIGNAL}">
<p class="link" style="margin:0 0 10px;font-family:${SANS};font-size:14px;font-weight:700;color:${LINK}">Worth knowing today</p>
${items}
</td></tr></table>`;
};

/**
 * How much of the day's conversation a story drew: a bar scaled to the busiest thread.
 * Built from table cells, since mail apps block images by default.
 */
const heatBar = (comments: number | null, busiest: number): string => {
  const width = 72;
  const filled = busiest > 0 ? Math.max(3, Math.round(((comments ?? 0) / busiest) * width)) : 3;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="${width}" style="width:${width}px"><tr><td width="${filled}" style="width:${filled}px;height:6px;line-height:6px;font-size:0;background:${SIGNAL};border-radius:3px 0 0 3px">&nbsp;</td><td class="track" style="height:6px;line-height:6px;font-size:0;background:${RULE}">&nbsp;</td></tr></table>`;
};

const storyHtml = (story: DigestStory, busiest: number, first: boolean): string => {
  const url = escapeHtml(threadUrl(story));
  const summary =
    story.opinion === null
      ? para("This story has no summary.", { color: MUTED, cls: "muted" })
      : para(escapeHtml(story.opinion));
  const about =
    story.about === null ? "" : para(escapeHtml(story.about), { size: 15, color: MUTED, cls: "muted", margin: "0 0 8px" });
  const disagreement =
    story.disagreement === null
      ? ""
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px"><tr><td style="padding:2px 0 2px 12px;border-left:2px solid ${SIGNAL}">${para(
          `<span style="font-family:${SANS};font-weight:700">Where they disagree:</span> ${escapeHtml(story.disagreement)}`,
          { size: 15, margin: "0" },
        )}</td></tr></table>`;

  return `<tr><td class="rule" style="padding:${first ? "4px" : "22px"} 0 22px;${first ? "" : `border-top:1px solid ${RULE};`}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="rank" width="40" valign="top" style="width:40px;padding-top:1px;font-family:${SANS};font-size:20px;line-height:1.2;font-weight:800;color:${SIGNAL}">${story.rank}</td>
<td valign="top">
<p style="margin:0 0 8px;font-family:${SANS};font-size:18px;line-height:1.3;font-weight:700"><a class="ink" href="${url}" style="color:${INK}">${escapeHtml(oneLine(story.title))}</a></p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px"><tr><td valign="middle">${heatBar(story.comment_count, busiest)}</td><td class="muted" valign="middle" style="padding-left:10px;font-family:${SANS};font-size:13px;color:${MUTED}">${escapeHtml(`${plural(story.comment_count, "comment")}, ${plural(story.score, "point")}`)}</td></tr></table>
${about}${summary}${disagreement}
<p style="margin:0;font-family:${SANS};font-size:14px;font-weight:700"><a class="link" href="${url}" style="color:${LINK}">Read the thread</a></p>
</td></tr></table>
</td></tr>`;
};

const failedFetchNote = (digest: Digest): string | null =>
  digest.failed_fetches === 0
    ? null
    : `${digest.failed_fetches} items couldn't be loaded, so some stories or comments may be missing.`;

const rankingNote = (digest: Digest): string | null =>
  digest.ranking_source === "front_page_html"
    ? null
    : "The front page was unavailable, so story order comes from the Hacker News API and may differ slightly.";

const notes = (digest: Digest): ReadonlyArray<string> =>
  [failedFetchNote(digest), rankingNote(digest)].filter((note) => note !== null);

const provenance = (digest: Digest): string =>
  `Written by ${digest.model ?? "a model"} from public comments, not the linked articles, so it can be wrong. Numbers are each story's place on the front page.`;

const replyBox = (text: string) =>
  `<table role="presentation" class="rule" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;border:1px solid ${RULE};border-radius:4px"><tr><td style="padding:14px 16px">${para(
    escapeHtml(text),
    { size: 15, margin: "0" },
  )}</td></tr></table>`;

export const renderDigestEmail = (digest: Digest): RenderedEmail => {
  const busiest = Math.max(0, ...digest.stories.map((story) => story.comment_count ?? 0));
  const comments = digest.stories.reduce((sum, story) => sum + (story.comment_count ?? 0), 0);
  const standfirst =
    digest.stories.length === 0
      ? "Hacker News digest"
      : `Hacker News digest, ${digest.stories.length} ${digest.stories.length === 1 ? "story" : "stories"} and ${count(comments)} comments`;

  const masthead = `<p class="ink" style="margin:0 0 4px;font-family:${SANS};font-size:26px;line-height:1.2;font-weight:800;color:${INK}">${escapeHtml(longDate(digest.date))}</p>
<p class="muted" style="margin:0 0 20px;font-family:${SANS};font-size:14px;color:${MUTED}">${escapeHtml(standfirst)}</p>
${digest.overview === null ? "" : para(escapeHtml(digest.overview), { size: 19, margin: "0 0 26px" })}`;

  const stories =
    digest.stories.length === 0
      ? para("No new stories made the cut today.") +
        para("Reply to ask about anything on the front page right now.", { color: MUTED, cls: "muted" })
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${digest.stories
          .map((story, index) => storyHtml(story, busiest, index === 0))
          .join("")}</table>`;

  const footer =
    replyBox(digest.stories.length === 0 ? "Reply to this email to ask a question." : REPLY_HINT) +
    notes(digest).map((note) => small(escapeHtml(note))).join("") +
    small(escapeHtml(provenance(digest)));

  const html = shell({
    title: subjectFor(digest),
    preheader: digest.overview ?? (digest.stories.length === 0 ? "No new stories today." : standfirst),
    body: masthead + importantHtml(digest) + stories,
    footer,
  }).replace(/>\s+</g, "><");

  const importantText = importantStories(digest).map(
    ({ story, why }) => `- ${oneLine(story.title)}: ${why}\n  ${threadUrl(story)}`,
  );
  const storyText = (story: DigestStory): string =>
    [
      `${story.rank}. ${oneLine(story.title)}`,
      `${plural(story.comment_count, "comment")}, ${plural(story.score, "point")}`,
      story.about,
      story.opinion ?? "This story has no summary.",
      story.disagreement === null ? null : `Where they disagree: ${story.disagreement}`,
      threadUrl(story),
    ]
      .filter((line) => line !== null)
      .join("\n");

  const text = [
    `${longDate(digest.date)}\n${standfirst}`,
    digest.overview,
    importantText.length === 0 ? null : ["Worth knowing today", ...importantText].join("\n"),
    digest.stories.length === 0
      ? "No new stories made the cut today."
      : digest.stories.map(storyText).join("\n\n"),
    REPLY_HINT,
    ...notes(digest),
    provenance(digest),
  ]
    .filter((line) => line !== null)
    .join("\n\n");

  return { subject: subjectFor(digest), html, text };
};

export const renderFailureEmail = (
  date: string,
  attempts: number,
  error: string,
): RenderedEmail => {
  const headline = `The ${longDate(date)} digest didn't go out`;
  const summary = `It failed ${attempts} times today and won't try again until tomorrow's digest.`;
  const hint = "On the server, make logs-digest shows what happened.";
  const body =
    `<p class="ink" style="margin:0 0 12px;font-family:${SANS};font-size:22px;line-height:1.25;font-weight:800;color:${INK}">${escapeHtml(headline)}</p>` +
    para(escapeHtml(summary)) +
    `<p class="muted" style="margin:0 0 6px;font-family:${SANS};font-size:13px;font-weight:700;color:${MUTED}">Last error</p>` +
    `<pre class="tint ink" style="margin:0 0 16px;padding:12px 14px;background:${TINT};border-radius:4px;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.5;color:${INK};white-space:pre-wrap;word-break:break-word">${escapeHtml(error)}</pre>`;
  return {
    subject: `Hacker News digest ${date}: failed`,
    html: shell({ title: headline, preheader: summary, body, footer: small(escapeHtml(hint)) }),
    text: `${headline}\n\n${summary}\n\nLast error: ${error}\n\n${hint}`,
  };
};

const HN_ITEM_LINK = /https:\/\/news\.ycombinator\.com\/item\?id=(\d+)/g;

/** "Re: " plus the original subject, made safe to use as a header. */
export const replySubject = (subject: string | undefined): string => {
  const base = oneLine(subject ?? "").replace(/^(?:re:\s*)+/i, "");
  return `Re: ${base.length > 0 ? base.slice(0, 200).toWellFormed() : "Hacker News digest"}`;
};

/**
 * An answer to an emailed question. The text must already have passed `keepOnlyHnLinks`:
 * the only links made clickable are Hacker News threads, rebuilt here from their ids.
 */
export const renderAnswerEmail = (subject: string | undefined, answer: string): RenderedEmail => {
  const paragraphs = answer
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) =>
      para(
        escapeHtml(paragraph)
          .replace(
            HN_ITEM_LINK,
            (_, id: string) =>
              `<a class="link" href="https://news.ycombinator.com/item?id=${id}" style="color:${LINK};font-family:${SANS};font-size:15px;font-weight:700">news.ycombinator.com/item?id=${id}</a>`,
          )
          // The model is told to write "- " lists; show them as bullets.
          .replace(/^- /gm, "&bull;&nbsp;")
          .replace(/\n/g, "<br>"),
      ),
    )
    .join("");
  const reSubject = replySubject(subject);
  return {
    subject: reSubject,
    html: shell({
      title: reSubject,
      preheader: oneLine(answer).slice(0, PREHEADER_LENGTH),
      body: paragraphs,
      footer: small("Reply to keep asking. Answers come from public comments and can be wrong."),
    }),
    text: `${answer.trim()}\n\nReply to keep asking.`,
  };
};
