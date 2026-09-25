#!/bin/zsh
# Weekly self-improvement pass (launchd: com.tester.agentctl-graph-weekly,
# installed as ~/.agentctl/bin/graph-weekly.sh).
#   1. SessionGraph analyze + code proposals — read-only toward code; it never
#      runs `graph apply` (code changes stay human-approved, on a branch).
#   2. Config-only loop (only when the selfTune feature is on — see
#      `agentctl features`) — `tune --apply` may reorder routing.prefer in
#      preferences.yaml when verifier evidence says a lane is bad and the
#      routing benchmark has no new hard failures. Backed up and logged;
#      undo with `agentctl tune --rollback`.
# Results: ~/.agentctl/graph/weekly-<date>/ (latest → symlink), tune-log.jsonl.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
CLI="$HOME/code/agentctl/current/dist/cli.js"
OUT="$HOME/.agentctl/graph/weekly-$(date +%Y-%m-%d)"

node "$CLI" graph analyze --since 7d --out "$OUT" > "$OUT.analyze.json"
node "$CLI" graph improve "$OUT" > "$OUT.improve.json"
ln -sfn "$OUT" "$HOME/.agentctl/graph/latest"

# tune exits 1 when it rejects a candidate; that is a result, not a failure.
node "$CLI" tune --apply --scheduled --since 30d --format json > "$OUT.tune.json" || true
node "$CLI" bench --format json > "$OUT.bench.json" || true
echo "$(date -u +%FT%TZ) ok $OUT"
