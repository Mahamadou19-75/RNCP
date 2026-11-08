'use strict';

// Le tableau crée ce panneau une seule fois et lui confie son signal d'annulation
// et son traitement des 401/403. Aucune donnée privée n'est conservée au départ.
function createAdminUsersPanel() {
  const section = document.getElementById('admin-users');
  if (!section) return null;
  const list = document.getElementById('admin-users-list');
  const feedback = document.getElementById('admin-users-feedback');
  const refresh = document.getElementById('admin-users-refresh');
  let version = 0;
  let active = null;
  let busy = false;
  let options = {};
  let users = [];

  function clear() {
    version += 1;
    active?.abort();
    active = null;
    users = [];
    busy = false;
    list.replaceChildren();
    feedback.textContent = '';
    refresh.disabled = true;
    section.setAttribute('aria-busy', 'false');
  }

  // La version complète AbortController : une réponse déjà partie peut arriver
  // malgré l'annulation, mais elle ne pourra plus réafficher une ancienne liste.
  function begin() {
    version += 1;
    active?.abort();
    active = new AbortController();
    busy = true;
    refresh.disabled = true;
    list.replaceChildren();
    section.setAttribute('aria-busy', 'true');
    return { current: version, signal: active.signal };
  }

  function accessOptions(current, signal) {
    return { signal, onAccessDenied: error => {
      if (current !== version) return;
      clear();
      options.onAccessDenied?.(error);
    } };
  }

  function finish(current) {
    if (current !== version) return;
    busy = false;
    active = null;
    refresh.disabled = false;
    section.setAttribute('aria-busy', 'false');
  }

  function displayUsers() {
    const cards = users.map(user => {
      const card = document.createElement('article');
      card.className = 'panel';
      const title = document.createElement('h3');
      title.textContent = user.username;
      const role = document.createElement('p');
      role.textContent = 'Rôle : ' + (user.is_admin ? 'Administrateur' : 'Utilisateur');
      const status = document.createElement('p');
      status.textContent = 'Statut : ' + (user.is_banned ? 'Banni' : 'Actif');
      card.append(title, role, status);
      if (user.is_admin) {
        const protectedText = document.createElement('p');
        protectedText.textContent = 'Compte administrateur protégé';
        card.append(protectedText);
      } else if (!user.is_banned) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.textContent = 'Bannir cet utilisateur';
        button.addEventListener('click', () => ban(user));
        card.append(button);
      }
      return card;
    });
    list.replaceChildren(...cards);
  }

  async function readUsers(current, signal) {
    const result = await getAdminUsers(accessOptions(current, signal));
    if (current !== version) return false;
    users = result;
    displayUsers();
    return true;
  }

  async function load(nextOptions = options) {
    options = nextOptions;
    const { current, signal } = begin();
    feedback.textContent = 'Chargement des utilisateurs...';
    try {
      const session = await getCurrentUser(accessOptions(current, signal));
      if (current !== version) return;
      if (session?.user?.is_admin !== true) {
        accessOptions(current, signal).onAccessDenied({ status: 403 });
        return;
      }
      if (await readUsers(current, signal)) {
        feedback.textContent = users.length ? 'Utilisateurs chargés.' : 'Aucun utilisateur.';
      }
    } catch (error) {
      if (current !== version) return;
      feedback.textContent = 'Impossible de charger les utilisateurs. Utilisez Actualiser pour réessayer.';
    } finally { finish(current); }
  }

  // Verrouiller avant la première attente empêche les doubles clics. Le pseudo
  // est du texte dans la confirmation ; aucun contenu utilisateur n'est du HTML.
  async function ban(user) {
    if (busy || user.is_admin || user.is_banned || !users.some(item => item.id === user.id)) return;
    if (!window.confirm('Bannir « ' + user.username + ' » ? Ses prochains accès authentifiés seront bloqués. Son compte et ses contributions seront conservés.')) return;
    const { current, signal } = begin();
    feedback.textContent = 'Bannissement en cours...';
    let message;
    try {
      const session = await getCurrentUser(accessOptions(current, signal));
      if (current !== version) return;
      if (session?.user?.is_admin !== true) {
        accessOptions(current, signal).onAccessDenied({ status: 403 });
        return;
      }
      await banAdminUser(user.id, accessOptions(current, signal));
      message = 'Bannissement confirmé. État relu sur le serveur.';
    } catch (error) {
      if (current !== version) return;
      message = error.status === 409 ?
        'Ce compte est désormais protégé. Liste actualisée.' :
        error.status === 404 ? 'Cet utilisateur n’existe plus. Liste actualisée.' :
        'Réponse du bannissement incertaine. Aucun nouvel envoi automatique ; vérification de l’état serveur.';
    }
    try {
      // Même après un timeout, relire le serveur plutôt que supposer un échec
      // du commit. Le POST n'est jamais rejoué et son résultat tardif est écarté.
      if (current === version && await readUsers(current, signal)) feedback.textContent = message;
    } catch (error) {
      if (current !== version) return;
      feedback.textContent = 'État du bannissement non vérifié. Utilisez Actualiser avant une nouvelle action.';
    } finally { finish(current); }
  }

  refresh.addEventListener('click', () => { if (!busy) return load(); });
  return { load, clear };
}
