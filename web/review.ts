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
  pr: { number: number; title: string; body: string; additions: number; deletions: number };
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
