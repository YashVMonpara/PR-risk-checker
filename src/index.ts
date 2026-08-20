import * as core from '@actions/core';
import * as github from '@actions/github';
import { extractStructuralChanges } from './ast';
import { postReview, buildSummary } from './comment';
import { getAddedLines } from './diff';
import { getChangedFiles, getFileContent, getPullRequestMeta, Octokit } from './github';
import { assessRiskWithLLM, buildLLMOptions } from './llm';
import { runRules } from './rules';
import { LLMOptions, RiskFinding, RuleContext, SEVERITY_ORDER, Severity } from './types';

/** Files we never analyse. */
const IGNORED = /(^|\/)(node_modules|dist|build|vendor|coverage)\//;

function parseSeverity(value: string): Severity {
  return value === 'info' || value === 'warning' || value === 'error' ? value : 'warning';
}

/** Removes duplicate findings that different files/rules produced. */
export function dedupe(findings: RiskFinding[]): RiskFinding[] {
  const seen = new Set<string>();
  const unique: RiskFinding[] = [];

  for (const finding of findings) {
    const key = `${finding.rule}|${finding.path ?? ''}|${finding.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }

  return unique;
}

/** Orders findings by severity (most severe first), then by file. */
export function sortFindings(findings: RiskFinding[]): RiskFinding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[b.level] - SEVERITY_ORDER[a.level];
    if (bySeverity !== 0) return bySeverity;
    return (a.path ?? '').localeCompare(b.path ?? '') || (a.line ?? 0) - (b.line ?? 0);
  });
}

/** Extracts a focused slice of the patch around the finding for LLM context. */
export function contextForFinding(patch: string | undefined, line?: number): string {
  if (!patch) return '';
  if (!line) return patch.slice(0, 4000);

  const lines = patch.split('\n');
  const added = getAddedLines(patch);
  const target = added.find((a) => a.lineNumber === line);
  if (!target) return patch.slice(0, 4000);

  // target.position is 1-based counting after the first hunk header.
  const headerOffset = lines.findIndex((l) => l.startsWith('@@'));
  const index = headerOffset + target.position;
  const start = Math.max(0, index - 8);
  const end = Math.min(lines.length, index + 9);

  return lines.slice(start, end).join('\n');
}

/**
 * Enriches findings with LLM judgement.
 *
 * A finding the model dismisses is dropped, EXCEPT error-level security findings,
 * which llm.ts refuses to dismiss. When the model is unreachable the deterministic
 * message is kept as-is.
 */
async function enrichWithLLM(
  findings: RiskFinding[],
  patchByFile: Map<string, string | undefined>,
  options: LLMOptions,
  maxCalls: number
): Promise<RiskFinding[]> {
  const kept: RiskFinding[] = [];
  let calls = 0;

  for (const finding of findings) {
    if (calls >= maxCalls) {
      kept.push(finding);
      continue;
    }

    calls += 1;
    const context = contextForFinding(
      finding.path ? patchByFile.get(finding.path) : undefined,
      finding.line
    );

    const verdict = await assessRiskWithLLM(
      finding,
      context,
      finding.path ?? 'pull request',
      options
    );

    if (!verdict) {
      kept.push(finding); // LLM unavailable — keep the deterministic finding
      continue;
    }

    if (!verdict.is_real_risk) {
      core.info(`LLM dismissed ${finding.rule} on ${finding.path ?? 'PR'}`);
      continue;
    }

    kept.push({
      ...finding,
      level: verdict.severity,
      message: verdict.comment.trim() || finding.message,
      llmEnriched: true,
    });
  }

  if (calls >= maxCalls) {
    core.info(`LLM call budget (${maxCalls}) reached; remaining findings kept as-is.`);
  }

  return kept;
}

/** Analyses a pull request and returns the findings, without posting. */
export async function analyzePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  llmOptions: LLMOptions | null,
  threshold: Severity,
  maxLLMCalls: number
) {
  const pr = await getPullRequestMeta(octokit, owner, repo, pullNumber);
  const files = await getChangedFiles(octokit, owner, repo, pullNumber);
  const analysable = files.filter((f) => !IGNORED.test(f.filename));

  core.info(`Analysing ${analysable.length} of ${files.length} changed file(s).`);

  const all: RiskFinding[] = [];

  for (const file of analysable) {
    const [baseContent, headContent] = await Promise.all([
      file.status === 'added' ? Promise.resolve(null) : getFileContent(octokit, owner, repo, pr.baseSha, file.filename),
      file.status === 'removed' ? Promise.resolve(null) : getFileContent(octokit, owner, repo, pr.headSha, file.filename),
    ]);

    let structuralChanges: RuleContext['structuralChanges'] = [];
    try {
      structuralChanges = await extractStructuralChanges(baseContent, headContent, file.filename);
    } catch (error) {
      core.warning(`AST analysis failed for ${file.filename}: ${error}`);
    }

    all.push(
      ...runRules({
        file,
        allFiles: files,
        pr,
        structuralChanges,
        addedLines: getAddedLines(file.patch ?? ''),
        headContent,
        baseContent,
      })
    );
  }

  const minRank = SEVERITY_ORDER[threshold];
  let findings = sortFindings(dedupe(all)).filter((f) => SEVERITY_ORDER[f.level] >= minRank);

  core.info(`${findings.length} finding(s) at or above "${threshold}".`);

  if (llmOptions && findings.length > 0) {
    const patchByFile = new Map(files.map((f) => [f.filename, f.patch]));
    findings = await enrichWithLLM(findings, patchByFile, llmOptions, maxLLMCalls);
    core.info(`${findings.length} finding(s) remain after LLM triage.`);
  }

  return { pr, files, findings };
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput('github_token');
    const threshold = parseSeverity(core.getInput('risk_threshold') || 'warning');
    const failOnError = core.getInput('fail_on_error') === 'true';
    const maxLLMCalls = parseInt(core.getInput('max_llm_calls') || '10', 10);

    const llmOptions = buildLLMOptions({
      apiKey: core.getInput('openai_api_key') || '',
      baseURL: core.getInput('llm_api_base_url') || '',
      model: core.getInput('model') || 'gpt-4o-mini',
    });

    if (!llmOptions) {
      core.info('No LLM configured — running deterministic rules only.');
    } else if (llmOptions.baseURL) {
      core.info(`Using custom LLM endpoint ${llmOptions.baseURL} with model "${llmOptions.model}".`);
    } else {
      core.info(`Using OpenAI with model "${llmOptions.model}".`);
    }

    const context = github.context;
    const pullNumber = context.payload.pull_request?.number;

    if (!pullNumber) {
      core.warning('No pull_request in the event payload — nothing to review.');
      core.setOutput('findings_count', 0);
      core.setOutput('summary', 'Not a pull request event.');
      return;
    }

    const { owner, repo } = context.repo;
    const octokit = github.getOctokit(token);

    const { pr, files, findings } = await analyzePullRequest(
      octokit,
      owner,
      repo,
      pullNumber,
      llmOptions,
      threshold,
      Number.isNaN(maxLLMCalls) ? 10 : maxLLMCalls
    );

    const result = await postReview(octokit, owner, repo, pullNumber, pr.headSha, findings, files);

    if (result.error) {
      core.warning(`Could not post the review: ${result.error}`);
    } else if (result.posted) {
      core.info(
        `Posted review: ${result.inlineCount} inline comment(s), ${result.summaryCount} in the summary.`
      );
    } else {
      core.info('No findings to report. ✅');
    }

    core.setOutput('findings_count', findings.length);
    core.setOutput('summary', buildSummary(findings));

    const errors = findings.filter((f) => f.level === 'error');
    if (failOnError && errors.length > 0) {
      core.setFailed(`${errors.length} error-severity finding(s) detected.`);
    }
  } catch (error) {
    core.setFailed(`PR Risk Checker failed: ${(error as Error).message ?? error}`);
  }
}

/* istanbul ignore next */
if (require.main === module) {
  void run();
}
