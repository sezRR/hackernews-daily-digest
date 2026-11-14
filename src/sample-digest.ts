import type { Digest } from "./Digest.js";

/**
 * A fixed, made-up digest for `pnpm dev:test --sample`: checks the email design and
 * delivery without fetching Hacker News or paying for a model call.
 */
export const sampleDigest = (date: string): Digest => ({
  date,
  generated_at: new Date().toISOString(),
  model: null,
  overview:
    "A security-heavy morning: commenters spent most of their energy on a widely used compression library's backdoor scare, with a calmer side debate about whether SQLite belongs on servers.",
  important: [
    {
      story_id: 1,
      why: "Several commenters confirmed the affected versions ship in common Linux images, and the advice in the thread is to pin or downgrade today.",
    },
  ],
  ranking_source: "front_page_html",
  failed_fetches: 0,
  stories: [
    {
      rank: 1,
      id: 1,
      title: "Sample: Suspicious commit found in a popular compression library",
      url: "https://example.com/1",
      hn_url: "https://news.ycombinator.com/item?id=1",
      score: 1243,
      comment_count: 512,
      about: "A maintainer noticed an obfuscated change in a release tarball that wasn't in the repository.",
      opinion:
        "Most commenters treat it as a serious supply-chain attack and praise the person who caught it. Many argue that unpaid maintainers are the real weak point.",
      disagreement:
        "Whether reproducible builds would have caught it, or whether the attacker would simply have targeted the build scripts instead.",
    },
    {
      rank: 3,
      id: 3,
      title: "Sample: SQLite in production, five years later",
      url: "https://example.com/3",
      hn_url: "https://news.ycombinator.com/item?id=3",
      score: 640,
      comment_count: 231,
      about: "An engineer describes running a busy web app on a single SQLite file.",
      opinion:
        "Commenters are broadly positive and share similar setups, with WAL mode and regular backups as the common advice.",
      disagreement: "How far a single writer really scales before you need Postgres.",
    },
    {
      rank: 7,
      id: 7,
      title: "Sample: Show HN: A terminal UI for reading RFCs",
      url: "https://example.com/7",
      hn_url: "https://news.ycombinator.com/item?id=7",
      score: 188,
      comment_count: 64,
      about: "A small open-source tool that downloads and formats RFCs for reading in a terminal.",
      opinion: "Friendly reception. People suggest search and better table rendering.",
      disagreement: null,
    },
  ],
});
