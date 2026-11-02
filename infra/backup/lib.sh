# shellcheck shell=bash
# Shared helpers for the backup, restore and drill scripts. Sourced, never run.
#
# Exit codes used by every script:
#   0 success
#   1 a step failed while running
#   2 bad usage or missing configuration
#   3 a safety check refused to continue

readonly EXIT_FAILED=1
readonly EXIT_USAGE=2
readonly EXIT_REFUSED=3

log() {
	printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-backup}" "$*" >&2
}

die() {
	local code="$1"
	shift
	log "ERROR: $*"
	exit "$code"
}

# Reads KEY=VALUE lines without evaluating them, so a value containing `$` or
# backticks is taken literally. Variables already set in the environment win.
load_env_file() {
	local file="$1" line key value
	[[ -f "$file" ]] || die "$EXIT_USAGE" "env file not found: $file"
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
		key="${BASH_REMATCH[1]}"
		value="${BASH_REMATCH[2]}"
		if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
			value="${BASH_REMATCH[1]}"
		fi
		if [[ -z "${!key+x}" ]]; then
			printf -v "$key" '%s' "$value"
			# shellcheck disable=SC2163
			export "$key"
		fi
	done <"$file"
}

# Names only: values never reach the log.
require_vars() {
	local missing=() name
	for name in "$@"; do
		[[ -n "${!name:-}" ]] || missing+=("$name")
	done
	((${#missing[@]} == 0)) || die "$EXIT_USAGE" "missing required variables: ${missing[*]}"
}

require_cmds() {
	local missing=() cmd
	for cmd in "$@"; do
		command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
	done
	((${#missing[@]} == 0)) || die "$EXIT_USAGE" "missing required commands: ${missing[*]}"
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

file_bytes() {
	wc -c <"$1" | tr -d '[:space:]'
}

utc_now() {
	date -u +%Y-%m-%dT%H:%M:%SZ
}

epoch_of() {
	# GNU date first, BSD date as the fallback.
	date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s
}

# Splits GEO_OBJECT_STORE_URL (https://host[:port]/bucket[/prefix]) and exposes it
# to rclone as the remote "$1" through environment variables, so no rclone config
# file holding the keys is written to disk. BACKUP_OBJECT_STORE_ENDPOINT overrides
# the host when the scripts run outside the compose network.
configure_object_remote() {
	local remote="$1" url="$2" access="$3" secret="$4" endpoint_override="${5:-}"
	local upper rest scheme hostport path
	[[ "$url" =~ ^(https?)://([^/]+)/(.+)$ ]] || die "$EXIT_USAGE" "object store URL must look like https://host/bucket[/prefix]"
	scheme="${BASH_REMATCH[1]}"
	hostport="${BASH_REMATCH[2]}"
	path="${BASH_REMATCH[3]%/}"
	rest="${endpoint_override:-$scheme://$hostport}"
	upper="$(printf '%s' "$remote" | tr '[:lower:]' '[:upper:]')"
	export "RCLONE_CONFIG_${upper}_TYPE=s3"
	export "RCLONE_CONFIG_${upper}_PROVIDER=Other"
	export "RCLONE_CONFIG_${upper}_ENDPOINT=$rest"
	export "RCLONE_CONFIG_${upper}_ACCESS_KEY_ID=$access"
	export "RCLONE_CONFIG_${upper}_SECRET_ACCESS_KEY=$secret"
	export "RCLONE_CONFIG_${upper}_REGION=${GEO_OBJECT_STORE_REGION:-us-east-1}"
	export "RCLONE_CONFIG_${upper}_FORCE_PATH_STYLE=true"
	OBJECT_REMOTE_PATH="$remote:$path"
}

# Best effort: the table arrives with a later migration, and a backup must not
# fail just because its status row cannot be written.
record_backup_run() {
	local database_url="$1" kind="$2" status="$3" started="$4" finished="$5"
	local db_bytes="${6:-}" object_count="${7:-}" offsite="${8:-false}" duration="${9:-}" location="${10:-}" message="${11:-}"
	if ! command -v psql >/dev/null 2>&1; then
		log "warning: psql not found, run not recorded in geo_backup_runs"
		return 0
	fi
	if ! psql "$database_url" -X -q -v ON_ERROR_STOP=1 \
		-v kind="$kind" -v status="$status" -v started="$started" -v finished="$finished" \
		-v db_bytes="$db_bytes" -v object_count="$object_count" -v offsite="$offsite" \
		-v duration="$duration" -v location="$location" -v host="$(hostname)" -v message="$message" \
		>/dev/null 2>&1 <<'SQL'; then
INSERT INTO geo_backup_runs
	(kind, status, started_at, finished_at, database_bytes, object_count, offsite_copied,
	 duration_seconds, location, host, message)
VALUES
	(:'kind', :'status', :'started'::timestamptz, :'finished'::timestamptz,
	 NULLIF(:'db_bytes', '')::bigint, NULLIF(:'object_count', '')::integer, :'offsite'::boolean,
	 NULLIF(:'duration', '')::integer, NULLIF(:'location', ''), NULLIF(:'host', ''), NULLIF(:'message', ''));
SQL
		log "warning: could not record the run in geo_backup_runs (table missing or database unreachable)"
	fi
}

# pg_dump refuses a newer server, so this fails early with a clear message instead.
check_pg_client_version() {
	local database_url="$1" server client
	server="$(psql "$database_url" -X -At -c 'SHOW server_version_num' 2>/dev/null)" ||
		die "$EXIT_FAILED" "cannot connect to the source database"
	client="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
	((client >= server / 10000)) ||
		die "$EXIT_USAGE" "pg_dump major version $client is older than the server ($((server / 10000))); install a matching client"
}

# Comparison key for a postgres URL: host, port and database, without the credentials.
database_identity() {
	local url="$1"
	url="${url#*://}"
	url="${url#*@}"
	url="${url%%\?*}"
	local hostport="${url%%/*}" db="${url#*/}"
	[[ "$hostport" == *:* ]] || hostport="$hostport:5432"
	printf '%s/%s' "$(printf '%s' "$hostport" | tr '[:upper:]' '[:lower:]')" "$db"
}
