# PR Risk Reviewer — Architecture & Design

This is the design document for the action. It records what was built, why, and
which decisions were forced by evidence gathered while building it.

---

## 1. Problem

Pull request review has two failure modes that tooling can help with:

1. **Linters are context-blind.** They flag `eval()` but can't tell you that the
   exported function you just changed has three callers and no updated test.
2. **LLMs alone are unreliable and expensive.** Feeding an entire diff to a model
   produces confident, unfocused output and scales badly with PR size.

The design combines them: deterministic analysis decides *what* to look at, and
the LLM decides *whether it matters* and *how to explain it*.

---

## 2. Architecture

```
pull_request event
   → github.ts    fetch PR metadata, changed files + patches, base/head contents
   → diff.ts      parse unified diff into hunks, added lines, diff positions
   → ast.ts       tree-sitter parse of base AND head; extract + diff signatures
   → rules.ts     deterministic rule engine → RiskFinding[]
   → llm.ts       optional triage: confirm / dismiss / reword each finding
   → comment.ts   one review: inline comments + summary table
```

Each module is independently testable and has no knowledge of the ones after it.
`index.ts` is the only place that knows the full sequence.

### Data flow

| Stage | Input | Output |
| --- | --- | --- |
| Diff fetch | owner, repo, PR number | `ChangedFile[]` with patches, `PullRequestMeta` |
| Diff parse | `patch` string | `DiffHunk[]`, `AddedLine[]`, line→position map |
| AST | base + head file contents | `StructuralChange[]` |
| Rules | file + diff + structural changes + PR meta | `RiskFinding[]` |
| LLM | one finding + focused diff slice | `LLMVerdict` or `null` |
| Comment | findings + patches | one `createReview` call |

---

## 3. Risk categories

| Category | Severity | Detection |
| --- | --- | --- |
| Security anti-patterns | error | Regex over **added lines only**, skipping comments: `eval()`, `new Function()`, `innerHTML =`, `dangerouslySetInnerHTML`, concatenated shell commands, concatenated SQL, hardcoded secrets |
| Breaking API change | warning | AST signature diff on **exported** symbols, when no test file changed |
| Missing tests | warning | Source file changed, no test file anywhere in the PR |
| Dependency mismatch | warning | `package.json` dependency blocks changed without a lockfile change, or vice versa |
| Large diff, thin description | info | >500 changed lines and <100 characters of PR body |

Secret detection skips comment lines and placeholder values (`xxx`, `your-key-here`,
`changeme`) — without those exclusions the rule was unusable on real repos.

---

## 4. Tree-sitter strategy

**Decision: WASM grammars (`web-tree-sitter`), not native bindings.**

A GitHub Action runs a pre-built bundle with no `npm install` on the runner. The
native `tree-sitter` package needs `node-gyp` and a compiler at install time and
produces a `.node` binary that ncc cannot bundle. This was verified before any
implementation: native bindings are a dead end for this deployment model.

`web-tree-sitter` loads `.wasm` grammar files at runtime instead. `scripts/copy-wasm.js`
vendors four files into `dist/` at build time:

| File | Size |
| --- | --- |
| `web-tree-sitter.wasm` (runtime) | 196 KB |
| `tree-sitter-javascript.wasm` | 402 KB |
| `tree-sitter-typescript.wasm` | 1381 KB |
| `tree-sitter-tsx.wasm` | 1412 KB |

Grammars come from `@vscode/tree-sitter-wasm`, which publishes prebuilt WASM. The
npm `tree-sitter-javascript` package ships grammar *source*, not WASM.

### Signature extraction

One tree-sitter query captures four declaration forms:

```scheme
(function_declaration name: (identifier) @name parameters: (formal_parameters) @params) @fn
(generator_function_declaration …) @fn
(variable_declarator name: (identifier) @name
  value: [(arrow_function parameters: (formal_parameters) @params)
          (function_expression parameters: (formal_parameters) @params)]) @fn
(method_definition name: (property_identifier) @name parameters: (formal_parameters) @params) @method
```

Base and head are parsed separately and the resulting `{ name, params, exported }`
sets are compared. Methods are keyed as `ClassName.methodName`; export status is
resolved by walking up to the enclosing `export_statement`.

Only *exported* signature changes are reported as breaking — internal refactors are
not the caller's problem.

---

## 5. LLM integration

### Dual backend

One `OpenAI` client handles both cases; only the constructor arguments differ.

| `openai_api_key` | `llm_api_base_url` | Behaviour |
| --- | --- | --- |
| ❌ | ❌ | `buildLLMOptions` returns `null` — LLM skipped entirely |
| ✅ | ❌ | `baseURL: undefined` → api.openai.com |
| ❌ | ✅ | `apiKey: 'lm-studio'` placeholder (SDK requires non-empty), custom `baseURL` |
| ✅ | ✅ | Both honoured — authenticated proxy / vLLM / Together |

Prompt construction is identical across backends: the action is model-agnostic.

### Structured output, not free text

The original brief specified a prompt whose answer was either a review comment or
the literal string `SAFE`. That was replaced with a JSON schema
(`response_format: json_schema`) returning `{ is_real_risk, severity, comment }`,
because free-text `SAFE` parsing is ambiguous and gives no severity signal.
Bare `SAFE` replies are still handled for models that ignore the schema.

### Fail-closed safety floor — evidence-driven

**Verified failure:** `qwen/qwen3-vl-8b` in LM Studio, asked about
`return eval(options.expr)` — a textbook injection — replied `SAFE`.

Under the original "if the LLM says SAFE, discard the finding" design, that would
have **silently deleted a real security finding**. So:

> An `error`-level finding in the `security` category can never be dismissed or
> downgraded by the model. The model's wording is kept; the verdict is floored.

Everything else remains dismissible — that's how false positives get filtered.
This is enforced in `applySafetyFloor` and covered by tests in both `llm.test.ts`
and `integration.test.ts`.

### Resilience

- Up to 3 attempts with exponential backoff (500ms, 1s, 2s).
- 60s timeout per request; SDK-internal retries disabled so retry logging is ours.
- `max_llm_calls` (default 10) caps cost and runtime; findings past the budget keep
  their deterministic message.
- Any failure returns `null` → the caller keeps the deterministic finding. The LLM
  can only ever *improve* output, never remove it through failure.

---

## 6. Comment positioning

GitHub's `position` is **not** a file line number: it's the 1-based index of the
line within the unified diff, counting from the line after the first `@@` header,
including context and deleted lines, and **counting subsequent `@@` headers**.

`calculatePosition(patch, lineNumber)` walks the patch tracking both the new-side
line number and the diff position, and returns the position for the target line —
or `null` when the line isn't in the diff.

Fallback chain, so feedback is never silently lost:

1. Line maps into the diff → inline comment.
2. Line doesn't map, or the finding is PR-level → row in the review's summary table.
3. GitHub rejects the positions (`422`) → retry once as a summary-only review.

Everything is posted as a **single** `createReview` call with `event: 'COMMENT'`,
which avoids per-comment secondary rate limits.

---

## 7. Testing strategy

| Layer | What's real | What's faked |
| --- | --- | --- |
| Unit (97 tests) | The module under test | Its collaborators |
| Integration (9 tests) | Diff parsing, real tree-sitter, rules, positions, rendering | Octokit, the LLM HTTP call |
| E2E (`npm run e2e`) | The built `dist/index.js` in a subprocess, real HTTP | GitHub API (local mock server) |
| E2E mock LLM | Built action + real HTTP to a local OpenAI-compatible server | — |
| E2E LM Studio | Built action + **real local model inference** | — |

Coverage: 86% statements, above the 80% target.

Fixture patches are generated with `git diff --no-index` rather than hand-written,
because hand-written diffs are exactly where position bugs hide.

---

## 8. CI/CD

`.github/workflows/ci.yml`:

| Job | Purpose |
| --- | --- |
| `build-and-test` | typecheck, lint, unit + integration tests with coverage |
| `dist-up-to-date` | rebuilds and fails if `dist/` differs from the commit |
| `e2e-simulation` | runs the built action against the mock GitHub API, with and without a mock LLM |
| `action-smoke-test` | runs the action on its own repo via `uses: ./` |

`dist/` is committed because Actions runs the pre-built bundle. The `dist-up-to-date`
job is what keeps that honest.

---

## 9. Decisions forced by evidence

| Decision | Why |
| --- | --- |
| WASM grammars over native tree-sitter | Native `.node` binaries can't be bundled by ncc or built on a runner |
| `@actions/core` pinned to 1.11.1 | v3 is ESM-only; ncc produced a bundle with `webpackMissingModule` stubs that crashed at startup |
| `undici` override to ^7.29.0 | `@actions/github@6` pulls undici 5.29.0 with 3 known advisories; the override clears `npm audit` while keeping CJS compatibility |
| Fail-closed on security findings | A local 8B model dismissed a real `eval()` injection as SAFE |
| JSON schema instead of `SAFE` sentinel | Unambiguous parsing, plus a severity signal |
| Async `spawn` in the mock-LLM harness | `spawnSync` blocks the parent event loop, so the mock server could never answer the child — the harness deadlocked until it was changed |
| Dependency rule uses head content | Diff context alone can't tell which JSON block a changed line belongs to |
| Single `createReview` call | Avoids GitHub secondary rate limits |

---

## 10. Known limitations

- **JS/TS/TSX only.** Adding a language means adding a grammar (~1MB) and an
  extension mapping.
- **`localhost` is the runner's localhost.** LM Studio on your laptop is not
  reachable from a GitHub-hosted runner; use a self-hosted runner.
- **Small local models produce weaker triage** than `gpt-4o-mini`. Security findings
  are protected, but expect more surviving false positives elsewhere.
- **Renamed files** are analysed as-is; the rename itself isn't reported.
- **`position` is legacy.** GitHub also offers `line`/`side`; `position` was chosen
  as specified and works consistently with computed diff offsets.
