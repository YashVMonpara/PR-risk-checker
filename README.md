# PR Risk Reviewer

A GitHub Action that reviews pull requests for risky changes by combining **tree-sitter AST analysis**, a **deterministic rule engine**, and an **LLM** — where the LLM can be **OpenAI, LM Studio, or any OpenAI-compatible endpoint**.

It posts inline review comments on the exact lines it's worried about, and falls back to a summary table when a line can't be positioned in the diff.

```yaml
- uses: your-username/pr-risk-reviewer@main
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

That's the whole setup. With no LLM configured it runs the deterministic rules only — no API key, no cost, no network calls beyond GitHub.

---

## What it catches

| Rule                             | Severity     | What it looks for                                                                                                                                                |
| -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security-anti-patterns`       | 🚨 error     | `eval()`, `new Function()`, `innerHTML =`, `dangerouslySetInnerHTML`, shell commands built by concatenation, SQL string concatenation, hardcoded secrets |
| `breaking-signature-change`    | ⚠️ warning | An**exported** function's parameter list changed while no test file was touched (detected via AST, not regex)                                              |
| `missing-tests`                | ⚠️ warning | A source file changed but the PR contains no test file                                                                                                           |
| `dependency-lockfile-mismatch` | ⚠️ warning | `package.json` dependencies changed without a lockfile update (or the reverse)                                                                                 |
| `large-diff-thin-description`  | ℹ️ info    | >500 changed lines with a PR description under 100 characters                                                                                                    |

Hardcoded-secret detection deliberately ignores comment lines and obvious placeholders (`xxx`, `your-key-here`, `changeme`, …) to keep the noise down.

---

## Why AST, and not just regex

The `breaking-signature-change` rule parses **both the base and head versions** of every changed file with tree-sitter, extracts every function/method/arrow signature with its exported status, and diffs those structures. So it reports:

> The exported signature of `runTask` changed from `(name)` to `(name, options)`

…which a diff-only tool can't distinguish from a rename, a reformat, or a change inside a comment.

Grammars ship as WASM (`web-tree-sitter`) rather than native bindings, so the action needs **no compiler toolchain on the runner** — it runs on `node20` out of the box. JavaScript, TypeScript, and TSX are supported.

---

## LLM triage (optional)

When an LLM is configured, each deterministic finding is sent to the model with a focused slice of the diff. The model returns a structured verdict:

```json
{ "is_real_risk": true, "severity": "error", "comment": "…" }
```

- **Confirmed** findings get the model's wording — specific, contextual, with a suggested fix.
- **Dismissed** findings are dropped, which is how false positives get filtered.

### Fail-closed safety

**An error-level security finding is never dismissed or downgraded by the model.** The model may reword it, but not suppress it.

This isn't theoretical caution. During development, `qwen3-vl-8b` running locally answered `SAFE` to this:

```js
export function runTask(name, options) {
  return eval(options.expr);   // textbook code injection
}
```

A small local model confidently waving through an injection bug is exactly the failure mode that would make this action dangerous, so security findings are protected by design. Everything else is still fair game for the model to dismiss.

---

## Configuration

| Input                | Required | Default                 | Description                                                                                         |
| -------------------- | -------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `github_token`     | yes      | `${{ github.token }}` | Token used to read the PR and post the review. Needs `pull-requests: write`.                      |
| `openai_api_key`   | no       | —                      | OpenAI API key. Leave empty when using LM Studio without auth.                                      |
| `llm_api_base_url` | no       | —                      | Custom OpenAI-compatible base URL, e.g.`http://localhost:1234/v1`. Overrides the OpenAI endpoint. |
| `model`            | no       | `gpt-4o-mini`         | Model name. Any model your endpoint serves.                                                         |
| `risk_threshold`   | no       | `warning`             | Minimum severity to report:`info`, `warning`, or `error`.                                     |
| `fail_on_error`    | no       | `false`               | Fail the workflow when error-severity findings exist.                                               |
| `max_llm_calls`    | no       | `10`                  | Cap on LLM calls per run (cost/time guard).                                                         |

**Outputs:** `findings_count`, `summary`.

### Which backend runs?

| `openai_api_key` | `llm_api_base_url` | Result                                                          |
| ------------------ | -------------------- | --------------------------------------------------------------- |
| ❌                 | ❌                   | Deterministic rules only                                        |
| ✅                 | ❌                   | OpenAI                                                          |
| ❌                 | ✅                   | LM Studio / compatible, no auth (key defaults to `lm-studio`) |
| ✅                 | ✅                   | Custom endpoint that requires auth (proxy, vLLM, Together, …)  |

---

## LM Studio support

LM Studio exposes an OpenAI-compatible server, so it needs no special handling beyond pointing the action at it.

**1. Start the server**

In LM Studio: load a model → **Developer** tab → **Start Server**. Or via CLI:

```bash
lms server start
lms ls                       # list the models you have
curl http://localhost:1234/v1/models   # confirm it's up
```

**2. Point the action at it**

```yaml
- uses: your-username/pr-risk-reviewer@main
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    llm_api_base_url: http://localhost:1234/v1
    model: qwen/qwen3-vl-8b        # whatever you loaded
    # openai_api_key: omit entirely — LM Studio doesn't need one
```

> **Important:** `localhost` refers to *the runner*. A GitHub-hosted runner cannot reach the LM Studio instance on your laptop. Use a **self-hosted runner** on the machine running LM Studio, or expose it at a URL the runner can reach.

**Model choice matters.** Small local models are noticeably worse at triage than `gpt-4o-mini`. The fail-closed rule protects security findings, but for everything else expect more false positives to survive. Structured JSON output (`response_format: json_schema`) is requested, and bare `SAFE` replies from models that ignore the schema are handled.

---

## Example workflows

### Deterministic rules only — no credentials

```yaml
name: PR Risk Review
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-username/pr-risk-reviewer@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### OpenAI

```yaml
      - uses: your-username/pr-risk-reviewer@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-4o-mini
          max_llm_calls: 15
```

### LM Studio on a self-hosted runner

```yaml
jobs:
  review:
    runs-on: self-hosted        # the machine running LM Studio
    steps:
      - uses: actions/checkout@v4
      - uses: your-username/pr-risk-reviewer@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          llm_api_base_url: http://localhost:1234/v1
          model: qwen/qwen3-vl-8b
```

### Block merges on security findings

```yaml
      - uses: your-username/pr-risk-reviewer@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          risk_threshold: error
          fail_on_error: 'true'
```

---

## Testing it locally

No GitHub repo, no PR, and no credentials needed. The harness boots a mock GitHub API and runs the **real built action** (`dist/index.js`) as a subprocess against it.

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
npm test                # 106 unit + integration tests
npm test -- --coverage  # coverage report
npm run lint
npm run typecheck
./scripts/demo-pr.sh    # opens a real PR with risky changes (needs gh)
```

---

## Setup wizard (no GitHub required)

Hand-writing workflows is where most people get this wrong — usually the
`localhost` trap (a hosted runner can't reach your laptop's LM Studio) or
inlining a secret. `panel/` is a single static page that guides you through the
choices with inline hints and emits a correct `pr-risk-review.yml`. It also
**probes your LM Studio instance and auto-fills the loaded model list** — so you
never type a model ID from memory.

```bash
npm run panel          # serves panel/ at http://localhost:8877
```

Open that URL. Nothing is uploaded: the only network call is the LM Studio
probe you trigger yourself, and secrets are emitted as `${{ secrets.* }}`
references, never inlined.

What it does:

- **Step-by-step backend choice** (rules-only / OpenAI / LM Studio / custom) with a plain-language trade-off for each.
- **Live model discovery** — "Test connection" hits your `/v1/models` and populates the dropdown, auto-selecting a chat model (embedding models are filtered out).
- **Contextual hints** — CORS gotchas, the `localhost` runner warning, per-backend cost estimates, and a merge-gate caveat.
- **Always-correct output** — if you pick LM Studio but leave the runner on GitHub-hosted, the next-steps checklist flags it; the YAML never includes a bare API key.

The wizard needs LM Studio started with CORS enabled to probe from the browser:

```bash
lms server start --cors
```

(The `--cors` flag affects only the in-browser wizard, not the action itself.)

---

## How it works

```
pull_request event
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
  ┌──────────────┐   one review: inline comments where the line
  │ comment.ts   │   maps, summary table where it doesn't
  └──────────────┘
```

**Error handling.** Every stage degrades instead of crashing: AST failures fall back to text rules, LLM failures keep the deterministic message, and a `422` from GitHub (positions rejected because the diff moved) is retried as a summary-only review so the feedback still lands..

---

## Web app (companion UI)

A small local web app that turns the engine into a point-and-click tool: **connect a GitHub account → pick a repo → pick a PR → run the review → read the findings → post them back**. It reuses the exact same analysis pipeline as the Action (`src/index.ts` → `analyzePullRequest`), so results are identical.

```bash
npm run web          # serves the app at http://localhost:3180
```

Open that URL. You can authenticate two ways:

- **Personal access token** (default, no setup) — paste a PAT with the `repo` scope. It is stored only in the browser session and used solely to call GitHub from your machine.
- **GitHub OAuth** — set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` from `web/.env` (see `web/.env.example`) and register the callback `http://localhost:3180/api/auth/callback`.

What the app does:

- Lists your repositories (searchable) and their open PRs.
- Runs rules-only or LLM triage (OpenAI or LM Studio) — same `llm_api_base_url` / `model` knobs as the Action.
- Shows findings grouped by severity with inline location; the "Post to GitHub" button pushes them as a real review on the PR.

> The app never stores data. The token lives in the session cookie; nothing is written to disk or sent anywhere except GitHub. For OAuth, register the app under your own account.

The server (`web/server.ts`) and SPA (`web/public/`) are intentionally separate from the Action so the bundle stays self-contained for GitHub's runner.

---

## Repository layout

```
src/
  index.ts     orchestration, inputs, LLM budget
  github.ts    Octokit calls (paginated)
  diff.ts      unified-diff parsing and position math
  ast.ts       tree-sitter parsing and signature extraction
  rules.ts     the deterministic rule engine
  llm.ts       dual-backend client, retries, fail-closed floor
  comment.ts   review rendering and posting
  types.ts     shared types
__tests__/     106 tests, including integration for both backends
scripts/
  local-run.js     mock GitHub API + real action subprocess
  e2e-mock-llm.js  mock OpenAI-compatible server
  copy-wasm.js     vendors grammars into dist/
  demo-pr.sh       opens a real demo PR
fixtures/demo-pr/  base/head files and git-generated patches
panel/              static setup wizard (index.html, panel.css, panel.js)
dist/              committed build (index.js + 4 WASM files)
```

`dist/` is committed because GitHub Actions runs the pre-built bundle — there's no `npm install` on the runner. CI fails if it drifts from source, so **run `npm run build` before pushing**.

---

## License

MIT — see [LICENSE](LICENSE).
