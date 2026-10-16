#!/usr/bin/env bash
#
# state-preserve.sh - carry the controller state (phase + setpoints) of a RUNNING
# bridge into the persistent bind-mount used by the new container.
#
# Run this BEFORE `docker compose up -d --build`. While the old bridge is still
# running, its /app/climate_state.json is the only copy of the active phase; once
# the container is recreated without a mount, that file is gone and the controller
# would silently fall back to the default phase (fruiting) and drive the equipment.
#
# Usage:
#   ./state-preserve.sh                    # copy the live state into bridge/state/
#   ./state-preserve.sh --default-mode manual
#                                          # nothing to copy: seed this phase
#   ./state-preserve.sh --print            # only show what would be written (read-only)
#
# Precedence: state of the running bridge container, then an existing
# bridge/state/climate_state.json, then --default-mode. A valid existing file is
# never replaced by --default-mode.
#
# Every candidate is validated with a REAL JSON parser (the same contract the
# bridge applies): `node`, `python3`/`python` or `jq` on the host, otherwise
# `node` inside the running bridge image. The file must be a JSON object whose
# "mode" is one of the phases the controller can restore (incubation, pinning,
# fruiting, manual); a truncated file or an unknown phase is rejected, because
# the bridge would silently keep its current phase instead.
#
# A broken file rejected during a real run is moved to
# climate_state.json.invalid-<timestamp> so the new container cannot pick it
# up. --print only reports: it never writes, moves or deletes anything.
#
set -euo pipefail

cd "$(dirname "$0")"

STATE_DIR="bridge/state"
STATE_FILE="$STATE_DIR/climate_state.json"
CONTAINER_STATE="/app/climate_state.json"
ALLOWED_MODES="incubation pinning fruiting manual"
DEFAULT_MODE=""
PRINT_ONLY="0"

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --default-mode)
      DEFAULT_MODE="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"
      if [ -z "$DEFAULT_MODE" ]; then
        echo "✖ --default-mode requires a phase id (${ALLOWED_MODES// /, })" >&2
        exit 2
      fi
      case " $ALLOWED_MODES " in
        *" $DEFAULT_MODE "*) ;;
        *)
          echo "✖ --default-mode \"$DEFAULT_MODE\" is not a known phase." >&2
          echo "  Allowed: ${ALLOWED_MODES// /, }" >&2
          exit 2
          ;;
      esac
      shift 2
      ;;
    --print)
      PRINT_ONLY="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "✖ Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# JSON validators - full parse plus exactly the checks the bridge relies on:
#   * top level must be an object
#   * "mode" must be one of the four phases the controller can restore
#     (anything else makes the bridge silently keep its previous phase)
#   * "profiles", when present, must be an object
# They read a file path or "-" for stdin, print "ok <mode>" and exit 0, or
# print "invalid <reason>" and exit 2.
# ---------------------------------------------------------------------------

NODE_VALIDATOR='
const fs = require("fs");
const target = process.argv[1];
const allowed = new Set(String(process.argv[2] || "").split(/\s+/).filter(Boolean));
const raw = (target === "-" || !target) ? fs.readFileSync(0, "utf8") : fs.readFileSync(target, "utf8");
let state;
try {
  state = JSON.parse(raw);
} catch (err) {
  console.log("invalid unparsable-json (" + err.message + ")");
  process.exit(2);
}
if (!state || typeof state !== "object" || Array.isArray(state)) {
  console.log("invalid not-an-object");
  process.exit(2);
}
if (typeof state.mode !== "string" || !allowed.has(state.mode)) {
  console.log("invalid unknown-mode (" + String(state.mode) + ")");
  process.exit(2);
}
if (state.profiles !== undefined && state.profiles !== null &&
    (typeof state.profiles !== "object" || Array.isArray(state.profiles))) {
  console.log("invalid bad-profiles");
  process.exit(2);
}
console.log("ok " + state.mode);
'

PY_VALIDATOR='
import json, sys
target = sys.argv[1]
allowed = set((sys.argv[2] if len(sys.argv) > 2 else "").split())
if target in ("-", "", None):
    raw = sys.stdin.read()
else:
    with open(target, encoding="utf-8") as handle:
        raw = handle.read()
try:
    state = json.loads(raw)
except Exception as exc:
    print("invalid unparsable-json (" + str(exc) + ")")
    sys.exit(2)
if not isinstance(state, dict):
    print("invalid not-an-object")
    sys.exit(2)
mode = state.get("mode")
if not isinstance(mode, str) or mode not in allowed:
    print("invalid unknown-mode (" + str(mode) + ")")
    sys.exit(2)
profiles = state.get("profiles")
if profiles is not None and not isinstance(profiles, dict):
    print("invalid bad-profiles")
    sys.exit(2)
print("ok " + mode)
'

JQ_PROGRAM='if (type != "object") then "invalid not-an-object"
  elif ((.mode | type) != "string") then "invalid unknown-mode (\(.mode))"
  elif (.mode as $m | ($allowed | split(" ") | index($m)) == null) then "invalid unknown-mode (\(.mode))"
  elif (.profiles != null and (.profiles | type) != "object") then "invalid bad-profiles"
  else "ok \(.mode)" end'

HOST_PARSER=""
if command -v node >/dev/null 2>&1; then HOST_PARSER="node"
elif command -v python3 >/dev/null 2>&1; then HOST_PARSER="python3"
elif command -v python >/dev/null 2>&1; then HOST_PARSER="python"
elif command -v jq >/dev/null 2>&1; then HOST_PARSER="jq"
fi

# validate_host <file|-> -> "ok <mode>" | "invalid <reason>"; exit code mirrors validity
validate_host() {
  local target="$1"
  case "$HOST_PARSER" in
    node)    node -e "$NODE_VALIDATOR" "$target" "$ALLOWED_MODES" ;;
    python3) python3 -c "$PY_VALIDATOR" "$target" "$ALLOWED_MODES" ;;
    python)  python -c "$PY_VALIDATOR" "$target" "$ALLOWED_MODES" ;;
    jq)
      local verdict
      if verdict="$(jq -r --arg allowed "$ALLOWED_MODES" "$JQ_PROGRAM" "$target" 2>/dev/null)" && [ -n "$verdict" ]; then
        printf '%s\n' "$verdict"
        case "$verdict" in ok\ *) return 0 ;; *) return 2 ;; esac
      fi
      echo "invalid unparsable-json (jq could not parse the content)"
      return 2
      ;;
    *)
      echo "invalid no-json-parser"
      return 2
      ;;
  esac
}

# ---------------------------------------------------------------------------
# docker compose availability
# ---------------------------------------------------------------------------

COMPOSE=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "  ! docker compose not available here - the running container cannot be read"
fi

container_running() {
  [ -n "$COMPOSE" ] && $COMPOSE ps --status running --services 2>/dev/null | grep -qx bridge
}

# Validates the state file *inside* the container with the image's own node
validate_in_container() {
  local out
  if out="$($COMPOSE exec -T bridge node -e "$NODE_VALIDATOR" "$CONTAINER_STATE" "$ALLOWED_MODES" 2>/dev/null)"; then
    printf '%s\n' "$out"
    return 0
  fi
  printf '%s\n' "${out:-invalid unreachable}"
  return 2
}

# ---------------------------------------------------------------------------
# Pick the source of truth
# ---------------------------------------------------------------------------

LIVE_STATE=""
SOURCE=""
SOURCE_KIND=""   # container | local | default (drives byte-exact copying below)
MODE=""
INVALID_REASONS=""

if container_running; then
  echo "→ Reading the active controller state from the running bridge..."
  if CONTAINER_RESULT="$(validate_in_container)"; then
    echo "  container state: $CONTAINER_RESULT"
    # Copy the exact bytes we validated and re-check them on the host when possible
    LIVE_STATE="$($COMPOSE exec -T bridge cat "$CONTAINER_STATE")"
    SOURCE="running bridge container"
    SOURCE_KIND="container"
    MODE="${CONTAINER_RESULT#ok }"
  else
    echo "  ! container state rejected: ${CONTAINER_RESULT#invalid }"
    INVALID_REASONS="$INVALID_REASONS
    - container $CONTAINER_STATE: ${CONTAINER_RESULT#invalid }"
  fi
else
  echo "→ No running bridge container, looking for a local state file..."
fi

if [ -z "$LIVE_STATE" ] && [ -f "$STATE_FILE" ]; then
  if HOST_RESULT="$(validate_host "$STATE_FILE")"; then
    echo "  existing $STATE_FILE: $HOST_RESULT"
    SOURCE="existing $STATE_FILE"
    SOURCE_KIND="local"
    LIVE_STATE="$(cat "$STATE_FILE")"
    MODE="${HOST_RESULT#ok }"
  else
    # A broken file left in place would be silently ignored by the bridge on the next
    # start, so it is moved aside - but never during --print (a preview must not
    # change anything on disk).
    if [ "$PRINT_ONLY" = "1" ]; then
      echo "  ! $STATE_FILE rejected (${HOST_RESULT#invalid }) - would be moved to $STATE_FILE.invalid-<timestamp>"
    else
      QUARANTINE="$STATE_FILE.invalid-$(date -u +%Y%m%d-%H%M%S)"
      n=1
      while [ -e "$QUARANTINE" ]; do
        QUARANTINE="$STATE_FILE.invalid-$(date -u +%Y%m%d-%H%M%S).$n"
        n=$((n + 1))
      done
      mv "$STATE_FILE" "$QUARANTINE"
      echo "  ! $STATE_FILE rejected (${HOST_RESULT#invalid }) and moved to $QUARANTINE"
    fi
    INVALID_REASONS="$INVALID_REASONS
    - $STATE_FILE: ${HOST_RESULT#invalid }"
  fi
fi

# Re-validate the exact bytes we are going to write, straight from stdin so that
# even a --print run touches nothing on disk.
if [ -n "$LIVE_STATE" ]; then
  if [ "$HOST_PARSER" != "" ]; then
    if ! COPY_RESULT="$(printf '%s\n' "$LIVE_STATE" | validate_host -)"; then
      echo "✖ The copied state failed host validation: ${COPY_RESULT#invalid }" >&2
      exit 1
    fi
    MODE="${COPY_RESULT#ok }"
  else
    # No host parser: the container-side validation above is the only check available
    # and the mode came from it.
    echo "  ! no host JSON parser (node/python3/jq) - relying on the container-side validation"
    if [ -z "$MODE" ]; then
      echo "✖ Cannot determine the phase of the copied state without a JSON parser." >&2
      exit 1
    fi
  fi
fi

if [ -z "$LIVE_STATE" ]; then
  if [ -n "$DEFAULT_MODE" ]; then
    LIVE_STATE="$(printf '{\n  "mode": "%s",\n  "profiles": {},\n  "saved_at": "%s"\n}\n' "$DEFAULT_MODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
    SOURCE="--default-mode $DEFAULT_MODE"
    SOURCE_KIND="default"
    MODE="$DEFAULT_MODE"
  else
    cat >&2 <<EOF
✖ No usable controller state.

  Looks for, in order:
    1. docker compose exec bridge node -e <json check> $CONTAINER_STATE
    2. $STATE_FILE   (validated with a real JSON parser)

  Accepted phases: ${ALLOWED_MODES// /, }
  Rejected sources:${INVALID_REASONS:- none found}

  The bridge writes that file only when the phase or setpoints change, so an
  untouched installation may legitimately have none.

  Choose one of the safe options before updating:
    a) the equipment is already off  -> ./state-preserve.sh --default-mode manual
    b) you know the current phase    -> ./state-preserve.sh --default-mode fruiting
    c) read it from the running bridge -> docker compose exec -T bridge cat $CONTAINER_STATE > $STATE_FILE

  Writing mode "manual" disables the automatic control until you pick a phase again.
EOF
    exit 1
  fi
fi

echo "  source: $SOURCE"
echo "  phase : $MODE"

if [ "$PRINT_ONLY" = "1" ]; then
  echo "  (--print: nothing was written)"
  printf '%s\n' "$LIVE_STATE"
  exit 0
fi

mkdir -p "$STATE_DIR"
# Same-directory temp file: `mv` is then an atomic rename and does not depend on /tmp
TMP_STATE="$STATE_DIR/.climate_state.json.tmp.$$"
case "$SOURCE_KIND" in
  local)
    # Byte-exact copy: no shell round-trip, no added trailing newline
    cp "$STATE_FILE" "$TMP_STATE"
    ;;
  container)
    $COMPOSE exec -T bridge cat "$CONTAINER_STATE" > "$TMP_STATE"
    ;;
  *)
    printf '%s\n' "$LIVE_STATE" > "$TMP_STATE"
    ;;
esac
mv "$TMP_STATE" "$STATE_FILE"
chmod 0644 "$STATE_FILE" 2>/dev/null || true

echo "✔ State written to $STATE_FILE"
echo "  The new bridge will start in phase \"$MODE\" (CLIMATE_STATE_FILE=/app/state/climate_state.json)."
echo "  Now run: docker compose up -d --build"
