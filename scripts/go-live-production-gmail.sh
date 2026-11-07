#!/bin/bash
# Switches production from the controlled Gmail test to real broker sends, in one step
# (docs/runbooks/gmail-connect.md, Part C, step 5.9.2). Run it yourself, from the project folder,
# after the controlled test passed and you clicked Turn off Live sending:
#
#   bash scripts/go-live-production-gmail.sh           check, confirm, switch, verify
#   bash scripts/go-live-production-gmail.sh --check   only check; changes nothing
#
# What it does:
#   1. Checks the app is up.
#   2. On the server, tests the app's own startup check against the new settings, and checks
#      Live sending is off. If anything is wrong it stops here and nothing changes.
#   3. Asks you to type GO LIVE.
#   4. Sets DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1 and removes the test-only
#      settings (and the test listing Sheet, if it was added as a second Sheet source), all
#      staged first and applied together, so the app restarts once.
#   5. Waits for the app to come back and checks the switch landed.
#
# It never turns Live sending on: you do that in the Email sending card afterwards (step 6).
# It prints setting names only, never their values.
set -euo pipefail
export FLY_NO_UPDATE_CHECK=1

APP="${GO_LIVE_APP:-uckele-group}"
HEALTH_URL="${GO_LIVE_HEALTH_URL:-https://uckele-group.fly.dev/api/health}"
WAIT_SECONDS="${GO_LIVE_WAIT_SECONDS:-180}"
PROFILE_SETTING="DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1"
REMOVABLE=" DEAL_HUNTER_CIM_MAILBOX_PROVIDER DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS DEAL_HUNTER_SHEET_CSV_URLS "

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
CHECK_ARGS=""
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --keep-sheet-sources) CHECK_ARGS="--keep-sheet-sources" ;;
    *) echo "Unknown option: $arg. Nothing changed."; exit 1 ;;
  esac
done

healthy() { "${GO_LIVE_CURL:-curl}" -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; }

# Runs scripts/go-live-check.js on the server; prints its report and leaves its last line in
# CHECK_RESULT.
run_check() {
  local output
  if ! output="$("$FLY" ssh console -a "$APP" -C "node /app/scripts/go-live-check.js $1 $CHECK_ARGS" 2>&1)"; then
    output="$output"$'\n'"(the server check could not run)"
  fi
  output="$(printf '%s\n' "$output" | tr -d '\r')"
  printf '%s\n' "$output" | grep -v '^GO_LIVE_CHECK ' | sed 's/^/  /'
  CHECK_RESULT="$(printf '%s\n' "$output" | grep '^GO_LIVE_CHECK ' | tail -1 || true)"
  if [[ -z "$CHECK_RESULT" ]] && printf '%s\n' "$output" | grep -q "Cannot find module"; then
    echo "  The server doesn't have the go-live check yet. Deploy the latest main first."
  fi
}

echo "1. Checking the app is up..."
if ! healthy; then echo "The app isn't answering at $HEALTH_URL. Nothing changed."; exit 1; fi
echo "  It is."
echo
echo "2. Checking on the server that the switch is safe..."
run_check before
if [[ "$CHECK_RESULT" != "GO_LIVE_CHECK result=ok"* ]]; then
  echo
  echo "Stopped. Nothing changed."; exit 1
fi

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

if [[ "$CHECK_ONLY" == true ]]; then
  echo
  echo "The check passed. Nothing changed (--check)."; exit 0
fi

echo
echo "3. About to change on $APP (the app restarts once):"
echo "  set:    $PROFILE_SETTING"
if [[ ${#UNSET[@]} -gt 0 ]]; then echo "  remove: ${UNSET[*]}"; fi
echo "After this, the sender may email real brokers as soon as you turn on Live sending."
echo "Live sending stays off until you click Turn on Live sending in the Email sending card."
read -r -p "Type GO LIVE to continue: " OK
if [[ "$OK" != "GO LIVE" ]]; then echo "Nothing changed."; exit 1; fi

staged_note() {
  echo "Some changes may be staged on Fly but not applied. The app is unchanged. Run this script"
  echo "again (it stages the same changes and applies them), or ask your engineer."
}

echo
echo "4. Staging and applying the changes..."
if ! "$FLY" secrets set --stage -a "$APP" "$PROFILE_SETTING"; then
  echo "Staging the profile failed."; staged_note; exit 1
fi
if [[ ${#UNSET[@]} -gt 0 ]]; then
  if ! "$FLY" secrets unset --stage -a "$APP" "${UNSET[@]}"; then
    echo "Staging the removals failed."; staged_note; exit 1
  fi
fi
if ! "$FLY" secrets deploy -a "$APP"; then
  echo "Applying the changes failed. Check fly status; if the app is down, ask your engineer."; exit 1
fi

echo
echo "5. Waiting for the app to come back..."
deadline=$((SECONDS + WAIT_SECONDS))
until healthy; do
  if (( SECONDS >= deadline )); then
    echo "The app hasn't answered for $WAIT_SECONDS seconds. Run: $FLY status -a $APP, and ask your engineer."; exit 1
  fi
  sleep 5
done
echo "  It's up. Checking the switch landed..."
run_check after
if [[ "$CHECK_RESULT" != "GO_LIVE_CHECK result=ok"* ]]; then
  echo
  echo "The switch did not land as planned. Leave Live sending off and ask your engineer."; exit 1
fi

echo
echo "Done. Production is set up for real sending, and Live sending is still off."
echo "Next (runbook step 6): in Admin > Operations, the Email sending card, click Turn on Live"
echo "sending. It should say Sending setup: production, and readiness should say Ready to send."
