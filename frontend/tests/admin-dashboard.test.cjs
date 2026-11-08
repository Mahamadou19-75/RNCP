'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(frontend, 'api.js'), 'utf8');
const appSource = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
const source = fs.readFileSync(path.join(frontend, 'admin-dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(frontend, 'admin-dashboard.html'), 'utf8');
const routes = ['/api/v1/me', '/api/v1/stats', '/api/v1/stories',
  '/api/v1/proposals', '/api/v1/admin/reports', '/api/v1/admin/stories?state=archived'];
const counters = ['stories', 'resolved', 'coldcases', 'users', 'comments', 'reports', 'pending-proposals'];
const story = (id, category_id) => ({
  id, category_id, slug: 'isolated-' + id, title: 'Dossier ' + id,
  summary: 'Résumé isolé', content: 'Contenu isolé'
});
const proposal = (changes = {}) => ({
  id: 3, title: 'Proposition isolée', content: 'Une piste.\n\nUne suite.',
  status: 'pending', created_at: '2026-10-24T10:15:00', ...changes
});
const report = (changes = {}) => ({
  id: 9, type: 'comment', target_id: '7', reason: 'Motif isolé.',
  status: 'pending', created_at: '2026-10-24T10:15:00', ...changes
});
const response = (status, body) => ({
  status, ok: status >= 200 && status < 300, async json() { return body; }
});
function defaults(url) {
  if (url.endsWith('/admin/stories?state=archived')) return [];
  if (url.endsWith('/me')) return { user: { is_admin: true, private_marker: 'Never render this' }, csrf_token: 'isolated-test-token' };
  if (url.endsWith('/stats')) return { users: 7, comments: 12, reports: 2 };
  if (url.endsWith('/stories')) return [story(17, 1), story(42, 2), story(43, 2)];
  if (url.endsWith('/proposals')) return [proposal()];
  return [report()];
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = new Map();
    this.attributes = {}; this.style = {}; this.disabled = false;
    this.hidden = false; this._text = '';
    Object.defineProperty(this, 'innerHTML', {
      get() { throw new Error('HTML parsing forbidden'); },
      set() { throw new Error('HTML parsing forbidden'); }
    });
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) {
    const listeners = this.events.get(name) || [];
    listeners.push(fn); this.events.set(name, listeners);
  }
  async emit(name, event = {}) {
    await Promise.all((this.events.get(name) || []).map(fn => fn({ target: this, ...event })));
  }
  querySelector(tag) {
    for (const child of this.children) {
      if (child.tagName === tag) return child;
      const found = child.querySelector(tag); if (found) return found;
    }
    return null;
  }
}
async function settle() { for (let i = 0; i < 32; i++) await Promise.resolve(); }
function mount(options = {}) {
  const ids = new Map();
  for (const id of ['admin-dashboard', 'admin-data', 'admin-refresh', 'admin-feedback',
    'admin-login-link', 'admin-proposals-list', 'admin-reports-list',
    'admin-categories-feedback', 'admin-proposals-feedback', 'admin-reports-feedback',
    ...counters.map(k => 'admin-' + k + '-count')]) ids.set(id, new Element());
  const window = new Element('window'), calls = [], tags = [];
  const main = ids.get('admin-dashboard'), data = ids.get('admin-data');
  const refresh = ids.get('admin-refresh'), feedback = ids.get('admin-feedback');
  const login = ids.get('admin-login-link');
  main.setAttribute('aria-busy', 'true');
  data.hidden = login.hidden = refresh.disabled = true;
  const context = vm.createContext({
    AbortController, TextEncoder, setTimeout, clearTimeout, Intl, window,
    document: {
      getElementById: id => ids.get(id) || null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement(tag) { tags.push(tag); return new Element(tag); }
    },
    XMLHttpRequest() { throw new Error('Network forbidden'); },
    WebSocket() { throw new Error('Network forbidden'); },
    localStorage: new Proxy({}, { get() { throw new Error('Local role claims forbidden'); } }),
    async fetch(url, request) {
      assert.ok(routes.includes(url), 'Only the six approved read routes are allowed');
      assert.equal(request.method || 'GET', 'GET', 'Write requests forbidden');
      assert.equal(request.onAccessDenied, undefined, 'Callback must never be forwarded to fetch');
      assert.equal(request.body, undefined);
      calls.push({ url, ...request });
      if (options.fetch) return options.fetch(url, request, calls);
      const body = options.bodies?.[url] === undefined ? defaults(url) : options.bodies[url];
      return response(options.statuses?.[url] || 200, body);
    }
  });
  vm.runInContext(apiSource, context, { filename: 'frontend/api.js', timeout: 1000 });
  vm.runInContext(appSource, context, { filename: 'frontend/app.js', timeout: 1000 });
  vm.runInContext(source, context, { filename: 'frontend/admin-dashboard.js', timeout: 1000 });
  return {
    ids, context, window, calls, tags, main, data, refresh, feedback, login,
    proposals: ids.get('admin-proposals-list'), reports: ids.get('admin-reports-list'),
    count: name => ids.get('admin-' + name + '-count').textContent,
    async ready() { await settle(); assert.equal(main.attributes['aria-busy'], 'false'); },
    update() { return refresh.emit('click'); }
  };
}
function assertCleared(page) {
  assert.equal(page.data.hidden, true);
  assert.equal(page.proposals.children.length, 0);
  assert.equal(page.reports.children.length, 0);
  for (const name of counters) assert.equal(page.count(name), '—');
}

test('HTML removes fictitious data and actions and loads API before application and dashboard', () => {
  assert.doesNotMatch(html, /MAQUETTE|Aucune donnée réelle|Ajouter une histoire|à connecter|Gestion des histoires|donnees\.js/);
  assert.match(html, /id="admin-data" class="section" hidden/);
  assert.match(html, /id="admin-refresh" class="btn" type="button" disabled/);
  for (const name of counters) assert.match(html, new RegExp('id="admin-' + name + '-count">—<'));
  assert.ok(html.indexOf('src="api.js"') < html.indexOf('src="app.js"'));
  assert.ok(html.indexOf('src="app.js"') < html.indexOf('src="admin-dashboard.js"'));
  assert.match(html, /Les Petits Enquêteurs · Projet étudiant — HOLBERTON SCHOOL/);
  assert.doesNotMatch(html, /<form|onclick=|<style|style=/);
});

test('session is checked before any dashboard read', async () => {
  const gate = deferred();
  const page = mount({ fetch: async url => {
    if (url.endsWith('/me')) await gate.promise;
    return response(200, defaults(url));
  } });
  try {
    assert.deepEqual(page.calls.map(c => c.url), ['/api/v1/me']);
    assert.equal(page.refresh.disabled, true);
    assertCleared(page);
  } finally { gate.resolve(); await page.ready(); }
  assert.deepEqual(page.calls.map(c => c.url).sort(), [...routes].sort());
});

for (const role of [false, 'true', 1, null, undefined, {}]) {
  test('strict admin role rejects ' + String(role) + ' before reading data', async () => {
    const page = mount({ bodies: { '/api/v1/me': { user: { is_admin: role } } } });
    await page.ready();
    assert.deepEqual(page.calls.map(c => c.url), ['/api/v1/me']);
    assertCleared(page); assert.equal(page.login.hidden, false);
    assert.match(page.feedback.textContent, /Accès refusé/);
  });
}

test('missing user data grants no dashboard access', async () => {
  const page = mount({ bodies: { '/api/v1/me': {} } }); await page.ready();
  assert.equal(page.calls.length, 1); assertCleared(page);
});

for (const status of [401, 403]) {
  test('session HTTP ' + status + ' clears data and offers administrator login', async () => {
    const page = mount({ statuses: { '/api/v1/me': status } }); await page.ready();
    assert.equal(page.calls.length, 1); assertCleared(page);
    assert.equal(page.login.hidden, false);
    assert.equal(page.refresh.disabled, false);
    assert.match(page.feedback.textContent, status === 401 ? /session.*expiré/ : /Accès refusé/);
  });
}

test('authorized reads render genuine counters, category distribution, proposals and reports', async () => {
  const page = mount(); await page.ready();
  assert.equal(page.data.hidden, false);
  assert.deepEqual(counters.map(name => page.count(name)), ['3', '1', '2', '7', '12', '2', '1']);
  assert.equal(page.proposals.querySelector('h3').textContent, 'Proposition isolée');
  assert.match(page.proposals.textContent, /En attente.*heure de Paris.*Une piste\..*Une suite\./);
  assert.match(page.reports.textContent, /Signalement de commentaire.*Cible : 7.*Motif isolé/);
  assert.equal(page.proposals.querySelector('time').dateTime, '2026-10-24T10:15:00.000Z');
  assert.match(page.proposals.querySelector('time').textContent, /12:15/);
  assert.equal(page.login.hidden, true);
  assert.ok(!Array.from(page.ids.values()).some(node => node.textContent.includes('Never render this')));
  assert.ok(page.calls.every(c => c.credentials === 'include' && c.headers['X-CSRF-Token'] === undefined));
});

test('empty lists and real zero counters are distinguished from unavailable data', async () => {
  const page = mount({ bodies: {
    '/api/v1/stats': { users: 0, comments: 0, reports: 0 },
    '/api/v1/stories': [], '/api/v1/proposals': [], '/api/v1/admin/reports': []
  } }); await page.ready();
  assert.equal(page.data.hidden, false);
  assert.ok(counters.every(name => page.count(name) === '0'));
  assert.match(page.ids.get('admin-categories-feedback').textContent, /Aucun dossier/);
  assert.match(page.ids.get('admin-proposals-feedback').textContent, /Aucune proposition/);
  assert.match(page.ids.get('admin-reports-feedback').textContent, /Aucun signalement/);
});

test('unknown categories remain counted in total and have a visible explanation', async () => {
  const page = mount({ bodies: { '/api/v1/stories': [story(17, 1), story(42, 99)] } });
  await page.ready();
  assert.equal(page.count('stories'), '2');
  assert.equal(page.count('resolved'), '1'); assert.equal(page.count('coldcases'), '0');
  assert.match(page.ids.get('admin-categories-feedback').textContent, /1 dossier.*non configurée/);
});

test('Actualiser rechecks session then replaces all values without duplicating entries', async () => {
  let cycle = 0;
  const page = mount({ fetch: async url => {
    if (url.endsWith('/me')) cycle++;
    if (url.endsWith('/stats')) return response(200, { users: cycle, comments: 0, reports: 0 });
    return response(200, defaults(url));
  } });
  await page.ready(); await page.update();
  assert.equal(page.count('users'), '2');
  assert.equal(page.proposals.children.length, 1);
  assert.equal(page.reports.children.length, 1);
  assert.equal(page.calls.filter(c => c.url.endsWith('/me')).length, 2);
});

test('double refresh clicks while loading do not start another cycle', async () => {
  const gate = deferred();
  const page = mount({ fetch: async url => {
    if (!url.endsWith('/me')) await gate.promise;
    return response(200, defaults(url));
  } });
  await settle();
  try {
    await page.update(); await page.update();
    assert.equal(page.calls.length, routes.length);
    assertCleared(page);
    assert.equal(page.main.attributes['aria-busy'], 'true');
  } finally { gate.resolve(); await page.ready(); }
});

for (const route of routes) {
  for (const status of [401, 403]) {
    test(route + ' HTTP ' + status + ' aborts immediately without waiting for a response body or other reads', async () => {
      const gate = deferred(); let bodyReads = 0;
      const page = mount({ fetch: async url => {
        if (url === route) return {
          status, ok: false, json() { bodyReads++; return new Promise(() => {}); }
        };
        if (!url.endsWith('/me')) await gate.promise;
        return response(200, defaults(url));
      } });
      try {
        await page.ready();
        assertCleared(page);
        assert.equal(bodyReads, 0, 'Denied response body must not delay revocation');
        assert.equal(page.login.hidden, false);
        assert.equal(page.refresh.disabled, false);
        // The successful /me request is already complete when data reads start.
        const pending = page.calls.filter(c => c.url !== '/api/v1/me' || route === '/api/v1/me');
        assert.ok(pending.every(c => c.signal.aborted));
      } finally { gate.resolve(); await settle(); }
      assertCleared(page);
    });
  }
}

for (const status of [401, 403]) {
  test('previously visible administrative data is erased when refreshed session returns ' + status, async () => {
    let sessions = 0;
    const page = mount({ fetch: async url => {
      if (url.endsWith('/me') && ++sessions > 1) return response(status, {});
      return response(200, defaults(url));
    } });
    await page.ready(); assert.equal(page.data.hidden, false);
    await page.update(); assertCleared(page);
    assert.equal(page.login.hidden, false);
  });
}

for (const route of routes) {
  test(route + ' network failure hides incomplete data and permits retry', async () => {
    let failed = false;
    const page = mount({ fetch: async url => {
      if (url === route && !failed) { failed = true; throw new TypeError('Synthetic offline'); }
      return response(200, defaults(url));
    } });
    await page.ready(); assertCleared(page);
    assert.match(page.feedback.textContent, /Impossible de charger/);
    assert.equal(page.refresh.disabled, false);
    await page.update(); assert.equal(page.data.hidden, false);
  });
}

for (const route of routes) {
  test(route + ' HTTP 500 never displays invented zero counters', async () => {
    const page = mount({ statuses: { [route]: 500 } }); await page.ready();
    assertCleared(page); assert.match(page.feedback.textContent, /Impossible de charger/);
  });
}

for (const invalid of [null, {}, { users: -1, comments: 0, reports: 0 },
  { users: '7', comments: 0, reports: 0 }, { users: 0, comments: 1.5, reports: 0 },
  { users: 0, comments: 0, reports: Number.MAX_SAFE_INTEGER + 1 }]) {
  test('invalid statistics are rejected: ' + JSON.stringify(invalid), async () => {
    const page = mount({ bodies: { '/api/v1/stats': invalid } }); await page.ready();
    assertCleared(page);
  });
}

for (const [route, payload] of [
  ['/api/v1/stories', [story(0, 1)]],
  ['/api/v1/stories', [story(17, 1), story(17, 1)]],
  ['/api/v1/proposals', {}],
  ['/api/v1/proposals', [proposal({ id: 0 })]],
  ['/api/v1/proposals', [proposal(), proposal()]],
  ['/api/v1/proposals', [proposal({ title: {} })]],
  ['/api/v1/proposals', [proposal({ content: null })]],
  ['/api/v1/admin/reports', [null]],
  ['/api/v1/admin/reports', [report({ reason: [] })]],
  ['/api/v1/admin/reports', [report({ target_id: 7 })]],
  ['/api/v1/admin/reports', [report({ status: false })]],
  ['/api/v1/admin/reports', [report(), report()]]
]) {
  test('invalid collection on ' + route + ' is rejected without partial display: ' + JSON.stringify(payload), async () => {
    const page = mount({ bodies: { [route]: payload } }); await page.ready(); assertCleared(page);
  });
}

for (const status of [201, 202, 204]) {
  test('unexpected GET status ' + status + ' is rejected by dashboard data helpers', async () => {
    const page = mount({ statuses: { '/api/v1/proposals': status } }); await page.ready();
    assertCleared(page);
  });
}

test('unreadable JSON cannot leave partial administrative data on screen', async () => {
  const page = mount({ fetch: async url => {
    if (url.endsWith('/proposals')) return {
      status: 200, ok: true, async json() { throw new SyntaxError('Synthetic invalid JSON'); }
    };
    return response(200, defaults(url));
  } }); await page.ready(); assertCleared(page);
});

test('external titles, reasons, targets and statuses use textContent without HTML parsing', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const page = mount({ bodies: {
    '/api/v1/proposals': [proposal({ title: attack, content: '<script>alert(1)</script>', status: attack })],
    '/api/v1/admin/reports': [report({ type: attack, target_id: attack, reason: attack, status: attack })]
  } }); await page.ready();
  assert.equal(page.data.hidden, false);
  assert.equal(page.proposals.querySelector('h3').textContent, attack);
  assert.ok(page.proposals.textContent.includes('<script>alert(1)</script>'));
  assert.ok(page.reports.textContent.includes(attack));
  assert.ok(!page.tags.some(tag => ['img', 'script'].includes(tag)));
});

test('missing or unusable dates have neutral fallbacks', async () => {
  const page = mount({ bodies: {
    '/api/v1/proposals': [proposal({ created_at: null })],
    '/api/v1/admin/reports': [report({ created_at: 'unusable date' })]
  } }); await page.ready();
  assert.equal(page.proposals.querySelector('time').textContent, 'Date indisponible');
  assert.equal(page.reports.querySelector('time').textContent, 'Date indisponible');
});

for (const staleDenied of [false, true]) {
  test('restoring the page prevents a late ' + (staleDenied ? 'denial' : 'success') + ' from overwriting the fresh session', async () => {
    const gate = deferred(); let sessions = 0;
    const page = mount({ fetch: async url => {
      if (url.endsWith('/me')) {
        sessions++;
        if (sessions === 1) {
          await gate.promise;
          return response(staleDenied ? 403 : 200, defaults(url));
        }
      }
      return response(200, defaults(url));
    } });
    try {
      await page.window.emit('pagehide'); assertCleared(page);
      await page.window.emit('pageshow', { persisted: true });
      assert.equal(page.data.hidden, false);
      gate.resolve(); await settle();
      assert.equal(page.data.hidden, false);
      assert.equal(page.feedback.textContent, 'Données chargées.');
    } finally { gate.resolve(); await settle(); }
  });
}

test('leaving the page erases private data before browser history caching', async () => {
  const page = mount(); await page.ready();
  assert.equal(page.data.hidden, false);
  await page.window.emit('pagehide'); assertCleared(page);
  await page.window.emit('pageshow', { persisted: true });
  assert.equal(page.data.hidden, false);
  assert.equal(page.calls.filter(c => c.url.endsWith('/me')).length, 2);
});

test('initial pageshow does not cause a duplicate session check', async () => {
  const page = mount(); await page.ready();
  await page.window.emit('pageshow', { persisted: false });
  assert.equal(page.calls.length, routes.length);
});

test('dashboard script does nothing on unrelated pages', () => {
  let requests = 0;
  vm.runInNewContext(source, {
    document: { getElementById: () => null },
    getCurrentUser() { requests++; throw new Error('Unexpected request'); }
  }, { timeout: 1000 });
  assert.equal(requests, 0);
});

for (const status of [201, 202, 204]) {
  test('session GET status ' + status + ' must not grant dashboard access', async () => {
    const page = mount({ statuses: { '/api/v1/me': status } }); await page.ready();
    assert.equal(page.calls.length, 1); assertCleared(page);
  });
}

// Le jeu complet est aussi comparé à la réponse réelle de Flask en SQLite mémoire.
const proposalFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/admin-proposals.json'), 'utf8'));
for (const [label, rows, expected] of [
  ['empty API', [], '0'],
  ['no pending', proposalFixture.filter(row => row.status !== 'pending'), '0'],
  ['one pending', [proposalFixture[0]], '1'],
  ['several pending and other statuses', proposalFixture, '2']
]) {
  test('seventh counter handles ' + label + ' without altering the six existing counts', async () => {
    const data = rows.map(row => Object.freeze({ ...row })); Object.freeze(data);
    const page = mount({ bodies: { '/api/v1/proposals': data } }); await page.ready();
    assert.equal(page.data.hidden, false);
    assert.deepEqual(counters.map(name => page.count(name)), ['3', '1', '2', '7', '12', '2', expected]);
    assert.equal(page.proposals.children.length, rows.length);
    assert.deepEqual(data, rows);
    assert.equal(page.calls.length, routes.length);
    assert.equal(page.calls.filter(call => call.url === '/api/v1/proposals').length, 1);
    assert.ok(page.calls.every(call => (call.method || 'GET') === 'GET' && call.body === undefined));
  });
}
for (const status of ['approved', 'rejected', 'Pending', ' pending', 'pending ', '', 'unknown']) {
  test('only exact pending is counted, excluding ' + JSON.stringify(status), async () => {
    const page = mount({ bodies: { '/api/v1/proposals': [proposal({ status })] } }); await page.ready();
    assert.equal(page.count('pending-proposals'), '0');
    assert.equal(page.proposals.children.length, 1);
  });
}
test('pending count stays unavailable until all current reads succeed', async () => {
  const gate = deferred();
  const page = mount({ fetch: async url => {
    if (url.endsWith('/proposals')) await gate.promise;
    return response(200, defaults(url));
  } }); await settle();
  try {
    assertCleared(page); assert.equal(page.main.attributes['aria-busy'], 'true');
    assert.equal(page.refresh.disabled, true);
  } finally { gate.resolve(); await page.ready(); }
  assert.equal(page.count('pending-proposals'), '1');
});
for (const failure of ['500', 'network', 'invalid JSON', 'missing status', 'numeric status']) {
  test('proposal refresh failure ' + failure + ' removes previous counts rather than showing zero', async () => {
    let fail = false;
    const page = mount({ fetch: async url => {
      if (fail && url.endsWith('/proposals')) {
        if (failure === '500') return response(500, { error: 'Synthetic failure' });
        if (failure === 'network') throw new TypeError('Synthetic network failure');
        if (failure === 'invalid JSON') return { status: 200, ok: true, async json() { throw new SyntaxError('Synthetic JSON'); } };
        return response(200, [proposal({ status: failure === 'numeric status' ? 1 : undefined })]);
      }
      return response(200, defaults(url));
    } }); await page.ready(); assert.equal(page.count('pending-proposals'), '1');
    fail = true; await page.update(); assertCleared(page);
    assert.match(page.feedback.textContent, /Impossible de charger/);
    assert.equal(page.refresh.disabled, false);
  });
}
for (const lateStatus of [200, 403]) {
  test('late proposal HTTP ' + lateStatus + ' cannot overwrite a fresh pending count', async () => {
    const gate = deferred(); let reads = 0, oldSignal;
    const page = mount({ fetch: async (url, request) => {
      if (url.endsWith('/proposals')) {
        if (++reads === 1) { oldSignal = request.signal; await gate.promise; return response(lateStatus, []); }
        return response(200, proposalFixture);
      }
      return response(200, defaults(url));
    } }); await settle();
    try {
      await page.window.emit('pageshow', { persisted: true });
      assert.equal(oldSignal.aborted, true); assert.equal(page.count('pending-proposals'), '2');
      gate.resolve(); await settle();
      assert.equal(page.count('pending-proposals'), '2'); assert.equal(page.data.hidden, false);
    } finally { gate.resolve(); await settle(); }
  });
}
test('refresh recalculates pending count from the new administrative response', async () => {
  let rows = proposalFixture;
  const page = mount({ fetch: async url => response(200, url.endsWith('/proposals') ? rows : defaults(url)) });
  await page.ready(); assert.equal(page.count('pending-proposals'), '2');
  rows = []; await page.update(); assert.equal(page.count('pending-proposals'), '0');
  assert.equal(page.calls.filter(call => call.url === '/api/v1/proposals').length, 2);
});

const contextualReport = (changes = {}) => report({
  comment: { id: 7, story_id: 17, text: 'Texte du commentaire <img src=x onerror=alert(1)>' },
  story: { id: 17, title: 'Dossier SQL <script>test</script>', slug: 'dossier été & test',
    category_id: 1, category_name: 'Catégorie SQL', is_archived: false },
  ...changes
});

test('moderation card shows comment, actual dossier/category and safe link without changing seven counts', async () => {
  const page = mount({ bodies: { '/api/v1/admin/reports': [contextualReport()] } }); await page.ready();
  assert.match(page.reports.textContent, /Texte du commentaire <img/);
  assert.match(page.reports.textContent, /Dossier SQL <script>/);
  assert.match(page.reports.textContent, /Catégorie : Catégorie SQL/);
  assert.match(page.reports.textContent, /Motif du signalement/);
  assert.equal(page.reports.querySelector('a').href, 'dossier.html?slug=' + encodeURIComponent('dossier été & test'));
  assert.equal(page.reports.querySelector('img'), null); assert.equal(page.reports.querySelector('script'), null);
  assert.deepEqual(counters.map(name => page.count(name)), ['3','1','2','7','12','2','1']);
});

for (const [label, changes] of [
  ['wrong comment', { comment: { id: 8, story_id: 17, text: 'Wrong target' } }],
  ['wrong dossier', { story: { id: 42, slug: 'other', title: 'Other', category_id: 2, category_name: 'Other', is_archived: false } }],
  ['missing story field', { story: undefined }],
  ['invalid archive state', { story: { id: 17, slug: 'target', title: 'Target', category_id: 1, category_name: 'SQL', is_archived: 'true' } }]
]) {
  test('inconsistent moderation context '+label+' clears dashboard instead of showing a wrong target', async () => {
    const page = mount({ bodies: { '/api/v1/admin/reports': [contextualReport(changes)] } }); await page.ready();
    assertCleared(page); assert.match(page.feedback.textContent, /Impossible de charger/);
  });
}

test('archived report context remains readable without a broken public dossier link', async () => {
  const data = contextualReport(); data.story.is_archived = true;
  const page = mount({ bodies: { '/api/v1/admin/reports': [data] } }); await page.ready();
  assert.match(page.reports.textContent, /Dossier SQL/); assert.match(page.reports.textContent, /archivé/);
  assert.match(page.reports.textContent, /filtre Archives/); assert.equal(page.reports.querySelector('a'), null);
  assert.match(page.reports.textContent, /Texte du commentaire/);
});

test('unavailable historical context preserves the report without inventing a dossier', async () => {
  const page = mount({ bodies: { '/api/v1/admin/reports': [report({ comment: null, story: null })] } }); await page.ready();
  assert.equal(page.data.hidden, false); assert.match(page.reports.textContent, /Commentaire indisponible/);
  assert.match(page.reports.textContent, /Dossier indisponible/); assert.match(page.reports.textContent, /Motif isolé/);
  assert.equal(page.reports.querySelector('a'), null);
});

test('global session end immediately masks reports, private lists and all seven values', async () => {
  const page = mount(); await page.ready(); assert.equal(page.data.hidden, false);
  await page.window.emit('session-ended');
  assertCleared(page); assert.equal(page.refresh.disabled, false); assert.equal(page.login.hidden, false);
  assert.match(page.feedback.textContent, /Session modifiée/);
});
