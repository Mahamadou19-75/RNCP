"""État personnel et retrait des likes ; aucune attribution côté client."""
from flask import jsonify, request
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from api.v1.views import app_views
from api.v1.views.permissions import get_authenticated_user
from api.v1.views.story_visibility import get_active_story
from api.v1.views.write_support import api_error, get_resource, is_unique_conflict
from models import db, Comment, CommentLike, Vote


def legacy_likes_compatible(comment):
    # Zéro seul est compatible. Ni un historique positif, ni une donnée
    # invalide ne peuvent être attribués silencieusement aux comptes actuels.
    return type(comment.likes) is int and comment.likes == 0


def like_state(kind, identifier, user_id):
    model = Vote if kind == 'story' else CommentLike
    predicate = model.story_id == identifier if kind == 'story' else model.comment_id == identifier
    query = model.query.filter(predicate)
    return {'status': 'success', 'target_type': kind, 'target_id': identifier,
            'likes': query.count(), 'liked_by_me': query.filter_by(user_id=user_id).first() is not None}


def handle_like(kind, identifier, action='read'):
    try:
        user, error = get_authenticated_user()
        if error:
            return error
        if kind == 'story':
            target = get_active_story(identifier, lock=action != 'read')
        else:
            target = get_resource(Comment, identifier)
            if target and not get_active_story(target.story_id, lock=action != 'read'):
                target = None
        if target is None:
            return api_error('Élément introuvable ou archivé.', 404)
        if kind == 'comment':
            # Recharger le compteur physique évite de décider sur un objet ORM
            # périmé. Aucune valeur historique n'est réécrite par ce refresh.
            db.session.refresh(target)
        if kind == 'comment' and not legacy_likes_compatible(target):
            return jsonify(status='error', code='LEGACY_LIKES_UNRESOLVED',
                           message='Compteur historique non attribuable : décision de reprise nécessaire.'), 409
        if action == 'read':
            return jsonify(like_state(kind, identifier, user.id)), 200

        model = Vote if kind == 'story' else CommentLike
        predicate = model.story_id == identifier if kind == 'story' else model.comment_id == identifier
        own = (predicate, model.user_id == user.id)
        if action == 'add':
            if model.query.filter(*own).first() is not None:
                return api_error('Vous avez déjà aimé ce commentaire.', 409)
            db.session.add(CommentLike(comment_id=identifier, user_id=user.id))
            db.session.flush()
            from api.v1.views.comments import comment_to_dict
            payload = {'status': 'success', 'comment': comment_to_dict(target)}
        else:
            # Filtrer les deux identifiants protège les likes des autres comptes.
            result = db.session.execute(delete(model).where(*own))
            if result.rowcount not in (0, 1):
                raise SQLAlchemyError('Unicité du couple non garantie.')
            payload = like_state(kind, identifier, user.id)
            payload['changed'] = result.rowcount == 1
        # Préparer le JSON avant commit évite une lecture ORM implicite après
        # validation. Une réponse réseau perdue reste néanmoins indéterminée.
        db.session.commit()
        return jsonify(payload), 200
    except IntegrityError as error:
        db.session.rollback()
        if action == 'add' and is_unique_conflict(
            error, mysql_keys={'unique_user_comment_like'},
            sqlite_columns={frozenset({'comment_likes.user_id', 'comment_likes.comment_id'})}
        ):
            return api_error('Vous avez déjà aimé ce commentaire.', 409)
        return api_error('Impossible de modifier le like.', 500)
    except SQLAlchemyError:
        db.session.rollback()
        return api_error('Service des likes indisponible.', 500)


@app_views.route('/votes/<int:story_id>', methods=['GET', 'DELETE'])
def personal_story_like(story_id):
    return handle_like('story', story_id, 'remove' if request.method == 'DELETE' else 'read')


@app_views.route('/comments/<int:comment_id>/like', methods=['GET', 'DELETE'])
def personal_comment_like(comment_id):
    return handle_like('comment', comment_id, 'remove' if request.method == 'DELETE' else 'read')


@app_views.after_request
def protect_personal_likes_cache(response):
    path = request.path
    if path.startswith('/api/v1/votes/') or path.startswith('/api/v1/comments/') and path.endswith('/like'):
        response.headers['Cache-Control'] = 'private, no-store'
    return response
