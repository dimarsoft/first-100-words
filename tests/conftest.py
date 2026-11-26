"""Общая обвязка автотестов: сервер для docs/, браузер с размером телефона, поддельные Google и Диск,
заполнение и чтение IndexedDB приложения.

Каждый тест получает новый контекст браузера — пустую базу и чистое хранилище.
"""
import http.server
import json
import pathlib
import re
import threading
import time
from urllib.parse import urlparse, parse_qs

import pytest
from playwright.sync_api import expect

DOCS = pathlib.Path(__file__).resolve().parent.parent / 'docs'
CHILD = {'name': 'Тест', 'birth': '2025-01-01'}

# Поддельный звук вместо микрофона, без запроса разрешения.
LAUNCH_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
CONTEXT_ARGS = {
    'viewport': {'width': 390, 'height': 844},
    'device_scale_factor': 2,
    'is_mobile': True,
    'has_touch': True,
    'locale': 'ru-RU',
    'permissions': ['microphone'],
    'accept_downloads': True,
}
# Без Web Share приложение скачивает файл — так его можно поймать. Тест «Поделиться» ставит свою заглушку.
NO_SHARE = 'delete Navigator.prototype.share; delete Navigator.prototype.canShare;'


# ---------------- сервер ----------------
class Server:
    def __init__(self):
        self.overrides = {}  # путь → (тип, bytes): подмена файла, например sw.js с другим CACHE
        server = self

        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=str(DOCS), **kw)

            def do_GET(self):
                path = urlparse(self.path).path
                if path == '/__blank':
                    return self._send('text/html; charset=utf-8', b'<!doctype html><meta charset="utf-8">')
                if path in server.overrides:
                    return self._send(*server.overrides[path])
                return super().do_GET()

            def _send(self, ctype, body):
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def end_headers(self):
                self.send_header('Cache-Control', 'no-store')
                super().end_headers()

            def log_message(self, *a):
                pass

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}/'
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def override_sw_cache(self, name):
        sw = (DOCS / 'sw.js').read_text(encoding='utf-8')
        sw = re.sub(r"const CACHE = '[^']+'", f"const CACHE = '{name}'", sw)
        self.overrides['/sw.js'] = ('text/javascript; charset=utf-8', sw.encode('utf-8'))


@pytest.fixture(scope='session')
def server():
    s = Server()
    yield s
    s.httpd.shutdown()


@pytest.fixture(autouse=True)
def _reset_overrides(server):
    server.overrides.clear()
    yield
    server.overrides.clear()


# ---------------- браузер ----------------
@pytest.fixture(scope='session')
def browser_type_launch_args(browser_type_launch_args):
    return {**browser_type_launch_args, 'args': LAUNCH_ARGS}


@pytest.fixture(scope='session')
def browser_context_args(browser_context_args):
    # Service worker в обычных тестах выключен: он не нужен и мешает перехвату запросов.
    # Тесты офлайна и обновления создают контекст с ним сами (make_context).
    return {**browser_context_args, **CONTEXT_ARGS, 'service_workers': 'block'}


# ---------------- поддельные Google и Диск ----------------
GIS_STUB = """
window.google = { accounts: { oauth2: {
  initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() =>
    cfg.callback({ access_token: 'test-token', expires_in: 3600, scope: cfg.scope }), 0) }),
  hasGrantedAllScopes: () => true,
  revoke: (t, cb) => { if (cb) cb(); },
} } };
"""
CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Upload-Content-Type',
    'Access-Control-Expose-Headers': 'Location',
}


class FakeDrive:
    """Google Drive API в объёме, который использует приложение: поиск файла, resumable-загрузка, скачивание."""

    def __init__(self):
        self.files = {}  # id → {'name', 'body', 'modifiedTime'}
        self.requests = []

    def handle(self, route):
        req = route.request
        u = urlparse(req.url)
        self.requests.append(f'{req.method} {u.path}')
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers=CORS)
        # Адрес сессии загрузки сам служит ключом: приложение шлёт туда файл без токена, как и разрешает Google.
        if req.headers.get('authorization') != 'Bearer test-token' and not u.path.startswith('/upload/session/'):
            return self._json(route, {'error': 'unauthorized'}, 401)
        path = u.path
        if req.method == 'GET' and path == '/drive/v3/files':
            q = parse_qs(u.query).get('q', [''])[0]
            name = re.search(r"name = '([^']*)'", q).group(1)
            found = [{'id': i, 'modifiedTime': f['modifiedTime'], 'size': str(len(f['body']))}
                     for i, f in self.files.items() if f['name'] == name]
            return self._json(route, {'files': found[:1]})
        m = re.fullmatch(r'/drive/v3/files/([^/]+)', path)
        if req.method == 'GET' and m and 'alt=media' in u.query:
            return route.fulfill(status=200, headers=CORS, body=self.files[m.group(1)]['body'])
        if req.method == 'POST' and path == '/upload/drive/v3/files':
            meta = json.loads(req.post_data or '{}')
            fid = f'file{len(self.files) + 1}'
            self.files[fid] = {'name': meta['name'], 'body': b'', 'modifiedTime': '2026-01-01T00:00:00Z'}
            return self._session(route, fid)
        m = re.fullmatch(r'/upload/drive/v3/files/([^/]+)', path)
        if req.method == 'PATCH' and m:
            return self._session(route, m.group(1))
        m = re.fullmatch(r'/upload/session/([^/]+)', path)
        if req.method == 'PUT' and m:
            self.files[m.group(1)]['body'] = req.post_data_buffer or b''
            return self._json(route, {'id': m.group(1)})
        return self._json(route, {'error': 'not found'}, 404)

    def _session(self, route, fid):
        return route.fulfill(status=200, headers={**CORS, 'Location': f'https://www.googleapis.com/upload/session/{fid}'}, body='')

    @staticmethod
    def _json(route, data, status=200):
        return route.fulfill(status=status, headers={**CORS, 'Content-Type': 'application/json'}, body=json.dumps(data))


def prepare_context(ctx, drive):
    ctx.add_init_script(NO_SHARE)
    ctx.route('https://accounts.google.com/**', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GIS_STUB))
    ctx.route('https://www.googleapis.com/**', drive.handle)


@pytest.fixture
def drive():
    return FakeDrive()


@pytest.fixture(autouse=True)
def _google(context, drive):
    prepare_context(context, drive)


@pytest.fixture
def make_context(browser, browser_context_args, drive):
    """Отдельный контекст (второй «телефон» или контекст с service worker)."""
    made = []

    def make(**overrides):
        ctx = browser.new_context(**{**browser_context_args, **overrides})
        prepare_context(ctx, drive)
        made.append(ctx)
        return ctx

    yield make
    for c in made:
        c.close()


# ---------------- приложение ----------------
def word(id, pron, meaning, date='2026-06-01', stress=None, audio=None, history=None, self=True,
         draft=False, story='', created=1):
    """Запись слова как в базе. audio — размер поддельной записи в байтах (или None)."""
    return {
        'schema': 1, 'id': id, 'pron': pron, 'stress': stress, 'meaning': meaning, 'date': date,
        'self': self, 'story': story, 'audio': audio, 'audioType': 'audio/webm' if audio else '',
        'draft': draft, 'history': history or [], 'createdAt': created, 'updatedAt': created,
    }


def old_pron(pron, until, stress=None, audio=None):
    return {'pron': pron, 'stress': stress, 'until': until, 'audio': audio, 'audioType': 'audio/webm' if audio else ''}


SEED_JS = """
async ({ words, meta }) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('first100', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('words', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const blob = (n) => (typeof n === 'number' ? new Blob([new Uint8Array(n)], { type: 'audio/webm' }) : null);
  const t = db.transaction(['words', 'meta'], 'readwrite');
  for (const w of words) t.objectStore('words').put({ ...w, audio: blob(w.audio), history: w.history.map((h) => ({ ...h, audio: blob(h.audio) })) });
  for (const [k, v] of Object.entries(meta)) t.objectStore('meta').put(v, k);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  db.close();
}
"""
READ_JS = """
async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('first100'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const get = (store, op) => new Promise((res) => { const r = op(db.transaction(store).objectStore(store)); r.onsuccess = () => res(r.result); });
  const words = await get('words', (s) => s.getAll());
  const keys = await get('meta', (s) => s.getAllKeys());
  const vals = await get('meta', (s) => s.getAll());
  db.close();
  const size = (a) => (a ? a.size : null);
  return {
    words: words.map((w) => ({ ...w, audio: size(w.audio), history: (w.history || []).map((h) => ({ ...h, audio: size(h.audio) })) })),
    meta: Object.fromEntries(keys.map((k, i) => [k, vals[i]])),
  };
}
"""


class App:
    def __init__(self, page, server):
        self.page = page
        self.server = server

    def seed(self, words=(), child=CHILD, **meta):
        """Заполнить базу до запуска приложения (страница того же origin без приложения)."""
        self.page.goto(self.server.url + '__blank')
        if child:
            meta['child'] = child
        self.page.evaluate(SEED_JS, {'words': list(words), 'meta': meta})

    def open(self, hash='#/'):
        self.page.goto(self.server.url + 'index.html' + hash)
        self.page.wait_for_function("document.querySelector('section.view:not([hidden])')")

    def go(self, hash):
        self.page.evaluate('(h) => { location.hash = h; }', hash)

    def db(self):
        return self.page.evaluate(READ_JS)

    def words(self):
        return {w['id']: w for w in self.db()['words']}

    def wait_db(self, check, timeout=5.0):
        """Дождаться, пока данные в базе станут такими, как ожидается (check(db) → bool)."""
        end = time.time() + timeout
        while True:
            d = self.db()
            if check(d):
                return d
            if time.time() > end:
                raise AssertionError(f'База не пришла в ожидаемое состояние: {d}')
            self.page.wait_for_timeout(100)

    # --- элементы
    def view(self, name):
        return self.page.locator(f'#view-{name}')

    def modal_text(self):
        return self.page.locator('#modal-text')

    def answer(self, text):
        """Нажать кнопку в вопросе приложения."""
        self.page.locator('#modal-btns button', has_text=text).click()
        expect(self.page.locator('#modal')).to_be_hidden()

    def toast(self):
        return self.page.locator('#toast')

    def list_items(self):
        return self.page.locator('#list > li')


@pytest.fixture
def app(page, server):
    return App(page, server)
