#!/bin/sh
# Installs, shows or removes this project's crontab entry. Run through make:
#   make cron-set | cron-list | cron-remove
#
# The digest runs once a day at DIGEST_TIME in DIGEST_TIMEZONE. Cron reads times in the
# server's time zone, so when the two differ the entry is preceded by CRON_TZ, which tells
# cron which zone to use (daylight saving included). Not every cron supports it: Debian and
# Ubuntu's default cron ignores CRON_TZ, and would then run an hour off in summer. So this
# checks first, and refuses with instructions rather than install a wrong schedule.
set -eu

: "${TAG:?}" "${TIME:?}" "${ZONE:?}" "${LOG:?}" "${DIR:?}" "${DOCKER:?}"
BEGIN="# >>> $TAG"
END="# <<< $TAG"

current() { crontab -l 2>/dev/null || true; }

# Everything except our block, and except single tagged lines older versions installed.
others() { current | sed "/^$BEGIN\$/,/^$END\$/d" | grep -vF "$TAG" || true; }

ours() { current | sed -n "/^$BEGIN\$/,/^$END\$/p"; }

# The many names of UTC count as one.
normalize() {
  case "$1" in
    UTC | UCT | GMT | Universal | Zulu | Etc/UTC | Etc/UCT | Etc/GMT | Etc/Universal | Etc/Zulu) echo UTC ;;
    *) echo "$1" ;;
  esac
}

# SERVER_ZONE and CRON_BINARIES override detection, for testing this script.
server_zone() {
  if [ -n "${SERVER_ZONE:-}" ]; then echo "$SERVER_ZONE"; return; fi
  zone=""
  if command -v timedatectl >/dev/null 2>&1; then
    zone=$(timedatectl show -p Timezone --value 2>/dev/null || true)
  fi
  if [ -z "$zone" ] && [ -r /etc/timezone ]; then zone=$(cat /etc/timezone); fi
  if [ -z "$zone" ]; then zone=$(readlink /etc/localtime 2>/dev/null | sed 's#.*zoneinfo/##' || true); fi
  echo "${zone:-UTC}"
}

# cronie (Fedora, RHEL, Arch, Alpine's cronie) knows CRON_TZ, and its binary says so.
cron_supports_tz() {
  for binary in ${CRON_BINARIES:-/usr/sbin/crond /usr/sbin/cron /usr/bin/crond /usr/bin/cron}; do
    if [ -r "$binary" ] && grep -aq CRON_TZ "$binary"; then return 0; fi
  done
  return 1
}

set_entry() {
  case "$TIME" in
    [0-2][0-9]:[0-5][0-9]) ;;
    *) echo "DIGEST_TIME must be HH:MM, got '$TIME'." >&2; exit 1 ;;
  esac
  hour=$(expr "${TIME%%:*}" + 0)
  minute=$(expr "${TIME#*:}" + 0)
  job="$minute $hour * * * cd $DIR && $DOCKER compose --progress quiet run --rm -T digest node dist/run-digest.js --scheduled >> $LOG 2>&1"
  server=$(server_zone)

  if [ "$(normalize "$server")" = "$(normalize "$ZONE")" ]; then
    entry=$(printf '%s\n%s\n%s' "$BEGIN" "$job" "$END")
  elif cron_supports_tz; then
    # The second CRON_TZ puts the server's zone back for any line added after ours.
    entry=$(printf '%s\nCRON_TZ=%s\n%s\nCRON_TZ=%s\n%s' "$BEGIN" "$ZONE" "$job" "$server" "$END")
  else
    cat >&2 <<MSG
This server's time zone is $server, but the digest should go out at $TIME $ZONE.
Its cron doesn't support CRON_TZ, so it can only run jobs in the server's own time zone.
Set the server's time zone, then run make cron-set again:

  sudo timedatectl set-timezone $ZONE

Nothing was installed.
MSG
    exit 1
  fi

  # Built in full before installing, so crontab never reads and writes at once.
  updated=$(others)
  printf '%s%s\n' "${updated:+$updated
}" "$entry" | crontab -
  echo "Installed. The digest runs every day at $TIME $ZONE (server time zone: $server):"
  ours
}

case "${1:-}" in
  set) set_entry ;;
  list) if [ -n "$(ours)" ]; then ours; else echo "No $TAG entry. Run make cron-set."; fi ;;
  remove)
    updated=$(others)
    printf '%s' "${updated:+$updated
}" | crontab - && echo "Removed the $TAG entry."
    ;;
  *) echo "usage: $0 set|list|remove" >&2; exit 2 ;;
esac
