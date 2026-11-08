from flask import jsonify

from api.v1.views import app_views
from api.v1.views.permissions import get_authenticated_user
from models import db, Theory, Story
from sqlalchemy import update
from sqlalchemy.exc import SQLAlchemyError
from api.v1.views.write_support import api_error, get_resource, json_object, required_text
from api.v1.views.story_visibility import get_active_story


# Construire les champs JSON attendus par le lecteur, sans exposer l'objet ORM.
# La date devient du texte ISO ou None ; aucune écriture SQL n'est effectuée ici.
def theory_to_dict(theory):
    """Convert a Theory object to a dictionary."""
    return {
        "id": theory.id,
        "story_id": theory.story_id,
        "user_id": theory.user_id,
        "title": theory.title,
        "content": theory.content,
        "likes": theory.likes,
        "created_at": (
            theory.created_at.isoformat()
            if theory.created_at else None
        )
    }


@app_views.route(
    "/stories/<int:story_id>/theories",
    methods=["GET"]
)
# GET public : vérifier le dossier distingue une liste vide (200) d'un dossier
# inexistant (404), puis le tri chronologique stabilise la lecture.
def get_theories(story_id):
    """Return theories for one story."""
    story = get_active_story(story_id)

    if not story:
        return jsonify({
            "error": "Story not found"
        }), 404

    theories = (
        Theory.query
        .filter_by(story_id=story_id)
        .order_by(Theory.created_at.asc())
        .all()
    )

    return jsonify([
        theory_to_dict(theory)
        for theory in theories
    ]), 200


@app_views.route(
    "/stories/<int:story_id>/theories",
    methods=["POST"]
)
# POST exige une session autorisée ; le filtre global a déjà vérifié son CSRF.
# L'auteur vient du compte relu en base, jamais d'un user_id fourni dans le JSON.
def post_theory(story_id):
    """Create a theory for one story."""
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

    title, error_response = required_text(
        req_data, "title", max_length=Theory.title.type.length
    )
    if error_response:
        return error_response

    content, error_response = required_text(req_data, "content", text_column=True)
    if error_response:
        return error_response

    new_theory = Theory(
        story_id=story_id,
        user_id=user.id,
        title=title,
        content=content
    )

    # add prépare l'objet ; commit déclenche le flush puis valide la transaction.
    # En cas d'erreur SQL, rollback annule les écritures non validées et rétablit
    # une session utilisable avant de renvoyer la réponse d’échec.
    try:
        db.session.add(new_theory)
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        return api_error("Impossible de creer la theorie.", 500)

    return jsonify({
        "status": "success",
        "theory": theory_to_dict(new_theory)
    }), 201


@app_views.route(
    "/theories/<int:theory_id>/like",
    methods=["POST"]
)
# L'incrément est fait par SQL afin de ne pas écraser un like concurrent.
# Il n'y a pas ici de contrainte imposant un seul like par utilisateur.
def like_theory(theory_id):
    """Add one like to a theory."""
    user, error_response = get_authenticated_user()

    if error_response:
        return error_response

    theory = get_resource(Theory, theory_id)

    if not theory or not get_active_story(theory.story_id, lock=True):
        return jsonify({
            "error": "Theory not found"
        }), 404

    try:
        # Increment in SQL to avoid overwriting concurrent likes.
        result = db.session.execute(
            update(Theory)
            .where(Theory.id == theory.id)
            .values(likes=Theory.likes + 1)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount == 0:
            db.session.rollback()
            return jsonify({"error": "Theory not found"}), 404
        db.session.refresh(theory)
        payload = theory_to_dict(theory)
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        return api_error("Impossible d'enregistrer le like.", 500)

    return jsonify({
        "status": "success",
        "theory": payload
    }), 200
