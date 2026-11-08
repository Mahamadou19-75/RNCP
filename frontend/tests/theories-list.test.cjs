'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(frontend, 'api.js'), 'utf8');
const readerSource = fs.readFileSync(path.join(frontend, 'theories-list.js'), 'utf8');
const appSource = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(frontend, 'theories.html'), 'utf8');
const originalForm = "<form id=\"theory-form\" class=\"demo-form\" method=\"post\" aria-busy=\"true\">\r\n\t\t\t\t\t\t<label for=\"sujet\">Dossier</label>\r\n\t\t\t\t\t\t<select id=\"sujet\" name=\"story_id\" required disabled>\r\n\t\t\t\t\t\t\t<option value=\"\">Choisir un dossier</option>\r\n\t\t\t\t\t\t</select>\r\n\t\t\t\t\t\t<label for=\"theory-title\">Titre de votre théorie</label>\r\n\t\t\t\t\t\t<input id=\"theory-title\" name=\"title\" maxlength=\"200\" required placeholder=\"Titre de votre théorie\">\r\n\t\t\t\t\t\t<label for=\"avis\">Votre avis</label>\r\n\t\t\t\t\t\t<textarea id=\"avis\" name=\"content\" rows=\"5\" required placeholder=\"Votre analyse...\"></textarea>\r\n\t\t\t\t\t\t<button class=\"btn\" type=\"submit\" disabled>Envoyer</button>\r\n\t\t\t\t\t\t<p class=\"feedback\" aria-live=\"polite\">Chargement des dossiers...</p>\r\n\t\t\t\t\t</form>";
const stories = [17, 42].map(id => ({
  id, category_id: 1, slug: 'isolated-' + id, title: 'Dossier ' + id,
  summary: 'Résumé isolé', content: 'Contenu isolé'
}));
const theory = (storyId = 17, changes = {}) => ({
  id: 7, story_id: storyId, user_id: null, title: 'Une piste',
  content: 'Premier paragraphe.\n\nDeuxième paragraphe.',
  created_at: '2026-10-24T10:15:00', likes: 0, ...changes
});
const response = (status, body) => ({
  status, ok: status >= 200 && status < 300, async json() { return body; }
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.events = new Map();
    this.attributes = {};
    this.style = {};
    this.value = '';
    this.disabled = false;
    this._text = '';
    Object.defineProperty(this, 'innerHTML', {
      get() { throw new Error('HTML parsing forbidden'); },
      set() { throw new Error('HTML parsing forbidden'); }
    });
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) {
    this.children = children;
    this._text = '';
    if (this.tagName === 'select') this.value = children[0]?.value || '';
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) {
    const items = this.events.get(name) || [];
    items.push(handler); this.events.set(name, items);
  }
  async emit(name) {
    await Promise.all((this.events.get(name) || []).map(handler => handler({
      preventDefault() {}, target: this
    })));
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.tagName === selector || selector === '.' + child.className) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function mount(options = {}) {
  const ids = new Map([
    ['published-theories', new Element('section')],
    ['theories-story-select', new Element('select')],
    ['theories-refresh', new Element('button')],
    ['theories-list-feedback', new Element('p')],
    ['published-theories-list', new Element('div')]
  ]);
  const section = ids.get('published-theories');
  const select = ids.get('theories-story-select');
  const refresh = ids.get('theories-refresh');
  const feedback = ids.get('theories-list-feedback');
  const list = ids.get('published-theories-list');
  select.disabled = refresh.disabled = true;
  section.setAttribute('aria-busy', 'true');
  const placeholder = new Element('option');
  select.replaceChildren(placeholder);
  let creation;
  if (options.withCreation) {
    creation = new Element('form');
    creation.elements = {
      story_id: new Element('select'), title: new Element('input'), content: new Element('textarea')
    };
    creation.feedback = new Element('p');
    creation.button = new Element('button');
    creation.children = [creation.feedback, creation.button];
    creation.feedback.className = 'feedback';
    creation.resets = 0;
    creation.reset = function () {
      this.resets++;
      Object.values(this.elements).forEach(field => { field.value = ''; });
    };
    ids.set('theory-form', creation);
  }
  const calls = [], tags = [];
  const context = vm.createContext({
    AbortController, TextEncoder, setTimeout, clearTimeout, Intl,
    document: {
      getElementById: id => ids.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement(tag) { tags.push(tag); return new Element(tag); }
    },
    XMLHttpRequest() { throw new Error('Network forbidden'); },
    WebSocket() { throw new Error('Network forbidden'); },
    async fetch(url, request) {
      const method = request.method || 'GET';
      const allowed = url === '/api/v1/stories' ||
        /^\/api\/v1\/stories\/(17|42)\/theories$/.test(url) ||
        options.withCreation && url === '/api/v1/me';
      assert.ok(allowed, 'Unexpected route');
      assert.ok(method === 'GET' || options.withCreation && method === 'POST');
      calls.push({ url, ...request, method });
      if (options.fetch) return options.fetch(url, request, calls);
      if (url === '/api/v1/stories') return response(200, options.stories === undefined ? stories : options.stories);
      if (url === '/api/v1/me') return response(200, { csrf_token: 'isolated-test-token' });
      if (method === 'POST') return response(201, { status: 'success',
        theory: theory(Number(url.split('/')[4]), JSON.parse(request.body)) });
      const id = Number(url.split('/')[4]);
      return response(200, options.theories === undefined ? [theory(id)] : options.theories);
    }
  });
  vm.runInContext(apiSource, context, { filename: 'frontend/api.js', timeout: 1000 });
  if (options.withCreation) vm.runInContext(appSource, context, { filename: 'frontend/app.js', timeout: 1000 });
  vm.runInContext(readerSource, context, { filename: 'frontend/theories-list.js', timeout: 1000 });
  return {
    context, calls, tags, creation, section, select, refresh, feedback, list,
    async ready() {
      await settle();
      assert.equal(section.attributes['aria-busy'], 'false', 'Story loading must finish');
    },
    choose(value) { select.value = String(value); return select.emit('change'); },
    update() { return refresh.emit('click'); }
  };
}

test('HTML preserves the complete creation form and adds an independent reader after it', () => {
  const normalizeLineEndings = value => value.replace(/\r\n/g, '\n');
  const actualForm = html.match(/<form id="theory-form"[\s\S]*?<\/form>/)[0];
  // Conserver la comparaison integrale de l'ancien formulaire, hors seuls ajouts 6E.2.
  const historicalForm = value => normalizeLineEndings(value)
    .replace(/ aria-describedby="theory-data-notice"/g, '')
    .replace(/\n[\t ]*<p id="theory-data-notice" class="data-notice">[\s\S]*?<\/p>/, '');
  assert.equal((actualForm.match(/id="theory-data-notice"/g) || []).length, 1);
  assert.equal(historicalForm(actualForm), normalizeLineEndings(originalForm));
  for (const lineEnding of ['\n', '\r\n']) {
    const formattedForm = normalizeLineEndings(actualForm).replace(/\n/g, lineEnding);
    assert.equal(historicalForm(formattedForm), normalizeLineEndings(originalForm));
  }
  const reader = html.indexOf('id="published-theories"');
  assert.ok(reader > html.indexOf('</form>'));
  assert.match(html, /<h2 id="published-theories-title">Théories publiées<\/h2>/);
  assert.match(html, /<label for="theories-story-select">Dossier à consulter<\/label>/);
  assert.match(html, /id="theories-refresh" class="btn" type="button" disabled/);
  assert.ok(html.indexOf('src="api.js"') < html.indexOf('src="app.js"'));
  assert.ok(html.indexOf('src="app.js"') < html.indexOf('src="theories-list.js"'));
  assert.doesNotMatch(html, /<style|style=/);
});

test('loading stories disables only reader controls and exposes loading status', async () => {
  const gate = deferred();
  const page = mount({ fetch: async () => { await gate.promise; return response(200, stories); } });
  try {
    assert.equal(page.section.attributes['aria-busy'], 'true');
    assert.ok(page.select.disabled && page.refresh.disabled);
    assert.match(page.feedback.textContent, /Chargement des dossiers/);
  } finally { gate.resolve(); await page.ready(); }
});

test('anonymous visitors get API dossier IDs without a session or a theory request', async () => {
  const page = mount(); await page.ready();
  assert.deepEqual(page.select.children.map(o => o.value), ['', '17', '42']);
  assert.equal(page.select.value, '');
  assert.equal(page.select.disabled, false);
  assert.equal(page.refresh.disabled, false);
  assert.deepEqual(page.calls.map(c => c.url), ['/api/v1/stories']);
  assert.match(page.feedback.textContent, /Choisissez un dossier/);
});

test('selection performs one GET for the selected dossier with cookie handling and no CSRF write', async () => {
  const page = mount(); await page.ready(); await page.choose(42);
  assert.equal(page.calls.at(-1).url, '/api/v1/stories/42/theories');
  assert.equal(page.calls.at(-1).method, 'GET');
  assert.equal(page.calls.at(-1).credentials, 'include');
  assert.equal(page.calls.at(-1).headers['X-CSRF-Token'], undefined);
  assert.ok(page.calls.at(-1).signal instanceof AbortSignal);
  assert.equal(page.list.children.length, 1);
  assert.equal(page.feedback.textContent, '');
});

test('theory title, paragraphs and UTC publication date are rendered safely', async () => {
  const page = mount(); await page.ready(); await page.choose(17);
  const card = page.list.children[0];
  assert.equal(card.querySelector('h3').textContent, 'Une piste');
  assert.equal(card.querySelector('time').dateTime, '2026-10-24T10:15:00.000Z');
  assert.match(card.querySelector('time').textContent, /12:15.*heure de Paris/);
  assert.deepEqual(card.querySelector('div').children.map(p => p.textContent),
    ['Premier paragraphe.', '', 'Deuxième paragraphe.']);
  assert.equal(card.style.overflowWrap, 'anywhere');
});

test('Actualiser reloads only the selected dossier and replaces the previous result', async () => {
  let reads = 0;
  const page = mount({ fetch: async url => url.endsWith('/stories') ?
    response(200, stories) : response(200, [theory(17, { title: 'Version ' + ++reads })]) });
  await page.ready(); await page.choose(17); await page.update();
  assert.equal(reads, 2);
  assert.equal(page.list.children.length, 1);
  assert.equal(page.list.children[0].querySelector('h3').textContent, 'Version 2');
  assert.equal(page.select.value, '17');
});

test('empty theory lists have an explicit empty state', async () => {
  const page = mount({ theories: [] }); await page.ready(); await page.choose(17);
  assert.equal(page.list.children.length, 0);
  assert.match(page.feedback.textContent, /Aucune théorie publiée/);
  assert.equal(page.section.attributes['aria-busy'], 'false');
  assert.equal(page.refresh.disabled, false);
});

test('empty dossier lists can be refreshed when stories become available', async () => {
  let reads = 0;
  const page = mount({ fetch: async () => response(200, ++reads === 1 ? [] : stories) });
  await page.ready();
  assert.ok(page.select.disabled);
  assert.match(page.feedback.textContent, /Aucun dossier/);
  await page.update();
  assert.equal(page.select.disabled, false);
  assert.deepEqual(page.select.children.map(o => o.value), ['', '17', '42']);
});

test('story loading network failures support an explicit retry', async () => {
  let reads = 0;
  const page = mount({ fetch: async () => {
    if (++reads === 1) throw new TypeError('Synthetic offline');
    return response(200, stories);
  } });
  await page.ready();
  assert.ok(page.select.disabled);
  assert.match(page.feedback.textContent, /Impossible de charger les dossiers/);
  await page.update();
  assert.equal(page.select.disabled, false);
  assert.equal(reads, 2);
});

for (const status of [401, 403, 500]) {
  test('story HTTP ' + status + ' is an error rather than an empty list', async () => {
    const page = mount({ fetch: async () => response(status, { message: 'Service indisponible.' }) });
    await page.ready();
    assert.match(page.feedback.textContent, /Impossible de charger les dossiers/);
    assert.doesNotMatch(page.feedback.textContent, /Aucun dossier n’est/);
    assert.ok(page.select.disabled);
    assert.equal(page.refresh.disabled, false);
  });
}

for (const invalid of [{}, [{ ...stories[0], id: 0 }], [{ ...stories[0], id: 2147483648 }],
  [stories[0], stories[0]], [{ ...stories[0], id: '17' }]]) {
  test('malformed or duplicate dossier IDs cannot be selected: ' + JSON.stringify(invalid), async () => {
    const page = mount({ stories: invalid }); await page.ready();
    assert.ok(page.select.disabled);
    assert.match(page.feedback.textContent, /Impossible de charger les dossiers/);
    assert.equal(page.calls.length, 1);
  });
}

for (const status of [400, 401, 403, 404, 500]) {
  test('theory HTTP ' + status + ' clears old data and keeps an explicit retry', async () => {
    let reads = 0;
    const page = mount({ fetch: async url => {
      if (url.endsWith('/stories')) return response(200, stories);
      return ++reads === 1 ? response(200, [theory()]) : response(status, { message: 'Refus simulé.' });
    } });
    await page.ready(); await page.choose(17); await page.update();
    assert.equal(page.list.children.length, 0);
    assert.match(page.feedback.textContent, status === 404 ? /dossier n’est plus disponible/ : /Impossible de charger les théories/);
    assert.doesNotMatch(page.feedback.textContent, /Aucune théorie publiée/);
    assert.equal(page.select.value, '17');
    assert.equal(page.refresh.disabled, false);
  });
}

test('network error while reading theories is visible and never claims an empty list', async () => {
  const page = mount({ fetch: async url => {
    if (url.endsWith('/stories')) return response(200, stories);
    throw new TypeError('Synthetic offline');
  } });
  await page.ready(); await page.choose(17);
  assert.match(page.feedback.textContent, /Impossible de contacter/);
  assert.equal(page.list.children.length, 0);
  assert.equal(page.refresh.disabled, false);
});

test('no selection or a fabricated ID performs no theory request', async () => {
  const page = mount(); await page.ready(); await page.update();
  for (const id of ['cc1', '0', '-1', '999', '17.5', '01', '1e1', '../17']) await page.choose(id);
  assert.equal(page.calls.length, 1);
  assert.equal(page.list.children.length, 0);
});

test('the GET helper rejects invalid IDs before fetch', async () => {
  const page = mount(); await page.ready();
  for (const id of ['17', 0, -1, 1.5, 2147483648, NaN, Infinity, null, {}]) {
    await assert.rejects(page.context.getStoryTheories(id), /dossier valide/);
  }
  assert.equal(page.calls.length, 1);
});

for (const status of [201, 202, 204]) {
  test('GET success status ' + status + ' is rejected instead of rendering data', async () => {
    const page = mount({ fetch: async url => url.endsWith('/stories') ?
      response(200, stories) : response(status, [theory()]) });
    await page.ready(); await page.choose(17);
    assert.match(page.feedback.textContent, /Réponse inattendue/);
    assert.equal(page.list.children.length, 0);
  });
}

for (const [name, payload] of [
  ['nonarray', {}], ['null row', [null]], ['wrong dossier', [theory(42)]],
  ['string ID', [theory(17, { id: '7' })]], ['zero ID', [theory(17, { id: 0 })]],
  ['overflow ID', [theory(17, { id: 2147483648 })]], ['title type', [theory(17, { title: {} })]],
  ['content type', [theory(17, { content: [] })]], ['date type', [theory(17, { created_at: {} })]],
  ['duplicate IDs', [theory(), theory()]]
]) {
  test('theory response validation rejects ' + name, async () => {
    const page = mount({ theories: payload }); await page.ready(); await page.choose(17);
    assert.match(page.feedback.textContent, /Réponse des théories invalide/);
    assert.equal(page.list.children.length, 0);
  });
}

test('unreadable theory JSON displays an error', async () => {
  const page = mount({ fetch: async url => url.endsWith('/stories') ? response(200, stories) : {
    status: 200, ok: true, async json() { throw new SyntaxError('Synthetic invalid JSON'); }
  } });
  await page.ready(); await page.choose(17);
  assert.match(page.feedback.textContent, /illisible/);
  assert.equal(page.list.children.length, 0);
});

for (const firstFails of [false, true]) {
  test('a late ' + (firstFails ? 'error' : 'success') + ' cannot overwrite the newly selected dossier', async () => {
    const gate = deferred();
    const page = mount({ fetch: async url => {
      if (url.endsWith('/stories')) return response(200, stories);
      if (url.includes('/17/')) {
        await gate.promise;
        return firstFails ? response(500, { message: 'Late error' }) :
          response(200, [theory(17, { title: 'Ancienne réponse' })]);
      }
      return response(200, [theory(42, { title: 'Dossier courant' })]);
    } });
    await page.ready();
    const old = page.choose(17);
    try {
      assert.equal(page.section.attributes['aria-busy'], 'true');
      await page.choose(42);
      assert.ok(page.calls[1].signal.aborted);
      gate.resolve(); await old;
      assert.equal(page.list.children[0].querySelector('h3').textContent, 'Dossier courant');
      assert.equal(page.feedback.textContent, '');
      assert.equal(page.section.attributes['aria-busy'], 'false');
    } finally { gate.resolve(); await old; }
  });
}

test('clearing the selection discards a pending result', async () => {
  const gate = deferred();
  const page = mount({ fetch: async url => {
    if (url.endsWith('/stories')) return response(200, stories);
    await gate.promise; return response(200, [theory()]);
  } });
  await page.ready(); const old = page.choose(17);
  try {
    await page.choose('');
    gate.resolve(); await old;
    assert.equal(page.list.children.length, 0);
    assert.match(page.feedback.textContent, /Choisissez un dossier/);
  } finally { gate.resolve(); await old; }
});

test('untrusted story titles and theory text are never parsed as HTML', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const page = mount({
    stories: [{ ...stories[0], title: attack }],
    theories: [theory(17, { title: attack, content: '<script>alert(1)</script>\n' + attack })]
  });
  await page.ready(); await page.choose(17);
  assert.equal(page.select.children[1].textContent, attack);
  const card = page.list.children[0];
  assert.equal(card.querySelector('h3').textContent, attack);
  assert.deepEqual(card.querySelector('div').children.map(p => p.textContent), ['<script>alert(1)</script>', attack]);
  assert.ok(!page.tags.some(tag => ['img', 'script'].includes(tag)));
});

for (const date of [null, 'bad date', '<img src=x onerror=alert(1)>']) {
  test('unusable publication date has a neutral fallback: ' + String(date), async () => {
    const page = mount({ theories: [theory(17, { created_at: date })] });
    await page.ready(); await page.choose(17);
    assert.equal(page.list.children[0].querySelector('time').textContent, 'Date indisponible');
  });
}

test('the script makes no request on a page without the reader section', () => {
  let calls = 0;
  vm.runInNewContext(readerSource, {
    document: { getElementById: () => null },
    getStories() { calls++; throw new Error('Unexpected request'); }
  }, { timeout: 1000 });
  assert.equal(calls, 0);
});

test('the reader coexists with real creation handlers without changing their inputs or POST contract', async () => {
  const page = mount({ withCreation: true }); await page.ready();
  await page.choose(42);
  const form = page.creation;
  assert.equal(form.events.get('submit').length, 1);
  form.elements.story_id.value = '17';
  form.elements.title.value = 'Titre conservé';
  form.elements.content.value = 'Analyse conservée';
  await page.update();
  assert.equal(form.elements.title.value, 'Titre conservé');
  assert.equal(form.elements.story_id.value, '17');
  await form.emit('submit');
  const posts = page.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/v1/stories/17/theories');
  assert.deepEqual(JSON.parse(posts[0].body), { title: 'Titre conservé', content: 'Analyse conservée' });
  assert.ok(posts[0].headers['X-CSRF-Token']);
  assert.equal(form.resets, 1);
  assert.equal(form.feedback.textContent, 'Théorie publiée.');
  assert.equal(page.select.value, '42');
  assert.equal(page.list.children[0].querySelector('h3').textContent, 'Une piste');
  assert.equal(page.calls.filter(call => call.url === '/api/v1/me').length, 1);
});
