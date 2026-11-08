// Le frontend et l'API doivent être accessibles sur la même origine.
const API_BASE = '/api/v1';
const API_TIMEOUT_MS = 10000;
let csrfToken = null;

// Centraliser fetch impose les mêmes cookies, délais et erreurs aux pages.
// fetch ne rejette pas tout seul les HTTP 400/500 : examiner explicitement le statut.
async function apiRequest(path, options = {}, expectedStatus = null) {
  const { timeoutMs = API_TIMEOUT_MS, signal, onAccessDenied, conditionalHeaders = {}, ...requestOptions } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new RangeError('Le délai de requête doit être positif et inférieur ou égal à 2147483647 ms.');
  }
  const method = requestOptions.method || 'GET';
  const headers = {};
  // Les deux seuls en-têtes supplémentaires du DELETE sont autorisés ; ils
  // ne peuvent pas remplacer le CSRF, les cookies ou les credentials communs.
  for (const [key, value] of Object.entries(conditionalHeaders)) {
    if (!['If-Match', 'X-Deletion-Confirmation'].includes(key) || typeof value !== 'string') {
      throw new Error('En-tête conditionnel invalide.');
    }
    headers[key] = value;
  }

  if (requestOptions.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  // Le cookie HttpOnly voyage via credentials ; le jeton CSRF, séparé, reste en
  // mémoire JavaScript. Login est exempté comme sur le serveur ; pas de relance
  // automatique des écritures, pour éviter une seconde création involontaire.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
      path !== '/login' && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  // Le même contrôleur relaie l'annulation demandée par la page et le délai
  // maximal. Une annulation locale ne prouve pas qu'un POST a été annulé en base.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(API_BASE + path, {
      ...requestOptions,
      headers,
      credentials: 'include',
      signal: controller.signal
    });

    if (path === '/me' && [401, 403].includes(response.status)) {
      csrfToken = null;
    }

    // Prévenir la page dès le statut permet de masquer les données protégées,
    // même si le corps de la réponse est absent ou illisible.
    if ([401, 403].includes(response.status) && typeof onAccessDenied === 'function') {
      const error = new Error(response.status === 401 ?
        'Session absente ou expirée.' : 'Accès administrateur requis.');
      error.status = response.status;
      error.code = 'HTTP_ERROR';
      onAccessDenied(error);
      throw error;
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (timedOut || controller.signal.aborted) throw error;
      if (response.ok) {
        if (error.name !== 'SyntaxError') throw error;
        const invalidJson = new Error('Réponse du serveur illisible. Réessayez.');
        invalidJson.code = 'INVALID_JSON';
        throw invalidJson;
      }
    }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error ||
        'Le serveur a renvoyé une erreur (HTTP ' + response.status + '). Réessayez.');
      error.status = response.status;
      error.code = 'HTTP_ERROR';
      throw error;
    }
    if (expectedStatus !== null && response.status !== expectedStatus) {
      const error = new Error('Réponse inattendue du serveur. Réessayez.');
      error.status = response.status;
      error.code = 'UNEXPECTED_STATUS';
      throw error;
    }
    return data;
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error('Le serveur met trop de temps à répondre. Réessayez.');
      timeoutError.code = 'TIMEOUT';
      throw timeoutError;
    }
    if (['HTTP_ERROR', 'INVALID_JSON', 'UNEXPECTED_STATUS'].includes(error.code)) throw error;
    const networkError = new Error('Impossible de contacter le serveur. Réessayez.');
    networkError.code = 'NETWORK_ERROR';
    throw networkError;
  } finally {
    // Libérer le minuteur et l'écouteur après chaque issue évite de conserver
    // des rappels attachés à une requête déjà terminée.
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

// Le serveur valide le mot de passe et émet le cookie signé ; seule la réponse
// CSRF est gardée en mémoire ici. Le mot de passe n’est pas stocké côté navigateur.
async function login(username, password) {
  const data = await apiRequest('/login', {
    method: 'POST',
    body: JSON.stringify({ username: username.trim(), password })
  });
  csrfToken = data.csrf_token;
  return data;
}

// Relire /me rafraîchit le jeton et vérifie encore le compte côté serveur ;
// le rôle affiché côté client ne remplace jamais les permissions des routes.
async function getCurrentUser({ signal, onAccessDenied } = {}) {
  const data = await apiRequest('/me', { signal, onAccessDenied, cache: 'no-store' }, 200);
  csrfToken = data.csrf_token;
  return data;
}

// Vider le jeton local après confirmation de la déconnexion serveur.
async function logout() {
  const data = await apiRequest('/logout', { method: 'POST' }, 200);
  if (data?.status !== 'success') throw new Error('Déconnexion non confirmée par le serveur.');
  csrfToken = null;
  return data;
}

// Nettoyer les identifiants sans modifier les espaces du mot de passe ; le
// serveur contrôle les champs et crée toujours un compte classique.
async function register(username, email, password) {
  return apiRequest('/users', {
    method: 'POST',
    body: JSON.stringify({ username: username.trim(), email: email.trim(), password })
  }, 201);
}

// Un succès de création exige 201 et un JSON lisible, avant d'effacer le formulaire.
async function createProposal(title, content) {
  return apiRequest('/proposals', {
    method: 'POST',
    body: JSON.stringify({ title, content })
  }, 201);
}

// Attendre 201 et la théorie enregistrée pour confirmer la publication.
// L'auteur sera déterminé par la session côté serveur, pas par ce JSON.
async function createTheory(storyId, title, content) {
  if (!Number.isInteger(storyId) || storyId < 1 || storyId > 2147483647) {
    throw new Error('Choisissez un dossier valide.');
  }
  const data = await apiRequest('/stories/' + storyId + '/theories', {
    method: 'POST',
    body: JSON.stringify({ title, content })
  }, 201);
  const saved = data?.theory;
  if (data?.status !== 'success' || !isContributionId(saved?.id) ||
      saved.story_id !== storyId || saved.title !== title || saved.content !== content) {
    throw new Error('Publication de la théorie non confirmée.');
  }
  return data;
}

// Vérifier la structure utile à l'affichage ne remplace pas les permissions
// serveur ; cela empêche surtout de construire le DOM avec une réponse incohérente.
function isStory(story) {
  return story && Number.isInteger(story.id) &&
    Number.isInteger(story.category_id) &&
    ['slug', 'title', 'summary', 'content'].every(field =>
      typeof story[field] === 'string') && story.slug.length > 0;
}

// Une liste vide est valide ; un objet ou un dossier mal formé provoque une erreur.
async function getStories({ signal, onAccessDenied } = {}) {
  const stories = await apiRequest('/stories', { signal, onAccessDenied }, 200);
  if (!Array.isArray(stories) || !stories.every(isStory)) {
    throw new Error('Réponse des histoires invalide.');
  }
  return stories;
}

// Encoder le slug comme un seul segment du chemin, puis vérifier le dossier reçu.
async function getStoryBySlug(slug) {
  const story = await apiRequest('/stories/slug/' + encodeURIComponent(slug), {}, 200);
  if (!isStory(story)) {
    throw new Error('Réponse du dossier invalide.');
  }
  return story;
}

// Refuser une réponse incohérente (autre dossier, doublons, champs invalides)
// évite d'afficher silencieusement des théories attribuées à la mauvaise sélection.
async function getStoryTheories(storyId, { signal } = {}) {
  if (!Number.isInteger(storyId) || storyId < 1 || storyId > 2147483647) {
    throw new Error('Choisissez un dossier valide.');
  }
  const theories = await apiRequest('/stories/' + storyId + '/theories', { signal }, 200);
  if (!Array.isArray(theories) || !theories.every(theory =>
    theory && Number.isInteger(theory.id) && theory.id > 0 &&
    theory.id <= 2147483647 && theory.story_id === storyId &&
    typeof theory.title === 'string' && typeof theory.content === 'string' &&
    (theory.created_at === null || typeof theory.created_at === 'string')) ||
    new Set(theories.map(theory => theory.id)).size !== theories.length) {
    throw new Error('Réponse des théories invalide.');
  }
  return theories;
}

// Le tableau attend des compteurs entiers positifs ou nuls ; /stats reste une
// route publique même si cette fonction est utilisée par la page administrateur.
async function getAdminStats({ signal, onAccessDenied } = {}) {
  const stats = await apiRequest('/stats', { signal, onAccessDenied }, 200);
  if (!stats || !['users', 'comments', 'reports'].every(key =>
    Number.isSafeInteger(stats[key]) && stats[key] >= 0)) {
    throw new Error('Réponse des statistiques invalide.');
  }
  return stats;
}

// Les listes administrateur attendent des identifiants distincts, les textes
// nécessaires aux cartes et une date nullable ; les droits restent contrôlés par Flask.
function isAdminList(items, fields) {
  return Array.isArray(items) && items.every(item =>
    item && Number.isInteger(item.id) && item.id > 0 && item.id <= 2147483647 &&
    fields.every(field => typeof item[field] === 'string') &&
    (item.created_at === null || typeof item.created_at === 'string')) &&
    new Set(items.map(item => item.id)).size === items.length;
}

// Lire les propositions privées sans les transformer en dossiers publiés.
async function getAdminProposals({ signal, onAccessDenied } = {}) {
  const proposals = await apiRequest('/proposals', { signal, onAccessDenied }, 200);
  if (!isAdminList(proposals, ['title', 'content', 'status'])) {
    throw new Error('Réponse des propositions invalide.');
  }
  return proposals;
}

// Lire et vérifier les signalements pour consultation ; aucun traitement de
// modération n'est déclenché par ce chargement.
async function getAdminReports({ signal, onAccessDenied } = {}) {
  const reports = await apiRequest('/admin/reports', { signal, onAccessDenied, cache: 'no-store' }, 200);
  if (!isAdminList(reports, ['type', 'target_id', 'reason', 'status']) ||
      !reports.every(isAdminReportContext)) {
    throw new Error('Réponse des signalements invalide.');
  }
  return reports;
}

function isAdminReportContext(report) {
  // L'ancien format reste lisible, sans inventer un contexte absent. Si les
  // nouveaux champs sont présents, leurs ids doivent désigner la même cible.
  const has = key => Object.prototype.hasOwnProperty.call(report, key);
  if (!has('comment') && !has('story')) return true;
  if (!has('comment') || !has('story') || report.type !== 'comment') return false;
  const { comment, story } = report;
  if (comment === null) return story === null;
  if (!comment || !isContributionId(comment.id) || String(comment.id) !== report.target_id ||
      !isContributionId(comment.story_id) || typeof comment.text !== 'string') return false;
  if (story === null) return true;
  return story && story.id === comment.story_id && isContributionId(story.category_id) &&
    typeof story.title === 'string' && typeof story.slug === 'string' && story.slug.length > 0 &&
    (story.category_name === null || typeof story.category_name === 'string') &&
    typeof story.is_archived === 'boolean';
}

// Contrôler les booléens de rôle et de bannissement avant de construire les
// boutons. Le serveur reste seul responsable de l'autorisation de l'action.
function isAdminUser(user) {
  return user && Number.isInteger(user.id) && user.id > 0 && user.id <= 2147483647 &&
    typeof user.username === 'string' && typeof user.is_admin === 'boolean' &&
    typeof user.is_banned === 'boolean';
}

async function getAdminUsers({ signal, onAccessDenied } = {}) {
  const users = await apiRequest('/users', { signal, onAccessDenied }, 200);
  if (!Array.isArray(users) || !users.every(isAdminUser) ||
      new Set(users.map(user => user.id)).size !== users.length) {
    throw new Error('Réponse des utilisateurs invalide.');
  }
  return users;
}

// Ne jamais répéter automatiquement ce POST. Une erreur réseau peut survenir
// après le commit ; l'interface devra relire la liste pour connaître l'état serveur.
async function banAdminUser(userId, { signal, onAccessDenied } = {}) {
  if (!Number.isInteger(userId) || userId < 1 || userId > 2147483647) {
    throw new Error('Choisissez un utilisateur valide.');
  }
  const data = await apiRequest('/admin/users/' + userId + '/ban', {
    method: 'POST', signal, onAccessDenied
  }, 200);
  if (data?.status !== 'success' || !isAdminUser(data.user) || data.user.id !== userId ||
      data.user.is_admin || !data.user.is_banned) {
    const error = new Error('État du bannissement à vérifier.');
    error.code = 'INVALID_BAN_RESPONSE';
    throw error;
  }
  return data;
}

// Les métadonnées d'archive n'entrent que dans les lectures privées. Une date
// absente n'est pas assimilée à NULL : une réponse ambiguë doit être refusée.
function isAdminStory(story) {
  return isStory(story) && story.id > 0 && story.id <= 2147483647 &&
    typeof story.is_archived === 'boolean' &&
    (story.archived_at === null || (typeof story.archived_at === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(story.archived_at) &&
      Number.isFinite(Date.parse(story.archived_at + 'Z')))) &&
    story.is_archived === (story.archived_at !== null);
}

async function getAdminStories({ signal, onAccessDenied } = {}) {
  const stories = await apiRequest('/admin/stories?state=archived', { signal, onAccessDenied }, 200);
  if (!Array.isArray(stories) || !stories.every(story => isAdminStory(story) && story.is_archived) ||
      new Set(stories.map(story => story.id)).size !== stories.length) {
    throw new Error('Réponse des archives invalide.');
  }
  return stories;
}

async function getAdminStory(storyId, { signal, onAccessDenied } = {}) {
  if (!Number.isInteger(storyId) || storyId < 1 || storyId > 2147483647) throw new Error('Dossier invalide.');
  const story = await apiRequest('/admin/stories/' + storyId, { signal, onAccessDenied }, 200);
  if (!isAdminStory(story) || story.id !== storyId ||
      !['comments', 'theories', 'updates'].every(key => Array.isArray(story[key])) ||
      !story.comments.every(row => row && row.story_id === storyId && typeof row.text === 'string') ||
      !story.theories.every(row => row && row.story_id === storyId && typeof row.title === 'string' && typeof row.content === 'string') ||
      !story.updates.every(row => row && row.story_id === storyId && typeof row.content === 'string')) {
    throw new Error('Réponse du dossier administratif invalide.');
  }
  return story;
}

async function changeAdminStoryArchive(storyId, archived, { signal, onAccessDenied } = {}) {
  if (!Number.isInteger(storyId) || storyId < 1 || storyId > 2147483647 || typeof archived !== 'boolean') {
    throw new Error('Dossier ou état invalide.');
  }
  // Aucun retry automatique : même après un timeout, relire l'état du serveur.
  const data = await apiRequest('/admin/stories/' + storyId + (archived ? '/archive' : '/restore'), {
    method: 'POST', signal, onAccessDenied
  }, 200);
  if (data?.status !== 'success' || typeof data.changed !== 'boolean' ||
      !isAdminStory(data.story) || data.story.id !== storyId || data.story.is_archived !== archived) {
    throw new Error("État de l'archivage à vérifier.");
  }
  return data;
}

function isManagementRevision(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && value !== '0'.repeat(32);
}

async function getStoryDeletionPreview(storyId, { signal, onAccessDenied } = {}) {
  if (!Number.isInteger(storyId) || storyId < 1 || storyId > 2147483647) throw new Error('Dossier invalide.');
  const data = await apiRequest('/admin/stories/' + storyId + '/deletion-preview', { signal, onAccessDenied }, 200);
  if (data?.story?.id !== storyId || typeof data.story.title !== 'string' ||
      !isManagementRevision(data.story.management_revision) ||
      !['comments', 'theories', 'votes', 'updates', 'reports'].every(key =>
        Number.isSafeInteger(data.impact?.[key]) && data.impact[key] >= 0) ||
      !/^"[0-9a-f]{64}"$/.test(data.resource_etag) ||
      typeof data.preview_token !== 'string' || !data.preview_token || data.preview_token.length > 4096 ||
      typeof data.expires_at !== 'string' || !Number.isFinite(Date.parse(data.expires_at))) {
    throw new Error('Aperçu de suppression invalide.');
  }
  return data;
}

async function confirmStoryDeletion(storyId, preview, typedTitle, { signal, onAccessDenied } = {}) {
  const data = await apiRequest('/admin/stories/' + storyId + '/deletion-confirmations', {
    method: 'POST', signal, onAccessDenied,
    body: JSON.stringify({ preview_token: preview.preview_token, typed_title: typedTitle, confirm_contributions: true })
  }, 200);
  if (data?.status !== 'success' || typeof data.confirmation_token !== 'string' || !data.confirmation_token ||
      data.confirmation_token.length > 4096 || data.expires_at !== preview.expires_at) {
    throw new Error('Confirmation du serveur invalide.');
  }
  return data.confirmation_token;
}

async function deleteAdminStory(storyId, preview, token, { signal, onAccessDenied } = {}) {
  const data = await apiRequest('/admin/stories/' + storyId, { method: 'DELETE', signal, onAccessDenied,
    conditionalHeaders: { 'If-Match': preview.resource_etag, 'X-Deletion-Confirmation': token }
  }, 200);
  if (data?.status !== 'success' || data.code !== 'STORY_DELETED' || data.deleted_story?.id !== storyId ||
      data.deleted_story.management_revision !== preview.story.management_revision ||
      !['comments', 'theories', 'votes', 'updates', 'reports'].every(key =>
        data.deleted_counts?.[key] === preview.impact[key])) {
    throw new Error('Réponse de suppression à vérifier.');
  }
  return data;
}

async function verifyAdminStoryState(storyId, { signal, onAccessDenied } = {}) {
  try {
    const data = await apiRequest('/admin/stories/' + storyId, { signal, onAccessDenied }, 200);
    if (!isAdminStory(data) || data.id !== storyId || !isManagementRevision(data.management_revision)) {
      throw new Error('État administratif invalide.');
    }
    return { state: 'present', revision: data.management_revision };
  } catch (error) {
    // 404 constate une absence, sans prouver quelle requête l'a provoquée.
    if (error.status === 404) return { state: 'absent' };
    throw error;
  }
}

// Les seules cibles de signalement sont les commentaires renvoyés par ce dossier.
function isContributionId(id) {
  return Number.isInteger(id) && id > 0 && id <= 2147483647;
}

function isStoryComment(comment, storyId) {
  return comment && isContributionId(comment.id) && comment.story_id === storyId &&
    (comment.user_id === null || isContributionId(comment.user_id)) &&
    (comment.username === null || typeof comment.username === 'string') &&
    typeof comment.text === 'string' &&
    (comment.created_at === null || typeof comment.created_at === 'string');
}

async function getStoryComments(storyId, { signal } = {}) {
  if (!isContributionId(storyId)) throw new Error('Dossier invalide.');
  const comments = await apiRequest('/stories/' + storyId + '/comments', { signal }, 200);
  if (!Array.isArray(comments) || !comments.every(item => isStoryComment(item, storyId)) ||
      new Set(comments.map(item => item.id)).size !== comments.length) {
    throw new Error('Réponse des commentaires invalide.');
  }
  return comments;
}

// Un JSON 201 incohérent laisse le résultat incertain : ne pas proposer une relance.
async function createComment(storyId, text) {
  if (!isContributionId(storyId)) throw new Error('Dossier invalide.');
  const data = await apiRequest('/stories/' + storyId + '/comments', {
    method: 'POST', body: JSON.stringify({ text })
  }, 201);
  if (data?.status !== 'success' || !isStoryComment(data.comment, storyId)) {
    throw new Error('Confirmation du commentaire invalide.');
  }
  return data.comment;
}

async function reportComment(commentId, reason) {
  if (!isContributionId(commentId)) throw new Error('Commentaire invalide.');
  const data = await apiRequest('/comments/' + commentId + '/report', {
    method: 'POST', body: JSON.stringify({ reason })
  }, 201);
  if (data?.status !== 'success' || !isContributionId(data.report?.id) ||
      data.report.type !== 'comment' || data.report.target_id !== String(commentId)) {
    throw new Error('Confirmation du signalement invalide.');
  }
  return data.report;
}

// Les chemins sont choisis par le code, jamais à partir d'un type arbitraire.
function likePath(kind, id) {
  if (!isContributionId(id) || !['story', 'comment'].includes(kind)) throw new Error('Cible de like invalide.');
  return kind === 'story' ? '/votes/' + id : '/comments/' + id + '/like';
}

function isLikeCount(value) { return Number.isSafeInteger(value) && value >= 0; }

async function getLikeState(kind, id, { signal } = {}) {
  const data = await apiRequest(likePath(kind, id), { signal }, 200);
  if (data?.status !== 'success' || data.target_type !== kind || data.target_id !== id ||
      !isLikeCount(data.likes) || typeof data.liked_by_me !== 'boolean') {
    throw new Error('État du like incohérent.');
  }
  return data;
}

async function changeLike(kind, id, wanted) {
  if (typeof wanted !== 'boolean') throw new Error('Intention de like invalide.');
  const data = await apiRequest(likePath(kind, id), { method: wanted ? 'POST' : 'DELETE' },
    wanted && kind === 'story' ? 201 : 200);
  const valid = !wanted ? data?.status === 'success' && data.target_type === kind &&
    data.target_id === id && data.liked_by_me === false && typeof data.changed === 'boolean' && isLikeCount(data.likes) :
    kind === 'story' ? typeof data?.message === 'string' && isLikeCount(data.votes) :
      data?.status === 'success' && data.comment?.id === id && data.comment.likes_compatible === true && isLikeCount(data.comment.likes);
  if (!valid) throw new Error('Confirmation du like incohérente.');
  return data;
}
