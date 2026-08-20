# PR Risk Checker

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/YashVMonpara/PR-risk-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/YashVMonpara/PR-risk-checker/actions/workflows/ci.yml)

**Free, open-source PR review that combines AST analysis, deterministic rules, and an optional
LLM — yours to run as a GitHub Action, a local web app, or both.** No account, no server, no
vendor. Your GitHub token and any LLM API key never leave your machine except to talk to GitHub
and whichever LLM endpoint you point it at.

It posts inline review comments on the exact lines it's worried about, and falls back to a
summary table when a line can't be positioned in the diff.

```yaml
- uses: YashVMonpara/PR-risk-checker@main
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

That's the whole setup for the Action. With no LLM configured it runs the deterministic rules
only — no API key, no cost, no network calls beyond GitHub.

---

## Table of contents

- [What it catches](#what-it-catches)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Security & privacy](#security--privacy)
- [LM Studio / local models](#lm-studio--local-models)
- [Configuration reference](#configuration-reference)
- [Testing it locally](#testing-it-locally)
- [Repository layout](#repository-layout)
- [Contributing](#contributing)
- [Known limitations](#known-limitations)
- [License](#license)

---

## What it catches

| Rule                             | Severity     | What it looks for                                                                                                                                                |
| -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security-anti-patterns`       | 🚨 error     | `eval()`, `new Function()`, `innerHTML =`, `dangerouslySetInnerHTML`, shell commands built by concatenation, SQL string concatenation, hardcoded secrets |
| `breaking-signature-change`    | ⚠️ warning | An **exported** function's parameter list changed while no test file was touched (detected via AST, not regex)                                              |
| `missing-tests`                | ⚠️ warning | A source file changed but the PR contains no test file                                                                                                           |
| `dependency-lockfile-mismatch` | ⚠️ warning | `package.json` dependencies changed without a lockfile update (or the reverse)                                                                                 |
| `large-diff-thin-description`  | ℹ️ info    | >500 changed lines with a PR description under 100 characters                                                                                                    |

Hardcoded-secret detection deliberately ignores comment lines and obvious placeholders (`xxx`,
`your-key-here`, `changeme`, …) to keep the noise down.

**AST, not regex.** The `breaking-signature-change` rule parses both the base and head versions
of every changed file with tree-sitter, extracts every function/method/arrow signature with its
exported status, and diffs those structures — so it correctly ignores renames, reformats, and
changes inside comments that a regex-based tool can't distinguish. JavaScript, TypeScript, and
TSX are supported; grammars ship as WASM, so no compiler toolchain is needed on the runner.

---

## Prerequisites

- **Node.js 20 or newer** and **npm**. That's the entire runtime requirement.
- **Git**, obviously.
- **A GitHub account.** For the Action: a token with `pull-requests: write` (the default
  `${{ github.token }}` already has this). For the web app: either a personal access token
  (`repo` scope) or a self-registered GitHub OAuth App — both are supported, see below.
- **LM Studio is optional.** Only needed if you want LLM triage to run on your own hardware
  instead of OpenAI. Skip it entirely and the tool still works — deterministic rules only.

> **No Python required, anywhere.** This is a pure Node.js/TypeScript project — the Action and the
> web app are both plain JS/TS, no Python scripts, no `pip install`, no virtualenv. If you've seen
> a reference to Python for this project, it's out of date or mistaken.

---

## Quickstart

### Option A — GitHub Action (reviews PRs automatically)

```yaml
# .github/workflows/pr-risk-check.yml
name: PR Risk Check
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: YashVMonpara/PR-risk-checker@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

Commit that file, open a PR, done. No secrets to add for the deterministic-rules-only path — see
[Configuration reference](#configuration-reference) to add LLM triage.

### Option B — Web app (point-and-click, runs on your machine)

```bash
git clone https://github.com/YashVMonpara/PR-risk-checker.git
cd PR-risk-checker
npm ci
npm run web          # serves the app at http://localhost:3180 (127.0.0.1 only, by default)
```

Open `http://localhost:3180`. Sign in either way:

- **Personal access token** (fastest, no setup) — paste a PAT with the `repo` scope. It's kept
  only in your local session; never written to disk or sent anywhere except GitHub.
- **GitHub OAuth** — copy `web/.env.example` to `web/.env`, register an OAuth App at
  <https://github.com/settings/developers> (homepage `http://localhost:3180`, callback
  `http://localhost:3180/api/auth/callback`), and fill in `GITHUB_CLIENT_ID` /
  `GITHUB_CLIENT_SECRET`.

Then: pick a repo → pick a PR → run the review → read the findings → optionally post them back or
generate auto-fixes. See [Security & privacy](#security--privacy) for exactly what does and
doesn't leave your machine.

---

## How it works

```
pull_request event / web app request
        │
        ▼
  ┌──────────────┐   PR metadata, changed files + patches,
  │ github.ts    │   base/head file contents
  └──────┬───────┘
         ▼
  ┌──────────────┐   unified diff → hunks, added lines,
  │ diff.ts      │   line number → diff position
  └──────┬───────┘
         ▼
  ┌──────────────┐   parse base + head with tree-sitter,
  │ ast.ts       │   diff the extracted signatures
  └──────┬───────┘
         ▼
  ┌──────────────┐   5 deterministic rules → RiskFinding[]
  │ rules.ts     │
  └──────┬───────┘
         ▼
  ┌──────────────┐   optional: confirm / dismiss / reword
  │ llm.ts       │   (security findings are fail-closed)
  └──────┬───────┘
         ▼
  ┌──────────────┐   Action: one review, inline + summary
  │ comment.ts   │   Web app: shown in the UI, posted on request
  └──────────────┘
```

The Action (`src/index.ts`) and the web app (`web/review.ts`) call the **exact same** analysis
pipeline, so results never drift between the two.

**Error handling.** Every stage degrades instead of crashing: AST failures fall back to text
rules, LLM failures keep the deterministic message, and a `422` from GitHub (positions rejected
because the diff moved) is retried as a summary-only review so feedback is never silently lost.

Full design rationale, tree-sitter query details, and the evidence behind specific decisions
(like why WASM grammars over native bindings, and the fail-closed LLM safety floor) live in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Security & privacy

This tool is built to hold a live GitHub token and, optionally, an LLM API key — so this section
is not an afterthought.

- **Nothing is sent anywhere except GitHub and the LLM endpoint you explicitly configure.** No
  telemetry, no analytics, no third-party calls of any kind. You can verify this yourself: the
  entire codebase is open, and a `grep` for telemetry/analytics libraries turns up nothing.
- **Tokens and keys are never persisted to disk or logged.** The Action's token lives for the
  duration of one workflow run (GitHub's own ephemeral token, by default). The web app's GitHub
  token lives only in your browser's session cookie; any LLM API key you type travels only in the
  request body of the review call you triggered, is never written to disk, and is never logged.
- **The web app binds to `127.0.0.1` (localhost) by default.** It is not reachable from other
  devices on your network unless you deliberately set `HOST=0.0.0.0` in `web/.env` — and if you
  do, set a real `SESSION_SECRET` first (the server warns loudly on startup if you haven't).
- **OAuth login is CSRF-protected** with a per-login random `state` value validated on callback.
- **Auto-fix can't touch files outside the PR.** Before committing anything, the server
  re-fetches the PR's actual changed-file list from GitHub and rejects any proposed path that
  isn't in it — the "only what you approved, only in this PR" guarantee is enforced server-side,
  not just in the UI.
- **Security findings can't be silently dismissed by the LLM.** A local 8B model was once
  observed answering `SAFE` to a textbook `eval()` injection during development. Any
  `error`-severity security finding is fail-closed: the model can reword it, but never suppress
  or downgrade it. See `applySafetyFloor` in `src/llm.ts`.
- **No account creation, ever.** Both the Action and the web app work entirely against your own
  GitHub token/session — there is no PR Risk Checker account, no sign-up, no hosted backend to
  trust.

If you find a way around any of the above, please report it privately — see
[`SECURITY.md`](SECURITY.md).

---

## LM Studio / local models

LLM triage is entirely optional, and when you want it, it doesn't have to mean sending your code
to a third party. [LM Studio](https://lmstudio.ai/) runs a model on your own hardware and exposes
an OpenAI-compatible server, so it needs no special handling beyond pointing this tool at it.

**1. Start the server**

In LM Studio: load a model → **Developer** tab → **Start Server**. Or via CLI:

```bash
lms server start
lms ls                       # list the models you have
curl http://localhost:1234/v1/models   # confirm it's up
```

**2. Point the tool at it**

For the **Action**:

```yaml
- uses: YashVMonpara/PR-risk-checker@main
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    llm_api_base_url: http://localhost:1234/v1
    model: qwen/qwen3-vl-8b        # whatever you loaded
    # openai_api_key: omit entirely — LM Studio doesn't need one
```

> **Important:** `localhost` refers to *the runner*. A GitHub-hosted runner cannot reach LM
> Studio on your laptop — use a **self-hosted runner** on that machine, or expose the endpoint at
> a URL the runner can reach.

For the **web app**: open the "LLM triage" section, paste the base URL
(`http://localhost:1234/v1`), and click **Detect models** — it asks the endpoint's own `/models`
list directly from your browser (never through the app's server) and fills in the model field
for you, so you never have to type a model ID from memory. Leave the API key blank.

**Model choice matters.** Small local models are noticeably worse at triage than `gpt-4o-mini`.
The fail-closed rule protects security findings regardless, but expect more false positives to
survive elsewhere with an 8B-class model.

---

## Configuration reference

### GitHub Action inputs

| Input                | Required | Default                 | Description                                                                                         |
| -------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `github_token`     | no      | `${{ github.token }}` | Token used to read the PR and post the review. Needs `pull-requests: write`.                      |
| `openai_api_key`   | no       | —                      | OpenAI API key. Leave empty when using LM Studio without auth.                                      |
| `llm_api_base_url` | no       | —                      | Custom OpenAI-compatible base URL, e.g. `http://localhost:1234/v1`. Overrides the OpenAI endpoint. |
| `model`            | no       | `gpt-4o-mini`         | Model name. Any model your endpoint serves.                                                         |
| `risk_threshold`   | no       | `warning`             | Minimum severity to report: `info`, `warning`, or `error`.                                     |
| `fail_on_error`    | no       | `false`               | Fail the workflow when error-severity findings exist.                                               |
| `max_llm_calls`    | no       | `10`                  | Cap on LLM calls per run (cost/time guard).                                                         |

**Outputs:** `findings_count`, `summary`.

Which backend runs, based on the two LLM inputs:

| `openai_api_key` | `llm_api_base_url` | Result                                                          |
| ------------------ | -------------------- | ----------------------------------------------------------------- |
| ❌                 | ❌                   | Deterministic rules only                                        |
| ✅                 | ❌                   | OpenAI                                                          |
| ❌                 | ✅                   | LM Studio / compatible, no auth (key defaults to `lm-studio`) |
| ✅                 | ✅                   | Custom endpoint that requires auth (proxy, vLLM, Together, …)  |

### Web app environment variables (`web/.env`)

Copy `web/.env.example` to `web/.env` and fill in what you need — everything is optional except
for enabling OAuth.

| Variable                | Required            | Default                                    | Description                                                                 |
| ------------------------ | -------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | only for OAuth login | —                                          | From your GitHub OAuth App. Without this, the app falls back to PAT login.  |
| `GITHUB_CLIENT_SECRET` | only for OAuth login | —                                          | Paired with the client ID above.                                            |
| `GITHUB_REDIRECT_URI`  | no                   | `http://<host>/api/auth/callback`         | Override if serving behind a proxy/tunnel.                                  |
| `SESSION_SECRET`       | strongly recommended | an insecure built-in placeholder           | Used to sign the session cookie. The server warns on startup if left unset. |
| `PORT`                 | no                   | `3180`                                    | Port the app listens on.                                                    |
| `HOST`                 | no                   | `127.0.0.1`                               | Bind address. Only change this if you deliberately want LAN access.         |

---

## Testing it locally

No GitHub repo, no PR, and no credentials needed. The harness boots a mock GitHub API and runs
the **real built action** (`dist/index.js`) as a subprocess against it.

```bash
npm ci
npm run build

npm run e2e             # deterministic rules only
npm run e2e:mock-llm    # + a mock OpenAI-compatible server (asserts the LLM path)
npm run e2e:lmstudio    # + your real LM Studio instance
```

`npm run e2e` prints the exact review that would be posted:

```
--- ACTION LOG ---
No LLM configured — running deterministic rules only.
Analysing 3 of 3 changed file(s).
7 finding(s) at or above "warning".
Posted review: 4 inline comment(s), 3 in the summary.

--- src/runner.js @ diff position 12 ---
**🚨 Error** · `security`

Use of `eval()` executes arbitrary code and is a code-injection risk. Parse the
value explicitly (e.g. `JSON.parse`) or dispatch through a lookup table instead.
```

Override the LM Studio target with `LM_STUDIO_URL` and `LM_STUDIO_MODEL`.

Other scripts:

```bash
npm test                # unit + integration tests
npm test -- --coverage  # coverage report
npm run lint
npm run typecheck
./scripts/demo-pr.sh    # opens a real PR with risky changes (needs gh)
```

---

## Repository layout

```
src/
  index.ts     orchestration, inputs, LLM budget
  github.ts    Octokit calls (paginated)
  diff.ts      unified-diff parsing and position math
  ast.ts       tree-sitter parsing and signature extraction
  rules.ts     the deterministic rule engine
  llm.ts       dual-backend LLM client, retries, fail-closed floor
  fix.ts       auto-fix generation + guardrailed patch application
  comment.ts   review rendering and posting
  types.ts     shared types
__tests__/     unit + integration tests, including both LLM backends
scripts/
  local-run.js     mock GitHub API + real action subprocess
  e2e-mock-llm.js  mock OpenAI-compatible server
  copy-wasm.js     vendors tree-sitter grammars into dist/
  demo-pr.sh       opens a real demo PR
fixtures/demo-pr/  base/head files and git-generated patches
web/                companion web app (server.ts, review.ts, public/)
dist/              committed build (index.js + 4 WASM files)
```

`dist/` is committed because GitHub Actions runs the pre-built bundle — there's no `npm install`
on the runner. CI fails if it drifts from source, so **run `npm run build` before pushing**
changes to `src/`.

---

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, the checks
CI runs, and how to add a rule. Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md).

Found a security issue? Please report it privately — see [`SECURITY.md`](SECURITY.md) rather than
opening a public issue.

---

## Known limitations

- **JS/TS/TSX only.** Adding a language means adding a grammar (~1MB) and an extension mapping.
- **`localhost` is the runner's localhost.** LM Studio on your laptop is not reachable from a
  GitHub-hosted runner; use a self-hosted runner.
- **Small local models produce weaker triage** than `gpt-4o-mini`. Security findings are
  protected either way, but expect more surviving false positives elsewhere.
- **Renamed files** are analysed as-is; the rename itself isn't reported.
- No dedicated release process yet — the Action is consumed via `@main` or a commit SHA; tagged
  releases are on the roadmap.

Full architecture, the evidence behind specific design decisions, and testing strategy:
[`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## License

MIT — see [LICENSE](LICENSE). Free to use, modify, and redistribute — including commercially.
