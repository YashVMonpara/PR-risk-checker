/* PR Risk Reviewer — setup panel.
 *
 * Pure client-side. The only network call is the LM Studio / custom-endpoint
 * probe, which the user triggers explicitly. Nothing is stored or uploaded.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    form: $('form'),
    stepModel: $('stepModel'),
    noteNone: $('noteNone'),
    noteLocal: $('noteLocal'),

    fieldOpenAIKey: $('fieldOpenAIKey'),
    secretName: $('secretName'),

    fieldBaseUrl: $('fieldBaseUrl'),
    baseUrl: $('baseUrl'),
    baseUrlHint: $('baseUrlHint'),
    probeBtn: $('probeBtn'),
    probeResult: $('probeResult'),

    fieldCustomAuth: $('fieldCustomAuth'),
    customNeedsAuth: $('customNeedsAuth'),
    customSecretWrap: $('customSecretWrap'),
    customSecretName: $('customSecretName'),

    fieldModel: $('fieldModel'),
    model: $('model'),
    modelList: $('modelList'),
    modelHint: $('modelHint'),

    threshold: $('threshold'),
    thresholdHint: $('thresholdHint'),
    failOnError: $('failOnError'),
    fieldBudget: $('fieldBudget'),
    maxCalls: $('maxCalls'),
    maxCallsOut: $('maxCallsOut'),
    budgetHint: $('budgetHint'),

    repoRef: $('repoRef'),
    selfHosted: $('selfHosted'),
    runnerHint: $('runnerHint'),

    behaviourNum: $('behaviourNum'),
    repoNum: $('repoNum'),

    yamlOut: $('yamlOut'),
    checklist: $('checklist'),
    costBox: $('costBox'),
    copyBtn: $('copyBtn'),
    downloadBtn: $('downloadBtn'),
  };

  const backend = () => el.form.querySelector('input[name=backend]:checked').value;
  const usesLLM = () => backend() !== 'none';

  /* ------------------------------------------------------------------ *
   * Hint copy
   * ------------------------------------------------------------------ */

  const THRESHOLD_HINT = {
    info: 'Includes PR-hygiene nits like "large diff, thin description". Noisiest — good for a one-off audit, tiring on every PR.',
    warning: 'Security issues, breaking exported signatures, missing tests and lockfile drift. The balance most teams want.',
    error: 'Security anti-patterns only: eval(), innerHTML, shell/SQL injection, hardcoded secrets. Pair with the merge gate below.',
  };

  const MODEL_HINT = {
    openai:
      'gpt-4o-mini is the sweet spot for triage — cheap, fast, and reliable at this task. gpt-4o costs roughly 15× more for marginal gain here.',
    local:
      'Pick a model you have actually loaded. Small models (≤8B) are noticeably worse at triage: expect more false positives to survive. Security findings are protected either way — the LLM can never dismiss them.',
    custom:
      'Use the exact model identifier your endpoint expects, e.g. meta-llama/Llama-3.1-70B-Instruct.',
  };

  function runnerHint() {
    if (backend() === 'local' && !el.selfHosted.checked) {
      return '⚠️ You chose a local model but a GitHub-hosted runner. It will not be able to reach your machine — tick this box.';
    }
    if (el.selfHosted.checked) {
      return 'The workflow will use runs-on: self-hosted. Make sure that runner is online and can reach your endpoint.';
    }
    return 'Uses GitHub-hosted ubuntu-latest. Correct for deterministic-only and OpenAI setups.';
  }

  function budgetHint() {
    const n = Number(el.maxCalls.value);
    if (backend() === 'openai') {
      const lo = (n * 0.0012).toFixed(3);
      const hi = (n * 0.004).toFixed(3);
      return `Caps spend and runtime. At ~${n} calls, expect roughly $${lo}–$${hi} per PR with gpt-4o-mini. Findings beyond the cap keep their built-in message.`;
    }
    const secs = n * 15;
    return `Local models are slow. At ~15s per call, ${n} findings ≈ ${Math.round(secs / 60)}–${Math.round((secs * 2) / 60)} min per PR. Lower this if reviews feel sluggish.`;
  }

  /* ------------------------------------------------------------------ *
   * Visibility
   * ------------------------------------------------------------------ */

  function sync() {
    const b = backend();

    el.stepModel.hidden = b === 'none';
    el.noteNone.hidden = b !== 'none';
    el.noteLocal.hidden = b !== 'local';

    el.fieldOpenAIKey.hidden = b !== 'openai';
    el.fieldBaseUrl.hidden = b !== 'local' && b !== 'custom';
    el.fieldCustomAuth.hidden = b !== 'custom';
    el.customSecretWrap.hidden = !el.customNeedsAuth.checked;
    el.fieldModel.hidden = b === 'none';
    el.fieldBudget.hidden = b === 'none';

    // Step numbering shifts when step 2 is hidden.
    el.behaviourNum.textContent = b === 'none' ? '2' : '3';
    el.repoNum.textContent = b === 'none' ? '3' : '4';

    if (b === 'local') {
      el.baseUrl.placeholder = 'http://localhost:1234/v1';
      el.baseUrlHint.innerHTML =
        'LM Studio default is <code>http://localhost:1234/v1</code>. The <code>/v1</code> suffix is required.';
    } else if (b === 'custom') {
      el.baseUrl.placeholder = 'https://api.together.xyz/v1';
      el.baseUrlHint.innerHTML =
        'Any OpenAI-compatible endpoint. Must include the <code>/v1</code> path segment.';
    }

    if (MODEL_HINT[b]) el.modelHint.textContent = MODEL_HINT[b];
    // Reset to the backend's default model when we're switching away from a
    // model that couldn't have come from this backend (local/custom models
    // contain a "/" and would be invalid on OpenAI).
    if (b === 'openai') {
      if (!el.model.value || el.model.value.includes('/')) el.model.value = 'gpt-4o-mini';
    }

    el.thresholdHint.textContent = THRESHOLD_HINT[el.threshold.value];
    el.runnerHint.textContent = runnerHint();
    el.maxCallsOut.textContent = el.maxCalls.value;
    el.budgetHint.textContent = budgetHint();

    render();
  }

  /* ------------------------------------------------------------------ *
   * Endpoint probe
   * ------------------------------------------------------------------ */

  function probeMsg(cls, html) {
    el.probeResult.hidden = false;
    el.probeResult.className = `probe ${cls}`;
    el.probeResult.innerHTML = html;
  }

  async function probe() {
    const raw = el.baseUrl.value.trim().replace(/\/+$/, '');
    if (!raw) {
      probeMsg('probe-err', '<strong>Enter a URL first.</strong>');
      return;
    }

    probeMsg('probe-busy', 'Contacting endpoint…');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetch(`${raw}/models`, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        probeMsg(
          'probe-err',
          `<strong>Reached it, but got HTTP ${res.status}.</strong>` +
            (res.status === 401
              ? '<div class="fix">This endpoint needs an API key — tick "requires an API key" above.</div>'
              : '<div class="fix">Check the URL includes <code>/v1</code>.</div>')
        );
        return;
      }

      const data = await res.json();
      const ids = (data.data || []).map((m) => m.id).filter(Boolean);

      // Offer the discovered models as autocomplete options.
      el.modelList.innerHTML = '';
      for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        el.modelList.appendChild(opt);
      }

      // Chat models only — embedding models can't do triage.
      const chat = ids.filter((id) => !/embed/i.test(id));
      if (chat.length && !chat.includes(el.model.value)) {
        el.model.value = chat[0];
      }

      probeMsg(
        'probe-ok',
        `<strong>Connected — ${ids.length} model${ids.length === 1 ? '' : 's'} available.</strong>` +
          `<ul>${ids.map((id) => `<li>${escapeHtml(id)}${/embed/i.test(id) ? ' <span style="color:var(--text-faint)">(embedding — not usable)</span>' : ''}</li>`).join('')}</ul>` +
          `<div class="fix">Picked <code>${escapeHtml(el.model.value)}</code>. Change it in the field below if you prefer another.</div>`
      );

      sync();
    } catch (err) {
      clearTimeout(timer);
      const aborted = err.name === 'AbortError';

      probeMsg(
        'probe-err',
        `<strong>${aborted ? 'Timed out after 6s.' : 'Could not reach the endpoint.'}</strong>` +
          `<div class="fix">Most likely one of:<br>` +
          `• The server isn't running — start it with <code>lms server start --cors</code><br>` +
          `• <strong>CORS is off.</strong> LM Studio blocks browser requests unless started with the <code>--cors</code> flag. This affects <em>this page only</em>, not the action itself.<br>` +
          `• Wrong port or missing <code>/v1</code>.</div>`
      );
    }
  }

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ------------------------------------------------------------------ *
   * YAML generation
   * ------------------------------------------------------------------ */

  function buildYaml() {
    const b = backend();
    const secretsRef = (name) => '${{ secrets.' + name + ' }}';

    const uses = el.repoRef.value.trim() || './';
    const runsOn = el.selfHosted.checked ? 'self-hosted' : 'ubuntu-latest';

    const lines = [
      'name: PR Risk Review',
      '',
      'on:',
      '  pull_request:',
      '    types: [opened, synchronize, reopened]',
      '',
      'permissions:',
      '  contents: read',
      '  pull-requests: write',
      '',
      'jobs:',
      '  review:',
      `    runs-on: ${runsOn}`,
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
      '      - name: Run PR Risk Reviewer',
      `        uses: ${uses}`,
      '        with:',
      '          github_token: ' + secretsRef('GITHUB_TOKEN'),
    ];

    if (b === 'openai') {
      lines.push('          openai_api_key: ' + secretsRef(el.secretName.value.trim() || 'OPENAI_API_KEY'));
    }

    if (b === 'local' || b === 'custom') {
      const url = el.baseUrl.value.trim();
      lines.push(`          llm_api_base_url: ${url || 'http://localhost:1234/v1'}`);
      if (b === 'custom' && el.customNeedsAuth.checked) {
        lines.push('          openai_api_key: ' + secretsRef(el.customSecretName.value.trim() || 'LLM_API_KEY'));
      } else if (b === 'local') {
        lines.push('          # openai_api_key omitted — LM Studio needs no auth');
      }
    }

    if (usesLLM()) {
      lines.push(`          model: ${el.model.value.trim() || 'gpt-4o-mini'}`);
      lines.push(`          max_llm_calls: '${el.maxCalls.value}'`);
    }

    lines.push(`          risk_threshold: ${el.threshold.value}`);
    lines.push(`          fail_on_error: '${el.failOnError.checked}'`);

    return lines.join('\n');
  }

  function highlight(yaml) {
    return yaml
      .split('\n')
      .map((line) => {
        if (/^\s*#/.test(line)) return `<span class="y-com">${escapeHtml(line)}</span>`;

        let out = escapeHtml(line);

        // ${{ ... }} expressions
        out = out.replace(/(\$\{\{[^}]*\}\})/g, '<span class="y-var">$1</span>');

        // key:
        out = out.replace(/^(\s*-?\s*)([\w.-]+)(:)/, '$1<span class="y-key">$2</span>$3');

        // trailing comment
        out = out.replace(/(\s#\s.*)$/, '<span class="y-com">$1</span>');

        // quoted values
        out = out.replace(/('(?:[^']*)')/g, '<span class="y-str">$1</span>');

        return out;
      })
      .join('\n');
  }

  /* ------------------------------------------------------------------ *
   * Checklist + cost
   * ------------------------------------------------------------------ */

  function buildChecklist() {
    const b = backend();
    const steps = [];

    steps.push(
      'Save the file above as <code>.github/workflows/pr-risk-review.yml</code> in the repo you want reviewed.'
    );

    if (!el.repoRef.value.trim()) {
      steps.push(
        '<strong>Set the action reference.</strong> It currently says <code>uses: ./</code>, which only works inside the action\'s own repo. Fill in <em>owner/repo</em> above once it\'s published.'
      );
    }

    if (b === 'openai') {
      steps.push(
        `Add your OpenAI key as a secret named <code>${escapeHtml(el.secretName.value.trim() || 'OPENAI_API_KEY')}</code> under <strong>Settings → Secrets and variables → Actions</strong>.`
      );
    }

    if (b === 'custom' && el.customNeedsAuth.checked) {
      steps.push(
        `Add the endpoint key as a secret named <code>${escapeHtml(el.customSecretName.value.trim() || 'LLM_API_KEY')}</code>.`
      );
    }

    if (b === 'local') {
      steps.push(
        '<strong>Register a self-hosted runner</strong> on the machine running LM Studio, and keep the LM Studio server started.'
      );
      if (!el.selfHosted.checked) {
        steps.push(
          '⚠️ <strong>Tick "self-hosted runner" above.</strong> As written, a GitHub-hosted runner cannot reach <code>localhost</code> and the AI step will be skipped.'
        );
      }
    }

    if (el.failOnError.checked) {
      steps.push(
        'Because this can fail the check, add it as a required status check under <strong>Settings → Branches</strong> if you want it to actually block merges.'
      );
    }

    steps.push('Open a pull request. The review appears within a minute or two.');

    return (
      '<h3>Next steps</h3><ol>' + steps.map((s) => `<li>${s}</li>`).join('') + '</ol>'
    );
  }

  function buildCost() {
    const b = backend();
    if (b === 'none') {
      return '<strong>Cost: $0.</strong> No external API calls — only GitHub Actions minutes.';
    }
    if (b === 'openai') {
      const n = Number(el.maxCalls.value);
      return `<strong>Estimated cost:</strong> roughly $${(n * 0.0012).toFixed(3)}–$${(n * 0.004).toFixed(3)} per pull request at up to ${n} triage calls with gpt-4o-mini. A busy repo at 100 PRs/month lands near $${(n * 0.0025 * 100).toFixed(2)}/month. Rough estimate, not a quote.`;
    }
    return '<strong>Cost: $0 in API fees</strong> — inference runs on your own hardware. You pay in latency and the electricity bill.';
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  let currentYaml = '';

  function render() {
    currentYaml = buildYaml();
    el.yamlOut.innerHTML = highlight(currentYaml);
    el.checklist.innerHTML = buildChecklist();
    el.costBox.innerHTML = buildCost();
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  el.form.addEventListener('input', sync);
  el.form.addEventListener('change', sync);
  el.probeBtn.addEventListener('click', probe);

  el.copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentYaml);
      el.copyBtn.textContent = 'Copied';
    } catch {
      el.copyBtn.textContent = 'Press ⌘C';
    }
    setTimeout(() => (el.copyBtn.textContent = 'Copy'), 1600);
  });

  el.downloadBtn.addEventListener('click', () => {
    const blob = new Blob([currentYaml + '\n'], { type: 'text/yaml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pr-risk-review.yml';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  sync();
})();
