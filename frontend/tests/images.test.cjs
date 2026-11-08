'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const originals = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tools/fixtures/dossiers_historiques.json'), 'utf8')).stories;
const supplied = {
  'golden-state-killer': ['golden-state-killer.png', 1672, 941, '22a4a7ee470467387899b6d219cb4da176c2ccea5161a386c27d06f2fdcb1b19'],
  'chris-watts': ['chris-watts.png', 1672, 941, '7f9d22a3fab83a7132a681219090c12ea8baa7b454360ac941a1f13dceebf882'],
  'michelle-carter': ['michelle-carter.png', 1672, 941, '1422c6c62f8a7ad1c682c31a69bea1b54a290cbd1f2b583ee3cda857641cbd03'],
  'anthonioz': ['mystere-anthonioz.png', 1671, 941, '0bb8a5acda51b27eb9851b683c2d54aeb11d9a038e99277d79720cac7e969745'],
  'noirval': ['inconnue-noirval.png', 1671, 941, 'a6c804d070f172121ba1f04397bb6acd590b2eedc527375c7cfa8cd2c502c2b1'],
  'manoir-de-l-ombre': ['manoir-ombre.png', 1670, 941, '5fdb88f47e82844df2d479c0fbb9e9413c98286a9c992fef5238c614a5e675d2']
};
const slugs = [
  'demo-f32-20261024-v1-tableau-salle-bleue',
  'demo-f32-20261024-v1-medaille-pavillon-ferme',
  'demo-f32-20261024-v1-malle-quai-silencieux',
  'demo-f32-20261024-v1-carnet-tour-nord'
];
const names = ['tableau-salle-bleue', 'medaille-pavillon-ferme', 'malle-quai-silencieux', 'carnet-tour-nord'];
const rows = slugs.map((slug, i) => ({
  id: i + 1, slug, category_id: i < 2 ? 1 : 2,
  title: i === 1 ? 'La médaille' : 'Dossier ' + i,
  summary: 'Résumé ' + i, content: 'Premier paragraphe.\n\nDeuxième paragraphe.',
  image_url: null
}));
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.className = ''; this.children = [];
    this.style = {}; this.dataset = {}; this.attributes = {};
    this.events = new Map(); this.textContent = ''; this.value = '';
    this.hidden = false; this.disabled = false;
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { this.events.set(type, handler); }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}
function page(options = {}) {
  const nodes = new Map(), list = options.type ? new Element() : null;
  if (list) {
    list.dataset.storyType = options.type;
    for (const id of ['stories-feedback', 'recherche', 'aucun-resultat']) nodes.set(id, new Element());
    nodes.get('aucun-resultat').hidden = true;
  }
  if (options.detail) {
    for (const id of ['detail-titre', 'detail-categorie', 'detail-resume', 'detail-contenu', 'detail-feedback', 'retour-dossier', 'detail-image']) nodes.set(id, new Element());
    nodes.get('detail-titre').parentElement = new Element();
    nodes.get('detail-image').hidden = true;
  }
  const document = {
    baseURI: 'http://portfolio.test/',
    createElement: tag => new Element(tag),
    querySelector: selector => selector === '[data-story-type]' ? list : null,
    querySelectorAll: () => [],
    getElementById: id => nodes.get(id) || null
  };
  const noNetwork = () => { throw new Error('NETWORK_FORBIDDEN'); };
  const context = vm.createContext({
    document, URL, URLSearchParams, fetch: noNetwork,
    XMLHttpRequest: noNetwork, WebSocket: noNetwork,
    location: { search: options.detail ? '?slug=' + rows[0].slug : '' },
    getStories: async () => {
      if (options.error) throw new Error('Erreur simulée');
      return options.rows || rows;
    },
    getStoryBySlug: async () => {
      if (options.error) throw Object.assign(new Error('Absent'), { status: 404 });
      return rows[0];
    }
  });
  vm.runInContext(source, context, { filename: 'frontend/app.js', timeout: 1000 });
  return { context, nodes, list };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

test('API image has priority, then local file, then default', () => {
  const p = page();
  assert.deepEqual(Array.from(p.context.getStoryImageSources({ ...rows[0], image_url: ' https://images.example.test/custom.webp ' })), [
    'https://images.example.test/custom.webp', 'images/tableau-salle-bleue.webp', 'images/default-story.svg'
  ]);
  assert.equal(p.context.getStoryImageSources({ ...rows[0], image_url: '/images/custom.webp' })[0], '/images/custom.webp');
});

test('four NULL-image demo slugs select the four expected local files', () => {
  const p = page();
  rows.forEach((row, i) => assert.deepEqual(Array.from(p.context.getStoryImageSources(row)), [
    'images/' + names[i] + '.webp', 'images/default-story.svg'
  ]));
});

test('unknown slug and blank API value select only the default', () => {
  const p = page();
  assert.deepEqual(Array.from(p.context.getStoryImageSources({ slug: 'unknown', image_url: ' ' })), ['images/default-story.svg']);
});

test('non-web image schemes are ignored and identical sources are deduplicated', () => {
  const p = page();
  for (const image_url of ['javascript:alert(1)', 'data:image/svg+xml,test', 'file:///private.jpg']) {
    assert.equal(p.context.getStoryImageSources({ ...rows[0], image_url })[0], 'images/tableau-salle-bleue.webp');
  }
  assert.deepEqual(Array.from(p.context.getStoryImageSources({ ...rows[0], image_url: 'images/tableau-salle-bleue.webp' })), [
    'images/tableau-salle-bleue.webp', 'images/default-story.svg'
  ]);
});

test('error chain tries API, local, default, then stops with readable text', () => {
  const p = page();
  const frame = p.context.createStoryImage({ ...rows[0], image_url: '/images/missing.webp' });
  const image = frame.querySelector('img'), fail = image.events.get('error');
  assert.equal(image.src, '/images/missing.webp');
  fail(); assert.equal(image.src, 'images/tableau-salle-bleue.webp');
  fail(); assert.equal(image.src, 'images/default-story.svg');
  assert.match(image.alt, /Image à venir/);
  fail(); assert.equal(image.hidden, true);
  assert.equal(frame.querySelector('p').textContent, 'Image indisponible');
  const count = frame.children.length;
  fail(); fail();
  assert.equal(frame.children.length, count);
  assert.equal(image.src, 'images/default-story.svg');
});

test('image dimensions, decoding, alt and lazy/eager policy are explicit', () => {
  const p = page();
  const cardImage = p.context.createStoryImage(rows[0]).querySelector('img');
  const detailImage = p.context.createStoryImage(rows[0], true).querySelector('img');
  assert.equal(cardImage.width, 1200); assert.equal(cardImage.height, 675);
  assert.equal(cardImage.decoding, 'async'); assert.equal(cardImage.loading, 'lazy');
  assert.equal(detailImage.loading, 'eager');
  assert.ok(cardImage.alt.includes(rows[0].title));
});

for (const [type, category] of [['resolved', 1], ['coldcase', 2]]) {
  test(type + ': two correct stories with images, category labels and dossier links', async () => {
    const p = page({ type });
    await settle();
    assert.equal(p.list.children.length, 2);
    const expected = rows.filter(r => r.category_id === category);
    p.list.children.forEach((card, i) => {
      assert.equal(card.querySelector('h3').textContent, expected[i].title);
      assert.equal(card.querySelector('img').src, 'images/' + names[expected[i].id - 1] + '.webp');
      assert.equal(card.querySelector('a').href, 'dossier.html?slug=' + expected[i].slug);
    });
    assert.equal(p.nodes.get('stories-feedback').textContent, '');
  });
}

test('home limit and search remain unchanged after adding images', async () => {
  const home = page({ type: 'all' });
  const resolved = page({ type: 'resolved' });
  await settle();
  assert.equal(home.list.children.length, 3);
  const input = resolved.nodes.get('recherche');
  input.value = ' MÉDAILLE '; input.events.get('input')();
  assert.equal(resolved.list.children.length, 1);
  assert.equal(resolved.list.children[0].querySelector('h3').textContent, 'La médaille');
  input.value = 'absent'; input.events.get('input')();
  assert.equal(resolved.list.children.length, 0);
  assert.equal(resolved.nodes.get('aucun-resultat').hidden, false);
  input.value = ''; input.events.get('input')();
  assert.equal(resolved.list.children.length, 2);
});

test('empty and failing lists keep their existing feedback and loading state', async () => {
  const empty = page({ type: 'resolved', rows: [] });
  const error = page({ type: 'resolved', error: true });
  await settle();
  assert.equal(empty.nodes.get('stories-feedback').textContent, 'Aucune histoire n’est disponible pour le moment.');
  assert.equal(error.nodes.get('stories-feedback').textContent, 'Erreur simulée');
  assert.equal(error.list.attributes['aria-busy'], 'false');
  assert.equal(error.nodes.get('recherche').disabled, true);
});

test('detail image appears only after successful loading, with original content and return link', async () => {
  const p = page({ detail: true });
  assert.equal(p.nodes.get('detail-image').hidden, true);
  await settle();
  assert.equal(p.nodes.get('detail-image').hidden, false);
  assert.equal(p.nodes.get('detail-image').querySelector('img').loading, 'eager');
  assert.equal(p.nodes.get('detail-titre').textContent, rows[0].title);
  assert.equal(p.nodes.get('retour-dossier').href, 'histoires.html');
  assert.deepEqual(p.nodes.get('detail-contenu').children.map(n => n.textContent), rows[0].content.split(/\r?\n/));
});

test('detail failure keeps the image hidden and preserves the 404 message', async () => {
  const p = page({ detail: true, error: true });
  await settle();
  assert.equal(p.nodes.get('detail-image').hidden, true);
  assert.equal(p.nodes.get('detail-feedback').textContent, 'Ce dossier n’existe pas.');
});

for (const original of originals) {
  const [filename, width, height, hash] = supplied[original.slug];
  test(original.slug + ': supplied bytes remain PNG with the original dimensions and fingerprint', () => {
    const bytes = fs.readFileSync(path.join(__dirname, '../images', filename));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), hash);
  });
  test(original.slug + ': slug selects its illustration independently of id or list position', () => {
    const p = page();
    assert.deepEqual(Array.from(p.context.getStoryImageSources({ ...original, id: 999 })), [
      'images/' + filename, 'images/default-story.svg'
    ]);
    const figure = p.context.createStoryImage(original);
    const image = figure.querySelector('img'), caption = figure.querySelector('figcaption');
    assert.equal(figure.tagName, 'figure'); assert.equal(image.src, 'images/' + filename);
    assert.equal(image.width, width); assert.equal(image.height, height);
    assert.equal(figure.querySelector('.story-media').style.aspectRatio, width + ' / ' + height);
    assert.equal(image.loading, 'lazy'); assert.equal(caption.hidden, false);
    assert.equal(caption.textContent, 'Illustration générée par IA');
    assert.match(image.alt, /Illustration générée par IA/);
    const detail = p.context.createStoryImage(original, true);
    assert.equal(detail.querySelector('img').loading, 'eager');
    assert.match(detail.querySelector('figcaption').textContent, /sans valeur de photographie ou de preuve authentique/);
  });
  test(original.slug + ': unavailable illustration uses the neutral SVG without attributing AI provenance', () => {
    const p = page(), figure = p.context.createStoryImage(original, true);
    const image = figure.querySelector('img'), caption = figure.querySelector('figcaption');
    const fail = image.events.get('error');
    fail(); assert.equal(image.src, 'images/default-story.svg');
    assert.equal(image.width, 1200); assert.equal(image.height, 675);
    assert.equal(caption.hidden, true); assert.match(image.alt, /^Image à venir/);
    assert.equal(figure.querySelector('.story-media').dataset.illustration, 'false');
    fail(); assert.equal(image.hidden, true);
    assert.equal(figure.querySelector('p').textContent, 'Image indisponible');
    const count = figure.querySelector('.story-media').children.length;
    fail(); fail(); assert.equal(figure.querySelector('.story-media').children.length, count);
  });
}

test('another API source keeps priority without inheriting an AI attribution', () => {
  const p = page(), figure = p.context.createStoryImage({ ...originals[0], image_url: '/images/other-source.png' });
  const image = figure.querySelector('img'), caption = figure.querySelector('figcaption');
  assert.equal(image.src, '/images/other-source.png'); assert.equal(caption.hidden, true);
  assert.doesNotMatch(image.alt, /générée par IA/);
  image.events.get('error')();
  assert.equal(image.src, 'images/golden-state-killer.png'); assert.equal(caption.hidden, false);
  assert.equal(image.width, 1672);
});

test('the same known API image in absolute form still gets its exact dimensions and AI notice', () => {
  const p = page();
  const figure = p.context.createStoryImage({ ...originals[0], image_url: 'http://portfolio.test/images/golden-state-killer.png' });
  assert.equal(figure.querySelector('img').width, 1672);
  assert.equal(figure.querySelector('figcaption').hidden, false);
});

for (const slug of ['__proto__', 'constructor', 'toString']) {
  test('an inherited property is never mistaken for an illustration: ' + slug, () => {
    const p = page(), frame = p.context.createStoryImage({ ...originals[0], slug });
    assert.equal(frame.querySelector('img').src, 'images/default-story.svg');
    assert.equal(frame.querySelector('figcaption'), null);
  });
}
