'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const sources = Object.fromEntries(['api.js', 'comments.js', 'app.js', 'dossier.html', 'styles.css']
  .map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });
const comment = (id = 31, changes = {}) => ({ id, story_id: 17, user_id: 5,
  username: 'Auteur isolé', text: 'Contribution réelle du contrat, simulée ici.', created_at: null, ...changes });
const report = (id = 31, changes = {}) => ({ status: 'success', report: {
  id: 9, type: 'comment', target_id: String(id), reason: 'Motif isolé', status: 'pending', ...changes
} });
const session = { user: { id: 5 }, csrf_token: 'csrf-fictif-isole' };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = new Map(); this.attributes = {};
    this.style = {}; this.dataset = {}; this.value = ''; this.disabled = false; this.hidden = false; this._text = '';
    Object.defineProperty(this, 'innerHTML', { set() { throw Error('HTML interdit'); }, get() { throw Error('HTML interdit'); } });
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, handler) { this.events.set(name, [...(this.events.get(name) || []), handler]); }
  async emit(name, extra = {}) {
    // Déclencher même un contrôle désactivé vérifie aussi les gardes JavaScript.
    await Promise.all((this.events.get(name) || []).map(handler => handler({ preventDefault() {}, ...extra })));
  }
  querySelectorAll(tag) { return this.children.flatMap(child => [
    ...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)
  ]); }
  querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
  focus() { this.focused = true; }
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function mount(options = {}) {
  const ids = new Map();
  for (const id of ['story-comments', 'comments-list', 'comments-refresh', 'comments-feedback',
    'comment-form', 'comment-text', 'comment-send', 'comment-feedback', 'report-form', 'report-target',
    'report-reason', 'report-send', 'report-cancel', 'report-feedback']) ids.set(id, new Element());
  ids.get('story-comments').hidden = ids.get('report-form').hidden = true;
  if (options.withApp) {
    for (const id of ['detail-titre', 'detail-feedback', 'detail-categorie', 'detail-resume',
      'detail-image', 'detail-contenu', 'retour-dossier']) ids.set(id, new Element());
    ids.get('detail-titre').parentElement = new Element();
  }
  const calls = [], tags = [], timers = new Map();
  const window = new Element();
  let nextTimer = 0;
  const context = vm.createContext({
    AbortController, TextEncoder, URLSearchParams, URL, window,
    location: { search: options.search === undefined ? '?slug=dossier-isole' : options.search },
    setTimeout: options.fakeTimers ? fn => { timers.set(++nextTimer, fn); return nextTimer; } : setTimeout,
    clearTimeout: options.fakeTimers ? id => timers.delete(id) : clearTimeout,
    document: {
      baseURI: 'http://invalid.test/dossier.html',
      getElementById: id => ids.get(id) || null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement(tag) { tags.push(tag); return new Element(tag); }
    },
    async fetch(url, request) {
      const method = request.method || 'GET';
      // Ni administration, ni stats, ni signalement d'histoire dans le parcours public.
      assert.ok(['/api/v1/me', '/api/v1/stories/17/comments', '/api/v1/stories/slug/dossier-isole',
        '/api/v1/comments/31/report', '/api/v1/comments/42/report'].includes(url), 'Route inattendue : ' + url);
      calls.push({ url, ...request, method });
      const result = options.fetch && await options.fetch(url, request, calls);
      if (result !== undefined) return result;
      if (url === '/api/v1/me') return response(200, session);
      if (url.includes('/slug/')) return response(200, { id: 17, category_id: options.category || 1,
        slug: 'dossier-isole', title: 'Titre isolé', summary: 'Résumé', content: 'Contenu' });
      if (method === 'GET') return response(200, options.comments === undefined ? [comment()] : options.comments);
      if (url.endsWith('/report')) return response(201, report(Number(url.split('/')[4])));
      return response(201, { status: 'success', comment: comment(72, { text: JSON.parse(request.body).text }) });
    }
  });
  vm.runInContext(sources['api.js'], context);
  vm.runInContext(sources['comments.js'], context);
  if (options.withApp) vm.runInContext(sources['app.js'], context);
  else if (!options.noMount) vm.runInContext('mountStoryComments(17)', context);
  const get = id => ids.get(id);
  return { context, calls, tags, window, get, timers,
    ready: settle,
    buttons: () => get('comments-list').querySelectorAll('button'),
    write(value = 'Mon commentaire') { get('comment-text').value = value; return get('comment-form').emit('submit'); },
    async select(index = 0) { await this.buttons()[index].emit('click'); },
    sendReason(value = 'Motif isolé') { get('report-reason').value = value; return get('report-form').emit('submit'); },
    posts: () => calls.filter(c => c.method === 'POST')
  };
}

test('HTML : notices avant champs, labels, confirmation, scripts dans le bon ordre, formulaires hors démonstration', () => {
  const html = sources['dossier.html'];
  for (const [form, field, notice] of [['comment', 'text', 'comment-data-notice'], ['report', 'reason', 'report-data-notice']]) {
    const markup = html.match(new RegExp('<form id="' + form + '-form"[\\s\\S]*?</form>'))[0];
    assert.doesNotMatch(markup, /demo-form/);
    assert.ok(markup.indexOf('id="' + notice + '"') < markup.indexOf('<textarea'));
    assert.match(markup, new RegExp('<label for="' + form + '-' + field + '"'));
    assert.match(markup, /required aria-describedby=/);
  }
  assert.match(html, /Confirmer le signalement/);
  assert.match(html, /65 535 octets UTF-8/);
  assert.ok(html.indexOf('src="api.js"') < html.indexOf('src="comments.js"'));
  assert.ok(html.indexOf('src="comments.js"') < html.indexOf('src="app.js"'));
  assert.match(sources['styles.css'], /\.story-comments\[hidden\],\.story-comments \[hidden\]\s*\{\s*display:none/);
  assert.doesNotMatch(html, /CONFIDENTIALITE_LOT|consentement|type="checkbox"/);
});

test('lecture publique utilise le vrai dossier sans /me et sans données administrateur', async () => {
  const page = mount(); await page.ready();
  assert.deepEqual(page.calls.map(c => c.url), ['/api/v1/stories/17/comments']);
  assert.equal(page.calls[0].credentials, 'include');
  assert.equal(page.calls[0].headers['X-CSRF-Token'], undefined);
  assert.equal(page.get('comments-list').children.length, 1);
  assert.equal(page.get('comment-send').disabled, false);
});

test('liste vide valide : message explicite et création disponible', async () => {
  const page = mount({ comments: [] }); await page.ready();
  assert.match(page.get('comments-feedback').textContent, /Aucun commentaire/);
  assert.equal(page.get('comment-send').disabled, false);
});

test('XSS : texte et pseudonyme restent du texte, les données de modération ne sont pas affichées', async () => {
  const attack = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const page = mount({ comments: [comment(31, { username: attack, text: attack,
    reports: 99, reason: 'DONNEE_ADMIN', status: 'pending' })] }); await page.ready();
  assert.equal(page.get('comments-list').children[0].querySelector('h3').textContent, attack);
  assert.match(page.get('comments-list').textContent, /<script>/);
  assert.doesNotMatch(page.get('comments-list').textContent, /DONNEE_ADMIN|pending|99/);
  assert.ok(!page.tags.some(tag => ['img', 'script', 'iframe'].includes(tag)));
  await page.select();
  assert.match(page.get('report-target').textContent, /<script>/);
});

test('ancien auteur sans référence ni pseudonyme : Anonyme', async () => {
  const page = mount({ comments: [comment(31, { user_id: null, username: null })] }); await page.ready();
  assert.equal(page.get('comments-list').children[0].querySelector('h3').textContent, 'Anonyme');
});

for (const [label, body] of [['objet', {}], ['autre dossier', [comment(31, { story_id: 42 })]],
  ['doublons', [comment(), comment()]], ['id négatif', [comment(-1)]],
  ['auteur invalide', [comment(31, { user_id: '5' })]], ['texte absent', [comment(31, { text: null })]]]) {
  test('lecture incohérente refusée : ' + label, async () => {
    const page = mount({ comments: body }); await page.ready();
    assert.equal(page.get('comments-list').children.length, 0);
    assert.equal(page.get('comment-send').disabled, true);
    assert.match(page.get('comments-feedback').textContent, /Lecture impossible/);
  });
}

test('GET en attente : écriture bloquée ; actualisation après erreur restaure la liste', async () => {
  let failing = true;
  const gate = deferred();
  const page = mount({ fetch: async () => { await gate.promise; return failing ? response(500, {}) : undefined; } });
  assert.equal(page.get('comment-send').disabled, true);
  await page.write(); assert.equal(page.posts().length, 0);
  gate.resolve(); await page.ready();
  failing = false;
  await page.get('comments-refresh').emit('click');
  assert.equal(page.get('comments-list').children.length, 1);
});

test('création : /me puis un POST avec CSRF, cookies et seulement text ; affichage confirmé puis GET', async () => {
  let saved;
  const page = mount({ fetch(url, request) {
    if (request.method === 'POST') { saved = comment(72, { text: JSON.parse(request.body).text });
      return response(201, { status: 'success', comment: saved }); }
    if (saved && url.endsWith('/comments')) return response(200, [comment(), saved]);
  } }); await page.ready();
  await page.write('  Texte publié\nDeuxième ligne  ');
  const post = page.posts()[0];
  assert.equal(page.calls.at(-2).url, '/api/v1/me');
  assert.equal(post.url, '/api/v1/stories/17/comments');
  assert.equal(post.credentials, 'include');
  assert.equal(post.headers['X-CSRF-Token'], session.csrf_token);
  assert.deepEqual(JSON.parse(post.body), { text: 'Texte publié\nDeuxième ligne' });
  assert.equal(page.get('comment-feedback').textContent, 'Commentaire publié.');
  assert.equal(page.get('comment-text').value, '');
  assert.match(page.get('comments-list').textContent, /Texte publié/);
  await page.get('comments-refresh').emit('click');
  assert.match(page.get('comments-list').textContent, /Texte publié/);
  assert.equal(page.posts().length, 1);
});

test('signalement : cible exacte du second commentaire et confirmation explicite', async () => {
  const page = mount({ comments: [comment(), comment(42)] }); await page.ready(); await page.select(1);
  assert.equal(page.posts().length, 0);
  assert.equal(page.get('report-form').hidden, false);
  assert.match(page.get('report-target').textContent, /n° 42/);
  assert.equal(page.get('report-reason').focused, true);
  await page.sendReason('  À vérifier  ');
  const post = page.posts()[0];
  assert.equal(post.url, '/api/v1/comments/42/report');
  assert.deepEqual(JSON.parse(post.body), { reason: 'À vérifier' });
  assert.equal(post.headers['X-CSRF-Token'], session.csrf_token);
  assert.equal(page.get('report-feedback').textContent, 'Votre signalement a été pris en compte.');
  assert.equal(page.get('report-form').hidden, true);
  assert.equal(page.get('comments-list').children.length, 2);
});

test('la cible ne change pas silencieusement et Annuler ne crée rien', async () => {
  const page = mount({ comments: [comment(), comment(42)] }); await page.ready(); await page.select();
  await page.select(1);
  assert.match(page.get('report-target').textContent, /n° 31/);
  await page.get('report-cancel').emit('click');
  assert.equal(page.get('report-form').hidden, true);
  assert.equal(page.posts().length, 0);
  await page.select(1);
  assert.match(page.get('report-target').textContent, /n° 42/);
});

test('pas de règle de doublon inventée : un nouvel envoi volontaire reste possible après succès', async () => {
  const page = mount(); await page.ready();
  for (let i = 0; i < 2; i++) { await page.select(); await page.sendReason(); }
  assert.equal(page.posts().length, 2);
});

for (const kind of ['comment', 'report']) {
  const prepare = async page => { await page.ready(); if (kind === 'report') await page.select(); };
  const send = (page, value) => kind === 'comment' ? page.write(value) : page.sendReason(value);
  const feedback = page => page.get(kind + '-feedback').textContent;
  const draft = page => page.get(kind === 'comment' ? 'comment-text' : 'report-reason');
  for (const user of [{ id: 1, is_admin: true }, { id: 2, is_admin: false }, { id: 3, is_admin: false }]) {
    test(kind + ' : session permanente simulée id ' + user.id, async () => {
      const page = mount({ fetch: url => url.endsWith('/me') ?
        response(200, { user, csrf_token: 'session-simulee-' + user.id }) : undefined });
      await prepare(page); await send(page);
      assert.equal(feedback(page), kind === 'comment' ? 'Commentaire publié.' : 'Votre signalement a été pris en compte.');
      assert.equal(page.posts().length, 1);
      assert.equal(page.posts()[0].headers['X-CSRF-Token'], 'session-simulee-' + user.id);
    });
  }
  for (const [label, value] of [['vide', ' \n '], ['UTF-8 trop long', 'é'.repeat(32768)], ['demi-surrogate', '\ud800']]) {
    test(kind + ' : validation ' + label + ' sans requête /me ni POST', async () => {
      const page = mount(); await prepare(page); await send(page, value);
      assert.equal(page.calls.length, 1);
      assert.equal(draft(page).value, value);
      assert.doesNotMatch(feedback(page), /Commentaire publié\.|Votre signalement a été pris en compte\./);
    });
  }
  test(kind + ' : limite UTF-8 acceptée, emoji valide', async () => {
    const page = mount(); await prepare(page); await send(page, '😀' + 'a'.repeat(65531));
    assert.equal(page.posts().length, 1);
    assert.equal(feedback(page), kind === 'comment' ? 'Commentaire publié.' : 'Votre signalement a été pris en compte.');
  });
  for (const status of [401, 403]) {
    test(kind + ' : /me refuse ' + status + ', aucun POST et brouillon conservé', async () => {
      const page = mount({ fetch: url => url.endsWith('/me') ? response(status, {}) : undefined });
      await prepare(page); await send(page, 'Brouillon');
      assert.equal(page.posts().length, 0);
      assert.equal(draft(page).value, 'Brouillon');
      assert.match(feedback(page), status === 401 ? /Connectez-vous/ : /refusé/);
    });
  }
  test(kind + ' : /me sans jeton empêche le POST', async () => {
    const page = mount({ fetch: url => url.endsWith('/me') ? response(200, { user: { id: 5 } }) : undefined });
    await prepare(page); await send(page);
    assert.equal(page.posts().length, 0);
    assert.match(feedback(page), /Session invalide/);
  });
  for (const status of [400, 401, 403, 404, 409]) {
    test(kind + ' : refus POST HTTP ' + status + ' sans réussite ni perte du texte', async () => {
      const page = mount({ fetch: (url, request) => request.method === 'POST' ? response(status, { message: 'Refus serveur' }) : undefined });
      await prepare(page); await send(page, 'Brouillon');
      assert.equal(page.posts().length, 1);
      assert.equal(draft(page).value, 'Brouillon');
      assert.doesNotMatch(feedback(page), /Commentaire publié\.|Votre signalement a été pris en compte\./);
      if (status === 404) assert.equal(page.get('comments-list').children.length, 0);
    });
  }
  test(kind + ' : double clic pendant /me, changement de cible et rafraîchissement bloqués', async () => {
    const gate = deferred();
    const page = mount({ fetch: async url => { if (url.endsWith('/me')) { await gate.promise; return response(200, session); } } });
    await prepare(page);
    const first = send(page);
    await send(page); await page.get('comments-refresh').emit('click');
    await page.get('report-cancel').emit('click');
    assert.equal(page.calls.filter(c => c.url.endsWith('/me')).length, 1);
    assert.equal(page.posts().length, 0);
    gate.resolve(); await first;
    assert.equal(page.posts().length, 1);
  });
  test(kind + ' : un POST en attente ne donne pas de réussite et bloque le second envoi', async () => {
    const gate = deferred();
    const page = mount({ fetch: async (url, request) => {
      if (request.method === 'POST') { await gate.promise; return undefined; }
    } });
    await prepare(page); const pending = send(page, 'Brouillon'); await settle();
    assert.equal(page.posts().length, 1);
    assert.match(feedback(page), /Envoi en cours/);
    assert.equal(draft(page).value, 'Brouillon');
    await send(page); assert.equal(page.posts().length, 1);
    gate.resolve(); await pending;
    assert.equal(feedback(page), kind === 'comment' ? 'Commentaire publié.' : 'Votre signalement a été pris en compte.');
  });
  for (const mode of ['réseau', '500', '200 inattendu', 'JSON illisible', 'JSON incohérent', 'timeout']) {
    test(kind + ' : résultat incertain après ' + mode + ', aucune relance ni succès', async () => {
      const page = mount({ fakeTimers: mode === 'timeout', fetch: (url, request) => {
        if (request.method !== 'POST') return;
        if (mode === 'réseau') throw Error('offline');
        if (mode === '500') return response(500, {});
        if (mode === '200 inattendu') return response(200, {});
        if (mode === 'JSON illisible') return { ...response(201, {}), json() { throw new SyntaxError(); } };
        if (mode === 'timeout') return new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(Error('abort')), { once: true });
        });
        return response(201, kind === 'comment' ? { status: 'success', comment: comment(72, { story_id: 99 }) } : report(42));
      } });
      await prepare(page);
      const pending = send(page, 'Brouillon');
      await settle();
      if (mode === 'timeout') for (const fn of page.timers.values()) fn();
      await pending;
      assert.match(feedback(page), /Résultat incertain/);
      assert.doesNotMatch(feedback(page), /Commentaire publié\.|Votre signalement a été pris en compte\./);
      assert.equal(draft(page).value, 'Brouillon');
      await send(page); assert.equal(page.posts().length, 1);
      if (kind === 'report') await page.get('report-cancel').emit('click');
      await page.get('comments-refresh').emit('click');
      assert.equal(page.posts().length, 1);
      assert.match(feedback(page), /Résultat incertain/);
    });
  }
}

test('quitter pendant /me empêche toute écriture ; retour cache exige un rechargement', async () => {
  const gate = deferred();
  const page = mount({ fetch: async url => { if (url.endsWith('/me')) { await gate.promise; return response(200, session); } } });
  await page.ready(); const pending = page.write();
  await page.window.emit('pagehide'); gate.resolve(); await pending;
  assert.equal(page.posts().length, 0);
  await page.window.emit('pageshow', { persisted: true });
  assert.match(page.get('comments-feedback').textContent, /rechargez-la/);
  assert.equal(page.get('comment-send').disabled, true);
});

test('lecture abandonnée ne réaffiche pas des données après pagehide', async () => {
  const gate = deferred();
  const page = mount({ fetch: async () => { await gate.promise; return response(200, [comment()]); } });
  await page.window.emit('pagehide'); gate.resolve(); await page.ready();
  assert.equal(page.get('comments-list').children.length, 0);
  assert.equal(page.calls[0].signal.aborted, true);
});

test('un dossier archivé refuse lecture et écriture ; restauration détectée par Actualiser', async () => {
  let archived = true;
  const page = mount({ fetch: url => url.endsWith('/comments') && archived ? response(404, {}) : undefined });
  await page.ready();
  assert.match(page.get('comments-feedback').textContent, /plus disponible/);
  await page.write(); assert.equal(page.posts().length, 0);
  archived = false; await page.get('comments-refresh').emit('click');
  assert.equal(page.get('comment-send').disabled, false);
});

for (const category of [1, 2]) {
  test('app.js : dossier catégorie ' + category + ' initialise le panneau avec son id réel', async () => {
    const page = mount({ withApp: true, category }); await page.ready();
    assert.equal(page.get('detail-titre').textContent, 'Titre isolé');
    assert.equal(page.get('story-comments').hidden, false);
    assert.equal(page.get('retour-dossier').href, category === 1 ? 'histoires.html' : 'coldcases.html');
    assert.deepEqual(page.calls.map(c => c.url), ['/api/v1/stories/slug/dossier-isole', '/api/v1/stories/17/comments']);
  });
}

for (const search of ['', '?slug=dossier-isole']) {
  test('app.js : dossier absent ou archivé ne monte pas le panneau, URL ' + search, async () => {
    const page = mount({ withApp: true, search, fetch: () => response(404, {}) }); await page.ready();
    assert.equal(page.get('story-comments').hidden, true);
    assert.equal(page.calls.filter(c => c.url.endsWith('/comments')).length, 0);
  });
}

test('autres pages : aucune initialisation, aucun appel réseau ; montage répété sans doublon', async () => {
  const page = mount({ noMount: true }); await page.ready(); assert.equal(page.calls.length, 0);
  vm.runInContext('mountStoryComments(17); mountStoryComments(17)', page.context); await page.ready();
  assert.equal(page.calls.length, 1);
});
