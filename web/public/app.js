/* PR Risk Reviewer web UI — vanilla JS, talks to /api/* on the same origin. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const state = {
    login: null,
    repo: null,      // "owner/name"
    pull: null,      // number
    lastResult: null,
  };

  const screens = {
    connect: $('screen-connect'),
    pick: $('screen-pick'),
    results: $('screen-results'),
    fixes: $('screen-fixes'),
  };
  function show(name) {
    for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(url, opts) {
    const r = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // --- auth status ---
  async function refreshAuth() {
    const s = await api('/api/auth/status');
    $('oauthBtn').hidden = !s.oauthEnabled;
    // If OAuth isn't configured, no GitHub button — show the token form instead.
    if (!s.oauthEnabled) {
      document.querySelector('.alt-login').open = true;
      document.querySelector('.alt-login summary').textContent = 'Sign in with a personal access token';
      $('oauthHint').hidden = true;
    }
    if (s.connected) {
      state.login = s.login;
      $('loginName').textContent = s.login;
      $('connectCard').hidden = true;
      $('connectedCard').hidden = false;
      $('sessionBox').innerHTML = `<span class="who">Connected as <strong>${esc(s.login)}</strong></span>`;
      show('pick');
    } else {
      $('connectCard').hidden = false;
      $('connectedCard').hidden = true;
      $('sessionBox').innerHTML = '';
      show('connect');
    }
  }

  // --- sign in with GitHub (OAuth) ---
  $('oauthBtn').addEventListener('click', () => {
    const st = $('connectStatus');
    st.className = 'status'; st.textContent = 'Redirecting to GitHub…';
    // Full-page navigation so GitHub can redirect back to /api/auth/callback.
    window.location.href = '/api/auth/login';
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.login = null;
    await refreshAuth();
  });

  // --- connect with token ---
  $('connectBtn').addEventListener('click', async () => {
    const st = $('patStatus');
    st.className = 'status'; st.textContent = 'Connecting…';
    try {
      const r = await api('/api/auth/token', {
        method: 'POST',
        body: JSON.stringify({ token: $('pat').value.trim() }),
      });
      state.login = r.login;
      st.className = 'status ok'; st.textContent = `Connected as ${r.login}`;
      await refreshAuth();
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message;
    }
  });

  // --- repo search ---
  let repoTimer;
  async function loadRepos() {
    const q = $('repoSearch').value.trim();
    const list = $('repoList');
    try {
      const { repos } = await api('/api/repos' + (q ? `?q=${encodeURIComponent(q)}` : ''));
      list.innerHTML = '';
      if (!repos.length) { list.innerHTML = '<div class="empty">No repositories found.</div>'; return; }
      for (const r of repos) {
        const el = document.createElement('div');
        el.className = 'row-item' + (state.repo === r.fullName ? ' sel' : '');
        el.innerHTML = `<span class="badge">${r.private ? 'private' : 'public'}</span><div class="t">${esc(r.fullName)}</div>` +
          (r.description ? `<div class="s">${esc(r.description)}</div>` : '');
        el.onclick = () => selectRepo(r.fullName);
        list.appendChild(el);
      }
    } catch (e) {
      list.innerHTML = `<div class="empty err">${esc(e.message)}</div>`;
    }
  }
  $('repoSearch').addEventListener('input', () => {
    clearTimeout(repoTimer);
    repoTimer = setTimeout(loadRepos, 300);
  });

  async function selectRepo(fullName) {
    state.repo = fullName;
    state.pull = null;
    document.querySelectorAll('#repoList .row-item').forEach((e) =>
      e.classList.toggle('sel', e.querySelector('.t').textContent === fullName));
    $('runBtn').disabled = true;
    const pl = $('pullList');
    pl.innerHTML = '<div class="empty"><span class="spinner"></span> Loading PRs…</div>';
    try {
      const { pulls } = await api(`/api/pulls?repo=${encodeURIComponent(fullName)}`);
      pl.innerHTML = '';
      if (!pulls.length) { pl.innerHTML = '<div class="empty">No open pull requests.</div>'; return; }
      for (const p of pulls) {
        const el = document.createElement('div');
        el.className = 'row-item';
        const when = new Date(p.updatedAt).toLocaleDateString();
        el.innerHTML = `<span class="badge">#${p.number}</span><div class="t">${esc(p.title)}</div>` +
          `<div class="s">by ${esc(p.author || 'unknown')} · ${when}</div>`;
        el.onclick = () => {
          state.pull = p.number;
          document.querySelectorAll('#pullList .row-item').forEach((x) => x.classList.remove('sel'));
          el.classList.add('sel');
          $('runBtn').disabled = false;
        };
        pl.appendChild(el);
      }
    } catch (e) {
      pl.innerHTML = `<div class="empty err">${esc(e.message)}</div>`;
    }
  }

  // --- detect locally-installed models (LM Studio / any OpenAI-compatible endpoint) ---
  // Same idea as panel/panel.js's probe(): the browser calls the LLM endpoint's own
  // /v1/models directly (never through our server), so the base URL only ever needs to be
  // reachable from this machine, exactly like the review call it configures.
  $('detectModelsBtn').addEventListener('click', async () => {
    const st = $('detectModelsStatus');
    const raw = $('llmUrl').value.trim().replace(/\/+$/, '');
    if (!raw) {
      st.className = 'status err'; st.textContent = 'Enter a base URL first (e.g. http://localhost:1234/v1).';
      return;
    }
    st.className = 'status'; st.innerHTML = '<span class="spinner"></span> Contacting endpoint…';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(`${raw}/models`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        st.className = 'status err';
        st.textContent = res.status === 401
          ? `HTTP ${res.status} — this endpoint needs an API key. Fill in the API key field above.`
          : `HTTP ${res.status} — check the URL includes /v1.`;
        return;
      }
      const data = await res.json();
      const ids = (data.data || []).map((m) => m.id).filter(Boolean);

      const list = $('modelOptions');
      list.innerHTML = '';
      for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        list.appendChild(opt);
      }

      // Chat models only — embedding models can't do triage.
      const chat = ids.filter((id) => !/embed/i.test(id));
      if (chat.length && !$('llmModel').value.trim()) {
        $('llmModel').value = chat[0];
      }

      st.className = 'status ok';
      st.textContent = ids.length
        ? `Found ${ids.length} model(s) — picked "${$('llmModel').value}". Change it below if you prefer another.`
        : 'Connected, but the endpoint reported no models loaded.';
    } catch (e) {
      clearTimeout(timer);
      st.className = 'status err';
      st.textContent = e.name === 'AbortError'
        ? 'Timed out after 6s — is the server running?'
        : 'Could not reach the endpoint. Check it\'s running and reachable at that URL.';
    }
  });

  // --- run review ---
  $('runBtn').addEventListener('click', async () => {
    if (!state.repo || !state.pull) return;
    const st = $('runStatus');
    st.className = 'status'; st.innerHTML = '<span class="spinner"></span> Analyzing…';
    // Clear any outcome left over from a previously reviewed PR, so it can't be
    // mistaken for this PR's status before the user has actually acted on it.
    $('postStatus').className = 'status'; $('postStatus').textContent = '';
    $('applyStatus').className = 'status'; $('applyStatus').textContent = '';
    const [owner, repo] = state.repo.split('/');
    const llmKey = $('llmKey').value.trim();
    const llmUrl = $('llmUrl').value.trim();
    const llmModel = $('llmModel').value.trim();
    const body = {
      owner, repo, pullNumber: state.pull,
      threshold: $('threshold').value,
      ...(llmKey || llmUrl ? { llm: { apiKey: llmKey, baseURL: llmUrl, model: llmModel || 'gpt-4o-mini' } } : {}),
    };
    try {
      const result = await api('/api/review', { method: 'POST', body: JSON.stringify(body) });
      state.lastResult = result;
      renderResults(result);
      show('results');
      st.textContent = '';
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message;
    }
  });

  // --- render results ---
  function renderResults(result) {
    $('resultsTitle').textContent = `${result.pr.title}`;
    $('resultsMeta').textContent =
      `${state.repo} #${result.pr.number} · +${result.pr.additions} −${result.pr.deletions}` +
      (result.usedLLM ? ' · LLM triage on' : ' · rules only');

    const counts = { error: 0, warning: 0, info: 0 };
    for (const f of result.findings) counts[f.level] = (counts[f.level] || 0) + 1;
    const bar = $('summaryBar');
    bar.innerHTML =
      `<span class="pill err">${counts.error} errors</span>` +
      `<span class="pill warn">${counts.warning} warnings</span>` +
      (counts.info ? `<span class="pill info">${counts.info} info</span>` : '') +
      (result.usedLLM ? '<span class="pill ai">AI-reviewed</span>' : '');

    const wrap = $('findings');
    wrap.innerHTML = '';
    if (!result.findings.length) {
      wrap.innerHTML = '<div class="card">✅ No risks detected.</div>';
      return;
    }
    for (const f of result.findings) {
      const el = document.createElement('div');
      el.className = `finding ${f.level}`;
      el.innerHTML =
        `<div class="ftop"><span class="sev">${f.level}</span>` +
        `<span class="cat">${esc(f.category)}</span>` +
        (f.path ? `<span class="loc">${esc(f.path)}${f.line ? ':' + f.line : ''}</span>` : '') +
        `</div><div class="msg">${esc(f.message)}</div>` +
        (f.llmEnriched ? '<div class="ai">✦ Rewritten by AI</div>' : '');
      wrap.appendChild(el);
    }
  }

  // --- post to GitHub ---
  $('postBtn').addEventListener('click', async () => {
    if (!state.lastResult) return;
    const st = $('postStatus');
    st.className = 'status'; st.innerHTML = '<span class="spinner"></span> Posting to GitHub…';
    const [owner, repo] = state.repo.split('/');
    try {
      const r = await api('/api/post', {
        method: 'POST',
        body: JSON.stringify({
          owner, repo, pullNumber: state.pull,
          headSha: state.lastResult.pr.headSha || '',
          findings: state.lastResult.findings,
        }),
      });
      st.className = 'status ok';
      st.textContent = `Posted: ${r.inlineCount} inline comment(s), ${r.summaryCount} in the summary.`;
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message;
    }
  });

  $('backBtn').addEventListener('click', () => show('pick'));

  // --- auto-fix flow ---
  $('fixBtn').addEventListener('click', async () => {
    if (!state.lastResult) return;
    const st = $('runStatus');
    st.className = 'status'; st.innerHTML = '<span class="spinner"></span> Generating safe fixes…';
    const [owner, repo] = state.repo.split('/');
    const llmKey = $('llmKey').value.trim();
    const llmUrl = $('llmUrl').value.trim();
    const llmModel = $('llmModel').value.trim();
    const body = {
      owner, repo,
      headSha: state.lastResult.pr.headSha,
      findings: state.lastResult.findings,
      llm: { apiKey: llmKey, baseURL: llmUrl, model: llmModel || 'gpt-4o-mini' },
    };
    try {
      const data = await api('/api/fix', { method: 'POST', body: JSON.stringify(body) });
      state.fixPlans = data.plans;
      renderFixes(data.plans);
      show('fixes');
      st.textContent = '';
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message;
    }
  });

  function renderFixes(plans) {
    const ready = plans.filter((p) => p.status === 'ready').length;
    const needs = plans.filter((p) => p.status === 'needs_input').length;
    const other = plans.length - ready - needs;
    $('fixesMeta').innerHTML =
      `<span class="pill ok">${ready} ready</span>` +
      (needs ? `<span class="pill warn">${needs} need input</span>` : '') +
      (other ? `<span class="pill">${other} skipped/error</span>` : '') +
      ' · review each, then apply';
    const wrap = $('fixesList');
    wrap.innerHTML = '';
    if (!plans.length) { wrap.innerHTML = '<div class="card">No fixable findings.</div>'; return; }
    plans.forEach((plan, index) => {
      const el = document.createElement('div');
      el.className = `fix-card ${plan.status}`;
      const f = plan.finding;
      const head =
        `<div class="ftop"><span class="sev ${plan.status}">${plan.status}</span>` +
        `<span class="cat">${esc(f.category)}</span>` +
        `<span class="loc">${esc(plan.path)}</span></div>`;
      const why = plan.reason ? `<div class="why">${esc(plan.reason)}</div>` : '';
      let diff = '';
      if (plan.proposal) {
        const oldL = esc(plan.proposal.old_lines ? plan.proposal.old_lines : '');
        const newL = esc(plan.proposal.new_lines ? plan.proposal.new_lines : '');
        diff =
          `<pre class="diff"><span class="del">- ${oldL}</span>` +
          `<span class="add">+ ${newL}</span></pre>`;
      }
      const checkbox =
        plan.status === 'ready'
          ? `<label class="chk"><input type="checkbox" data-index="${index}" checked /> approve</label>`
          : plan.status === 'needs_input'
          ? `<label class="chk"><input type="checkbox" data-index="${index}" /> approve anyway</label>`
          : '';
      el.innerHTML = head + why + diff + checkbox;
      wrap.appendChild(el);
    });
  }

  $('fixBackBtn').addEventListener('click', () => show('results'));

  function collectApproved() {
    const indexes = new Set();
    document.querySelectorAll('#fixesList input[type=checkbox]:checked').forEach((c) => {
      if (c.dataset.index !== undefined) indexes.add(Number(c.dataset.index));
    });
    return [...indexes];
  }

  async function doApply(allSafe) {
    if (!state.fixPlans) return;
    const st = $('applyStatus');
    st.className = 'status'; st.innerHTML = '<span class="spinner"></span> Applying…';
    const [owner, repo] = state.repo.split('/');
    let approved = collectApproved();
    if (allSafe) {
      // Apply only 'ready' plans regardless of checkbox selection.
      approved = state.fixPlans
        .map((p, index) => ({ p, index }))
        .filter(({ p }) => p.status === 'ready')
        .map(({ index }) => index);
    }
    const body = {
      owner, repo,
      headSha: state.lastResult.pr.headSha,
      pullNumber: state.pull,
      plans: state.fixPlans,
      approvedIndexes: approved,
    };
    try {
      const r = await api('/api/fix/apply', { method: 'POST', body: JSON.stringify(body) });
      st.className = 'status ok';
      const ok = r.commits.filter((c) => c.status === 'committed').length;
      const fail = r.commits.filter((c) => c.status === 'failed').length;
      st.textContent = `Applied ${ok} file(s) to the PR branch${fail ? `, ${fail} failed` : ''}.`;
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message;
    }
  }

  $('applySafeBtn').addEventListener('click', () => doApply(true));
  $('centerApply').addEventListener('click', () => doApply(false));


  refreshAuth();
})();
