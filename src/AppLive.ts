import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Analyst } from "./Analyst.js";
import { AppConfig } from "./AppConfig.js";
import { ChatService } from "./ChatService.js";
import { DigestJob } from "./DigestJob.js";
import { HackerNews } from "./HackerNews.js";
import { Mailbox } from "./Mailbox.js";
import { Mailer, SmtpTransport } from "./Mailer.js";
import { Replies } from "./Replies.js";
import { Store } from "./Store.js";
import { ChatToolkitHandlers } from "./tools.js";

export const OpenAiModel = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    OpenAiLanguageModel.layer({
      model: config.model,
      // Nothing here needs to live on OpenAI's side: history is stored locally.
      config: { store: false },
    }),
  ),
).pipe(
  Layer.provide(
    OpenAiClient.layerConfig({ apiKey: Config.Redacted("OPENAI_API_KEY") }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
  ),
);

/** Sends through Gmail. The dev test swaps in a transport that marks subjects as tests. */
type Transport = Layer.Layer<SmtpTransport, never, AppConfig>;

const shared = (transport: Transport) =>
  Mailer.layerNoDeps.pipe(
    Layer.provideMerge(transport),
    Layer.provideMerge(HackerNews.layer),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(OpenAiModel),
    Layer.provideMerge(AppConfig.layer),
  );

/** Everything the digest job needs. Cron runs it as its own short-lived process. */
export const digestServices = (transport: Transport = SmtpTransport.gmail) =>
  DigestJob.layer.pipe(Layer.provideMerge(Analyst.layer), Layer.provideMerge(shared(transport)));

/** The long-running process that reads replies from the mailbox and answers them. */
export const replyServices = (transport: Transport = SmtpTransport.gmail) =>
  Replies.layer.pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(ChatToolkitHandlers),
    Layer.provideMerge(Mailbox.gmail),
    Layer.provideMerge(shared(transport)),
  );
