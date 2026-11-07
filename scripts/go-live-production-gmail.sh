#!/bin/bash
# Switches production from the controlled Gmail test to real broker sends, in one step
# (docs/runbooks/gmail-connect.md, Part C, step 5.9.2). Run it yourself, from the project folder,
# after the controlled test passed and you clicked Turn off Live sending:
#
#   bash scripts/go-live-production-gmail.sh           check, confirm, switch, verify
#   bash scripts/go-live-production-gmail.sh --check   only check; changes nothing
#   --keep-sheet-sources                               leave DEAL_HUNTER_SHEET_CSV_URLS as it is
#
# Needs: `fly auth login` done, and the server running a release that has
# scripts/go-live-check.js (it says so if not).
#
# What it does:
#   1. Checks the app is up, and that Fly holds no staged secret changes (`fly secrets deploy`
#      would apply them too, unchecked).
#   2. On the server, tests the app's own startup check against the new settings, and checks
#      Live sending is off. If anything is wrong it stops here and nothing changes.
#   3. Asks you to type GO LIVE, then checks again.
#   4. Sets DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1 and removes the test-only
#      settings (and the test listing Sheet, if it was added as a second Sheet source), all
#      staged first and applied together, so the app restarts once.
#   5. Waits for the app to come back and checks the switch landed.
#
# It never turns Live sending on: you do that in the Email sending card afterwards (step 6).
# It prints setting names and the sending setup's label, never a setting's value.
set -euo pipefail
export FLY_NO_UPDATE_CHECK=1

APP="${GO_LIVE_APP:-uckele-group}"
HEALTH_URL="${GO_LIVE_HEALTH_URL:-https://uckele-group.fly.dev/api/health}"
WAIT_SECONDS="${GO_LIVE_WAIT_SECONDS:-180}"
PROFILE_KEY="DEAL_HUNTER_CIM_PROVIDER_PROFILE"
REMOVABLE=" DEAL_HUNTER_CIM_MAILBOX_PROVIDER DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS DEAL_HUNTER_SHEET_CSV_URLS "
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "${GO_LIVE_FLY:-}" ]]; then
  FLY="$GO_LIVE_FLY"
elif command -v fly >/dev/null 2>&1; then
  FLY="$(command -v fly)"
elif [[ -x /opt/homebrew/bin/fly ]]; then
  FLY=/opt/homebrew/bin/fly
else
  echo "Couldn't find the fly command. Nothing changed."; exit 1
fi

CHECK_ONLY=false
KEEP_ARG=""
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --keep-sheet-sources) KEEP_ARG="--keep-sheet-sources" ;;
    *) echo "Unknown option: $arg. Nothing changed."; exit 1 ;;
  esac
done

healthy() { "${GO_LIVE_CURL:-curl}" -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; }

# The names fly.toml [env] and the Dockerfile set: Fly deploys these alongside the secrets.
# Read from this checkout, so run it from an up-to-date main. A staged removal of a name that is
# both an [env] key and a secret is not caught; the fly.toml value applies instead, and for those
# seven names it is the safe one (outreach and automation paused, follow-ups off, /data paths).
config_env_names() {
  {
    awk '/^[[:space:]]*\[/ { inenv = ($0 ~ /^[[:space:]]*\[env\][[:space:]]*$/); next }
      inenv && match($0, /^[[:space:]]*[A-Z][A-Z0-9_]*[[:space:]]*=/) {
        line = substr($0, RSTART, RLENGTH); gsub(/[[:space:]=]/, "", line); print line }' "$ROOT/fly.toml"
    awk '$1 == "ENV" { split($2, kv, "="); print kv[1] }' "$ROOT/Dockerfile"
  } | grep -E '^[A-Z][A-Z0-9_]*$' | sort -u | paste -sd, -
}

# Reads `fly secrets list --json` into SECRET_NAMES (comma list) and NOT_DEPLOYED (names whose
# status is not Deployed). Only names and statuses are kept; digests are dropped.
read_secret_statuses() {
  local json objects line name status
  if ! json="$("$FLY" secrets list -a "$APP" --json </dev/null 2>/dev/null)"; then return 1; fi
  objects="$(printf '%s' "$json" | tr -d '\r\n' | tr '}' '\n')"
  SECRET_NAMES=""
  NOT_DEPLOYED=""
  while IFS= read -r line; do
    name="$(printf '%s' "$line" | grep -oiE '"name"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_]+"' | head -1 \
      | sed -E 's/.*"([A-Za-z0-9_]+)"$/\1/' || true)"
    [[ -z "$name" ]] && continue
    status="$(printf '%s' "$line" | grep -oiE '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
      | sed -E 's/.*"([^"]*)"$/\1/' | tr '[:upper:]' '[:lower:]' || true)"
    SECRET_NAMES="${SECRET_NAMES:+$SECRET_NAMES,}$name"
    # The switch overwrites its own profile setting, so a staged profile left by an earlier run
    # is fine.
    if [[ "$status" != "deployed" && "$name" != "$PROFILE_KEY" ]]; then
      NOT_DEPLOYED="${NOT_DEPLOYED:+$NOT_DEPLOYED }$name"
    fi
  done <<< "$objects"
  [[ -n "$SECRET_NAMES" ]]
}

# Runs scripts/go-live-check.js on the server; prints its report and leaves its last line in
# CHECK_RESULT.
run_check() {
  local output
  if ! output="$("$FLY" ssh console -a "$APP" -C "node /app/scripts/go-live-check.js $*" </dev/null 2>&1)"; then
    output="$output"$'\n'"(the server check could not run)"
  fi
  output="$(printf '%s\n' "$output" | tr -d '\r')"
  printf '%s\n' "$output" | { grep -v '^GO_LIVE_CHECK ' || true; } | sed 's/^/  /'
  CHECK_RESULT="$(printf '%s\n' "$output" | { grep '^GO_LIVE_CHECK ' || true; } | tail -1)"
  if [[ -z "$CHECK_RESULT" ]] && printf '%s\n' "$output" | grep -q "Cannot find module"; then
    echo "  The server doesn't have the go-live check yet. Deploy the latest main first."
  fi
}

# The before-check, with the names Fly will deploy. Sets CHECK_RESULT.
check_before() {
  local env_names
  if ! read_secret_statuses; then
    echo "  Couldn't read the secret list from Fly."; CHECK_RESULT=""; return
  fi
  if [[ -n "$NOT_DEPLOYED" ]]; then
    echo "  Fly doesn't report these secrets as deployed (staged, partly deployed, or unknown): $NOT_DEPLOYED"
    echo "  The switch would apply them too, unchecked. Ask your engineer."
    CHECK_RESULT=""; return
  fi
  if ! env_names="$(config_env_names)" || [[ -z "$env_names" ]]; then
    echo "  Couldn't read fly.toml and the Dockerfile. Run this from the project folder."
    CHECK_RESULT=""; return
  fi
  run_check before "--app=$APP" "--secret-names=$SECRET_NAMES" "--env-names=$env_names" $KEEP_ARG
}

check_passed() { [[ "$CHECK_RESULT" == "GO_LIVE_CHECK result=ok"* ]]; }

RECOVERY="$FLY secrets unset -a $APP $PROFILE_KEY"
recovery_note() {
  echo "If the app is down, this starts it again with broker email off: $RECOVERY"
  echo "Don't set the profile back to controlled-mailbox-v1 by itself: the test-only settings"
  echo "are gone, and the app won't start that way. Then ask your engineer."
}

echo "1. Checking the app is up..."
if ! healthy; then echo "The app isn't answering at $HEALTH_URL. Nothing changed."; exit 1; fi
echo "  It is."
echo
echo "2. Checking that the switch is safe..."
check_before
if ! check_passed; then
  echo
  echo "Stopped. Nothing changed."; exit 1
fi
PLANNED="$CHECK_RESULT"

FROM="$(printf '%s\n' "$CHECK_RESULT" | sed -n 's/.* from=\([a-z]*\).*/\1/p')"
UNSET_LIST="$(printf '%s\n' "$CHECK_RESULT" | sed -n 's/.* unset=\([A-Z0-9_,]*\).*/\1/p')"
UNSET=()
if [[ -n "$UNSET_LIST" ]]; then
  IFS=',' read -r -a UNSET <<< "$UNSET_LIST"
fi
for name in "${UNSET[@]+"${UNSET[@]}"}"; do
  if [[ "$REMOVABLE" != *" $name "* ]]; then
    echo "The server check asked to remove $name, which this script never removes. Nothing changed."; exit 1
  fi
done
if [[ "$FROM" != "controlled" && "$FROM" != "production" ]]; then
  echo "The server check didn't say which sending setup is on. Nothing changed."; exit 1
fi

if [[ "$CHECK_ONLY" == true ]]; then
  echo
  echo "The check passed. Nothing changed (--check)."; exit 0
fi

if [[ "$FROM" == "production" && ${#UNSET[@]} -eq 0 ]]; then
  echo
  echo "The switch is already done: the sending setup is production and nothing is left to remove."
  echo "Nothing changed."; exit 0
fi

echo
echo "3. About to change on $APP (the app restarts once):"
echo "  set:    $PROFILE_KEY=production-gmail-v1"
if [[ ${#UNSET[@]} -gt 0 ]]; then echo "  remove: ${UNSET[*]}"; fi
echo "After this, the sender may email real brokers as soon as you turn on Live sending."
echo "Live sending stays off until you click Turn on Live sending in the Email sending card."
read -r -p "Type GO LIVE to continue: " OK || OK=""
if [[ "$OK" != "GO LIVE" ]]; then echo "Nothing changed."; exit 1; fi

echo "  Checking again..."
check_before
if [[ "$CHECK_RESULT" != "$PLANNED" ]]; then
  echo "Something changed since the first check. Nothing changed; run this script again."; exit 1
fi

still_staged_note() {
  echo "The production sending setup may still be staged on Fly, and would take effect at the"
  echo "next deploy (the app starts fine with it). Run this script again now to finish the switch,"
  echo "or ask your engineer."
}

# Puts the staged profile back to what is running, so a failed switch leaves nothing that the
# next deploy would apply by surprise. The controlled profile goes back only when Fly confirms
# every planned removal is still a secret: the controlled profile without
# DEAL_HUNTER_CIM_MAILBOX_PROVIDER stops the app from starting (2026-11-06), while the
# production profile starts with or without the test-only settings.
restore_staged_profile() {
  local original=controlled-mailbox-v1 name
  [[ "$FROM" == "production" ]] && original=production-gmail-v1
  if [[ "$original" == "controlled-mailbox-v1" && ${#UNSET[@]} -gt 0 ]]; then
    if ! read_secret_statuses; then still_staged_note; return; fi
    for name in "${UNSET[@]}"; do
      if [[ ",$SECRET_NAMES," != *",$name,"* ]]; then
        echo "$name was already removed on Fly, so the controlled test setup can't be put back."
        still_staged_note; return
      fi
    done
  fi
  if "$FLY" secrets set --stage -a "$APP" "$PROFILE_KEY=$original" </dev/null; then
    echo "Put the staged sending setup back to what is running. The app is unchanged."
  else
    still_staged_note
  fi
}

echo
echo "4. Staging and applying the changes..."
if ! "$FLY" secrets set --stage -a "$APP" "$PROFILE_KEY=production-gmail-v1" </dev/null; then
  echo "Staging the sending setup failed."
  restore_staged_profile; exit 1
fi
if [[ ${#UNSET[@]} -gt 0 ]]; then
  if ! "$FLY" secrets unset --stage -a "$APP" "${UNSET[@]}" </dev/null; then
    echo "Staging the removals failed."
    restore_staged_profile; exit 1
  fi
fi
if ! "$FLY" secrets deploy -a "$APP" </dev/null; then
  echo "Applying the changes failed. Check: $FLY status -a $APP"
  recovery_note; exit 1
fi

echo
echo "5. Waiting for the app to come back..."
deadline=$((SECONDS + WAIT_SECONDS))
until healthy; do
  if (( SECONDS >= deadline )); then
    echo "The app hasn't answered for $WAIT_SECONDS seconds. Check: $FLY status -a $APP"
    recovery_note; exit 1
  fi
  sleep 5
done
echo "  It's up. Checking the switch landed..."
run_check after "--app=$APP" "--expect-unset=$UNSET_LIST"
if ! check_passed; then
  echo
  echo "The switch did not land as planned. Leave Live sending off and ask your engineer."; exit 1
fi

echo
echo "Done. Production is set up for real sending, and Live sending is still off."
echo "Next (runbook step 6): in Admin > Operations, the Email sending card, click Turn on Live"
echo "sending. It should say Sending setup: production, and readiness should say Ready to send."
