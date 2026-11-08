// Contrôleur commun : seuls les états relus sur le serveur changent le compteur.
function createLikeControl(kind, id, initialCount, { compatible = true, onWriting = () => {} } = {}) {
  const node = document.createElement('div');
  node.className = 'like-control';
  const count = document.createElement('span');
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'outline';
  const verify = document.createElement('button');
  verify.type = 'button'; verify.className = 'outline'; verify.textContent = 'Vérifier les J’aime';
  const feedback = document.createElement('p');
  feedback.className = 'feedback'; feedback.setAttribute('role', 'status');
  node.append(count, button, verify, feedback);
  let state = null;
  let subjectId = null;
  let busy = false;
  let blocked = false;
  let disposed = false;
  let uncertain = false;
  const controller = new AbortController();
  function sessionEnded() {
    if (disposed) return;
    disposed = true; state = null; subjectId = null; controller.abort();
    feedback.textContent = 'Session modifiée : rechargez la page pour vérifier vos J’aime.';
    controls();
  }
  window.addEventListener('session-ended', sessionEnded);

  function controls() {
    button.textContent = state?.liked_by_me ? 'Retirer mon J’aime' : 'J’aime';
    button.setAttribute('aria-label', (state?.liked_by_me ? 'Retirer mon J’aime' : 'Aimer') +
      (kind === 'story' ? ' le dossier n° ' : ' le commentaire n° ') + id);
    if (state) button.setAttribute('aria-pressed', String(state.liked_by_me));
    else button.removeAttribute('aria-pressed');
    button.disabled = disposed || blocked || busy || uncertain || !compatible || state === null;
    verify.disabled = disposed || blocked || busy || !compatible;
    node.setAttribute('aria-busy', String(busy));
  }

  function display(data) {
    state = data;
    count.textContent = data.likes + ' J’aime';
  }

  async function read() {
    const session = await getCurrentUser({ signal: controller.signal });
    if (!isContributionId(session?.user?.id) || typeof session.csrf_token !== 'string' || !session.csrf_token) {
      throw new Error('Session invalide. Reconnectez-vous.');
    }
    const data = await getLikeState(kind, id, { signal: controller.signal });
    return { session, data };
  }

  function readError(error) {
    state = null; subjectId = null;
    if (error.status === 401) feedback.textContent = 'Connectez-vous pour aimer ou retirer votre J’aime.';
    else if (error.status === 403) feedback.textContent = 'Accès refusé. Reconnectez-vous avec un compte actif.';
    else if (error.status === 404) {
      count.textContent = 'Élément indisponible';
      feedback.textContent = 'Ce dossier ou commentaire n’est plus disponible.';
    } else if (kind === 'comment' && error.status === 409) {
      compatible = false;
      count.textContent = 'Compteur historique à vérifier';
      feedback.textContent = 'Historique non attribuable : aucun like individuel modifié.';
    } else feedback.textContent = 'État personnel indisponible. Utilisez Vérifier les J’aime.';
  }

  async function refresh() {
    if (busy || disposed || blocked || !compatible) return;
    busy = true; controls();
    feedback.textContent = 'Lecture de votre état…';
    try {
      const { session, data } = await read();
      if (disposed) return;
      subjectId = session.user.id;
      display(data);
      feedback.textContent = uncertain ?
        'Compteur actualisé. L’envoi précédent reste incertain.' : '';
    } catch (error) {
      if (!disposed) readError(error);
    } finally { busy = false; controls(); }
  }

  button.addEventListener('click', async () => {
    if (button.disabled || busy || disposed || !state) return;
    // Capturer l'intention, pas une bascule qui pourrait changer après /me.
    const wanted = !state.liked_by_me;
    const previousSubject = subjectId;
    let sent = false;
    let confirmed = false;
    busy = true; controls(); onWriting(true);
    feedback.textContent = 'Vérification de la session…';
    try {
      const { session, data } = await read();
      if (disposed) return;
      subjectId = session.user.id;
      display(data);
      if (subjectId !== previousSubject) {
        feedback.textContent = 'Compte modifié : état relu, aucune action envoyée.';
        return;
      }
      if (data.liked_by_me === wanted) {
        feedback.textContent = 'Votre J’aime est déjà à jour.';
        return;
      }
      sent = true;
      feedback.textContent = 'Envoi en cours…';
      await changeLike(kind, id, wanted);
      confirmed = true;
      if (disposed) return;
      const latest = await getLikeState(kind, id, { signal: controller.signal });
      if (disposed) return;
      display(latest);
      feedback.textContent = latest.liked_by_me === wanted ?
        (wanted ? 'J’aime ajouté.' : 'J’aime retiré.') :
        'Vos J’aime ont changé. Compteur actualisé.';
    } catch (error) {
      if (disposed) return;
      if (confirmed) {
        state = null;
        feedback.textContent = (wanted ? 'J’aime ajouté.' : 'J’aime retiré.') +
          ' Compteur indisponible. Utilisez « Vérifier les J’aime ».';
      } else if (sent && (!error.status || error.status >= 500 || error.code === 'UNEXPECTED_STATUS')) {
        uncertain = true;
        state = null;
        feedback.textContent = 'Résultat incertain. Vérifiez vos J’aime ; l’envoi reste bloqué sur cette page.';
      } else if (sent && error.status === 409) {
        // Un autre onglet a pu ajouter le même like : relire, jamais renvoyer.
        try {
          const latest = await getLikeState(kind, id, { signal: controller.signal });
          if (disposed) return;
          display(latest);
          feedback.textContent = 'Vos J’aime ont changé. Compteur actualisé.';
        } catch (readFailure) { if (!disposed) readError(readFailure); }
      } else readError(error);
    } finally { busy = false; onWriting(false); controls(); }
  });
  verify.addEventListener('click', refresh);
  if (!compatible) {
    count.textContent = isLikeCount(initialCount) ? initialCount + ' mentions historiques' : 'Compteur historique incompatible';
    feedback.textContent = 'Historique non attribuable : likes individuels indisponibles.';
    controls();
  } else {
    count.textContent = isLikeCount(initialCount) ? initialCount + ' J’aime' : 'Nombre de J’aime indisponible';
    refresh();
  }
  return {
    node,
    setBlocked(value) { blocked = value; controls(); },
    dispose() {
      disposed = true; state = null; subjectId = null; controller.abort();
      window.removeEventListener?.('session-ended', sessionEnded);
      controls();
    }
  };
}

function mountStoryLike(story) {
  const container = document.getElementById('story-like');
  if (!container || container.dataset.mounted || !isContributionId(story.id)) return;
  container.dataset.mounted = 'true';
  const control = createLikeControl('story', story.id, story.votes);
  container.append(control.node);
  // Un retour de cache ne doit pas réactiver un ancien état personnel.
  window.addEventListener('pagehide', () => control.dispose());
  window.addEventListener('pageshow', event => {
    if (event.persisted) container.textContent = 'Rechargez la page pour vérifier vos J’aime.';
  });
}
