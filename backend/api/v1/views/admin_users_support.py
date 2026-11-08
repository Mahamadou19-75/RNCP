"""Shared administrator representations and ban transaction; no schema change."""

from flask import jsonify
from sqlalchemy.exc import SQLAlchemyError

from models import db, User
from api.v1.views.write_support import api_error, MAX_RESOURCE_ID


# Le statut de suspension est réservé aux réponses administrateur. La méthode
# publique User.to_dict reste inchangée, notamment pour l'inscription.
def admin_user_to_dict(user):
    return {**user.to_dict(), "is_banned": bool(user.is_banned)}


# Les deux routes passent par cette transaction, après admin_required et le
# filtre CSRF global. Le verrou de ligne est utilisé par les moteurs compatibles ;
# SQLite ne démontre pas le comportement de ce verrou sous MySQL.
def ban_user_account(*, user_id=None, username=None):
    try:
        if user_id is not None:
            if not 1 <= user_id <= MAX_RESOURCE_ID:
                return jsonify({"status": "error", "message": "Utilisateur introuvable.", "error": "User not found"}), 404
            query = User.query.filter_by(id=user_id)
        else:
            query = User.query.filter_by(username=username)
        user = query.populate_existing().with_for_update().first()
        if user is None:
            return jsonify({"status": "error", "message": "Utilisateur introuvable.", "error": "User not found"}), 404
        # Protéger tous les administrateurs, y compris l'auteur de l'action.
        # Le 409 est un refus de cible, distinct d'une session refusée en 401/403.
        if user.is_admin:
            return jsonify({
                "status": "error", "code": "ADMIN_PROTECTED",
                "message": "Les comptes administrateurs sont protégés du bannissement."
            }), 409

        already_banned = user.is_banned
        user.is_banned = True
        payload = admin_user_to_dict(user)
        # Aucun objet lié n'est supprimé : seul is_banned change. Commit valide
        # la transaction ; rollback annule aussi un flush ayant précédé l'erreur.
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        return api_error("Impossible de bannir l'utilisateur.", 500)

    return jsonify({
        "status": "success",
        "message": "Cet utilisateur est déjà banni." if already_banned else "Utilisateur banni.",
        "user": payload
    }), 200
