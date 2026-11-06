#!/usr/bin/env bash
# Golden output check for the cli.ts split (slice 01 of specs/split-cli-commands).
#
#   golden.sh capture   record stdout, stderr and exit code of each case into golden/
#   golden.sh check     rerun every case and diff against golden/; exit 1 on any change
#
# Runs the built binary (bin/brain.js -> dist/src/cli.js), so run `npm run compile`
# first. Everything happens in a throwaway home, state dir and vault, with the update
# check and telemetry off. Only values that differ run to run are normalized: the temp
# paths, the state-folder ID (a hash of the temp vault path), timestamps, file mtimes,
# timings, and the real date in new log file names. The machine name and the
# lifecycle date are pinned. Output is captured byte for byte, trailing newlines included. Anything else that differs is a real change.
set -u
cd "$(dirname "$0")/../.."
REPO=$(pwd)
OUT="$REPO/specs/split-cli-commands/golden"
MODE=${1:-}
case "$MODE" in capture|check) ;; *) echo "usage: golden.sh capture|check" >&2; exit 2 ;; esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
VAULT="$TMP/vault"
mkdir -p "$VAULT/.obsidian" "$VAULT/notes" "$VAULT/a" "$TMP/home" "$TMP/state"
printf -- '---\ntags: [ops]\naliases: [deploys]\n---\n# Deploy gotchas\n\n## Cache\npnpm cache breaks on the mac mini.\n\n## Links\n[[runbook]]\n' > "$VAULT/notes/deploy.md"
printf -- '# Runbook\nRestart the worker, then [[deploy]].\n' > "$VAULT/notes/runbook.md"
printf 'one\n' > "$VAULT/notes/dup.md"
printf 'two\n' > "$VAULT/a/dup.md"
printf -- '# Broken\nSee [[nowhere]].\n' > "$VAULT/notes/broken.md"

run_case() { # name, then brain args; CASE_CWD overrides the working folder (default: the vault)
  local name=$1; shift
  local code
  # stdout and stderr go straight to files, so trailing newlines are kept byte for byte.
  (cd "${CASE_CWD:-$VAULT}" && env -i PATH="$PATH" HOME="$TMP/home" BRAIN_STATE_DIR="$TMP/state" \
    BRAIN_NO_UPDATE_CHECK=1 BRAIN_TELEMETRY=0 BRAIN_VAULT="" BRAIN_MACHINE=golden BRAIN_TODAY=2026-01-15 CI=1 \
    node --no-warnings=ExperimentalWarning "$REPO/bin/brain.js" "$@" >"$TMP/stdout" 2>"$TMP/stderr")
  code=$?
  {
    printf '$ brain %s\n--- exit %s\n--- stdout\n' "$*" "$code"
    cat "$TMP/stdout"
    printf -- '<<END stdout>>\n--- stderr\n'
    cat "$TMP/stderr"
    printf -- '<<END stderr>>\n'
  } | sed -E \
      -e "s#$TMP#<TMP>#g" \
      -e 's#[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z#<TIME>#g' \
      -e 's#"(durationMs|ms|took|elapsedMs)":[0-9]+#"\1":<N>#g' \
      -e 's#vault-[0-9a-f]{12}#vault-<ID>#g' \
      -e 's#"mtime":[0-9.]+#"mtime":<N>#g' \
      -e 's#[0-9]{4}-[0-9]{2}-[0-9]{2}-golden-#<DATE>-golden-#g' \
      > "$TMP/cases/$name.txt"
}

mkdir -p "$TMP/cases"
# Order matters only for index state; every case runs against the same vault.
run_case 00-help help
run_case 01-help-json help --json
run_case 02-version --version
run_case 03-path path
run_case 04-path-json path --json
run_case 05-index-json index --json
run_case 06-search search cache
run_case 07-search-json search cache --json
run_case 08-search-none-json search zzzz-nothing --json
run_case 09-get get deploy
run_case 10-get-json get deploy --json
run_case 11-get-section get deploy --section Cache
run_case 12-get-missing-json get no-such-note --json
run_case 13-get-ambiguous-json get dup --json
run_case 14-view view
run_case 15-log-list-json log list --json
run_case 16-lifecycle-json lifecycle --json
run_case 17-lint lint
run_case 18-lint-json lint --json
run_case 19-integrations-json integrations --json
run_case 20-doctor-json doctor --json
run_case 21-unknown-command bogus-command
run_case 22-unknown-command-json bogus-command --json
run_case 23-export-json export --json
run_case 24-sync-none-json sync --json
run_case 25-ext-list-json ext list --json
run_case 26-context context
run_case 27-lint-strict lint --strict
CASE_CWD="$TMP/home" run_case 28-no-vault-json search cache --json
run_case 29-log-add-json log add decision "Use pnpm" --body "faster installs" --json
run_case 30-log-add log add decision "Use pnpm" --body "faster installs"
run_case 31-log-json log --json
run_case 32-log log
run_case 33-view view decision
run_case 34-view-json view decision --json
run_case 35-lifecycle-status-json lifecycle status --json
run_case 36-lifecycle-status lifecycle status
# Command names that are also object-prototype properties must stay unknown commands.
run_case 37-proto-constructor constructor
run_case 38-proto-json __proto__ --json
run_case 39-tostring-json toString --json
run_case 40-hasownproperty-json hasOwnProperty --json
run_case 41-constructor-limit-json --limit 3 constructor --json

if [ "$MODE" = capture ]; then
  rm -rf "$OUT" && mkdir -p "$OUT" && cp "$TMP"/cases/*.txt "$OUT"/
  echo "captured $(ls "$OUT" | wc -l | tr -d ' ') cases into ${OUT#$REPO/}"
  exit 0
fi

if diff -ru "$OUT" "$TMP/cases" > "$TMP/diff"; then
  exit 0
fi
sed -e "s#$TMP/cases#<now>#g" -e "s#$OUT#<golden>#g" "$TMP/diff"
exit 1
