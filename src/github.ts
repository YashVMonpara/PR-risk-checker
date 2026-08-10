import * as github from '@actions/github';
import { ChangedFile, PullRequestMeta } from './types';

/** The authenticated Octokit client shape returned by @actions/github. */
export type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Fetches every file changed by the pull request, following pagination.
 * Binary files come back without a `patch`.
 */
export async function getChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<ChangedFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return (files as ChangedFile[]).map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch,
    previous_filename: file.previous_filename,
  }));
}

/** Fetches the pull request metadata the rule engine needs. */
export async function getPullRequestMeta(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestMeta> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });

  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    baseSha: data.base.sha,
    headSha: data.head.sha,
    additions: data.additions,
    deletions: data.deletions,
  };
}

/**
 * Reads a file's contents at a specific ref.
 *
 * Returns null rather than throwing when the file is absent at that ref — that
 * is the normal case for files added or deleted by the PR.
 */
export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });

    if (Array.isArray(data) || !('content' in data) || data.type !== 'file') {
      return null;
    }

    return Buffer.from(data.content, (data.encoding as BufferEncoding) || 'base64').toString(
      'utf8'
    );
  } catch {
    // 404 (file absent at this ref), 403 (too large), or transient failure —
    // degrade gracefully; the AST step treats null as "nothing to compare".
    return null;
  }
}
