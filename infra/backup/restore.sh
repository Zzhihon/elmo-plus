#!/usr/bin/env bash
# Restores one bundle written by backup.sh: verifies checksums, decrypts, restores
# the database into RESTORE_DATABASE_URL and the objects into
# RESTORE_OBJECT_STORE_URL, then runs read-only verification queries.
#
#   RESTORE_DATABASE_URL=postgres://...drill... BACKUP_AGE_IDENTITY_FILE=/secure/age.key \
#     infra/backup/restore.sh --bundle /var/backups/elmo/20260101T020000Z-daily
#
# Options:
#   --bundle <dir|name>              local bundle directory, or a bundle name with --fetch
#   --fetch                          download the named bundle from BACKUP_OFFSITE_REMOTE first
#   --skip-objects                   restore the database only
#   --i-understand-this-overwrites   allow the target to be the production database or bucket
set -euo pipefail

SCRIPT_NAME="restore"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
	sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit "$EXIT_USAGE"
}

BUNDLE_ARG=""
FETCH=false
SKIP_OBJECTS=false
OVERWRITE=false
while (($# > 0)); do
	case "$1" in
	--bundle)
		[[ $# -ge 2 ]] || usage
		BUNDLE_ARG="$2"
		shift 2
		;;
	--fetch) FETCH=true && shift ;;
	--skip-objects) SKIP_OBJECTS=true && shift ;;
	--i-understand-this-overwrites) OVERWRITE=true && shift ;;
	-h | --help) usage ;;
	*) die "$EXIT_USAGE" "unknown option: $1" ;;
	esac
done
[[ -n "$BUNDLE_ARG" ]] || usage

[[ -n "${BACKUP_ENV_FILE:-}" ]] && load_env_file "$BACKUP_ENV_FILE"
require_vars RESTORE_DATABASE_URL BACKUP_AGE_IDENTITY_FILE
require_cmds pg_restore psql age tar
[[ -r "$BACKUP_AGE_IDENTITY_FILE" ]] || die "$EXIT_USAGE" "BACKUP_AGE_IDENTITY_FILE is not readable"

PRODUCTION_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -n "$PRODUCTION_URL" && "$(database_identity "$RESTORE_DATABASE_URL")" == "$(database_identity "$PRODUCTION_URL")" ]]; then
	$OVERWRITE || die "$EXIT_REFUSED" "RESTORE_DATABASE_URL points at the production database; pass --i-understand-this-overwrites to continue"
	log "restoring over the production database as explicitly requested"
fi

if $FETCH; then
	require_vars BACKUP_DIR BACKUP_OFFSITE_REMOTE
	require_cmds rclone
	BUNDLE="$BACKUP_DIR/restore-$(basename "$BUNDLE_ARG")"
	log "fetching $(basename "$BUNDLE_ARG") from the off-site copy"
	rclone copy --quiet "${BACKUP_OFFSITE_REMOTE%/}/$(basename "$BUNDLE_ARG")" "$BUNDLE" || die "$EXIT_FAILED" "fetching the bundle failed"
else
	BUNDLE="$BUNDLE_ARG"
fi
[[ -f "$BUNDLE/manifest.txt" ]] || die "$EXIT_USAGE" "not a backup bundle: $BUNDLE"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/elmo-restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
umask 077

log "verifying checksums"
while read -r _ name expected; do
	actual="$(sha256_of "$BUNDLE/$name")"
	[[ "$actual" == "$expected" ]] || die "$EXIT_FAILED" "checksum mismatch for $name; the bundle is damaged or was altered"
done < <(grep '^sha256 ' "$BUNDLE/manifest.txt")

log "restoring the database"
age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$WORK/database.dump" "$BUNDLE/database.dump.age" ||
	die "$EXIT_FAILED" "decrypting the database dump failed"
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction \
	--dbname="$RESTORE_DATABASE_URL" "$WORK/database.dump" || die "$EXIT_FAILED" "pg_restore failed"
rm -f "$WORK/database.dump"

if ! $SKIP_OBJECTS; then
	require_vars RESTORE_OBJECT_STORE_URL RESTORE_OBJECT_STORE_ACCESS_KEY RESTORE_OBJECT_STORE_SECRET_KEY
	require_cmds rclone
	if [[ "${RESTORE_OBJECT_STORE_URL%/}" == "${GEO_OBJECT_STORE_URL:-}" ]]; then
		$OVERWRITE || die "$EXIT_REFUSED" "RESTORE_OBJECT_STORE_URL is the production bucket; pass --i-understand-this-overwrites to continue"
	fi
	log "restoring objects"
	mkdir -p "$WORK/objects"
	age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" "$BUNDLE/objects.tar.age" | tar -C "$WORK/objects" -xf - ||
		die "$EXIT_FAILED" "decrypting the object archive failed"
	configure_object_remote geodst "$RESTORE_OBJECT_STORE_URL" "$RESTORE_OBJECT_STORE_ACCESS_KEY" \
		"$RESTORE_OBJECT_STORE_SECRET_KEY" "${RESTORE_OBJECT_STORE_ENDPOINT:-}"
	rclone copy --quiet "$WORK/objects" "$OBJECT_REMOTE_PATH" || die "$EXIT_FAILED" "uploading objects failed"
	RESTORED_OBJECTS="$(find "$WORK/objects" -type f | wc -l | tr -d '[:space:]')"
	log "restored $RESTORED_OBJECTS objects (manifest: $(sed -n 's/^object_count=//p' "$BUNDLE/manifest.txt"))"
fi

log "running verification queries"
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' || die "$EXIT_FAILED" "verification queries failed"
SELECT 'organization' AS table_name, count(*) AS row_count, NULL::timestamptz AS newest FROM organization
UNION ALL SELECT 'geo_audit_logs', count(*), max(created_at) FROM geo_audit_logs
UNION ALL SELECT 'geo_observations', count(*), max(sampled_at) FROM geo_observations
UNION ALL SELECT 'geo_optimization_tasks', count(*), max(updated_at) FROM geo_optimization_tasks
UNION ALL SELECT 'geo_site_page_versions', count(*), max(fetched_at) FROM geo_site_page_versions
UNION ALL SELECT 'geo_knowledge_assertions', count(*), max(updated_at) FROM geo_knowledge_assertions;
SELECT count(*) AS applied_migrations FROM drizzle.__drizzle_migrations;
SQL

log "restore complete from $(basename "$BUNDLE") (backup taken $(sed -n 's/^created_at=//p' "$BUNDLE/manifest.txt"))"
