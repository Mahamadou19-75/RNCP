from flask import jsonify

from api.v1.views import app_views
from api.v1.views.permissions import get_authenticated_user
from models import db, Comment, Story, Report, CommentLike
from sqlalchemy.exc import SQLAlchemyError
from api.v1.views.write_support import api_error, get_resource, json_object, required_text
from api.v1.views.story_visibility import get_active_story


# Compter les lignes reports évite de maintenir un second compteur susceptible
# de diverger ; target_id est comparé au texte représentant le commentaire.
def comment_to_dict(comment):
    data = comment.to_dict()
    # Préserver exactement l'ancien nombre s'il est ambigu ; l'interface le
    # distingue alors des likes individuels et n'autorise aucune écriture.
    from api.v1.views.likes import legacy_likes_compatible
    data['likes_compatible'] = legacy_likes_compatible(comment)
    if data['likes_compatible']:
        data['likes'] = CommentLike.query.filter_by(comment_id=comment.id).count()

    data["reports"] = Report.query.filter_by(
        comment_id=comment.id
    ).count()

    return data


@app_views.route("/stories/<int:story_id>/comments", methods=["GET"])
# La lecture des commentaires est publique ; les erreurs de dossier et une
# liste sans contribution restent deux réponses différentes.
def get_story_comments(story_id):
    story = get_active_story(story_id)

    if not story:
        return jsonify({
            "error": "Story not found"
        }), 404

    comments = (
        Comment.query
        .filter_by(story_id=story_id)
        .order_by(Comment.created_at.asc())
        .all()
    )

    return jsonify([
        comment_to_dict(comment)
        for comment in comments
    ]), 200


@app_views.route("/stories/<int:story_id>/comments", methods=["POST"])
# Créer le commentaire avec l'identité de session, puis valider la transaction.
# Le pseudo est aussi copié en texte ; supprimer la référence auteur ne l'efface pas.
def post_story_comment(story_id):
    user, error_response = get_authenticated_user()

    if error_response:
        return error_response

    story = get_active_story(story_id, lock=True)

    if not story:
        return jsonify({
            "error": "Story not found"
        }), 404

    req_data, error_response = json_object()
    if error_response:
        return error_response

    text, error_response = required_text(req_data, "text", text_column=True)
    if error_response:
        return error_response

    new_comment = Comment(
        story_id=story_id,
        user_id=user.id,
        username=user.username,
        text=text
    )

    # add prépare l'objet ; commit déclenche le flush puis valide la transaction.
    # En cas d'erreur SQL, rollback annule les écritures non validées et rétablit
    # une session utilisable avant de renvoyer la réponse d’échec.
    try:
        db.session.add(new_comment)
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        return api_error("Impossible de creer le commentaire.", 500)

    return jsonify({
        "status": "success",
        "comment": comment_to_dict(new_comment)
    }), 201


@app_views.route("/comments/<int:comment_id>/like", methods=["POST"])
# Un couple compte/commentaire remplace les clics répétés. L'ancien nombre
# non nul bloque explicitement la reprise ; il n'est jamais remis à zéro.
def like_comment(comment_id):
    from api.v1.views.likes import handle_like
    return handle_like('comment', comment_id, 'add')


@app_views.route("/comments/<int:comment_id>/report", methods=["POST"])
# Cette seconde entrée de signalement connaît déjà sa cible par le chemin.
# Vérifier le commentaire et le motif avant d'ajouter une ligne reports.
def report_comment(comment_id):
    user, error_response = get_authenticated_user()

    if error_response:
        return error_response

    comment = get_resource(Comment, comment_id)

    if not comment or not get_active_story(comment.story_id, lock=True):
        return jsonify({
            "error": "Comment not found"
        }), 404

    req_data, error_response = json_object()
    if error_response:
        return error_response

    reason, error_response = required_text(
        req_data, "reason", text_column=True
    )
    if error_response:
        return error_response

    report = Report(
        comment_id=comment.id,
        reason=reason
    )

    try:
        db.session.add(report)
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        return api_error("Impossible de signaler le commentaire.", 500)

    return jsonify({
        "status": "success",
        "report": report.to_dict()
    }), 201
