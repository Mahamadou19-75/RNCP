from functools import wraps

from flask import jsonify, session

from models import db, User


# La signature du cookie permet de lire user_id, mais le compte est relu en
# base à chaque contrôle : un compte supprimé ou banni perd ainsi son accès.
def get_authenticated_user():
    """Return the authenticated user or an API error response."""
    user_id = session.get("user_id")

    if user_id is None:
        return None, (
            jsonify({
                "status": "error",
                "message": "Authentification requise."
            }),
            401
        )

    user = db.session.get(User, user_id)

    if not user:
        session.clear()

        return None, (
            jsonify({
                "status": "error",
                "message": "Utilisateur introuvable."
            }),
            401
        )

    if user.is_banned:
        session.clear()

        return None, (
            jsonify({
                "status": "error",
                "message": "Compte suspendu."
            }),
            403
        )

    return user, None


# Le décorateur applique le contrôle commun puis lit user.is_admin en base.
# Un booléen envoyé par le navigateur ou l'affichage du menu ne donne aucun droit.
def admin_required(view_function):
    """Allow access only to authenticated administrators."""
    @wraps(view_function)
    def wrapped_view(*args, **kwargs):
        user, error_response = get_authenticated_user()

        if error_response:
            return error_response

        if not user.is_admin:
            return jsonify({
                "status": "error",
                "message": "Acces administrateur requis."
            }), 403

        return view_function(*args, **kwargs)

    return wrapped_view
