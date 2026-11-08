"""Serve the existing frontend and Flask API on one local origin."""

import os
import sys
from pathlib import Path

from werkzeug.middleware.shared_data import SharedDataMiddleware


PROJECT_ROOT = Path(__file__).resolve().parent
FRONTEND_ROOT = PROJECT_ROOT / "frontend"
IMAGE_SUFFIXES = {".svg", ".webp", ".png", ".jpg", ".jpeg", ".gif", ".avif"}


# Ce middleware WSGI partage une origine pour les pages et l'API : les cookies
# accompagnent ainsi les requêtes sans second serveur frontend.
def create_local_app(api_app, frontend_root=FRONTEND_ROOT):
    """Serve public frontend files; leave every API request to Flask."""
    static_app = SharedDataMiddleware(
        api_app, {"/": str(frontend_root)}, cache=False
    )

    # cache=False désactive les réponses conditionnelles de Werkzeug, mais laisse
    # Cache-Control: public. Interdire explicitement le stockage évite qu'une
    # ancienne page masque les nouveaux contrôles de session ou de signalement.
    def serve_frontend(environ, start_response):
        def prevent_storage(status, headers, exc_info=None):
            headers = [(name, value) for name, value in headers
                       if name.lower() != "cache-control"]
            headers.append(("Cache-Control", "no-store"))
            return start_response(status, headers, exc_info)

        return static_app(environ, prevent_storage)

    # La liste autorisée ne publie que les ressources prévues de frontend/.
    # Les chemins API et les écritures restent traités par Flask ; les fichiers
    # privés situés ailleurs dans le dépôt ne deviennent pas téléchargeables.
    def application(environ, start_response):
        path = environ.get("PATH_INFO", "")
        if (
            environ.get("REQUEST_METHOD") not in {"GET", "HEAD"}
            or path == "/api"
            or path.startswith("/api/")
        ):
            return api_app(environ, start_response)

        if path == "/":
            return serve_frontend(
                dict(environ, PATH_INFO="/index.html"), start_response
            )

        suffix = Path(path).suffix.lower()
        root_file = (
            path.startswith("/")
            and path.count("/") == 1
            and suffix in {".html", ".css", ".js"}
        )
        image_file = path.startswith("/images/") and suffix in IMAGE_SUFFIXES
        if root_file or image_file:
            return serve_frontend(environ, start_response)
        return api_app(environ, start_response)

    return application


# Ce point d'entrée charge la configuration locale puis écoute seulement sur
# 127.0.0.1, sans debug ni reloader ; il ne crée ni tables ni données.
def main():
    # Charger une éventuelle configuration locale depuis la racine du projet.
    from dotenv import load_dotenv

    os.chdir(PROJECT_ROOT)
    load_dotenv(PROJECT_ROOT / ".env", encoding="utf-8-sig", override=False)
    sys.path.insert(0, str(PROJECT_ROOT / "backend"))
    from index import app

    app.wsgi_app = create_local_app(app.wsgi_app)
    app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
