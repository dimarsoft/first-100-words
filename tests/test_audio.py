"""Запись голоса с поддельного микрофона: остановка, удаление в форме, автостоп через минуту (подмена часов)."""
from playwright.sync_api import expect


def start_recording(app):
    app.page.locator('#f-audio button', has_text='Записать голос').click()
    expect(app.page.locator('#rec-time')).to_be_visible()
    app.page.wait_for_timeout(1200)  # настоящая запись, чтобы были данные


def test_record_stop_and_save(app):
    app.seed()
    app.open('#/new')
    start_recording(app)
    app.page.locator('#f-audio button', has_text='Стоп').click()
    expect(app.page.locator('#f-audio audio')).to_be_visible()
    app.page.locator('#f-pron').fill('да')
    app.page.locator('#f-meaning').fill('да')
    app.page.locator('#f-save').click()
    expect(app.list_items().first.locator('.item-icons')).to_have_text('🔊')
    w = next(iter(app.words().values()))
    assert w['audio'] > 0 and w['audioType'].startswith('audio/')


def test_delete_record_in_form(app):
    app.seed()
    app.open('#/new')
    start_recording(app)
    app.page.locator('#f-audio button', has_text='Стоп').click()
    app.page.locator('#f-audio button', has_text='Удалить').click()
    expect(app.modal_text()).to_have_text('Удалить запись голоса?')
    app.answer('Удалить')
    expect(app.page.locator('#f-audio audio')).to_have_count(0)
    expect(app.page.locator('#f-audio button', has_text='Записать голос')).to_be_visible()


def test_recording_stops_after_one_minute(app):
    app.page.clock.install()
    app.seed()
    app.open('#/new')
    start_recording(app)
    expect(app.page.locator('#rec-time')).to_contain_text('/ 1:00')
    app.page.clock.fast_forward(61_000)
    expect(app.toast()).to_have_text('Прошла минута — запись остановлена')
    expect(app.page.locator('#f-audio audio')).to_be_visible()
    expect(app.page.locator('#rec-time')).to_have_count(0)


def test_leaving_form_discards_recording(app):
    app.seed()
    app.open('#/new')
    start_recording(app)
    app.go('#/')
    expect(app.view('list')).to_be_visible()
    app.page.wait_for_timeout(300)
    assert app.words() == {}
