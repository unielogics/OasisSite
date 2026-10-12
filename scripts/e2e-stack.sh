#!/usr/bin/env bash
# e2e-stack: the site e2e against a LIVE stack, start to end in one shell (docs/e2e.md "The live stack"): the dashboard's
# `pnpm live:up` runs the real backend (~/oasis/backend unless E2E_BACKEND says otherwise) seeded with design,demo and the
# website catalog, with the website's public POSTs open (PUBLIC_WRITES_ENABLED=true) and the personal links switched on (PUBLIC_LINKS_ENABLED=true and a PIN_PEPPER of 32 random bytes made
# here, for this run only), the e2e numbers on the SMS allowlist (the stack's simulator delivers their texts) and the site
# hosts as allowed origins; then `pnpm e2e:site --stack <name> [args]`; the stack is always brought down and its schema
# dropped. On the test server (the run's own network and process namespaces, mirror the backend and the dashboard first):
#
#   oasis-remote ~/oasis/backend -- true; oasis-remote ~/oasis/dashboard -- true
#   oasis-remote ~/oasis/site -- 'bash scripts/e2e-stack.sh'                 # every check
#   oasis-remote ~/oasis/site -- 'bash scripts/e2e-stack.sh --only links'    # the personal-link checks 10-21
#
# Exit status: the e2e's (live:up failing twice exits 2). Output: the live:up log on failure, the e2e's check lines.
set -u
SITE=$(cd "$(dirname "$0")/.." && pwd)
DASHBOARD=${E2E_DASHBOARD:-$HOME/oasis/dashboard}
BACKEND=${E2E_BACKEND:-$HOME/oasis/backend}
NAME=${E2E_STACK_NAME:-sitee2e}
LOGDIR=$(mktemp -d)
echo "e2e-stack: site $SITE, backend $BACKEND, dashboard $DASHBOARD, stack $NAME"

# a test pepper for this run only (never a real secret): the stack and the e2e (which sets PINs for its clients) share it
PIN_PEPPER=$(openssl rand -base64 32)
export PIN_PEPPER
ALLOW=+12015550141,+12015550142,+12015550143,+12015550177
for n in $(seq 161 176); do ALLOW="$ALLOW,+1201555$(printf %04d "$n")"; done
export SMS_ALLOWLIST=$ALLOW

down() { (cd "$DASHBOARD" && pnpm -s live:down --name "$NAME" --drop); }
trap down EXIT

UP=1
for try in 1 2; do
  # (a dashboard build racing another run's in the same mirror can fail once: tried twice)
  (cd "$DASHBOARD" && ALLOW_DEV_ENDPOINTS=true PUBLIC_WRITES_ENABLED=true PUBLIC_LINKS_ENABLED=true PUBLIC_SITE_URL=http://127.0.0.1:3301 \
    timeout 1200 pnpm -s live:up --name "$NAME" --backend "$BACKEND" --profile design,demo,website-catalog \
    --api-port 4081 --web-port 3281 --origin http://127.0.0.1:3302 >"$LOGDIR/up.log" 2>&1)
  UP=$?
  echo "e2e-stack: live:up exit $UP (try $try)"
  [ "$UP" = 0 ] && break
  tail -20 "$LOGDIR/up.log"
  down
done
[ "$UP" = 0 ] || exit 2

cd "$SITE" || exit 2
timeout 2400 pnpm -s e2e:site --stack "$NAME" --dashboard "$DASHBOARD" "$@"
RC=$?
echo "e2e-stack: e2e:site exit $RC"
exit $RC
