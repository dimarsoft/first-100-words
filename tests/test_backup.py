"""Резервная копия в файл и восстановление на «новом телефоне», таблица CSV, Google Диск (поддельный)."""
import json

from playwright.sync_api import expect

from conftest import CORS, App, word, old_pron

WORDS = [
    word('w1', 'биби', 'машина', date='2026-03-01', stress=3, audio=700,
         history=[old_pron('би', '2026-03-01', stress=1, audio=300)], story='Во дворе "машинка"'),
    word('w2', 'ко', 'кошка', date='2026-04-01', stress=1, self=False, created=2),
    word('w3', 'му', 'корова', stress=1, draft=True, created=3),
]


def new_phone(make_context, server):
    ctx = make_context()
    return App(ctx.new_page(), server)


def check_restored(app):
    expect(app.view('list')).to_be_visible()
    expect(app.page.locator('#count')).to_have_text('2')
    expect(app.page.locator('#list-title')).to_have_text('Словарь: Тест')
    d = app.db()
    words = {w['id']: w for w in d['words']}
    assert set(words) == {'w1', 'w2', 'w3'}
    assert words['w1']['audio'] == 700 and words['w1']['history'][0]['audio'] == 300
    assert words['w1']['story'] == 'Во дворе "машинка"'
    assert words['w3']['draft'] is True
    assert d['meta']['celebrated'] == [10]
    assert d['meta']['lastBackupAt'] > 0


def test_backup_file_and_restore_on_new_phone(app, make_context, server, tmp_path):
    app.seed(WORDS, celebrated=[10])
    app.open('#/settings')
    expect(app.page.locator('#s-size')).to_contain_text('Слов: 2, аудиозаписей: 2')
    with app.page.expect_download() as d:
        app.page.locator('#s-backup').click()
    expect(app.toast()).to_have_text('Копия сохранена')
    assert d.value.suggested_filename.startswith('slova-kopiya-')
    path = tmp_path / 'copy.json'
    d.value.save_as(path)
    data = json.loads(path.read_text(encoding='utf-8'))
    assert data['app'] == 'first100' and len(data['words']) == 3
    assert data['words'][0]['audio'].startswith('data:audio/webm;base64,')
    expect(app.page.locator('#s-backup-info')).to_contain_text('Последняя копия')

    phone = new_phone(make_context, server)
    phone.open()
    expect(phone.view('onboard')).to_be_visible()
    phone.page.locator('#ob-restore-file').set_input_files(path)
    expect(phone.modal_text()).to_contain_text('В копии 2 слов')
    phone.answer('Восстановить')
    check_restored(phone)


def test_restore_replaces_current_data(app, tmp_path):
    app.seed([word('old', 'ня', 'няня', stress=1)])
    app.open('#/settings')
    copy = {'app': 'first100', 'format': 1, 'exportedAt': '2026-05-01T10:00:00Z',
            'child': {'name': 'Тест', 'birth': '2025-01-01'}, 'celebrated': [],
            'words': [word('n1', 'да', 'да', stress=1)]}
    path = tmp_path / 'copy.json'
    path.write_text(json.dumps(copy), encoding='utf-8')
    app.page.locator('#s-restore-file').set_input_files(path)
    expect(app.modal_text()).to_have_text('В копии 1 слов от 1 мая 2026. Заменить ими текущие данные (1 слов)?')
    app.answer('Заменить')
    expect(app.toast()).to_have_text('Данные восстановлены')
    assert list(app.words()) == ['n1']


def test_restore_rejects_foreign_file(app, tmp_path):
    app.seed([word('old', 'ня', 'няня', stress=1)])
    app.open('#/settings')
    path = tmp_path / 'other.json'
    path.write_text('{"hello": 1}', encoding='utf-8')
    app.page.locator('#s-restore-file').set_input_files(path)
    expect(app.toast()).to_have_text('Это не резервная копия «Первых 100 слов»')
    assert list(app.words()) == ['old']


def test_csv_export(app, tmp_path):
    app.seed(WORDS)
    app.open('#/settings')
    with app.page.expect_download() as d:
        app.page.locator('#s-csv').click()
    path = tmp_path / 'table.csv'
    d.value.save_as(path)
    raw = path.read_bytes()
    assert raw.startswith('﻿'.encode('utf-8'))  # BOM — чтобы Excel понял кодировку
    lines = raw.decode('utf-8-sig').split('\r\n')
    assert lines[0].split(';')[-1] == '"Как появилось слово?"'
    assert len(lines) == 3  # заголовок + 2 слова, без черновика
    assert lines[1] == ('"1";"бибИ";"машина";"1 марта 2026";"1 г 2 мес";"сам(а)";"бИ";"есть";'
                        '"Во дворе ""машинка"""')
    assert '"за взрослым"' in lines[2] and '"нет"' in lines[2]


def test_google_drive_save_and_load_on_new_phone(app, make_context, server, drive):
    app.seed(WORDS, celebrated=[10])
    app.open('#/settings')
    expect(app.page.locator('#s-drive-box')).to_be_visible()
    app.page.locator('#s-drive-save').click()
    expect(app.toast()).to_contain_text('Сохранено на Google Диск')
    assert len(drive.files) == 1
    f = next(iter(drive.files.values()))
    assert f['name'] == 'Первые 100 слов — копия.json'
    assert json.loads(f['body'])['app'] == 'first100'
    expect(app.page.locator('#s-drive-info')).to_contain_text('Последнее сохранение на Диск')
    expect(app.page.locator('#s-drive-off')).to_be_visible()

    # повторное сохранение перезаписывает тот же файл
    app.page.locator('#s-drive-save').click()
    expect(app.page.locator('#s-drive-save')).to_be_enabled()
    expect(app.toast()).to_contain_text('Сохранено на Google Диск')
    assert len(drive.files) == 1
    assert any(r.startswith('PATCH /upload/drive/v3/files/') for r in drive.requests)

    phone = new_phone(make_context, server)
    phone.open()
    phone.page.locator('#ob-drive').click()
    expect(phone.modal_text()).to_contain_text('В копии 2 слов')
    phone.answer('Восстановить')
    check_restored(phone)


def test_google_drive_without_copy(app):
    app.seed()
    app.open('#/settings')
    app.page.locator('#s-drive-load').click()
    expect(app.toast()).to_have_text('На Google Диске нет копии этого приложения')


def test_google_drive_error_is_shown(app, context):
    def broken(route):
        if route.request.method == 'OPTIONS':
            return route.fulfill(status=204, headers=CORS)
        return route.fulfill(status=500, headers=CORS, body='')

    context.unroute('https://www.googleapis.com/**')
    context.route('https://www.googleapis.com/**', broken)
    app.seed([word('w1', 'да', 'да', stress=1)])
    app.open('#/settings')
    app.page.locator('#s-drive-save').click()
    expect(app.toast()).to_have_text('Google Диск ответил ошибкой 500')
    expect(app.page.locator('#s-drive-save')).to_be_enabled()
