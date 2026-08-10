/**
 * Local end-to-end harness.
 *
 * Boots a mock GitHub API on localhost, then runs the REAL built action
 * (dist/index.js) as a child process against it, exactly as GitHub Actions would.
 * Nothing here is stubbed inside the action: it does its own HTTP calls, its own
 * tree-sitter parsing, and (optionally) real LLM inference.
 *
 * Usage:
 *   node scripts/local-run.js                 # deterministic rules only
 *   node scripts/local-run.js --llm lmstudio  # + real LM Studio inference
 *   node scripts/local-run.js --llm openai    # + real OpenAI (needs OPENAI_API_KEY)
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'demo-pr');

const args = process.argv.slice(2);
const llmArg = args.includes('--llm') ? args[args.indexOf('--llm') + 1] : null;

const OWNER = 'demo-org';
const REPO = 'demo-repo';
const PR_NUMBER = 42;
const BASE_SHA = 'base000000000000000000000000000000000000';
const HEAD_SHA = 'head111111111111111111111111111111111111';

function fixture(name) {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------
// The pull request under review
// ---------------------------------------------------------------------------

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

const PULL_REQUEST = {
  number: PR_NUMBER,
  title: 'Speed up the runner',
  body: 'quick fix',
  additions: FILES.reduce((n, f) => n + f.additions, 0),
  deletions: FILES.reduce((n, f) => n + f.deletions, 0),
  base: { sha: BASE_SHA },
  head: { sha: HEAD_SHA },
};

// ---------------------------------------------------------------------------
// Mock GitHub API
// ---------------------------------------------------------------------------

const captured = { reviews: [] };

function startMockGitHub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (code, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(body);
      };

      const prPath = `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`;

      if (req.method === 'GET' && url.pathname === prPath) {
        return send(200, PULL_REQUEST);
      }

      if (req.method === 'GET' && url.pathname === `${prPath}/files`) {
        return send(
          200,
          FILES.map(({ base: _b, head: _h, ...rest }) => rest)
        );
      }

      if (req.method === 'GET' && url.pathname.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
        const filePath = decodeURIComponent(url.pathname.split('/contents/')[1]);
        const ref = url.searchParams.get('ref');
        const file = FILES.find((f) => f.filename === filePath);

        if (!file) return send(404, { message: 'Not Found' });

        const content = ref === BASE_SHA ? file.base : file.head;
        if (content === null || content === undefined) {
          return send(404, { message: 'Not Found' });
        }

        return send(200, {
          type: 'file',
          encoding: 'base64',
          name: filePath.split('/').pop(),
          path: filePath,
          content: Buffer.from(content).toString('base64'),
        });
      }

      if (req.method === 'POST' && url.pathname === `${prPath}/reviews`) {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          const review = JSON.parse(raw || '{}');
          captured.reviews.push(review);
          send(200, { id: 999, ...review });
        });
        return undefined;
      }

      return send(404, { message: `Unmocked: ${req.method} ${url.pathname}` });
    });

    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Run the built action against the mock
// ---------------------------------------------------------------------------

function runAction(apiUrl, llmInputs) {
  const eventPath = path.join(ROOT, '.local-run', 'event.json');
  mkdirSync(path.dirname(eventPath), { recursive: true });
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { number: PR_NUMBER }, repository: { name: REPO } })
  );

  const env = {
    ...process.env,
    GITHUB_API_URL: apiUrl,
    GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    'INPUT_GITHUB_TOKEN': 'fake-token',
    'INPUT_RISK_THRESHOLD': 'warning',
    'INPUT_FAIL_ON_ERROR': 'false',
    'INPUT_MAX_LLM_CALLS': '10',
    'INPUT_OPENAI_API_KEY': llmInputs.apiKey ?? '',
    'INPUT_LLM_API_BASE_URL': llmInputs.baseURL ?? '',
    'INPUT_MODEL': llmInputs.model ?? 'gpt-4o-mini',
  };

  return new Promise((resolve) => {
    const child = spawn('node', [path.join(ROOT, 'dist', 'index.js')], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const server = await startMockGitHub();
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;

  const llmInputs =
    llmArg === 'lmstudio'
      ? {
          baseURL: process.env.LM_STUDIO_URL || 'http://localhost:1234/v1',
          model: process.env.LM_STUDIO_MODEL || 'qwen/qwen3-vl-8b',
          apiKey: '',
        }
      : llmArg === 'openai'
        ? { apiKey: process.env.OPENAI_API_KEY || '', model: 'gpt-4o-mini', baseURL: '' }
        : { apiKey: '', baseURL: '', model: 'gpt-4o-mini' };

  console.log('='.repeat(78));
  console.log(`Mock GitHub API : ${apiUrl}`);
  console.log(`LLM backend     : ${llmArg ?? 'none (deterministic rules only)'}`);
  if (llmInputs.baseURL) console.log(`LLM endpoint    : ${llmInputs.baseURL} (${llmInputs.model})`);
  console.log('='.repeat(78));

  const started = Date.now();
  const { code, stdout, stderr } = await runAction(apiUrl, llmInputs);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\n--- ACTION LOG ---');
  console.log(stdout.trim() || '(no stdout)');
  if (stderr.trim()) console.log('--- STDERR ---\n' + stderr.trim());

  console.log(`\n--- RESULT (exit ${code}, ${elapsed}s) ---`);

  if (captured.reviews.length === 0) {
    console.log('No review was posted.');
  }

  for (const review of captured.reviews) {
    console.log(`\nEVENT: ${review.event}   commit: ${review.commit_id}`);
    console.log('\n=== REVIEW BODY ===');
    console.log(review.body);

    const comments = review.comments ?? [];
    console.log(`\n=== INLINE COMMENTS (${comments.length}) ===`);
    for (const c of comments) {
      console.log(`\n--- ${c.path} @ diff position ${c.position} ---`);
      console.log(c.body);
    }
  }

  server.close();
  process.exit(code === 0 && captured.reviews.length > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Harness failed:', error);
  process.exit(1);
});
