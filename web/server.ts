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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3180;

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const OAUTH_ENABLED = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';

interface AppSession {
  githubToken?: string;
  login?: string;
}

declare module 'express-session' {
  interface SessionData {
    gh?: AppSession;
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
    res.status(400).json({ error: 'OAuth is not configured on the server.' });
    return;
  }
  const redirect = String(process.env.GITHUB_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/callback`);
  const url =
    `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&scope=repo`;
  res.redirect(url);
});

/** OAuth: GitHub redirects back here with ?code=... */
app.get('/api/auth/callback', async (req, res) => {
  const code = String(req.query.code || '');
  if (!code) {
    res.status(400).send('Missing code.');
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
      res.status(400).send(`OAuth failed: ${data.error ?? 'no token returned'}`);
      return;
    }
    const me = await ghFetch(data.access_token, 'https://api.github.com/user');
    const user = (await me.json()) as { login: string };
    req.session.gh = { githubToken: data.access_token, login: user.login };
    req.session.save((err: unknown) => {
      if (err) {
        res.status(500).send('Could not persist session.');
        return;
      }
      res.redirect('/');
    });
  } catch (err) {
    res.status(500).send(`OAuth exchange error: ${(err as Error).message}`);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ connected: false }));
});

// ---------------------------------------------------------------------------
// GitHub data
// ---------------------------------------------------------------------------

/** List repositories the user can access (filtered by query). */
app.get('/api/repos', requireToken, async (req, res) => {
  const token = tokenFor(req)!;
  const q = String(req.query.q || '').trim();
  try {
    // Own repos only — never surface other users' repositories.
    const login = req.session.gh?.login;
    let url = 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner';
    if (q) {
      // Scope the search to the authenticated user's own repos.
      const qry = `${q} user:${login}`;
      url = `https://api.github.com/search/repositories?q=${encodeURIComponent(qry)}&per_page=30`;
    }
    const r = await ghFetch(token, url);
    if (!r.ok) {
      res.status(r.status).json({ error: `GitHub: ${r.status}` });
      return;
    }
    const data = await r.json();
    const items = q ? data.items : data;
    const repos = (items as Array<{ full_name: string; private: boolean; description: string | null }>).map(
      (r) => ({ fullName: r.full_name, private: r.private, description: r.description })
    );
    res.json({ repos });
  } catch (err) {
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
 * Body: { owner, repo, headSha, pullNumber, plans, approvedPaths }.
 */
app.post('/api/fix/apply', requireToken, async (req, res) => {
  const token = tokenFor(req)!;
  const { owner, repo, headSha, pullNumber, plans, approvedPaths } = req.body || {};

  if (!owner || !repo || !headSha || !pullNumber || !Array.isArray(plans) || !Array.isArray(approvedPaths)) {
    res.status(400).json({ error: 'owner, repo, headSha, pullNumber, plans and approvedPaths are required.' });
    return;
  }

  try {
    const result = await applyFixes(token, owner, repo, headSha, pullNumber, plans, approvedPaths);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Apply fixes failed: ${(err as Error).message}` });
  }
});

// ---------------------------------------------------------------------------
// Static UI
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`PR Risk Reviewer web app: http://localhost:${PORT}`);
  if (OAUTH_ENABLED) {
    console.log('OAuth enabled. Add the callback http://localhost:' + PORT + '/api/auth/callback in GitHub.');
  } else {
    console.log('OAuth not configured — use a personal access token (Settings → Developer settings is not needed; a classic or fine-grained PAT with repo scope works).');
  }
});
