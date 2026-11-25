'use strict';

/* ================= Константы ================= */
const VOWELS = 'аеёиоуыэюя';
const MILESTONES = [10, 30, 50, 80, 100];
const GOAL = 100;
const MAX_AUDIO_SEC = 60;
const BACKUP_REMIND_DAYS = 14;
const SCHEMA = 1; // версия формата записи слова
const MONTHS_SHORT = ['янв', 'февр', 'мар', 'апр', 'мая', 'июня', 'июля', 'авг', 'сент', 'окт', 'нояб', 'дек'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/* ================= База (IndexedDB) ================= */
// При добавлении новых полей: увеличить DB_VERSION и дописать шаг миграции в onupgradeneeded.
const DB_NAME = 'first100';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('words', { keyPath: 'id' });
        d.createObjectStore('meta');
      }
      // if (e.oldVersion < 2) { ...миграция для версии 2... }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function dbReq(store, mode, op) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = op(t.objectStore(store));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
const dbAllWords = () => dbReq('words', 'readonly', (s) => s.getAll());
const dbPutWord = (w) => dbReq('words', 'readwrite', (s) => s.put(w));
const dbDelWord = (id) => dbReq('words', 'readwrite', (s) => s.delete(id));
const dbGetMeta = (k) => dbReq('meta', 'readonly', (s) => s.get(k));
const dbSetMeta = (k, v) => dbReq('meta', 'readwrite', (s) => s.put(v, k));

/* ================= Состояние ================= */
const state = {
  words: [],
  child: null,          // { name, birth: 'YYYY-MM-DD' }
  celebrated: [],       // достигнутые рубежи, уже поздравленные
  lastBackupAt: 0,
  lastChangeAt: 0,
};

/* ================= Даты ================= */
function todayStr() { return dateToStr(new Date()); }
function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function strToDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return dateToStr(d); }
function fmtShort(s) { // «12 нояб», год — только если не текущий
  const d = strToDate(s);
  const y = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${y}`;
}
function fmtLong(s) { const d = strToDate(s); return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`; }
function ageAt(s) {
  if (!state.child || !state.child.birth) return '';
  const b = strToDate(state.child.birth), d = strToDate(s);
  let months = (d.getFullYear() - b.getFullYear()) * 12 + (d.getMonth() - b.getMonth());
  if (d.getDate() < b.getDate()) months--;
  if (months < 0) return '';
  const y = Math.floor(months / 12), m = months % 12;
  if (y === 0) return `${m} мес`;
  return m ? `${y} г ${m} мес` : `${y} г`;
}
function ageAtDetailed(s) {
  if (!state.child || !state.child.birth) return '';
  const b = strToDate(state.child.birth), d = strToDate(s);
  if (d < b) return '';

  const anniversary = (months) => {
    const year = b.getFullYear(), month = b.getMonth() + months;
    const lastDay = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(b.getDate(), lastDay));
  };
  let totalMonths = (d.getFullYear() - b.getFullYear()) * 12 + d.getMonth() - b.getMonth();
  if (anniversary(totalMonths) > d) totalMonths--;
  const completed = anniversary(totalMonths);
  const years = Math.floor(totalMonths / 12), months = totalMonths % 12;
  const utcDay = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = (utcDay(d) - utcDay(completed)) / 86400000;
  const unit = (n, one, few, many) => {
    if (n % 100 >= 11 && n % 100 <= 14) return many;
    return n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
  };
  return `${years} ${unit(years, 'год', 'года', 'лет')}, ` +
    `${months} ${unit(months, 'месяц', 'месяца', 'месяцев')}, ` +
    `${days} ${unit(days, 'день', 'дня', 'дней')}`;
}

/* ================= Слова и ударение ================= */
const isVowel = (ch) => VOWELS.includes(ch);
function vowelIdx(pron) { const r = []; for (let i = 0; i < pron.length; i++) if (isVowel(pron[i])) r.push(i); return r; }
function display(pron, stress) {
  if (stress == null || stress < 0 || stress >= pron.length) return pron;
  return pron.slice(0, stress) + pron[stress].toUpperCase() + pron.slice(stress + 1);
}
const norm = (s) => s.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
const showWord = (w) => display(w.pron, w.stress);

function sortedWords() { // готовые слова по дате появления (старые → новые)
  return state.words.filter((w) => !w.draft)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
}
const countWords = () => state.words.filter((w) => !w.draft).length;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ================= Общий UI ================= */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
// Диалог: buttons = [{ text, cls, value }]; возвращает value нажатой кнопки
function ask(textOrNode, buttons) {
  return new Promise((resolve) => {
    const m = $('modal'), txt = $('modal-text'), box = $('modal-btns');
    txt.replaceChildren(typeof textOrNode === 'string' ? el('div', null, textOrNode) : textOrNode);
    box.replaceChildren();
    for (const b of buttons) {
      const btn = el('button', `btn ${b.cls || ''}`, b.text);
      btn.onclick = () => { m.hidden = true; resolve(b.value); };
      box.append(btn);
    }
    m.hidden = false;
  });
}

function celebrate(n) {
  const name = state.child && state.child.name ? state.child.name : 'Малыш';
  $('cel-num').textContent = n;
  $('cel-text').textContent = n >= GOAL
    ? `${name} сказал(а) 100 слов! Цель достигнута 🎉`
    : `${n} слов! ${name} — молодец 🎉`;
  const c = $('confetti'); c.replaceChildren();
  const colors = ['#e8735a', '#f0c56a', '#4a9d6e', '#6a8be8', '#d46ab8'];
  for (let i = 0; i < 70; i++) {
    const p = el('i');
    p.style.left = Math.random() * 100 + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = 1.8 + Math.random() * 2 + 's';
    p.style.animationDelay = Math.random() * .8 + 's';
    c.append(p);
  }
  $('celebrate').hidden = false;
}
$('cel-ok').onclick = () => { $('celebrate').hidden = true; };

async function checkMilestones() {
  const n = countWords();
  const fresh = MILESTONES.filter((m) => m <= n && !state.celebrated.includes(m));
  if (!fresh.length) return;
  state.celebrated.push(...fresh);
  await dbSetMeta('celebrated', state.celebrated);
  celebrate(Math.max(...fresh));
}

async function touchChange() { state.lastChangeAt = Date.now(); await dbSetMeta('lastChangeAt', state.lastChangeAt); }

/* ================= Маршрутизация ================= */
// Хэш-маршруты, чтобы работала кнопка «Назад» на Android.
const VIEWS = ['onboard', 'list', 'form', 'card', 'stats', 'settings'];
function showView(name) {
  for (const v of VIEWS) $('view-' + v).hidden = v !== name;
  const navOn = ['list', 'stats', 'settings'].includes(name);
  $('nav').hidden = !navOn;
  document.body.classList.toggle('no-nav', !navOn);
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
  window.scrollTo(0, 0);
}
function route() {
  stopRecording(true);
  stopDictation();
  if (!state.child) return showView('onboard'), renderOnboard();
  const h = location.hash.replace(/^#\/?/, '');
  const [p, id] = h.split('/');
  if (p === 'new') return openForm(null);
  if (p === 'edit') return openForm(id);
  if (p === 'word') return openCard(id);
  if (p === 'stats') return showView('stats'), renderStats();
  if (p === 'settings') return showView('settings'), renderSettings();
  showView('list'); renderList();
}
window.addEventListener('hashchange', route);
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = go.dataset.go; return; }
  if (e.target.closest('[data-back]')) goBack();
});
function goBack() { if (history.length > 1) history.back(); else location.hash = '#/'; }

/* ================= Первый запуск ================= */
function renderOnboard() {
  const birth = $('ob-birth');
  birth.max = todayStr();
  const check = () => { $('ob-save').disabled = !birth.value || birth.value > todayStr(); };
  birth.oninput = check; check();
  $('ob-save').onclick = async () => {
    if (!birth.value || birth.value > todayStr()) return;
    state.child = { name: $('ob-name').value.trim(), birth: birth.value };
    await dbSetMeta('child', state.child);
    requestPersist();
    location.hash = '#/'; route();
  };
}

/* ================= Список ================= */
function renderList() {
  const n = countWords();
  const name = state.child.name;
  $('list-title').textContent = name ? `Словарь: ${name}` : 'Словарь малыша';
  $('count').textContent = n;
  $('bar-fill').style.width = Math.min(100, n / GOAL * 100) + '%';
  const done = sortedWords();
  const self = done.filter((w) => w.self).length;
  $('count-sub').textContent = n ? `сам(а): ${self} · за взрослым: ${n - self}` : '';
  $('backup-banner').hidden = !needBackupReminder();

  const q = norm($('search').value || '');
  const match = (w) => !q || norm(w.pron).includes(q) || norm(w.meaning || '').includes(q);

  // черновики
  const drafts = state.words.filter((w) => w.draft && match(w)).sort((a, b) => b.createdAt - a.createdAt);
  const dWrap = $('drafts'); dWrap.replaceChildren();
  if (drafts.length) {
    dWrap.append(el('div', 'drafts-title', `⚠ Дополнить (${drafts.length})`));
    const ol = el('ol', 'list');
    for (const w of drafts) {
      const li = el('li', 'item draft');
      const main = el('div', 'item-main');
      main.append(el('div', 'item-pron', showWord(w)), el('div', 'item-meaning', w.meaning ? '→ ' + w.meaning : 'нужно значение и ударение'));
      li.append(main, el('div', 'item-side', fmtShort(w.date)));
      li.onclick = () => { location.hash = '#/edit/' + w.id; };
      ol.append(li);
    }
    dWrap.append(ol);
  }

  // слова: новые сверху, номер — порядковый по дате появления
  const list = $('list'); list.replaceChildren();
  const numbered = done.map((w, i) => ({ w, num: i + 1 })).reverse().filter(({ w }) => match(w));
  for (const { w, num } of numbered) {
    const li = el('li', 'item');
    const main = el('div', 'item-main');
    main.append(el('div', 'item-pron', showWord(w)));
    const mean = el('div', 'item-meaning', '→ ' + w.meaning);
    main.append(mean);
    const side = el('div', 'item-side');
    side.append(el('div', null, fmtShort(w.date)));
    const icons = [];
    if (w.audio) icons.push('🔊');
    if (w.story) icons.push('📝');
    if (icons.length) side.append(el('div', 'item-icons', icons.join(' ')));
    if (num === 1) {
      const age = ageAt(w.date);
      main.append(el('span', 'badge first', age ? `первое слово · в ${age}` : 'первое слово'));
    }
    if (!w.self) main.append(el('span', 'badge', 'за взрослым'));
    li.append(el('div', 'item-num', num), main, side);
    li.onclick = () => { location.hash = '#/word/' + w.id; };
    list.append(li);
  }
  $('empty').hidden = state.words.length > 0;
}
$('search').addEventListener('input', renderList);

/* ================= Форма ================= */
let form = null; // { id, isNew, pron, stress, meaning, date, self, story, audio, audioType, draft }

function openForm(id) {
  showView('form');
  const w = id ? state.words.find((x) => x.id === id) : null;
  if (id && !w) { location.hash = '#/'; return; }
  form = w
    ? { id: w.id, isNew: false, wasDraft: !!w.draft, pron: w.pron, stress: w.stress, meaning: w.meaning || '', date: w.date, self: w.self !== false, story: w.story || '', audio: w.audio || null, audioType: w.audioType || '' }
    : { id: uid(), isNew: true, wasDraft: false, pron: '', stress: null, meaning: '', date: todayStr(), self: true, story: '', audio: null, audioType: '' };
  $('form-title').textContent = !w ? 'Новое слово' : (w.draft ? 'Дополнить слово' : 'Изменить слово');
  $('f-pron').value = form.pron; // в поле — без заглавных, ударение видно на плитках
  $('f-meaning').value = form.meaning;
  $('f-story').value = form.story;
  $('f-date').max = todayStr();
  if (state.child && state.child.birth) $('f-date').min = state.child.birth;
  $('f-draft').hidden = !(form.isNew || form.wasDraft);
  renderTiles(); renderSugg(); renderDate(); renderSelf(); renderAudio(); validate();
  $('f-dictate').hidden = !SpeechRec;
  if (form.isNew) setTimeout(() => $('f-pron').focus(), 60);
}

// --- произношение и ударение
$('f-pron').addEventListener('input', (e) => {
  const raw = e.target.value;
  // Если мама по привычке набрала ударную гласную заглавной — берём её как ударение.
  const upper = [];
  for (let i = 0; i < raw.length; i++) if (isVowel(raw[i].toLowerCase()) && raw[i] !== raw[i].toLowerCase()) upper.push(i);
  const lower = raw.toLowerCase();
  const allUpper = raw.length > 1 && raw === raw.toUpperCase();
  if (lower !== form.pron) form.stress = null;
  form.pron = lower;
  if (upper.length === 1 && !allUpper) form.stress = upper[0];
  if (raw !== lower) {
    const pos = e.target.selectionStart;
    e.target.value = lower;
    e.target.setSelectionRange(pos, pos);
  }
  renderTiles(); validate();
});

function renderTiles() {
  const box = $('f-tiles'); box.replaceChildren();
  const pron = form.pron;
  const vi = vowelIdx(pron);
  if (vi.length === 1) form.stress = vi[0];
  if (form.stress != null && !isVowel(pron[form.stress] || '')) form.stress = null;
  for (let i = 0; i < pron.length; i++) {
    const ch = pron[i];
    if (isVowel(ch) && vi.length > 1) {
      const b = el('button', 'tile' + (form.stress === i ? ' on' : ''), form.stress === i ? ch.toUpperCase() : ch);
      b.type = 'button';
      b.onpointerdown = (e) => e.preventDefault(); // фокус остаётся в поле — клавиатура не закрывается
      b.onclick = () => { form.stress = i; renderTiles(); validate(); };
      box.append(b);
    } else {
      const isS = form.stress === i;
      const s = el('span', 'tile', isS ? ch.toUpperCase() : (ch === ' ' ? ' ' : ch));
      if (isS) s.style.color = 'var(--accent)', s.style.fontWeight = '800';
      box.append(s);
    }
  }
  const hint = $('f-stress-hint');
  if (!pron) hint.textContent = '';
  else if (!vi.length) hint.textContent = 'В слове нет гласных — ударение не нужно.';
  else if (vi.length === 1) hint.textContent = 'Одна гласная — ударение поставлено автоматически.';
  else if (form.stress == null) hint.textContent = '👆 Нажмите гласную, на которую малыш ставит ударение.';
  else hint.textContent = `Записано: ${display(pron, form.stress)}`;
  hint.classList.toggle('warn', vi.length > 1 && form.stress == null);
}

// --- значение и подсказки
function allMeanings() {
  const used = state.words.map((w) => w.meaning).filter(Boolean);
  return [...new Set([...used, ...window.COMMON_MEANINGS])];
}
function renderSugg() {
  const box = $('f-sugg'); box.replaceChildren();
  const q = norm(form.meaning);
  const list = allMeanings();
  const picks = q
    ? list.filter((m) => norm(m).startsWith(q) && norm(m) !== q).concat(list.filter((m) => !norm(m).startsWith(q) && norm(m).includes(q)))
    : list;
  for (const m of picks.slice(0, 8)) {
    const c = el('button', 'chip', m); c.type = 'button';
    c.onclick = () => { form.meaning = m; $('f-meaning').value = m; renderSugg(); validate(); };
    box.append(c);
  }
}
$('f-meaning').addEventListener('input', (e) => { form.meaning = e.target.value; renderSugg(); validate(); });

// Клавиша «Далее»/«Готово» на клавиатуре телефона
$('f-pron').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('f-meaning').focus(); }
});
$('f-meaning').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (!$('f-save').disabled) saveWord(false); else e.target.blur();
});

// --- дата
function renderDate() {
  $('f-date').value = form.date;
  $('f-today').classList.toggle('on', form.date === todayStr());
  $('f-yesterday').classList.toggle('on', form.date === yesterdayStr());
}
$('f-today').onclick = () => { form.date = todayStr(); renderDate(); validate(); };
$('f-yesterday').onclick = () => { form.date = yesterdayStr(); renderDate(); validate(); };
$('f-date').addEventListener('change', (e) => { form.date = e.target.value; renderDate(); validate(); });

// --- сам / за взрослым
function renderSelf() {
  $('f-self-yes').classList.toggle('on', form.self);
  $('f-self-no').classList.toggle('on', !form.self);
}
$('f-self-yes').onclick = () => { form.self = true; renderSelf(); };
$('f-self-no').onclick = () => { form.self = false; renderSelf(); };

// --- «Как появилось слово?» + диктовка
$('f-story').addEventListener('input', (e) => { form.story = e.target.value; });
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function stopDictation() { if (rec) { try { rec.stop(); } catch (_) {} rec = null; $('f-dictate').classList.remove('on'); } }
$('f-dictate').onclick = () => {
  if (rec) return stopDictation();
  rec = new SpeechRec();
  rec.lang = 'ru-RU'; rec.interimResults = false; rec.continuous = true;
  rec.onresult = (e) => {
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript;
    if (!text) return;
    const cur = $('f-story').value.trim();
    const add = text.trim();
    $('f-story').value = cur ? cur + ' ' + add : add.charAt(0).toUpperCase() + add.slice(1);
    form.story = $('f-story').value;
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed') toast('Нет доступа к микрофону'); stopDictation(); };
  rec.onend = () => { rec = null; $('f-dictate').classList.remove('on'); };
  rec.start();
  $('f-dictate').classList.add('on');
  toast('Говорите… Нажмите 🎤 ещё раз, чтобы закончить');
};

// --- аудио
let recorder = null, recTimer = null, recStart = 0, recStream = null, audioUrl = null;
function pickMime() {
  if (!window.MediaRecorder) return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}
function fmtSec(s) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function renderAudio() {
  const box = $('f-audio'); box.replaceChildren();
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  if (recorder) {
    const r = el('div', 'rec');
    const time = el('div', 'rec-time', `0:00 / ${fmtSec(MAX_AUDIO_SEC)}`); time.id = 'rec-time';
    const stop = el('button', 'btn primary', '■ Стоп'); stop.type = 'button';
    stop.onclick = () => stopRecording(false);
    r.append(el('div', 'rec-dot'), time, stop);
    box.append(r);
    return;
  }
  if (form.audio) {
    audioUrl = URL.createObjectURL(form.audio);
    const a = el('audio'); a.controls = true; a.src = audioUrl;
    const row = el('div', 'row');
    const again = el('button', 'btn', '🎙 Перезаписать'); again.type = 'button'; again.onclick = startRecording;
    const del = el('button', 'btn danger', 'Удалить'); del.type = 'button';
    del.onclick = async () => {
      const v = await ask('Удалить запись голоса?', [{ text: 'Удалить', cls: 'danger', value: true }, { text: 'Отмена', value: false }]);
      if (v) { form.audio = null; form.audioType = ''; renderAudio(); }
    };
    row.append(again, del);
    box.append(a, row);
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    box.append(el('div', 'hint', 'Запись голоса недоступна в этом браузере.'));
    return;
  }
  const b = el('button', 'btn', '🎙 Записать голос'); b.type = 'button'; b.style.marginTop = '0';
  b.onclick = startRecording;
  box.append(b);
}
async function startRecording() {
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) { toast('Нет доступа к микрофону'); return; }
  const mime = pickMime();
  const chunks = [];
  recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recorder._done = new Promise((res) => { recorder._resolve = res; });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const keep = !recorder._discard;
    const resolve = recorder._resolve;
    const type = recorder.mimeType || mime || 'audio/webm';
    recStream.getTracks().forEach((t) => t.stop());
    recorder = null; recStream = null;
    clearInterval(recTimer);
    if (keep && chunks.length && form) { form.audio = new Blob(chunks, { type }); form.audioType = type; }
    if (form && !$('view-form').hidden) renderAudio();
    resolve();
  };
  recorder.start();
  recStart = Date.now();
  renderAudio();
  recTimer = setInterval(() => {
    const s = (Date.now() - recStart) / 1000;
    const t = $('rec-time'); if (t) t.textContent = `${fmtSec(s)} / ${fmtSec(MAX_AUDIO_SEC)}`;
    if (s >= MAX_AUDIO_SEC) { stopRecording(false); toast('Прошла минута — запись остановлена'); }
  }, 250);
}
function stopRecording(discard) {
  if (!recorder) return Promise.resolve();
  recorder._discard = discard;
  const done = recorder._done;
  if (recorder.state !== 'inactive') recorder.stop();
  return done;
}

// --- проверка и сохранение
function problems(asDraft) {
  const p = [];
  if (!form.pron.trim()) p.push('напишите, как малыш сказал');
  if (asDraft) return p;
  const vi = vowelIdx(form.pron);
  if (form.pron.trim() && vi.length > 1 && form.stress == null) p.push('выберите ударную гласную');
  if (!form.meaning.trim()) p.push('укажите значение');
  if (!form.date) p.push('укажите дату');
  else if (form.date > todayStr()) p.push('дата не может быть в будущем');
  else if (state.child.birth && form.date < state.child.birth) p.push('дата раньше дня рождения');
  return p;
}
function validate() {
  const p = problems(false);
  $('f-save').disabled = p.length > 0;
  $('f-why').textContent = p.length && form.pron ? 'Чтобы сохранить: ' + p.join(', ') + '.' : '';
  $('f-draft').disabled = problems(true).length > 0;
}

function buildWord(asDraft) {
  const old = state.words.find((w) => w.id === form.id);
  const now = Date.now();
  return {
    schema: SCHEMA,
    history: [],
    createdAt: now,
    ...(old || {}),
    id: form.id,
    pron: form.pron.trim(),
    stress: form.stress,
    meaning: form.meaning.trim(),
    date: form.date && form.date <= todayStr() ? form.date : todayStr(),
    self: form.self,
    story: form.story.trim(),
    audio: form.audio || null,
    audioType: form.audio ? form.audioType : '',
    draft: asDraft,
    updatedAt: now,
  };
}

async function saveWord(asDraft) {
  await stopRecording(false); // если запись ещё идёт — сохранить то, что записано
  if (problems(asDraft).length) return;
  const w = buildWord(asDraft);

  if (!asDraft && (form.isNew || form.wasDraft)) {
    const others = state.words.filter((x) => x.id !== w.id && !x.draft);
    const same = others.find((x) => norm(x.meaning) === norm(w.meaning) && x.pron === w.pron);
    if (same) {
      const v = await ask(`Такое слово уже есть: «${showWord(same)}» → ${same.meaning} (${fmtShort(same.date)}).`,
        [{ text: 'Открыть его', cls: 'primary', value: 'open' }, { text: 'Отмена', value: 'cancel' }]);
      if (v === 'open') location.replace('#/word/' + same.id);
      return;
    }
    const sameMeaning = others.find((x) => norm(x.meaning) === norm(w.meaning));
    if (sameMeaning) {
      const v = await ask(`Слово «${sameMeaning.meaning}» уже записано как «${showWord(sameMeaning)}». Малыш стал говорить его по-новому — «${showWord(w)}»?`, [
        { text: 'Да, обновить произношение', cls: 'primary', value: 'update' },
        { text: 'Нет, это другое слово', value: 'new' },
        { text: 'Отмена', cls: 'ghost', value: 'cancel' },
      ]);
      if (v === 'cancel') return;
      if (v === 'update') {
        sameMeaning.history = sameMeaning.history || [];
        sameMeaning.history.push({ pron: sameMeaning.pron, stress: sameMeaning.stress, until: w.date, audio: sameMeaning.audio || null, audioType: sameMeaning.audioType || '' });
        sameMeaning.pron = w.pron; sameMeaning.stress = w.stress;
        if (w.audio) { sameMeaning.audio = w.audio; sameMeaning.audioType = w.audioType; }
        if (w.story) sameMeaning.story = sameMeaning.story ? `${sameMeaning.story}\n\n${fmtShort(w.date)}: ${w.story}` : w.story;
        sameMeaning.updatedAt = Date.now();
        await dbPutWord(sameMeaning);
        if (form.wasDraft) { await dbDelWord(w.id); state.words = state.words.filter((x) => x.id !== w.id); }
        await touchChange();
        toast('Произношение обновлено, старое — в истории');
        location.replace('#/word/' + sameMeaning.id);
        return;
      }
    }
  }

  await dbPutWord(w);
  const i = state.words.findIndex((x) => x.id === w.id);
  if (i >= 0) state.words[i] = w; else state.words.push(w);
  await touchChange();
  toast(asDraft ? 'Сохранено в черновики' : `Сохранено: ${showWord(w)}`);
  form = null;
  location.replace('#/');
  if (!asDraft) await checkMilestones();
}
$('f-save').onclick = () => saveWord(false);
$('f-draft').onclick = () => saveWord(true);

/* ================= Карточка ================= */
function openCard(id) {
  const w = state.words.find((x) => x.id === id);
  if (!w) { location.hash = '#/'; return; }
  showView('card');
  const box = $('card'); box.replaceChildren();
  const num = sortedWords().findIndex((x) => x.id === id) + 1;
  box.append(el('div', 'card-pron', showWord(w)), el('div', 'card-meaning', '→ ' + w.meaning));

  const kv = el('div', 'kv');
  const add = (k, v) => { const r = el('div'); r.append(el('span', 'k', k), el('span', null, v)); kv.append(r); };
  if (num) add('Номер в словаре', String(num));
  add('Появилось', fmtLong(w.date));
  const age = ageAtDetailed(w.date); if (age) add('Возраст', age);
  add('Сказал(а)', w.self ? 'сам(а)' : 'повторил(а) за взрослым');
  box.append(kv);

  if (w.audio) {
    const a = el('audio'); a.controls = true; a.src = URL.createObjectURL(w.audio); a.style.width = '100%'; a.style.marginTop = '12px';
    box.append(a);
  }
  if (w.story) {
    box.append(el('h3', null, 'Как появилось слово'));
    box.append(el('div', 'story', w.story));
  }
  if (w.history && w.history.length) {
    box.append(el('h3', null, 'Раньше говорил(а)'));
    const ul = el('ul', 'history');
    for (const h of w.history) {
      const li = el('li', null, `${display(h.pron, h.stress)} — до ${fmtShort(h.until)}`);
      if (h.audio) {
        const a = el('audio'); a.controls = true; a.src = URL.createObjectURL(h.audio); a.style.width = '100%';
        li.append(a);
      }
      ul.append(li);
    }
    box.append(ul);
  }
  const edit = el('button', 'btn primary', 'Изменить'); edit.style.marginTop = '20px';
  edit.onclick = () => { location.hash = '#/edit/' + w.id; };
  const del = el('button', 'btn danger', 'Удалить слово');
  del.onclick = async () => {
    const v = await ask(`Удалить «${showWord(w)}» → ${w.meaning}? Это нельзя отменить.`,
      [{ text: 'Удалить', cls: 'danger', value: true }, { text: 'Отмена', value: false }]);
    if (!v) return;
    await dbDelWord(w.id);
    state.words = state.words.filter((x) => x.id !== w.id);
    await touchChange();
    toast('Слово удалено');
    location.replace('#/');
  };
  box.append(edit, del);
}

/* ================= Статистика ================= */
function renderStats() {
  const box = $('stats'); box.replaceChildren();
  const ws = sortedWords();
  if (!ws.length) { box.append(el('p', 'muted', 'Статистика появится после первого слова.')); return; }
  const self = ws.filter((w) => w.self).length;
  const grid = el('div', 'stat-grid');
  const stat = (v, t) => { const s = el('div', 'stat'); s.append(el('b', null, v), el('span', null, t)); grid.append(s); };
  stat(`${ws.length}`, 'слов из 100');
  stat(`${self} / ${ws.length - self}`, 'сам(а) / за взрослым');
  const first = ws[0];
  stat(showWord(first), `первое слово, ${fmtShort(first.date)}`);
  stat(ageAt(first.date) || '—', 'возраст первого слова');
  box.append(grid);

  box.append(el('h3', null, 'Рубежи'));
  const ms = el('ul', 'ms');
  for (const m of MILESTONES) {
    const w = ws[m - 1];
    const li = el('li', w ? '' : 'no');
    li.append(el('span', null, `${m} слов`));
    li.append(el('span', null, w ? `${fmtShort(w.date)}${ageAt(w.date) ? ' · ' + ageAt(w.date) : ''}` : 'впереди'));
    ms.append(li);
  }
  box.append(ms);

  box.append(el('h3', null, 'Новые слова по месяцам'));
  const byMonth = new Map();
  for (const w of ws) { const k = w.date.slice(0, 7); byMonth.set(k, (byMonth.get(k) || 0) + 1); }
  // все месяцы от первого слова до текущего, включая «пустые»
  const start = strToDate(first.date.slice(0, 7) + '-01'), end = new Date();
  const max = Math.max(...byMonth.values());
  for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) {
    const k = dateToStr(d).slice(0, 7), n = byMonth.get(k) || 0;
    const row = el('div', 'month');
    row.append(el('span', null, `${MONTHS_NOM[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`));
    const bar = el('div', 'month-bar'); bar.style.width = (n / max * 100) + '%'; if (!n) bar.style.opacity = '.2';
    row.append(bar, el('b', null, n));
    box.append(row);
  }
}

/* ================= Настройки, копии, экспорт ================= */
function renderSettings() {
  $('s-name').value = state.child.name || '';
  $('s-birth').value = state.child.birth || '';
  $('s-birth').max = todayStr();
  $('s-backup-info').textContent = state.lastBackupAt
    ? `Последняя копия: ${fmtLong(dateToStr(new Date(state.lastBackupAt)))}.`
    : 'Копий ещё не было. Сохраните копию в Telegram, Google Диск или почту — на случай смены или потери телефона.';
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => {
      $('s-storage').textContent = p ? 'Данные защищены от автоочистки браузером.' : 'Браузер может очистить данные при нехватке места — делайте резервные копии.';
    });
  }
  renderAppVersion();
}

async function renderAppVersion() {
  const target = $('s-version');
  target.textContent = 'Загрузка информации о версии…';
  try {
    const response = await fetch('git-info.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Git metadata unavailable');
    const info = await response.json();
    if (!info.version || !info.commit || !info.date) throw new Error('Incomplete Git metadata');
    target.textContent = `Версия ${info.version} · коммит ${info.commit} · ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(info.date))}`;
  } catch (_) {
    target.textContent = 'Версия недоступна';
  }
}
$('s-save-child').onclick = async () => {
  const b = $('s-birth').value;
  if (!b || b > todayStr()) { toast('Проверьте дату рождения'); return; }
  state.child = { name: $('s-name').value.trim(), birth: b };
  await dbSetMeta('child', state.child);
  toast('Сохранено');
};

function needBackupReminder() {
  if (!countWords() || state.lastChangeAt <= state.lastBackupAt) return false;
  const since = state.lastBackupAt || Math.min(...state.words.map((w) => w.createdAt));
  return Date.now() - since > BACKUP_REMIND_DAYS * 864e5;
}

const blobToDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const dataUrlToBlob = async (u) => (await fetch(u)).blob();

async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return true;
}

$('s-backup').onclick = async () => {
  const words = [];
  for (const w of state.words) {
    const c = { ...w, audio: w.audio ? await blobToDataUrl(w.audio) : null };
    c.history = await Promise.all((w.history || []).map(async (h) => ({ ...h, audio: h.audio ? await blobToDataUrl(h.audio) : null })));
    words.push(c);
  }
  const data = { app: 'first100', format: 1, exportedAt: new Date().toISOString(), child: state.child, celebrated: state.celebrated, words };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const ok = await shareOrDownload(blob, `slova-kopiya-${todayStr()}.json`, 'Первые 100 слов — резервная копия');
  if (ok) {
    state.lastBackupAt = Date.now();
    await dbSetMeta('lastBackupAt', state.lastBackupAt);
    renderSettings();
    toast('Копия сохранена');
  }
};

$('s-restore').onclick = () => $('s-restore-file').click();
$('s-restore-file').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (_) { toast('Не удалось прочитать файл'); return; }
  if (data.app !== 'first100' || !Array.isArray(data.words)) { toast('Это не резервная копия «Первых 100 слов»'); return; }
  const v = await ask(`В копии ${data.words.filter((w) => !w.draft).length} слов от ${fmtLong(data.exportedAt.slice(0, 10))}. Заменить ими текущие данные (${countWords()} слов)?`,
    [{ text: 'Заменить', cls: 'primary', value: true }, { text: 'Отмена', value: false }]);
  if (!v) return;
  const words = [];
  for (const w of data.words) {
    const c = { ...w, audio: w.audio ? await dataUrlToBlob(w.audio) : null };
    c.history = await Promise.all((w.history || []).map(async (h) => ({ ...h, audio: h.audio ? await dataUrlToBlob(h.audio) : null })));
    words.push(c);
  }
  await dbReq('words', 'readwrite', (s) => s.clear());
  for (const w of words) await dbPutWord(w);
  state.words = words;
  if (data.child) { state.child = data.child; await dbSetMeta('child', state.child); }
  state.celebrated = Array.isArray(data.celebrated) ? data.celebrated : [];
  await dbSetMeta('celebrated', state.celebrated);
  state.lastBackupAt = Date.now(); await dbSetMeta('lastBackupAt', state.lastBackupAt);
  toast('Данные восстановлены');
  renderSettings();
};

function exportRows() {
  return sortedWords().map((w, i) => [
    i + 1, showWord(w), w.meaning, fmtLong(w.date), ageAt(w.date), w.self ? 'сам(а)' : 'за взрослым',
    (w.history || []).map((h) => display(h.pron, h.stress)).join(', '), w.story || '',
  ]);
}
const EXPORT_HEAD = ['№', 'Как говорит', 'Значение', 'Дата появления', 'Возраст', 'Сам / за взрослым', 'Раньше говорил(а)', 'Как появилось слово?'];

$('s-csv').onclick = () => {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [EXPORT_HEAD, ...exportRows()].map((r) => r.map(q).join(';'));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
  shareOrDownload(blob, `slovar-${todayStr()}.csv`, 'Словарь ребёнка');
};

$('s-print').onclick = () => {
  const p = $('print'); p.replaceChildren();
  const name = state.child.name;
  p.append(el('h2', null, `Словарь ребёнка${name ? ': ' + name : ''}`));
  p.append(el('p', null, `Дата рождения: ${fmtLong(state.child.birth)}. Слов: ${countWords()}. Составлено ${fmtLong(todayStr())}.`));
  const t = el('table'), thead = el('thead'), tr = el('tr');
  for (const h of EXPORT_HEAD) tr.append(el('th', null, h));
  thead.append(tr); t.append(thead);
  const tb = el('tbody');
  for (const r of exportRows()) { const row = el('tr'); for (const c of r) row.append(el('td', null, c)); tb.append(row); }
  t.append(tb); p.append(t);
  window.print();
};

function requestPersist() { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); }

/* ================= Запуск ================= */
(async function init() {
  try {
    db = await openDB();
    state.words = await dbAllWords();
    state.child = (await dbGetMeta('child')) || null;
    state.celebrated = (await dbGetMeta('celebrated')) || [];
    state.lastBackupAt = (await dbGetMeta('lastBackupAt')) || 0;
    state.lastChangeAt = (await dbGetMeta('lastChangeAt')) || 0;
  } catch (e) {
    document.body.textContent = 'Не удалось открыть хранилище браузера: ' + e.message;
    return;
  }
  if (state.child) requestPersist();
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
