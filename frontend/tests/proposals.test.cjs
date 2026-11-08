'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const { TextEncoder } = require('node:util');

const frontend = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(frontend, 'api.js'), 'utf8');
const appSource = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(frontend, 'proposer-histoire.html'), 'utf8');

function response(status, body, invalidJson = false) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (invalidJson) throw new SyntaxError('Invalid synthetic JSON');
      return body;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function mount(options = {}) {
  const feedback = { textContent: '' };
  const button = { disabled: false };
  const initial = { title: '', category: 'Histoire', content: '' };
  const elements = Object.fromEntries(Object.entries(initial).map(([name, value]) => [
    name, { value, disabled: false }
  ]));
  const handlers = [];
  const attributes = {};
  let resets = 0;
  const form = {
    elements,
    addEventListener(name, handler) { if (name === 'submit') handlers.push(handler); },
    querySelector(selector) {
      return selector === '.feedback' ? feedback : selector === 'button' ? button : null;
    },
    setAttribute(name, value) { attributes[name] = value; },
    reset() {
      resets += 1;
      for (const [name, value] of Object.entries(initial)) elements[name].value = value;
    }
  };
  const calls = [];
  const csrf = randomBytes(24).toString('hex');
  const context = vm.createContext({
    AbortController, TextEncoder, setTimeout, clearTimeout,
    document: {
      querySelector: () => null,
      querySelectorAll(selector) {
        return selector.includes('.demo-form') && !selector.includes(':not(#proposal-form)') ? [form] : [];
      },
      getElementById: id => id === 'proposal-form' ? form : null
    },
    async fetch(url, request) {
      if (!['/api/v1/me', '/api/v1/proposals'].includes(url)) {
        throw new Error('NETWORK_FORBIDDEN');
      }
      calls.push({ url, ...request });
      if (options.fetch) return options.fetch(url, request, csrf);
      if (url === '/api/v1/me') {
        if (options.meNetworkError) throw new TypeError('Synthetic offline network failure');
        return response(options.meStatus || 200,
          options.meBody === undefined ? { csrf_token: csrf } : options.meBody);
      }
      if (options.postNetworkError) throw new TypeError('Synthetic offline network failure');
      return response(options.postStatus || 201,
        options.postBody || { status: 'success', proposal: { id: 1, status: 'pending' } },
        options.invalidPostJson);
    }
  });
  vm.runInContext(apiSource, context, { filename: 'frontend/api.js', timeout: 1000 });
  vm.runInContext(appSource, context, { filename: 'frontend/app.js', timeout: 1000 });
  return {
    calls, elements, feedback, button, attributes, csrf,
    get resets() { return resets; },
    get listenerCount() { return handlers.length; },
    fill(values = {}) {
      const supplied = { title: ' Une proposition ', category: 'Histoire', content: ' Des indices ', ...values };
      for (const [name, value] of Object.entries(supplied)) elements[name].value = value;
    },
    values() {
      return Object.fromEntries(Object.entries(elements).map(([name, field]) => [name, field.value]));
    },
    async submit() {
      let prevented = false;
      const event = { preventDefault() { prevented = true; } };
      await Promise.all(handlers.map(handler => handler(event)));
      assert.ok(prevented, 'Native submission must be prevented');
    }
  };
}

function assertReady(page) {
  assert.equal(page.button.disabled, false);
  assert.equal(page.attributes['aria-busy'], 'false');
  assert.ok(Object.values(page.elements).every(field => !field.disabled));
}

function assertFailure(page, before) {
  assert.deepEqual(page.values(), before);
  assert.equal(page.resets, 0);
  assert.ok(page.feedback.textContent.length > 0);
  assert.doesNotMatch(page.feedback.textContent, /envoyée pour examen/);
  assertReady(page);
}

test('local page keeps existing presentation hooks and loads API before app', () => {
  // Une description accessible ne doit pas faire disparaitre les contraintes existantes.
  const formTag = html.match(/<form\b[^>]*\bid="proposal-form"[^>]*>/)?.[0];
  assert.ok(formTag);
  assert.match(formTag, /\bclass="panel demo-form"/);
  assert.match(formTag, /\bmethod="post"/);
  assert.match(html, /id="titre" name="title" maxlength="200" required/);
  assert.match(html, /id="categorie" name="category" required/);
  assert.match(html, /id="contenu" name="content"/);
  const api = html.indexOf('<script src="api.js"></script>');
  const app = html.indexOf('<script src="app.js"></script>');
  assert.ok(api >= 0 && api < app);
  assert.doesNotMatch(html, /type=["']file["']/);
});

test('valid proposal sends only title/content with category, cookies and fresh CSRF', async () => {
  const page = mount();
  page.fill();
  assert.equal(page.listenerCount, 1, 'Demo handler must not also handle this form');
  await page.submit();
  assert.deepEqual(page.calls.map(call => call.url), ['/api/v1/me', '/api/v1/proposals']);
  const post = page.calls[1];
  assert.equal(post.method, 'POST');
  assert.equal(post.credentials, 'include');
  assert.equal(page.calls[0].credentials, 'include');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.ok(post.headers['X-CSRF-Token'] === page.csrf);
  assert.deepEqual(JSON.parse(post.body), {
    title: 'Une proposition',
    content: 'Catégorie proposée : Histoire\n\nDes indices'
  });
  assert.equal(page.resets, 1);
  assert.match(page.feedback.textContent, /envoyée pour examen/);
  assertReady(page);
});

test('Cold case category and internal paragraphs are preserved', async () => {
  const page = mount();
  page.fill({ category: 'Cold case', content: ' Premier paragraphe.\n\nDeuxième paragraphe. ' });
  await page.submit();
  assert.equal(JSON.parse(page.calls[1].body).content,
    'Catégorie proposée : Cold case\n\nPremier paragraphe.\n\nDeuxième paragraphe.');
});

test('anonymous /me stops before POST, explains login and preserves inputs', async () => {
  const page = mount({ meStatus: 401, meBody: { message: 'Authentification requise.' } });
  page.fill(); const before = page.values();
  await page.submit();
  assert.equal(page.calls.length, 1);
  assert.match(page.feedback.textContent, /Connectez-vous/);
  assertFailure(page, before);
});

test('session expiring between /me and POST is handled as authentication failure', async () => {
  const page = mount({ postStatus: 401, postBody: { message: 'Authentification requise.' } });
  page.fill(); const before = page.values();
  await page.submit();
  assert.equal(page.calls.length, 2);
  assert.match(page.feedback.textContent, /expiré/);
  assertFailure(page, before);
});

test('banned session is refused by /me without POST', async () => {
  const page = mount({ meStatus: 403, meBody: { message: 'Compte suspendu.' } });
  page.fill(); const before = page.values();
  await page.submit();
  assert.equal(page.calls.length, 1);
  assert.match(page.feedback.textContent, /Compte suspendu/);
  assertFailure(page, before);
});

test('invalid CSRF response is visible and preserves the proposal', async () => {
  const page = mount({ postStatus: 403, postBody: { message: 'Token CSRF invalide ou manquant.' } });
  page.fill(); const before = page.values();
  await page.submit();
  assert.match(page.feedback.textContent, /Envoi refusé/);
  assert.match(page.feedback.textContent, /Rechargez/);
  assertFailure(page, before);
});

for (const field of ['title', 'content']) {
  for (const [kind, value] of [['empty', ''], ['whitespace', ' \t\n ']]) {
    test(field + ' rejects ' + kind + ' before network and keeps inputs', async () => {
      const page = mount();
      page.fill({ [field]: value }); const before = page.values();
      await page.submit();
      assert.equal(page.calls.length, 0);
      assertFailure(page, before);
    });
  }
}

test('title longer than 200 characters is rejected before network', async () => {
  const page = mount();
  page.fill({ title: 'x'.repeat(201) }); const before = page.values();
  await page.submit();
  assert.equal(page.calls.length, 0);
  assert.match(page.feedback.textContent, /200/);
  assertFailure(page, before);
});

test('title at the 200-character boundary is accepted', async () => {
  const page = mount();
  page.fill({ title: 'x'.repeat(200) });
  await page.submit();
  assert.equal(JSON.parse(page.calls[1].body).title.length, 200);
  assert.equal(page.resets, 1);
});

test('category metadata counts toward the 65535-byte content boundary', async () => {
  const prefix = 'Catégorie proposée : Histoire\n\n';
  const room = 65535 - Buffer.byteLength(prefix, 'utf8');
  const page = mount();
  page.fill({ content: 'x'.repeat(room) });
  await page.submit();
  assert.equal(Buffer.byteLength(JSON.parse(page.calls[1].body).content, 'utf8'), 65535);
  assert.equal(page.resets, 1);
});

test('one byte above the limit including category is refused without network', async () => {
  const room = 65535 - Buffer.byteLength('Catégorie proposée : Histoire\n\n', 'utf8');
  const page = mount();
  page.fill({ content: 'x'.repeat(room + 1) }); const before = page.values();
  await page.submit();
  assert.equal(page.calls.length, 0);
  assertFailure(page, before);
});

test('UTF-8 content size is measured in bytes rather than characters', async () => {
  const page = mount();
  page.fill({ content: 'é'.repeat(32768) }); const before = page.values();
  await page.submit();
  assert.equal(page.calls.length, 0);
  assertFailure(page, before);
});

test('multibyte content below the UTF-8 limit is accepted', async () => {
  const room = 65535 - Buffer.byteLength('Catégorie proposée : Histoire\n\n', 'utf8');
  const page = mount();
  page.fill({ content: 'é'.repeat(Math.floor(room / 2)) });
  await page.submit();
  assert.ok(Buffer.byteLength(JSON.parse(page.calls[1].body).content, 'utf8') <= 65535);
  assert.equal(page.resets, 1);
});

for (const field of ['title', 'content']) {
  test('unpaired Unicode in ' + field + ' is refused before network', async () => {
    const page = mount();
    page.fill({ [field]: '\ud800' }); const before = page.values();
    await page.submit();
    assert.equal(page.calls.length, 0);
    assertFailure(page, before);
  });
}

test('unexpected category is not silently discarded', async () => {
  const page = mount();
  page.fill({ category: 'unexpected' }); const before = page.values();
  await page.submit();
  assert.equal(page.calls.length, 0);
  assertFailure(page, before);
});

for (const [name, value] of [
  ['absent', undefined], ['empty', ''], ['non-ASCII', '\u00e9'], ['wrong type', {}]
]) {
  test('unusable CSRF from /me (' + name + ') prevents POST', async () => {
    const page = mount({ meBody: value === undefined ? {} : { csrf_token: value } });
    page.fill(); const before = page.values();
    await page.submit();
    assert.equal(page.calls.length, 1);
    assertFailure(page, before);
  });
}

for (const phase of ['me', 'post']) {
  test('network failure during ' + phase + ' keeps inputs and permits retry', async () => {
    const page = mount({ [phase + 'NetworkError']: true });
    page.fill(); const before = page.values();
    await page.submit();
    assert.match(page.feedback.textContent, /Impossible de contacter/);
    assertFailure(page, before);
  });
}

for (const status of [200, 202, 204]) {
  test('HTTP ' + status + ' never triggers success or reset', async () => {
    const page = mount({ postStatus: status });
    page.fill(); const before = page.values();
    await page.submit();
    assertFailure(page, before);
  });
}

test('HTTP 201 with unreadable JSON preserves inputs and reports failure', async () => {
  const page = mount({ invalidPostJson: true });
  page.fill(); const before = page.values();
  await page.submit();
  assert.match(page.feedback.textContent, /illisible/);
  assertFailure(page, before);
});

test('server validation failure is shown without clearing fields', async () => {
  const page = mount({ postStatus: 400, postBody: { message: 'Titre invalide.' } });
  page.fill(); const before = page.values();
  await page.submit();
  assert.equal(page.feedback.textContent, 'Titre invalide.');
  assertFailure(page, before);
});

test('server failure is shown without clearing fields', async () => {
  const page = mount({ postStatus: 500, postBody: { message: 'Service indisponible.' } });
  page.fill(); const before = page.values();
  await page.submit();
  assertFailure(page, before);
});

test('double clicks during /me and POST produce exactly one creation', async () => {
  const meGate = deferred(), postGate = deferred(), postStarted = deferred();
  const page = mount({ fetch: async (url, request, csrf) => {
    if (url.endsWith('/me')) {
      await meGate.promise;
      return response(200, { csrf_token: csrf });
    }
    postStarted.resolve();
    await postGate.promise;
    return response(201, { status: 'success' });
  } });
  page.fill();
  const pending = [page.submit(), page.submit()];
  try {
    assert.equal(page.calls.length, 1);
    assert.equal(page.button.disabled, true);
    assert.ok(Object.values(page.elements).every(field => field.disabled));
    await pending[1];
    meGate.resolve();
    await Promise.race([
      postStarted.promise,
      pending[0].then(() => { throw new Error('Submission ended before POST'); })
    ]);
    pending.push(page.submit());
    assert.equal(page.calls.length, 2);
    await pending[2];
    assert.equal(page.button.disabled, true);
    assert.equal(page.resets, 0);
    postGate.resolve();
    await pending[0];
    assert.equal(page.calls.filter(call => call.url.endsWith('/proposals')).length, 1);
    assert.equal(page.resets, 1);
    assertReady(page);
  } finally {
    meGate.resolve();
    postGate.resolve();
    await Promise.allSettled(pending);
  }
});

test('explicit retry refreshes /me and succeeds after an earlier failure', async () => {
  let posts = 0;
  const page = mount({ fetch: async (url, request, csrf) => {
    if (url.endsWith('/me')) return response(200, { csrf_token: csrf });
    posts += 1;
    return posts === 1 ? response(403, { message: 'Token refuse.' }) : response(201, { status: 'success' });
  } });
  page.fill(); const before = page.values();
  await page.submit();
  assertFailure(page, before);
  assert.equal(page.calls.length, 2, 'No automatic retry');
  await page.submit();
  assert.deepEqual(page.calls.map(call => call.url),
    ['/api/v1/me', '/api/v1/proposals', '/api/v1/me', '/api/v1/proposals']);
  assert.equal(page.resets, 1);
});

test('unrelated demo forms keep their handler without loading stories', () => {
  const handlers = [];
  const feedback = { textContent: '' };
  const form = { addEventListener: (name, handler) => handlers.push(handler), querySelector: () => feedback };
  let network = 0;
  const context = vm.createContext({
    document: {
      querySelector: () => null,
      querySelectorAll: () => [form],
      getElementById: () => null
    },
    fetch() { network += 1; throw new Error('NETWORK_FORBIDDEN'); }
  });
  vm.runInContext(appSource, context, { filename: 'frontend/app.js', timeout: 1000 });
  let prevented = false;
  assert.equal(handlers.length, 1);
  handlers[0]({ preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.ok(feedback.textContent.length > 0);
  assert.equal(network, 0);
});
