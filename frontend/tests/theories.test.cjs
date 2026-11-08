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
const html = fs.readFileSync(path.join(frontend, 'theories.html'), 'utf8');
const stories = [17, 42].map(id => ({
  id, category_id: id === 17 ? 1 : 2, slug: 'synthetic-story-' + id,
  title: 'Dossier ' + id, summary: 'Synthetic summary', content: 'Synthetic content'
}));

function response(status, body, invalidJson = false) {
  return {
    status, ok: status >= 200 && status < 300,
    async json() {
      if (invalidJson) throw new SyntaxError('Invalid synthetic JSON');
      return body;
    }
  };
}

function savedTheory(url, request, userId = 5) {
  return { status: 'success', theory: { id: 1, story_id: Number(url.split('/')[4]),
    user_id: userId, ...JSON.parse(request.body), likes: 0, created_at: null } };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function mount(options = {}) {
  const loaded = deferred();
  const feedback = { textContent: 'Chargement des dossiers...' };
  const button = { disabled: true };
  const attributes = { 'aria-busy': 'true' };
  const initial = { story_id: '', title: '', content: '' };
  const elements = Object.fromEntries(Object.entries(initial).map(([name, value]) =>
    [name, { value, disabled: name === 'story_id' }]));
  elements.story_id.children = [{ value: '', textContent: 'Choisir un dossier' }];
  elements.story_id.replaceChildren = function (...children) {
    this.children = children;
    this.value = children[0]?.value || '';
  };
  const handlers = [];
  let resets = 0;
  const form = {
    elements,
    addEventListener(name, handler) { if (name === 'submit') handlers.push(handler); },
    querySelector(selector) {
      return selector === '.feedback' ? feedback : selector === 'button' ? button : null;
    },
    setAttribute(name, value) {
      attributes[name] = value;
      if (name === 'aria-busy' && value === 'false') loaded.resolve();
    },
    reset() {
      resets += 1;
      for (const [name, value] of Object.entries(initial)) elements[name].value = value;
    }
  };
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const csrf = randomBytes(24).toString('hex');
  const context = vm.createContext({
    AbortController, TextEncoder,
    setTimeout: options.fakeTimers ? fn => { timers.set(++timerId, fn); return timerId; } : setTimeout,
    clearTimeout: options.fakeTimers ? id => timers.delete(id) : clearTimeout,
    document: {
      querySelector: () => null,
      querySelectorAll(selector) {
        return selector.includes('.demo-form') && !selector.includes(':not(#theory-form)') ? [form] : [];
      },
      getElementById: id => id === 'theory-form' ? form : null,
      createElement(tag) {
        assert.equal(tag, 'option');
        const option = { value: '', textContent: '' };
        Object.defineProperty(option, 'innerHTML', {
          set() { throw new Error('HTML injection forbidden'); }
        });
        return option;
      }
    },
    async fetch(url, request) {
      assert.ok(['/api/v1/stories', '/api/v1/me', '/api/v1/stories/17/theories',
        '/api/v1/stories/42/theories'].includes(url), 'Unexpected route');
      calls.push({ url, ...request });
      if (options.fetch) return options.fetch(url, request, csrf);
      if (url === '/api/v1/stories') {
        if (options.storiesNetworkError) throw new TypeError('Synthetic offline failure');
        return response(options.storiesStatus || 200,
          options.storiesBody === undefined ? stories : options.storiesBody,
          options.invalidStoriesJson);
      }
      if (url === '/api/v1/me') {
        if (options.meNetworkError) throw new TypeError('Synthetic offline failure');
        return response(options.meStatus || 200,
          options.meBody === undefined ? { csrf_token: csrf } : options.meBody);
      }
      if (options.postNetworkError) throw new TypeError('Synthetic offline failure');
      return response(options.postStatus || 201,
        options.postBody === undefined ? savedTheory(url, request) : options.postBody,
        options.invalidPostJson);
    }
  });
  vm.runInContext(apiSource, context, { filename: 'frontend/api.js', timeout: 1000 });
  vm.runInContext(appSource, context, { filename: 'frontend/app.js', timeout: 1000 });
  return {
    ready: loaded.promise, calls, csrf, elements, feedback, button, attributes, context, timers,
    get resets() { return resets; },
    get listenerCount() { return handlers.length; },
    fill(values = {}) {
      const supplied = { story_id: '17', title: ' Une théorie ', content: ' Des indices ', ...values };
      for (const [name, value] of Object.entries(supplied)) elements[name].value = value;
    },
    values() {
      return Object.fromEntries(Object.entries(elements).map(([name, field]) => [name, field.value]));
    },
    async submit() {
      let prevented = false;
      await Promise.all(handlers.map(handler => handler({
        preventDefault() { prevented = true; }
      })));
      assert.ok(prevented);
    }
  };
}

function assertReady(page, blocked = false) {
  assert.equal(page.button.disabled, blocked);
  assert.equal(page.attributes['aria-busy'], 'false');
  assert.ok(Object.values(page.elements).every(field => !field.disabled));
}

function assertFailure(page, before, uncertain = false) {
  assert.deepEqual(page.values(), before);
  assert.equal(page.resets, 0);
  assert.ok(page.feedback.textContent.length > 0);
  assert.notEqual(page.feedback.textContent, 'Théorie publiée.');
  assertReady(page, uncertain);
}

test('HTML preserves design hooks, adds required title and loads API before app', () => {
  // Les attributs d'accessibilité peuvent s'ajouter sans changer le contrat du formulaire.
  const formTag = html.match(/<form\b[^>]*\bid="theory-form"[^>]*>/)?.[0];
  assert.ok(formTag);
  assert.match(formTag, /\bclass="demo-form"/);
  assert.match(formTag, /\bmethod="post"/);
  assert.match(formTag, /\baria-busy="true"/);
  assert.match(html, /<label for="theory-title">Titre de votre théorie<\/label>/);
  assert.match(html, /id="theory-title" name="title" maxlength="200" required/);
  assert.match(html, /id="sujet" name="story_id" required disabled/);
  assert.match(html, /id="avis" name="content" rows="5" required/);
  const submitTag = html.match(/<button\b[^>]*\btype="submit"[^>]*>Envoyer<\/button>/)?.[0];
  assert.ok(submitTag);
  assert.match(submitTag, /\bclass="btn"/);
  assert.match(submitTag, /\bdisabled(?=\s|>)/);
  assert.match(html, /class="feedback" aria-live="polite"/);
  const api = html.indexOf('<script src="api.js"></script>');
  assert.ok(api >= 0 && api < html.indexOf('<script src="app.js"></script>'));
  assert.match(html, /href="styles.css"/);
  assert.doesNotMatch(html, /<style|style=|type=["']file["']/);
});

test('story selector uses numeric IDs returned by API and never fictitious local IDs', async () => {
  const page = mount();
  assert.equal(page.button.disabled, true);
  assert.equal(page.elements.story_id.disabled, true);
  await page.ready;
  assert.deepEqual(page.calls.map(call => call.url), ['/api/v1/stories']);
  assert.deepEqual(page.elements.story_id.children.map(option => option.value), ['', '17', '42']);
  assert.deepEqual(page.elements.story_id.children.map(option => option.textContent),
    ['Choisir un dossier', 'Dossier 17', 'Dossier 42']);
  assert.equal(page.listenerCount, 1);
  assertReady(page);
});

test('API story titles are rendered as text rather than HTML', async () => {
  const title = '<img src=x onerror=alert(1)>';
  const page = mount({ storiesBody: [{ ...stories[0], title }] });
  await page.ready;
  assert.equal(page.elements.story_id.children[1].textContent, title);
});

test('empty story list disables creation and gives clear feedback', async () => {
  const page = mount({ storiesBody: [] });
  await page.ready;
  page.fill();
  await page.submit();
  assert.equal(page.calls.length, 1);
  assert.equal(page.button.disabled, true);
  assert.equal(page.elements.story_id.disabled, true);
  assert.equal(page.resets, 0);
  assert.match(page.feedback.textContent, /dossiers ne sont pas disponibles/);
});

for (const [name, options] of [
  ['network', { storiesNetworkError: true }],
  ['HTTP 500', { storiesStatus: 500, storiesBody: { message: 'Service indisponible.' } }],
  ['invalid JSON', { invalidStoriesJson: true }],
  ['invalid payload', { storiesBody: {} }],
  ['fictitious ID', { storiesBody: [{ ...stories[0], id: 'cc1' }] }],
  ['zero ID', { storiesBody: [{ ...stories[0], id: 0 }] }],
  ['ID overflow', { storiesBody: [{ ...stories[0], id: 2147483648 }] }],
  ['duplicate IDs', { storiesBody: [stories[0], stories[0]] }]
]) {
  test('story loading failure (' + name + ') never enables submission', async () => {
    const page = mount(options);
    await page.ready;
    assert.match(page.feedback.textContent, /Impossible de charger les dossiers/);
    assert.equal(page.button.disabled, true);
    assert.equal(page.elements.story_id.disabled, true);
    page.fill(); const before = page.values();
    await page.submit();
    assert.equal(page.calls.length, 1);
    assert.deepEqual(page.values(), before);
    assert.equal(page.resets, 0);
  });
}

test('programmatic submission while loading cannot create a theory', async () => {
  const gate = deferred();
  const page = mount({ fetch: async () => { await gate.promise; return response(200, stories); } });
  try {
    page.fill();
    await page.submit();
    assert.equal(page.calls.length, 1);
    assert.equal(page.resets, 0);
    assert.equal(page.button.disabled, true);
  } finally {
    gate.resolve();
    await page.ready;
  }
});

test('valid theory sends title/content to selected story using refreshed CSRF and cookies', async () => {
  const page = mount();
  await page.ready;
  vm.runInContext('csrfToken = "stale-synthetic-token"', page.context);
  page.fill({ story_id: '42' });
  await page.submit();
  assert.deepEqual(page.calls.map(call => call.url),
    ['/api/v1/stories', '/api/v1/me', '/api/v1/stories/42/theories']);
  const post = page.calls[2];
  assert.equal(post.method, 'POST');
  assert.ok(page.calls.every(call => call.credentials === 'include'));
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.equal(post.headers['X-CSRF-Token'], page.csrf);
  assert.deepEqual(JSON.parse(post.body), { title: 'Une théorie', content: 'Des indices' });
  assert.equal(page.resets, 1);
  assert.equal(page.feedback.textContent, 'Théorie publiée.');
  assertReady(page);
});

for (const value of ['', 'h1', 'cc1', '0', '-1', '17.5', '01', ' 17', '1e1', '999', '2147483648', '../17']) {
  test('invalid or unlisted dossier "' + value + '" is refused before /me', async () => {
    const page = mount();
    await page.ready;
    page.fill({ story_id: value }); const before = page.values();
    await page.submit();
    assert.equal(page.calls.length, 1);
    assert.match(page.feedback.textContent, /Choisissez un dossier/);
    assertFailure(page, before);
  });
}

test('API helper rejects nonnumeric or out-of-range story IDs before fetch', async () => {
  const page = mount();
  await page.ready;
  for (const value of ['17', 0, -1, 1.5, 2147483648, NaN, Infinity, null, {}]) {
    await assert.rejects(page.context.createTheory(value, 'Title', 'Content'), /dossier valide/);
  }
  assert.equal(page.calls.length, 1);
});

for (const [name, options, message] of [
  ['anonymous', { meStatus: 401, meBody: { message: 'Authentification requise.' } }, /Connectez-vous/],
  ['expired before POST', { postStatus: 401, postBody: { message: 'Authentification requise.' } }, /expiré/],
  ['invalid CSRF', { postStatus: 403, postBody: { message: 'Token CSRF invalide.' } }, /Envoi refusé/],
  ['banned', { meStatus: 403, meBody: { message: 'Compte suspendu.' } }, /Compte suspendu/],
  ['deleted dossier', { postStatus: 404, postBody: { error: 'Story not found' } }, /dossier n’est plus disponible/],
  ['server validation', { postStatus: 400, postBody: { message: 'Titre invalide.' } }, /Titre invalide/],
  ['server failure', { postStatus: 500, postBody: { message: 'Service indisponible.' } }, /Résultat incertain/]
]) {
  test(name + ' preserves title, content and selected dossier', async () => {
    const page = mount(options);
    await page.ready;
    page.fill(); const before = page.values();
    await page.submit();
    assert.match(page.feedback.textContent, message);
    assert.equal(page.calls.length, options.meStatus ? 2 : 3);
    assertFailure(page, before, options.postStatus >= 500);
  });
}

for (const field of ['title', 'content']) {
  for (const value of ['', ' \t\n ']) {
    test(field + ' required validation preserves whitespace/empty inputs', async () => {
      const page = mount();
      await page.ready;
      page.fill({ [field]: value }); const before = page.values();
      await page.submit();
      assert.equal(page.calls.length, 1);
      assertFailure(page, before);
    });
  }
}

for (const [name, title] of [
  ['200 ASCII characters', 'x'.repeat(200)],
  ['200 Unicode code points', '\u{1f50e}'.repeat(200)]
]) {
  test('title boundary accepts ' + name + ' in the handler', async () => {
    const page = mount();
    await page.ready;
    page.fill({ title });
    await page.submit();
    assert.equal(JSON.parse(page.calls[2].body).title, title);
    assert.equal(page.resets, 1);
  });
}

test('title above 200 characters is rejected before /me', async () => {
  const page = mount();
  await page.ready;
  page.fill({ title: 'x'.repeat(201) }); const before = page.values();
  await page.submit();
  assert.equal(page.calls.length, 1);
  assert.match(page.feedback.textContent, /200/);
  assertFailure(page, before);
});

for (const [name, content, accepted] of [
  ['65535 ASCII bytes', 'x'.repeat(65535), true],
  ['65536 ASCII bytes', 'x'.repeat(65536), false],
  ['65535 multibyte bytes', '\u{1f50e}'.repeat(16383) + 'xxx', true],
  ['65536 multibyte bytes', '\u{1f50e}'.repeat(16384), false],
  ['65536 accented bytes', 'é'.repeat(32768), false]
]) {
  test('content UTF-8 boundary: ' + name, async () => {
    const page = mount();
    await page.ready;
    page.fill({ content }); const before = page.values();
    await page.submit();
    if (accepted) {
      assert.equal(JSON.parse(page.calls[2].body).content, content);
      assert.equal(page.resets, 1);
    } else {
      assert.equal(page.calls.length, 1);
      assertFailure(page, before);
    }
  });
}

for (const field of ['title', 'content']) {
  test('unpaired Unicode in ' + field + ' is rejected without POST', async () => {
    const page = mount();
    await page.ready;
    page.fill({ [field]: '\ud800' }); const before = page.values();
    await page.submit();
    assert.equal(page.calls.length, 1);
    assertFailure(page, before);
  });
}

for (const value of [undefined, '', 'é', {}]) {
  test('unusable CSRF from /me blocks POST (' + typeof value + ')', async () => {
    const page = mount({ meBody: value === undefined ? {} : { csrf_token: value } });
    await page.ready;
    page.fill(); const before = page.values();
    await page.submit();
    assert.equal(page.calls.length, 2);
    assertFailure(page, before);
  });
}

for (const phase of ['me', 'post']) {
  test('network error during ' + phase + ' preserves all inputs', async () => {
    const page = mount({ [phase + 'NetworkError']: true });
    await page.ready;
    page.fill(); const before = page.values();
    await page.submit();
    assert.match(page.feedback.textContent, phase === 'post' ? /Résultat incertain/ : /Impossible de contacter/);
    assertFailure(page, before, phase === 'post');
  });
}

for (const status of [200, 202, 204]) {
  test('HTTP ' + status + ' cannot display success or reset the form', async () => {
    const page = mount({ postStatus: status });
    await page.ready;
    page.fill(); const before = page.values();
    await page.submit();
    assertFailure(page, before, true);
  });
}

test('HTTP 201 with unreadable JSON preserves inputs', async () => {
  const page = mount({ invalidPostJson: true });
  await page.ready;
  page.fill(); const before = page.values();
  await page.submit();
  assert.match(page.feedback.textContent, /Résultat incertain/);
  assertFailure(page, before, true);
});

test('double submissions during /me and POST create exactly one theory', async () => {
  const meGate = deferred(), postGate = deferred(), postStarted = deferred();
  const page = mount({ fetch: async (url, request, csrf) => {
    if (url.endsWith('/stories')) return response(200, stories);
    if (url.endsWith('/me')) {
      await meGate.promise;
      return response(200, { csrf_token: csrf });
    }
    postStarted.resolve();
    await postGate.promise;
    return response(201, savedTheory(url, request));
  } });
  await page.ready;
  page.fill();
  const pending = [page.submit(), page.submit()];
  try {
    assert.equal(page.calls.length, 2);
    assert.equal(page.button.disabled, true);
    assert.ok(Object.values(page.elements).every(field => field.disabled));
    await pending[1];
    meGate.resolve();
    await Promise.race([
      postStarted.promise,
      pending[0].then(() => { throw new Error('Submission ended before POST'); })
    ]);
    pending.push(page.submit());
    await pending[2];
    assert.equal(page.calls.length, 3);
    assert.equal(page.resets, 0);
    postGate.resolve();
    await pending[0];
    assert.equal(page.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(page.resets, 1);
    assertReady(page);
  } finally {
    meGate.resolve();
    postGate.resolve();
    await Promise.allSettled(pending);
  }
});

test('explicit retry refreshes CSRF after failure without automatic resubmission', async () => {
  let attempts = 0;
  const page = mount({ fetch: async (url, request, csrf) => {
    if (url.endsWith('/stories')) return response(200, stories);
    if (url.endsWith('/me')) return response(200, { csrf_token: csrf });
    attempts += 1;
    return attempts === 1 ? response(403, { message: 'CSRF refuse.' }) :
      response(201, savedTheory(url, request));
  } });
  await page.ready;
  page.fill(); const before = page.values();
  await page.submit();
  assertFailure(page, before);
  assert.equal(page.calls.length, 3);
  await page.submit();
  assert.deepEqual(page.calls.map(call => call.url), [
    '/api/v1/stories', '/api/v1/me', '/api/v1/stories/17/theories',
    '/api/v1/me', '/api/v1/stories/17/theories'
  ]);
  assert.equal(page.resets, 1);
});

test('application does not load stories on pages without the theory form', () => {
  let requests = 0;
  const context = vm.createContext({
    document: {
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null
    },
    getStories() { requests += 1; throw new Error('Unexpected request'); }
  });
  vm.runInContext(appSource, context, { filename: 'frontend/app.js', timeout: 1000 });
  assert.equal(requests, 0);
});

for (const payload of [
  null, {}, { status: 'error' }, { status: 'success' },
  ...[{ id: 0 }, { id: '1' }, { id: 2147483648 }, { story_id: 42 },
    { title: 'Autre titre' }, { content: 'Autre contenu' }].map(changes => ({
    status: 'success', theory: { id: 1, story_id: 17, title: 'Une théorie', content: 'Des indices', ...changes }
  }))
]) {
  test('201 incohérent conserve le brouillon et interdit un nouvel envoi : ' + JSON.stringify(payload), async () => {
    const page = mount({ postBody: payload }); await page.ready;
    page.fill(); const before = page.values(); await page.submit();
    assert.match(page.feedback.textContent, /Résultat incertain/);
    assertFailure(page, before, true);
    await page.submit();
    assert.equal(page.calls.filter(call => call.method === 'POST').length, 1);
  });
}

for (const failure of ['network', '500', 'unexpected status', 'unreadable JSON', 'timeout']) {
  test('théorie : ' + failure + ' après enregistrement simulé ne déclenche aucune répétition', async () => {
    let saved = 0;
    const page = mount({ fakeTimers: failure === 'timeout', fetch: async (url, request, csrf) => {
      if (url.endsWith('/stories')) return response(200, stories);
      if (url.endsWith('/me')) return response(200, { user: { id: 2, is_admin: false }, csrf_token: csrf });
      saved++;
      if (failure === 'network') throw Error('offline');
      if (failure === '500') return response(500, {});
      if (failure === 'unexpected status') return response(202, savedTheory(url, request));
      if (failure === 'unreadable JSON') return response(201, {}, true);
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(Error('abort'))));
    } });
    await page.ready; page.fill(); const before = page.values();
    const pending = page.submit();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    if (failure === 'timeout') for (const expire of [...page.timers.values()]) expire();
    await pending;
    assert.match(page.feedback.textContent, /Résultat incertain/);
    assertFailure(page, before, true);
    await page.submit(); await page.submit();
    assert.equal(saved, 1);
    assert.equal(page.calls.filter(call => call.method === 'POST').length, 1);
  });
}

for (const user of [{ id: 1, is_admin: true }, { id: 2, is_admin: false }, { id: 3, is_admin: false }]) {
  test('théorie : contrat de session permanente id ' + user.id, async () => {
    const page = mount({ fetch: async (url, request, csrf) => {
      if (url.endsWith('/stories')) return response(200, stories);
      if (url.endsWith('/me')) return response(200, { user, csrf_token: csrf });
      return response(201, savedTheory(url, request, user.id));
    } });
    await page.ready; page.fill(); await page.submit();
    assert.equal(page.feedback.textContent, 'Théorie publiée.');
    const post = page.calls.find(call => call.method === 'POST');
    assert.equal(post.headers['X-CSRF-Token'], page.csrf);
    assert.deepEqual(Object.keys(JSON.parse(post.body)).sort(), ['content', 'title']);
    assert.equal(page.resets, 1); assertReady(page);
  });
}
