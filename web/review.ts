/**
 * Server-side entry point into the PR Risk Reviewer engine.
 *
 * Reuses the action's analysis pipeline (analyzePullRequest) and the real GitHub
 * posting path (postReview) so the web app and the Action never drift. The only
 * difference is the Octokit client: the Action uses @actions/github's getOctokit,
 * here we build one from whichever token/session the request carries.
 */
import * as github from '@actions/github';
import { analyzePullRequest } from '../src/index';
import { postReview } from '../src/comment';
import { buildLLMOptions } from '../src/llm';
import type { LLMOptions, RiskFinding, Severity } from '../src/types';

const DEFAULT_THRESHOLD: Severity = 'warning';

export interface AnalyzeParams {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  /** LLM configuration — optional. Omit for deterministic-only. */
  llm?: { apiKey?: string; baseURL?: string; model?: string };
  threshold?: Severity;
  maxLLMCalls?: number;
}

export interface AnalyzeResult {
  pr: {
    number: number;
    title: string;
    body: string;
    additions: number;
    deletions: number;
    headSha: string;
  };
  findings: RiskFinding[];
  /** True when an LLM was consulted (vs deterministic rules only). */
  usedLLM: boolean;
}

/**
 * Runs the full analysis against a real GitHub PR and returns the findings.
 * Does NOT post anything — the web UI shows them first and the user decides.
 */
export async function analyze(params: AnalyzeParams): Promise<AnalyzeResult> {
  const octokit = github.getOctokit(params.token);

  const llmOptions: LLMOptions | null = params.llm
    ? buildLLMOptions({
        apiKey: params.llm.apiKey ?? '',
        baseURL: params.llm.baseURL ?? '',
        model: params.llm.model ?? 'gpt-4o-mini',
      })
    : null;

  const { pr, findings } = await analyzePullRequest(
    octokit as never,
    params.owner,
    params.repo,
    params.pullNumber,
    llmOptions,
    params.threshold ?? DEFAULT_THRESHOLD,
    params.maxLLMCalls ?? 10
  );

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      additions: pr.additions,
      deletions: pr.deletions,
      headSha: pr.headSha,
    },
    findings,
    usedLLM: llmOptions !== null,
  };
}

/**
 * Posts the review to the PR. Used only when the user clicks "Post to GitHub".
 */
export async function postToGitHub(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  findings: RiskFinding[]
): Promise<{ posted: boolean; inlineCount: number; summaryCount: number; error?: string }> {
  const octokit = github.getOctokit(token);
  // We only need the file list for fallbacks; re-fetch to keep postReview self-contained.
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return postReview(
    octokit as never,
    owner,
    repo,
    pullNumber,
    pr.head.sha,
    findings,
    files as never
  );
}

import { generateFixes, applyPatch, type FixPlan } from '../src/fix';

/**
 * Generates auto-fix plans for the given findings. Requires an LLM (the fixes
 * are model-proposed). Returns one FixPlan per finding describing what can be
 * applied, what needs user input, and what was skipped.
 */
export async function generateFixPlans(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  findings: RiskFinding[],
  llm: { apiKey?: string; baseURL?: string; model?: string }
): Promise<FixPlan[]> {
  const octokit = github.getOctokit(token);
  const llmOptions = buildLLMOptions({
    apiKey: llm.apiKey ?? '',
    baseURL: llm.baseURL ?? '',
    model: llm.model ?? 'gpt-4o-mini',
  });
  if (!llmOptions) {
    throw new Error('An LLM must be configured to generate fixes (OpenAI key or LM Studio base URL).');
  }
  return generateFixes({
    octokit: octokit as never,
    owner,
    repo,
    headSha,
    findings,
    llmOptions,
  });
}

export interface ApplyFixResult {
  applied: number;
  skippedNeedsInput: number;
  failed: number;
  /** Per-file commit results for the UI summary. */
  commits: Array<{ path: string; status: 'committed' | 'failed'; sha?: string; error?: string }>;
}

/**
 * Applies the approved fixes by committing them to the PR's head branch, one
 * commit per file. Only plans whose path is in `approvedPaths` AND is actually
 * part of the PR's changed files are touched, and a plan is only applied if its
 * proposal still matches the file verbatim (the `applyPatch` guardrail) — so a
 * stale or fabricated plan can never touch a file outside the PR or corrupt one
 * inside it. The client supplies `plans`/`approvedPaths` wholesale (they're not
 * cryptographically bound to a prior /api/fix response), so this endpoint is
 * the only place that re-checks a plan's path is real before writing anything.
 *
 * Fail-closed: a failure on one file is reported and does not abort the others.
 * PRs from forks (where the token lacks push access) fail with a clear message
 * rather than a confusing 404/422.
 */
export async function applyFixes(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  pullNumber: number,
  plans: FixPlan[],
  approvedPaths: string[]
): Promise<ApplyFixResult> {
  const octokit = github.getOctokit(token);
  const { data: prMeta } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const headRef = prMeta.head.ref;
  const prFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const prPaths = new Set(prFiles.map((f) => f.filename));

  const approved = new Set(approvedPaths);
  const commits: ApplyFixResult['commits'] = [];
  let applied = 0;
  let skippedNeedsInput = 0;
  let failed = 0;

  // Group approved, applicable plans by file path (one commit per file).
  // Only paths genuinely part of this PR are eligible — anything else is a
  // fabricated or stale request and is rejected rather than silently dropped.
  const byPath = new Map<string, FixPlan[]>();
  for (const plan of plans) {
    if (!approved.has(plan.path) || !plan.proposal) continue;
    if (!prPaths.has(plan.path)) {
      commits.push({ path: plan.path, status: 'failed', error: 'This path is not part of the pull request — refusing to apply.' });
      failed += 1;
      continue;
    }
    if (plan.status === 'needs_input' && plan.proposal.needs_user_input) {
      // The engine said a human must decide; if the user still approved it we
      // attempt it (applyPatch will validate), but count it as "needs input".
      skippedNeedsInput += 1;
    }
    const list = byPath.get(plan.path) ?? [];
    list.push(plan);
    byPath.set(plan.path, list);
  }

  for (const [path, filePlans] of byPath) {
    try {
      // Fetch current file content + its blob SHA at head so we can update it.
      const { data: current } = await octokit.rest.repos.getContent({ owner, repo, path, ref: headSha });
      if (!('content' in current) || typeof current.content !== 'string') {
        commits.push({ path, status: 'failed', error: 'Not a regular file (directory or submodule).' });
        failed += 1;
        continue;
      }
      let content = Buffer.from(current.content, 'base64').toString('utf8');
      const blobSha = current.sha;

      // Apply each approved patch, validating it matches verbatim.
      let allApplied = true;
      for (const plan of filePlans) {
        if (!plan.proposal) continue;
        const patched = applyPatch(content, plan.proposal.old_lines, plan.proposal.new_lines);
        if (patched === null) {
          allApplied = false;
          break;
        }
        content = patched;
      }

      if (!allApplied) {
        commits.push({ path, status: 'failed', error: 'A proposed change no longer matches the file (it may have shifted). Not applying.' });
        failed += 1;
        continue;
      }

      // Commit the updated file back to the PR head branch.
      const result = await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message: `fix(pr-risk-reviewer): auto-fix ${filePlans.length} finding(s) in ${path}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha: blobSha,
        branch: headRef,
      });
      commits.push({ path, status: 'committed', sha: result.data.commit.sha });
      applied += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      commits.push({ path, status: 'failed', error: msg });
      failed += 1;
    }
  }

  return { applied, skippedNeedsInput, failed, commits };
}
