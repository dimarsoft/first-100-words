"""Карточка слова: возраст, удаление записей голоса, «Поделиться», удаление слова, «Назад» при вопросе."""
from playwright.sync_api import expect

from conftest import word, old_pron

SHARE_STUB = """
window.__shared = [];
Navigator.prototype.canShare = function () { return true; };
Navigator.prototype.share = async function (d) {
  window.__shared.push({ title: d.title, text: d.text, files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) });
};
"""


def seed_two_records(app):
    app.seed([word('w1', 'биби', 'машина', date='2026-06-01', stress=3, audio=500,
                   history=[old_pron('би', '2026-06-01', stress=1, audio=400)])])
    app.open('#/word/w1')


def delete_buttons(app):
    return app.page.locator('#card .audio-item .btn.danger')


def test_card_details(app):
    app.seed([word('w1', 'биби', 'машина', date='2026-02-03', stress=3, self=False, story='Увидел во дворе')])
    app.open('#/word/w1')
    card = app.page.locator('#card')
    expect(card.locator('.card-pron')).to_have_text('бибИ')
    expect(card).to_contain_text('3 февраля 2026')
    expect(card).to_contain_text('1 год, 1 месяц, 2 дня')
    expect(card).to_contain_text('повторил(а) за взрослым')
    expect(card).to_contain_text('Увидел во дворе')


def test_delete_old_pronunciation_record(app):
    seed_two_records(app)
    expect(app.page.locator('#card audio')).to_have_count(2)
    delete_buttons(app).nth(1).click()
    expect(app.modal_text()).to_have_text('Удалить запись «бИ»? Это нельзя отменить.')
    app.answer('Удалить')
    expect(app.page.locator('#card audio')).to_have_count(1)
    expect(app.toast()).to_have_text('Запись удалена')
    w = app.wait_db(lambda d: d['words'][0]['history'][0]['audio'] is None)['words'][0]
    assert w['audio'] == 500
    assert w['history'][0]['pron'] == 'би'  # само произношение осталось


def test_two_quick_deletions_keep_both_deleted(app):
    seed_two_records(app)
    b = delete_buttons(app)
    first, second = b.nth(0), b.nth(1)
    first.click(); app.page.locator('#modal-btns button', has_text='Удалить').click()
    second.click(); app.page.locator('#modal-btns button', has_text='Удалить').click()
    expect(app.page.locator('#card audio')).to_have_count(0)
    app.page.wait_for_timeout(300)
    w = app.words()['w1']
    assert w['audio'] is None and w['history'][0]['audio'] is None


def test_cancel_keeps_record(app):
    seed_two_records(app)
    delete_buttons(app).first.click()
    app.answer('Отмена')
    expect(app.page.locator('#card audio')).to_have_count(2)
    assert app.words()['w1']['audio'] == 500


def test_back_closes_question_as_cancel(app):
    seed_two_records(app)
    delete_buttons(app).first.click()
    expect(app.page.locator('#modal')).to_be_visible()
    app.go('#/')
    expect(app.page.locator('#modal')).to_be_hidden()
    expect(app.view('list')).to_be_visible()
    app.page.wait_for_timeout(300)
    assert app.words()['w1']['audio'] == 500


def test_list_icon_disappears_after_deleting_record(app):
    app.seed([word('w1', 'да', 'да', stress=1, audio=500)])
    app.open()
    expect(app.list_items().first.locator('.item-icons')).to_have_text('🔊')
    app.list_items().first.click()
    delete_buttons(app).first.click()
    app.answer('Удалить')
    expect(app.page.locator('#card audio')).to_have_count(0)
    app.go('#/')
    expect(app.list_items().first.locator('.item-icons')).to_have_count(0)


def test_share_record(app):
    app.page.add_init_script(SHARE_STUB)
    app.seed([word('w1', 'биби', 'машина', date='2026-06-01', stress=3, audio=500)])
    app.open('#/word/w1')
    app.page.locator('#card .btn.share-audio', has_text='Поделиться').click()
    app.page.wait_for_function('window.__shared.length === 1')
    shared = app.page.evaluate('window.__shared[0]')
    assert shared['files'] == [{'name': 'бибИ-машина-2026-06-01.webm', 'type': 'audio/webm', 'size': 500}]
    assert shared['text'].startswith('«бибИ» — машина, 1 июня 2026')


def test_share_without_web_share_downloads(app):
    app.seed([word('w1', 'да', 'да', date='2026-06-01', stress=1, audio=500)])
    app.open('#/word/w1')
    with app.page.expect_download() as d:
        app.page.locator('#card .btn.share-audio', has_text='Поделиться').click()
    assert d.value.suggested_filename == 'дА-да-2026-06-01.webm'


def test_delete_word(app):
    app.seed([word('w1', 'да', 'да', stress=1), word('w2', 'ко', 'кошка', stress=1, created=2)])
    app.open('#/word/w1')
    app.page.locator('#card .btn.danger', has_text='Удалить слово').click()
    expect(app.modal_text()).to_contain_text('Удалить «дА» → да?')
    app.answer('Удалить')
    expect(app.view('list')).to_be_visible()
    expect(app.list_items()).to_have_count(1)
    assert list(app.words()) == ['w2']


def test_edit_keeps_date(app):
    app.seed([word('w1', 'да', 'да', date='2026-02-03', stress=1)])
    app.open('#/word/w1')
    app.page.locator('#card .btn.primary', has_text='Изменить').click()
    expect(app.page.locator('#form-title')).to_have_text('Изменить слово')
    expect(app.page.locator('#f-date')).to_have_value('2026-02-03')
    expect(app.page.locator('#f-draft')).to_be_hidden()
    app.page.locator('#f-meaning').fill('согласие')
    app.page.locator('#f-save').click()
    expect(app.view('list')).to_be_visible()
    w = app.words()['w1']
    assert (w['meaning'], w['date']) == ('согласие', '2026-02-03')
