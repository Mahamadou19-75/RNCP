'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const sources = Object.fromEntries(['api.js', 'app.js', 'admin-users.js', 'admin-dashboard.js']
  .map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
const html = fs.readFileSync(path.join(root, 'admin-dashboard.html'), 'utf8');
const response = (status, body) => ({ status, ok: status >= 200 && status < 300,
  async json() { return body; } });
const user = (changes = {}) => ({ id: 4, username: 'Fictitious reader', is_admin: false,
  is_banned: false, email: 'private@example.invalid', ...changes });
const initialUsers = () => [user({ id: 3, username: 'Admin', is_admin: true }), user(),
  user({ id: 2, username: 'Already banned', is_banned: true })];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 120; i++) await Promise.resolve(); }

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = new Map(); this.attributes = {};
    this.style = {}; this.disabled = false; this.hidden = false; this._text = '';
    Object.defineProperty(this, 'innerHTML', { set() { throw new Error('HTML parsing forbidden'); },
      get() { throw new Error('HTML parsing forbidden'); } });
  }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { const events = this.events.get(name) || []; events.push(fn); this.events.set(name, events); }
  async emit(name, event = {}) { await Promise.all((this.events.get(name) || []).map(fn => fn({ target: this, ...event }))); }
  querySelector(tag) {
    for (const child of this.children) { if (child.tagName === tag) return child;
      const node = child.querySelector(tag); if (node) return node; }
    return null;
  }
}

function mount(options = {}) {
  const ids = new Map();
  for (const name of ['admin-dashboard', 'admin-data', 'admin-refresh', 'admin-feedback', 'admin-login-link',
    'admin-proposals-list', 'admin-reports-list', 'admin-categories-feedback', 'admin-proposals-feedback',
    'admin-reports-feedback', 'admin-users', 'admin-users-refresh', 'admin-users-list', 'admin-users-feedback',
    ...['stories', 'resolved', 'coldcases', 'users', 'comments', 'reports', 'pending-proposals'].map(name => 'admin-' + name + '-count')]) ids.set(name, new Element());
  const window = new Element('window'), calls = [], confirmations = [], tags = [], timers = new Map();
  let timerId = 0;
  let users = options.users || initialUsers();
  window.confirm = text => { confirmations.push(text); return options.confirm !== false; };
  const defaults = url => {
    if (url.endsWith('/me')) return { user: { id: 3, is_admin: true }, csrf_token: 'fictitious-csrf' };
    if (url.endsWith('/stats')) return { users: 3, comments: 7, reports: 2 };
    if (url.endsWith('/stories')) return [{ id: 1, category_id: 1, title: 'Fictitious', slug: 'fictitious', summary: 'Summary', content: 'Content' }];
    if (url.endsWith('/users')) return users;
    if (url.endsWith('/ban')) {
      users = users.map(item => item.id === 4 ? { ...item, is_banned: true } : item);
      return { status: 'success', user: users.find(item => item.id === 4) };
    }
    return [];
  };
  const context = vm.createContext({ AbortController, TextEncoder, Intl, window,
    setTimeout: options.manualTimers ? fn => { timers.set(++timerId, fn); return timerId; } : setTimeout,
    clearTimeout: options.manualTimers ? id => timers.delete(id) : clearTimeout,
    document: { getElementById: name => ids.get(name) || null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement(tag) { tags.push(tag); return new Element(tag); } },
    async fetch(url, request) {
      assert.ok(['/api/v1/me', '/api/v1/stats', '/api/v1/stories', '/api/v1/proposals',
        '/api/v1/admin/stories?state=archived', '/api/v1/admin/reports', '/api/v1/users', '/api/v1/admin/users/4/ban'].includes(url));
      const method = request.method || 'GET';
      assert.equal(method, url.endsWith('/ban') ? 'POST' : 'GET');
      assert.equal(request.credentials, 'include');
      assert.equal(request.body, undefined);
      if (method === 'POST') assert.equal(request.headers['X-CSRF-Token'], 'fictitious-csrf');
      calls.push({ url, ...request });
      const fallback = () => response(200, defaults(url));
      if (options.fetch) return options.fetch(url, request, { fallback, calls,
        setUsers(value) { users = value; } });
      return fallback();
    }
  });
  for (const name of Object.keys(sources)) {
    if (options.skipDashboard && name === 'admin-dashboard.js') continue;
    vm.runInContext(sources[name], context, { filename: name, timeout: 1000 });
  }
  return { ids, context, window, calls, confirmations, tags, timers,
    list: ids.get('admin-users-list'), feedback: ids.get('admin-users-feedback'),
    async ready() { await settle(); assert.equal(ids.get('admin-dashboard').attributes['aria-busy'], 'false'); },
    button() { return ids.get('admin-users-list').children.find(card => card.querySelector('button'))?.querySelector('button'); },
    refresh() { return ids.get('admin-users-refresh').emit('click'); },
    posts() { return calls.filter(call => call.method === 'POST'); },
    reads() { return calls.filter(call => call.url === '/api/v1/users'); }
  };
}

test('HTML keeps the six counters and loads the users panel before the dashboard', () => {
  for (const id of ['admin-users', 'admin-users-list', 'admin-users-feedback', 'admin-users-refresh']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.ok(html.indexOf('src="admin-users.js"') < html.indexOf('src="admin-dashboard.js"'));
  for (const name of ['stories', 'resolved', 'coldcases', 'users', 'comments', 'reports']) assert.match(html, new RegExp('admin-' + name + '-count'));
});

test('admin sees role/status and only an eligible user has a ban button', async () => {
  const page = mount(); await page.ready();
  assert.equal(page.list.children.length, 3);
  assert.equal(page.list.children.filter(card => card.querySelector('button')).length, 1);
  assert.match(page.list.textContent, /Administrateur.*Actif.*protégé/);
  assert.match(page.list.textContent, /Already banned.*Banni/);
  assert.doesNotMatch(page.list.textContent, /private@example.invalid/);
  assert.equal(page.ids.get('admin-comments-count').textContent, '7');
  assert.equal(page.ids.get('admin-reports-count').textContent, '2');
});

for (const status of [401, 403]) {
  test('user-list access denial ' + status + ' clears every private section', async () => {
    const page = mount({ fetch: async (url, request, state) => url === '/api/v1/users' ? response(status, {}) : state.fallback() });
    await page.ready();
    assert.equal(page.ids.get('admin-data').hidden, true);
    assert.equal(page.list.children.length, 0);
    assert.equal(page.ids.get('admin-comments-count').textContent, '—');
  });
}

for (const role of [false, 'true', 1]) {
  test('non-admin role ' + role + ' never reaches the users API', async () => {
    const page = mount({ fetch: async (url, request, state) => url.endsWith('/me') ?
      response(200, { user: { is_admin: role }, csrf_token: 'fictitious-csrf' }) : state.fallback() });
    await page.ready(); assert.equal(page.reads().length, 0); assert.equal(page.list.children.length, 0);
  });
}

test('confirmation cancellation sends no POST and leaves the user unchanged', async () => {
  const page = mount({ confirm: false }); await page.ready();
  await page.button().emit('click');
  assert.equal(page.posts().length, 0);
  assert.equal(page.reads().length, 1);
  assert.match(page.confirmations[0], /Fictitious reader.*contributions seront conservés/);
});

test('ban success is re-read from server and removes the eligible button', async () => {
  const page = mount(); await page.ready();
  await page.button().emit('click');
  assert.equal(page.posts().length, 1);
  assert.equal(page.reads().length, 2);
  assert.equal(page.button(), undefined);
  assert.match(page.feedback.textContent, /confirmé.*État relu/);
});

test('double click while the POST is pending cannot send a second action', async () => {
  const gate = deferred();
  const page = mount({ fetch: async (url, request, state) => {
    if (url.endsWith('/ban')) await gate.promise;
    return state.fallback();
  } }); await page.ready();
  const button = page.button(); const pending = button.emit('click'); await settle();
  try {
    await button.emit('click'); assert.equal(page.posts().length, 1);
    assert.equal(page.ids.get('admin-users-refresh').disabled, true);
    assert.equal(page.ids.get('admin-users').attributes['aria-busy'], 'true');
  } finally { gate.resolve(); await pending; }
});

for (const status of [409, 404]) {
  test('business refusal ' + status + ' reloads users without blocking the admin', async () => {
    const page = mount({ fetch: async (url, request, state) => {
      if (url.endsWith('/ban')) {
        state.setUsers(status === 409 ? [user({ id: 4, is_admin: true })] : []);
        return response(status, { status: 'error', message: 'Fictitious refusal' });
      }
      return state.fallback();
    } }); await page.ready(); await page.button().emit('click');
    assert.equal(page.ids.get('admin-data').hidden, false);
    assert.equal(page.posts().length, 1); assert.equal(page.reads().length, 2);
    assert.equal(page.button(), undefined);
    assert.match(page.feedback.textContent, status === 409 ? /protégé/ : /n’existe plus/);
  });
}

for (const status of [401, 403]) {
  test('ban access denial ' + status + ' clears the old account list', async () => {
    const page = mount({ fetch: async (url, request, state) => url.endsWith('/ban') ? response(status, {}) : state.fallback() });
    await page.ready(); await page.button().emit('click');
    assert.equal(page.ids.get('admin-data').hidden, true);
    assert.equal(page.list.children.length, 0); assert.equal(page.reads().length, 1);
  });
}

for (const failure of ['network', 'http500', 'invalid-json', 'wrong-user', 'not-banned']) {
  test('uncertain ' + failure + ' response causes a GET, never a POST retry', async () => {
    const page = mount({ fetch: async (url, request, state) => {
      if (url.endsWith('/ban')) {
        state.setUsers([user({ is_banned: true })]);
        if (failure === 'network') throw new TypeError('Fictitious network error');
        if (failure === 'http500') return response(500, {});
        if (failure === 'invalid-json') return { status: 200, ok: true, async json() { throw new SyntaxError('Invalid JSON'); } };
        return response(200, { status: 'success', user: user(failure === 'wrong-user' ? { id: 42, is_banned: true } : {}) });
      }
      return state.fallback();
    } }); await page.ready(); await page.button().emit('click');
    assert.equal(page.posts().length, 1); assert.equal(page.reads().length, 2);
    assert.equal(page.button(), undefined); assert.match(page.feedback.textContent, /incertaine/);
  });
}

test('timeout after a simulated commit re-reads the banned status without retry', async () => {
  const page = mount({ manualTimers: true, fetch: async (url, request, state) => {
    if (!url.endsWith('/ban')) return state.fallback();
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => {
      state.setUsers([user({ is_banned: true })]);
      reject(new Error('Aborted after fictitious commit'));
    }, { once: true }));
  } }); await page.ready();
  const pending = page.button().emit('click'); await settle();
  assert.equal(page.timers.size, 1);
  [...page.timers.values()][0](); await pending;
  assert.equal(page.posts().length, 1); assert.equal(page.reads().length, 2);
  assert.equal(page.button(), undefined); assert.match(page.feedback.textContent, /incertaine/);
});

test('failed reconciliation leaves no actionable stale card and allows explicit refresh', async () => {
  let reads = 0;
  const page = mount({ fetch: async (url, request, state) => {
    if (url === '/api/v1/users' && ++reads === 2) throw new TypeError('Fictitious unavailable list');
    return state.fallback();
  } }); await page.ready(); await page.button().emit('click');
  assert.equal(page.list.children.length, 0);
  assert.match(page.feedback.textContent, /non vérifié/);
  assert.equal(page.ids.get('admin-users-refresh').disabled, false);
  await page.refresh(); assert.match(page.list.textContent, /Banni/);
});

test('pagehide cancels a pending write and a late response cannot restore private data', async () => {
  const gate = deferred();
  const page = mount({ fetch: async (url, request, state) => {
    if (url.endsWith('/ban')) await gate.promise;
    return state.fallback();
  } }); await page.ready();
  const pending = page.button().emit('click'); await settle();
  await page.window.emit('pagehide');
  assert.equal(page.list.children.length, 0);
  gate.resolve(); await pending;
  assert.equal(page.list.children.length, 0); assert.equal(page.ids.get('admin-data').hidden, true);
  assert.equal(page.reads().length, 1);
});

for (const denied of [false, true]) {
  test('late user-list ' + (denied ? 'denial' : 'success') + ' cannot overwrite a newer page', async () => {
    const gate = deferred(); let reads = 0;
    const page = mount({ fetch: async (url, request, state) => {
      if (url === '/api/v1/users' && ++reads === 1) {
        await gate.promise;
        return response(denied ? 403 : 200, [user({ username: 'Stale private user' })]);
      }
      return state.fallback();
    } }); await settle();
    try {
      await page.window.emit('pageshow', { persisted: true });
      assert.equal(page.ids.get('admin-data').hidden, false);
      gate.resolve(); await page.ready();
      assert.doesNotMatch(page.list.textContent, /Stale private user/);
      assert.equal(page.ids.get('admin-data').hidden, false);
    } finally { gate.resolve(); await settle(); }
});
}

test('usernames are rendered as text, without email or HTML execution', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const page = mount({ users: [user({ username: attack })] }); await page.ready();
  assert.equal(page.list.querySelector('h3').textContent, attack);
  assert.ok(!page.tags.some(tag => ['img', 'script'].includes(tag)));
  assert.doesNotMatch(page.list.textContent, /private@example.invalid/);
});

for (const invalid of [null, {}, [user({ is_banned: 'false' })], [user({ is_admin: 'true' })],
  [user({ id: 0 })], [user(), user()]]) {
  test('malformed users are rejected: ' + JSON.stringify(invalid), async () => {
    const page = mount({ fetch: async (url, request, state) => url === '/api/v1/users' ? response(200, invalid) : state.fallback() });
    await page.ready(); assert.equal(page.list.children.length, 0);
    assert.match(page.feedback.textContent, /Impossible de charger/);
    assert.equal(page.ids.get('admin-data').hidden, false);
  });
}

test('invalid ids are rejected before any ban request', async () => {
  const page = mount({ skipDashboard: true });
  for (const id of [0, -1, 1.5, '4', 2147483648]) await assert.rejects(page.context.banAdminUser(id));
  assert.equal(page.posts().length, 0);
});
