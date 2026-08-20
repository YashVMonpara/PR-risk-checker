/**
 * PR Risk Reviewer — companion web app.
 *
 * A local web app that lets a user connect a GitHub account, pick a repository,
 * pick a pull request, run the review engine, read the findings in a clean UI,
 * and optionally post them back to the PR.
 *
 * Auth: GitHub OAuth (if GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are set) or a
 * pasted personal access token. Either way the token lives only in the session
 * and is used to call GitHub directly — nothing is persisted.
 *
 * The analysis path reuses src/index.ts (analyzePullRequest) and src/comment.ts
 * (postReview), so behaviour matches the Action exactly.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { fileURLToPath as __fileURLToPath } from 'node:url';
dotenv.config({ path: path.resolve(__fileURLToPath(import.meta.url), '..', '.env') });

import { analyze, postToGitHub, generateFixPlans, applyFixes } from './review';
import { generateOAuthState, isValidOAuthState } from './oauthState';
import { filterRepos, parseNextPageLink } from './repoFilter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3180;
// Loopback-only by default — this app handles a GitHub token and any LLM API key typed into
// the review screen, so it must not be reachable from the rest of the network unless someone
// explicitly opts in (e.g. HOST=0.0.0.0).
const HOST = process.env.HOST || '127.0.0.1';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const OAUTH_ENABLED = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
const DEFAULT_SESSION_SECRET = 'dev-only-insecure-secret-change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;

interface AppSession {
  githubToken?: string;
  login?: string;
}

declare module 'express-session' {
  interface SessionData {
    gh?: AppSession;
    /** Pending OAuth CSRF token, set by /api/auth/login and consumed by /api/auth/callback. */
    oauthState?: string;
  }
}

const app = express();
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
  })
);

/** Returns the GitHub token for the current session, or null. */
function tokenFor(req: Request): string | null {
  return req.session.gh?.githubToken ?? null;
}

function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!tokenFor(req)) {
    res.status(401).json({ error: 'Not connected to GitHub. Authenticate first.' });
    return;
  }
  next();
}

/** Builds an Octokit-like fetcher using the session token. */
function ghFetch(token: string, url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

/** Renders a small dark-themed HTML error page (matching public/app.css) with a link back to the app. */
function errorPage(title: string, message: string): string {
  return `
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
      <style>
        body{font-family:system-ui,sans-serif;padding:2rem;max-width:600px;margin:0 auto;background:#0d1117;color:#e6edf3;}
        h1{font-size:1.3rem;}
        code{color:#f0883e;}
        a{color:#58a6ff;}
      </style>
      </head>
      <body>
        <h1>🐙 ${escapeHtml(title)}</h1>
        <p>${message}</p>
        <p><a href="/">← Back to app</a></p>
      </body>
    </html>
  `;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.get('/api/auth/status', (req, res) => {
  const gh = req.session.gh;
  res.json({
    connected: Boolean(gh?.githubToken),
    login: gh?.login ?? null,
    oauthEnabled: OAUTH_ENABLED,
  });
});

/** Token mode: user pastes a PAT. */
app.post('/api/auth/token', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) {
    res.status(400).json({ error: 'No token provided.' });
    return;
  }
  // Validate by calling the GitHub user endpoint.
  const r = await ghFetch(token, 'https://api.github.com/user');
  if (!r.ok) {
    res.status(401).json({ error: 'Token rejected by GitHub. Check the value and scopes (needs repo).' });
    return;
  }
  const user = (await r.json()) as { login: string };
  req.session.gh = { githubToken: token, login: user.login };
  // Explicitly persist before responding so a follow-up request sees it
  // (express-session saves after the response in the default flow, which can
  // race with an immediate status check from the client).
  req.session.save((err: unknown) => {
    if (err) {
      res.status(500).json({ error: 'Could not persist session.' });
      return;
    }
    res.json({ connected: true, login: user.login });
  });
});

/** OAuth: start the flow. */
app.get('/api/auth/login', (req, res) => {
  if (!OAUTH_ENABLED) {
    res
      .status(400)
      .send(
        errorPage(
          'GitHub OAuth not configured',
          'This server needs a GitHub OAuth App to be configured. Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in <code>.env</code> and restart the server — or use a personal access token instead.'
        )
      );
    return;
  }
  const state = generateOAuthState();
  req.session.oauthState = state;
  const redirect = String(process.env.GITHUB_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/callback`);
  const url =
    `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&scope=repo&state=${state}`;
  // Persist the state before redirecting so the callback (a fresh request) can see it.
  req.session.save((err: unknown) => {
    if (err) {
      res.status(500).send(errorPage('Could not start sign-in', 'The session could not be saved. Please try again.'));
      return;
    }
    res.redirect(url);
  });
});

/** OAuth: GitHub redirects back here with ?code=&state=... */
app.get('/api/auth/callback', async (req, res) => {
  const expectedState = req.session.oauthState;
  req.session.oauthState = undefined;
  if (!isValidOAuthState(req.query.state, expectedState)) {
    res
      .status(400)
      .send(
        errorPage(
          'Sign-in could not be verified',
          'The sign-in request could not be verified (missing or mismatched state). Please try signing in again.'
        )
      );
    return;
  }
  const code = String(req.query.code || '');
  if (!code) {
    res.status(400).send(errorPage('Missing code', 'GitHub did not send an authorization code. Please try signing in again.'));
    return;
  }
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const data = (await r.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
      res
        .status(400)
        .send(errorPage('OAuth failed', `GitHub did not return an access token: ${escapeHtml(data.error ?? 'no token returned')}`));
      return;
    }
    const me = await ghFetch(data.access_token, 'https://api.github.com/user');
    const user = (await me.json()) as { login: string };
    req.session.gh = { githubToken: data.access_token, login: user.login };
    req.session.save((err: unknown) => {
      if (err) {
        res.status(500).send(errorPage('Could not persist session', 'Sign-in succeeded but the session could not be saved. Please try again.'));
        return;
      }
      res.redirect('/');
    });
  } catch (err) {
    res
      .status(500)
      .send(errorPage('Sign-in error', `Something went wrong exchanging the OAuth code: ${escapeHtml((err as Error).message)}`));
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ connected: false }));
});

// ---------------------------------------------------------------------------
// GitHub data
// ---------------------------------------------------------------------------

type GhRepo = { full_name: string; private: boolean; description: string | null; owner: { login: string } };

/** Thrown when the *first* page of a paginated GitHub call fails, so the route can mirror GitHub's status. */
class GhStatusError extends Error {
  constructor(public status: number) {
    super(`GitHub: ${status}`);
  }
}

// Sane upper bound so a very large account can't turn one request into unbounded pagination.
const MAX_REPO_PAGES = 10;

/**
 * Fetches every page of repos owned by `login`, following the `Link: rel="next"` header.
 * A failure on the first page aborts (GhStatusError); a failure on a later page just stops
 * pagination and returns what's been collected so far, rather than discarding it.
 */
async function fetchAllOwnedRepos(token: string, login: string): Promise<GhRepo[]> {
  const repos: GhRepo[] = [];
  let url: string | null = 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner';
  for (let page = 0; url && page < MAX_REPO_PAGES; page++) {
    const r = await ghFetch(token, url);
    if (!r.ok) {
      if (page === 0) throw new GhStatusError(r.status);
      break;
    }
    const data = (await r.json()) as GhRepo[];
    // Extra safety: only keep repos actually owned by the authenticated user.
    repos.push(...data.filter((repo) => repo.owner.login === login));
    url = parseNextPageLink(r.headers.get('link'));
  }
  return repos;
}

/** List repositories the user owns (created), both private and public. */
app.get('/api/repos', requireToken, async (req, res) => {
  const token = tokenFor(req)!;
  const q = String(req.query.q || '').trim();
  const login = req.session.gh?.login;
  if (!login) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const ownedRepos = await fetchAllOwnedRepos(token, login);
    const repos = filterRepos(
      ownedRepos.map((r) => ({ fullName: r.full_name, private: r.private, description: r.description })),
      q
    );
    res.json({ repos });
  } catch (err) {
    if (err instanceof GhStatusError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

/** List open PRs for a repo. */
app.get('/api/pulls', requireToken, async (req, res) => {
  const token = tokenFor(req)!;
  const repo = String(req.query.repo || '');
  if (!repo.includes('/')) {
    res.status(400).json({ error: 'repo must be owner/name' });
    return;
  }
  try {
    const r = await ghFetch(
      token,
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=50`
    );
    if (!r.ok) {
      res.status(r.status).json({ error: `GitHub: ${r.status}` });
      return;
    }
    const data = (await r.json()) as Array<{
      number: number;
      title: string;
      user: { login: string } | null;
      updated_at: string;
    }>;
    res.json({
      pulls: data.map((p) => ({
        number: p.number,
        title: p.title,
        author: p.user?.login ?? null,
        updatedAt: p.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

app.post('/api/review', requireToken, async (req, res) => {
  const token = tokenFor(req)!;
  const { owner, repo, pullNumber, llm, threshold, maxLLMCalls } = req.body || {};

  if (!owner || !repo || !pullNumber) {
    res.status(400).json({ error: 'owner, repo and pullNumber are required.' });
    return;
  }

  try {
    const result = await analyze({
      token,
      owner,
      repo,
      pullNumber: Number(pullNumber),
      llm: llm || undefined,
      threshold,
      maxLLMCalls: maxLLMCalls ? Number(maxLLMCalls) : undefined,
    });
    res.json(result);
  } catch (err) {
    const message = (err as Error).message || String(err);
    res.status(502).json({ error: `Analysis failed: ${message}` });
  }
});

app.post('/api/post', requireToken, async (req, res) => {
  const token = tokenFor(req)!;
  const { owner, repo, pullNumber, headSha, findings } = req.body || {};

  // headSha is optional here: postToGitHub re-fetches the head SHA from GitHub
  // itself, so we only validate the fields that are truly required.
  if (!owner || !repo || !pullNumber || !Array.isArray(findings)) {
    res.status(400).json({ error: 'owner, repo, pullNumber and findings are required.' });
    return;
  }

  try {
    const result = await postToGitHub(token, owner, repo, Number(pullNumber), headSha, findings);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Post failed: ${(err as Error).message}` });
  }
});


// ---------------------------------------------------------------------------
// Auto-fix (opt-in: requires an LLM configured in the review request)
// ---------------------------------------------------------------------------

/** Generates safe, minimal fix plans for the findings of a reviewed PR. */
app.post('/api/fix', requireToken, async (req, res) => {
  const token = tokenFor(req)!;
  const { owner, repo, headSha, findings, llm } = req.body || {};

  if (!owner || !repo || !headSha || !Array.isArray(findings)) {
    res.status(400).json({ error: 'owner, repo, headSha and findings are required.' });
    return;
  }
  if (!llm || (!llm.apiKey && !llm.baseURL)) {
    res.status(400).json({ error: 'An LLM must be configured (apiKey or baseURL) to generate fixes.' });
    return;
  }

  try {
    const plans = await generateFixPlans(token, owner, repo, headSha, findings, llm);
    res.json({ plans });
  } catch (err) {
    res.status(502).json({ error: `Fix generation failed: ${(err as Error).message}` });
  }
});

/**
 * Applies the approved fixes by committing them to the PR branch.
 * Body: { owner, repo, headSha, pullNumber, plans, approvedIndexes }.
 * approvedIndexes are indexes into `plans` — keyed by index (not path) since a
 * single file can carry multiple findings/plans and approval must stay
 * per-finding, not silently widen to every plan on that file.
 */
app.post('/api/fix/apply', requireToken, async (req, res) => {
  const token = tokenFor(req)!;
  const { owner, repo, headSha, pullNumber, plans, approvedIndexes } = req.body || {};

  if (
    !owner || !repo || !headSha || !pullNumber ||
    !Array.isArray(plans) || !Array.isArray(approvedIndexes) ||
    !approvedIndexes.every((n: unknown) => typeof n === 'number')
  ) {
    res.status(400).json({ error: 'owner, repo, headSha, pullNumber, plans and approvedIndexes (numbers) are required.' });
    return;
  }

  try {
    const result = await applyFixes(token, owner, repo, headSha, pullNumber, plans, approvedIndexes);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Apply fixes failed: ${(err as Error).message}` });
  }
});

// ---------------------------------------------------------------------------
// Static UI
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

if (SESSION_SECRET === DEFAULT_SESSION_SECRET) {
  console.warn(
    'WARNING: SESSION_SECRET is not set — using the built-in default. Anyone who knows this ' +
      'default value can forge a valid session cookie. Set SESSION_SECRET in web/.env before ' +
      'exposing this server beyond your own machine.'
  );
}

app.listen(PORT, HOST, () => {
  console.log(`PR Risk Reviewer web app: http://${HOST}:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(`WARNING: listening on ${HOST}, not just localhost — this server is reachable from other devices on your network.`);
  }
  if (OAUTH_ENABLED) {
    console.log('OAuth enabled. Add the callback http://localhost:' + PORT + '/api/auth/callback in GitHub.');
  } else {
    console.log('OAuth not configured — use a personal access token, or set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env to enable GitHub login.');
  }
});
