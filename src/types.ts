/**
 * Shared type definitions for PR Risk Reviewer.
 */

/** Severity levels, ordered from least to most severe. */
export type Severity = 'info' | 'warning' | 'error';

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/** Categories a finding can belong to. Security findings get special protection. */
export type RiskCategory =
  | 'security'
  | 'breaking-change'
  | 'missing-tests'
  | 'maintainability'
  | 'dependencies';

/** A single risk reported against the pull request. */
export interface RiskFinding {
  /** Identifier of the rule that produced this finding. */
  rule: string;
  category: RiskCategory;
  level: Severity;
  /** Human-readable message shown in the review comment. */
  message: string;
  /** Repository-relative file path, when the finding is file-scoped. */
  path?: string;
  /** 1-based line number in the HEAD version of the file. */
  line?: number;
  /** Optional short snippet of the offending code. */
  snippet?: string;
  /** Set to true once an LLM has reviewed and rewritten the message. */
  llmEnriched?: boolean;
}

/** A structural (AST-level) difference between base and head versions of a file. */
export interface StructuralChange {
  type:
    | 'signature_changed'
    | 'export_added'
    | 'export_removed'
    | 'function_added'
    | 'function_removed'
    | 'method_changed';
  /** Symbol name, e.g. the function or method identifier. */
  name: string;
  /** Whether the symbol is exported from the module. */
  exported: boolean;
  /** Parameter list before the change, if applicable. */
  before?: string;
  /** Parameter list after the change, if applicable. */
  after?: string;
  /** 1-based line in the head file where the symbol is declared. */
  line?: number;
}

/** A file changed by the pull request. */
export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  /** Unified diff for this file. Absent for binary files. */
  patch?: string;
  previous_filename?: string;
}

/** Pull request metadata needed by the rule engine. */
export interface PullRequestMeta {
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  additions: number;
  deletions: number;
}

/** Everything a rule needs to make a decision about one file. */
export interface RuleContext {
  file: ChangedFile;
  /** All files in the PR — lets rules reason about siblings (e.g. test files). */
  allFiles: ChangedFile[];
  pr: PullRequestMeta;
  structuralChanges: StructuralChange[];
  /** Lines added by this file's patch, with their new-file line numbers. */
  addedLines: AddedLine[];
  /** Content of the file at the head commit, when retrievable. */
  headContent: string | null;
  baseContent: string | null;
}

/** One added line from a unified diff. */
export interface AddedLine {
  /** 1-based line number in the new version of the file. */
  lineNumber: number;
  content: string;
  /** 1-based position within the file's unified diff (for review comments). */
  position: number;
}

/** A deterministic rule. */
export interface Rule {
  name: string;
  description: string;
  check(context: RuleContext): RiskFinding[];
}

/** Options controlling which LLM backend is used. */
export interface LLMOptions {
  /** API key. May be empty/dummy for LM Studio. */
  apiKey?: string;
  /** Custom base URL, e.g. http://localhost:1234/v1 for LM Studio. */
  baseURL?: string;
  model: string;
  /** Max attempts for a single call, including the first. */
  maxRetries?: number;
  /** Abort a single request after this many milliseconds. */
  timeoutMs?: number;
}

/** Structured verdict returned by the LLM triage step. */
export interface LLMVerdict {
  is_real_risk: boolean;
  severity: Severity;
  comment: string;
}

/** A review comment ready to be posted. */
export interface ReviewComment {
  path: string;
  position: number;
  body: string;
}

/** Parsed unified-diff hunk. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Position (in the file's diff) of the hunk header line itself. */
  headerPosition: number;
}
