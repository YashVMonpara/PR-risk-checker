import { runRules, RULES } from '../src/rules';
import { getAddedLines } from '../src/diff';
import { ChangedFile, PullRequestMeta, RuleContext, StructuralChange } from '../src/types';

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -1,2 +1,3 @@\n keep\n+added line\n keep2',
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequestMeta> = {}): PullRequestMeta {
  return {
    number: 1,
    title: 'Some change',
    body:
      'A reasonably detailed description of what this pull request changes, why it matters, ' +
      'and which areas reviewers should pay the closest attention to.',
    baseSha: 'base',
    headSha: 'head',
    additions: 10,
    deletions: 5,
    ...overrides,
  };
}

function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
  const f = overrides.file ?? file();
  return {
    file: f,
    allFiles: overrides.allFiles ?? [f],
    pr: overrides.pr ?? pr(),
    structuralChanges: overrides.structuralChanges ?? [],
    addedLines: overrides.addedLines ?? getAddedLines(f.patch ?? ''),
    headContent: overrides.headContent ?? null,
    baseContent: overrides.baseContent ?? null,
  };
}

function withPatch(patch: string, extra: Partial<ChangedFile> = {}): RuleContext {
  const f = file({ patch, ...extra });
  return ctx({ file: f, allFiles: [f] });
}

describe('rule: security-anti-patterns', () => {
  const cases: Array<[string, string]> = [
    ['eval', '+  return eval(userInput);'],
    ['new Function', '+  const fn = new Function("a", "return a");'],
    ['innerHTML', '+  el.innerHTML = userInput;'],
    ['dangerouslySetInnerHTML', '+  <div dangerouslySetInnerHTML={{__html: raw}} />'],
    ['child_process exec', '+  exec("rm -rf " + dir);'],
    ['SQL concatenation', '+  db.query("SELECT * FROM users WHERE id = " + userId);'],
    ['hardcoded secret', '+  const apiKey = "sk-abcdef1234567890abcdef1234567890";'],
  ];

  it.each(cases)('flags %s as an error', (_label, line) => {
    const findings = runRules(withPatch(`@@ -1,1 +1,2 @@\n context\n${line}`));
    const security = findings.filter((f) => f.category === 'security');

    expect(security.length).toBeGreaterThan(0);
    expect(security[0].level).toBe('error');
    expect(security[0].line).toBe(2);
  });

  it('does not flag safe code', () => {
    const findings = runRules(
      withPatch('@@ -1,1 +1,2 @@\n context\n+  const total = a + b;')
    );
    expect(findings.filter((f) => f.category === 'security')).toHaveLength(0);
  });

  it('only scans ADDED lines, ignoring pre-existing code', () => {
    // eval() appears as a context line — it was already there before this PR.
    const findings = runRules(withPatch('@@ -1,2 +1,2 @@\n  return eval(x);\n+  const y = 1;'));
    expect(findings.filter((f) => f.category === 'security')).toHaveLength(0);
  });

  it('ignores comment lines', () => {
    const findings = runRules(
      withPatch('@@ -1,1 +1,2 @@\n c\n+  // never use eval() here')
    );
    expect(findings.filter((f) => f.category === 'security')).toHaveLength(0);
  });
});

describe('rule: breaking-signature-change', () => {
  const change: StructuralChange = {
    type: 'signature_changed',
    name: 'run',
    exported: true,
    before: '(a)',
    after: '(a, b)',
    line: 4,
  };

  it('flags an exported signature change with no test file touched', () => {
    const findings = runRules(ctx({ structuralChanges: [change] }));
    const breaking = findings.filter((f) => f.category === 'breaking-change');

    expect(breaking).toHaveLength(1);
    expect(breaking[0].level).toBe('warning');
    expect(breaking[0].message).toContain('run');
    expect(breaking[0].message).toContain('(a, b)');
  });

  it('stays quiet when a test file is part of the same PR', () => {
    const src = file();
    const test = file({ filename: 'src/app.test.ts' });
    const findings = runRules(
      ctx({ file: src, allFiles: [src, test], structuralChanges: [change] })
    );
    expect(findings.filter((f) => f.category === 'breaking-change')).toHaveLength(0);
  });

  it('ignores signature changes on non-exported functions', () => {
    const findings = runRules(
      ctx({ structuralChanges: [{ ...change, exported: false }] })
    );
    expect(findings.filter((f) => f.category === 'breaking-change')).toHaveLength(0);
  });

  it('flags a removed export', () => {
    const findings = runRules(
      ctx({
        structuralChanges: [
          { type: 'export_removed', name: 'gone', exported: true, before: '()' },
        ],
      })
    );
    const breaking = findings.filter((f) => f.category === 'breaking-change');
    expect(breaking).toHaveLength(1);
    expect(breaking[0].message).toContain('gone');
  });
});

describe('rule: missing-tests', () => {
  it('flags a modified source file with no test file in the PR', () => {
    const findings = runRules(ctx());
    expect(findings.filter((f) => f.category === 'missing-tests')).toHaveLength(1);
  });

  it('is satisfied by any test file in the PR', () => {
    const src = file();
    const spec = file({ filename: 'src/__tests__/app.spec.ts' });
    const findings = runRules(ctx({ file: src, allFiles: [src, spec] }));
    expect(findings.filter((f) => f.category === 'missing-tests')).toHaveLength(0);
  });

  it('does not ask a test file to have its own tests', () => {
    const t = file({ filename: 'src/app.test.ts' });
    const findings = runRules(ctx({ file: t, allFiles: [t] }));
    expect(findings.filter((f) => f.category === 'missing-tests')).toHaveLength(0);
  });

  it('ignores non-source files like markdown and config', () => {
    for (const name of ['README.md', 'package.json', 'docs/guide.mdx', '.github/workflows/ci.yml']) {
      const f = file({ filename: name });
      const findings = runRules(ctx({ file: f, allFiles: [f] }));
      expect(findings.filter((x) => x.category === 'missing-tests')).toHaveLength(0);
    }
  });

  it('ignores deleted files', () => {
    const f = file({ status: 'removed' });
    const findings = runRules(ctx({ file: f, allFiles: [f] }));
    expect(findings.filter((x) => x.category === 'missing-tests')).toHaveLength(0);
  });
});

describe('rule: large-diff-thin-description', () => {
  it('flags a huge diff with a short body', () => {
    const findings = runRules(
      ctx({ pr: pr({ additions: 600, deletions: 100, body: 'fix' }) })
    );
    const large = findings.filter((f) => f.rule === 'large-diff-thin-description');
    expect(large).toHaveLength(1);
    expect(large[0].level).toBe('info');
    expect(large[0].path).toBeUndefined(); // PR-level, not file-level
  });

  it('stays quiet when the description is substantial', () => {
    const findings = runRules(ctx({ pr: pr({ additions: 600, deletions: 100 }) }));
    expect(findings.filter((f) => f.rule === 'large-diff-thin-description')).toHaveLength(0);
  });

  it('stays quiet for a small diff with a short body', () => {
    const findings = runRules(ctx({ pr: pr({ additions: 5, deletions: 1, body: 'typo' }) }));
    expect(findings.filter((f) => f.rule === 'large-diff-thin-description')).toHaveLength(0);
  });

  it('reports only once per PR, not once per file', () => {
    const a = file({ filename: 'src/a.ts' });
    const b = file({ filename: 'src/b.ts' });
    const bigPr = pr({ additions: 600, deletions: 100, body: 'x' });
    const findings = [
      ...runRules(ctx({ file: a, allFiles: [a, b], pr: bigPr })),
      ...runRules(ctx({ file: b, allFiles: [a, b], pr: bigPr })),
    ];
    // Both invocations produce it; index.ts dedupes. Verify the key is stable.
    const large = findings.filter((f) => f.rule === 'large-diff-thin-description');
    expect(large).toHaveLength(2);
    expect(large[0].path).toBe(large[1].path);
  });
});

describe('rule: dependency-lockfile-mismatch', () => {
  it('flags package.json changed without a lockfile', () => {
    const pkg = file({
      filename: 'package.json',
      patch:
        '@@ -1,4 +1,5 @@\n {\n   "dependencies": {\n+    "lodash": "^4.17.21",\n     "x": "1.0.0"',
    });
    const findings = runRules(ctx({ file: pkg, allFiles: [pkg] }));
    const dep = findings.filter((f) => f.category === 'dependencies');

    expect(dep).toHaveLength(1);
    expect(dep[0].message).toContain('lockfile');
  });

  it('stays quiet when the lockfile changed too', () => {
    const pkg = file({
      filename: 'package.json',
      patch:
        '@@ -1,4 +1,5 @@\n {\n   "dependencies": {\n+    "lodash": "^4.17.21",\n     "x": "1.0.0"',
    });
    const lock = file({ filename: 'package-lock.json' });
    const findings = runRules(ctx({ file: pkg, allFiles: [pkg, lock] }));
    expect(findings.filter((f) => f.category === 'dependencies')).toHaveLength(0);
  });

  it('accepts yarn.lock and pnpm-lock.yaml', () => {
    for (const lockName of ['yarn.lock', 'pnpm-lock.yaml']) {
      const pkg = file({
        filename: 'package.json',
        patch:
          '@@ -1,4 +1,5 @@\n {\n   "dependencies": {\n+    "lodash": "^4.17.21",\n     "x": "1.0.0"',
      });
      const lock = file({ filename: lockName });
      const findings = runRules(ctx({ file: pkg, allFiles: [pkg, lock] }));
      expect(findings.filter((f) => f.category === 'dependencies')).toHaveLength(0);
    }
  });

  it('ignores package.json edits that do not touch dependencies', () => {
    const pkg = file({
      filename: 'package.json',
      patch: '@@ -1,3 +1,3 @@\n {\n-  "version": "1.0.0",\n+  "version": "1.0.1",',
    });
    const findings = runRules(ctx({ file: pkg, allFiles: [pkg] }));
    expect(findings.filter((f) => f.category === 'dependencies')).toHaveLength(0);
  });

  it('detects a dependency added deep in the list, where the diff shows no block header', () => {
    // Real-world case: 3 lines of diff context never reveal `"dependencies": {`.
    const headContent = [
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "aaa": "^1.0.0",',
      '    "bbb": "^2.0.0",',
      '    "ccc": "^3.0.0",',
      '    "lodash": "^4.17.21",',
      '    "ddd": "^5.0.0"',
      '  }',
      '}',
    ].join('\n');

    const pkg = file({
      filename: 'package.json',
      // Hunk starts at new line 5 — well past the "dependencies" header.
      patch: '@@ -4,3 +4,4 @@\n     "bbb": "^2.0.0",\n     "ccc": "^3.0.0",\n+    "lodash": "^4.17.21",\n     "ddd": "^5.0.0"',
    });

    const findings = runRules(ctx({ file: pkg, allFiles: [pkg], headContent }));
    expect(findings.filter((f) => f.category === 'dependencies')).toHaveLength(1);
  });

  it('ignores a versioned-looking edit outside any dependency block', () => {
    const headContent = ['{', '  "engines": {', '    "node": ">=20.0.0"', '  }', '}'].join('\n');
    const pkg = file({
      filename: 'package.json',
      patch: '@@ -2,2 +2,3 @@\n   "engines": {\n+    "node": ">=20.0.0"\n   }',
    });

    const findings = runRules(ctx({ file: pkg, allFiles: [pkg], headContent }));
    expect(findings.filter((f) => f.category === 'dependencies')).toHaveLength(0);
  });
});

describe('rule registry', () => {
  it('exposes all five rules with unique names', () => {
    expect(RULES).toHaveLength(5);
    expect(new Set(RULES.map((r) => r.name)).size).toBe(5);
    RULES.forEach((r) => expect(r.description.length).toBeGreaterThan(0));
  });

  it('never throws on a binary file with no patch', () => {
    const bin = file({ filename: 'logo.png', patch: undefined });
    expect(() => runRules(ctx({ file: bin, allFiles: [bin] }))).not.toThrow();
  });

  it('isolates a throwing rule from the rest', () => {
    const broken = { name: 'boom', description: 'x', check: () => { throw new Error('bad'); } };
    expect(() => runRules(ctx(), [...RULES, broken])).not.toThrow();
  });
});
