"""Первый запуск, список, форма слова: ударение, значение, даты, черновики, повторы, рубежи."""
from playwright.sync_api import expect

from conftest import word


def fill_word(app, pron, meaning=None):
    page = app.page
    page.locator('#f-pron').fill(pron)
    if meaning is not None:
        page.locator('#f-meaning').fill(meaning)


def test_first_launch(app):
    app.open()
    expect(app.view('onboard')).to_be_visible()
    expect(app.page.locator('#ob-save')).to_be_disabled()
    app.page.locator('#ob-name').fill('Тест')
    app.page.locator('#ob-birth').fill('2025-01-01')
    app.page.locator('#ob-save').click()
    expect(app.view('list')).to_be_visible()
    expect(app.page.locator('#list-title')).to_have_text('Словарь: Тест')
    expect(app.page.locator('#empty')).to_be_visible()
    assert app.db()['meta']['child'] == {'name': 'Тест', 'birth': '2025-01-01'}


def test_one_vowel_stress_is_automatic(app):
    app.seed()
    app.open('#/new')
    fill_word(app, 'да', 'да')
    expect(app.page.locator('#f-stress-hint')).to_contain_text('Одна гласная')
    app.page.locator('#f-save').click()
    expect(app.view('list')).to_be_visible()
    expect(app.list_items()).to_have_count(1)
    expect(app.list_items().first.locator('.item-pron')).to_have_text('дА')
    expect(app.list_items().first.locator('.badge.first')).to_contain_text('первое слово')
    expect(app.page.locator('#count')).to_have_text('1')


def test_several_vowels_need_stress(app):
    app.seed()
    app.open('#/new')
    fill_word(app, 'биби', 'машина')
    expect(app.page.locator('#f-save')).to_be_disabled()
    expect(app.page.locator('#f-why')).to_contain_text('выберите ударную гласную')
    app.page.locator('#f-tiles button.tile').nth(1).click()
    expect(app.page.locator('#f-stress-hint')).to_have_text('Записано: бибИ')
    app.page.locator('#f-save').click()
    expect(app.list_items().first.locator('.item-pron')).to_have_text('бибИ')
    w = next(iter(app.words().values()))
    assert (w['pron'], w['stress'], w['meaning']) == ('биби', 3, 'машина')


def test_capital_vowel_is_taken_as_stress(app):
    app.seed()
    app.open('#/new')
    fill_word(app, 'бИби', 'машина')
    expect(app.page.locator('#f-pron')).to_have_value('биби')
    expect(app.page.locator('#f-stress-hint')).to_have_text('Записано: бИби')
    expect(app.page.locator('#f-save')).to_be_enabled()


def test_date_before_birth_is_rejected(app):
    app.seed()
    app.open('#/new')
    fill_word(app, 'да', 'да')
    app.page.locator('#f-date').fill('2024-12-31')
    app.page.locator('#f-date').dispatch_event('change')
    expect(app.page.locator('#f-save')).to_be_disabled()
    expect(app.page.locator('#f-why')).to_contain_text('дата раньше дня рождения')


def test_meaning_suggestions(app):
    app.seed([word('w1', 'ням', 'кушать', stress=1)])
    app.open('#/new')
    app.page.locator('#f-meaning').fill('куш')
    chip = app.page.locator('#f-sugg .chip', has_text='кушать')
    chip.first.click()
    expect(app.page.locator('#f-meaning')).to_have_value('кушать')


def test_draft_not_counted(app):
    app.seed([word('w1', 'да', 'да', stress=1)])
    app.open('#/new')
    fill_word(app, 'ко')
    expect(app.page.locator('#f-save')).to_be_disabled()
    app.page.locator('#f-draft').click()
    expect(app.page.locator('#drafts')).to_contain_text('Дополнить (1)')
    expect(app.page.locator('#count')).to_have_text('1')
    expect(app.list_items()).to_have_count(1)
    # дополнить черновик → становится словом
    app.page.locator('#drafts li').click()
    expect(app.page.locator('#form-title')).to_have_text('Дополнить слово')
    app.page.locator('#f-meaning').fill('кошка')
    app.page.locator('#f-save').click()
    expect(app.page.locator('#count')).to_have_text('2')
    expect(app.page.locator('#drafts')).to_be_empty()


def test_same_word_twice(app):
    app.seed([word('w1', 'да', 'да', stress=1)])
    app.open('#/new')
    fill_word(app, 'да', 'да')
    app.page.locator('#f-save').click()
    expect(app.modal_text()).to_contain_text('Такое слово уже есть')
    app.answer('Открыть его')
    expect(app.view('card')).to_be_visible()
    assert len(app.words()) == 1


def test_new_pronunciation_goes_to_history(app):
    app.seed([word('w1', 'би', 'машина', stress=1, audio=300)])
    app.open('#/new')
    fill_word(app, 'бибика', 'Машина')
    app.page.locator('#f-tiles button.tile').nth(1).click()
    app.page.locator('#f-save').click()
    expect(app.modal_text()).to_contain_text('Малыш стал говорить его по-новому')
    app.answer('Да, обновить произношение')
    expect(app.view('card')).to_be_visible()
    expect(app.page.locator('.card-pron')).to_have_text('бибИка')
    expect(app.page.locator('.history')).to_contain_text('бИ')
    words = app.words()
    assert list(words) == ['w1']
    w = words['w1']
    assert w['pron'] == 'бибика' and w['history'][0]['pron'] == 'би' and w['history'][0]['audio'] == 300


def test_same_pron_other_meaning_is_new_word(app):
    app.seed([word('w1', 'ко', 'кошка', stress=1)])
    app.open('#/new')
    fill_word(app, 'ко', 'корова')
    app.page.locator('#f-save').click()
    expect(app.view('list')).to_be_visible()
    expect(app.list_items()).to_have_count(2)


def test_milestone_celebrated_once(app):
    app.seed([word(f'w{i}', 'да', f'слово{i}', stress=1, created=i) for i in range(9)])
    app.open('#/new')
    fill_word(app, 'ко', 'кошка')
    app.page.locator('#f-save').click()
    expect(app.page.locator('#celebrate')).to_be_visible()
    expect(app.page.locator('#cel-num')).to_have_text('10')
    app.page.locator('#cel-ok').click()
    assert app.db()['meta']['celebrated'] == [10]
    # следующее слово — без повторного поздравления
    app.go('#/new')
    fill_word(app, 'му', 'корова')
    app.page.locator('#f-save').click()
    expect(app.page.locator('#count')).to_have_text('11')
    expect(app.page.locator('#celebrate')).to_be_hidden()


def test_numbering_and_search(app):
    app.seed([
        word('a', 'ма', 'мама', date='2026-03-01', stress=1),
        word('b', 'па', 'папа', date='2026-04-01', stress=1, self=False),
        word('c', 'ко', 'кошка', date='2026-02-01', stress=1, draft=True),
    ])
    app.open()
    items = app.list_items()
    expect(items).to_have_count(2)
    # новые сверху, номер — по дате появления, черновик не считается
    expect(items.nth(0).locator('.item-num')).to_have_text('2')
    expect(items.nth(0)).to_contain_text('за взрослым')
    expect(items.nth(1).locator('.item-num')).to_have_text('1')
    expect(app.page.locator('#count-sub')).to_have_text('сам(а): 1 · за взрослым: 1')
    app.page.locator('#search').fill('мам')
    expect(items).to_have_count(1)
    expect(items.first).to_contain_text('мама')


def test_stats(app):
    app.seed([word(f'w{i}', 'да', f'слово{i}', date=f'2026-0{1 + i % 3}-10', stress=1, created=i) for i in range(12)])
    app.open('#/stats')
    stats = app.page.locator('#stats')
    expect(stats).to_contain_text('слов из 100')
    expect(stats.locator('.ms li').first).not_to_have_class('no')  # 10 слов — рубеж пройден
    expect(stats.locator('.ms li').nth(1)).to_have_class('no')    # 30 — впереди
    expect(stats.locator('.month').first).to_contain_text('Янв 2026')
