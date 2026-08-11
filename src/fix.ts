/**
 * Auto-fix engine: proposes safe, minimal patches for review findings using the
 * LLM, then validates them with strict guardrails before anything is applied.
 *
 * SAFETY MODEL (fail-closed — nothing is applied unless every check passes):
 *   1. The proposal's old_lines must appear VERBATIM and EXACTLY ONCE in the
 *      current file. If it appears 0 times the patch can't apply; if >1 the
 *      edit is ambiguous, so we refuse rather than guess which occurrence.
 *   2. new_lines must not be empty and must not be identical to old_lines
 *      (a no-op fix is rejected as pointless).
 *   3. The model's own needs_user_input flag is honoured: if it says it needs a
 *      human decision (real secret, breaking change with external consumers,
 *      low confidence) we surface that and never auto-apply.
 *   4. A lightweight balance check rejects patches that look truncated (e.g. an
 *      unbalanced brace/paren count that would obviously corrupt the file).
 *   5. PRs from forks can't be pushed to by a token without write access, so the
 *      apply step refuses and explains instead of failing mid-way.
 *
 * The engine produces a FixPlan per finding. The caller (web app) shows the plan
 * and only commits the ready ones the user approves.
 */
import { getFileContent } from './github';
import { generateFixWithLLM, type FixProposal } from './llm';
import type { LLMOptions, RiskFinding } from './types';

/** Outcome of trying to fix one finding. */
export type FixStatus = 'ready' | 'needs_input' | 'skipped' | 'error';

export interface FixPlan {
  finding: RiskFinding;
  status: FixStatus;
  proposal?: FixProposal;
  fileContent?: string;
  path: string;
  reason?: string;
  confidence?: number;
}

export interface GenerateFixesParams {
  octokit: unknown;
  owner: string;
  repo: string;
  headSha: string;
  findings: RiskFinding[];
  llmOptions: LLMOptions;
  minConfidence?: number;
  maxFixes?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MAX_FIXES = 20;

/** Counts unbalanced braces/parens/brackets in a block of code. */
function balanceDelta(text: string): number {
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const open = new Set(['(', '[', '{']);

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const prev = text[i - 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '/' && prev === '*') inBlockComment = false;
      continue;
    }
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      inLineComment = true;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      inBlockComment = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (open.has(ch)) depth += 1;
    else if (pairs[ch]) {
      if (depth <= 0) return Number.NaN;
      depth -= 1;
    }
  }
  return depth;
}

/**
 * Applies old_lines -> new_lines to content. Returns null if old_lines does not
 * appear exactly once (the guardrail the engine relies on).
 */
export function applyPatch(content: string, oldLines: string, newLines: string): string | null {
  const occurrences = content.split(oldLines).length - 1;
  if (occurrences !== 1) return null;
  return content.replace(oldLines, newLines);
}

/** Validates that a proposed patch is safe to apply. */
function validateProposal(
  fileContent: string,
  proposal: FixProposal
): { ok: true; reason?: undefined } | { ok: false; reason: string } {
  if (proposal.needs_user_input) {
    return { ok: false, reason: proposal.user_input_reason || 'Model flagged this as needing a human decision.' };
  }
  if (!proposal.old_lines.trim()) {
    return { ok: false, reason: 'Model returned empty old_lines — cannot locate the change.' };
  }
  if (!proposal.new_lines.trim()) {
    return { ok: false, reason: 'Model returned empty new_lines — would delete code without replacement.' };
  }
  if (proposal.old_lines === proposal.new_lines) {
    return { ok: false, reason: 'Proposed fix is identical to the original — no change.' };
  }

  const occurrences = fileContent.split(proposal.old_lines).length - 1;
  if (occurrences === 0) {
    return { ok: false, reason: 'The lines to replace were not found verbatim in the current file (may have shifted). Manual review needed.' };
  }
  if (occurrences > 1) {
    return { ok: false, reason: 'The lines to replace appear more than once — edit is ambiguous, refusing to guess.' };
  }

  const patched = applyPatch(fileContent, proposal.old_lines, proposal.new_lines);
  if (patched === null) {
    return { ok: false, reason: 'Patch could not be applied (unexpected).' };
  }
  const delta = balanceDelta(patched);
  if (Number.isNaN(delta)) {
    return { ok: false, reason: 'Resulting file has an unmatched closing bracket — fix looks incomplete.' };
  }
  if (delta < 0) {
    return { ok: false, reason: 'Resulting file is missing opening brackets — fix looks incomplete.' };
  }

  return { ok: true };
}

/**
 * Generates fix plans for the given findings. Pure with respect to GitHub — it
 * only reads file contents and asks the LLM; it never writes.
 */
export async function generateFixes(params: GenerateFixesParams): Promise<FixPlan[]> {
  const {
    octokit,
    owner,
    repo,
    headSha,
    findings,
    llmOptions,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    maxFixes = DEFAULT_MAX_FIXES,
  } = params;

  const plans: FixPlan[] = [];
  let attempted = 0;

  for (const finding of findings) {
    const path = finding.path;
    if (!path) {
      plans.push({
        finding,
        status: 'skipped',
        path: '(PR-level)',
        reason: 'This finding is not tied to a specific file, so there is no code to change.',
      });
      continue;
    }
    if (attempted >= maxFixes) {
      plans.push({ finding, status: 'skipped', path, reason: `Reached the cap of ${maxFixes} fixes to attempt.` });
      continue;
    }

    attempted += 1;
    const fileContent = await getFileContent(octokit as never, owner, repo, headSha, path);

    if (fileContent === null) {
      plans.push({
        finding,
        status: 'error',
        path,
        reason: 'Could not read the file at the PR head — it may have been deleted or renamed.',
      });
      continue;
    }

    const proposal = await generateFixWithLLM(finding, fileContent, path, llmOptions);
    if (!proposal) {
      plans.push({
        finding,
        status: 'error',
        path,
        reason: 'The model did not return a usable fix (unavailable or unintelligible).',
      });
      continue;
    }

    if (proposal.confidence < minConfidence) {
      plans.push({
        finding,
        status: 'needs_input',
        path,
        proposal,
        fileContent,
        confidence: proposal.confidence,
        reason: `Model confidence ${proposal.confidence.toFixed(2)} is below the safe threshold (${minConfidence}). Review manually before applying.`,
      });
      continue;
    }

    const check = validateProposal(fileContent, proposal);
    if (!check.ok) {
      plans.push({
        finding,
        status: proposal.needs_user_input ? 'needs_input' : 'error',
        path,
        proposal,
        fileContent,
        confidence: proposal.confidence,
        reason: check.reason,
      });
      continue;
    }

    plans.push({
      finding,
      status: 'ready',
      path,
      proposal,
      fileContent,
      confidence: proposal.confidence,
    });
  }

  return plans;
}
