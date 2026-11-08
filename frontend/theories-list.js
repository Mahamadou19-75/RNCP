(() => {
  'use strict';

  const section = document.getElementById('published-theories');
  if (!section) return;

  const select = document.getElementById('theories-story-select');
  const refresh = document.getElementById('theories-refresh');
  const feedback = document.getElementById('theories-list-feedback');
  const list = document.getElementById('published-theories-list');
  let storyIds = new Set();
  let storiesReady = false;
  let requestVersion = 0;
  let activeRequest = null;

  // Une nouvelle sélection invalide les réponses anciennes, même si l'annulation
  // réseau arrive trop tard : leur numéro de version ne correspondra plus.
  function cancelRequest() {
    requestVersion += 1;
    activeRequest?.abort();
    activeRequest = null;
    return requestVersion;
  }

  // Associer le chargement à une version et vider les anciens résultats ;
  // aria-busy et le bouton rendent l'attente perceptible dans l'interface.
  function beginRequest() {
    const version = cancelRequest();
    const controller = new AbortController();
    activeRequest = controller;
    section.setAttribute('aria-busy', 'true');
    refresh.disabled = true;
    list.replaceChildren();
    return { version, controller };
  }

  // Seul le chargement encore courant peut rendre le bouton disponible :
  // une ancienne réponse ne doit pas terminer l'attente d'une nouvelle sélection.
  function finishRequest(version) {
    if (version !== requestVersion) return;
    activeRequest = null;
    section.setAttribute('aria-busy', 'false');
    refresh.disabled = false;
  }

  // Appliquer la convention UTC de cette API aux dates sans suffixe, puis
  // afficher l'heure de Paris ; conserver un libellé neutre si la date est invalide.
  function publicationDate(value) {
    const time = document.createElement('time');
    if (typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/i.test(value)) {
      // Dans cette API, les dates SQLAlchemy sont produites en UTC sans suffixe.
      const iso = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : value + 'Z';
      const date = new Date(iso);
      if (Number.isFinite(date.getTime())) {
        time.dateTime = date.toISOString();
        time.textContent = new Intl.DateTimeFormat('fr-FR', {
          dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris'
        }).format(date) + ' (heure de Paris)';
        return time;
      }
    }
    time.textContent = 'Date indisponible';
    return time;
  }

  // Afficher les contributions comme du texte évite d'exécuter un HTML fourni
  // dans le titre ou le contenu ; les retours à la ligne deviennent des paragraphes.
  function theoryCard(theory) {
    const card = document.createElement('article');
    card.className = 'panel';
    card.style.overflowWrap = 'anywhere';
    const title = document.createElement('h3');
    title.textContent = theory.title;
    const content = document.createElement('div');
    theory.content.split(/\r?\n/).forEach(line => {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      content.append(paragraph);
    });
    card.append(title, publicationDate(theory.created_at), content);
    return card;
  }

  // La lecture est publique ; vérifier l'id sélectionné puis demander les théories.
  // Le sélecteur du lecteur est distinct de celui du formulaire de création.
  async function loadSelectedTheories() {
    const selected = select.value;
    const storyId = Number(selected);
    if (!/^[1-9]\d*$/.test(selected) || !storyIds.has(storyId)) {
      cancelRequest();
      list.replaceChildren();
      section.setAttribute('aria-busy', 'false');
      refresh.disabled = false;
      feedback.textContent = selected ?
        'Choisissez un dossier disponible dans la liste.' :
        'Choisissez un dossier pour consulter les théories publiées.';
      return;
    }

    const { version, controller } = beginRequest();
    feedback.textContent = 'Chargement des théories...';
    try {
      const theories = await getStoryTheories(storyId, { signal: controller.signal });
      if (version !== requestVersion) return;
      list.replaceChildren(...theories.map(theoryCard));
      feedback.textContent = theories.length ? '' :
        'Aucune théorie publiée pour ce dossier.';
    } catch (error) {
      if (version !== requestVersion) return;
      feedback.textContent = error.status === 404 ?
        'Ce dossier n’est plus disponible. Choisissez un autre dossier.' :
        'Impossible de charger les théories. ' + (error.message || 'Réessayez.');
    } finally {
      finishRequest(version);
    }
  }

  // Alimenter le lecteur avec les dossiers réels et gérer aussi une liste vide.
  // Après une création, l'actualisation reste volontaire via le bouton ou la sélection.
  async function loadDossiers() {
    const { version } = beginRequest();
    storiesReady = false;
    storyIds = new Set();
    select.disabled = true;
    feedback.textContent = 'Chargement des dossiers...';
    try {
      const stories = await getStories();
      if (version !== requestVersion) return;
      if (stories.some(story => !Number.isInteger(story.id) ||
          story.id < 1 || story.id > 2147483647) ||
          new Set(stories.map(story => story.id)).size !== stories.length) {
        throw new Error('La liste des dossiers contient des identifiants invalides.');
      }
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choisir un dossier';
      const options = stories.map(story => {
        const option = document.createElement('option');
        option.value = String(story.id);
        option.textContent = story.title;
        return option;
      });
      select.replaceChildren(placeholder, ...options);
      storyIds = new Set(stories.map(story => story.id));
      storiesReady = storyIds.size > 0;
      select.disabled = !storiesReady;
      feedback.textContent = storiesReady ?
        'Choisissez un dossier pour consulter les théories publiées.' :
        'Aucun dossier n’est disponible pour le moment.';
    } catch (error) {
      if (version !== requestVersion) return;
      feedback.textContent = 'Impossible de charger les dossiers. ' +
        (error.message || 'Réessayez.') + ' Utilisez Actualiser pour réessayer.';
    } finally {
      finishRequest(version);
    }
  }

  select.addEventListener('change', loadSelectedTheories);
  refresh.addEventListener('click', () => {
    if (refresh.disabled) return;
    return storiesReady ? loadSelectedTheories() : loadDossiers();
  });
  loadDossiers();
})();
