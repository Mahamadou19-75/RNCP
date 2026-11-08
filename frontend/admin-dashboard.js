(() => {
  'use strict';

  const dashboard = document.getElementById('admin-dashboard');
  if (!dashboard) return;

  const dataRegion = document.getElementById('admin-data');
  const refresh = document.getElementById('admin-refresh');
  const feedback = document.getElementById('admin-feedback');
  const loginLink = document.getElementById('admin-login-link');
  const proposalsList = document.getElementById('admin-proposals-list');
  const reportsList = document.getElementById('admin-reports-list');
  const categoriesFeedback = document.getElementById('admin-categories-feedback');
  const proposalsFeedback = document.getElementById('admin-proposals-feedback');
  const reportsFeedback = document.getElementById('admin-reports-feedback');
  const counters = Object.fromEntries([
    'stories', 'resolved', 'coldcases', 'users', 'comments', 'reports', 'pending-proposals'
  ].map(name => [name, document.getElementById('admin-' + name + '-count')]));
  const statuses = new Map([
    ['pending', 'En attente'], ['approved', 'Acceptée'], ['rejected', 'Refusée'],
    ['resolved', 'Traité'], ['dismissed', 'Classé']
  ]);
  let requestVersion = 0;
  let activeRequest = null;

  // Le panneau utilisateurs réutilise l'accès global sans remplacer les six
  // compteurs. Ses données sont effacées avec celles du tableau à tout refus.
  const usersPanel = typeof createAdminUsersPanel === 'function' ? createAdminUsersPanel() : null;
  const storiesPanel = typeof createAdminStoriesPanel === 'function' ? createAdminStoriesPanel({
    reload: outcome => loadDashboard(outcome)
  }) : null;

  dataRegion.style.overflowWrap = 'anywhere';

  // Effacer les données avant un nouveau chargement et après un refus d'accès
  // évite de laisser visibles les résultats d’une ancienne session autorisée.
  function clearData() {
    storiesPanel?.clear();
    usersPanel?.clear();
    dataRegion.hidden = true;
    Object.values(counters).forEach(counter => { counter.textContent = '—'; });
    proposalsList.replaceChildren();
    reportsList.replaceChildren();
    categoriesFeedback.textContent = '';
    proposalsFeedback.textContent = '';
    reportsFeedback.textContent = '';
  }

  // Invalider aussi la version protège contre une réponse tardive lorsque
  // l'annulation réseau ne suffit plus à arrêter le traitement déjà commencé.
  function cancelRequest() {
    storiesPanel?.clear();
    usersPanel?.clear();
    requestVersion += 1;
    activeRequest?.abort();
    activeRequest = null;
    return requestVersion;
  }

  // Un 401/403 courant annule les lectures et masque les données ; ignorer une
  // ancienne requête empêche qu’elle réaffiche une vue devenue interdite.
  function blockAccess(error, version) {
    if (version !== requestVersion) return;
    cancelRequest();
    clearData();
    dashboard.setAttribute('aria-busy', 'false');
    refresh.disabled = false;
    loginLink.hidden = false;
    feedback.textContent = error.status === 401 ?
      'Votre session est absente ou a expiré. Connectez-vous avec un compte administrateur.' :
      'Accès refusé. Un compte administrateur autorisé est nécessaire.';
  }

  // La convention du backend est UTC ; l'affichage est converti en heure de Paris.
  // Ce traitement d'interface ne change pas les dates stockées dans la base.
  function publicationDate(value) {
    const time = document.createElement('time');
    if (typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/i.test(value)) {
      // Cette API sérialise ses dates UTC sans suffixe de fuseau.
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

  function paragraph(text) {
    const node = document.createElement('p');
    node.textContent = text;
    return node;
  }

  // Construire une carte de consultation avec textContent : le contenu soumis
  // reste du texte et les statuts affichés ne déclenchent aucune publication.
  function proposalCard(proposal) {
    const card = document.createElement('article');
    card.className = 'panel';
    const title = document.createElement('h3');
    title.textContent = proposal.title;
    card.append(title, paragraph('Statut : ' + (statuses.get(proposal.status) || proposal.status)),
      publicationDate(proposal.created_at));
    proposal.content.split(/\r?\n/).forEach(line => card.append(paragraph(line)));
    return card;
  }

  // Afficher cible, motif et statut comme texte ; un signalement consulté
  // n'est pas automatiquement marqué comme traité.
  function reportCard(report) {
    const card = document.createElement('article');
    card.className = 'panel';
    const title = document.createElement('h3');
    title.textContent = report.type === 'comment' ? 'Signalement de commentaire' : 'Signalement : ' + report.type;
    card.append(title, paragraph('Cible : ' + report.target_id),
      paragraph('Statut : ' + (statuses.get(report.status) || report.status)),
      publicationDate(report.created_at));
    if (report.comment) {
      card.append(paragraph('Commentaire n° ' + report.comment.id));
      const text = paragraph(report.comment.text);
      text.className = 'report-comment-text';
      card.append(text);
    } else card.append(paragraph('Commentaire indisponible.'));
    const story = report.story;
    if (story) {
      const dossier = paragraph('Dossier : ');
      let href = null;
      if (!story.is_archived && !/[\/\\]/.test(story.slug) && !['.', '..'].includes(story.slug)) {
        try { href = 'dossier.html?slug=' + encodeURIComponent(story.slug); } catch { /* Slug illisible : garder le texte. */ }
      }
      if (href) {
        const link = document.createElement('a'); link.href = href; link.textContent = story.title;
        dossier.append(link);
      } else {
        const label = document.createElement('span');
        label.textContent = story.title + (story.is_archived ? ' (archivé)' : '');
        dossier.append(label);
      }
      card.append(dossier, paragraph('Catégorie : ' + (story.category_name || 'Indisponible (n° ' + story.category_id + ')')));
      if (story.is_archived) card.append(paragraph('Lecture du dossier dans la section Dossiers, filtre Archives.'));
    } else card.append(paragraph('Dossier indisponible.'));
    card.append(paragraph('Motif du signalement :'));
    report.reason.split(/\r?\n/).forEach(line => card.append(paragraph(line)));
    return card;
  }

  // Les dossiers et leurs catégories sont comptés localement ; les trois autres
  // compteurs proviennent de /stats. Les cartes restent des vues de consultation.
  function displayData(stats, stories, proposals, reports) {
    if (stories.some(story => story.id < 1 || story.id > 2147483647) ||
        new Set(stories.map(story => story.id)).size !== stories.length) {
      throw new Error('Identifiants de dossiers invalides.');
    }
    const resolved = stories.filter(story => getStoryCategory(story)?.type === 'resolved').length;
    const coldcases = stories.filter(story => getStoryCategory(story)?.type === 'coldcase').length;
    const others = stories.length - resolved - coldcases;
    // Réutiliser la liste administrative validée : seul le statut exact pending
    // compte. Une erreur de lecture suit le nettoyage global, jamais un faux zéro.
    const values = { stories: stories.length, resolved, coldcases,
      users: stats.users, comments: stats.comments, reports: stats.reports,
      'pending-proposals': proposals.filter(proposal => proposal.status === 'pending').length };
    Object.entries(values).forEach(([name, value]) => {
      counters[name].textContent = String(value);
    });
    categoriesFeedback.textContent = !stories.length ? 'Aucun dossier disponible.' :
      others ? others + ' dossier(s) dans une catégorie non configurée.' : '';
    proposalsList.replaceChildren(...proposals.map(proposalCard));
    reportsList.replaceChildren(...reports.map(reportCard));
    proposalsFeedback.textContent = proposals.length ? '' : 'Aucune proposition reçue.';
    reportsFeedback.textContent = reports.length ? '' : 'Aucun signalement.';
    dataRegion.hidden = false;
  }

  // Vérifier /me et is_admin avant les lectures parallèles. Flask protège encore
  // chaque route privée ; ce contrôle client sert à guider et nettoyer l’interface.
  // Il n'y a pas de surveillance continue de session ni d'action de modération.
  async function loadDashboard(outcome = null) {
    const version = cancelRequest();
    const controller = new AbortController();
    activeRequest = controller;
    clearData();
    loginLink.hidden = true;
    storiesPanel?.begin();
    refresh.disabled = true;
    dashboard.setAttribute('aria-busy', 'true');
    feedback.textContent = 'Vérification de votre accès...';
    const options = {
      signal: controller.signal,
      onAccessDenied: error => blockAccess(error, version)
    };
    try {
      const session = await getCurrentUser(options);
      if (version !== requestVersion) return;
      if (session?.user?.is_admin !== true) {
        blockAccess({ status: 403 }, version);
        return;
      }
      feedback.textContent = 'Chargement des données...';
      const [stats, stories, proposals, reports, archives] = await Promise.all([
        getAdminStats(options), getStories(options),
        getAdminProposals(options), getAdminReports(options), getAdminStories(options)
      ]);
      if (version !== requestVersion) return;
      displayData(stats, stories, proposals, reports);
      // Deux GET peuvent encadrer une transition concurrente : ne pas afficher
      // deux fois le même dossier ou inventer un état. Une actualisation est requise.
      if (archives.some(archive => stories.some(story => story.id === archive.id))) {
        throw new Error('État des dossiers modifié pendant la lecture.');
      }
      storiesPanel?.display(stories, archives, options);
      await usersPanel?.load(options);
      if (version !== requestVersion) return;
      if (outcome?.kind === 'delete') {
        const present = [...stories, ...archives].some(story => story.id === outcome.id);
        feedback.textContent = outcome.confirmed ? 'Suppression confirmée par le serveur. Listes et statistiques relues.' :
          'Réponse de suppression incertaine. État relu : dossier ' + (present ? 'présent' : 'absent') +
          '. Sans journal persistant, cette demande ne peut pas être attribuée avec certitude. Aucune relance automatique.';
      } else if (outcome) {
        const current = archives.some(story => story.id === outcome.id) ? 'archivé' :
          stories.some(story => story.id === outcome.id) ? 'actif' : 'introuvable';
        feedback.textContent = (outcome.uncertain ? 'Réponse de modification incertaine. ' : '') +
          'État relu sur le serveur : dossier ' + current + '.';
        refresh.focus?.();
      } else feedback.textContent = 'Données chargées.';
    } catch (error) {
      if (version !== requestVersion) return;
      if ([401, 403].includes(error.status)) {
        blockAccess(error, version);
        return;
      }
      controller.abort();
      clearData();
      feedback.textContent = outcome?.kind === 'delete' && outcome.confirmed ?
        'Suppression confirmée par le serveur ; actualisation des listes indisponible. Utilisez Actualiser.' : outcome ?
        'État du dossier non vérifié. Actualisez avant toute nouvelle action.' : error.code === 'TIMEOUT' ?
        'Le serveur met trop de temps à répondre. Utilisez Actualiser pour réessayer.' :
        'Impossible de charger le tableau de bord. Utilisez Actualiser pour réessayer.';
    } finally {
      if (version === requestVersion) {
        activeRequest = null;
        dashboard.setAttribute('aria-busy', 'false');
        refresh.disabled = false;
        if (outcome) refresh.focus?.();
      }
    }
  }

  refresh.addEventListener('click', () => {
    if (refresh.disabled) return;
    return loadDashboard();
  });
  // Nettoyer avant de quitter la page, y compris si le navigateur la conserve
  // en cache ; au retour depuis ce cache, revérifier la session et les données.
  window.addEventListener('pagehide', () => {
    cancelRequest();
    clearData();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) return loadDashboard();
  });
  window.addEventListener('session-ended', () => {
    cancelRequest(); clearData();
    dashboard.setAttribute('aria-busy', 'false');
    refresh.disabled = false; loginLink.hidden = false;
    feedback.textContent = 'Session modifiée. Actualisez pour vérifier votre accès.';
  });
  loadDashboard();
})();
