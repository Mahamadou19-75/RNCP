"""SQLite jetables seulement ; accès générés en mémoire, jamais en sortie."""
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from unittest.mock import patch
import hashlib
import importlib.util
import json
import os
import secrets
import shutil
import socket
import sqlite3
import string
import subprocess
import sys
import tempfile
import unittest
import warnings

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))
from tools import demo_persistante as demo


def password():
    groups = [string.ascii_uppercase, string.ascii_lowercase, string.digits, string.punctuation]
    characters = [secrets.choice(group) for group in groups]
    characters.extend(secrets.choice(''.join(groups)) for _ in range(20))
    secrets.SystemRandom().shuffle(characters)
    return ''.join(characters)


def people():
    return [demo.Person(name, name.lower() + '@example.invalid', (' ' + password() + ' ') if name == 'Alice' else password()) for name in demo.NAMES]


def digest(path):
    return hashlib.sha256(path.read_bytes()).digest()


def initialized(paths, persons):
    with demo.operation_lock(paths, create=True):
        demo.initialize(paths, persons)


def client(app):
    from werkzeug.test import Client
    from werkzeug.wrappers import Response
    from run_local import create_local_app
    return Client(create_local_app(app), Response)


def request(http, method, path, expected=200, body=None, token=None):
    response = http.open('/api/v1' + path, method=method, json=body,
                         headers={'X-CSRF-Token': token} if token else {})
    if response.status_code != expected:
        raise AssertionError('Statut HTTP inattendu, corps et accès masqués.')
    return response.get_json()


def login(http, person):
    return request(http, 'POST', '/login', body={'username': person.username, 'password': person.password})


def worker(phase, root, persons):
    paths = demo.Paths(Path(root))
    if phase == 'create':
        initialized(paths, persons)
    with demo.operation_lock(paths), demo.application(paths) as (app, db, models):
        clients = [client(app) for _ in persons]
        sessions = [login(http, person) for http, person in zip(clients, persons)]
        for index, (http, session) in enumerate(zip(clients, sessions), 1):
            current = request(http, 'GET', '/me')['user']
            if current['id'] != index or current['is_admin'] != (index == 1):
                raise AssertionError('Rôle ou session incorrect.')
            if http.get_cookie(demo.COOKIE) is None:
                raise AssertionError('Nom du cookie incorrect.')
        admin, alice, bob = clients
        admin_csrf, alice_csrf, bob_csrf = [session['csrf_token'] for session in sessions]
        request(alice, 'GET', '/users', 403)
        request(bob, 'GET', '/admin/reports', 403)
        request(alice, 'POST', '/proposals', 403, {'title': 'Contrôle', 'content': 'Contrôle CSRF.'})
        request(alice, 'POST', '/proposals', 403, {'title': 'Contrôle', 'content': 'Contrôle CSRF.'}, secrets.token_urlsafe())
        request(client(app), 'POST', '/login', 401, {'username': 'Alice', 'password': password()})
        if phase == 'create':
            comment = request(alice, 'POST', '/stories/101/comments', 201,
                              {'text': 'Commentaire de persistance isolé.'}, alice_csrf)['comment']
            request(alice, 'POST', '/votes/101', 201, token=alice_csrf)
            request(alice, 'POST', '/comments/' + str(comment['id']) + '/like', token=alice_csrf)
            request(alice, 'POST', '/stories/201/theories', 201,
                    {'title': 'Piste de contrôle', 'content': 'Théorie de persistance isolée.'}, alice_csrf)
            request(bob, 'POST', '/comments/' + str(comment['id']) + '/report', 201,
                    {'reason': 'Signalement de contrôle isolé.'}, bob_csrf)
            request(alice, 'POST', '/proposals', 201,
                    {'title': 'Proposition de contrôle', 'content': 'Contribution de contrôle isolée.'}, alice_csrf)
            with app.app_context():
                db.session.add(models.ColdCaseUpdate(story_id=201, content='Mise à jour de contrôle isolée.'))
                db.session.commit()
        comments = request(alice, 'GET', '/stories/101/comments')
        if len(comments) != 1:
            raise AssertionError('Commentaire non conservé.')
        comment_id = comments[0]['id']
        for kind_path in ['/votes/101', '/comments/' + str(comment_id) + '/like']:
            if request(alice, 'GET', kind_path)['liked_by_me'] is not True or request(bob, 'GET', kind_path)['liked_by_me'] is not False:
                raise AssertionError('État personnel incorrect.')
        if len(request(bob, 'GET', '/stories/201/theories')) != 1:
            raise AssertionError('Théorie non conservée.')
        stats = request(admin, 'GET', '/stats')
        proposals = request(admin, 'GET', '/proposals')
        reports = request(admin, 'GET', '/admin/reports')
        stories = request(admin, 'GET', '/stories')
        indicators = [len(stories), sum(s['category_id'] == 1 for s in stories), sum(s['category_id'] == 2 for s in stories),
                      stats['users'], stats['comments'], stats['reports'], sum(p['status'] == 'pending' for p in proposals)]
        if indicators != [6, 3, 3, 3, 1, 1, 1] or len(reports) != 1:
            raise AssertionError('Indicateurs non conservés.')
        for original in demo.catalogue():
            story = request(bob, 'GET', '/stories/slug/' + original['slug'])
            if any(story[key] != original[key] for key in demo.FIELDS):
                raise AssertionError('Texte original différent.')
        html = admin.get('/admin-dashboard.html')
        if html.status_code != 200 or html.data.count(b'-count"') < 7:
            raise AssertionError('Dashboard indisponible.')
    return {'phase': phase, 'result': 'PASS', 'indicators': indicators}


class PersistentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='lpe-test persistance-')
        self.addCleanup(self.temporary.cleanup)
        self.paths = demo.Paths(Path(self.temporary.name))
        self.persons = people()

    def init(self):
        initialized(self.paths, self.persons)

    def test_help_and_import_do_not_create_data_or_import_flask_application(self):
        code = "import sys,runpy; sys.argv=['demo','--help']; runpy.run_path(" + repr(str(ROOT/'tools/demo_persistante.py')) + ",run_name='__main__')"
        result = subprocess.run([sys.executable, '-I', '-B', '-c', code], capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertFalse(self.paths.data.exists())
        with patch.object(sqlite3, 'connect', side_effect=AssertionError('Import SQL interdit')):
            spec = importlib.util.spec_from_file_location('_import_only', ROOT/'tools/demo_persistante.py')
            module = importlib.util.module_from_spec(spec);sys.modules[spec.name] = module
            try:
                spec.loader.exec_module(module)
            finally:
                sys.modules.pop(spec.name, None)

    def test_initial_data_roles_hashes_and_originals(self):
        self.init()
        result = demo.check(self.paths)
        self.assertEqual(result['tables'], {'users': 3, 'categories': 2, 'stories': 6, 'theories': 0, 'comments': 0,
                                          'votes': 0, 'comment_likes': 0, 'proposals': 0, 'reports': 0, 'cold_case_updates': 0})
        self.assertEqual(result['originals_changed'], 0)
        with demo.application(self.paths) as (app, db, models), app.app_context():
            for index, person in enumerate(self.persons, 1):
                stored = db.session.get(models.User, index)
                self.assertTrue(stored.check_password(person.password), 'Vérification du hachage échouée.')
                self.assertNotIn('password_hash', stored.to_dict())
                self.assertTrue(stored.password_hash != person.password, 'Stockage en clair interdit.')
                self.assertEqual(stored.is_admin, index == 1)
        demo.private_directory(self.paths, self.paths.data)

    def test_second_initialization_cannot_change_existing_bytes(self):
        self.init();before = digest(self.paths.database), digest(self.paths.key)
        with self.assertRaises(demo.LocalError):
            demo.initialize(self.paths, people())
        self.assertEqual((digest(self.paths.database), digest(self.paths.key)), before)

    def test_missing_data_and_foreign_format_are_not_created_or_migrated(self):
        with self.assertRaises(demo.LocalError):
            demo.check(self.paths)
        self.assertFalse(self.paths.instance.exists())
        self.init()
        with demo.opened(self.paths.database, readonly=False) as connection:
            connection.execute('PRAGMA user_version=99')
        before = digest(self.paths.database)
        with self.assertRaises(demo.LocalError):
            demo.check(self.paths)
        self.assertEqual(digest(self.paths.database), before)

    def test_changed_schema_is_refused_without_repair(self):
        self.init()
        with demo.opened(self.paths.database, readonly=False) as connection:
            connection.execute('ALTER TABLE users ADD COLUMN unexpected TEXT')
        before = digest(self.paths.database)
        with self.assertRaises(demo.LocalError):
            demo.check(self.paths)
        self.assertEqual(digest(self.paths.database), before)

    def test_hostile_environment_and_other_database_or_network_are_blocked(self):
        self.init()
        dirty = {'DATABASE_URL': 'sqlite:///forbidden.sqlite3',
                 'SECRET_KEY': secrets.token_urlsafe(), 'RNCP_UNRELATED_SETTING': 'ignored'}
        with patch.dict(os.environ, dirty), demo.application(self.paths) as (app, db, models), app.app_context():
            self.assertNotIn('RNCP_UNRELATED_SETTING', os.environ)
            self.assertEqual(app.config['SESSION_COOKIE_NAME'], demo.COOKIE)
            self.assertTrue(app.config['SESSION_COOKIE_HTTPONLY'])
            self.assertEqual(app.config['SESSION_COOKIE_SAMESITE'], 'Lax')
            with db.engine.connect() as first, db.engine.connect() as second:
                self.assertEqual(first.exec_driver_sql('PRAGMA foreign_keys').scalar_one(), 1)
                self.assertEqual(second.exec_driver_sql('PRAGMA foreign_keys').scalar_one(), 1)
                with self.assertRaises(Exception):
                    first.exec_driver_sql('ATTACH DATABASE ? AS other', (str(self.paths.root/'forbidden.sqlite3'),))
            for action in [lambda: sqlite3.connect(':memory:'), lambda: socket.create_connection(('127.0.0.1', 5064)),
                           lambda: __import__('sqlalchemy').create_engine('sqlite:///:memory:').connect()]:
                with self.assertRaises(demo.LocalError):
                    action()
        self.assertFalse((self.paths.root/'forbidden.sqlite3').exists())

    def test_registration_cannot_grant_administrator(self):
        self.init()
        with demo.application(self.paths) as (app, db, models):
            response = request(client(app), 'POST', '/users', 201,
                               {'username': 'autre-test', 'email': 'autre-test@example.invalid', 'password': password(), 'is_admin': True})
            self.assertIs(response['user']['is_admin'], False)
        self.assertEqual(demo.check(self.paths)['tables']['users'], 4)

    def test_persistence_in_two_distinct_processes_and_no_reseeding(self):
        payload = json.dumps([{'username': p.username, 'email': p.email, 'password': p.password} for p in self.persons])
        for phase in ['create', 'reopen']:
            if phase == 'reopen':
                before = digest(self.paths.database), digest(self.paths.key)
            result = subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--worker', phase, str(self.paths.root)],
                                    input=payload, text=True, encoding='utf-8', capture_output=True, timeout=90)
            self.assertTrue(result.returncode == 0, 'Échec du parcours interprocessus ; sorties privées non reproduites.')
            self.assertEqual(json.loads(result.stdout)['result'], 'PASS')
        self.assertEqual((digest(self.paths.database), digest(self.paths.key)), before)
        result = demo.check(self.paths)
        self.assertEqual(result['tables']['users'], 3)
        self.assertTrue(all(result['tables'][name] == 1 for name in ['comments', 'theories', 'votes', 'comment_likes', 'reports', 'proposals', 'cold_case_updates']))
        with demo.operation_lock(self.paths):
            snapshot = demo.backup(self.paths)
        with tempfile.TemporaryDirectory(prefix='lpe-restauration-complete-') as folder:
            target = demo.Paths(Path(folder))
            target.backups.parent.mkdir();demo.private_directory(target, target.backups, create=True)
            demo.private_directory(target, target.backups/snapshot, create=True)
            for name in ['portfolio.sqlite3', 'manifest.json']:
                shutil.copyfile(self.paths.backups/snapshot/name, target.backups/snapshot/name)
            with demo.operation_lock(target, create=True):
                demo.restore(target, snapshot, renew_key=True)
            restored = subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--worker', 'reopen', str(target.root)],
                                      input=payload, text=True, encoding='utf-8', capture_output=True, timeout=90)
            self.assertTrue(restored.returncode == 0, 'Contributions restaurées non conformes ; détails privés masqués.')

    def test_archived_and_deleted_stories_are_never_reseeded(self):
        self.init()
        with demo.application(self.paths) as (app, db, models), app.app_context():
            db.session.get(models.Story, 101).archived_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.session.delete(db.session.get(models.Story, 102));db.session.commit()
        before = digest(self.paths.database)
        with demo.application(self.paths) as (app, _, _):
            self.assertEqual(len(request(client(app), 'GET', '/stories')), 4)
        self.assertEqual(digest(self.paths.database), before)
        result = demo.check(self.paths)
        self.assertEqual(result['originals_archived'], 1)
        self.assertEqual(result['originals_missing'], 1)

    def test_backup_restore_and_session_key_rotation(self):
        self.init()
        with demo.operation_lock(self.paths):
            snapshot = demo.backup(self.paths)
        original_backup = digest(self.paths.backups/snapshot/'portfolio.sqlite3')
        with demo.application(self.paths) as (app, _, _):
            http = client(app);session = login(http, self.persons[1]);old_cookie = http.get_cookie(demo.COOKIE).value
            request(http, 'POST', '/stories/101/comments', 201, {'text': 'Contribution après sauvegarde.'}, session['csrf_token'])
        self.assertEqual(demo.check(self.paths)['tables']['comments'], 1)
        before = digest(self.paths.database)
        with self.assertRaises(demo.LocalError):
            demo.restore(self.paths, snapshot)
        self.assertEqual(digest(self.paths.database), before)
        old_key = digest(self.paths.key)
        with demo.operation_lock(self.paths):
            outcome = demo.restore(self.paths, snapshot, replace=True, renew_key=True)
        self.assertIsNotNone(outcome['safety_backup'])
        self.assertNotEqual(digest(self.paths.key), old_key)
        self.assertEqual(demo.check(self.paths)['tables']['comments'], 0)
        with demo.opened(self.paths.backups/outcome['safety_backup']/'portfolio.sqlite3') as connection:
            self.assertEqual(demo.inspect_database(connection)['tables']['comments'], 1)
        self.assertEqual(digest(self.paths.backups/snapshot/'portfolio.sqlite3'), original_backup)
        with demo.application(self.paths) as (app, _, _):
            stale = client(app);stale.set_cookie(demo.COOKIE, old_cookie)
            request(stale, 'GET', '/me', 401)
            for person in self.persons:
                login(client(app), person)

    def test_restore_into_new_destination_preserves_source(self):
        self.init()
        snapshot = demo.backup(self.paths);before = digest(self.paths.database)
        with tempfile.TemporaryDirectory(prefix='lpe-restore-test-') as folder:
            target = demo.Paths(Path(folder))
            target.backups.parent.mkdir();demo.private_directory(target, target.backups, create=True)
            demo.private_directory(target, target.backups/snapshot, create=True)
            for name in ['portfolio.sqlite3', 'manifest.json']:
                shutil.copyfile(self.paths.backups/snapshot/name, target.backups/snapshot/name)
            with demo.operation_lock(target, create=True):
                demo.restore(target, snapshot, renew_key=True)
            self.assertEqual(demo.check(target)['tables']['users'], 3)
            with demo.application(target) as (app, _, _):
                for person in self.persons:
                    login(client(app), person)
        self.assertEqual(digest(self.paths.database), before)

    def test_bad_snapshot_and_checksum_do_not_touch_live_test_data(self):
        self.init();snapshot = demo.backup(self.paths);before = digest(self.paths.database)
        for invalid in ['..', '../other', str(self.paths.database)]:
            with self.assertRaises(demo.LocalError):
                demo.restore(self.paths, invalid, replace=True)
        manifest = self.paths.backups/snapshot/'manifest.json'
        data = json.loads(manifest.read_text());data['sha256'] = '0'*64;manifest.write_text(json.dumps(data))
        with self.assertRaises(demo.LocalError):
            demo.restore(self.paths, snapshot, replace=True)
        self.assertEqual(digest(self.paths.database), before)

    def test_lock_prevents_another_process_and_cli_backup(self):
        self.init()
        with demo.operation_lock(self.paths):
            result = subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--lock-probe', str(self.paths.root)], capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 3)
            with patch.object(demo, 'Paths', return_value=self.paths), redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                self.assertEqual(demo.main(['backup']), 1)

    def test_private_input_has_no_echo_fallback_or_embedded_values(self):
        with patch.object(sys.stdin, 'isatty', return_value=False), patch('builtins.input') as read:
            with self.assertRaises(demo.LocalError):
                demo.collect_people()
            read.assert_not_called()
        values = [value for person in self.persons for value in [person.password, person.password]]
        with patch.object(sys.stdin, 'isatty', return_value=True), patch.object(sys.stdout, 'isatty', return_value=True), \
             patch('builtins.input', side_effect=[p.email for p in self.persons]), patch.object(demo.getpass, 'getpass', side_effect=values):
            collected = demo.collect_people()
        self.assertTrue(all(p.password == q.password for p, q in zip(collected, self.persons)), 'Saisies non conservées exactement.')
        def warning(*args):
            warnings.warn('Saisie confidentielle indisponible.', demo.getpass.GetPassWarning)
            raise AssertionError('La lecture de repli ne doit pas être atteinte.')
        with patch.object(sys.stdin, 'isatty', return_value=True), patch.object(sys.stdout, 'isatty', return_value=True), \
             patch('builtins.input', return_value=self.persons[0].email), patch.object(demo.getpass, 'getpass', side_effect=warning):
            with self.assertRaises(demo.getpass.GetPassWarning):
                demo.collect_people()
        self.assertTrue(all(p.password not in repr(p) for p in self.persons), 'Représentation privée non masquée.')

    def test_failed_initialization_does_not_publish_partial_data(self):
        models, _ = demo._backend()
        with demo.operation_lock(self.paths, create=True), patch.object(models.db, 'create_all', side_effect=RuntimeError('Échec de contrôle')):
            with self.assertRaises(RuntimeError):
                demo.initialize(self.paths, self.persons)
        self.assertFalse(self.paths.data.exists())
        self.assertFalse(list(self.paths.instance.glob('.demo-work-*')))

    def test_canonical_paths_are_confined(self):
        with self.assertRaises(demo.LocalError):
            self.paths.checked(self.paths.root.parent/'outside.sqlite3')

    def test_hardlinked_database_is_refused(self):
        self.init()
        linked = self.paths.root/'alias.sqlite3'
        os.link(self.paths.database, linked)
        with self.assertRaises(demo.LocalError):
            demo.check(self.paths)

    def test_existing_sqlite_annex_prevents_replacement(self):
        self.init();snapshot = demo.backup(self.paths);before = digest(self.paths.database)
        annex = Path(str(self.paths.database) + '-wal')
        annex.write_bytes(b'controle')
        with self.assertRaises(demo.LocalError):
            demo.restore(self.paths, snapshot, replace=True)
        self.assertEqual(digest(self.paths.database), before)
        self.assertEqual(annex.read_bytes(), b'controle')

    def test_tracked_private_file_causes_git_preflight_refusal(self):
        def result(command, **kwargs):
            output = kwargs['input'] if 'check-ignore' in command else b'instance/demo-persistante/portfolio.sqlite3\n'
            return subprocess.CompletedProcess(command, 0, output, b'')
        with patch.object(demo.subprocess, 'run', side_effect=result):
            with self.assertRaises(demo.LocalError):
                demo.verify_git_exclusions(self.paths)

    def test_real_git_preflight_preserves_lf_on_windows(self):
        # Dépôt jetable, sans commit ni indexation : tester le vrai protocole stdin
        # évite le faux succès d'un mock qui ne reproduit pas la traduction CRLF.
        created = subprocess.run(['git', 'init', '--quiet', str(self.paths.root)], capture_output=True)
        self.assertEqual(created.returncode, 0)
        shutil.copyfile(ROOT/'.gitignore', self.paths.root/'.gitignore')
        demo.verify_git_exclusions(self.paths)
        self.assertFalse(self.paths.data.exists())

    def test_occupied_port_does_not_stop_another_server(self):
        self.init()
        with patch('werkzeug.serving.make_server', side_effect=OSError('Port occupé')) as factory:
            with self.assertRaises(demo.LocalError):
                demo.serve(self.paths)
            self.assertEqual(factory.call_args.args[:2], (demo.HOST, demo.PORT))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--worker':
        try:
            persons = [demo.Person(**row) for row in json.loads(sys.stdin.read())]
            print(json.dumps(worker(sys.argv[2], sys.argv[3], persons)))
        except Exception:
            print('Échec du contrôle isolé ; détails privés non reproduits.', file=sys.stderr)
            raise SystemExit(1)
    elif len(sys.argv) > 1 and sys.argv[1] == '--lock-probe':
        try:
            with demo.operation_lock(demo.Paths(Path(sys.argv[2]))):
                raise SystemExit(0)
        except demo.LocalError:
            raise SystemExit(3)
    else:
        unittest.main(verbosity=2)
