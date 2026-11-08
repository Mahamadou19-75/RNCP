from flask import Blueprint

# Le Blueprint partage le préfixe /api/v1 entre les modules de routes.
# Les imports en bas enregistrent leurs décorateurs sur ce même objet.
app_views = Blueprint(
    'app_views',
    __name__,
    url_prefix='/api/v1'
)

from api.v1.views.index import *
from api.v1.views.users import *
from api.v1.views.histoires import *
from api.v1.views.theories import *
from api.v1.views.comments import *
from api.v1.views.proposals import *
from api.v1.views.admin_stories import *
from api.v1.views.likes import *
