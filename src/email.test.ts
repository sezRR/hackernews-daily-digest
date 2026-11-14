import { assert, it } from "@effect/vitest";
import type { Digest, DigestStory } from "./Digest.js";
import { keepOnlyHnLinks } from "./Analyst.js";
import {
  longDate,
  renderAnswerEmail,
  renderDigestEmail,
  renderFailureEmail,
  replySubject,
} from "./email.js";

const story = (overrides: Partial<DigestStory> = {}): DigestStory => ({
  rank: 1,
  id: 42,
  title: "A story",
  url: "https://example.com/a",
  hn_url: "https://news.ycombinator.com/item?id=42",
  score: 100,
  comment_count: 50,
  about: "It is about things.",
  opinion: "People like it.",
  disagreement: "Some do not.",
  ...overrides,
});

const digest = (overrides: Partial<Digest> = {}): Digest => ({
  date: "2026-11-05",
  generated_at: "2026-11-05T08:00:00.000Z",
  model: "gpt-6-luna",
  overview: "A calm day.",
  important: [],
  ranking_source: "front_page_html",
  failed_fetches: 0,
  stories: [story()],
  ...overrides,
});

const hrefs = (html: string) => Array.from(html.matchAll(/href="([^"]*)"/g), (match) => match[1]);

it("links only to the Hacker News thread, never the story's own url", () => {
  const { html, text } = renderDigestEmail(digest());

  assert.isAbove(hrefs(html).length, 0);
  assert.deepStrictEqual(new Set(hrefs(html)), new Set(["https://news.ycombinator.com/item?id=42"]));
  assert.notInclude(html, "example.com/a");
  assert.notInclude(text, "example.com/a");
});

it("tells the reader they can reply with questions", () => {
  const { html, text } = renderDigestEmail(digest());

  assert.include(html, "Reply to this email");
  assert.include(text, "Reply to this email");
});

it("puts important stories first, linked to their threads", () => {
  const { html, text } = renderDigestEmail(
    digest({
      stories: [story(), story({ id: 7, rank: 2, title: "Big CVE" })],
      important: [{ story_id: 7, why: "Patch your servers." }],
    }),
  );

  assert.include(html, "Worth knowing today");
  assert.isBelow(html.indexOf("Patch your servers."), html.indexOf("People like it."));
  assert.strictEqual(hrefs(html)[0], "https://news.ycombinator.com/item?id=7");
  assert.include(text, "Worth knowing today\n- Big CVE: Patch your servers.");
});

it("leaves out the important section on a quiet day, and picks for stories it doesn't have", () => {
  const quiet = renderDigestEmail(digest());
  const unknown = renderDigestEmail(digest({ important: [{ story_id: 999, why: "Invented." }] }));

  for (const { html, text } of [quiet, unknown]) {
    assert.notInclude(html, "Worth knowing");
    assert.notInclude(text, "Worth knowing");
  }
  assert.notInclude(unknown.html, "Invented.");
});

it("escapes every field that comes from Hacker News or the model", () => {
  const hostile = '<img src=x onerror=alert(1)>"\'&';
  const { html } = renderDigestEmail(
    digest({
      overview: hostile,
      stories: [story({ title: hostile, about: hostile, opinion: hostile, disagreement: hostile })],
    })
  );

  assert.notInclude(html, "<img");
  assert.include(html, "&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
});

it("keeps a hostile title out of the subject's headers", () => {
  const { subject } = renderDigestEmail(
    digest({ stories: [story({ title: "Hi\r\nBcc: evil@example.com" })] })
  );

  assert.notMatch(subject, /[\r\n]/);
});

it("shortens long titles in the subject without splitting an emoji", () => {
  const { subject } = renderDigestEmail(
    digest({ stories: [story({ title: `${"x".repeat(59)}😀😀 more` })] })
  );

  assert.isTrue(subject.isWellFormed());
  assert.isTrue(subject.endsWith("…"));
});

it("says so when a story has no summary", () => {
  const { html, text } = renderDigestEmail(
    digest({ stories: [story({ about: null, opinion: null, disagreement: null })] })
  );

  assert.include(html, "This story has no summary");
  assert.include(text, "This story has no summary");
  assert.notInclude(text, "null");
});

it("reports partial data and the ranking fallback to the reader", () => {
  const { html, text } = renderDigestEmail(
    digest({ failed_fetches: 3, ranking_source: "api_topstories" })
  );

  assert.include(html, "3 items couldn&#39;t be loaded");
  assert.include(text, "3 items couldn't be loaded");
  for (const body of [html, text]) {
    assert.include(body, "front page was unavailable");
  }
});

it("renders an empty day without pretending there was news", () => {
  const { subject, html } = renderDigestEmail(
    digest({ overview: null, stories: [] })
  );

  assert.include(subject, "nothing new");
  assert.include(html, "No new stories");
});

it("failure emails escape the error and name the date", () => {
  const { subject, html, text } = renderFailureEmail("2026-11-05", 4, "<boom>");

  assert.include(subject, "2026-11-05");
  assert.include(html, "&lt;boom&gt;");
  assert.include(text, "<boom>");
});

it("escapes answers and links only Hacker News threads, rebuilt from the id", () => {
  const answer = keepOnlyHnLinks(
    "See https://news.ycombinator.com/item?id=123.\n\n<b>bold</b> and https://evil.example/?q=secret",
  );
  const { html, text } = renderAnswerEmail("Hacker News digest 2026-11-05: A story", answer);

  assert.deepStrictEqual(hrefs(html), ["https://news.ycombinator.com/item?id=123"]);
  assert.include(html, "&lt;b&gt;bold&lt;/b&gt;");
  assert.notInclude(html, "evil.example");
  assert.notInclude(text, "evil.example");
  assert.include(text, "https://news.ycombinator.com/item?id=123.");
});

it("keepOnlyHnLinks removes look-alike hosts and extra query parts", () => {
  for (const url of [
    "https://news.ycombinator.com.evil.example/item?id=1",
    "https://news.ycombinator.com/item?id=1&x=secret",
    "http://news.ycombinator.com/item?id=1",
    "https://evil.example/#https://news.ycombinator.com/item?id=1",
  ]) {
    assert.strictEqual(keepOnlyHnLinks(url), "[link removed]", url);
  }
});

it("reply subjects get one Re: and no line breaks", () => {
  assert.strictEqual(replySubject("Re: RE: Hacker News digest"), "Re: Hacker News digest");
  assert.strictEqual(replySubject("Hi\r\nBcc: evil@example.com"), "Re: Hi Bcc: evil@example.com");
  assert.strictEqual(replySubject(undefined), "Re: Hacker News digest");
});

it("is a designed HTML email with a plain-text alternative", () => {
  const { html, text } = renderDigestEmail(digest());

  assert.match(html, /^<!doctype html>/);
  assert.include(html, "Thursday 5 November");
  assert.include(html, "prefers-color-scheme:dark");
  assert.notInclude(text, "<");
});

it("shows the overview as the inbox preview line, escaped", () => {
  const { html } = renderDigestEmail(digest({ overview: "Calm <day>" }));

  assert.match(html, /<div style="display:none[^>]*>Calm &lt;day&gt;/);
});

it("scales each discussion bar to the busiest thread", () => {
  const { html } = renderDigestEmail(
    digest({
      stories: [story({ comment_count: 400 }), story({ id: 2, rank: 2, comment_count: 100 })],
    }),
  );

  const filled = Array.from(html.matchAll(/<td width="(\d+)" style="width:\1px;height:6px/g), (m) => Number(m[1]));
  assert.deepStrictEqual(filled, [72, 18]);
});

it("formats digest dates in the reader's words", () => {
  assert.strictEqual(longDate("2026-11-14"), "Saturday 14 November");
});
