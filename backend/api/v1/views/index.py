import os
from flask import jsonify, request, render_template_string
from api.v1.views import app_views
from api.v1.views.permissions import admin_required, get_authenticated_user
from models import db, Report, User, Comment, Story
from sqlalchemy.orm import joinedload
from sqlalchemy.exc import SQLAlchemyError
from api.v1.views.write_support import api_error
from api.v1.views.admin_users_support import ban_user_account
from api.v1.views.story_visibility import get_active_story


@app_views.route('/reports', methods=['POST'])
# reports.target_id ne possède pas de clé étrangère : cette validation API
# doit vérifier un identifiant positif et un commentaire réellement présent.
# Cette route générique n'accepte actuellement que le type comment.
def post_report():
    user, error_response = get_authenticated_user()

    if error_response:
        return error_response

    req_data = request.get_json(silent=True)

    if not isinstance(req_data, dict):
        return jsonify({
            "status": "error",
            "message": "Corps JSON invalide."
        }), 400

    values = {}
    for field in ("type", "target_id", "reason"):
        value = req_data.get(field)
        if not isinstance(value, str) or not value.strip():
            return jsonify({
                "status": "error",
                "message": "type, target_id et reason doivent etre des chaines non vides."
            }), 400
        values[field] = value.strip()

    target_models = {"comment": Comment}
    target_model = target_models.get(values["type"])
    if target_model is None:
        return jsonify({
            "status": "error",
            "message": "Type de signalement non pris en charge."
        }), 400

    target_id = values["target_id"]
    target_digits = target_id.lstrip("0")
    if (
        not target_id.isascii()
        or not target_id.isdecimal()
        or not target_digits
        or len(target_digits) > 10
    ):
        return jsonify({
            "status": "error",
            "message": "target_id doit etre un entier positif valide."
        }), 400

    target_value = int(target_digits)
    if target_value > 2147483647:
        return jsonify({
            "status": "error",
            "message": "target_id doit etre un entier positif valide."
        }), 400

    target = db.session.get(target_model, target_value)
    if target is None or not get_active_story(target.story_id, lock=True):
        return jsonify({
            "status": "error",
            "message": "Cible du signalement introuvable."
        }), 404

    report = Report(
        comment_id=target_value,
        reason=values["reason"]
    )

    # add prépare l'objet ; commit déclenche le flush puis valide la transaction.
    # En cas d'erreur SQL, rollback annule les écritures non validées et rétablit
    # une session utilisable avant de renvoyer la réponse d’échec.
    try:
        db.session.add(report)
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        return jsonify({
            "status": "error",
            "message": "Impossible d'enregistrer le signalement."
        }), 500

    return jsonify({
        "status": "success",
        "report": report.to_dict()
    }), 201


@app_views.after_request
def protect_admin_reports_cache(response):
    if request.path == '/api/v1/admin/reports':
        response.headers['Cache-Control'] = 'private, no-store'
    return response


@app_views.route('/admin/reports', methods=['GET'])
@admin_required
# La lecture des motifs de signalement exige le rôle administrateur côté serveur.
def get_admin_reports():
    try:
        # Charger le contexte en une lecture sans perdre un signalement si une
        # ancienne référence est incohérente. Aucune reprise de données ici.
        reports = Report.query.options(
            joinedload(Report.comment).joinedload(Comment.story).joinedload(Story.category)
        ).order_by(Report.created_at.desc(), Report.id.desc()).all()
        result = []
        for report in reports:
            data = report.to_dict()
            comment = report.comment
            story = comment.story if comment else None
            data['comment'] = ({'id': comment.id, 'story_id': comment.story_id,
                                'text': comment.text} if comment else None)
            data['story'] = ({'id': story.id, 'slug': story.slug, 'title': story.title,
                              'category_id': story.category_id,
                              'category_name': story.category.name if story.category else None,
                              'is_archived': story.archived_at is not None} if story else None)
            result.append(data)
        return jsonify(result), 200
    except SQLAlchemyError:
        db.session.rollback()
        return api_error('Impossible de lire les signalements.', 500)


@app_views.route('/admin/users/<string:username>/ban', methods=['DELETE'])
@admin_required
# Malgré la méthode HTTP DELETE, ce code conserve le compte : il positionne
# is_banned à True. Ce n’est ni un effacement RGPD ni une suppression de ligne.
def ban_user(username):
    return ban_user_account(username=username)


@app_views.route('/admin/users/<int:user_id>/ban', methods=['POST'])
@admin_required
# L'identifiant stable évite d'utiliser le pseudo comme segment d'URL. La règle
# des comptes protégés reste commune avec l'ancienne route par pseudo.
def ban_user_by_id(user_id):
    return ban_user_account(user_id=user_id)

@app_views.route('/swagger.json', methods=['GET'])
# Le contrat OpenAPI est lu dans le système de fichiers puis renvoyé en JSON ;
# sa cohérence peut être testée sans exécuter les opérations décrites.
def get_swagger_json():
    current_dir = os.path.dirname(os.path.abspath(__file__))
    swagger_path = os.path.join(current_dir, '../swagger.json')
    try:
        with open(swagger_path, 'r', encoding='utf-8') as f:
            import json
            return jsonify(json.load(f)), 200
    except FileNotFoundError:
        return jsonify({"error": "Swagger file not found"}), 404

@app_views.route('/swagger', methods=['GET'])
# Le nom est historique : cette vue affiche Swagger UI et ne fait pas d'OAuth.
# Les scripts viennent normalement du CDN ; aucun requestInterceptor n'ajoute
# ici le CSRF aux POST Try it out. Afficher Swagger ne prouve pas ces écritures.
def oauth_swagger():
    swagger_ui_html = """
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Swagger UI - Les Petits Enquêteurs</title>
        <link rel="stylesheet" type="text/css" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.min.css">
        <style>html { box-sizing: border-box; overflow-y: scroll; } *, *:before, *:after { box-sizing: inherit; } body { margin:0; background: #fafafa; }</style>
    </head>
    <body>
        <div id="swagger-ui"></div>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-bundle.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-standalone-preset.min.js"></script>
        <script>
        window.onload = function() {
            window.ui = SwaggerUIBundle({
                url: "/api/v1/swagger.json",
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [SwaggerUIBundle.presets.apis],
                plugins: [SwaggerUIBundle.plugins.DownloadUrl],
                layout: "BaseLayout"
            });
        };
        </script>
    </body>
    </html>
    """
    return render_template_string(swagger_ui_html)
