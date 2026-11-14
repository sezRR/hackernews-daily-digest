import { Effect, Schema } from "effect";
import { Thread } from "./domain.js";

/** What the model returns for one story. Text only: code decides every link. */
export const StoryAnalysis = Schema.Struct({
  story_id: Schema.Int,
  about: Schema.String.annotate({
    description: "One sentence on what the story is about, as far as the comments reveal it",
  }),
  opinion: Schema.String.annotate({
    description: "Two or three sentences on what commenters think overall",
  }),
  disagreement: Schema.NullOr(Schema.String).annotate({
    description: "The main point commenters disagree on, or null if there is none",
  }),
});
export type StoryAnalysis = typeof StoryAnalysis.Type;

/** A story the reader shouldn't miss, with the reason in one sentence. */
export const Important = Schema.Struct({
  story_id: Schema.Int,
  why: Schema.String.annotate({
    description: "One sentence on why this matters to a busy reader today",
  }),
});
export type Important = typeof Important.Type;

export const DigestAnalysis = Schema.Struct({
  overview: Schema.String.annotate({
    description: "One or two sentences on the overall mood of today's discussions",
  }),
  important: Schema.Array(Important).annotate({
    description:
      "Stories a busy reader shouldn't miss today, most important first: security problems that may need action, major outages, significant releases or shutdowns, legal or policy changes, big industry news. Usually zero to three. Empty when nothing stands out",
  }),
  stories: Schema.Array(StoryAnalysis),
});
export type DigestAnalysis = typeof DigestAnalysis.Type;

export const SnapshotThread = Schema.Struct({
  rank: Schema.Int,
  thread: Thread,
});
export type SnapshotThread = typeof SnapshotThread.Type;

/** The raw data a digest was built from, kept so analysis can retry without fetching again. */
export const Snapshot = Schema.Struct({
  fetched_at: Schema.String,
  ranking_source: Schema.Literals(["front_page_html", "api_topstories"]),
  failed_fetches: Schema.Int,
  threads: Schema.Array(SnapshotThread),
});
export type Snapshot = typeof Snapshot.Type;

export const DigestStory = Schema.Struct({
  rank: Schema.Int,
  id: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  hn_url: Schema.String,
  score: Schema.NullOr(Schema.Int),
  comment_count: Schema.NullOr(Schema.Int),
  about: Schema.NullOr(Schema.String),
  opinion: Schema.NullOr(Schema.String),
  disagreement: Schema.NullOr(Schema.String),
});
export type DigestStory = typeof DigestStory.Type;

export const Digest = Schema.Struct({
  date: Schema.String,
  generated_at: Schema.String,
  model: Schema.NullOr(Schema.String),
  overview: Schema.NullOr(Schema.String),
  /** Absent from digests stored before this field existed. */
  important: Schema.Array(Important).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  ranking_source: Schema.Literals(["front_page_html", "api_topstories"]),
  failed_fetches: Schema.Int,
  stories: Schema.Array(DigestStory),
});
export type Digest = typeof Digest.Type;

export const SnapshotJson = Schema.fromJsonString(Snapshot);
export const DigestJson = Schema.fromJsonString(Digest);
