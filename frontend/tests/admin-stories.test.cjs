'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
// Cette fixture est aussi comparée à la vraie réponse Flask dans le backend.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/admin-stories.json'), 'utf8'));
const sources = Object.fromEntries(['api.js', 'app.js', 'admin-users.js', 'admin-stories.js', 'admin-dashboard.js']
  .map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
const html = fs.readFileSync(path.join(root, 'admin-dashboard.html'), 'utf8');
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });
const clone = data => JSON.parse(JSON.stringify(data));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 140; i++) await Promise.resolve(); }
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = new Map(); this.attributes = {};
    this.style = {}; this.disabled = false; this.hidden = false; this._text = ''; this.value = '';
    Object.defineProperty(this, 'innerHTML', { get() { throw new Error('No HTML parsing'); }, set() { throw new Error('No HTML parsing'); } });
  }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { const listeners = this.events.get(name) || []; listeners.push(fn); this.events.set(name, listeners); }
  async emit(name, event = {}) { await Promise.all((this.events.get(name) || []).map(fn => fn({ target: this, ...event }))); }
  querySelector(tag) { for (const child of this.children) { if (child.tagName === tag) return child;
    const found = child.querySelector(tag); if (found) return found; } return null; }
}
function mount(options = {}) {
  const ids = new Map();
  for (const name of ['admin-dashboard', 'admin-data', 'admin-refresh', 'admin-feedback', 'admin-login-link',
    'admin-proposals-list', 'admin-reports-list', 'admin-categories-feedback', 'admin-proposals-feedback', 'admin-reports-feedback',
    'admin-users', 'admin-users-list', 'admin-users-refresh', 'admin-users-feedback',
    'admin-stories-state', 'admin-archives-count', 'admin-stories', 'admin-stories-search', 'admin-stories-filter', 'admin-stories-other', 'admin-stories-list', 'admin-stories-feedback',
    ...['stories', 'resolved', 'coldcases', 'users', 'comments', 'reports', 'pending-proposals'].map(name => 'admin-' + name + '-count')]) ids.set(name, new Element());
  const window = new Element('window'), calls = [], tags = [];
  window.confirm = () => true;
  let users = [{ id: 3, username: 'Fictitious admin', is_admin: true, is_banned: false },
    { id: 4, username: 'Fictitious reader', is_admin: false, is_banned: false }];
  const defaults = url => {
    if (url.endsWith('/me')) return { user: { id: 3, is_admin: true }, csrf_token: 'fictitious-csrf' };
    if (url.endsWith('/stats')) return { users: 3, comments: 7, reports: 2 };
    if (url.endsWith('/stories')) return options.stories === undefined ? clone(fixture) : options.stories;
    if (url.endsWith('/proposals')) return [{ id: 1, user_id: 1, title: 'Fictitious pending', content: 'Test only', status: 'pending', created_at: null, updated_at: null }];
    if (url.endsWith('/users')) return users;
    if (url.endsWith('/ban')) { users = users.map(user => user.id === 4 ? { ...user, is_banned: true } : user);
      return { status: 'success', user: users[1] }; }
    return [];
  };
  const context = vm.createContext({ AbortController, TextEncoder, Intl, setTimeout, clearTimeout, window,
    document: { getElementById: id => ids.get(id) || null, querySelector: () => null, querySelectorAll: () => [],
      createElement(tag) { tags.push(tag); return new Element(tag); } },
    async fetch(url, request) {
      assert.ok(['/api/v1/me', '/api/v1/stats', '/api/v1/stories', '/api/v1/proposals', '/api/v1/admin/stories?state=archived', '/api/v1/admin/reports',
        '/api/v1/users', '/api/v1/admin/users/4/ban'].includes(url));
      assert.equal(request.method || 'GET', url.endsWith('/ban') ? 'POST' : 'GET');
      calls.push({ url, ...request });
      const fallback = () => response(200, defaults(url));
      return options.fetch ? options.fetch(url, request, { fallback, calls }) : fallback();
    }
  });
  for (const name of Object.keys(sources)) vm.runInContext(sources[name], context, { filename: name, timeout: 1000 });
  return { ids, context, window, calls, tags, list: ids.get('admin-stories-list'),
    search: ids.get('admin-stories-search'), filter: ids.get('admin-stories-filter'), feedback: ids.get('admin-stories-feedback'),
    async ready() { await settle(); assert.equal(ids.get('admin-dashboard').attributes['aria-busy'], 'false'); },
    async query(value) { ids.get('admin-stories-search').value = value; await ids.get('admin-stories-search').emit('input'); },
    async select(value) { ids.get('admin-stories-filter').value = value; await ids.get('admin-stories-filter').emit('change'); },
    titles() { return ids.get('admin-stories-list').children.map(node => node.querySelector('h3').textContent); },
    counts() { return ['stories', 'resolved', 'coldcases', 'users', 'comments', 'reports'].map(name => ids.get('admin-' + name + '-count').textContent); }
  };
}

test('markup has labelled native controls, live status and responsive existing grid', () => {
  assert.match(html, /for="admin-stories-search"/); assert.match(html, /for="admin-stories-filter"/);
  assert.match(html, /id="admin-stories-search" type="search"[^>]*disabled/);
  assert.match(html, /id="admin-stories-filter"[^>]*disabled/);
  assert.match(html, /id="admin-stories-feedback"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="admin-stories-list" class="cards"/);
  assert.ok(html.indexOf('src="admin-stories.js"') < html.indexOf('src="admin-dashboard.js"'));
  assert.doesNotMatch(sources['admin-stories.js'], /innerHTML|\bfetch\(/);
});
test('all stories use the existing GET once, with the actual complete API fixture', async () => {
  const page = mount(); await page.ready();
  assert.deepEqual(page.titles(), fixture.map(story => story.title));
  assert.equal(page.calls.filter(call => call.url === '/api/v1/stories').length, 1);
  assert.equal(page.search.disabled, false); assert.equal(page.filter.disabled, false);
  assert.match(page.list.children[0].textContent, /Histoires résolues/);
  assert.match(page.list.children[1].textContent, /Cold Cases/);
});
for (const [filter, ids] of [['all', [1, 2, 3, 4]], ['resolved', [1, 4]], ['coldcase', [2]], ['other', [3]]]) {
  test('filter ' + filter + ' preserves every matching API record', async () => {
    const page = mount(); await page.ready(); const requests = page.calls.length;
    await page.select(filter);
    assert.deepEqual(page.titles(), fixture.filter(story => ids.includes(story.id)).map(story => story.title));
    assert.equal(page.calls.length, requests);
  });
}
test('unknown category is labelled with its real id, never an invented name', async () => {
  const page = mount(); await page.ready(); await page.select('other');
  assert.match(page.list.textContent, /Catégorie inconnue \(identifiant 17\)/);
  assert.equal(page.ids.get('admin-stories-other').hidden, false);
  assert.doesNotMatch(page.list.textContent, /Catégorie fictive supplémentaire/);
});
test('other filter is hidden if the dataset contains only configured categories', async () => {
  const page = mount({ stories: clone(fixture).filter(story => story.category_id !== 17) }); await page.ready();
  assert.equal(page.ids.get('admin-stories-other').hidden, true);
  assert.equal(page.ids.get('admin-stories-other').disabled, true);
});
test('title search is case insensitive and combined with category filtering', async () => {
  const page = mount(); await page.ready(); const requests = page.calls.length;
  await page.query('  ÉNIGME '); assert.deepEqual(page.titles(), [fixture[0].title]);
  await page.select('coldcase'); assert.equal(page.list.children.length, 0);
  await page.query('carnet'); assert.deepEqual(page.titles(), [fixture[1].title]);
  assert.equal(page.calls.length, requests);
});
test('search ignores summary and slug and distinguishes no match from an empty base', async () => {
  const page = mount(); await page.ready(); await page.query('Résumé fictif');
  assert.equal(page.list.children.length, 0); assert.match(page.feedback.textContent, /ne correspond/);
  await page.query('cold-case-brouillard'); assert.equal(page.list.children.length, 0);
  await page.query(''); assert.equal(page.list.children.length, 4);
});
test('empty story base has no active filters or fictitious cards', async () => {
  const page = mount({ stories: [] }); await page.ready();
  assert.equal(page.list.children.length, 0); assert.match(page.feedback.textContent, /Aucun dossier disponible/);
  assert.equal(page.search.disabled, true); assert.equal(page.filter.disabled, true);
  assert.deepEqual(page.counts(), ['0', '0', '0', '3', '7', '2']);
});
test('links open the existing detail page using the exact encoded slug', async () => {
  const page = mount(); await page.ready();
  page.list.children.forEach((card, index) => assert.equal(card.querySelector('a').href,
    'dossier.html?slug=' + encodeURIComponent(fixture[index].slug)));
});
for (const slug of [' ', '/', 'a/b', '.', '..', 'bad\\slug', '\u0000bad', '\ud800', 'a'.repeat(151)]) {
  test('unusable slug has a visible explanation and no detail link: ' + JSON.stringify(slug), async () => {
    const stories = clone(fixture); stories[0].slug = slug;
    const page = mount({ stories }); await page.ready();
    assert.equal(page.list.children[0].querySelector('a'), null);
    assert.match(page.list.children[0].textContent, /slug absent ou invalide/);
    assert.equal(page.list.children.length, 4);
  });
}
for (const slug of [undefined, null, 42, '']) {
  test('broken API slug field is rejected before rendering: ' + slug, async () => {
    const stories = clone(fixture); stories[0].slug = slug;
    const page = mount({ stories }); await page.ready();
    assert.equal(page.list.children.length, 0); assert.equal(page.ids.get('admin-data').hidden, true);
    assert.match(page.ids.get('admin-feedback').textContent, /Impossible de charger/);
  });
}
test('titles and scheme-like slug remain text and a same-site detail query', async () => {
  const stories = clone(fixture); stories[3].slug = 'javascript:alert(1)';
  const page = mount({ stories }); await page.ready();
  assert.equal(page.list.children[3].querySelector('h3').textContent, fixture[3].title);
  assert.ok(!page.tags.some(tag => ['img', 'script'].includes(tag)));
  assert.equal(page.list.children[3].querySelector('a').href, 'dossier.html?slug=javascript%3Aalert(1)');
});
for (const failure of ['network', '500', 'malformed-category', 'duplicate-id']) {
  test('story load error ' + failure + ' clears old data and permits global retry', async () => {
    const page = mount({ fetch: async (url, request, state) => {
      if (url !== '/api/v1/stories') return state.fallback();
      if (failure === 'network') throw new TypeError('Fictitious unavailable API');
      if (failure === '500') return response(500, {});
      const broken = clone(fixture);
      if (failure === 'malformed-category') broken[0].category_id = '1';
      else broken[1].id = broken[0].id;
      return response(200, broken);
    } }); await page.ready();
    assert.equal(page.list.children.length, 0); assert.equal(page.ids.get('admin-data').hidden, true);
    assert.equal(page.ids.get('admin-refresh').disabled, false);
    assert.match(page.ids.get('admin-feedback').textContent, /Impossible de charger/);
  });
}
test('story panel announces loading and disables controls until the validated response', async () => {
  const gate = deferred();
  const page = mount({ fetch: async (url, request, state) => { if (url === '/api/v1/stories') await gate.promise; return state.fallback(); } });
  await settle();
  try { assert.equal(page.ids.get('admin-stories').attributes['aria-busy'], 'true');
    assert.equal(page.search.disabled, true); assert.match(page.feedback.textContent, /Chargement/); }
  finally { gate.resolve(); await page.ready(); }
  assert.equal(page.search.disabled, false);
});
for (const staleDenied of [false, true]) {
  test('late story ' + (staleDenied ? 'denial' : 'success') + ' is ignored after cancellation and a newer load', async () => {
    const gate = deferred(); let reads = 0, oldSignal;
    const page = mount({ fetch: async (url, request, state) => {
      if (url === '/api/v1/stories' && ++reads === 1) { oldSignal = request.signal; await gate.promise;
        const old = clone(fixture); old[0].title = 'Stale title'; return response(staleDenied ? 403 : 200, old); }
      return state.fallback();
    } }); await settle();
    try { await page.window.emit('pageshow', { persisted: true });
      assert.equal(oldSignal.aborted, true); gate.resolve(); await page.ready();
      assert.doesNotMatch(page.list.textContent, /Stale title/); assert.equal(page.list.children.length, 4);
      assert.equal(page.ids.get('admin-data').hidden, false); }
    finally { gate.resolve(); await settle(); }
  });
}
test('pagehide aborts pending reads and removes dossiers and user data', async () => {
  const gate = deferred(); let signal;
  const page = mount({ fetch: async (url, request, state) => { if (url === '/api/v1/stories') { signal = request.signal; await gate.promise; } return state.fallback(); } });
  await settle(); await page.window.emit('pagehide');
  assert.equal(signal.aborted, true); gate.resolve(); await settle();
  assert.equal(page.list.children.length, 0); assert.equal(page.ids.get('admin-users-list').children.length, 0);
  assert.equal(page.search.disabled, true); assert.equal(page.ids.get('admin-data').hidden, true);
});
for (const role of [false, 'true', 1, null]) {
  test('ordinary or invalid role ' + role + ' never activates administrative controls', async () => {
    const page = mount({ fetch: async (url, request, state) => url.endsWith('/me') ?
      response(200, { user: { is_admin: role }, csrf_token: 'fictitious-csrf' }) : state.fallback() });
    await page.ready(); assert.equal(page.calls.length, 1); assert.equal(page.list.children.length, 0);
    assert.equal(page.search.disabled, true); assert.equal(page.ids.get('admin-data').hidden, true);
  });
}
test('loss of access during user-list refresh also clears dossier search and results', async () => {
  let denied = false;
  const page = mount({ fetch: async (url, request, state) => denied && url.endsWith('/me') ? response(401, {}) : state.fallback() });
  await page.ready(); await page.query('phare'); denied = true;
  await page.ids.get('admin-users-refresh').emit('click');
  assert.equal(page.list.children.length, 0); assert.equal(page.search.value, ''); assert.equal(page.search.disabled, true);
  assert.equal(page.ids.get('admin-data').hidden, true);
  assert.equal(page.ids.get('admin-pending-proposals-count').textContent, '—');
});
test('filters preserve six counters, user management and source data', async () => {
  const data = clone(fixture); data.forEach(Object.freeze); Object.freeze(data);
  const page = mount({ stories: data }); await page.ready();
  assert.deepEqual(page.counts(), ['4', '2', '1', '3', '7', '2']);
  assert.equal(page.ids.get('admin-pending-proposals-count').textContent, '1');
  await page.select('other'); await page.query('inconnue');
  assert.deepEqual(page.counts(), ['4', '2', '1', '3', '7', '2']);
  const button = page.ids.get('admin-users-list').querySelector('button'); assert.ok(button);
  await button.emit('click');
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(page.calls.filter(call => call.method === 'POST').every(call => call.url === '/api/v1/admin/users/4/ban'));
  assert.match(page.ids.get('admin-users-feedback').textContent, /confirmé/);
  assert.deepEqual(data, fixture); assert.equal(page.list.children.length, 1);
  assert.equal(page.ids.get('admin-pending-proposals-count').textContent, '1');
});
