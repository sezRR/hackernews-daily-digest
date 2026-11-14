import { Effect, Schema } from "effect";

/** An item as the Hacker News API returns it. Every field but `id` can be absent. */
export const Item = Schema.Struct({
  id: Schema.Int,
  type: Schema.optionalKey(Schema.String),
  by: Schema.optionalKey(Schema.String),
  time: Schema.optionalKey(Schema.Int),
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  score: Schema.optionalKey(Schema.Int),
  descendants: Schema.optionalKey(Schema.Int),
  kids: Schema.optionalKey(Schema.Array(Schema.Int)),
  deleted: Schema.optionalKey(Schema.Boolean),
  dead: Schema.optionalKey(Schema.Boolean),
});
export type Item = typeof Item.Type;

export interface Comment {
  readonly id: number;
  readonly by: string | null;
  readonly time: string | null;
  readonly text: string;
  readonly truncated?: true;
  readonly reply_count: number;
  readonly replies?: ReadonlyArray<Comment>;
}

export const Comment: Schema.Codec<Comment> = Schema.Struct({
  id: Schema.Int,
  by: Schema.NullOr(Schema.String),
  time: Schema.NullOr(Schema.String),
  text: Schema.String,
  truncated: Schema.optionalKey(Schema.Literal(true)),
  reply_count: Schema.Int.annotate({
    description: "Direct replies that exist on Hacker News, which can be more than `replies` holds",
  }),
  replies: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<Comment> => Comment))),
}).annotate({ identifier: "Comment" });

const itemSummaryFields = {
  id: Schema.Int,
  type: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  url: Schema.String,
  hn_url: Schema.String,
  by: Schema.NullOr(Schema.String),
  score: Schema.NullOr(Schema.Int),
  comment_count: Schema.NullOr(Schema.Int),
  time: Schema.NullOr(Schema.String),
  text: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Literal(true)),
};

export const ItemSummary = Schema.Struct(itemSummaryFields);
export type ItemSummary = typeof ItemSummary.Type;

export const Story = Schema.Struct({
  rank: Schema.Int,
  ...itemSummaryFields,
  top_comments: Schema.Array(Comment),
});
export type Story = typeof Story.Type;

export const FrontPage = Schema.Struct({
  fetched_at: Schema.String,
  ranking_source: Schema.Literals(["front_page_html", "api_topstories"]),
  failed_fetches: Schema.Int,
  stories: Schema.Array(Story),
});
export type FrontPage = typeof FrontPage.Type;

export const Thread = Schema.Struct({
  fetched_at: Schema.String,
  failed_fetches: Schema.Int,
  item: ItemSummary,
  comments: Schema.Array(Comment),
});
export type Thread = typeof Thread.Type;

const boundedInt = (options: {
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly description: string;
}) =>
  Schema.Int.check(Schema.isBetween({ minimum: options.min, maximum: options.max }))
    .annotate({
      description: `${options.description}. Default ${options.default}, range ${options.min}-${options.max}`,
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(options.default)));

const maxCommentChars = (defaultChars: number) =>
  boundedInt({
    min: 100,
    max: 10_000,
    default: defaultChars,
    description: "Maximum characters kept from each comment or post text",
  });

export const FrontPageParams = Schema.Struct({
  limit: boundedInt({
    min: 1,
    max: 30,
    default: 30,
    description: "Number of stories, starting from rank 1",
  }),
  comments_per_story: boundedInt({
    min: 0,
    max: 10,
    default: 3,
    description: "Top-level comments per story, highest ranked first. 0 returns none",
  }),
  max_comment_chars: maxCommentChars(500),
});
export type FrontPageParams = typeof FrontPageParams.Type;

export const CommentsParams = Schema.Struct({
  item_id: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Story id from get_front_page, or a comment id",
  }),
  limit: boundedInt({ min: 1, max: 30, default: 10, description: "Number of top-level comments" }),
  reply_depth: boundedInt({
    min: 0,
    max: 3,
    default: 1,
    description: "Levels of nested replies. 0 returns top-level comments only",
  }),
  replies_per_comment: boundedInt({
    min: 1,
    max: 5,
    default: 3,
    description: "Replies kept under each comment, highest ranked first",
  }),
  max_comment_chars: maxCommentChars(2_000),
});
export type CommentsParams = typeof CommentsParams.Type;

export class HnRequestError extends Schema.TaggedError<HnRequestError>()("HnRequestError", {
  url: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Request to ${this.url} failed: ${this.reason}`;
  }
}

export class ItemNotFound extends Schema.TaggedError<ItemNotFound>()("ItemNotFound", {
  id: Schema.Int,
}) {
  override get message() {
    return `No Hacker News item with id ${this.id}`;
  }
}

export class FrontPageUnavailable extends Schema.TaggedError<FrontPageUnavailable>()(
  "FrontPageUnavailable",
  { failed: Schema.Int },
) {
  override get message() {
    return `Could not load any front page story (${this.failed} requests failed)`;
  }
}
