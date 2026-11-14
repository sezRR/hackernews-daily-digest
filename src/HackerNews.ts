import {
  Cache,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import {
  type Comment,
  type CommentsParams,
  type FrontPage,
  FrontPageUnavailable,
  type FrontPageParams,
  HnRequestError,
  Item,
  type ItemSummary,
  ItemNotFound,
  type Thread,
} from "./domain.js";
import { htmlToText } from "./html.js";

const API_BASE = "https://hacker-news.firebaseio.com/v0";
const FRONT_PAGE_URL = "https://news.ycombinator.com/";
const ITEM_URL = "https://news.ycombinator.com/item?id=";
const USER_AGENT = "hackernews-mcp/0.1";
const FRONT_PAGE_SIZE = 30;
const MAX_CONCURRENT_REQUESTS = 16;
const ATTEMPT_TIMEOUT = Duration.seconds(10);
/** Covers every attempt and reading the body, which `HttpClient.timeout` does not. */
const REQUEST_TIMEOUT = Duration.seconds(35);
/** news.ycombinator.com/robots.txt asks for "Crawl-delay: 30". */
const RANKING_TTL = Duration.seconds(30);

interface CommentWalk {
  readonly limit: number;
  readonly depth: number;
  readonly repliesPerComment: number;
  readonly maxChars: number;
}

const isLive = (item: Item | null): item is Item =>
  item !== null && !item.deleted && !item.dead;

const isoTime = (seconds: number | undefined): string | null =>
  seconds === undefined
    ? null
    : DateTime.make(seconds * 1000).pipe(Option.map(DateTime.formatIso), Option.getOrNull);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const clip = (html: string, maxChars: number): { text: string; truncated?: true } => {
  const text = htmlToText(html);
  if (text.length <= maxChars) return { text };
  // A cut can split a surrogate pair, and JSON consumers may reject a lone surrogate.
  return { text: `${text.slice(0, maxChars).toWellFormed().trimEnd()}…`, truncated: true };
};

const summarize = (item: Item, maxChars: number): ItemSummary => {
  const hnUrl = `${ITEM_URL}${item.id}`;
  return {
    id: item.id,
    type: item.type ?? null,
    title: item.title ?? null,
    // Ask HN and similar posts have no external link; HN itself links them to the thread.
    url: item.url ?? hnUrl,
    hn_url: hnUrl,
    by: item.by ?? null,
    score: item.score ?? null,
    comment_count: item.descendants ?? null,
    time: isoTime(item.time),
    ...(item.text ? clip(item.text, maxChars) : {}),
  };
};

const parseFrontPageIds = (html: string): ReadonlyArray<number> =>
  Array.from(html.matchAll(/class="athing[^"]*" id="(\d+)"/g), (match) => Number(match[1]));

export class HackerNews extends Context.Service<
  HackerNews,
  {
    getFrontPage(
      params: FrontPageParams,
    ): Effect.Effect<FrontPage, HnRequestError | FrontPageUnavailable>;
    getComments(params: CommentsParams): Effect.Effect<Thread, HnRequestError | ItemNotFound>;
  }
>()("hackernews-mcp/HackerNews") {
  static readonly layerNoDeps = Layer.effect(
    HackerNews,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("user-agent", USER_AGENT)),
        HttpClient.filterStatusOk,
        HttpClient.timeout(ATTEMPT_TIMEOUT),
      );
      // The page client stays without retries so it never re-requests inside the crawl delay.
      const apiClient = client.pipe(
        HttpClient.retryTransient({ schedule: Schedule.exponential("100 millis"), times: 2 }),
      );
      const limiter = yield* Semaphore.make(MAX_CONCURRENT_REQUESTS);

      const send = <A, E extends { readonly message: string }>(
        url: string,
        request: Effect.Effect<A, E>,
      ): Effect.Effect<A, HnRequestError> =>
        request.pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) => new HnRequestError({ url, reason: cause.message })),
          limiter.withPermit,
        );

      const getItem = (id: number): Effect.Effect<Item | null, HnRequestError> => {
        const url = `${API_BASE}/item/${id}.json`;
        return send(
          url,
          apiClient
            .get(url)
            .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.NullOr(Item)))),
        );
      };

      /** Counts a failed fetch instead of failing the call, so partial results are reported. */
      const tryItem = (id: number, failures: Ref.Ref<number>): Effect.Effect<Item | null> =>
        getItem(id).pipe(
          Effect.catchTag("HnRequestError", (error) =>
            Effect.logWarning(error.message).pipe(
              Effect.andThen(Ref.update(failures, (count) => count + 1)),
              Effect.as(null),
            ),
          ),
        );

      /** Follows `ids` in HN's rank order, skipping removed comments so `limit` stays filled. */
      const loadComments = Effect.fnUntraced(function* (
        ids: ReadonlyArray<number>,
        walk: CommentWalk,
        failures: Ref.Ref<number>,
      ): Effect.fn.Return<ReadonlyArray<Comment>> {
        const live: Array<Item> = [];
        let next = 0;
        while (live.length < walk.limit && next < ids.length) {
          const batch = ids.slice(next, next + walk.limit - live.length);
          next += batch.length;
          const items = yield* Effect.forEach(batch, (id) => tryItem(id, failures), {
            concurrency: "unbounded",
          });
          live.push(...items.filter(isLive));
        }

        return yield* Effect.forEach(
          live,
          (item) => {
            const kids = item.kids ?? [];
            const comment: Comment = {
              id: item.id,
              by: item.by ?? null,
              time: isoTime(item.time),
              ...clip(item.text ?? "", walk.maxChars),
              reply_count: kids.length,
            };
            return walk.depth > 0 && kids.length > 0
              ? loadComments(
                  kids,
                  { ...walk, limit: walk.repliesPerComment, depth: walk.depth - 1 },
                  failures,
                ).pipe(Effect.map((replies) => ({ ...comment, replies })))
              : Effect.succeed(comment);
          },
          { concurrency: "unbounded" },
        );
      });

      const fetchPageIds = send(
        FRONT_PAGE_URL,
        client.get(FRONT_PAGE_URL).pipe(Effect.flatMap((response) => response.text)),
      ).pipe(
        Effect.map(parseFrontPageIds),
        Effect.filterOrFail(
          (ids) => ids.length > 0,
          () =>
            new HnRequestError({
              url: FRONT_PAGE_URL,
              reason: "no story rows found in the page markup",
            }),
        ),
      );

      // Failures expire at once, so an outage does not pin the fallback for the whole TTL.
      const pageIds = yield* Cache.makeWith((_: "front-page") => fetchPageIds, {
        capacity: 1,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? RANKING_TTL : Duration.zero),
      });

      const topStoriesUrl = `${API_BASE}/topstories.json`;
      const fetchTopStories = send(
        topStoriesUrl,
        apiClient
          .get(topStoriesUrl)
          .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(Schema.Int)))),
      );

      /**
       * The API's topstories order differs from the page for some stories, so the page is
       * the source of rank. The API list is the fallback if the page is unavailable or its
       * markup changes.
       */
      const ranking = Cache.get(pageIds, "front-page").pipe(
        Effect.map((ids) => ({ ids, source: "front_page_html" as const })),
        Effect.catchTag("HnRequestError", (error) =>
          Effect.logWarning(`Falling back to API ranking: ${error.message}`).pipe(
            Effect.andThen(fetchTopStories),
            Effect.map((ids) => ({
              ids: ids.slice(0, FRONT_PAGE_SIZE),
              source: "api_topstories" as const,
            })),
          ),
        ),
      );

      const getFrontPage = Effect.fn("HackerNews.getFrontPage")(function* (
        params: FrontPageParams,
      ) {
        const { ids, source } = yield* ranking;
        const failures = yield* Ref.make(0);
        const walk: CommentWalk = {
          limit: params.comments_per_story,
          depth: 0,
          repliesPerComment: 0,
          maxChars: params.max_comment_chars,
        };

        const stories = yield* Effect.forEach(
          ids.slice(0, params.limit),
          Effect.fnUntraced(function* (id, index) {
            const item = yield* tryItem(id, failures);
            if (!isLive(item)) return null;
            return {
              // Taken from the page position, so a story that failed to load leaves a visible gap.
              rank: index + 1,
              ...summarize(item, params.max_comment_chars),
              top_comments: yield* loadComments(item.kids ?? [], walk, failures),
            };
          }),
          { concurrency: "unbounded" },
        );

        const found = stories.filter(Predicate.isNotNull);
        const failed = yield* Ref.get(failures);
        if (found.length === 0 && failed > 0) {
          return yield* new FrontPageUnavailable({ failed });
        }
        return {
          fetched_at: yield* nowIso,
          ranking_source: source,
          failed_fetches: failed,
          stories: found,
        };
      });

      const getComments = Effect.fn("HackerNews.getComments")(function* (params: CommentsParams) {
        const item = yield* getItem(params.item_id);
        if (item === null) return yield* new ItemNotFound({ id: params.item_id });

        const failures = yield* Ref.make(0);
        const comments = yield* loadComments(
          item.kids ?? [],
          {
            limit: params.limit,
            depth: params.reply_depth,
            repliesPerComment: params.replies_per_comment,
            maxChars: params.max_comment_chars,
          },
          failures,
        );
        return {
          fetched_at: yield* nowIso,
          failed_fetches: yield* Ref.get(failures),
          item: summarize(item, params.max_comment_chars),
          comments,
        };
      });

      return HackerNews.of({ getFrontPage, getComments });
    }),
  );

  static readonly layer = HackerNews.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer));
}
