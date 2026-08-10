import { calculatePosition } from './diff';
import { Octokit } from './github';
import { ChangedFile, ReviewComment, RiskFinding, Severity } from './types';

const SEVERITY_LABEL: Record<Severity, string> = {
  info: 'ℹ️ Info',
  warning: '⚠️ Warning',
  error: '🚨 Error',
};

const FOOTER = '<sub>🤖 Posted by [PR Risk Reviewer](https://github.com/marketplace/actions/pr-risk-reviewer)</sub>';

export interface PostResult {
  posted: boolean;
  inlineCount: number;
  summaryCount: number;
  error?: string;
}

/** Renders one finding as an inline review comment body. */
function renderInline(finding: RiskFinding): string {
  const label = SEVERITY_LABEL[finding.level];
  const enriched = finding.llmEnriched ? ' · AI-reviewed' : '';

  return [
    `**${label}** · \`${finding.category}\`${enriched}`,
    '',
    finding.message,
    '',
    FOOTER,
  ].join('\n');
}

/** Builds the markdown body for the review itself. */
export function buildSummary(findings: RiskFinding[], unmapped: RiskFinding[] = []): string {
  if (findings.length === 0) {
    return `## PR Risk Reviewer\n\n✅ No risks detected in this pull request.\n\n${FOOTER}`;
  }

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.level] += 1;

  const parts: string[] = [];
  if (counts.error) parts.push(`${counts.error} error${counts.error === 1 ? '' : 's'}`);
  if (counts.warning) parts.push(`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`);
  if (counts.info) parts.push(`${counts.info} info`);

  const lines = [
    '## PR Risk Reviewer',
    '',
    `Found **${findings.length}** item${findings.length === 1 ? '' : 's'} — ${parts.join(', ')}.`,
    '',
  ];

  if (unmapped.length > 0) {
    lines.push('| Severity | Category | Location | Finding |', '| --- | --- | --- | --- |');

    for (const finding of unmapped) {
      const location = finding.path
        ? `\`${finding.path}${finding.line ? `:${finding.line}` : ''}\``
        : '_pull request_';
      const message = finding.message.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
      lines.push(
        `| ${SEVERITY_LABEL[finding.level]} | \`${finding.category}\` | ${location} | ${message} |`
      );
    }

    lines.push('');
  }

  lines.push(FOOTER);
  return lines.join('\n');
}

/**
 * Publishes findings as a single pull request review.
 *
 * Findings whose line maps into the diff become inline comments; everything else
 * (PR-level findings, or lines GitHub cannot position) goes into the review body
 * so nothing is silently dropped.
 */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  findings: RiskFinding[],
  files: ChangedFile[]
): Promise<PostResult> {
  if (findings.length === 0) {
    return { posted: false, inlineCount: 0, summaryCount: 0 };
  }

  const patchByFile = new Map(files.map((f) => [f.filename, f.patch]));
  const comments: ReviewComment[] = [];
  const unmapped: RiskFinding[] = [];

  for (const finding of findings) {
    const patch = finding.path ? patchByFile.get(finding.path) : undefined;
    const position =
      finding.path && finding.line && patch ? calculatePosition(patch, finding.line) : null;

    if (finding.path && position !== null) {
      comments.push({ path: finding.path, position, body: renderInline(finding) });
    } else {
      unmapped.push(finding);
    }
  }

  const body = buildSummary(findings, unmapped);

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body,
      ...(comments.length > 0 ? { comments } : {}),
    });

    return { posted: true, inlineCount: comments.length, summaryCount: unmapped.length };
  } catch (error) {
    const status = (error as { status?: number }).status;

    // 422 means GitHub rejected our positions (e.g. the diff moved under us).
    // Retry once with everything in the body so the review still lands.
    if (status === 422 && comments.length > 0) {
      try {
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: headSha,
          event: 'COMMENT',
          body: buildSummary(findings, findings),
        });

        return { posted: true, inlineCount: 0, summaryCount: findings.length };
      } catch (retryError) {
        return {
          posted: false,
          inlineCount: 0,
          summaryCount: 0,
          error: String((retryError as Error).message ?? retryError),
        };
      }
    }

    return {
      posted: false,
      inlineCount: 0,
      summaryCount: 0,
      error: String((error as Error).message ?? error),
    };
  }
}
