"""Visibilité commune aux lectures publiques et aux contributions."""

from flask import abort
from sqlalchemy.exc import SQLAlchemyError

from models import db, Story
from api.v1.views.write_support import MAX_RESOURCE_ID


def get_active_story(identifier, *, lock=False):
    """Lire un dossier actif ; verrouiller son parent avant toute contribution."""
    if not 1 <= identifier <= MAX_RESOURCE_ID:
        return None
    try:
        query = Story.query.filter_by(id=identifier, archived_at=None)
        if lock:
            # Même verrou parent que l'archivage : sous InnoDB, une contribution
            # passe avant le retrait ou relit l'état archivé après son commit.
            # populate_existing évite de réutiliser un objet de session périmé.
            query = query.populate_existing().with_for_update()
        return query.first()
    except SQLAlchemyError:
        db.session.rollback()
        abort(500, description="Dossier indisponible.")
