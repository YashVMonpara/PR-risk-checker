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
    $('oauthLink').hidden = !s.oauthEnabled;
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

  // --- connect with token ---
  $('connectBtn').addEventListener('click', async () => {
    const st = $('connectStatus');
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

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.login = null;
    await refreshAuth();
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

  // --- run review ---
  $('runBtn').addEventListener('click', async () => {
    if (!state.repo || !state.pull) return;
    const st = $('runStatus');
    st.className = 'status'; st.innerHTML = '<span class="spinner"></span> Analyzing…';
    const [owner, repo] = state.repo.split('/');
    const llmKey = $('llmKey').value.trim();
    const llmUrl = $('llmUrl').value.trim();
    const llmModel = $('llmModel').value.trim();
    const body = {
      owner, repo, pullNumber: state.pull,
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

  refreshAuth();
})();
