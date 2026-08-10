/**
 * Runs the full end-to-end simulation against a MOCK OpenAI-compatible server.
 *
 * This proves the LM Studio / custom-endpoint code path works without needing any
 * credentials or a running model: it boots a tiny HTTP server that speaks the
 * /v1/chat/completions contract, points the action at it via llm_api_base_url,
 * and asserts the action actually called it and used the returned text.
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const received = [];

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      received.push(body);

      // Echo back a schema-valid verdict, as a real model would.
      const payload = {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                is_real_risk: true,
                severity: 'error',
                comment: 'MOCK-LLM-VERDICT: this change is risky; here is a concrete fix.',
              }),
            },
            finish_reason: 'stop',
          },
        ],
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-local-model', object: 'model' }] }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const baseURL = `http://127.0.0.1:${port}/v1`;

  console.log(`Mock OpenAI-compatible server listening on ${baseURL}`);

  // NOTE: must be async spawn — spawnSync would block this process's event loop,
  // so the mock server could never answer the child's requests (deadlock).
  const child = spawn('node', [path.join(ROOT, 'scripts', 'local-run.js'), '--llm', 'lmstudio'], {
    env: {
      ...process.env,
      LM_STUDIO_URL: baseURL,
      LM_STUDIO_MODEL: 'mock-local-model',
    },
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  child.on('close', (code) => {
    console.log(output);
    server.close();

    const failures = [];

    if (code !== 0) {
      failures.push(`harness exited with code ${code}`);
    }
    if (received.length === 0) {
      failures.push('the action never called the custom LLM endpoint');
    }
    if (!output.includes('MOCK-LLM-VERDICT')) {
      failures.push('the mock verdict text never reached the review output');
    }
    const wrongModel = received.find((r) => r.model !== 'mock-local-model');
    if (wrongModel) {
      failures.push(`the action sent the wrong model: ${wrongModel.model}`);
    }

    if (failures.length > 0) {
      console.error('\nE2E (mock LLM) FAILED:');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }

    console.log(
      `\nE2E (mock LLM) PASSED — ${received.length} completion request(s) served, ` +
        `verdict text propagated into the review.`
    );
  });
});
