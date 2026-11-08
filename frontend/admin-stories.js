'use strict';

// Les compteurs gardent leur source publique active ; les archives proviennent
// d'une lecture privée distincte. Le tableau coordonne toute relecture globale.
function createAdminStoriesPanel({ reload } = {}) {
  const section = document.getElementById('admin-stories');
  if (!section) return null;
  const search = document.getElementById('admin-stories-search');
  const filter = document.getElementById('admin-stories-filter');
  const otherOption = document.getElementById('admin-stories-other');
  const feedback = document.getElementById('admin-stories-feedback');
  const list = document.getElementById('admin-stories-list');
  const state = document.getElementById('admin-stories-state');
  const archiveCount = document.getElementById('admin-archives-count');
  let stories = [];
  let ready = false;
  let version = 0;
  let pending = false;
  let operation = null;
  let accessOptions = {};
  let closeDeletionDialog = null;
  let deleteFocusId = null;
  let deleteFocusButton = null;

  function clear() {
    version += 1;
    closeDeletionDialog?.();
    closeDeletionDialog = null;
    operation?.abort();
    operation = null;
    stories = [];
    ready = false;
    search.value = '';
    filter.value = 'all';
    state.value = 'active';
    state.disabled = true;
    archiveCount.textContent = 'Archives : —';
    search.disabled = filter.disabled = true;
    otherOption.hidden = otherOption.disabled = true;
    list.replaceChildren();
    feedback.textContent = '';
    section.setAttribute('aria-busy', 'false');
  }

  function askPermanentDeletion(preview) {
    // Le dialogue est construit en texte : titre et contenu externes ne sont
    // jamais interprétés comme HTML. Aucun secret n'est conservé en stockage.
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.style.maxWidth = 'min(40rem, calc(100vw - 2rem))';
      const title = document.createElement('h2');
      title.id = 'story-deletion-title';
      title.textContent = 'Supprimer définitivement : ' + preview.story.title;
      const warning = document.createElement('p');
      warning.id = 'story-deletion-warning';
      warning.textContent = 'Action irréversible. Les théories, commentaires, votes, mises à jour et signalements associés seront supprimés. ' +
        Object.entries(preview.impact).map(([key, count]) => ({ comments: 'Commentaires', theories: 'Théories',
          votes: 'Votes', updates: 'Mises à jour', reports: 'Signalements' }[key] || key) + ' : ' + count).join(' ; ');
      const label = document.createElement('label');
      label.setAttribute('for', 'story-deletion-title-input');
      label.textContent = 'Recopiez le titre complet du dossier';
      const input = document.createElement('input');
      input.id = 'story-deletion-title-input';
      input.type = 'text'; input.maxLength = 200; input.autocomplete = 'off';
      const checkLabel = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox'; check.id = 'story-deletion-ack';
      const checkText = document.createElement('span');
      checkText.textContent = 'Je comprends que les contributions et signalements seront perdus.';
      checkLabel.append(check, checkText);
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.textContent = 'Annuler';
      const confirm = document.createElement('button');
      confirm.type = 'button'; confirm.textContent = 'Supprimer définitivement'; confirm.disabled = true;
      const update = () => { confirm.disabled = input.value !== preview.story.title || check.checked !== true; };
      input.addEventListener('input', update); check.addEventListener('change', update);
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true;
        closeDeletionDialog = null;
        dialog.close?.(); dialog.remove?.();
        resolve(value);
      };
      closeDeletionDialog = () => finish(null);
      cancel.addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.addEventListener('close', () => finish(null));
      confirm.addEventListener('click', () => { if (!confirm.disabled) finish(input.value); });
      dialog.setAttribute('aria-labelledby', title.id);
      dialog.setAttribute('aria-describedby', warning.id);
      dialog.append(title, warning, label, input, checkLabel, cancel, confirm);
      section.append(dialog);
      if (typeof dialog.showModal !== 'function') { finish(null); return; }
      dialog.showModal(); cancel.focus?.();
    });
  }

  async function permanentlyDelete(story) {
    if (!ready || pending || !story.is_archived) return;
    pending = true;
    deleteFocusId = story.id;
    const current = version;
    const controller = new AbortController();
    operation?.abort(); operation = controller;
    render(); section.setAttribute('aria-busy', 'true');
    feedback.textContent = 'Vérification du dossier avant suppression...';
    const options = { ...accessOptions, signal: controller.signal };
    let attempted = false;
    let confirmed = false;
    let localError = '';
    try {
      const preview = await getStoryDeletionPreview(story.id, options);
      if (current !== version) return;
      section.setAttribute('aria-busy', 'false');
      const title = await askPermanentDeletion(preview);
      if (current !== version || title === null) return;
      const token = await confirmStoryDeletion(story.id, preview, title, options);
      if (current !== version) return;
      attempted = true;
      try {
        await deleteAdminStory(story.id, preview, token, options);
        confirmed = true;
      } catch (error) {
        if (current !== version) return;
        if ([401, 403].includes(error.status)) return;
      }
      if (current !== version) return;
      let observed = 'unknown';
      try { observed = (await verifyAdminStoryState(story.id, options)).state; }
      catch (error) {
        if (current !== version || [401, 403].includes(error.status)) return;
      }
      if (current !== version) return;
      // Relire les listes et statistiques même si le DELETE est incertain.
      // Cette lecture ne relance jamais la suppression et n'invente aucun reçu.
      await reload({ kind: 'delete', id: story.id, uncertain: !confirmed, confirmed, observed });
    } catch (error) {
      if (current === version && ![401, 403].includes(error.status)) {
        localError = attempted ? 'Issue de suppression non vérifiée. Actualisez ; aucune suppression ne sera relancée automatiquement.' :
          'Suppression non envoyée. Relisez le dossier avant une nouvelle confirmation.';
      }
    } finally {
      pending = false;
      if (current === version) {
        operation = null; section.setAttribute('aria-busy', 'false');
        if (ready) render();
        if (localError) feedback.textContent = localError;
        if (!attempted) deleteFocusButton?.focus?.();
      } else if (ready) render();
    }
  }

  async function change(story) {
    if (!ready || pending) return;
    const archived = !story.is_archived;
    const question = archived ? 'Archiver « ' + story.title + ' » ? Le dossier sera masqué du site public. ' +
      'Ses contributions et signalements seront conservés ; il pourra être restauré.' :
      'Restaurer « ' + story.title + ' » et ses contributions sur le site public ?';
    // Dialogue natif accessible au clavier ; annuler ne déclenche aucun appel.
    if (!window.confirm(question)) return;
    pending = true;
    const current = version;
    const controller = new AbortController();
    operation?.abort();
    operation = controller;
    render();
    section.setAttribute('aria-busy', 'true');
    feedback.textContent = 'Modification en cours...';
    let uncertain = false;
    try {
      await changeAdminStoryArchive(story.id, archived, { ...accessOptions, signal: controller.signal });
    } catch (error) {
      if (current !== version) return;
      // Un refus courant est déjà transmis au tableau par onAccessDenied.
      if ([401, 403].includes(error.status)) return;
      uncertain = true;
    } finally {
      if (current === version) operation = null;
      // Garder le verrou pendant la relecture, même si le POST a échoué.
      if (current !== version) { pending = false; if (ready) render(); }
    }
    if (current !== version) return;
    try {
      await reload({ id: story.id, uncertain });
    } finally {
      pending = false;
      if (ready) render();
    }
  }

  async function readArchive(story, button, container) {
    if (!ready || pending || button.disabled) return;
    button.disabled = true;
    const current = version;
    const controller = new AbortController();
    operation?.abort();
    operation = controller;
    try {
      const detail = await getAdminStory(story.id, { ...accessOptions, signal: controller.signal });
      if (current !== version || controller.signal.aborted) return;
      const texts = [detail.summary, detail.content, 'Votes conservés : ' + detail.votes,
        ...detail.theories.map(row => 'Théorie : ' + row.title + ' — ' + row.content),
        ...detail.comments.map(row => 'Commentaire : ' + row.text),
        ...detail.updates.map(row => 'Mise à jour : ' + row.content)];
      container.replaceChildren(...texts.map(text => {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        return paragraph;
      }));
    } catch (error) {
      if (current === version && !controller.signal.aborted && ![401, 403].includes(error.status)) {
        container.textContent = 'Lecture impossible. Réessayez ou actualisez le tableau.';
      }
    } finally {
      if (current === version) {
        button.disabled = false;
        if (operation === controller) operation = null;
      }
    }
  }

  function begin() {
    clear();
    feedback.textContent = 'Chargement des dossiers...';
    section.setAttribute('aria-busy', 'true');
  }

  // L'API fournit un identifiant, pas un nom. Réutiliser le classement existant
  // de app.js ; aucun autre libellé de catégorie n'est inventé à partir de l'id.
  function category(story) {
    const known = getStoryCategory(story);
    return known || { type: 'other', label: 'Catégorie inconnue (identifiant ' + story.category_id + ')' };
  }

  // La fiche existante transmet ensuite le slug à une route Flask <string:slug>.
  // Refuser séparateurs, segments spéciaux et texte non encodable évite un lien
  // inutilisable. Les accents et caractères spéciaux valides sont encodés, sans
  // transformer le slug enregistré ni fabriquer un slug depuis le titre.
  function detailLink(slug) {
    if (typeof slug !== 'string' || !slug.trim() || [...slug].length > 150 ||
        slug === '.' || slug === '..' || /[\\/\u0000-\u001f\u007f]/.test(slug)) return null;
    try { return 'dossier.html?slug=' + encodeURIComponent(slug); }
    catch { return null; }
  }

  function card(story) {
    const article = document.createElement('article');
    article.className = 'panel';
    const title = document.createElement('h3');
    title.textContent = story.title || 'Titre indisponible';
    const badge = document.createElement('p');
    badge.textContent = category(story).label;
    article.append(title, badge);
    const status = document.createElement('p');
    status.textContent = story.is_archived ? 'Archivé le ' + story.archived_at + ' UTC' : 'Actif';
    article.append(status);
    const href = detailLink(story.slug);
    if (story.is_archived) {
      const read = document.createElement('button');
      read.type = 'button';
      read.textContent = 'Consulter l’archive';
      read.disabled = pending;
      read.setAttribute('aria-label', 'Consulter l’archive : ' + story.title);
      const content = document.createElement('div');
      content.setAttribute('role', 'status');
      read.addEventListener('click', () => readArchive(story, read, content));
      article.append(read, content);
    } else if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = 'Consulter le dossier';
      article.append(link);
    } else {
      const unavailable = document.createElement('p');
      unavailable.textContent = 'Fiche indisponible : slug absent ou invalide.';
      article.append(unavailable);
    }
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn';
    action.textContent = story.is_archived ? 'Restaurer' : 'Archiver';
    action.setAttribute('aria-label', action.textContent + ' : ' + story.title);
    action.disabled = pending;
    action.addEventListener('click', () => change(story));
    article.append(action);
    if (story.is_archived) {
      const permanent = document.createElement('button');
      permanent.type = 'button'; permanent.textContent = 'Supprimer définitivement';
      permanent.disabled = pending;
      permanent.setAttribute('aria-label', 'Supprimer définitivement : ' + story.title);
      permanent.addEventListener('click', () => permanentlyDelete(story));
      article.append(permanent);
      if (story.id === deleteFocusId) deleteFocusButton = permanent;
    }
    return article;
  }

  // Filtrer ne modifie ni le tableau source, ni les six compteurs, ni la base.
  // La recherche porte uniquement sur le titre et conserve l'ordre de l'API.
  function render() {
    if (!ready) return;
    const query = search.value.toLocaleLowerCase('fr').trim();
    const type = ['all', 'resolved', 'coldcase', 'other'].includes(filter.value) ? filter.value : 'all';
    const selected = stories.filter(story =>
      (state.value === 'all' || story.is_archived === (state.value === 'archived')) &&
      (type === 'all' || category(story).type === type) &&
      story.title.toLocaleLowerCase('fr').includes(query));
    list.replaceChildren(...selected.map(card));
    feedback.textContent = !stories.length ? 'Aucun dossier disponible.' :
      !selected.length ? 'Aucun dossier ne correspond à cette recherche ou à ce filtre.' :
      selected.length + ' dossier(s) affiché(s) sur ' + stories.length + '.';
  }

  function display(items, archives = [], options = {}) {
    // getStories et displayData valident déjà le contrat ; garder aussi une
    // frontière locale explicite avant d'activer les contrôles de ce panneau.
    if (!Array.isArray(items) || !items.every(story => story &&
        Number.isInteger(story.id) && story.id > 0 && story.id <= 2147483647 &&
        Number.isInteger(story.category_id) && typeof story.title === 'string') ||
        new Set(items.map(story => story.id)).size !== items.length) {
      throw new Error('Liste de dossiers invalide.');
    }
    if (!Array.isArray(archives) || !archives.every(isAdminStory) ||
        new Set([...items, ...archives].map(story => story.id)).size !== items.length + archives.length) {
      throw new Error('Liste des archives invalide.');
    }
    stories = [...items.map(story => ({ ...story, is_archived: false, archived_at: null })), ...archives];
    accessOptions = options;
    ready = true;
    state.disabled = !stories.length;
    archiveCount.textContent = 'Archives : ' + archives.length;
    const hasOther = stories.some(story => category(story).type === 'other');
    otherOption.hidden = otherOption.disabled = !hasOther;
    search.disabled = filter.disabled = !stories.length;
    section.setAttribute('aria-busy', 'false');
    render();
  }

  search.addEventListener('input', render);
  filter.addEventListener('change', render);
  state.addEventListener('change', render);
  clear();
  return { begin, clear, display };
}
