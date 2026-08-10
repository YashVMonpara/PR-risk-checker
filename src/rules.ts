import { Rule, RuleContext, RiskFinding } from './types';

/** Files that look like tests. */
const TEST_PATTERN = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$/i;

/** Source files we expect to be covered by tests. */
const SOURCE_PATTERN = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];

export function isTestFile(path: string): boolean {
  return TEST_PATTERN.test(path);
}

export function isSourceFile(path: string): boolean {
  return SOURCE_PATTERN.test(path) && !isTestFile(path);
}

/** Strips a line comment so we do not flag patterns mentioned in prose. */
function isCommentLine(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

interface SecurityPattern {
  id: string;
  regex: RegExp;
  message: string;
}

const SECURITY_PATTERNS: SecurityPattern[] = [
  {
    id: 'eval',
    regex: /\beval\s*\(/,
    message:
      'Use of `eval()` executes arbitrary code and is a code-injection risk. Parse the value explicitly (e.g. `JSON.parse`) or dispatch through a lookup table instead.',
  },
  {
    id: 'new-function',
    regex: /\bnew\s+Function\s*\(/,
    message:
      '`new Function()` compiles a string into executable code, with the same injection risk as `eval()`. Prefer an explicit function or a lookup table.',
  },
  {
    id: 'inner-html',
    regex: /\.innerHTML\s*=/,
    message:
      'Assigning to `innerHTML` with untrusted data enables XSS. Use `textContent`, or sanitise the HTML first (e.g. DOMPurify).',
  },
  {
    id: 'dangerously-set-inner-html',
    regex: /dangerouslySetInnerHTML/,
    message:
      '`dangerouslySetInnerHTML` bypasses React\'s escaping and can introduce XSS. Render text as children, or sanitise the HTML before injecting it.',
  },
  {
    id: 'child-process-exec',
    regex: /\b(?:child_process\.)?exec(?:Sync)?\s*\(\s*[^)]*[`'"]?\s*\+|\bexec\s*\(\s*`[^`]*\$\{/,
    message:
      'Building a shell command through string concatenation allows command injection. Use `execFile`/`spawn` with an argument array instead.',
  },
  {
    id: 'sql-concat',
    regex:
      /(?:query|execute)\s*\(\s*[`'"](?:[^`'"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`'"]*)[`'"]\s*\+|(?:SELECT|INSERT|UPDATE|DELETE)[^`'"]*\$\{/i,
    message:
      'SQL built by concatenating values is vulnerable to SQL injection. Use parameterised queries / prepared statements.',
  },
  {
    id: 'hardcoded-secret',
    regex:
      /(?:api[_-]?key|secret|password|token|access[_-]?key)\s*[:=]\s*[`'"](?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9/+=]{24,})[`'"]/i,
    message:
      'This looks like a hardcoded credential. Move it to a secret store or environment variable and rotate the exposed value.',
  },
];

/** Rule 1 — security anti-patterns in newly added code. */
const securityRule: Rule = {
  name: 'security-anti-patterns',
  description: 'Detects dangerous constructs (eval, innerHTML, shell/SQL injection, secrets).',
  check(context) {
    const findings: RiskFinding[] = [];

    for (const line of context.addedLines) {
      if (isCommentLine(line.content)) continue;

      for (const pattern of SECURITY_PATTERNS) {
        if (pattern.regex.test(line.content)) {
          findings.push({
            rule: `security-anti-patterns/${pattern.id}`,
            category: 'security',
            level: 'error',
            message: pattern.message,
            path: context.file.filename,
            line: line.lineNumber,
            snippet: line.content.trim().slice(0, 200),
          });
        }
      }
    }

    return findings;
  },
};

/** Rule 2 — breaking changes to the module's public surface. */
const breakingChangeRule: Rule = {
  name: 'breaking-signature-change',
  description: 'Flags changed or removed exported signatures when tests were not updated.',
  check(context) {
    const testsTouched = context.allFiles.some((f) => isTestFile(f.filename));
    if (testsTouched) return [];

    const findings: RiskFinding[] = [];

    for (const change of context.structuralChanges) {
      if (!change.exported) continue;

      if (change.type === 'signature_changed' || change.type === 'method_changed') {
        findings.push({
          rule: 'breaking-signature-change',
          category: 'breaking-change',
          level: 'warning',
          message:
            `The exported signature of \`${change.name}\` changed from \`${change.before}\` to ` +
            `\`${change.after}\` and no test file was updated in this PR. Callers may break — ` +
            'consider updating tests and noting the change in the PR description.',
          path: context.file.filename,
          line: change.line,
        });
      } else if (change.type === 'export_removed') {
        findings.push({
          rule: 'breaking-signature-change',
          category: 'breaking-change',
          level: 'warning',
          message:
            `The exported symbol \`${change.name}\` was removed. This breaks any consumer that ` +
            'imports it — consider deprecating it first or documenting the removal.',
          path: context.file.filename,
        });
      }
    }

    return findings;
  },
};

/** Rule 3 — source changed without any accompanying test. */
const missingTestsRule: Rule = {
  name: 'missing-tests',
  description: 'Flags source changes that ship without any test file in the same PR.',
  check(context) {
    const { file, allFiles } = context;

    if (file.status === 'removed') return [];
    if (!isSourceFile(file.filename)) return [];
    if (allFiles.some((f) => isTestFile(f.filename))) return [];

    return [
      {
        rule: 'missing-tests',
        category: 'missing-tests',
        level: 'warning',
        message:
          `\`${file.filename}\` was changed but this PR contains no test file. Consider adding ` +
          'or updating a test that covers the new behaviour.',
        path: file.filename,
      },
    ];
  },
};

const LARGE_DIFF_LINES = 500;
const THIN_BODY_CHARS = 100;

/** Rule 4 — big diff with barely any explanation. */
const largeDiffRule: Rule = {
  name: 'large-diff-thin-description',
  description: 'Flags very large PRs that lack a meaningful description.',
  check(context) {
    const total = context.pr.additions + context.pr.deletions;
    if (total <= LARGE_DIFF_LINES) return [];
    if (context.pr.body.trim().length >= THIN_BODY_CHARS) return [];

    return [
      {
        rule: 'large-diff-thin-description',
        category: 'maintainability',
        level: 'info',
        message:
          `This PR changes ${total} lines but the description is only ` +
          `${context.pr.body.trim().length} characters. A short summary of the intent, scope, ` +
          'and risk areas would make review substantially easier.',
      },
    ];
  },
};

const DEPENDENCY_BLOCKS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/** Rule 5 — manifest and lockfile out of step. */
const dependencyRule: Rule = {
  name: 'dependency-lockfile-mismatch',
  description: 'Flags package.json dependency edits with no matching lockfile update.',
  check(context) {
    const { file, allFiles } = context;
    const name = file.filename.split('/').pop();

    if (name !== 'package.json') return [];

    const touchesDeps = dependencyLinesChanged(context);
    if (!touchesDeps) return [];

    const lockChanged = allFiles.some((f) => LOCKFILES.includes(f.filename.split('/').pop() ?? ''));
    if (lockChanged) return [];

    return [
      {
        rule: 'dependency-lockfile-mismatch',
        category: 'dependencies',
        level: 'warning',
        message:
          '`package.json` dependencies changed but no lockfile was updated in this PR. Run your ' +
          'package manager\'s install and commit the resulting lockfile so CI installs the same tree.',
        path: file.filename,
      },
    ];
  },
};

/**
 * True when this patch adds or modifies an actual dependency entry.
 *
 * Preferred path: use the full head content to locate the line ranges of the
 * dependency blocks, then check whether any added line falls inside one. This
 * works even when a dependency is added deep inside a long list, where the
 * diff's three lines of context never reveal the enclosing block header.
 *
 * Fallback (head content unavailable): track the enclosing block while walking
 * the patch itself.
 */
function dependencyLinesChanged(context: RuleContext): boolean {
  const { addedLines, headContent, file } = context;
  if (!file.patch) return false;

  const versioned = addedLines.filter((line) => VERSIONED_ENTRY.test(line.content));
  if (versioned.length === 0) return false;

  if (headContent) {
    const ranges = dependencyBlockRanges(headContent);
    return versioned.some((line) =>
      ranges.some(([start, end]) => line.lineNumber > start && line.lineNumber < end)
    );
  }

  return patchTouchesDependencyBlock(file.patch);
}

const VERSIONED_ENTRY = /^\s*"[^"]+"\s*:\s*"[~^>=<* ]*[\d*x]/;

/** Finds the [startLine, endLine] range of each dependency block in a package.json. */
function dependencyBlockRanges(content: string): Array<[number, number]> {
  const lines = content.split('\n');
  const ranges: Array<[number, number]> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = /^\s*"([^"]+)"\s*:\s*\{/.exec(lines[i]);
    if (!header || !DEPENDENCY_BLOCKS.has(header[1])) continue;

    const indent = lines[i].search(/\S/);
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*\}/.test(lines[j]) && lines[j].search(/\S/) <= indent) {
        ranges.push([i + 1, j + 1]);
        break;
      }
    }
  }

  return ranges;
}

/** Fallback: track the enclosing package.json block while walking the patch. */
function patchTouchesDependencyBlock(patch: string): boolean {
  let currentBlock: string | null = null;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      currentBlock = null; // a new hunk may start anywhere in the file
      continue;
    }

    const line = raw.slice(1);

    const blockHeader = /^\s{0,4}"([^"]+)"\s*:\s*\{/.exec(line);
    if (blockHeader) {
      currentBlock = blockHeader[1];
      continue;
    }

    if (/^\s{0,4}\}/.test(line)) {
      currentBlock = null;
      continue;
    }

    if (
      (raw.startsWith('+') || raw.startsWith('-')) &&
      VERSIONED_ENTRY.test(line) &&
      currentBlock &&
      DEPENDENCY_BLOCKS.has(currentBlock)
    ) {
      return true;
    }
  }

  return false;
}

/** All deterministic rules, in reporting order. */
export const RULES: Rule[] = [
  securityRule,
  breakingChangeRule,
  missingTestsRule,
  largeDiffRule,
  dependencyRule,
];

/**
 * Runs every rule against one file's context.
 * A rule that throws is skipped rather than taking the whole run down.
 */
export function runRules(context: RuleContext, rules: Rule[] = RULES): RiskFinding[] {
  const findings: RiskFinding[] = [];

  for (const rule of rules) {
    try {
      findings.push(...rule.check(context));
    } catch (error) {
      console.warn(`Rule "${rule.name}" failed on ${context.file.filename}: ${error}`);
    }
  }

  return findings;
}
