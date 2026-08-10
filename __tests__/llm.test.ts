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

import { assessRiskWithLLM, buildLLMOptions, truncateForPrompt } from '../src/llm';
import { RiskFinding } from '../src/types';

function reply(content: string) {
  return { choices: [{ message: { content } }] };
}

const securityFinding: RiskFinding = {
  rule: 'security-anti-patterns/eval',
  category: 'security',
  level: 'error',
  message: 'Use of eval() is dangerous.',
  path: 'src/a.ts',
  line: 3,
};

const styleFinding: RiskFinding = {
  rule: 'missing-tests',
  category: 'missing-tests',
  level: 'warning',
  message: 'No tests found.',
  path: 'src/a.ts',
};

beforeEach(() => {
  mockCreate.mockReset();
  mockConstructor.mockReset();
});

describe('buildLLMOptions', () => {
  it('returns null when neither key nor base URL is configured', () => {
    expect(buildLLMOptions({ apiKey: '', baseURL: '', model: 'gpt-4o-mini' })).toBeNull();
  });

  it('uses the standard OpenAI endpoint when only a key is given', () => {
    const opts = buildLLMOptions({ apiKey: 'sk-real', baseURL: '', model: 'gpt-4o-mini' });
    expect(opts).toEqual({ apiKey: 'sk-real', baseURL: undefined, model: 'gpt-4o-mini' });
  });

  it('supplies a placeholder key for LM Studio when none is given', () => {
    const opts = buildLLMOptions({
      apiKey: '',
      baseURL: 'http://localhost:1234/v1',
      model: 'qwen/qwen3-vl-8b',
    });
    expect(opts).toEqual({
      apiKey: 'lm-studio',
      baseURL: 'http://localhost:1234/v1',
      model: 'qwen/qwen3-vl-8b',
    });
  });

  it('keeps a real key when a custom base URL also needs auth', () => {
    const opts = buildLLMOptions({
      apiKey: 'sk-proxy',
      baseURL: 'https://proxy.internal/v1',
      model: 'llama3',
    });
    expect(opts!.apiKey).toBe('sk-proxy');
    expect(opts!.baseURL).toBe('https://proxy.internal/v1');
  });
});

describe('assessRiskWithLLM — backend wiring', () => {
  it('constructs the client with the LM Studio base URL', async () => {
    mockCreate.mockResolvedValue(
      reply('{"is_real_risk":true,"severity":"error","comment":"Bad."}')
    );

    await assessRiskWithLLM(securityFinding, 'diff', 'src/a.ts', {
      apiKey: 'lm-studio',
      baseURL: 'http://localhost:1234/v1',
      model: 'qwen/qwen3-vl-8b',
    });

    expect(mockConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'lm-studio', baseURL: 'http://localhost:1234/v1' })
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'qwen/qwen3-vl-8b', temperature: 0.1 })
    );
  });

  it('leaves baseURL undefined for standard OpenAI', async () => {
    mockCreate.mockResolvedValue(
      reply('{"is_real_risk":true,"severity":"error","comment":"Bad."}')
    );

    await assessRiskWithLLM(securityFinding, 'diff', 'src/a.ts', {
      apiKey: 'sk-real',
      model: 'gpt-4o-mini',
    });

    const opts = mockConstructor.mock.calls[0][0];
    expect(opts.apiKey).toBe('sk-real');
    expect(opts.baseURL).toBeUndefined();
  });

  it('requests structured JSON output', async () => {
    mockCreate.mockResolvedValue(reply('{"is_real_risk":false,"severity":"info","comment":"ok"}'));
    await assessRiskWithLLM(styleFinding, 'diff', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
    });

    const payload = mockCreate.mock.calls[0][0];
    expect(payload.response_format.type).toBe('json_schema');
    expect(payload.messages[0].role).toBe('system');
    expect(payload.messages[1].content).toContain('src/a.ts');
  });
});

describe('assessRiskWithLLM — verdicts', () => {
  it('returns the LLM comment when it confirms a real risk', async () => {
    mockCreate.mockResolvedValue(
      reply('{"is_real_risk":true,"severity":"error","comment":"Injection risk; parse instead."}')
    );

    const verdict = await assessRiskWithLLM(securityFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
    });

    expect(verdict).toEqual({
      is_real_risk: true,
      severity: 'error',
      comment: 'Injection risk; parse instead.',
    });
  });

  it('lets a NON-security finding be dismissed', async () => {
    mockCreate.mockResolvedValue(
      reply('{"is_real_risk":false,"severity":"info","comment":"Tests exist elsewhere."}')
    );

    const verdict = await assessRiskWithLLM(styleFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
    });

    expect(verdict!.is_real_risk).toBe(false);
  });

  it('FAIL-CLOSED: never dismisses an error-level security finding', async () => {
    // This is the exact failure observed with a local 8B model.
    mockCreate.mockResolvedValue(
      reply('{"is_real_risk":false,"severity":"info","comment":"SAFE"}')
    );

    const verdict = await assessRiskWithLLM(securityFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
    });

    expect(verdict!.is_real_risk).toBe(true);
    expect(verdict!.severity).toBe('error');
  });

  it('FAIL-CLOSED: never downgrades the severity of a security finding', async () => {
    mockCreate.mockResolvedValue(
      reply('{"is_real_risk":true,"severity":"info","comment":"Minor nit."}')
    );

    const verdict = await assessRiskWithLLM(securityFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
    });

    expect(verdict!.severity).toBe('error');
    expect(verdict!.comment).toBe('Minor nit.');
  });

  it('handles a bare SAFE reply from a model that ignores the schema', async () => {
    mockCreate.mockResolvedValue(reply('SAFE'));

    const verdict = await assessRiskWithLLM(styleFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
    });

    expect(verdict!.is_real_risk).toBe(false);
  });

  it('extracts JSON wrapped in markdown fences', async () => {
    mockCreate.mockResolvedValue(
      reply('```json\n{"is_real_risk":true,"severity":"warning","comment":"Careful."}\n```')
    );

    const verdict = await assessRiskWithLLM(styleFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
    });

    expect(verdict!.comment).toBe('Careful.');
  });

  it('returns null on unparseable output so the caller keeps its own message', async () => {
    mockCreate.mockResolvedValue(reply('I think maybe possibly this could be fine?'));

    const verdict = await assessRiskWithLLM(styleFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
      maxRetries: 1,
    });

    expect(verdict).toBeNull();
  });
});

describe('assessRiskWithLLM — resilience', () => {
  it('retries a transient failure and succeeds', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        reply('{"is_real_risk":true,"severity":"warning","comment":"Second try."}')
      );

    const verdict = await assessRiskWithLLM(styleFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
      maxRetries: 3,
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(verdict!.comment).toBe('Second try.');
  });

  it('gives up after maxRetries and returns null', async () => {
    mockCreate.mockRejectedValue(new Error('connection refused'));

    const verdict = await assessRiskWithLLM(styleFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
      maxRetries: 3,
    });

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(verdict).toBeNull();
  });

  it('returns null (not a crash) when LM Studio is unreachable', async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' })
    );

    const verdict = await assessRiskWithLLM(securityFinding, 'd', 'src/a.ts', {
      apiKey: 'lm-studio',
      baseURL: 'http://localhost:1234/v1',
      model: 'qwen/qwen3-vl-8b',
      maxRetries: 1,
    });

    expect(verdict).toBeNull();
  });

  it('handles an empty choices array', async () => {
    mockCreate.mockResolvedValue({ choices: [] });

    const verdict = await assessRiskWithLLM(styleFinding, 'd', 'src/a.ts', {
      apiKey: 'k',
      model: 'm',
      maxRetries: 1,
    });

    expect(verdict).toBeNull();
  });
});

describe('truncateForPrompt', () => {
  it('leaves short text untouched', () => {
    expect(truncateForPrompt('short', 100)).toBe('short');
  });

  it('truncates long text and marks it', () => {
    const out = truncateForPrompt('x'.repeat(10_000), 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('truncated');
  });
});
