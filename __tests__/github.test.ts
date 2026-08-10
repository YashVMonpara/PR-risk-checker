import { getChangedFiles, getFileContent, getPullRequestMeta } from '../src/github';

type MockOctokit = {
  paginate: jest.Mock;
  rest: {
    pulls: { listFiles: jest.Mock; get: jest.Mock };
    repos: { getContent: jest.Mock };
  };
};

function makeOctokit(): MockOctokit {
  return {
    paginate: jest.fn(),
    rest: {
      pulls: { listFiles: jest.fn(), get: jest.fn() },
      repos: { getContent: jest.fn() },
    },
  };
}

describe('getChangedFiles', () => {
  it('paginates listFiles and normalises the response', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      {
        filename: 'src/a.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        changes: 4,
        patch: '@@ -1 +1 @@\n+x',
      },
      { filename: 'img.png', status: 'added', additions: 0, deletions: 0, changes: 0 },
    ]);

    const files = await getChangedFiles(octokit as never, 'octo', 'repo', 7);

    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.pulls.listFiles, {
      owner: 'octo',
      repo: 'repo',
      pull_number: 7,
      per_page: 100,
    });
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ filename: 'src/a.ts', status: 'modified', additions: 3 });
    expect(files[1].patch).toBeUndefined();
  });
});

describe('getPullRequestMeta', () => {
  it('maps the PR payload to our metadata shape', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        number: 42,
        title: 'Add feature',
        body: 'Some description',
        additions: 10,
        deletions: 2,
        base: { sha: 'basesha' },
        head: { sha: 'headsha' },
      },
    });

    const meta = await getPullRequestMeta(octokit as never, 'octo', 'repo', 42);

    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      pull_number: 42,
    });
    expect(meta).toEqual({
      number: 42,
      title: 'Add feature',
      body: 'Some description',
      baseSha: 'basesha',
      headSha: 'headsha',
      additions: 10,
      deletions: 2,
    });
  });

  it('coerces a null body to an empty string', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        number: 1,
        title: 't',
        body: null,
        additions: 0,
        deletions: 0,
        base: { sha: 'b' },
        head: { sha: 'h' },
      },
    });

    const meta = await getPullRequestMeta(octokit as never, 'o', 'r', 1);
    expect(meta.body).toBe('');
  });
});

describe('getFileContent', () => {
  it('decodes base64 file content', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('export const a = 1;').toString('base64'),
      },
    });

    const content = await getFileContent(octokit as never, 'o', 'r', 'abc123', 'src/a.ts');

    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      path: 'src/a.ts',
      ref: 'abc123',
    });
    expect(content).toBe('export const a = 1;');
  });

  it('returns null when the file does not exist at that ref (added/deleted files)', async () => {
    const octokit = makeOctokit();
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    octokit.rest.repos.getContent.mockRejectedValue(err);

    const content = await getFileContent(octokit as never, 'o', 'r', 'abc', 'new.ts');
    expect(content).toBeNull();
  });

  it('returns null for a directory response', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.getContent.mockResolvedValue({ data: [{ name: 'a.ts' }] });

    expect(await getFileContent(octokit as never, 'o', 'r', 'abc', 'src')).toBeNull();
  });

  it('returns null instead of throwing on unexpected API errors', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.getContent.mockRejectedValue(new Error('boom'));

    expect(await getFileContent(octokit as never, 'o', 'r', 'abc', 'x.ts')).toBeNull();
  });
});
