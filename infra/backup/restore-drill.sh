#!/usr/bin/env bash
# Restore drill: restores the newest daily bundle from the off-site copy into a
# separate drill database and bucket, times it, and writes a report.
#
#   RTO = wall-clock time from the start of the drill until verification passes.
#   RPO = drill start minus the time the restored backup was taken, i.e. the data
#         that would have been lost had production failed at the start of the drill.
#
# Targets: RPO <= 24h, RTO <= 4h (override with DRILL_RPO_TARGET_HOURS / DRILL_RTO_TARGET_HOURS).
#
#   BACKUP_ENV_FILE=/opt/elmo/.env RESTORE_DATABASE_URL=postgres://...drill... \
#     RESTORE_OBJECT_STORE_URL=... RESTORE_OBJECT_STORE_ACCESS_KEY=... RESTORE_OBJECT_STORE_SECRET_KEY=... \
#     BACKUP_AGE_IDENTITY_FILE=/secure/age.key infra/backup/restore-drill.sh
#
# The drill refuses production targets: restore.sh is called without the overwrite flag.
set -euo pipefail

SCRIPT_NAME="restore-drill"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
source "$SCRIPT_DIR/lib.sh"

[[ -n "${BACKUP_ENV_FILE:-}" ]] && load_env_file "$BACKUP_ENV_FILE"
require_vars BACKUP_DIR BACKUP_OFFSITE_REMOTE RESTORE_DATABASE_URL BACKUP_AGE_IDENTITY_FILE
require_cmds rclone
RECORD_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
RPO_TARGET_HOURS="${DRILL_RPO_TARGET_HOURS:-24}"
RTO_TARGET_HOURS="${DRILL_RTO_TARGET_HOURS:-4}"

STARTED_AT="$(utc_now)"
STARTED_EPOCH="$(date -u +%s)"

LATEST="$(rclone lsf --dirs-only "${BACKUP_OFFSITE_REMOTE%/}/" | sed 's:/$::' | grep -- '-daily$' | sort | tail -n 1)" ||
	die "$EXIT_FAILED" "listing the off-site copies failed"
[[ -n "$LATEST" ]] || die "$EXIT_FAILED" "no daily bundle found off site"
log "drilling with off-site bundle $LATEST"

STATUS=SUCCEEDED
MESSAGE=""
if ! "$SCRIPT_DIR/restore.sh" --fetch --bundle "$LATEST"; then
	STATUS=FAILED
	MESSAGE="restore failed"
fi

FINISHED_AT="$(utc_now)"
DURATION=$(($(date -u +%s) - STARTED_EPOCH))
BACKUP_TAKEN="$(sed -n 's/^created_at=//p' "$BACKUP_DIR/restore-$LATEST/manifest.txt" 2>/dev/null || true)"
RPO_SECONDS=""
[[ -n "$BACKUP_TAKEN" ]] && RPO_SECONDS=$((STARTED_EPOCH - $(epoch_of "$BACKUP_TAKEN")))

verdict() {
	local seconds="$1" hours="$2"
	if [[ -z "$seconds" ]]; then printf 'unknown'; elif ((seconds <= hours * 3600)); then printf 'PASS'; else printf 'FAIL'; fi
}
RTO_VERDICT="$(verdict "$DURATION" "$RTO_TARGET_HOURS")"
RPO_VERDICT="$(verdict "$RPO_SECONDS" "$RPO_TARGET_HOURS")"
[[ "$STATUS" == SUCCEEDED ]] || RTO_VERDICT=FAIL
if [[ "$RTO_VERDICT" != PASS || "$RPO_VERDICT" != PASS ]]; then
	STATUS=FAILED
	MESSAGE="${MESSAGE:-target missed} (RTO $RTO_VERDICT, RPO $RPO_VERDICT)"
fi

mkdir -p "$BACKUP_DIR/drill-reports"
REPORT="$BACKUP_DIR/drill-reports/$(date -u +%Y%m%dT%H%M%SZ).md"
cat >"$REPORT" <<EOF
# Restore drill $STARTED_AT

| Item | Value |
| --- | --- |
| Bundle | $LATEST |
| Backup taken | ${BACKUP_TAKEN:-unknown} |
| Drill started | $STARTED_AT |
| Drill finished | $FINISHED_AT |
| RTO (restore + verification) | ${DURATION}s, target ${RTO_TARGET_HOURS}h: $RTO_VERDICT |
| RPO (drill start - backup taken) | ${RPO_SECONDS:-unknown}s, target ${RPO_TARGET_HOURS}h: $RPO_VERDICT |
| Result | $STATUS |
| Operator | ${DRILL_OPERATOR:-unspecified} |
| Host | $(hostname) |

Attach the verification query output printed by restore.sh and a screenshot of
the restored workspace signing in, then file this report with the acceptance record.
EOF

if [[ -n "$RECORD_URL" ]]; then
	record_backup_run "$RECORD_URL" RESTORE_DRILL "$STATUS" "$STARTED_AT" "$FINISHED_AT" "" "" true "$DURATION" \
		"drill:$LATEST" "RPO ${RPO_SECONDS:-unknown}s; ${MESSAGE:-targets met}"
fi

log "report written to $REPORT"
[[ "$STATUS" == SUCCEEDED ]] || die "$EXIT_FAILED" "drill did not meet its targets: $MESSAGE"
log "drill passed: RTO ${DURATION}s, RPO ${RPO_SECONDS}s"
