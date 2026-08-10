/**
 * Integration tests: the whole pipeline (diff → AST → rules → LLM → review),
 * driven through analyzePullRequest/postReview with a fake Octokit.
 *
 * Only the two outermost edges are faked — the GitHub API and the LLM HTTP call.
 * Everything in between (diff parsing, real tree-sitter parsing, the rule engine,
 * position math, comment rendering) is the real implementation.
 */
const mockCreate = jest.fn();
const mockConstructor = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: class MockOpenAI {
    chat: { completions: { create: jest.Mock } };
    constructor(opts: Record<string, unknown>) {
      mockConstructor(opts);
      this.chat = { completions: { create: mockCreate } };
    }
  },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzePullRequest } from '../src/index';
import { postReview } from '../src/comment';
import { resetParsers } from '../src/ast';
import { LLMOptions } from '../src/types';

const FIXTURES = join(__dirname, '..', 'fixtures', 'demo-pr');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

const OWNER = 'demo-org';
const REPO = 'demo-repo';
const PR = 42;
const BASE_SHA = 'base000';
const HEAD_SHA = 'head111';

const FILES = [
  {
    filename: 'src/runner.js',
    status: 'modified',
    additions: 6,
    deletions: 2,
    changes: 8,
    patch: fixture('runner.patch'),
    base: fixture('runner.base.js'),
    head: fixture('runner.head.js'),
  },
  {
    filename: 'src/render.js',
    status: 'modified',
    additions: 3,
    deletions: 1,
    changes: 4,
    patch: fixture('render.patch'),
    base: fixture('render.base.js'),
    head: fixture('render.head.js'),
  },
  {
    filename: 'package.json',
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: fixture('package.patch'),
    base: fixture('package.base.json'),
    head: fixture('package.head.json'),
  },
];

function makeOctokit() {
  const createReview = jest.fn().mockResolvedValue({ data: { id: 1 } });

  return {
    createReview,
    paginate: jest.fn().mockResolvedValue(
      FILES.map(({ base: _b, head: _h, ...rest }) => rest)
    ),
    rest: {
      pulls: {
        listFiles: jest.fn(),
        get: jest.fn().mockResolvedValue({
          data: {
            number: PR,
            title: 'Speed up the runner',
            body: 'quick fix',
            additions: 10,
            deletions: 3,
            base: { sha: BASE_SHA },
            head: { sha: HEAD_SHA },
          },
        }),
        createReview,
      },
      repos: {
        getContent: jest.fn(async ({ path, ref }: { path: string; ref: string }) => {
          const file = FILES.find((f) => f.filename === path);
          if (!file) throw new Error('Not Found');
          const content = ref === BASE_SHA ? file.base : file.head;
          return {
            data: {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(content).toString('base64'),
            },
          };
        }),
      },
    },
  };
}

function verdict(body: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(body) } }] };
}

const OPENAI_OPTS: LLMOptions = { apiKey: 'sk-test', model: 'gpt-4o-mini', maxRetries: 1 };
const LMSTUDIO_OPTS: LLMOptions = {
  apiKey: 'lm-studio',
  baseURL: 'http://localhost:1234/v1',
  model: 'qwen/qwen3-vl-8b',
  maxRetries: 1,
};

beforeEach(() => {
  mockCreate.mockReset();
  mockConstructor.mockReset();
});

afterAll(() => resetParsers());

describe('integration — deterministic rules only (no LLM)', () => {
  it('finds the planted risks and posts one review', async () => {
    const octokit = makeOctokit();

    const { findings, files, pr } = await analyzePullRequest(
      octokit as never,
      OWNER,
      REPO,
      PR,
      null,
      'warning',
      10
    );

    const rules = findings.map((f) => f.rule);
    expect(rules).toContain('security-anti-patterns/eval');
    expect(rules).toContain('security-anti-patterns/inner-html');
    expect(rules).toContain('security-anti-patterns/child-process-exec');
    expect(rules).toContain('breaking-signature-change');
    expect(rules).toContain('missing-tests');
    expect(rules).toContain('dependency-lockfile-mismatch');

    // The LLM must not be touched at all.
    expect(mockConstructor).not.toHaveBeenCalled();

    const result = await postReview(
      octokit as never,
      OWNER,
      REPO,
      PR,
      pr.headSha,
      findings,
      files
    );

    expect(result.posted).toBe(true);
    expect(octokit.createReview).toHaveBeenCalledTimes(1);

    const payload = octokit.createReview.mock.calls[0][0];
    expect(payload.event).toBe('COMMENT');
    expect(payload.commit_id).toBe(HEAD_SHA);

    // Every inline comment must carry a positive integer position.
    for (const comment of payload.comments) {
      expect(Number.isInteger(comment.position)).toBe(true);
      expect(comment.position).toBeGreaterThan(0);
    }
  });

  it('detects the breaking signature change via real tree-sitter parsing', async () => {
    const octokit = makeOctokit();
    const { findings } = await analyzePullRequest(
      octokit as never,
      OWNER,
      REPO,
      PR,
      null,
      'warning',
      10
    );

    const breaking = findings.find((f) => f.rule === 'breaking-signature-change');
    expect(breaking).toBeDefined();
    expect(breaking!.message).toContain('runTask');
    expect(breaking!.message).toContain('(name)');
    expect(breaking!.message).toContain('(name, options)');
  });

  it('respects the error threshold', async () => {
    const octokit = makeOctokit();
    const { findings } = await analyzePullRequest(
      octokit as never,
      OWNER,
      REPO,
      PR,
      null,
      'error',
      10
    );

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.level === 'error')).toBe(true);
  });
});

describe('integration — OpenAI backend', () => {
  it('routes to api.openai.com and enriches findings', async () => {
    mockCreate.mockResolvedValue(
      verdict({ is_real_risk: true, severity: 'error', comment: 'LLM says: fix this.' })
    );

    const octokit = makeOctokit();
    const { findings } = await analyzePullRequest(
      octokit as never,
      OWNER,
      REPO,
      PR,
      OPENAI_OPTS,
      'warning',
      10
    );

    expect(mockConstructor).toHaveBeenCalled();
    expect(mockConstructor.mock.calls[0][0].baseURL).toBeUndefined();
    expect(mockConstructor.mock.calls[0][0].apiKey).toBe('sk-test');

    expect(findings.every((f) => f.llmEnriched)).toBe(true);
    expect(findings[0].message).toBe('LLM says: fix this.');
  });
});

describe('integration — LM Studio backend', () => {
  it('routes to the local base URL with the local model', async () => {
    mockCreate.mockResolvedValue(
      verdict({ is_real_risk: true, severity: 'warning', comment: 'Local model comment.' })
    );

    const octokit = makeOctokit();
    await analyzePullRequest(octokit as never, OWNER, REPO, PR, LMSTUDIO_OPTS, 'warning', 10);

    expect(mockConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'lm-studio',
        baseURL: 'http://localhost:1234/v1',
      })
    );
    expect(mockCreate.mock.calls[0][0].model).toBe('qwen/qwen3-vl-8b');
  });

  it('drops a non-security finding the model dismisses', async () => {
    mockCreate.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      const prompt = messages[1].content;
      if (prompt.includes('missing-tests')) {
        return verdict({ is_real_risk: false, severity: 'info', comment: 'Covered elsewhere.' });
      }
      return verdict({ is_real_risk: true, severity: 'error', comment: 'Real risk.' });
    });

    const octokit = makeOctokit();
    const { findings } = await analyzePullRequest(
      octokit as never,
      OWNER,
      REPO,
      PR,
      LMSTUDIO_OPTS,
      'warning',
      10
    );

    expect(findings.some((f) => f.rule === 'missing-tests')).toBe(false);
    expect(findings.some((f) => f.category === 'security')).toBe(true);
  });

  it('FAIL-CLOSED: keeps security findings even when the model says SAFE for everything', async () => {
    // Reproduces the real observed behaviour of a small local model.
    mockCreate.mockResolvedValue(reply('SAFE'));

    function reply(content: string) {
      return { choices: [{ message: { content } }] };
    }

    const octokit = makeOctokit();
    const { findings } = await analyzePullRequest(
      octokit as never,
      OWNER,
      REPO,
      PR,
      LMSTUDIO_OPTS,
      'warning',
      10
    );

    const security = findings.filter((f) => f.category === 'security');
    expect(security).toHaveLength(3);
    expect(security.every((f) => f.level === 'error')).toBe(true);
    // Non-security findings were dismissed, so only the protected ones remain.
    expect(findings.every((f) => f.category === 'security')).toBe(true);
  });

  it('degrades gracefully when the local server is unreachable', async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' })
    );

    const octokit = makeOctokit();
    const { findings, files, pr } = await analyzePullRequest(
      octokit as never,
      OWNER,
      REPO,
      PR,
      LMSTUDIO_OPTS,
      'warning',
      10
    );

    // Deterministic findings survive with their original messages.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => !f.llmEnriched)).toBe(true);

    const result = await postReview(
      octokit as never,
      OWNER,
      REPO,
      PR,
      pr.headSha,
      findings,
      files
    );
    expect(result.posted).toBe(true);
  });

  it('honours the LLM call budget', async () => {
    mockCreate.mockResolvedValue(
      verdict({ is_real_risk: true, severity: 'warning', comment: 'ok' })
    );

    const octokit = makeOctokit();
    await analyzePullRequest(octokit as never, OWNER, REPO, PR, LMSTUDIO_OPTS, 'warning', 2);

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
