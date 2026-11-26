"""Service worker: работа без сети и автообновление (новый sw.js → перезагрузка, но не в форме слова)."""
import time

from playwright.sync_api import expect

from conftest import App, word


def installed_app(make_context, server):
    """Приложение с активным service worker, как установленное на телефоне (вторая загрузка)."""
    ctx = make_context(service_workers='allow')
    app = App(ctx.new_page(), server)
    app.seed([word('w1', 'да', 'да', stress=1)])
    app.open()
    app.page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=10_000)
    # Перезагрузка: при первой установке приложение обновления не ждёт (не было controller).
    app.page.reload()
    app.page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=10_000)
    expect(app.view('list')).to_be_visible()
    return ctx, app


def mark(app):
    app.page.evaluate('window.__mark = 1')


def reloaded(app, timeout=10.0):
    """Ждёт перезагрузку страницы (пропала метка window.__mark)."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            if app.page.evaluate('window.__mark === undefined'):
                return True
        except Exception:  # контекст страницы пересоздаётся во время перезагрузки
            pass
        app.page.wait_for_timeout(200)
    return False


def publish_update(app, server, name):
    server.override_sw_cache(name)
    app.page.evaluate('navigator.serviceWorker.getRegistration().then((r) => r.update())')


def test_works_offline(make_context, server):
    ctx, app = installed_app(make_context, server)
    ctx.set_offline(True)
    app.page.reload()
    expect(app.view('list')).to_be_visible()
    expect(app.list_items()).to_have_count(1)


def test_update_reloads_on_list(make_context, server):
    _, app = installed_app(make_context, server)
    mark(app)
    publish_update(app, server, 'first100-test-2')
    assert reloaded(app), 'страница не перезагрузилась после обновления'
    expect(app.view('list')).to_be_visible()


def test_update_waits_while_form_is_open(make_context, server):
    _, app = installed_app(make_context, server)
    app.go('#/new')
    expect(app.view('form')).to_be_visible()
    app.page.locator('#f-pron').fill('ко')
    mark(app)
    publish_update(app, server, 'first100-test-3')
    assert not reloaded(app, timeout=3), 'страница перезагрузилась посреди ввода слова'
    expect(app.page.locator('#f-pron')).to_have_value('ко')
    app.go('#/')
    assert reloaded(app), 'после ухода из формы обновление не применилось'
