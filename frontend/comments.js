// Ce contrôleur est démarré par app.js uniquement après la lecture du vrai dossier.
function mountStoryComments(storyId) {
  const panel = document.getElementById('story-comments');
  if (!panel || panel.dataset.mounted || !isContributionId(storyId)) return;
  panel.dataset.mounted = 'true';
  panel.hidden = false;
  const element = id => document.getElementById(id);
  const list = element('comments-list');
  const refresh = element('comments-refresh');
  const listFeedback = element('comments-feedback');
  const commentForm = element('comment-form');
  const text = element('comment-text');
  const sendComment = element('comment-send');
  const commentFeedback = element('comment-feedback');
  const reportForm = element('report-form');
  const target = element('report-target');
  const reason = element('report-reason');
  const sendReport = element('report-send');
  const cancelReport = element('report-cancel');
  const reportFeedback = element('report-feedback');
  let comments = [];
  let selectedId = null;
  let ready = false;
  let unavailable = false;
  let busy = false;
  let likeBusy = false;
  let likeControls = [];
  let reading = false;
  let departed = false;
  let uncertainComment = false;
  let uncertainReport = false;
  let readController;

  // Un verrou commun couvre aussi /me : deux clics ne créent pas deux POST.
  function controls() {
    const blocked = !ready || unavailable || busy || likeBusy || reading || departed;
    text.disabled = blocked || uncertainComment;
    sendComment.disabled = text.disabled;
    reason.disabled = blocked || uncertainReport;
    sendReport.disabled = reason.disabled || selectedId === null;
    cancelReport.disabled = busy || likeBusy;
    refresh.disabled = busy || likeBusy || reading || departed || selectedId !== null;
    list.querySelectorAll('button').forEach(button => {
      if (button.dataset.action === 'report') button.disabled = blocked || uncertainReport || selectedId !== null;
    });
    likeControls.forEach(control => control.setBlocked(blocked || selectedId !== null));
    panel.setAttribute('aria-busy', String(busy || likeBusy || reading));
  }

  function closeReport() {
    selectedId = null;
    reportForm.hidden = true;
    target.textContent = '';
    reason.value = '';
  }

  // Le texte et le pseudonyme sont du contenu utilisateur, jamais du HTML.
  function render() {
    disposeLikes();
    list.replaceChildren(...comments.map(comment => {
      const card = document.createElement('article');
      card.className = 'comment-card';
      const heading = document.createElement('h3');
      heading.textContent = comment.username || 'Anonyme';
      const content = document.createElement('p');
      content.className = 'comment-text';
      content.textContent = comment.text;
      const button = document.createElement('button');
      button.className = 'outline';
      button.type = 'button';
      button.textContent = 'Signaler';
      button.dataset.action = 'report';
      button.setAttribute('aria-label', 'Signaler le commentaire n° ' + comment.id);
      button.addEventListener('click', () => {
        if (button.disabled || selectedId !== null) return;
        selectedId = comment.id;
        target.textContent = 'Commentaire n° ' + comment.id + ' de ' + (comment.username || 'Anonyme');
        reportFeedback.textContent = '';
        reportForm.hidden = false;
        controls();
        reason.focus();
      });
      card.append(heading, content, button);
      if (typeof createLikeControl === 'function') {
        const like = createLikeControl('comment', comment.id, comment.likes, {
          compatible: comment.likes_compatible !== false,
          onWriting(value) { likeBusy = value; controls(); }
        });
        likeControls.push(like);
        card.append(like.node);
      }
      return card;
    }));
    listFeedback.textContent = comments.length ? '' : 'Aucun commentaire pour ce dossier.';
  }

  function disposeLikes() {
    likeControls.forEach(control => control.dispose());
    likeControls = [];
  }

  async function load() {
    if (busy || likeBusy || reading || departed || selectedId !== null) return;
    reading = true;
    ready = false;
    disposeLikes();
    list.replaceChildren();
    controls();
    listFeedback.textContent = 'Chargement des commentaires…';
    readController = new AbortController();
    try {
      const received = await getStoryComments(storyId, { signal: readController.signal });
      if (departed) return;
      comments = received;
      unavailable = false;
      ready = true;
      render();
    } catch (error) {
      if (departed) return;
      comments = [];
      unavailable = error.status === 404;
      listFeedback.textContent = unavailable ? 'Ce dossier n’est plus disponible.' :
        'Lecture impossible. Utilisez Actualiser les commentaires pour réessayer.';
    } finally {
      reading = false;
      controls();
    }
  }

  // Le backend utilise un TEXT limité en octets UTF-8, pas en caractères HTML.
  // Refuser les demi-surrogates évite leur remplacement silencieux par TextEncoder.
  function validatedText(field) {
    const value = field.value.trim();
    if (!value) throw new Error('Saisissez un texte non vide.');
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
      throw new Error('Le texte contient un caractère invalide.');
    }
    if (new TextEncoder().encode(value).length > 65535) {
      throw new Error('Le texte dépasse 65 535 octets UTF-8.');
    }
    return value;
  }

  async function submit(kind) {
    const reporting = kind === 'report';
    const feedback = reporting ? reportFeedback : commentFeedback;
    if (busy || likeBusy || reading || !ready || unavailable || departed ||
        (reporting ? uncertainReport || selectedId === null : uncertainComment)) return;
    let postStarted = false;
    busy = true;
    controls();
    feedback.textContent = 'Vérification de la session…';
    try {
      const value = validatedText(reporting ? reason : text);
      const session = await getCurrentUser();
      if (departed) return;
      if (!isContributionId(session?.user?.id) || typeof session.csrf_token !== 'string' ||
          !session.csrf_token) throw new Error('Session invalide. Reconnectez-vous.');
      feedback.textContent = 'Envoi en cours…';
      postStarted = true;
      if (reporting) {
        // La cible capturée vient du GET ; aucun id d'histoire ni auteur n'est envoyé.
        await reportComment(selectedId, value);
        if (departed) return;
        closeReport();
        feedback.textContent = 'Votre signalement a été pris en compte.';
      } else {
        const saved = await createComment(storyId, value);
        if (departed) return;
        comments = [...comments.filter(item => item.id !== saved.id), saved];
        render();
        text.value = '';
        feedback.textContent = 'Commentaire publié.';
      }
    } catch (error) {
      if (departed) return;
      // Un timeout, un JSON incohérent ou un 5xx peut arriver après le commit.
      // Conserver le brouillon et bloquer tout nouvel envoi du même type sur cette page.
      if (postStarted && (!error.status || error.status >= 500 || error.code === 'UNEXPECTED_STATUS')) {
        if (reporting) uncertainReport = true;
        else uncertainComment = true;
        feedback.textContent = reporting ?
          'Résultat incertain. Faites vérifier ce signalement par l’administration. Aucun nouvel envoi sur cette page.' :
          'Résultat incertain. Actualisez la liste pour vérifier votre commentaire. Aucun nouvel envoi sur cette page.';
      } else if (error.status === 401) {
        feedback.textContent = 'Connectez-vous pour envoyer. Votre texte est conservé sur cette page.';
      } else if (error.status === 403) {
        feedback.textContent = 'Envoi refusé : compte suspendu ou protection CSRF. Reconnectez-vous avant de réessayer.';
      } else if (error.status === 404) {
        // Une archive ou une suppression peut survenir après la lecture publique.
        ready = false;
        unavailable = true;
        list.replaceChildren();
        feedback.textContent = 'Le dossier ou le commentaire n’est plus disponible. Annulez le signalement éventuel puis actualisez la liste.';
      } else {
        feedback.textContent = error.message || 'Envoi impossible.';
      }
    } finally {
      busy = false;
      controls();
    }
  }

  commentForm.addEventListener('submit', event => {
    event.preventDefault();
    return submit('comment');
  });
  reportForm.addEventListener('submit', event => {
    event.preventDefault();
    return submit('report');
  });
  cancelReport.addEventListener('click', () => {
    if (busy || likeBusy) return;
    closeReport();
    controls();
  });
  refresh.addEventListener('click', load);
  // Quitter la page annule la lecture, jamais un commit déjà envoyé. Le retour
  // depuis le cache garde les écritures bloquées jusqu'à un rechargement complet.
  window.addEventListener('pagehide', () => {
    departed = true;
    disposeLikes();
    readController?.abort();
    controls();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && departed) {
      listFeedback.textContent = 'Page restaurée : rechargez-la et vérifiez les commentaires avant tout nouvel envoi.';
    }
  });
  load();
}
