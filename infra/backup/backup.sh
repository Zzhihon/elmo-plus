#!/usr/bin/env bash
# Backs up PostgreSQL and the GEO object store into one encrypted bundle, copies
# it off site and records the run in geo_backup_runs.
#
#   BACKUP_ENV_FILE=/opt/elmo/.env infra/backup/backup.sh            # daily
#   BACKUP_KIND=PRE_MIGRATION infra/backup/backup.sh                  # see pre-migrate.sh
#
# Bundle layout, under $BACKUP_DIR/<UTC timestamp>-<kind>/:
#   database.dump.age   pg_dump custom format, encrypted to BACKUP_AGE_RECIPIENT
#   objects.tar.age     mirror of the GEO bucket, encrypted the same way
#   manifest.txt        kind, timestamps, sizes and sha256 of both files (no secrets)
#
# Encryption uses age with a public recipient key, so this host can write backups
# but cannot read them; the private identity is kept off this machine.
set -euo pipefail

SCRIPT_NAME="backup"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
source "$SCRIPT_DIR/lib.sh"

[[ -n "${BACKUP_ENV_FILE:-}" ]] && load_env_file "$BACKUP_ENV_FILE"

BACKUP_KIND="${BACKUP_KIND:-DAILY}"
case "$BACKUP_KIND" in
DAILY | PRE_MIGRATION) ;;
*) die "$EXIT_USAGE" "BACKUP_KIND must be DAILY or PRE_MIGRATION" ;;
esac

require_vars BACKUP_DIR BACKUP_AGE_RECIPIENT GEO_OBJECT_STORE_URL GEO_OBJECT_STORE_ACCESS_KEY GEO_OBJECT_STORE_SECRET_KEY
require_cmds pg_dump psql age rclone tar
# The compose DATABASE_URL names the in-network host; the host-side scripts can be pointed elsewhere.
SOURCE_DATABASE_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
[[ -n "$SOURCE_DATABASE_URL" ]] || die "$EXIT_USAGE" "missing required variables: BACKUP_DATABASE_URL or DATABASE_URL"
KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-7}"
[[ "$KEEP_LOCAL" =~ ^[1-9][0-9]*$ ]] || die "$EXIT_USAGE" "BACKUP_KEEP_LOCAL must be a positive integer"

STARTED_AT="$(utc_now)"
STARTED_EPOCH="$(date -u +%s)"
BUNDLE_NAME="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$BACKUP_KIND" | tr '[:upper:]_' '[:lower:]-')"
BUNDLE="$BACKUP_DIR/$BUNDLE_NAME"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/elmo-backup.XXXXXX")"
DB_BYTES=""
OBJECT_COUNT=""
OFFSITE="false"
LOCATION="local:$BUNDLE_NAME"

cleanup() {
	rm -rf "$WORK"
}

on_exit() {
	local code=$?
	cleanup
	if ((code != 0)); then
		local finished
		finished="$(utc_now)"
		record_backup_run "$SOURCE_DATABASE_URL" "$BACKUP_KIND" FAILED "$STARTED_AT" "$finished" \
			"$DB_BYTES" "$OBJECT_COUNT" "$OFFSITE" "$(($(date -u +%s) - STARTED_EPOCH))" "$LOCATION" "exit code $code"
		rm -rf "$BUNDLE.partial"
	fi
}
trap on_exit EXIT

umask 077
mkdir -p "$BACKUP_DIR" "$BUNDLE.partial"

log "checking client tools against the server"
check_pg_client_version "$SOURCE_DATABASE_URL"

log "dumping the database"
pg_dump --format=custom --no-owner --no-privileges --dbname="$SOURCE_DATABASE_URL" --file="$WORK/database.dump" ||
	die "$EXIT_FAILED" "pg_dump failed"
DB_BYTES="$(file_bytes "$WORK/database.dump")"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$BUNDLE.partial/database.dump.age" "$WORK/database.dump" ||
	die "$EXIT_FAILED" "encrypting the database dump failed"
rm -f "$WORK/database.dump"

log "mirroring the object store"
configure_object_remote geosrc "$GEO_OBJECT_STORE_URL" "$GEO_OBJECT_STORE_ACCESS_KEY" "$GEO_OBJECT_STORE_SECRET_KEY" \
	"${BACKUP_OBJECT_STORE_ENDPOINT:-}"
mkdir -p "$WORK/objects"
rclone copy --quiet "$OBJECT_REMOTE_PATH" "$WORK/objects" || die "$EXIT_FAILED" "copying the object store failed"
OBJECT_COUNT="$(find "$WORK/objects" -type f | wc -l | tr -d '[:space:]')"
tar -C "$WORK/objects" -cf - . | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$BUNDLE.partial/objects.tar.age" ||
	die "$EXIT_FAILED" "encrypting the object archive failed"
rm -rf "$WORK/objects"

{
	printf 'kind=%s\n' "$BACKUP_KIND"
	printf 'created_at=%s\n' "$STARTED_AT"
	printf 'pg_dump_version=%s\n' "$(pg_dump --version)"
	printf 'database_bytes=%s\n' "$DB_BYTES"
	printf 'object_count=%s\n' "$OBJECT_COUNT"
	printf 'sha256 database.dump.age %s\n' "$(sha256_of "$BUNDLE.partial/database.dump.age")"
	printf 'sha256 objects.tar.age %s\n' "$(sha256_of "$BUNDLE.partial/objects.tar.age")"
} >"$BUNDLE.partial/manifest.txt"
mv "$BUNDLE.partial" "$BUNDLE"

if [[ -n "${BACKUP_OFFSITE_REMOTE:-}" ]]; then
	log "copying the bundle off site"
	rclone copy --quiet "$BUNDLE" "${BACKUP_OFFSITE_REMOTE%/}/$BUNDLE_NAME" || die "$EXIT_FAILED" "off-site copy failed"
	OFFSITE="true"
	LOCATION="offsite:$BUNDLE_NAME"
elif [[ "$BACKUP_KIND" == "DAILY" ]]; then
	log "warning: BACKUP_OFFSITE_REMOTE is not set; this bundle exists on this host only"
fi

if [[ "$BACKUP_KIND" == "DAILY" ]]; then
	# Newest first; the bundle just written is always kept.
	mapfile -t OLD < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '*-daily' | sort -r | tail -n "+$((KEEP_LOCAL + 1))")
	for dir in "${OLD[@]}"; do
		log "pruning local bundle $(basename "$dir")"
		rm -rf "$dir"
	done
fi

FINISHED_AT="$(utc_now)"
record_backup_run "$SOURCE_DATABASE_URL" "$BACKUP_KIND" SUCCEEDED "$STARTED_AT" "$FINISHED_AT" \
	"$DB_BYTES" "$OBJECT_COUNT" "$OFFSITE" "$(($(date -u +%s) - STARTED_EPOCH))" "$LOCATION" ""
log "backup complete: $BUNDLE_NAME (offsite=$OFFSITE)"
printf '%s\n' "$BUNDLE"
