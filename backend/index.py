import os
import secrets

from dotenv import load_dotenv
from flask import Flask, jsonify, request, session
from flask_cors import CORS
from sqlalchemy import event
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from werkzeug.exceptions import HTTPException

from api.v1.views import app_views
from api.v1.views.permissions import get_authenticated_user
from models import db, User, Comment, Report


# Le lancement normal lit la configuration locale ; les harnais hors ligne
# des campagnes neutralisent cet appel avant tout import de cette application.
load_dotenv()

app = Flask(__name__)

app.config["SECRET_KEY"] = os.getenv("SECRET_KEY")

if not app.config["SECRET_KEY"]:
    raise RuntimeError(
        "SECRET_KEY is missing. Add it to the .env file."
    )


# Une variable d'environnement est une chaîne : interpréter explicitement
# ses valeurs évite de considérer la chaîne "false" comme vraie.
def env_to_bool(name, default=False):
    """Read a boolean value from an environment variable."""
    value = os.getenv(name)

    if value is None:
        return default

    return value.strip().lower() in {
        "1",
        "true",
        "yes",
        "on"
    }


# CORS autorise les échanges navigateur pour les origines configurées.
# Il ne remplace ni l'authentification, ni les permissions, ni le CSRF.
# CORS configuration
cors_origins_env = os.getenv("CORS_ALLOWED_ORIGINS")

if not cors_origins_env:
    raise RuntimeError(
        "CORS_ALLOWED_ORIGINS is missing. "
        "Add it to the .env file."
    )

cors_origins = [
    origin.strip()
    for origin in cors_origins_env.split(",")
    if origin.strip()
]

CORS(
    app,
    resources={
        r"/api/v1/*": {
            "origins": cors_origins
        }
    },
    supports_credentials=True
)


# Database configuration
BASE_DIR = os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)

SQLITE_PATH = os.path.join(
    BASE_DIR,
    "instance",
    "site.db"
)

database_uri = os.getenv("DATABASE_URL", f"sqlite:///{SQLITE_PATH.replace(os.sep, '/')}")
if make_url(database_uri).drivername not in {"sqlite", "sqlite+pysqlite"}:
    raise RuntimeError("La version RNCP accepte uniquement une base SQLite.")
app.config["SQLALCHEMY_DATABASE_URI"] = database_uri


app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False


# Le cookie Flask contient une session signée, pas chiffrée. HttpOnly empêche
# sa lecture directe par JavaScript ; SameSite limite certains envois intersites.
# Secure réserve son envoi à HTTPS quand l'option est activée.
# Session cookie configuration
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = env_to_bool(
    "SESSION_COOKIE_SECURE",
    default=False
)


# Initialize database
db.init_app(app)

def enable_sqlite_foreign_keys(connection, _record):
    cursor = connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()


with app.app_context():
    event.listen(db.engine, "connect", enable_sqlite_foreign_keys)


# Le jeton aléatoire est lié à la session. Le frontend le reçoit par login/me
# et le garde en mémoire pour ses en-têtes ; ne jamais le journaliser.
def get_csrf_token():
    """Return the current CSRF token, creating one if necessary."""
    csrf_token = session.get("csrf_token")

    if not csrf_token:
        csrf_token = secrets.token_urlsafe(32)
        session["csrf_token"] = csrf_token

    return csrf_token


@app.before_request
# Avant la vue, contrôler les écritures qui portent déjà un user_id de session.
# GET/HEAD/OPTIONS passent ; login est exempté ; une requête anonyme passe aussi
# ce filtre, mais doit encore satisfaire les permissions propres à la route.
def protect_session_requests_from_csrf():
    """Require a CSRF token for state-changing authenticated requests."""
    protected_methods = {
        "POST",
        "PUT",
        "PATCH",
        "DELETE"
    }

    if request.method not in protected_methods:
        return None

    # Login does not rely on an existing authenticated session.
    if request.path == "/api/v1/login":
        return None

    # Anonymous requests do not use an authenticated Flask session.
    if session.get("user_id") is None:
        return None

    # Deux chaînes ASCII non vides sont exigées avant la comparaison à durée
    # aussi constante que possible ; un jeton absent ou différent donne 403.
    expected_token = session.get("csrf_token")
    received_token = request.headers.get("X-CSRF-Token")

    if (
        not isinstance(expected_token, str)
        or not isinstance(received_token, str)
        or not expected_token.strip()
        or not received_token.strip()
        or not expected_token.isascii()
        or not received_token.isascii()
        or not secrets.compare_digest(
            expected_token,
            received_token
        )
    ):
        return jsonify({
            "status": "error",
            "message": "Token CSRF invalide ou manquant."
        }), 403

    return None


@app.errorhandler(404)
def not_found(error):
    return jsonify({
        "status": "error",
        "message": "Not found"
    }), 404


@app.errorhandler(HTTPException)
# Garder le statut et les en-têtes HTTP du framework, tout en donnant au
# frontend un corps JSON cohérent pour les erreurs des chemins API.
def handle_api_http_error(error):
    """Normalize framework API errors while preserving their HTTP headers."""
    if request.path != "/api/v1" and not request.path.startswith("/api/v1/"):
        return error

    response = error.get_response()
    response.set_data(app.json.dumps({
        "status": "error",
        "message": error.name
    }))
    response.content_type = "application/json"
    return response


# Application statistics
@app.route("/api/v1/stats", methods=["GET"])
# Cette lecture est publique : elle ne renvoie que trois nombres agrégés.
# L'accès aux propositions, signalements et comptes reste protégé ailleurs.
def get_stats():
    try:
        user_count = User.query.count()
        comment_count = Comment.query.count()
        reported_count = Report.query.count()

        return jsonify({
            "users": user_count,
            "comments": comment_count,
            "reports": reported_count
        }), 200

    except SQLAlchemyError:
        db.session.rollback()
        return jsonify({
            "status": "error",
            "message": "Statistics unavailable"
        }), 500


# User login
@app.route("/api/v1/login", methods=["POST"])
# Vérifier le mot de passe haché et le bannissement avant de préparer la session.
# Le rôle renvoyé aide l'affichage ; les routes admin relisent le rôle en base.
def login_user():
    req_data = request.get_json(silent=True)
    if not isinstance(req_data, dict):
        req_data = {}

    username = req_data.get("username")
    password = req_data.get("password")

    if (
        not isinstance(username, str)
        or not isinstance(password, str)
        or not username.strip()
        or not password
    ):
        return jsonify({
            "status": "error",
            "message": "Identifiant et mot de passe obligatoires."
        }), 400

    username = username.strip()
    try:
        username.encode("utf-8")
        password.encode("utf-8")
    except UnicodeEncodeError:
        return jsonify({
            "status": "error",
            "message": "Identifiant et mot de passe obligatoires."
        }), 400

    user = User.query.filter_by(
        username=username
    ).first()

    if not user or not user.check_password(password):
        return jsonify({
            "status": "error",
            "message": "Identifiants incorrects."
        }), 401

    if user.is_banned:
        return jsonify({
            "status": "error",
            "message": "Compte suspendu."
        }), 403

    # Écarter l'ancien état de session et son CSRF avant de retenir le nouveau
    # compte. Le mot de passe ne doit jamais entrer dans le cookie.
    session.clear()

    session["user_id"] = user.id
    session["is_admin"] = bool(user.is_admin)

    csrf_token = get_csrf_token()

    user_data = {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "is_admin": bool(user.is_admin)
    }

    return jsonify({
        "status": "success",
        "message": "Connexion réussie !",
        "user": user_data,
        "csrf_token": csrf_token
    }), 200


# Return the currently authenticated user
@app.route("/api/v1/me", methods=["GET"])
# Relire le compte détecte aussi une suppression ou un bannissement depuis
# la connexion ; le navigateur obtient alors son état actuel et un CSRF valide.
def get_current_user():
    user, error_response = get_authenticated_user()

    if error_response:
        return error_response

    csrf_token = get_csrf_token()

    return jsonify({
        "status": "success",
        "user": {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "is_admin": bool(user.is_admin)
        },
        "csrf_token": csrf_token
    }), 200


# User logout
@app.route("/api/v1/logout", methods=["POST"])
# Vider la session fait émettre un cookie de suppression au navigateur.
# Il n'y a pas ici de registre serveur révoquant toutes les copies d'un cookie.
def logout_user():
    session.clear()

    return jsonify({
        "status": "success",
        "message": "Déconnexion réussie."
    }), 200


# Register all API blueprint routes
app.register_blueprint(app_views)


# Entrée historique de développement (debug et écoute large ci-dessous).
# Pour la démonstration locale, utiliser run_local.py qui borne son écoute.
if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True
    )
