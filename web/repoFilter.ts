/**
 * Pure helpers for the "list my repos" endpoint. No Express or network
 * dependencies, so they're unit-testable directly.
 */

export interface RepoLike {
  fullName: string;
  description: string | null;
}

/** Case-insensitive substring match on name or description. Empty query returns everything. */
export function filterRepos<T extends RepoLike>(repos: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter(
    (repo) => repo.fullName.toLowerCase().includes(q) || (repo.description?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Extracts the `rel="next"` URL from a GitHub `Link` response header, e.g.
 * `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"`.
 * Returns null when there is no next page (or no header at all).
 */
export function parseNextPageLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}
