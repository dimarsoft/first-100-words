# Первые 100 слов

Дневник первых слов малыша — PWA для Android: https://dimarsoft.github.io/first-100-words/

Данные хранятся на телефоне. Резервную копию можно сохранить файлом (через «Поделиться»)
или в свой Google Диск и восстановить на новом телефоне. Своего сервера у приложения нет.

- Приложение: папка `docs/` (обычные HTML/CSS/JS, без сборки).
- Требования: `requirements.md`.
- Политика конфиденциальности: `docs/privacy.html`.
- CI: `.github/workflows/ci.yml` — проверки на каждый push/PR и публикация на GitHub Pages при push в `main`.
- Версия — git-тег `vX.Y.Z`: `git tag v0.4.0 && git push --atomic origin main v0.4.0`.
