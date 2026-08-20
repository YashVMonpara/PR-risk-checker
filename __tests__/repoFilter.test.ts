import { filterRepos, parseNextPageLink } from '../web/repoFilter';

const repos = [
  { fullName: 'yash/pr-risk-checker', description: 'Reviews pull requests for risk' },
  { fullName: 'yash/left-pad-clone', description: null },
  { fullName: 'yash/notes', description: 'Personal notes and TODOs' },
];

describe('filterRepos', () => {
  it('returns everything when the query is empty', () => {
    expect(filterRepos(repos, '')).toEqual(repos);
    expect(filterRepos(repos, '   ')).toEqual(repos);
  });

  it('matches case-insensitively on the repo name', () => {
    expect(filterRepos(repos, 'LEFT-PAD')).toEqual([repos[1]]);
  });

  it('matches case-insensitively on the description', () => {
    expect(filterRepos(repos, 'todos')).toEqual([repos[2]]);
  });

  it('handles a null description without throwing', () => {
    expect(filterRepos(repos, 'left-pad-clone')).toEqual([repos[1]]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterRepos(repos, 'nonexistent')).toEqual([]);
  });
});

describe('parseNextPageLink', () => {
  it('extracts the next-page URL from a multi-rel Link header', () => {
    const header =
      '<https://api.github.com/user/repos?page=2>; rel="next", ' +
      '<https://api.github.com/user/repos?page=5>; rel="last"';
    expect(parseNextPageLink(header)).toBe('https://api.github.com/user/repos?page=2');
  });

  it('returns null when there is no rel="next"', () => {
    expect(parseNextPageLink('<https://api.github.com/user/repos?page=1>; rel="prev"')).toBeNull();
  });

  it('returns null for a null header', () => {
    expect(parseNextPageLink(null)).toBeNull();
  });
});
