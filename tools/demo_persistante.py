"""Mode local persistant explicite, indépendant du kit SQLite mémoire.

Aucune création ni ouverture de base à l'import. Utiliser --help avant init.
Les accès sont saisis exclusivement dans une console privée interactive.
"""
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode
import argparse
import ctypes
import getpass
import hashlib
import importlib.util
import json
import logging
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import warnings

ROOT = Path(__file__).resolve().parents[1]
HOST, PORT = '127.0.0.1', 5066
FORMAT = 1
APPLICATION_ID = int.from_bytes(b'LPE1', 'big')
COOKIE = 'lpe_persistante'
NAMES = ('admin', 'Alice', 'Bob')
FIELDS = ('id', 'slug', 'title', 'summary', 'content', 'category_id', 'image_url')
SNAPSHOT = re.compile(r'\d{8}T\d{12}Z-[0-9a-f]{8}')


class LocalError(Exception):
    """Message constant, sans donnée de compte ou de configuration privée."""


@dataclass(frozen=True)
class Person:
    username: str
    email: str = field(repr=False)
    password: str = field(repr=False)


@dataclass(frozen=True)
class Paths:
    root: Path = ROOT

    def __post_init__(self):
        object.__setattr__(self, 'root', self.root.resolve())
        if str(self.root).startswith('\\\\'):
            raise LocalError('Un chemin local est requis.')

    @property
    def instance(self):
        return self.root / 'instance'

    @property
    def data(self):
        return self.instance / 'demo-persistante'

    @property
    def database(self):
        return self.data / 'portfolio.sqlite3'

    @property
    def key(self):
        return self.data / 'session.key'

    @property
    def lock(self):
        return self.instance / '.demo-persistante.lock'

    @property
    def backups(self):
        return self.root / 'backups' / 'demo-persistante'

    def checked(self, path):
        path = Path(path).absolute()
        if not path.is_relative_to(self.root) or path.resolve() != path:
            raise LocalError('Chemin hors du périmètre local ou redirigé.')
        for part in (path, *path.parents):
            if part == self.root:
                break
            if part.is_symlink() or part.is_junction():
                raise LocalError('Lien de fichier ou de dossier refusé.')
        if path.is_file() and path.stat().st_nlink != 1:
            raise LocalError('Fichier partagé par lien physique refusé.')
        return path


def _windows_security(action, path=None):
    """Créer/vérifier une DACL protégée, réservée au SID du processus courant."""
    from ctypes import wintypes as w
    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pointer = ctypes.c_void_p
    adv.OpenProcessToken.argtypes = (w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE))
    adv.GetTokenInformation.argtypes = (w.HANDLE, ctypes.c_int, pointer, w.DWORD, ctypes.POINTER(w.DWORD))
    adv.ConvertSidToStringSidW.argtypes = (pointer, ctypes.POINTER(w.LPWSTR))
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = (w.LPCWSTR, w.DWORD, ctypes.POINTER(pointer), pointer)
    adv.GetFileSecurityW.argtypes = (w.LPCWSTR, w.DWORD, pointer, w.DWORD, ctypes.POINTER(w.DWORD))
    adv.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = (pointer, w.DWORD, w.DWORD, ctypes.POINTER(w.LPWSTR), pointer)
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = (w.HANDLE,)
    kernel.LocalFree.argtypes = (pointer,)
    token, size = w.HANDLE(), w.DWORD()
    if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise LocalError('Impossible de protéger le dossier privé.')
    try:
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        if not adv.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
            raise LocalError('Impossible de lire les droits du compte courant.')
        sid_pointer = ctypes.cast(buffer, ctypes.POINTER(pointer))[0]
        sid = w.LPWSTR()
        if not adv.ConvertSidToStringSidW(sid_pointer, ctypes.byref(sid)):
            raise LocalError('Impossible de lire les droits du compte courant.')
        try:
            sid_text = sid.value
        finally:
            kernel.LocalFree(ctypes.cast(sid, pointer))
    finally:
        kernel.CloseHandle(token)
    if action == 'create':
        descriptor = pointer()
        if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                'D:P(A;OICI;FA;;;' + sid_text + ')', 1, ctypes.byref(descriptor), None):
            raise LocalError('Impossible de préparer les droits privés.')
        class Attributes(ctypes.Structure):
            _fields_ = [('length', w.DWORD), ('descriptor', pointer), ('inherit', w.BOOL)]
        attrs = Attributes(ctypes.sizeof(Attributes), descriptor, False)
        kernel.CreateDirectoryW.argtypes = (w.LPCWSTR, ctypes.POINTER(Attributes))
        try:
            if not kernel.CreateDirectoryW(str(path), ctypes.byref(attrs)):
                raise LocalError('Impossible de créer un dossier privé neuf.')
        finally:
            kernel.LocalFree(descriptor)
    size = w.DWORD()
    adv.GetFileSecurityW(str(path), 4, None, 0, ctypes.byref(size))
    buffer = ctypes.create_string_buffer(size.value)
    if not adv.GetFileSecurityW(str(path), 4, buffer, size, ctypes.byref(size)):
        raise LocalError('Impossible de vérifier les droits privés.')
    text = w.LPWSTR()
    if not adv.ConvertSecurityDescriptorToStringSecurityDescriptorW(buffer, 1, 4, ctypes.byref(text), None):
        raise LocalError('Impossible de vérifier les droits privés.')
    try:
        value = text.value
        entries = re.findall(r'\(([^()]*)\)', value)
        if not value.startswith('D:P') or not entries or any(
                entry.split(';')[0] != 'A' or entry.split(';')[-1] != sid_text for entry in entries):
            raise LocalError('Le dossier doit être réservé au compte Windows courant.')
    finally:
        kernel.LocalFree(ctypes.cast(text, pointer))


def private_directory(paths, path, *, create=False):
    path = paths.checked(path)
    if os.name == 'nt':
        _windows_security('create' if create else 'verify', path)
    elif create:
        path.mkdir(mode=0o700)
    if not path.is_dir() or os.name != 'nt' and path.stat().st_mode & 0o077:
        raise LocalError('Droits du dossier privé insuffisants.')
    return path


def exclusive_file(path, content=b''):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


@contextmanager
def operation_lock(paths, *, create=False):
    paths.checked(paths.lock)
    if create:
        paths.checked(paths.instance).mkdir(exist_ok=True)
        try:
            exclusive_file(paths.lock, b'\0')
        except FileExistsError:
            pass
    try:
        stream = paths.lock.open('r+b')
    except FileNotFoundError:
        raise LocalError('Le mode persistant n’est pas initialisé.') from None
    acquired = False
    try:
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError:
            raise LocalError('Mode persistant occupé : aucune opération concurrente.') from None
        yield
    finally:
        if acquired:
            if os.name == 'nt':
                import msvcrt
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def _backend():
    backend = str(ROOT / 'backend')
    if backend not in sys.path:
        sys.path.insert(0, backend)
    import models
    if Path(models.__file__).resolve() != ROOT / 'backend/models.py':
        raise LocalError('Un autre ensemble de modèles est déjà chargé.')
    from api.v1.views.users import is_valid_password
    return models, is_valid_password


def catalogue():
    spec = importlib.util.spec_from_file_location('_lpe_catalogue', ROOT / 'tools/recette_lot6g4.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.validate_sources()
    return module.load_historical_stories()


def database_uri(path, mode):
    return path.as_uri() + '?' + urlencode({'mode': mode})


@contextmanager
def opened(path, *, readonly=True):
    connection = sqlite3.connect(database_uri(path, 'ro' if readonly else 'rw'), uri=True, timeout=5)
    try:
        connection.execute('PRAGMA foreign_keys=ON')
        if connection.execute('PRAGMA foreign_keys').fetchone()[0] != 1:
            raise LocalError('Clés étrangères non actives.')
        yield connection
    finally:
        connection.close()


def inspect_database(connection, *, initial=False):
    models, _ = _backend()
    from sqlalchemy.dialects.sqlite import dialect
    from sqlalchemy.schema import CreateTable
    if (connection.execute('PRAGMA application_id').fetchone()[0] != APPLICATION_ID or
            connection.execute('PRAGMA user_version').fetchone()[0] != FORMAT):
        raise LocalError('Format local inconnu : aucune migration automatique.')
    actual = dict(connection.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
    expected = {table.name: str(CreateTable(table).compile(dialect=dialect())) for table in models.db.metadata.sorted_tables}
    normalize = lambda text: ' '.join(text.split())
    if set(actual) != set(expected) or any(normalize(actual[name]) != normalize(expected[name]) for name in expected):
        raise LocalError('Schéma différent des modèles validés.')
    if (connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or
            connection.execute('PRAGMA foreign_key_check').fetchall()):
        raise LocalError('Intégrité de la base invalide.')
    if connection.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
        raise LocalError('Mode de journal SQLite non pris en charge par ce lanceur.')
    counts = {name: connection.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] for name in expected}
    missing = changed = archived = 0
    for original in catalogue():
        row = connection.execute('SELECT ' + ','.join(FIELDS) + ',archived_at FROM stories WHERE id=?', (original['id'],)).fetchone()
        if row is None:
            missing += 1
        else:
            changed += tuple(row[:-1]) != tuple(original[key] for key in FIELDS)
            archived += row[-1] is not None
    people = connection.execute('SELECT username,is_admin,is_banned FROM users WHERE username IN (?,?,?)', NAMES).fetchall()
    expected_people = {(name, int(name == 'admin'), 0) for name in NAMES}
    account_warnings = set(people) != expected_people
    if initial and (counts['users'] != 3 or account_warnings or missing or changed or archived or
                    any(counts[name] for name in expected if name not in {'users', 'categories', 'stories'}) or counts['categories'] != 2):
        raise LocalError('Initialisation non conforme : aucune donnée publiée.')
    return {'tables': counts, 'originals_missing': missing, 'originals_changed': changed,
            'originals_archived': archived, 'initial_account_roles_changed': account_warnings}


def initialized(paths):
    private_directory(paths, paths.data)
    paths.checked(paths.database)
    paths.checked(paths.key)
    if not paths.database.is_file() or not paths.key.is_file():
        raise LocalError('Base ou clé absente : aucune recréation automatique.')
    key = paths.key.read_bytes()
    if not re.fullmatch(b'[0-9a-f]{64}', key):
        raise LocalError('Clé de session invalide.')
    with opened(paths.database) as connection:
        inspect_database(connection)
    return key


@contextmanager
def application(paths, *, database=None, key=None):
    """Configurer avant init_app ; seules les connexions au fichier choisi passent."""
    database = paths.checked(database or paths.database)
    if not database.is_file():
        raise LocalError('Fichier local absent : aucune création implicite.')
    key = key if key is not None else initialized(paths)
    import dotenv
    import dotenv.main
    from sqlalchemy.engine import Engine, URL
    models, _ = _backend()
    db = models.db
    url = URL.create('sqlite', database=database.as_uri(), query={'mode': 'rw', 'uri': 'true'})
    environment = {name: os.environ[name] for name in ('SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'TEMP', 'TMP') if name in os.environ}
    environment.update({'DATABASE_URL': str(url), 'SECRET_KEY': key.decode('ascii'),
                        'CORS_ALLOWED_ORIGINS': f'http://{HOST}:{PORT}', 'SESSION_COOKIE_SECURE': 'false'})
    original_connect = sqlite3.dbapi2.connect
    engine_connect, engine_raw = Engine.connect, Engine.raw_connection
    init_app = db.init_app
    def deny(*args, **kwargs):
        raise LocalError('Connexion réseau ou base non autorisée.')
    def guard(engine):
        if (engine.url != url or not database.is_file() or paths.checked(database) != database):
            deny()
    def connect(database_name, *args, **kwargs):
        if database_name not in {database_uri(database, 'rw'), database_uri(database, 'ro')} or kwargs.get('uri') is not True:
            deny()
        paths.checked(database)
        if not database.is_file():
            deny()
        connection = original_connect(database_name, *args, **kwargs)
        connection.execute('PRAGMA foreign_keys=ON')
        if connection.execute('PRAGMA foreign_keys').fetchone()[0] != 1:
            connection.close(); deny()
        connection.set_authorizer(lambda action, *rest: sqlite3.SQLITE_DENY if action in {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH} else sqlite3.SQLITE_OK)
        return connection
    def configure(app):
        if app.config.get('SQLALCHEMY_DATABASE_URI') != str(url):
            deny()
        app.config.update(SESSION_COOKIE_NAME=COOKIE, SESSION_COOKIE_DOMAIN=None,
                          SQLALCHEMY_ENGINE_OPTIONS={'hide_parameters': True, 'echo': False, 'connect_args': {'timeout': 5}},
                          DEBUG=False)
        init_app(app)
    module_name = '_lpe_persistent_' + secrets.token_hex(8)
    app = None
    with ExitStack() as guards:
        guards.enter_context(patch.dict(os.environ, environment, clear=True))
        for owner, name, replacement in [
            (dotenv, 'load_dotenv', lambda *a, **k: False), (dotenv.main, 'load_dotenv', lambda *a, **k: False),
            (socket, 'create_connection', deny),
            (socket.socket, 'connect', deny), (socket.socket, 'connect_ex', deny),
            (sqlite3, 'connect', connect), (sqlite3.dbapi2, 'connect', connect),
            (Engine, 'connect', lambda engine, *a, **k: (guard(engine), engine_connect(engine, *a, **k))[1]),
            (Engine, 'raw_connection', lambda engine, *a, **k: (guard(engine), engine_raw(engine, *a, **k))[1]),
            (db, 'init_app', configure)]:
            guards.enter_context(patch.object(owner, name, replacement))
        guards.enter_context(patch.object(logging.getLogger('sqlalchemy.engine'), 'disabled', True))
        spec = importlib.util.spec_from_file_location(module_name, ROOT / 'backend/index.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
            app = module.app
            app.logger.disabled = True
            with app.app_context():
                guard(db.engine)
            yield app, db, models
        finally:
            if app is not None:
                with app.app_context():
                    db.session.remove()
                    db.engine.dispose()
            sys.modules.pop(module_name, None)


def _valid_people(people):
    _, valid_password = _backend()
    if len(people) != 3 or tuple(p.username for p in people) != NAMES or len({p.email for p in people}) != 3:
        raise LocalError('Trois comptes distincts requis.')
    email_pattern = r"[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+"
    for person in people:
        email = person.email
        if not isinstance(email, str):
            raise LocalError('Adresse e-mail invalide ou dupliquée.')
        local = email.partition('@')[0]
        if (not isinstance(email, str) or len(email) > 150 or not re.fullmatch(email_pattern, email) or
                len(local) > 64 or local.startswith('.') or local.endswith('.') or '..' in local or
                any(len(label) > 63 for label in email.partition('@')[2].split('.'))):
            raise LocalError('Adresse e-mail invalide ou dupliquée.')
        if not isinstance(person.password, str) or not valid_password(person.password):
            raise LocalError('Le mot de passe ne respecte pas la politique existante.')
        try:
            person.password.encode('utf-8')
        except UnicodeEncodeError:
            raise LocalError('Saisie non valide.') from None


def collect_people():
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise LocalError('Une console privée interactive sans transcription est requise.')
    people = []
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        for name in NAMES:
            email = input(name + ' — adresse e-mail : ').strip()
            first = getpass.getpass(name + ' — mot de passe : ')
            second = getpass.getpass('Confirmer sans écho : ')
            if first != second:
                raise LocalError('Les deux saisies diffèrent.')
            people.append(Person(name, email, first))
            del first, second
    _valid_people(people)
    return people


def verify_git_exclusions(paths):
    names = ['instance/demo-persistante/portfolio.sqlite3', 'instance/demo-persistante/session.key',
             *['instance/demo-persistante/portfolio.sqlite3' + suffix for suffix in ('-journal', '-wal', '-shm')],
             'backups/demo-persistante/snapshot/portfolio.sqlite3']
    command = ['git', '-c', 'safe.directory=' + paths.root.as_posix(), '--no-optional-locks']
    ignored = subprocess.run(command + ['check-ignore', '--stdin'], cwd=paths.root,
                             input=('\n'.join(names) + '\n').encode('utf-8'), capture_output=True)
    tracked = subprocess.run(command + ['ls-files', '--', 'instance/demo-persistante', 'backups/demo-persistante'],
                             cwd=paths.root, capture_output=True)
    if ignored.returncode or set(ignored.stdout.decode('utf-8').splitlines()) != set(names) or tracked.returncode or tracked.stdout.strip():
        raise LocalError('Exclusions Git privées non vérifiées.')


def _work(paths, parent):
    parent = paths.checked(parent)
    work = parent / ('.demo-work-' + secrets.token_hex(12))
    private_directory(paths, work, create=True)
    return work


def _discard(paths, work):
    work = paths.checked(work)
    if work.parent not in {paths.instance, paths.backups} or not work.name.startswith('.demo-work-'):
        raise LocalError('Nettoyage hors du dossier de travail refusé.')
    if work.exists():
        shutil.rmtree(work)


# Construire et vérifier la base dans un dossier de travail avant de la mettre en service.
def initialize(paths, people):
    if paths.checked(paths.data).exists():
        raise LocalError('Données déjà présentes : initialisation refusée.')
    _valid_people(people)
    stories = catalogue()
    work = _work(paths, paths.instance)
    try:
        database = work / 'portfolio.sqlite3'
        exclusive_file(database)
        key = secrets.token_hex(32).encode('ascii')
        exclusive_file(work / 'session.key', key)
        with application(paths, database=database, key=key) as (app, db, models):
            with app.app_context():
                db.create_all()
                db.session.execute(db.text(f'PRAGMA application_id={APPLICATION_ID}'))
                db.session.execute(db.text(f'PRAGMA user_version={FORMAT}'))
                for identifier, person in enumerate(people, 1):
                    user = models.User(id=identifier, username=person.username, email=person.email,
                                       is_admin=identifier == 1, is_banned=False)
                    user.set_password(person.password)
                    db.session.add(user)
                db.session.add_all([models.Category(id=1, name='Histoires résolues'), models.Category(id=2, name='Cold Cases')])
                db.session.flush()
                for row in stories:
                    db.session.add(models.Story(**{key: row[key] for key in FIELDS}, author_id=1))
                db.session.commit()
                with opened(database) as connection:
                    result = inspect_database(connection, initial=True)
        if paths.checked(paths.data).exists():
            raise LocalError('Une destination est apparue : aucun remplacement.')
        work.rename(paths.data)
        return result
    finally:
        _discard(paths, work)


# Inspecter le schéma et les dossiers de démonstration en lecture seule.
def check(paths):
    initialized(paths)
    with opened(paths.database) as connection:
        return inspect_database(connection)


def _copy_database(source, target):
    exclusive_file(target)
    with opened(source) as reader, opened(target, readonly=False) as writer:
        reader.backup(writer)
        inspect_database(writer)


# Utiliser la sauvegarde SQLite, puis associer la copie à son empreinte de contrôle.
def backup(paths):
    initialized(paths)
    paths.checked(paths.backups.parent).mkdir(exist_ok=True)
    private_directory(paths, paths.backups, create=not paths.backups.exists())
    work = _work(paths, paths.backups)
    try:
        target = work / 'portfolio.sqlite3'
        _copy_database(paths.database, target)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + secrets.token_hex(4)
        manifest = {'format': FORMAT, 'created_utc': datetime.now(timezone.utc).isoformat(),
                    'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                    'catalog_sha256': hashlib.sha256((ROOT / 'tools/fixtures/dossiers_historiques.json').read_bytes()).hexdigest()}
        exclusive_file(work / 'manifest.json', (json.dumps(manifest, indent=2) + '\n').encode('utf-8'))
        work.rename(paths.backups / stamp)
        return stamp
    finally:
        _discard(paths, work)


# Vérifier la sauvegarde et conserver une copie de sécurité avant un remplacement autorisé.
def restore(paths, snapshot, *, replace=False, renew_key=False):
    if not SNAPSHOT.fullmatch(snapshot):
        raise LocalError('Identifiant de sauvegarde invalide.')
    private_directory(paths, paths.backups)
    folder = private_directory(paths, paths.checked(paths.backups / snapshot))
    source = paths.checked(folder / 'portfolio.sqlite3')
    manifest_path = paths.checked(folder / 'manifest.json')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if (not isinstance(manifest, dict) or type(manifest.get('format')) is not int or manifest.get('format') != FORMAT or
            hashlib.sha256(source.read_bytes()).hexdigest() != manifest.get('sha256') or
            hashlib.sha256((ROOT / 'tools/fixtures/dossiers_historiques.json').read_bytes()).hexdigest() != manifest.get('catalog_sha256')):
        raise LocalError('Sauvegarde différente du manifeste validé.')
    exists = paths.checked(paths.data).exists()
    if exists and not replace:
        raise LocalError('Le remplacement exige --remplacer-base-locale.')
    previous = backup(paths) if exists else None
    work = _work(paths, paths.instance)
    try:
        target = work / 'portfolio.sqlite3'
        _copy_database(source, target)
        key = secrets.token_hex(32).encode('ascii') if renew_key or not exists else initialized(paths)
        exclusive_file(work / 'session.key', key)
        if exists:
            if any(paths.checked(Path(str(paths.database) + suffix)).exists() for suffix in ('-journal', '-wal', '-shm')):
                raise LocalError('Annexe SQLite présente : remplacement refusé.')
            # La clé est remplacée avant la base : un échec ultérieur peut imposer
            # une reconnexion, sans altérer les comptes ou perdre la base actuelle.
            if renew_key:
                os.replace(work / 'session.key', paths.key)
            os.replace(target, paths.database)
        else:
            work.rename(paths.data)
        return {'safety_backup': previous, 'session_key_renewed': renew_key or not exists}
    finally:
        _discard(paths, work)


# Ouvrir la base persistante et servir le site sur la boucle locale.
def serve(paths):
    initialized(paths)
    with application(paths) as (app, _, _):
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        from run_local import create_local_app
        from werkzeug.serving import WSGIRequestHandler, make_server
        class QuietHandler(WSGIRequestHandler):
            def log(self, *args, **kwargs):
                pass
        try:
            server = make_server(HOST, PORT, create_local_app(app), threaded=False, request_handler=QuietHandler)
        except (OSError, SystemExit):
            raise LocalError('Port 5066 indisponible ; aucun processus arrêté.') from None
        with server:
            print(f'Mode persistant local : http://{HOST}:{PORT}', flush=True)
            server.serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('init', 'serve', 'check', 'backup'):
        commands.add_parser(command)
    restore_parser = commands.add_parser('restore')
    restore_parser.add_argument('sauvegarde', help='Identifiant local produit par backup, jamais un chemin.')
    restore_parser.add_argument('--remplacer-base-locale', action='store_true')
    restore_parser.add_argument('--renouveler-cle-session', action='store_true')
    args = parser.parse_args(argv)
    paths = Paths()
    try:
        if args.command == 'init' and paths.checked(paths.data).exists():
            raise LocalError('Données déjà présentes : initialisation refusée.')
        if args.command in {'init', 'restore'}:
            verify_git_exclusions(paths)
        with operation_lock(paths, create=args.command in {'init', 'restore'}):
            if args.command == 'init':
                people = collect_people()
                try:
                    result = initialize(paths, people)
                finally:
                    people.clear()
                print(json.dumps({'result': 'PASS', 'users': 3, 'stories': 6}))
            elif args.command == 'serve':
                serve(paths)
            elif args.command == 'check':
                result = check(paths)
                print(json.dumps(result))
                return int(bool(result['originals_missing'] or result['originals_changed'] or result['initial_account_roles_changed']))
            elif args.command == 'backup':
                print(json.dumps({'backup': backup(paths)}))
            else:
                result = restore(paths, args.sauvegarde, replace=args.remplacer_base_locale, renew_key=args.renouveler_cle_session)
                print(json.dumps({'result': 'PASS', **result}))
        return 0
    except (KeyboardInterrupt, EOFError):
        print('Opération interrompue, aucune saisie affichée.', file=sys.stderr)
        return 130
    except LocalError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print('Opération refusée ou échouée ; aucun détail privé journalisé.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    raise SystemExit(main())
