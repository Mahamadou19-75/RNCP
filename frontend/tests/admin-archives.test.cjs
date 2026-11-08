'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const names = ['api.js', 'app.js', 'admin-users.js', 'admin-stories.js', 'admin-dashboard.js'];
const sources = names.map(name => fs.readFileSync(path.join(root, name), 'utf8'));
const html = fs.readFileSync(path.join(root, 'admin-dashboard.html'), 'utf8');
const response = (status, body) => ({ status, ok: status >= 200 && status < 300,
  async json() { return body; } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function settle() { for (let i = 0; i < 180; i++) await Promise.resolve(); }
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = new Map(); this.attributes = {};
    this.style = {}; this.disabled = false; this.hidden = false; this._text = ''; this.value = '';
    Object.defineProperty(this, 'innerHTML', { get() { throw Error('HTML interdit'); }, set() { throw Error('HTML interdit'); } });
  }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.events.set(name, [...(this.events.get(name) || []), fn]); }
  async emit(name, event = {}) { await Promise.all((this.events.get(name) || []).map(fn => fn({ target: this, ...event }))); }
  focus() { this.focused = true; }
  querySelector(tag) { return this.children.find(node => node.tagName === tag) ||
    this.children.map(node => node.querySelector(tag)).find(Boolean) || null; }
}
function mount(options = {}) {
  const ids = new Map();
  for (const name of ['admin-dashboard', 'admin-data', 'admin-refresh', 'admin-feedback', 'admin-login-link',
    'admin-proposals-list', 'admin-reports-list', 'admin-categories-feedback', 'admin-proposals-feedback',
    'admin-reports-feedback', 'admin-users', 'admin-users-list', 'admin-users-refresh', 'admin-users-feedback',
    'admin-stories', 'admin-stories-list', 'admin-stories-search', 'admin-stories-filter', 'admin-stories-state',
    'admin-stories-other', 'admin-stories-feedback', 'admin-archives-count',
    ...['stories', 'resolved', 'coldcases', 'users', 'comments', 'reports', 'pending-proposals'].map(k => 'admin-' + k + '-count')]) ids.set(name, new Element());
  const window = new Element('window'), calls = [], confirmations = [], timers = new Map();
  let timerId = 0;
  let stories = [
    { id: 1, slug: 'fictitious-one', title: '<img src=x onerror=alert(1)>', summary: 'Summary', content: 'Content', category_id: 1, is_archived: false, archived_at: null },
    { id: 2, slug: 'fictitious-two', title: 'Witness', summary: 'Other', content: 'Other', category_id: 2, is_archived: false, archived_at: null }
  ];
  if (options.archived) stories[0] = { ...stories[0], is_archived: true, archived_at: '2026-10-30T10:00:00' };
  window.confirm = text => { confirmations.push(text); return options.confirm !== false; };
  const defaults = url => {
    if (url.endsWith('/me')) return { user: { id: 3, is_admin: true }, csrf_token: 'fictitious-csrf' };
    if (url.endsWith('/stats')) return { users: 3, comments: 7, reports: 2 };
    if (url === '/api/v1/stories') return stories.filter(row => !row.is_archived);
    if (url.endsWith('/admin/stories?state=archived')) return stories.filter(row => row.is_archived);
    if (url.endsWith('/admin/stories/1')) return { ...stories[0], votes: 1,
      comments: [{ story_id: 1, text: '<script>hostile</script>' }],
      theories: [{ story_id: 1, title: 'Fictitious theory', content: 'Evidence' }],
      updates: [{ story_id: 1, content: 'Update' }] };
    if (url.endsWith('/archive') || url.endsWith('/restore')) {
      const archived = url.endsWith('/archive'); const changed = stories[0].is_archived !== archived;
      stories[0] = { ...stories[0], is_archived: archived, archived_at: archived ? '2026-10-30T10:00:00' : null };
      return { status: 'success', changed, story: stories[0] };
    }
    if (url.endsWith('/proposals')) return [{ id: 1, title: 'Proposal', content: 'Independent', status: 'pending', created_at: null }];
    return [];
  };
  const context = vm.createContext({ AbortController, TextEncoder, Intl, window,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    document: { getElementById: id => ids.get(id) || null, querySelector: () => null, querySelectorAll: () => [],
      createElement: tag => new Element(tag) },
    async fetch(url, request) {
      calls.push({ url, ...request });
      assert.ok(url.startsWith('/api/v1/'));
      assert.equal(request.credentials, 'include');
      if (request.method === 'POST') assert.equal(request.headers['X-CSRF-Token'], 'fictitious-csrf');
      const fallback = () => response(200, JSON.parse(JSON.stringify(defaults(url))));
      return options.fetch ? options.fetch(url, request, { fallback, calls }) : fallback();
    }
  });
  sources.forEach((source, i) => vm.runInContext(source, context, { filename: names[i], timeout: 1000 }));
  return { ids, window, calls, confirmations, timers, context,
    list: ids.get('admin-stories-list'),
    async ready() { await settle(); assert.equal(ids.get('admin-dashboard').attributes['aria-busy'], 'false'); },
    async select(value) { ids.get('admin-stories-state').value = value; await ids.get('admin-stories-state').emit('change'); },
    action() { return ids.get('admin-stories-list').children[0].children.find(node => node.tagName === 'button' && /^(Archiver|Restaurer)$/.test(node.textContent)); },
    posts() { return calls.filter(call => call.method === 'POST'); },
    count(name) { return ids.get('admin-' + name + '-count').textContent; }
  };
}

test('archive controls are labelled native buttons and preserve responsive cards', () => {
  assert.match(html, /for="admin-stories-state"/);
  assert.match(html, /id="admin-stories-state"[^>]*disabled/);
  assert.match(html, /id="admin-archives-count"[^>]*role="status"/);
  assert.match(html, /id="admin-stories-list" class="cards"/);
});
test('cancel confirmation sends no write and preserves focusable original action', async () => {
  const page = mount({ confirm: false }); await page.ready(); const action = page.action();
  await action.emit('click');
  assert.equal(page.posts().length, 0); assert.equal(page.action(), action);
  assert.match(page.confirmations[0], /masqué.*contributions et signalements seront conservés/);
});
test('archive re-reads state, keeps seven counters coherent and exposes private archive', async () => {
  const page = mount(); await page.ready(); await page.action().emit('click');
  assert.equal(page.posts().length, 1); assert.match(page.posts()[0].url, /\/1\/archive$/);
  assert.equal(page.count('stories'), '1'); assert.equal(page.count('resolved'), '0');
  assert.equal(page.count('coldcases'), '1'); assert.equal(page.count('comments'), '7');
  assert.equal(page.count('reports'), '2'); assert.equal(page.count('users'), '3');
  assert.equal(page.count('pending-proposals'), '1');
  assert.equal(page.ids.get('admin-archives-count').textContent, 'Archives : 1');
  assert.match(page.ids.get('admin-feedback').textContent, /État relu.*archivé/);
  assert.equal(page.ids.get('admin-refresh').focused, true);
  await page.select('archived'); assert.equal(page.action().textContent, 'Restaurer');
  assert.equal(page.list.children[0].querySelector('a'), null);
});
test('restore republishes the original story and recomputes active category counts', async () => {
  const page = mount({ archived: true }); await page.ready(); await page.select('archived');
  await page.action().emit('click');
  assert.match(page.posts()[0].url, /\/1\/restore$/);
  assert.equal(page.count('stories'), '2'); assert.equal(page.count('resolved'), '1');
  assert.equal(page.ids.get('admin-archives-count').textContent, 'Archives : 0');
  assert.match(page.ids.get('admin-feedback').textContent, /État relu.*actif/);
});
test('archived content and contributions are read privately and rendered as text', async () => {
  const page = mount({ archived: true }); await page.ready(); await page.select('archived');
  await page.list.children[0].querySelector('button').emit('click');
  assert.match(page.list.textContent, /<script>hostile<\/script>.*Théorie|Théorie.*<script>hostile<\/script>/);
  assert.match(page.list.textContent, /Votes conservés : 1.*Evidence.*Update/);
  assert.ok(page.calls.some(call => call.url === '/api/v1/admin/stories/1'));
});
test('double submission stays locked through write and global re-read', async () => {
  const gate = deferred(); const readGate = deferred(); let posted = false;
  const page = mount({ fetch: async (url, req, state) => {
    if (req.method === 'POST') { posted = true; await gate.promise; }
    else if (posted) await readGate.promise;
    return state.fallback();
  } }); await page.ready(); const old = page.action();
  const first = old.emit('click'); await settle(); await old.emit('click');
  assert.equal(page.posts().length, 1); assert.equal(page.action().disabled, true);
  gate.resolve(); await settle(); await old.emit('click'); assert.equal(page.posts().length, 1);
  readGate.resolve(); await first; assert.equal(page.posts().length, 1);
});
for (const failure of ['network-before-commit', 'network-after-commit', '500', 'invalid-json', 'invalid-state', 'wrong-id']) {
  test('uncertain write ' + failure + ' reads server state without retry', async () => {
    const page = mount({ fetch: async (url, req, state) => {
      if (req.method !== 'POST') return state.fallback();
      if (failure === 'network-before-commit') throw TypeError('offline');
      const result = state.fallback();
      if (failure === 'network-after-commit') throw TypeError('response lost');
      if (failure === '500') return response(500, {});
      if (failure === 'invalid-json') return { status: 200, ok: true, async json() { throw new SyntaxError('bad'); } };
      const data = await result.json();
      if (failure === 'invalid-state') data.story.archived_at = null;
      if (failure === 'wrong-id') data.story.id = 99;
      return response(200, data);
    } }); await page.ready(); await page.action().emit('click');
    assert.equal(page.posts().length, 1);
    assert.match(page.ids.get('admin-feedback').textContent, /incertaine.*État relu/);
    assert.equal(page.count('stories'), failure === 'network-before-commit' ? '2' : '1');
  });
}
test('timeout after commit re-reads the server without reporting assumed success', async () => {
  const page = mount({ fetch: async (url, req, state) => {
    if (req.method !== 'POST') return state.fallback();
    state.fallback();
    return new Promise((resolve, reject) => req.signal.addEventListener('abort', () => reject(Error('aborted'))));
  } }); await page.ready(); const running = page.action().emit('click'); await settle();
  assert.equal(page.timers.size, 1); [...page.timers.values()][0](); await running;
  assert.equal(page.count('stories'), '1'); assert.equal(page.posts().length, 1);
  assert.match(page.ids.get('admin-feedback').textContent, /incertaine.*État relu/);
});
test('failed state re-read clears lists and all seven counts without enabling stale actions', async () => {
  let posted = false;
  const page = mount({ fetch: async (url, req, state) => {
    if (req.method === 'POST') { posted = true; state.fallback(); throw TypeError('lost'); }
    if (posted && url === '/api/v1/stories') return response(500, {});
    return state.fallback();
  } }); await page.ready(); await page.action().emit('click');
  assert.equal(page.list.children.length, 0); assert.equal(page.ids.get('admin-data').hidden, true);
  for (const key of ['stories', 'resolved', 'coldcases', 'users', 'comments', 'reports', 'pending-proposals']) assert.equal(page.count(key), '—');
  assert.match(page.ids.get('admin-feedback').textContent, /État du dossier non vérifié/);
});
for (const status of [401, 403]) {
  test('write access denial ' + status + ' clears archives and active data', async () => {
    const page = mount({ fetch: async (url, req, state) => req.method === 'POST' ? response(status, {}) : state.fallback() });
    await page.ready(); await page.action().emit('click');
    assert.equal(page.ids.get('admin-data').hidden, true); assert.equal(page.list.children.length, 0);
    assert.equal(page.count('stories'), '—');
  });
}
for (const denied of [false, true]) {
  test('stale write ' + (denied ? 'denial' : 'success') + ' cannot overwrite newer dashboard state', async () => {
    const gate = deferred();
    const page = mount({ fetch: async (url, req, state) => {
      if (req.method === 'POST') { await gate.promise; return denied ? response(403, {}) : state.fallback(); }
      return state.fallback();
    } }); await page.ready(); const running = page.action().emit('click'); await settle();
    await page.window.emit('pagehide'); await page.window.emit('pageshow', { persisted: true });
    gate.resolve(); await running; await settle();
    assert.equal(page.ids.get('admin-data').hidden, false); assert.equal(page.count('stories'), '2');
    assert.doesNotMatch(page.ids.get('admin-feedback').textContent, /refusé|État relu/);
    assert.equal(page.posts().length, 1);
  });
}
test('active plus archive overlap from concurrent reads is rejected before actions are displayed', async () => {
  const page = mount({ fetch: async (url, req, state) => {
    const result = state.fallback();
    if (!url.endsWith('?state=archived')) return result;
    return response(200, [{ id: 1, category_id: 1, slug: 'fictitious-one', title: 'Duplicate',
      summary: 'Summary', content: 'Content', is_archived: true, archived_at: '2026-10-30T10:00:00' }]);
  } }); await page.ready(); assert.equal(page.list.children.length, 0);
  assert.equal(page.count('stories'), '—'); assert.equal(page.ids.get('admin-data').hidden, true);
});
test('private archive denial during load prevents activation of management controls', async () => {
  const page = mount({ fetch: async (url, req, state) => url.endsWith('?state=archived') ? response(403, {}) : state.fallback() });
  await page.ready(); assert.equal(page.list.children.length, 0); assert.equal(page.ids.get('admin-data').hidden, true);
});
