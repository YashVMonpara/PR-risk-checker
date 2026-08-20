# Security Policy

PR Risk Checker handles GitHub tokens and, optionally, LLM API keys — both as a GitHub Action
and as a local web app. We take reports about either seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Instead, use one of these private channels:

1. **[GitHub Security Advisories](https://github.com/YashVMonpara/PR-risk-checker/security/advisories/new)**
   (preferred) — lets you report privately and, if you want, collaborate on a fix before it's
   disclosed.
2. Email the maintainer directly (see the profile on the
   [repository's GitHub page](https://github.com/YashVMonpara/PR-risk-checker)) with a subject
   line starting `SECURITY:`.

Please include:

- What you found and why it matters (impact).
- Steps to reproduce, or a minimal proof of concept.
- Which component is affected: the GitHub Action (`src/`) or the web app (`web/`).

We'll acknowledge reports within a few days and aim to have a fix or mitigation out within two
weeks for anything credible, faster for anything actively exploitable.

## Scope

In scope:

- Anything that could leak a GitHub token, PAT, session cookie, or LLM API key to an
  unintended party.
- Any way to bypass the web app's authentication or session handling.
- Any way for the auto-fix feature to write to a file outside the pull request being reviewed,
  or to commit something the user didn't approve.
- Any way for the deterministic rules or LLM prompt construction to be tricked into executing
  code, rather than just analyzing it.
- Any way the web app becomes reachable from outside `localhost` without the operator
  deliberately opting in.

Out of scope / won't-fix by design:

- The LLM itself producing a wrong verdict (false positive/negative) on a *non-security* finding
  — this is inherent to using a model for triage. Security-severity findings are explicitly
  fail-closed and can never be dismissed by the model (see `applySafetyFloor` in `src/llm.ts`
  and the README's Security & Privacy section) — a bypass of *that* specific guarantee is very
  much in scope.
- Vulnerabilities that require the attacker to already have your GitHub token or LLM API key.

## Supported versions

This project doesn't yet maintain multiple release lines — security fixes land on `main` and are
included in the next tagged release (or the next `dist/` rebuild, for Action consumers pinned to
`@main`).
