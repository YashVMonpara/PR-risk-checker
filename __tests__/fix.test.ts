import { applyPatch, generateFixes } from '../src/fix';
import type { RiskFinding } from '../src/types';

const sampleFile = [
  'function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'const x = eval("1+1");',
  'console.log(x);',
].join('\n');

function finding(over: Partial<RiskFinding> = {}): RiskFinding {
  return {
    rule: 'security-anti-patterns/eval',
    category: 'security',
    level: 'error',
    message: 'Use of eval() is dangerous.',
    path: 'app.js',
    line: 5,
    snippet: 'const x = eval("1+1");',
    ...over,
  };
}

// Mock module internals by passing a fake octokit + stubbing generateFixWithLLM
// is hard without injection, so we test applyPatch (pure) exhaustively and
// generateFixes with a real-but-trivial LLM stub via jest module mocking.
jest.mock('../src/llm', () => ({
  generateFixWithLLM: jest.fn(),
  FixProposal: {},
}));
jest.mock('../src/github', () => ({
  getFileContent: jest.fn(),
}));

import * as llm from '../src/llm';
import * as github from '../src/github';

describe('applyPatch', () => {
  it('replaces the single occurrence', () => {
    const out = applyPatch('a\nb\nc', 'b', 'B');
    expect(out).toBe('a\nB\nc');
  });

  it('returns null when old_lines is absent', () => {
    expect(applyPatch('a\nb', 'zzz', 'x')).toBeNull();
  });

  it('returns null when old_lines appears more than once (ambiguous)', () => {
    expect(applyPatch('a\na', 'a', 'x')).toBeNull();
  });

  it('returns null for empty old_lines', () => {
    expect(applyPatch('a', '', 'x')).toBeNull();
  });
});

describe('generateFixes guardrails', () => {
  const llmOptions = { apiKey: 'k', baseURL: '', model: 'm' };

  beforeEach(() => {
    jest.clearAllMocks();
    (github.getFileContent as jest.Mock).mockResolvedValue(sampleFile);
  });

  it('marks a PR-level (no path) finding as skipped', async () => {
    const plans = await generateFixes({
      octokit: {},
      owner: 'o',
      repo: 'r',
      headSha: 'sha',
      findings: [finding({ path: undefined })],
      llmOptions,
    });
    expect(plans[0].status).toBe('skipped');
  });

  it('produces a ready plan when the model returns a valid, matching patch', async () => {
    (llm.generateFixWithLLM as jest.Mock).mockResolvedValue({
      old_lines: 'const x = eval("1+1");',
      new_lines: 'const x = 2;',
      confidence: 0.95,
      needs_user_input: false,
      rationale: 'replaced eval with literal',
    });
    const plans = await generateFixes({
      octokit: {},
      owner: 'o',
      repo: 'r',
      headSha: 'sha',
      findings: [finding()],
      llmOptions,
    });
    expect(plans[0].status).toBe('ready');
  });

  it('flags low-confidence proposals as needs_input (fail-closed)', async () => {
    (llm.generateFixWithLLM as jest.Mock).mockResolvedValue({
      old_lines: 'const x = eval("1+1");',
      new_lines: 'const x = 2;',
      confidence: 0.4,
      needs_user_input: false,
    });
    const plans = await generateFixes({
      octokit: {},
      owner: 'o',
      repo: 'r',
      headSha: 'sha',
      findings: [finding()],
      llmOptions,
    });
    expect(plans[0].status).toBe('needs_input');
    expect(plans[0].reason).toMatch(/confidence/i);
  });

  it('honours the model needs_user_input flag', async () => {
    (llm.generateFixWithLLM as jest.Mock).mockResolvedValue({
      old_lines: 'const x = eval("1+1");',
      new_lines: 'const x = 2;',
      confidence: 0.9,
      needs_user_input: true,
      user_input_reason: 'Revoke the real secret and use an env var instead.',
    });
    const plans = await generateFixes({
      octokit: {},
      owner: 'o',
      repo: 'r',
      headSha: 'sha',
      findings: [finding()],
      llmOptions,
    });
    expect(plans[0].status).toBe('needs_input');
    expect(plans[0].reason).toMatch(/secret/i);
  });

  it('errors when the model cannot be reached', async () => {
    (llm.generateFixWithLLM as jest.Mock).mockResolvedValue(null);
    const plans = await generateFixes({
      octokit: {},
      owner: 'o',
      repo: 'r',
      headSha: 'sha',
      findings: [finding()],
      llmOptions,
    });
    expect(plans[0].status).toBe('error');
  });

  it('errors when the file cannot be read', async () => {
    (github.getFileContent as jest.Mock).mockResolvedValue(null);
    const plans = await generateFixes({
      octokit: {},
      owner: 'o',
      repo: 'r',
      headSha: 'sha',
      findings: [finding()],
      llmOptions,
    });
    expect(plans[0].status).toBe('error');
    expect(plans[0].reason).toMatch(/read/i);
  });

  it('rejects a patch whose old_lines no longer matches verbatim', async () => {
    (llm.generateFixWithLLM as jest.Mock).mockResolvedValue({
      old_lines: 'const y = eval("9");', // not present in sampleFile
      new_lines: 'const y = 9;',
      confidence: 0.95,
      needs_user_input: false,
    });
    const plans = await generateFixes({
      octokit: {},
      owner: 'o',
      repo: 'r',
      headSha: 'sha',
      findings: [finding()],
      llmOptions,
    });
    expect(plans[0].status).toBe('error');
    expect(plans[0].reason).toMatch(/not found verbatim/i);
  });
});
