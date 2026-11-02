#!/usr/bin/env bash
# The backup that must succeed before any schema migration. It never migrates
# anything itself: on success it prints the command to run next.
#
#   BACKUP_ENV_FILE=/opt/elmo/.env infra/backup/pre-migrate.sh
set -euo pipefail

SCRIPT_NAME="pre-migrate"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/backup/lib.sh
source "$SCRIPT_DIR/lib.sh"

[[ -n "${BACKUP_ENV_FILE:-}" ]] && load_env_file "$BACKUP_ENV_FILE"

# A migration is only as recoverable as its last copy that left the machine.
[[ -n "${BACKUP_OFFSITE_REMOTE:-}" ]] ||
	die "$EXIT_REFUSED" "BACKUP_OFFSITE_REMOTE is not set; refusing to approve a migration without an off-site copy"

BUNDLE="$(BACKUP_KIND=PRE_MIGRATION "$SCRIPT_DIR/backup.sh")" ||
	die "$EXIT_FAILED" "pre-migration backup failed; do not migrate"

log "pre-migration backup ready: $(basename "$BUNDLE")"
cat <<EOF

Backup verified and copied off site. Next steps, in order:

  1. Stop the writers:   docker compose -f infra/compose/docker-compose.yml stop web worker
  2. Migrate:            docker compose -f infra/compose/docker-compose.yml run --rm db-migrate
  3. Start again:        docker compose -f infra/compose/docker-compose.yml up -d web worker

If step 2 fails, restore this bundle with:
  RESTORE_DATABASE_URL=<target> infra/backup/restore.sh --bundle $BUNDLE

EOF
