"""Purge conditionnelle, sans reçu persistant ni relance automatique."""
import hashlib
import json
import re
import time
from datetime import datetime
from uuid import uuid4

from flask import current_app, jsonify, request, session
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
import sqlalchemy as sa
from sqlalchemy.exc import SQLAlchemyError

from models import db, User, Story, Comment, Theory, Vote, ColdCaseUpdate, Report, CommentLike
from api.v1.views.write_support import MAX_RESOURCE_ID

TTL = 300
MAX_DEPENDENCIES = 10000
SENTINEL = '0' * 32
PUBLIC_FAMILIES = [('comments', Comment), ('theories', Theory), ('votes', Vote),
                   ('updates', ColdCaseUpdate), ('reports', Report)]
# Les likes sont des dépendances internes des commentaires : le contrat des
# cinq nombres publics et les sept indicateurs du dashboard restent inchangés.
FAMILIES = PUBLIC_FAMILIES + [('comment_likes', CommentLike)]


class PurgeError(Exception):
    def __init__(self, message, status, code):
        self.message, self.status, self.code = message, status, code


def fail(message, status=409, code='DELETE_CONDITIONS_NOT_MET'):
    raise PurgeError(message, status, code)


def signer():
    return URLSafeTimedSerializer(current_app.secret_key, salt='story-deletion-v1',
                                  signer_kwargs={'digest_method': hashlib.sha256})


def session_binding():
    # Le jeton de session n'est ni recopié dans les signatures ni journalisé.
    return hashlib.sha256(str(session.get('csrf_token', '')).encode()).hexdigest()


def load_token(value, purpose):
    if value is None:
        fail('Confirmation requise.', 428, 'PRECONDITION_REQUIRED')
    if not isinstance(value, str) or not value.isascii() or len(value) > 4096:
        fail('Confirmation invalide.', 403, 'INVALID_CONFIRMATION')
    try:
        data = signer().loads(value, max_age=TTL)
    except SignatureExpired:
        fail('Confirmation expirée : relire le dossier.', 412, 'STALE_CONFIRMATION')
    except BadSignature:
        fail('Confirmation invalide.', 403, 'INVALID_CONFIRMATION')
    if (not isinstance(data, dict) or data.get('purpose') != purpose or
            data.get('user_id') != session.get('user_id') or data.get('session') != session_binding()):
        fail('Confirmation invalide pour cette session.', 403, 'INVALID_CONFIRMATION')
    if not isinstance(data.get('expires'), (int, float)) or data['expires'] <= time.time():
        fail('Confirmation expirée : relire le dossier.', 412, 'STALE_CONFIRMATION')
    return data


def lock_actor():
    user = User.query.filter_by(id=session.get('user_id')).populate_existing().with_for_update(read=True).first()
    if user is None:
        fail('Authentification requise.', 401, 'AUTH_REQUIRED')
    if not user.is_admin or user.is_banned:
        fail('Administrateur actif requis.', 403, 'ADMIN_REQUIRED')
    return user


def require_integrity():
    connection = db.session.connection()
    dialect = connection.dialect.name
    if dialect == 'sqlite':
        if connection.exec_driver_sql('PRAGMA foreign_keys').scalar() != 1:
            fail('Purge indisponible : intégrité non activée.', 503, 'PURGE_UNAVAILABLE')
    elif dialect == 'mysql':
        if db.session.execute(sa.text('SELECT @@foreign_key_checks')).scalar() != 1:
            fail('Purge indisponible : intégrité non activée.', 503, 'PURGE_UNAVAILABLE')
        names = ('users', 'stories', 'comments', 'theories', 'votes', 'cold_case_updates', 'reports', 'comment_likes')
        engines = db.session.execute(sa.text(
            'SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'
        )).all()
        actual = {name: engine for name, engine in engines}
        if any(str(actual.get(name, '')).lower() != 'innodb' for name in names):
            fail('Purge indisponible : moteur non vérifié.', 503, 'PURGE_UNAVAILABLE')
    else:
        fail('Purge indisponible sur ce moteur.', 503, 'PURGE_UNAVAILABLE')
    inspector = sa.inspect(connection)
    columns = {column['name']: column for column in inspector.get_columns('reports')}
    if ('type' in columns or 'target_id' in columns or 'comment_id' not in columns or
            columns['comment_id']['nullable']):
        fail('Purge indisponible : reprise des signalements incomplète.', 503, 'PURGE_UNAVAILABLE')
    expected = [('reports', 'comment_id', 'comments'),
                ('comment_likes', 'comment_id', 'comments'), ('comment_likes', 'user_id', 'users'),
                ('comments', 'story_id', 'stories'), ('theories', 'story_id', 'stories'),
                ('votes', 'story_id', 'stories'), ('cold_case_updates', 'story_id', 'stories')]
    for table, column, parent in expected:
        if not any(fk['constrained_columns'] == [column] and fk['referred_table'] == parent and
                   fk['referred_columns'] == ['id'] and str(fk.get('options', {}).get('ondelete', '')).upper() == 'CASCADE'
                   for fk in inspector.get_foreign_keys(table)):
            fail('Purge indisponible : schéma relationnel non vérifié.', 503, 'PURGE_UNAVAILABLE')
    if db.session.execute(sa.select(Report.id).outerjoin(
            Comment, Report.comment_id == Comment.id).where(Comment.id.is_(None)).limit(1)).first():
        # Une ancienne écriture ayant désactivé les FK ne doit pas être ignorée
        # parce qu'elle ne rejoint plus aucun dossier : sa portée est inconnue.
        fail('Purge indisponible : référence historique incohérente.', 503, 'PURGE_UNAVAILABLE')
    if db.session.execute(sa.select(CommentLike.id).outerjoin(
            Comment, CommentLike.comment_id == Comment.id).outerjoin(
            User, CommentLike.user_id == User.id).where(
            sa.or_(Comment.id.is_(None), User.id.is_(None))).limit(1)).first():
        fail('Purge indisponible : référence de like incohérente.', 503, 'PURGE_UNAVAILABLE')


def snapshot(story_id, *, lock=True):
    if not 1 <= story_id <= MAX_RESOURCE_ID:
        fail('Dossier introuvable.', 404, 'STORY_NOT_FOUND')
    query = sa.select(Story.__table__).where(Story.id == story_id)
    if lock:
        query = query.with_for_update()
    story = db.session.execute(query).mappings().first()
    if story is None:
        fail('Dossier introuvable.', 404, 'STORY_NOT_FOUND')
    story = dict(story)
    revision = story['management_revision']
    if not isinstance(revision, str) or not re.fullmatch('[0-9a-f]{32}', revision) or revision == SENTINEL:
        fail('Révision du dossier incompatible.', 409)
    graph = {}
    total = 0
    for label, model in FAMILIES:
        query = sa.select(model.__table__)
        if model in (Report, CommentLike):
            query = query.join(Comment, model.comment_id == Comment.id).where(Comment.story_id == story_id)
        else:
            query = query.where(model.story_id == story_id)
        query = query.order_by(model.id).limit(MAX_DEPENDENCIES + 1)
        if lock:
            query = query.with_for_update()
        rows = [dict(row) for row in db.session.execute(query).mappings()]
        total += len(rows)
        if total > MAX_DEPENDENCIES:
            fail('Dossier trop volumineux pour cette opération.', 409, 'CASE_TOO_LARGE')
        graph[label] = rows
    # L'empreinte couvre aussi les textes/likes et les ids de reports. Ces
    # contenus restent en mémoire de requête, jamais dans un journal ou reçu.
    encoded = json.dumps({'story': story, 'graph': graph}, sort_keys=True,
                         separators=(',', ':'), default=lambda value: value.isoformat()).encode('utf-8')
    return story, graph, hashlib.sha256(encoded).hexdigest()


def ensure_archive(story):
    if story['archived_at'] is None:
        fail('Archiver le dossier avant sa suppression.', 409, 'STORY_NOT_ARCHIVED')


def check_state(data, story_id, story, digest):
    if (data.get('story_id') != story_id or data.get('revision') != story['management_revision'] or
            data.get('digest') != digest):
        fail('Confirmation périmée : relire le dossier.', 412, 'STALE_CONFIRMATION')


def strict_confirmation_json():
    def unique(pairs):
        data = {}
        for key, value in pairs:
            if key in data:
                raise ValueError('duplicate')
            data[key] = value
        return data
    raw = request.get_data(cache=True)
    if not request.is_json or len(raw) > 16384:
        fail('Corps de confirmation invalide.', 400, 'INVALID_REQUEST')
    try:
        data = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeDecodeError):
        fail('Corps de confirmation invalide.', 400, 'INVALID_REQUEST')
    if not isinstance(data, dict) or set(data) != {'preview_token', 'typed_title', 'confirm_contributions'}:
        fail('Champs de confirmation invalides.', 400, 'INVALID_REQUEST')
    if (not isinstance(data['typed_title'], str) or len(data['typed_title']) > 200 or
            data['confirm_contributions'] is not True):
        fail('Titre exact et accord explicite requis.', 400, 'INVALID_REQUEST')
    return data


def deletion_preview(story_id):
    user = lock_actor()
    require_integrity()
    story, graph, digest = snapshot(story_id)
    ensure_archive(story)
    claims = {'purpose': 'preview', 'story_id': story_id, 'revision': story['management_revision'],
              'digest': digest, 'user_id': user.id, 'session': session_binding(), 'expires': int(time.time()) + TTL}
    token = signer().dumps(claims)
    result = {'story': {'id': story_id, 'title': story['title'], 'management_revision': story['management_revision']},
              'impact': {key: len(graph[key]) for key, _ in PUBLIC_FAMILIES}, 'resource_etag': '"' + digest + '"',
              'preview_token': token, 'expires_at': datetime.utcfromtimestamp(claims['expires']).isoformat() + 'Z'}
    db.session.rollback()  # Fin de lecture : aucun verrou pendant la saisie humaine.
    return jsonify(result), 200


def confirm_deletion(story_id):
    body = strict_confirmation_json()
    claims = load_token(body['preview_token'], 'preview')
    lock_actor()
    require_integrity()
    story, graph, digest = snapshot(story_id)
    ensure_archive(story)
    check_state(claims, story_id, story, digest)
    if body['typed_title'] != story['title']:
        fail('Le titre complet doit correspondre exactement.', 400, 'INVALID_REQUEST')
    claims['purpose'] = 'delete'
    token = signer().dumps(claims)  # expires reste celui de l'aperçu initial.
    db.session.rollback()
    return jsonify(status='success', confirmation_token=token,
                   expires_at=datetime.utcfromtimestamp(claims['expires']).isoformat() + 'Z'), 200


def delete_story(story_id):
    if request.get_data(cache=True):
        fail('Aucun corps attendu pour DELETE.', 400, 'INVALID_REQUEST')
    etag = request.headers.get('If-Match')
    if etag is None:
        fail('If-Match requis.', 428, 'PRECONDITION_REQUIRED')
    if not re.fullmatch(r'"[0-9a-f]{64}"', etag):
        fail('Un validateur fort exact est requis.', 400, 'INVALID_REQUEST')
    claims = load_token(request.headers.get('X-Deletion-Confirmation'), 'delete')
    lock_actor()
    require_integrity()
    story, graph, digest = snapshot(story_id)
    ensure_archive(story)
    check_state(claims, story_id, story, digest)
    if etag != '"' + digest + '"':
        fail('État du dossier modifié.', 412, 'STALE_CONFIRMATION')
    reserved = uuid4().hex
    # Ce compare-and-swap complète les verrous MySQL. En SQLite un conflit de
    # snapshot/écriture doit échouer, jamais autoriser une confirmation ancienne.
    updated = db.session.execute(sa.update(Story.__table__).where(
        Story.id == story_id, Story.management_revision == story['management_revision'],
        Story.archived_at.is_not(None)).values(management_revision=reserved))
    if updated.rowcount != 1:
        fail('État du dossier modifié.', 412, 'STALE_CONFIRMATION')
    counts = {key: len(rows) for key, rows in graph.items()}
    # Les reports sont supprimés avant les commentaires : la sous-requête
    # identifie encore exactement leurs parents, sans confondre deux types d'id.
    for label, model in [('reports', Report), ('comment_likes', CommentLike), ('theories', Theory), ('votes', Vote),
                         ('updates', ColdCaseUpdate), ('comments', Comment)]:
        predicate = (model.comment_id.in_(sa.select(Comment.id).where(Comment.story_id == story_id))
                     if model in (Report, CommentLike) else model.story_id == story_id)
        result = db.session.execute(sa.delete(model.__table__).where(predicate))
        if result.rowcount != counts[label]:
            fail('Dépendances modifiées pendant la suppression.', 409)
    removed = db.session.execute(sa.delete(Story.__table__).where(
        Story.id == story_id, Story.management_revision == reserved, Story.archived_at.is_not(None)))
    if removed.rowcount != 1:
        fail('Dossier modifié pendant la suppression.', 409)
    for label, model in FAMILIES:
        ids = [row['id'] for row in graph[label]]
        for offset in range(0, len(ids), 500):
            if db.session.execute(sa.select(model.id).where(model.id.in_(ids[offset:offset + 500])).limit(1)).first():
                fail('Vérification finale des dépendances impossible.', 409)
    if claims['expires'] <= time.time():
        fail('Confirmation expirée.', 412, 'STALE_CONFIRMATION')
    payload = {'status': 'success', 'code': 'STORY_DELETED',
               'deleted_story': {'id': story_id, 'management_revision': story['management_revision']},
               'deleted_counts': {key: counts[key] for key, _ in PUBLIC_FAMILIES}}
    try:
        db.session.commit()
    except SQLAlchemyError:
        # COMMIT peut avoir abouti sans accusé : rollback local ne prouve pas
        # son annulation. Le client doit relire, sans réémettre le DELETE.
        db.session.rollback()
        return jsonify(status='error', code='DELETE_STATUS_UNKNOWN',
                       message='Issue de suppression à vérifier sur le serveur.'), 503
    db.session.expire_all()
    return jsonify(payload), 200


def run_deletion_action(action, story_id):
    try:
        return action(story_id)
    except PurgeError as error:
        db.session.rollback()
        return jsonify(status='error', code=error.code, message=error.message), error.status
    except SQLAlchemyError as error:
        db.session.rollback()
        original = getattr(error, 'orig', None)
        sqlite_code = getattr(original, 'sqlite_errorcode', None)
        arguments = getattr(original, 'args', ())
        locked = (isinstance(sqlite_code, int) and sqlite_code & 255 in (5, 6) or
                  bool(arguments) and arguments[0] in (1205, 1213))
        return jsonify(status='error', code='PURGE_UNAVAILABLE' if locked else 'PURGE_FAILED',
                       message='Opération indisponible ; aucune réussite confirmée.'), 503 if locked else 500
