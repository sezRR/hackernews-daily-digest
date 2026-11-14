# Run these on the VPS, from the project folder. Plain `make` lists the commands.
#
# The cron schedule comes from CRON_SCHEDULE in .env (every 30 minutes if unset). A value on
# the command line wins:  make cron-set SCHEDULE='*/15 * * * *'
# Keep it at least every 30 minutes: each run checks whether the digest is due and retries
# failures, so a sparser schedule sends late.

# Only these keys are read out of .env. Including the whole file would make `make` interpret
# any "$" or "#" in the secrets. Surrounding quotes are dropped.
env = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -1 | tr -d "\"'")

SCHEDULE ?= $(or $(call env,CRON_SCHEDULE),*/30 * * * *)
LOG      ?= $(CURDIR)/logs/digest.log
LINES    ?= 50

# Cron's PATH is minimal, so the line uses docker's full path.
DOCKER  := $(or $(shell command -v docker 2>/dev/null),/usr/bin/docker)
COMPOSE := $(DOCKER) compose

# Marks our line in the crontab so cron-set can replace it instead of adding a duplicate.
TAG := hn-digest-cron

# The trailing "# TAG" is a shell comment: cron hands the whole command to sh.
# --progress quiet keeps Compose's "Container ... Creating" lines out of the log.
CRON_LINE = $(SCHEDULE) cd $(CURDIR) && $(COMPOSE) --progress quiet run --rm -T digest >> $(LOG) 2>&1 \# $(TAG)

.PHONY: help deploy start stop restart status run send-now cron-set cron-list cron-remove \
	logs logs-digest logs-replies errors

# First target, so it is what a bare `make` runs. It prints every target that has a "## text".
help: ## Show this list
	@awk -F ':.*## ' '/^[a-z-]+:.*## / { printf "  make %-14s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

deploy: ## Pull the latest code (if this is a git checkout), rebuild, restart the reply reader
	@if [ -d .git ]; then git pull --ff-only; fi
	$(COMPOSE) build
	$(COMPOSE) up -d replies

start: ## Start the reply reader in the background
	$(COMPOSE) up -d replies

stop: ## Stop the reply reader. The cron digest keeps running.
	$(COMPOSE) stop replies

restart: ## Restart the reply reader, e.g. after editing .env
	$(COMPOSE) up -d --force-recreate replies

status: ## Reply reader state, the cron entry, and the last digest runs
	@$(COMPOSE) ps replies
	@echo
	@echo 'Cron entry:'
	@crontab -l 2>/dev/null | grep -F '$(TAG)' || echo '  none. Run make cron-set.'
	@echo
	@echo 'Last digest runs ($(LOG)):'
	@tail -n 5 '$(LOG)' 2>/dev/null || echo '  no log yet.'

run: ## One cron run now: sends only if due and not sent yet. Output to the terminal.
	$(COMPOSE) run --rm digest

send-now: ## Send today's digest now, whatever the time. Does nothing if already sent today.
	$(COMPOSE) run --rm digest node dist/run-digest.js --now

cron-set: ## Install (or replace) the crontab entry that runs the digest
	@mkdir -p '$(dir $(LOG))'
	@( crontab -l 2>/dev/null | grep -vF '$(TAG)'; echo '$(CRON_LINE)' ) | crontab -
	@echo 'Installed:'
	@crontab -l | grep -F '$(TAG)'

cron-list: ## Show the current user's crontab
	@crontab -l 2>/dev/null || echo 'No crontab for $(shell whoami).'

cron-remove: ## Remove the crontab entry
	@( crontab -l 2>/dev/null | grep -vF '$(TAG)' ) | crontab -
	@echo 'Removed the $(TAG) entry.'

logs: ## Recent lines from both the digest and the reply reader
	@echo '== digest ($(LOG))'
	@tail -n $(LINES) '$(LOG)' 2>/dev/null || echo 'No digest log yet. It appears after the first cron run.'
	@echo
	@echo '== replies'
	@$(COMPOSE) logs --no-log-prefix --tail $(LINES) replies

logs-digest: ## Follow the digest log as cron writes it (Ctrl-C to stop)
	@mkdir -p '$(dir $(LOG))' && touch '$(LOG)'
	tail -n $(LINES) -F '$(LOG)'

logs-replies: ## Follow the reply reader's log (Ctrl-C to stop)
	$(COMPOSE) logs --no-log-prefix --tail $(LINES) -f replies

errors: ## Only warnings and errors, from both logs
	@echo '== digest'
	@grep -E ' (WARN|ERROR|FATAL) ' '$(LOG)' 2>/dev/null | tail -n $(LINES) || true
	@echo
	@echo '== replies'
	@$(COMPOSE) logs --no-log-prefix replies 2>/dev/null | grep -E ' (WARN|ERROR|FATAL) ' | tail -n $(LINES) || true
