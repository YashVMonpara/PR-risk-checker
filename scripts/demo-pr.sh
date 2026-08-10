#!/usr/bin/env bash
#
# Opens a demo pull request containing deliberately risky changes, so you can
# watch PR Risk Reviewer comment on it.
#
# Usage:  ./scripts/demo-pr.sh [branch-name]
#
set -euo pipefail

BRANCH="${1:-demo/risky-change-$(date +%s)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v gh >/dev/null 2>&1 || { echo "error: the GitHub CLI (gh) is required."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: run 'gh auth login' first."; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: your working tree is dirty. Commit or stash first."
  exit 1
fi

DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"
git checkout "$DEFAULT_BRANCH"
git pull --ff-only
git checkout -b "$BRANCH"

mkdir -p examples

# 1. A security anti-pattern + a breaking exported signature change.
cat > examples/demo-service.js <<'JS'
const { exec } = require("child_process");

// CHANGED: added a second parameter — breaking for existing callers.
export function runTask(name, options) {
  // RISKY: executes arbitrary code from the caller.
  return eval(options.expr);
}

// RISKY: shell command built by string concatenation.
export function cleanup(dir) {
  return exec("rm -rf " + dir);
}
JS

# 2. A dependency added without a lockfile update.
if [[ -f package.json ]]; then
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies["left-pad"] = "^1.3.0";
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  '
fi

git add examples/demo-service.js package.json
git commit -m "demo: add risky changes for PR Risk Reviewer"
git push -u origin "$BRANCH"

PR_URL="$(gh pr create \
  --title "Demo: risky changes for PR Risk Reviewer" \
  --body "short" \
  --base "$DEFAULT_BRANCH" \
  --head "$BRANCH")"

echo
echo "Opened $PR_URL"
echo "Waiting for the review to be posted…"

PR_NUMBER="$(basename "$PR_URL")"

for _ in $(seq 1 60); do
  COUNT="$(gh api "repos/{owner}/{repo}/pulls/${PR_NUMBER}/reviews" -q 'length' 2>/dev/null || echo 0)"
  if [[ "$COUNT" -gt 0 ]]; then
    echo "Review posted. Open the PR to see the comments:"
    echo "  $PR_URL/files"
    exit 0
  fi
  sleep 5
done

echo "No review appeared within 5 minutes — check the Actions tab:"
gh run list --limit 3
