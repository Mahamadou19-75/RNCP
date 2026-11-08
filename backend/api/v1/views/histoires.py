from flask import jsonify

from api.v1.views import app_views
from api.v1.views.permissions import get_authenticated_user
from models import db, Story, Vote, ColdCaseUpdate
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from api.v1.views.write_support import api_error, get_resource, is_unique_conflict
from api.v1.views.story_visibility import get_active_story


@app_views.route('/stories', methods=['GET'])
# GET public : lire les dossiers triés et calculer leurs votes. Le comptage
# par dossier est simple, mais multiplie les requêtes quand la liste grandit.
def get_stories():
    """Return all stories."""
    stories = Story.query.filter_by(archived_at=None).order_by(Story.created_at.desc()).all()

    result = []

    for story in stories:
        result.append({
            "id": story.id,
            "slug": story.slug,
            "title": story.title,
            "summary": story.summary,
            "content": story.content,
            "image_url": story.image_url,
            "category_id": story.category_id,
            "author_id": story.author_id,
            "votes": Vote.query.filter_by(
                story_id=story.id
            ).count(),
            "created_at": (
                story.created_at.isoformat()
                if story.created_at else None
            )
        })

    return jsonify(result), 200


@app_views.route('/stories/slug/<string:slug>', methods=['GET'])
# Un slug absent donne 404 ; il ne faut pas fabriquer un dossier de remplacement.
def get_story_by_slug(slug):
    """Return one story using its slug."""
    story = Story.query.filter_by(slug=slug, archived_at=None).first()

    if not story:
        return jsonify({
            "error": "Story not found"
        }), 404

    vote_count = Vote.query.filter_by(
        story_id=story.id
    ).count()

    result = story.to_dict()
    result["votes"] = vote_count

    return jsonify(result), 200


@app_views.route('/votes/<int:story_id>', methods=['POST'])
# POST lie le vote au compte authentifié. Le précontrôle et la contrainte
# composite garantissent le même objectif ; un vote déjà présent donne 409.
def post_story_vote(story_id):
    """Add one vote to a story for the authenticated user."""
    user, error_response = get_authenticated_user()

    if error_response:
        return error_response

    story = get_active_story(story_id, lock=True)

    if not story:
        return jsonify({
            "error": "Story not found"
        }), 404

    existing_vote = Vote.query.filter_by(
        story_id=story_id,
        user_id=user.id
    ).first()

    if existing_vote:
        return jsonify({
            "error": "Vous avez déjà voté pour cette histoire"
        }), 409

    new_vote = Vote(
        story_id=story_id,
        user_id=user.id
    )

    # add prépare l'objet ; commit déclenche le flush puis valide la transaction.
    # En cas d'erreur SQL, rollback annule les écritures non validées et rétablit
    # une session utilisable avant de renvoyer la réponse d’échec.
    try:
        db.session.add(new_vote)
        db.session.flush()
        vote_count = Vote.query.filter_by(story_id=story_id).count()
        db.session.commit()
    except IntegrityError as error:
        db.session.rollback()
        if is_unique_conflict(
            error, mysql_keys={"unique_user_story_vote"},
            sqlite_columns={frozenset({"votes.user_id", "votes.story_id"})},
        ):
            return jsonify({"error": "Vous avez déjà voté pour cette histoire"}), 409
        return api_error("Impossible d'enregistrer le vote.", 500)
    except SQLAlchemyError:
        db.session.rollback()
        return api_error("Impossible d'enregistrer le vote.", 500)

    return jsonify({
        "message": "Vote pris en compte !",
        "votes": vote_count
    }), 201


@app_views.route('/coldcases/<int:case_id>/updates', methods=['GET'])
# GET public : vérifier le dossier puis lire les mises à jour chronologiques.
# Cette route ne contrôle pas que la catégorie du dossier soit Cold Case.
def get_case_updates(case_id):
    """Return updates for a cold case."""
    story = get_active_story(case_id)

    if not story:
        return jsonify({
            "error": "Story not found"
        }), 404

    updates = ColdCaseUpdate.query.filter_by(
        story_id=case_id
    ).order_by(
        ColdCaseUpdate.created_at.asc()
    ).all()

    return jsonify([
        update.to_dict()
        for update in updates
    ]), 200
