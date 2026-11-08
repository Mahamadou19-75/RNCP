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
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
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
  let timerId = 0; let purged = false;
  let stories = [
    { id: 1, slug: 'fictitious-one', title: '<img src=x onerror=alert(1)>', summary: 'Summary', content: 'Content', category_id: 1, management_revision: 'a'.repeat(32), is_archived: false, archived_at: null },
    { id: 2, slug: 'fictitious-two', title: 'Witness', summary: 'Other', content: 'Other', category_id: 2, management_revision: 'b'.repeat(32), is_archived: false, archived_at: null }
  ];
  if (options.archived) stories[0] = { ...stories[0], is_archived: true, archived_at: '2026-10-30T10:00:00' };
  window.confirm = text => { confirmations.push(text); return options.confirm !== false; };
  const defaults = (url, request) => {
    if (url.endsWith('/me')) return { user: { id: 3, is_admin: true }, csrf_token: 'fictitious-csrf' };
    if (url.endsWith('/stats')) return { users: 3, comments: purged ? 6 : 7, reports: purged ? 0 : 2 };
    if (url === '/api/v1/stories') return stories.filter(row => !row.is_archived);
    if (url.endsWith('/admin/stories?state=archived')) return stories.filter(row => row.is_archived);
    if (url.endsWith('/deletion-preview')) return { story: stories.find(row => row.id === 1), impact: {comments:1,theories:1,votes:1,updates:1,reports:2}, resource_etag: '\"'+'c'.repeat(64)+'\"', preview_token:'preview', expires_at:'2026-10-31T12:05:00Z' };
    if (url.endsWith('/deletion-confirmations')) return {status:'success',confirmation_token:'final',expires_at:'2026-10-31T12:05:00Z'};
    if (url.endsWith('/admin/stories/1') && request.method === 'DELETE') {
      purged = true; stories = stories.filter(row => row.id !== 1);
      return {status:'success',code:'STORY_DELETED',deleted_story:{id:1,management_revision:'a'.repeat(32)},deleted_counts:{comments:1,theories:1,votes:1,updates:1,reports:2}};
    }
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
      const fallback = () => url.endsWith('/admin/stories/1') && request.method !== 'DELETE' && !stories.some(row => row.id === 1) ? response(404, {status:'error',message:'Not found'}) : response(200, JSON.parse(JSON.stringify(defaults(url, request))));
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
    deletes() { return calls.filter(call => call.method === 'DELETE'); },
    dialog() { return ids.get('admin-stories').children.find(node => node.tagName === 'dialog' && !node.removed); },
    permanent() { return ids.get('admin-stories-list').children[0]?.children.find(node => node.tagName === 'button' && node.textContent === 'Supprimer d\u00e9finitivement'); },
    count(name) { return ids.get('admin-' + name + '-count').textContent; }
  };
}


function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function field(page, id) { return descendants(page.dialog()).find(node => node.id === id); }
function confirmButton(page) { return page.dialog().children.find(node => node.tagName === 'button' && node.textContent.startsWith('Supprimer')); }
async function open(page) { await page.ready(); await page.select('archived'); const running = page.permanent().emit('click'); await settle(); assert.ok(page.dialog()); return { running }; }
async function fill(page) { const input=field(page,'story-deletion-title-input'); input.value=page.list.children[0].querySelector('h3').textContent; await input.emit('input'); const check=field(page,'story-deletion-ack'); check.checked=true; await check.emit('change'); }

test('permanent deletion exists only on archived cards', async () => {
  const page = mount({ archived: true }); await page.ready();
  assert.equal(page.permanent(), undefined);
  await page.select('archived'); assert.ok(page.permanent());
});
test('cancel performs only an immutable preview and returns focus', async () => {
  const page = mount({ archived: true }); const { running } = await open(page);
  assert.equal(page.dialog().open, true);
  await page.dialog().children.find(node => node.tagName === 'button' && node.textContent === 'Annuler').emit('click');
  await running;
  assert.equal(page.posts().length, 0); assert.equal(page.deletes().length, 0);
  assert.equal(page.permanent().focused, true);
});
test('Escape cancels without confirmation or DELETE', async () => {
  const page = mount({ archived: true }); const { running } = await open(page);
  let prevented = false;
  await page.dialog().emit('cancel', { preventDefault() { prevented = true; } }); await running;
  assert.equal(prevented, true); assert.equal(page.posts().length, 0); assert.equal(page.deletes().length, 0);
});
test('exact title and explicit contribution acknowledgement are both required', async () => {
  const page = mount({ archived: true }); const { running } = await open(page);
  const input = field(page, 'story-deletion-title-input'); const check = field(page, 'story-deletion-ack');
  assert.equal(confirmButton(page).disabled, true);
  input.value = 'Wrong'; check.checked = true; await input.emit('input');
  assert.equal(confirmButton(page).disabled, true);
  await confirmButton(page).emit('click'); assert.equal(page.posts().length, 0);
  await fill(page); assert.equal(confirmButton(page).disabled, false);
  await confirmButton(page).emit('click'); await running;
  assert.equal(page.posts().length, 1); assert.equal(page.deletes().length, 1);
});
test('success sends CSRF and exact conditional headers, re-reads and updates global counts', async () => {
  const page = mount({ archived: true }); const { running } = await open(page);
  assert.match(page.dialog().textContent, /irréversible.*Signalements : 2/);
  assert.match(page.dialog().textContent, /<img src=x onerror=alert\(1\)>/);
  await fill(page); await confirmButton(page).emit('click'); await running;
  const request = page.deletes()[0];
  assert.equal(request.headers['X-CSRF-Token'], 'fictitious-csrf');
  assert.equal(request.headers['X-Deletion-Confirmation'], 'final');
  assert.equal(request.headers['If-Match'], '"'+'c'.repeat(64)+'"');
  assert.equal(request.body, undefined); assert.equal(request.conditionalHeaders, undefined);
  assert.ok(page.calls.some(call => call.url === '/api/v1/admin/stories/1' && !call.method));
  assert.equal(page.count('stories'), '1'); assert.equal(page.count('resolved'), '0');
  assert.equal(page.count('coldcases'), '1'); assert.equal(page.count('users'), '3');
  assert.equal(page.count('comments'), '6'); assert.equal(page.count('reports'), '0');
  assert.equal(page.count('pending-proposals'), '1');
  assert.equal(page.ids.get('admin-archives-count').textContent, 'Archives : 0');
  assert.match(page.ids.get('admin-feedback').textContent, /Suppression confirmée/);
});
test('confirmation error sends no DELETE and remains visible after controls are rebuilt', async () => {
  const page = mount({ archived: true, fetch: async (url, req, state) => url.endsWith('/deletion-confirmations') ? response(412, {}) : state.fallback() });
  const { running } = await open(page); await fill(page); await confirmButton(page).emit('click'); await running;
  assert.equal(page.deletes().length, 0); assert.match(page.ids.get('admin-stories-feedback').textContent, /Suppression non envoyée/);
});
test('double submission stays locked before confirmation and throughout DELETE', async () => {
  const gate = deferred();
  const page = mount({ archived: true, fetch: async (url, req, state) => { if (req.method === 'DELETE') await gate.promise; return state.fallback(); } });
  await page.ready(); await page.select('archived'); const old = page.permanent();
  const running = old.emit('click'); await settle(); await old.emit('click');
  assert.ok(page.dialog()); await fill(page); const submit = confirmButton(page);
  await submit.emit('click'); await submit.emit('click'); await settle(); await old.emit('click');
  assert.equal(page.posts().length, 1); assert.equal(page.deletes().length, 1);
  gate.resolve(); await running; assert.equal(page.deletes().length, 1);
});
for (const failure of ['before-commit', 'after-commit', '500', 'invalid-json', 'wrong-response']) {
  test('uncertain DELETE ' + failure + ' reads state without a second deletion', async () => {
    const page = mount({ archived: true, fetch: async (url, req, state) => {
      if (req.method !== 'DELETE') return state.fallback();
      if (failure === 'before-commit') throw TypeError('offline');
      const result = state.fallback();
      if (failure === 'after-commit') throw TypeError('lost response');
      if (failure === '500') return response(500, {});
      if (failure === 'invalid-json') return {status:200,ok:true,async json(){ throw new SyntaxError('invalid'); }};
      return response(200, {status:'success', code:'WRONG'});
    } });
    const { running } = await open(page); await fill(page); await confirmButton(page).emit('click'); await running;
    assert.equal(page.deletes().length, 1); assert.match(page.ids.get('admin-feedback').textContent, /incertaine.*Sans journal persistant/);
    assert.match(page.ids.get('admin-feedback').textContent, failure === 'before-commit' ? /dossier présent/ : /dossier absent/);
  });
}
test('timeout after commit re-reads absent target without attributing success', async () => {
  const page = mount({ archived: true, fetch: async (url, req, state) => {
    if (req.method !== 'DELETE') return state.fallback();
    state.fallback();
    return new Promise((resolve, reject) => req.signal.addEventListener('abort', () => reject(Error('timeout'))));
  } });
  const { running } = await open(page); await fill(page); await confirmButton(page).emit('click'); await settle();
  assert.equal(page.timers.size, 1); [...page.timers.values()][0](); await running;
  assert.equal(page.deletes().length, 1); assert.match(page.ids.get('admin-feedback').textContent, /incertaine.*dossier absent/);
});
test('lost response and failed re-read clear actions and keep unknown counters', async () => {
  let sent = false;
  const page = mount({ archived: true, fetch: async (url, req, state) => {
    if (req.method === 'DELETE') { sent = true; state.fallback(); throw TypeError('lost'); }
    if (sent && (url.endsWith('/admin/stories/1') || url === '/api/v1/stories')) return response(503, {});
    return state.fallback();
  } });
  const { running } = await open(page); await fill(page); await confirmButton(page).emit('click'); await running;
  assert.equal(page.deletes().length, 1); assert.equal(page.ids.get('admin-data').hidden, true);
  assert.equal(page.count('stories'), '—'); assert.equal(page.list.children.length, 0);
  assert.match(page.ids.get('admin-feedback').textContent, /non vérifié/);
});
test('known success remains distinct from failed statistics refresh', async () => {
  let sent = false;
  const page = mount({ archived: true, fetch: async (url, req, state) => {
    if (req.method === 'DELETE') { sent = true; return state.fallback(); }
    if (sent && url.endsWith('/stats')) return response(500, {});
    return state.fallback();
  } });
  const { running } = await open(page); await fill(page); await confirmButton(page).emit('click'); await running;
  assert.match(page.ids.get('admin-feedback').textContent, /Suppression confirmée.*indisponible/);
  assert.equal(page.count('stories'), '—');
});
for (const status of [401, 403]) {
  test('current DELETE denial ' + status + ' removes protected data', async () => {
    const page = mount({ archived: true, fetch: async (url, req, state) => req.method === 'DELETE' ? response(status, {}) : state.fallback() });
    const { running } = await open(page); await fill(page); await confirmButton(page).emit('click'); await running;
    assert.equal(page.ids.get('admin-data').hidden, true); assert.equal(page.list.children.length, 0);
    assert.equal(page.deletes().length, 1);
  });
}
for (const denial of [false, true]) {
  test('late DELETE ' + (denial ? 'denial' : 'success') + ' cannot overwrite a new dashboard', async () => {
    const gate = deferred();
    const page = mount({ archived: true, fetch: async (url, req, state) => {
      if (req.method === 'DELETE') { await gate.promise; return denial ? response(403, {}) : state.fallback(); }
      return state.fallback();
    } });
    const { running } = await open(page); await fill(page); await confirmButton(page).emit('click'); await settle();
    await page.window.emit('pagehide'); await page.window.emit('pageshow', {persisted:true});
    gate.resolve(); await running;
    assert.equal(page.ids.get('admin-data').hidden, false); assert.equal(page.count('stories'), '1');
    assert.doesNotMatch(page.ids.get('admin-feedback').textContent, /refusé|Suppression confirmée/);
  });
}
test('pagehide closes pending dialog with no destructive request', async () => {
  const page = mount({ archived: true }); const { running } = await open(page);
  await page.window.emit('pagehide'); await running;
  assert.equal(page.deletes().length, 0); assert.equal(page.posts().length, 0);
  assert.equal(page.ids.get('admin-data').hidden, true);
});
test('invalid preview prevents confirmation and DELETE', async () => {
  const page = mount({ archived: true, fetch: async (url, req, state) => {
    if (!url.endsWith('/deletion-preview')) return state.fallback();
    const value = await state.fallback().json(); value.story.management_revision = '0'.repeat(32); return response(200, value);
  } });
  await page.ready(); await page.select('archived'); await page.permanent().emit('click');
  assert.equal(page.dialog(), undefined); assert.equal(page.posts().length, 0); assert.equal(page.deletes().length, 0);
});
test('conditional header whitelist cannot replace CSRF', async () => {
  const page = mount({ archived: true }); await page.ready(); const count = page.calls.length;
  await assert.rejects(vm.runInContext("apiRequest('/admin/stories/1', {method:'DELETE', conditionalHeaders:{'X-CSRF-Token':'forged'}})", page.context));
  assert.equal(page.calls.length, count);
});
