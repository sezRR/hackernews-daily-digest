# Hacker News digest

Every morning it reads the [Hacker News](https://news.ycombinator.com/) front page, summarizes what commenters think, flags anything important, and emails you the result from your Gmail account. Reply to the email with a question and the answer comes back in the same thread. It also includes an MCP server for asking about Hacker News from Claude Code.

Built with [Effect](https://effect.website/), SQLite, Gmail (SMTP and IMAP with an app password) and the OpenAI API (`gpt-6-luna`). Designed for one reader, run with Docker Compose on a VPS.

```
cron, every 30 min: due? → fetch stories → save comments → one model call, no tools → save → send
replies, always on: poll IMAP → reply to a digest, from you? → model + read-only HN tools → answer in thread
```

## Gmail setup

1. Turn on 2-Step Verification for the Google account, then create an app password at <https://myaccount.google.com/apppasswords>.
2. Put the account in `GMAIL_USER` and the 16-character password in `GMAIL_APP_PASSWORD`. Spaces are fine.

The digest is sent from `GMAIL_USER` to `DIGEST_TO`, which defaults to the same address. To keep the bot's mail out of your main inbox, give it its own Gmail account and set `DIGEST_TO` to your usual address.

## Deploy to a VPS

You need Docker with the Compose plugin, `make`, cron, and an OpenAI API key. No domain or open ports: the app only makes outgoing connections.

```sh
# 1. Copy the project to the server, then in its folder:
cp .env.example .env
chmod 600 .env
nano .env

# 2. Build, and start the reply reader.
make deploy

# 3. Send a digest now, to check the keys. It doesn't replace the scheduled one.
make run

# 4. Schedule the digest. Asks for sudo once, to create /var/log/hn-digest.log.
make cron-set
```

Cron starts the digest once a day at `DIGEST_TIME` in `DIGEST_TIMEZONE`, so with `07:30` and `Europe/Lisbon` it runs at 07:30 Lisbon time all year. The email arrives a minute or so later, after the model call. `make cron-set` builds the entry from those two settings:

- If the server's own time zone matches, the entry is a plain `30 7 * * *`.
- If it doesn't, the entry starts with `CRON_TZ=Europe/Lisbon`, which tells cron which zone to use. Only some versions of cron support this (cronie does), and `make cron-set` checks yours first. Debian and Ubuntu's default cron ignores it, which would make the digest an hour late in summer. On those systems `make cron-set` installs nothing and tells you to run `sudo timedatectl set-timezone Europe/Lisbon` first.

Every run also checks the clock. If cron ever starts it more than 5 minutes from `DIGEST_TIME`, the log gets a warning saying so.

Plain `make` lists every command:

| Command | What it does |
| --- | --- |
| `make deploy` | Pull (if it's a git checkout), rebuild, restart the reply reader |
| `make start` / `stop` / `restart` | Control the reply reader. Restart after editing `.env`. |
| `make status` | Reply reader state, the cron entry, and the last digest runs |
| `make run` | Send a digest of the front page as it is now, always. It doesn't count as today's: nothing is marked sent or seen, so the scheduled digest still goes out in full. Tried once, errors print to the terminal. Replies to it are answered. |
| `make cron-set` / `cron-list` / `cron-remove` | Manage the crontab entry. Other entries in your crontab are left alone. |
| `make log-file` | Create `/var/log/hn-digest.log`, owned by you. `cron-set` runs it for you. |
| `make logs` | Recent lines from both logs |
| `make logs-digest` / `logs-replies` | Follow one log live |
| `make errors` | Only warnings and errors, from both logs |

The database lives in the `data` Docker volume. It holds every digest and conversation, so include it in backups. Stopping the reader first makes SQLite write everything to the one file:

```sh
make stop
docker compose cp replies:/data/hackernews.db ./hackernews-backup.db
make start
```

## Logs

Every line has the date, time and offset in `DIGEST_TIMEZONE`, a level and the process name:

```
2026-11-14 07:30:01 +00:00 INFO  [digest] Digest 2026-11-14: starting at 07:30 Europe/Lisbon (cron). Up to 4 attempts, 30m apart.
2026-11-14 07:31:05 +00:00 INFO  [digest] Digest 2026-11-14: sent (21043 input, 1588 output tokens)
2026-11-14 09:12:16 +00:00 INFO  [replies] Answering a question about the 2026-11-14 digest
2026-11-14 09:12:40 +00:00 INFO  [replies] Sent a reply in the 2026-11-14 digest thread
2026-11-14 09:12:40 +00:00 INFO  [replies] Checked: 3 new emails, answered 1 reply
```

- **Digest:** cron appends to `/var/log/hn-digest.log`, a few lines a day, so it stays tiny. Cron runs as you, not root, so `make cron-set` creates the file once with sudo and makes you its owner. A day with no lines means cron didn't run. Put it elsewhere with `make cron-set LOG=/path/to/file`, and pass the same `LOG=` to the log commands.
- **Replies:** one line when the first check succeeds, one for every check that found new mail (`Checked: 2 new emails, no replies to answer`), and an hourly summary, so a quiet log still shows it's alive. Lines hold counts only, never senders or subjects. Docker keeps this log, rotated at 5 files of 10 MB.
- **Errors:** failures log at `WARN` or `ERROR` with the full cause, so `make errors` finds them. A wrong app password or API key shows up there first.

## Test locally

Requires Node 22.19 or newer.

```sh
pnpm install
cp .env.example .env   # fill in the same keys
pnpm dev:test          # build today's digest from the live front page and email it now
pnpm dev:test --sample # email a fixed sample digest: no Hacker News, no model call, free
pnpm dev:replies       # answer replies to the test emails until you press Ctrl-C
```

Test emails start with `[test]` and use a separate database, `data/dev.db`, which never touches the server's. Each `dev:test` run starts the day over, so it always sends, and today's stories aren't skipped as already sent. To test answers, reply to the latest test email and keep `pnpm dev:replies` running until the answer arrives. If the server's reader watches the same Gmail account, it ignores test emails: it doesn't know their Message-IDs.

`pnpm test` builds, type-checks and runs all tests. Stdio tests use the build, so don't run `vitest` alone after changing code.

## How it behaves

**The email.** An HTML email with a plain-text copy for mail apps that want one. It opens with the date and a one-paragraph overview, then "Worth knowing today", then each story. Each story shows its front-page rank, a bar for how busy its discussion is compared with the day's busiest, what it's about, what commenters think, and where they disagree. It follows the reader's light or dark mode in Apple Mail and iOS, and Gmail recolours it on its own. `pnpm dev:test --sample` sends one to check how it looks.

**Choosing stories.** Up to 10 stories per digest, in front page order. It skips stories already sent, job posts, threads under 10 comments, and threads under 3 hours old. All of these are settings.

**Token limits.** Each digest call is capped at `DIGEST_MAX_INPUT_TOKENS` (default 40,000) and `DIGEST_MAX_OUTPUT_TOKENS` (default 8,000, reasoning included). A typical day is about 20,000 input tokens, so the input cap only matters on days with very long threads. There's no tokenizer for the model locally, so input size is estimated at 3 characters per token, on the high side. When the prompt is over the limit, the lowest-ranked comments of the longest threads are left out first, and every story keeps at least its top comment. Output that hits its cap is cut off mid-JSON, so that attempt fails and the error says to raise the limit. With 4 attempts a day, the digest can't use more than about 200,000 tokens a day, around $0.03 at `gpt-6-luna` prices.

**Important stories.** The model lists the stories a busy reader shouldn't miss, such as a vulnerability to patch, a major outage, a significant release or a policy change. It can pick at most 3, and it's told to leave the list empty on a quiet day. They appear at the top under "Worth knowing today". Picks that don't match a story in the digest are dropped.

**Replies.** The reader checks the mailbox every `REPLY_POLL_SECONDS`. It reads Gmail's All Mail folder read-only, so it never marks anything as read, and it starts from the newest mail the first time it runs. Write your question above the quoted email: text below the quote is ignored. Each digest day is one conversation, so a follow-up remembers what you asked earlier about that day's stories. A digest with nothing new today still accepts questions. The model can use read-only Hacker News tools for up to 5 rounds per question.

**Failures.** Each stage of the digest is saved, so a retry continues where the last attempt stopped: a failed send doesn't pay for another model call. After a failure, the same run waits 30 minutes and tries again, up to 4 attempts. Then it emails you the error and stops until tomorrow. A retry reuses the same Message-ID, so if an earlier attempt did go out, Gmail usually drops the second copy.

**Missed runs.** If the server is down at `DIGEST_TIME`, that day's digest is skipped. `make run` sends one late. Because it's a manual send, its stories can turn up again in the next scheduled digest.

**Cost.** Once `CHAT_DAILY_TOKEN_LIMIT` is reached, replies get a short "budget used up" answer until midnight UTC. Digests don't count toward the limit.

**Prompt caching.** OpenAI caches prompts by default. For GPT-5.6 and later, writing to the cache costs 1.25× normal input, and reading from it costs 0.1×. The digest turns caching off (`prompt_cache_options.mode: "explicit"` with no breakpoints): it's one call a day on new comments, so a cached copy would never be read. Replies keep the default, since every tool round and follow-up within 30 minutes re-sends the same prompt. Cached input is stored separately in `token_usage` and counts as a tenth of a token against `CHAT_DAILY_TOKEN_LIMIT`.

**Ranking.** The API's `topstories` list holds the same stories as the front page but orders some differently, so rank is read from the page HTML and everything else from the [official API](https://github.com/HackerNews/API). If the page is unavailable, the digest uses `topstories` and says so. The page is read at most once every 30 seconds, following `Crawl-delay: 30` in HN's `robots.txt`.

## Security

Comments are public text that goes into a model, and anyone can write one aimed at it. Anyone can also email you. The design assumes both will be tried.

- **The digest model has no tools.** Injected text can skew a summary, and that's all it can do.
- **Only your replies get answered.** A reply must come from `DIGEST_TO` and cite a Message-ID the app generated. Those IDs are random and only ever sent to you, so a stranger can't guess one. If Gmail's DMARC check fails, the reply is rejected, which stops a forged From. Automatic replies are skipped. Rejected replies are logged, never answered.
- **Chat tools are read-only** and take only numbers and limits. A comment has no way to make the model send data anywhere.
- **Code sends all email.** The recipient comes from settings, and the mailer has no recipient parameter. Code builds every link. Answers may link to `news.ycombinator.com/item?id=<number>`, and every other URL the model writes is removed.
- **Email is rendered as text.** Model output is HTML-escaped and never rendered as Markdown or HTML.
- **The app password** can read and send all of that account's mail, so keep `.env` at `chmod 600`. A dedicated Gmail account for the bot limits what a leak exposes.

Injection can still produce a misleading summary or answer, so treat them as a starting point rather than fact.

## MCP server

The MCP server is separate from the digest and needs no settings or API keys.

**Claude Code, in this folder:** `.mcp.json` is already set up. Start `claude` here and approve the `hackernews` server.

**Claude Code, in every project:**

```sh
claude mcp add --scope user hackernews -- node "$PWD/dist/index.js"
```

| Tool | Returns |
| --- | --- |
| `get_front_page` | Front page stories in page order, with their top comments |
| `get_comments` | A thread with nested replies. Takes a story id, or a comment id to read its replies. |

Default `get_front_page` output is about 12k tokens. Raising limits can pass Claude Code's 25k-token default for MCP output, which `MAX_MCP_OUTPUT_TOKENS` raises.

## Upgrading Effect

`effect` and every `@effect/*` package are pinned to one exact version and must move together. The modules for AI and MCP are marked `@stability unstable`, so a minor release can change them. Run `pnpm test` after any upgrade.
