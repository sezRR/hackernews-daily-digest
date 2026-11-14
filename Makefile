# Run these on the VPS, from the project folder. Plain `make` lists the commands.
#
# Cron sends the digest once a day at DIGEST_TIME in DIGEST_TIMEZONE, both read from .env.
# Run `make cron-set` again after changing either.

# Only these keys are read out of .env. Including the whole file would make `make` interpret
# any "$" or "#" in the secrets. Surrounding quotes are dropped.
env = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -1 | tr -d "\"'")

TIME  := $(or $(call env,DIGEST_TIME),07:30)
ZONE  := $(or $(call env,DIGEST_TIMEZONE),UTC)
LINES ?= 50

# Where cron writes the digest log. Cron runs as you, not root, so `make log-file` creates it
# once with sudo and gives it to you. Override with LOG=... on the command line.
LOG ?= /var/log/hn-digest.log
ME  := $(shell id -un)

# Cron's PATH is minimal, so the entry uses docker's full path.
DOCKER  := $(or $(shell command -v docker 2>/dev/null),/usr/bin/docker)
COMPOSE := $(DOCKER) compose

# Marks our entry in the crontab so cron-set can replace it instead of adding a duplicate.
TAG := hn-digest-cron

CRON = TAG='$(TAG)' TIME='$(TIME)' ZONE='$(ZONE)' LOG='$(LOG)' DIR='$(CURDIR)' DOCKER='$(DOCKER)' \
	sh scripts/cron.sh

.PHONY: help deploy start stop restart status run log-file cron-set cron-list cron-remove \
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

stop: ## Stop the reply reader. The daily digest still runs from cron.
	$(COMPOSE) stop replies

restart: ## Restart the reply reader, e.g. after editing .env
	$(COMPOSE) up -d --force-recreate replies

status: ## Reply reader state, the cron entry, and the last digest log lines
	@$(COMPOSE) ps replies
	@echo
	@$(CRON) list
	@echo
	@echo 'Last digest log lines ($(LOG)):'
	@tail -n 8 '$(LOG)' 2>/dev/null || echo '  no log yet.'

run: ## Send a digest now, always. Doesn't count as today's: the scheduled one still goes out.
	$(COMPOSE) run --rm digest node dist/run-digest.js --manual

log-file: ## Create the digest log file, owned by you (asks for sudo the first time)
	@if [ -w '$(LOG)' ]; then \
		echo 'Log file ready: $(LOG)'; \
	elif [ -e '$(LOG)' ]; then \
		echo '$(LOG) exists but you cannot write to it. Giving it to $(ME) with sudo:'; \
		sudo chown '$(ME)':"$$(id -gn)" '$(LOG)'; \
	elif touch '$(LOG)' 2>/dev/null; then \
		echo 'Created $(LOG)'; \
	else \
		echo 'Creating $(LOG) with sudo, owned by $(ME):'; \
		sudo install -m 644 -o '$(ME)' -g "$$(id -gn)" /dev/null '$(LOG)'; \
	fi

cron-set: log-file ## Install (or replace) the daily crontab entry for DIGEST_TIME
	@$(CRON) set

cron-list: ## Show this project's crontab entry
	@$(CRON) list

cron-remove: ## Remove this project's crontab entry
	@$(CRON) remove

logs: ## Recent lines from both the digest and the reply reader
	@echo '== digest ($(LOG))'
	@tail -n $(LINES) '$(LOG)' 2>/dev/null || echo 'No digest log yet. It appears after the first cron run.'
	@echo
	@echo '== replies'
	@$(COMPOSE) logs --no-log-prefix --tail $(LINES) replies

logs-digest: ## Follow the digest log (Ctrl-C to stop)
	tail -n $(LINES) -F '$(LOG)'

logs-replies: ## Follow the reply reader's log (Ctrl-C to stop)
	$(COMPOSE) logs --no-log-prefix --tail $(LINES) -f replies

errors: ## Only warnings and errors, from both logs
	@echo '== digest'
	@grep -E ' (WARN|ERROR|FATAL) ' '$(LOG)' 2>/dev/null | tail -n $(LINES) || true
	@echo
	@echo '== replies'
	@$(COMPOSE) logs --no-log-prefix replies 2>/dev/null | grep -E ' (WARN|ERROR|FATAL) ' | tail -n $(LINES) || true
