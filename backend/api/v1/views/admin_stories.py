"""Archivage réversible : aucune suppression de dossier ou de contribution."""

from datetime import datetime
from functools import wraps
from uuid import uuid4

from flask import jsonify, request
from sqlalchemy.exc import SQLAlchemyError

from api.v1.views import app_views
from api.v1.views.permissions import admin_required
from api.v1.views.write_support import api_error, MAX_RESOURCE_ID
from models import db, Story, Vote


def archive_admin_required(view):
    secured = admin_required(view)

    @wraps(view)
    def wrapped(*args, **kwargs):
        # Inclure la relecture du rôle dans la gestion SQL, pour renvoyer aussi
        # une erreur JSON si la base échoue avant d'entrer dans la vue protégée.
        try:
            return secured(*args, **kwargs)
        except SQLAlchemyError:
            db.session.rollback()
            return api_error('Service administratif indisponible.', 500)
    return wrapped


def admin_story_data(story):
    data = story.to_dict()
    data.update(
        archived_at=story.archived_at.isoformat() if story.archived_at else None,
        is_archived=story.archived_at is not None,
        management_revision=story.management_revision,
        votes=Vote.query.filter_by(story_id=story.id).count(),
    )
    return data


@app_views.after_request
def protect_admin_story_cache(response):
    # Les archives privées et leurs reçus ne doivent pas rester en cache HTTP.
    if request.path.startswith('/api/v1/admin/stories'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app_views.route('/admin/stories', methods=['GET'])
@archive_admin_required
def get_admin_stories():
    state = request.args.get('state', 'active')
    if state not in ('active', 'archived', 'all'):
        return api_error('État attendu : active, archived ou all.', 400)
    try:
        query = Story.query
        if state == 'active':
            query = query.filter(Story.archived_at.is_(None))
        elif state == 'archived':
            query = query.filter(Story.archived_at.is_not(None))
        return jsonify([admin_story_data(story) for story in query.order_by(
            Story.created_at.desc(), Story.id.desc()).all()]), 200
    except SQLAlchemyError:
        db.session.rollback()
        return api_error('Impossible de lire les dossiers administratifs.', 500)


@app_views.route('/admin/stories/<int:story_id>', methods=['GET'])
@archive_admin_required
def get_admin_story(story_id):
    if not 1 <= story_id <= MAX_RESOURCE_ID:
        return api_error('Dossier introuvable.', 404)
    try:
        story = db.session.get(Story, story_id)
        if story is None:
            return api_error('Dossier introuvable.', 404)
        # Réutiliser les sérialiseurs publics sans rouvrir leurs routes aux
        # archives. Les motifs de signalement restent dans /admin/reports.
        from api.v1.views.comments import comment_to_dict
        from api.v1.views.theories import theory_to_dict
        data = admin_story_data(story)
        data['comments'] = [comment_to_dict(row) for row in story.comments]
        data['theories'] = [theory_to_dict(row) for row in story.theories]
        data['updates'] = [row.to_dict() for row in story.cold_case_updates]
        return jsonify(data), 200
    except SQLAlchemyError:
        db.session.rollback()
        return api_error('Impossible de lire ce dossier.', 500)


def set_story_archive(story_id, *, archived):
    if not 1 <= story_id <= MAX_RESOURCE_ID:
        return api_error('Dossier introuvable.', 404)
    try:
        # Le verrou est partagé avec tous les écrivains de contributions.
        # Deux requêtes identiques ont un seul effet ; la seconde est un succès
        # explicite changed=false, sans changer la date du premier archivage.
        story = Story.query.filter_by(id=story_id).populate_existing().with_for_update().first()
        if story is None:
            return api_error('Dossier introuvable.', 404)
        changed = (story.archived_at is not None) != archived
        if changed:
            story.archived_at = datetime.utcnow() if archived else None
            story.management_revision = uuid4().hex
        db.session.flush()
        data = admin_story_data(story)
        db.session.commit()
        return jsonify(status='success', changed=changed, story=data), 200
    except SQLAlchemyError:
        db.session.rollback()
        return api_error("Impossible de modifier l'archivage du dossier.", 500)


@app_views.route('/admin/stories/<int:story_id>/archive', methods=['POST'])
@archive_admin_required
def archive_story(story_id):
    return set_story_archive(story_id, archived=True)


@app_views.route('/admin/stories/<int:story_id>/restore', methods=['POST'])
@archive_admin_required
def restore_story(story_id):
    return set_story_archive(story_id, archived=False)


@app_views.route('/admin/stories/<int:story_id>/deletion-preview', methods=['GET'])
@archive_admin_required
def get_story_deletion_preview(story_id):
    from api.v1.views.story_deletion_support import deletion_preview, run_deletion_action
    return run_deletion_action(deletion_preview, story_id)


@app_views.route('/admin/stories/<int:story_id>/deletion-confirmations', methods=['POST'])
@archive_admin_required
def confirm_story_deletion(story_id):
    from api.v1.views.story_deletion_support import confirm_deletion, run_deletion_action
    return run_deletion_action(confirm_deletion, story_id)


@app_views.route('/admin/stories/<int:story_id>', methods=['DELETE'])
@archive_admin_required
def delete_story_permanently(story_id):
    from api.v1.views.story_deletion_support import delete_story, run_deletion_action
    return run_deletion_action(delete_story, story_id)
