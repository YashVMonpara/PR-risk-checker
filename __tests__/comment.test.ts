import { postReview, buildSummary, buildFooter } from '../src/comment';
import { ChangedFile, RiskFinding } from '../src/types';

const PATCH = '@@ -1,2 +1,4 @@\n keep\n+risky one\n+risky two\n keep2';

function files(): ChangedFile[] {
  return [
    {
      filename: 'src/a.ts',
      status: 'modified',
      additions: 2,
      deletions: 0,
      changes: 2,
      patch: PATCH,
    },
  ];
}

function makeOctokit() {
  return {
    rest: { pulls: { createReview: jest.fn().mockResolvedValue({ data: { id: 1 } }) } },
  };
}

const inline: RiskFinding = {
  rule: 'security-anti-patterns/eval',
  category: 'security',
  level: 'error',
  message: 'Do not use eval().',
  path: 'src/a.ts',
  line: 2,
};

describe('postReview', () => {
  it('does nothing when there are no findings', async () => {
    const octokit = makeOctokit();
    const result = await postReview(octokit as never, 'o', 'r', 1, 'sha', [], files());

    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(result.posted).toBe(false);
  });

  it('posts an inline comment at the correct diff position', async () => {
    const octokit = makeOctokit();
    await postReview(octokit as never, 'o', 'r', 7, 'headsha', [inline], files());

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    const payload = octokit.rest.pulls.createReview.mock.calls[0][0];

    expect(payload).toMatchObject({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      commit_id: 'headsha',
      event: 'COMMENT',
    });
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toEqual({
      path: 'src/a.ts',
      position: 2, // line 2 is the first "+" line, at diff position 2
      body: expect.stringContaining('Do not use eval().'),
    });
  });

  it('labels the comment with its severity', async () => {
    const octokit = makeOctokit();
    await postReview(octokit as never, 'o', 'r', 1, 'sha', [inline], files());

    const body = octokit.rest.pulls.createReview.mock.calls[0][0].comments[0].body;
    expect(body).toMatch(/error/i);
    expect(body).toContain('security');
  });

  it('falls back to the summary when the line is not in the diff', async () => {
    const octokit = makeOctokit();
    const unmappable: RiskFinding = { ...inline, line: 999 };

    await postReview(octokit as never, 'o', 'r', 1, 'sha', [unmappable], files());

    const payload = octokit.rest.pulls.createReview.mock.calls[0][0];
    // The `comments` key is omitted entirely when there is nothing to attach.
    expect(payload.comments ?? []).toHaveLength(0);
    expect(payload.body).toContain('Do not use eval().');
    expect(payload.body).toContain('src/a.ts');
  });

  it('puts PR-level findings (no path) in the summary', async () => {
    const octokit = makeOctokit();
    const prLevel: RiskFinding = {
      rule: 'large-diff-thin-description',
      category: 'maintainability',
      level: 'info',
      message: 'Add a description.',
    };

    await postReview(octokit as never, 'o', 'r', 1, 'sha', [prLevel], files());

    const payload = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(payload.comments ?? []).toHaveLength(0);
    expect(payload.body).toContain('Add a description.');
  });

  it('handles a mix of inline and summary findings', async () => {
    const octokit = makeOctokit();
    const prLevel: RiskFinding = {
      rule: 'large-diff-thin-description',
      category: 'maintainability',
      level: 'info',
      message: 'Add a description.',
    };

    await postReview(octokit as never, 'o', 'r', 1, 'sha', [inline, prLevel], files());

    const payload = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(payload.comments).toHaveLength(1);
    expect(payload.body).toContain('Add a description.');
  });

  it('retries inline comments as a summary when GitHub rejects the positions', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.createReview
      .mockRejectedValueOnce(
        Object.assign(new Error('Unprocessable Entity'), { status: 422 })
      )
      .mockResolvedValueOnce({ data: { id: 2 } });

    const result = await postReview(octokit as never, 'o', 'r', 1, 'sha', [inline], files());

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(2);
    const retry = octokit.rest.pulls.createReview.mock.calls[1][0];
    expect(retry.comments).toBeUndefined();
    expect(retry.body).toContain('Do not use eval().');
    expect(result.posted).toBe(true);
  });

  it('reports failure rather than throwing when the API keeps rejecting', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.createReview.mockRejectedValue(new Error('403 Forbidden'));

    const result = await postReview(octokit as never, 'o', 'r', 1, 'sha', [inline], files());
    expect(result.posted).toBe(false);
    expect(result.error).toContain('403');
  });
});

describe('buildFooter', () => {
  it('links to the workflow run when the env provides one', () => {
    const footer = buildFooter({
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_RUN_ID: '12345',
    } as NodeJS.ProcessEnv);

    expect(footer).toContain('https://github.com/acme/widgets/actions/runs/12345');
  });

  it('falls back to the repository link when there is no run id', () => {
    const footer = buildFooter({
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/widgets',
    } as NodeJS.ProcessEnv);

    expect(footer).toContain('https://github.com/acme/widgets');
    expect(footer).not.toContain('/actions/runs/');
  });

  it('honours GitHub Enterprise server URLs', () => {
    const footer = buildFooter({
      GITHUB_SERVER_URL: 'https://ghe.internal',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_RUN_ID: '7',
    } as NodeJS.ProcessEnv);

    expect(footer).toContain('https://ghe.internal/acme/widgets/actions/runs/7');
  });

  it('emits no link at all outside a workflow', () => {
    const footer = buildFooter({} as NodeJS.ProcessEnv);

    expect(footer).toBe('<sub>🤖 Posted by PR Risk Reviewer</sub>');
    expect(footer).not.toContain('](');
  });

  it('never points at the unpublished Marketplace listing', () => {
    const envs = [
      {},
      { GITHUB_REPOSITORY: 'acme/widgets' },
      { GITHUB_REPOSITORY: 'acme/widgets', GITHUB_RUN_ID: '1' },
    ];

    for (const env of envs) {
      expect(buildFooter(env as NodeJS.ProcessEnv)).not.toContain('marketplace');
    }
  });
});

describe('buildSummary', () => {
  it('groups findings by severity with counts', () => {
    const summary = buildSummary([
      inline,
      { ...inline, rule: 'missing-tests', category: 'missing-tests', level: 'warning' },
    ]);

    expect(summary).toContain('1 error');
    expect(summary).toContain('1 warning');
  });

  it('renders a clean message for zero findings', () => {
    expect(buildSummary([])).toContain('No risks');
  });
});
