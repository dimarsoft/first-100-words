"""Проверки репозитория для CI (запуск: python .github/check.py [базовый-коммит]).

1. Все файлы из FILES в docs/sw.js существуют, и все файлы из docs/ перечислены в FILES
   (иначе установленное приложение не получит их офлайн).
2. Если с базового коммита менялись файлы в docs/, номер CACHE в sw.js должен измениться
   (иначе установленное приложение не обновится).
3. В репозиторий не попали резервные копии, экспорт и секреты OAuth.
"""
import fnmatch
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs'
FORBIDDEN = ['slova-kopiya-*.json', 'slovar-*.csv', 'client_secret*.json', '*.json.bak']
errors = []


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True, text=True, encoding='utf-8').stdout


def cache_name(sw_text):
    m = re.search(r"const CACHE = '([^']+)'", sw_text)
    return m.group(1) if m else None


sw = (DOCS / 'sw.js').read_text(encoding='utf-8')

# 1. Список офлайн-файлов
m = re.search(r'const FILES = \[(.*?)\];', sw, re.S)
if not m:
    errors.append('docs/sw.js: не найден список FILES')
else:
    listed = {f for f in re.findall(r"'([^']+)'", m.group(1)) if f != './'}
    for f in sorted(listed):
        if not (DOCS / f).is_file():
            errors.append(f'docs/sw.js: в FILES есть «{f}», но такого файла нет в docs/')
    tracked = {p[len('docs/'):] for p in git('ls-files', 'docs').splitlines()}
    for f in sorted(tracked - listed - {'sw.js'}):
        errors.append(f'docs/{f}: файл не добавлен в FILES в docs/sw.js')

if not cache_name(sw):
    errors.append("docs/sw.js: не найдена строка const CACHE = '…'")

# 2. Номер кэша поднят при изменениях в docs/
base = sys.argv[1] if len(sys.argv) > 1 else ''
if base and set(base) != {'0'}:
    changed = [p for p in git('diff', '--name-only', base, 'HEAD', '--', 'docs').splitlines()]
    if changed:
        try:
            old_cache = cache_name(git('show', f'{base}:docs/sw.js'))
        except subprocess.CalledProcessError:
            old_cache = None
        if old_cache and old_cache == cache_name(sw):
            errors.append(f'Изменены файлы в docs/ ({", ".join(changed)}), но CACHE в docs/sw.js остался «{old_cache}» — увеличьте номер версии')

# 3. Запрещённые файлы
for p in git('ls-files').splitlines():
    name = p.rsplit('/', 1)[-1]
    if any(fnmatch.fnmatch(name, pat) for pat in FORBIDDEN):
        errors.append(f'{p}: резервные копии, экспорт и секреты нельзя хранить в публичном репозитории')

if errors:
    for e in errors:
        print('::error::' + e)
    sys.exit(1)
print('Проверки пройдены')
