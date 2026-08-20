# Contributing to PR Risk Checker

Thanks for considering a contribution. This project is a GitHub Action plus a small companion
web app — both live in this one repository and share the same analysis engine (`src/`), so a fix
in one place usually benefits both.

## Getting set up

You need **Node.js 20+** and **npm** — nothing else. There's no Python, no native build
toolchain, and no database.

```bash
git clone https://github.com/YashVMonpara/PR-risk-checker.git
cd pr-risk-checker
npm ci
```

That installs everything, including the tree-sitter WASM grammars used for AST parsing.

## Before you open a PR

Run the same checks CI runs:

```bash
npm run typecheck   # tsc --noEmit
npm run lint         # eslint over src/, __tests__/, web/
npm test             # jest — unit + integration
```

If you touched anything under `src/` (the Action's engine), **rebuild `dist/`** and commit the
result:

```bash
npm run build
```

CI has a `dist-up-to-date` job that fails the build if `dist/` drifts from source — this is
required because GitHub Actions runs the pre-built bundle directly, with no `npm install` step on
the runner.

If you touched the deterministic rules, add a fixture-backed test in `__tests__/rules.test.ts`.
If you touched anything diff/position-related, prefer a real `git diff --no-index` fixture over a
hand-written patch string — see `__tests__/diff.test.ts` for why (hand-written diffs are exactly
where off-by-one position bugs hide).

## Testing the whole pipeline locally

```bash
npm run e2e             # deterministic rules only, against a mock GitHub API
npm run e2e:mock-llm    # + a mock OpenAI-compatible server
npm run web              # the companion web app, at http://localhost:3180
```

See [`README.md`](README.md) for what each of these needs configured.

## Code style

- TypeScript, strict mode. Keep new code type-safe rather than reaching for `any`.
- Match the existing module boundaries described in [`ARCHITECTURE.md`](ARCHITECTURE.md) — e.g.
  `rules.ts` stays free of GitHub/network calls, `llm.ts` is the only place that talks to a
  model.
- Prettier formatting (`npm run format`) — not currently enforced in CI, but please run it before
  opening a PR.
- Commit messages: short, imperative, prefixed by area when it helps (`fix(web): ...`,
  `feat(rules): ...`, `chore: ...`). Doesn't need to be strict Conventional Commits, just
  scannable in `git log`.

## Adding a new deterministic rule

Rules live in `src/rules.ts` as objects implementing the `Rule` interface (`name`, `description`,
`check(context)`). Add the rule to the `RULES` array, add unit tests covering both a triggering
and a non-triggering case, and update the rules table in `README.md`.

## Reporting a security issue

Please **do not** open a public issue for a security vulnerability — see
[`SECURITY.md`](SECURITY.md) for how to report it privately.

## Questions

Open a [discussion or issue](https://github.com/YashVMonpara/PR-risk-checker/issues) — there's
no separate chat/forum for this project.
