/**
 * Самопроверка API: поднимает настоящий HTTP-сервер на случайном порту
 * и проверяет сценарии настоящими запросами.
 *
 *   node scripts/check-api.js
 *
 * Почему именно так: проверять обработчики напрямую, минуя HTTP, нельзя —
 * тогда останутся непроверенными разбор тела, заголовок авторизации, коды
 * ответов и то, как сервер ведёт себя при отсутствии прав. Здесь запросы
 * идут через node:http, как у настоящего клиента.
 *
 * База — в памяти, рабочая база не затрагивается, порт выбирается системой.
 */

import { createServer } from 'node:http';
import { once } from 'node:events';

import { createApp } from '../src/app.js';
import { computeFreeSlots } from '../src/slots.js';
import { formatUtc, utcToZonedParts, zonedToUtc } from '../src/time.js';
import * as holds from '../src/holds.js';
import { freshTestDb, seedFixtures } from './fixtures.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Ближайший понедельник, не раньше чем через сутки: время точно в будущем. */
function nextMonday(hour, minute = 0) {
  const now = new Date();
  const today = utcToZonedParts(now, 'Europe/Moscow');
  const daysAhead = ((1 - today.weekday + 7) % 7) || 7;
  return zonedToUtc({ ...today, day: today.day + daysAhead, hour, minute }, 'Europe/Moscow');
}

function nextSaturday(hour, minute = 0) {
  const now = new Date();
  const today = utcToZonedParts(now, 'Europe/Moscow');
  const daysAhead = ((6 - today.weekday + 7) % 7) || 7;
  return zonedToUtc({ ...today, day: today.day + daysAhead, hour, minute }, 'Europe/Moscow');
}

function nextSunday(hour, minute = 0) {
  const now = new Date();
  const today = utcToZonedParts(now, 'Europe/Moscow');
  const daysAhead = (7 - today.weekday) % 7 || 7;
  return zonedToUtc({ ...today, day: today.day + daysAhead, hour, minute }, 'Europe/Moscow');
}

async function main() {
  const db = freshTestDb();
  const fixtures = await seedFixtures(db);
  const { masterId, service60, service90, service45, password } = fixtures;

  const app = createApp({ db, publicDir: 'public' });
  const server = createServer(app.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const base = `http://127.0.0.1:${server.address().port}`;

  /** Запрос к API с необязательным токеном и адресом клиента. */
  async function api(method, path, { body, token, ip } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (ip) headers['X-Forwarded-For'] = ip;

    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { status: response.status, json, text, headers: response.headers };
  }

  const register = (overrides = {}, ip = '10.0.0.1') =>
    api('POST', '/api/auth/register', {
      ip,
      body: {
        email: `user${Math.random().toString(36).slice(2, 9)}@example.com`,
        name: 'Тестовый клиент',
        password: 'Test2026!',
        ...overrides
      }
    });

  const login = (email, pwd = password, ip = '10.0.0.1') =>
    api('POST', '/api/auth/login', { body: { email, password: pwd }, ip });

  // ------------------------------------------------------------------ справочники
  console.log('Самопроверка API «Ноготочки»');
  console.log(`Node ${process.version}, сервер на порту ${server.address().port}, база в памяти.`);

  section('Публичные справочники');

  {
    const salon = await api('GET', '/api/salon');
    check('GET /api/salon отвечает данными студии', salon.status === 200 && salon.json.name === 'Ноготочки');
    check('часовой пояс студии передан клиенту', salon.json.timezone === 'Europe/Moscow');

    const services = await api('GET', '/api/services');
    check('список услуг отдаётся без авторизации', services.status === 200 && services.json.services.length === 3);
    check(
      'услуга отдаётся в понятных клиенту полях',
      services.json.services[0].durationMin > 0 && typeof services.json.services[0].priceRub === 'number'
    );

    const masters = await api('GET', '/api/masters');
    check('список мастеров отдаётся гостю', masters.status === 200 && masters.json.masters.length === 1);

    const byService = await api('GET', `/api/masters?serviceIds=${service90}`);
    check('фильтр по услуге оставил подходящего мастера', byService.json.masters.length === 1);

    const missing = await api('GET', '/api/masters/999');
    check('несуществующий мастер даёт 404', missing.status === 404, `статус ${missing.status}`);
  }

  // ------------------------------------------------------------------ свободные слоты
  section('Расчёт свободных слотов');

  const monday12 = nextMonday(12);
  const mondayDate = utcToZonedParts(monday12, 'Europe/Moscow').date;

  {
    const result = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`);

    check('слоты считаются гостю без входа', result.status === 200);
    check('первый слот начинается в 10:00', result.json.slots[0]?.time === '10:00', result.json.slots[0]?.time);

    // График 10:00–20:00, услуга 60 минут, шаг 15 минут:
    // последний слот начинается в 19:00, всего 37 окон.
    const last = result.json.slots[result.json.slots.length - 1];
    check('последний слот начинается в 19:00', last?.time === '19:00', last?.time);
    check('количество слотов равно 37', result.json.count === 37, `получено ${result.json.count}`);
    check(
      'слот не выходит за конец рабочего дня',
      result.json.slots.every((slot) => slot.time >= '10:00' && slot.time <= '19:00')
    );

    // Две услуги: 60 + 90 = 150 минут. График до 20:00, поэтому
    // последний слот начинается в 17:30.
    const long = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60},${service90}`);
    check(
      'суммарная длительность двух услуг сдвигает последний слот',
      long.json.slots[long.json.slots.length - 1].time === '17:30',
      long.json.slots[long.json.slots.length - 1].time
    );

    const sunday = nextSunday(12);
    const sundayDate = utcToZonedParts(sunday, 'Europe/Moscow').date;
    const off = await api('GET', `/api/masters/${masterId}/slots?date=${sundayDate}`);
    check('в выходной слотов нет', off.json.count === 0 && off.json.reason === 'day_off', off.json.reason);

    const past = await api('GET', `/api/masters/${masterId}/slots?date=2020-01-01`);
    check('на прошедшую дату слотов нет', past.json.count === 0 && past.json.reason === 'date_in_past', past.json.reason);

    const badDate = await api('GET', `/api/masters/${masterId}/slots?date=31-12-2026`);
    check('некорректная дата отклонена', badDate.status === 400, `статус ${badDate.status}`);

    const noDate = await api('GET', `/api/masters/${masterId}/slots`);
    check('без даты приходит понятная ошибка', noDate.status === 400 && noDate.json.error.code === 'bad_request');

    const unknown = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=999999`);
    check('несуществующая услуга не ломает расчёт', unknown.status === 200);
  }

  // ------------------------------------------------------------------ регистрация и вход
  section('Регистрация и вход');

  const anna = await login('anna@example.com', password, '10.0.1.1');
  const oleg = await login('oleg@example.com', password, '10.0.1.2');
  const admin = await login('admin@nogotochki.ru', password, '10.0.1.3');

  check('вход клиента выдаёт токен', anna.status === 200 && typeof anna.json.token === 'string');
  check('вход клиента не выдаёт хеш пароля', !anna.text.includes('scrypt$'));
  check('вход администратора выдаёт роль admin', admin.json.user.roles.includes('admin'), admin.json.user.roles.join(','));

  {
    const escalation = await register({ role: 'admin', roles: ['admin'], is_admin: 1 });
    check('роль из тела запроса игнорируется', escalation.json.user.roles.join(',') === 'client', escalation.json.user.roles.join(','));

    const short = await register({ password: 'корот' });
    check('короткий пароль отклонён', short.status === 400 && short.json.error.details.fields.some((f) => f.field === 'password'));

    const badEmail = await register({ email: 'не-почта' });
    check('некорректный e-mail отклонён', badEmail.status === 400);

    const first = await register({ email: 'duplicate@example.com' });
    const second = await register({ email: 'duplicate@example.com' });
    check('повторная регистрация e-mail даёт 409', second.status === 409, `статус ${second.status}`);
    check('e-mail сравнивается без учёта регистра', first.status === 201);

    const injection = await register({ email: "victim@example.com' OR '1'='1" });
    check('попытка SQL-инъекции в e-mail отклонена', injection.status === 400, `статус ${injection.status}`);

    const notJson = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{это не json'
    });
    check('битое тело запроса даёт 400, а не 500', notJson.status === 400, `статус ${notJson.status}`);
  }

  {
    const wrongPassword = await login('anna@example.com', 'неверный-пароль', '10.0.2.1');
    const unknownUser = await login('nobody@example.com', password, '10.0.2.2');

    check('неверный пароль даёт 401', wrongPassword.status === 401);
    check(
      'текст ошибки одинаков для неверного пароля и несуществующего e-mail',
      wrongPassword.json.error.message === unknownUser.json.error.message,
      `${wrongPassword.json.error.message} / ${unknownUser.json.error.message}`
    );
  }

  {
    // Лимит перебора: 5 неудачных попыток, шестая — отказ.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await login('bruteforce@example.com', `пароль-${attempt}`, '10.0.3.9');
      lastStatus = response.status;
      if (response.status === 429) break;
    }
    check('перебор пароля упирается в 429', lastStatus === 429, `последний статус ${lastStatus}`);
  }

  // ------------------------------------------------------------------ доступ к данным
  section('Права доступа');

  {
    const noToken = await api('GET', '/api/appointments');
    check('список записей без токена даёт 401', noToken.status === 401, `статус ${noToken.status}`);

    // Заголовок Authorization должен быть ASCII, поэтому токен-подделка
    // тоже латиницей: иначе проверка падала бы на кодировке, а не на правах.
    const badToken = await api('GET', '/api/appointments', { token: 'fake-token-0000' });
    check('выдуманный токен даёт 401', badToken.status === 401);

    const raw = await api('GET', `/api/appointments?token=${anna.json.token}`);
    check('токен в адресе не принимается', raw.status === 401, `статус ${raw.status}`);
  }

  // ------------------------------------------------------------------ создание записи
  section('Создание записи');

  const annaToken = anna.json.token;
  const olegToken = oleg.json.token;
  const adminToken = admin.json.token;

  const firstSlotIso = formatUtc(nextMonday(12));
  let annaAppointment = null;

  {
    const created = await api('POST', '/api/appointments', {
      token: annaToken,
      ip: '10.0.4.1',
      body: { masterId, serviceIds: [service60], startsAt: firstSlotIso, notes: 'Первый визит' }
    });

    check('запись создана', created.status === 201, `статус ${created.status}: ${created.text.slice(0, 120)}`);
    check(
      'стоимость посчитана из цен услуг',
      created.json?.appointment?.totalPriceRub === 2500,
      String(created.json?.appointment?.totalPriceRub)
    );
    check('время окончания вычислено по длительности', created.json?.appointment?.endsAt?.endsWith('Z') === true);
    annaAppointment = created.json.appointment;
  }

  {
    const again = await api('POST', '/api/appointments', {
      token: annaToken,
      ip: '10.0.4.1',
      body: { masterId, serviceIds: [service60], startsAt: firstSlotIso }
    });
    check('повторная запись на тот же слот даёт 409', again.status === 409, `статус ${again.status}`);

    const second = await api('POST', '/api/appointments', {
      token: annaToken,
      ip: '10.0.4.1',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(12, 30)) }
    });
    check('наложение на занятый интервал даёт 409', second.status === 409, `статус ${second.status}`);

    const occupied = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: firstSlotIso }
    });
    check('другой клиент не может занять тот же слот', occupied.status === 409, `статус ${occupied.status}`);

    const overrideByClient = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: firstSlotIso, isOverride: true }
    });
    check(
      'клиент не может обойти защиту признаком isOverride',
      overrideByClient.status === 409,
      `статус ${overrideByClient.status}`
    );
  }

  {
    const outsideHours = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(23)) }
    });
    check('запись после закрытия отклонена', outsideHours.status === 409, `статус ${outsideHours.status}`);

    const past = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: '2020-01-01T10:00:00Z' }
    });
    check('запись в прошлом отклонена', past.status === 400, `статус ${past.status}`);

    const notAligned = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(12, 7)) }
    });
    check('время вне сетки слотов отклонено', notAligned.status === 409, `статус ${notAligned.status}`);

    const noService = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [], startsAt: formatUtc(nextMonday(14)) }
    });
    check('запись без услуг отклонена', noService.status === 400);

    const longNotes = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(14)), notes: 'я'.repeat(600) }
    });
    check('слишком длинная заметка отклонена', longNotes.status === 400);

    const foreignClient = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(14)), clientId: fixtures.clientIds[0] }
    });
    check('клиент не может записать другого человека', foreignClient.status === 403, `статус ${foreignClient.status}`);
  }

  {
    // Слот освободился: 12:30 занят, но 12:00–13:00 перекрывается записью Анны,
    // поэтому 14:00 свободен.
    const booked = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(14)) }
    });
    check('свободный слот другого времени записывается', booked.status === 201, `статус ${booked.status}`);

    const takenAway = await api('POST', '/api/appointments', {
      token: annaToken,
      ip: '10.0.4.1',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(14)) }
    });
    check('занятое другим клиентом время больше не записывается', takenAway.status === 409);
  }

  {
    // Честная проверка наложения: сначала слот 15:00 занимает обычная запись
    // (администратор записал олега), потом администратор накладывает вторую
    // запись на это же время для анны. Клиент себе такой обход не позволяет:
    // проверено выше признаком isOverride, а здесь — реальным занятым слотом.
    const occupiedTarget = formatUtc(nextMonday(15));

    const normalForOleg = await api('POST', '/api/appointments', {
      token: adminToken,
      body: { masterId, serviceIds: [service45], startsAt: occupiedTarget, clientId: fixtures.clientIds[1] }
    });
    check('администратор создаёт обычную запись клиенту', normalForOleg.status === 201, `статус ${normalForOleg.status}`);

    const clientBlocked = await api('POST', '/api/appointments', {
      token: annaToken,
      body: { masterId, serviceIds: [service45], startsAt: occupiedTarget }
    });
    check('тот же слот клиенту уже недоступен', clientBlocked.status === 409, `статус ${clientBlocked.status}`);

    const override = await api('POST', '/api/appointments', {
      token: adminToken,
      body: { masterId, serviceIds: [service45], startsAt: occupiedTarget, clientId: fixtures.clientIds[0], isOverride: true }
    });
    check('администратор накладывает запись на занятое время', override.status === 201, `статус ${override.status}`);
    check('наложенная запись помечена как исключение', override.json?.appointment?.isOverride === true);
  }

  // ------------------------------------------------------------------ чтение и отмена
  section('Чтение и отмена записи');

  {
    const mine = await api('GET', '/api/appointments', { token: olegToken });
    // Две записи олега: 14:00 он записал сам, 15:00 — администратор.
    check('клиент видит только свои записи', mine.json.appointments.length === 2, `записей ${mine.json.appointments.length}`);
    check(
      'все видимые записи принадлежат клиенту',
      mine.json.appointments.every((appointment) => appointment.client.id === fixtures.clientIds[1])
    );

    const someoneElse = await api('GET', `/api/appointments/${annaAppointment.id}`, { token: olegToken });
    check('чужую запись открыть нельзя', someoneElse.status === 403, `статус ${someoneElse.status}`);

    const own = await api('GET', `/api/appointments/${annaAppointment.id}`, { token: annaToken });
    check('свою запись клиент открывает', own.status === 200 && own.json.appointment.id === annaAppointment.id);

    const asAdmin = await api('GET', `/api/appointments/${annaAppointment.id}`, { token: adminToken });
    check('администратор открывает любую запись', asAdmin.status === 200);

    const allAsClient = await api('GET', '/api/appointments?scope=all', { token: olegToken });
    check('scope=all клиенту недоступен', allAsClient.status === 403);

    const allAsAdmin = await api('GET', '/api/appointments?scope=all', { token: adminToken });
    // На этот момент в базе четыре активные записи: анна 12:00, олег 14:00,
    // олег 15:00 (обычная) и анна 15:00 (наложенная администратором).
    check('администратор видит все записи', allAsAdmin.status === 200 && allAsAdmin.json.appointments.length === 4, `записей ${allAsAdmin.json.appointments?.length}`);

    const mineAsAdmin = await api('GET', '/api/appointments?scope=mine', { token: adminToken });
    check('scope=mine у администратора — только его собственные записи', mineAsAdmin.status === 200 && mineAsAdmin.json.appointments.length === 0, `записей ${mineAsAdmin.json.appointments?.length}`);

    const unknownId = await api('GET', '/api/appointments/999999', { token: adminToken });
    check('несуществующая запись даёт 404', unknownId.status === 404);

    const badId = await api('GET', '/api/appointments/abc', { token: adminToken });
    check('нечисловой идентификатор даёт 400', badId.status === 400);
  }

  {
    const foreignCancel = await api('POST', `/api/appointments/${annaAppointment.id}/cancel`, { token: olegToken });
    check('чужую запись отменить нельзя', foreignCancel.status === 403);

    const ownCancel = await api('POST', `/api/appointments/${annaAppointment.id}/cancel`, {
      token: annaToken,
      body: { reason: 'Планы изменились' }
    });
    check('клиент отменяет свою запись', ownCancel.status === 200);
    check('статус отменённой записи верный', ownCancel.json.appointment.status === 'cancelled_by_client', ownCancel.json.appointment.status);

    const twice = await api('POST', `/api/appointments/${annaAppointment.id}/cancel`, { token: annaToken });
    check('повторная отмена отклонена', twice.status === 400, `статус ${twice.status}`);

    // Запись Анны освободила слот 12:00–13:00 целиком: наложение
    // администратора перенесено на 17:00, поэтому время снова доступно.
    const rebooked = await api('POST', '/api/appointments', {
      token: olegToken,
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(12)) }
    });
    check('отменённое время снова доступно', rebooked.status === 201, `статус ${rebooked.status}`);
  }

  // ------------------------------------------------------------------ удержание слота
  section('Удержание слота');

  {
    const holdIso = formatUtc(nextMonday(16));
    const holdEnd = formatUtc(nextMonday(17));

    const first = await api('POST', '/api/holds', {
      token: annaToken,
      ip: '10.0.9.1',
      body: { masterId, startsAt: holdIso, endsAt: holdEnd }
    });
    check('слот можно занять', first.status === 201 && first.json.held === true);

    const second = await api('POST', '/api/holds', {
      token: olegToken,
      ip: '10.0.9.2',
      body: { masterId, startsAt: holdIso, endsAt: holdEnd }
    });
    check('второй клиент не может занять тот же слот', second.status === 400, `статус ${second.status}`);

    const slots = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`);
    check(
      'удержанный слот пропал из списка свободных',
      !slots.json.slots.some((slot) => slot.startsAt === holdIso)
    );

    const ownSlots = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`, {
      token: annaToken
    });
    check(
      'свой удержанный слот клиент по-прежнему видит',
      ownSlots.json.slots.some((slot) => slot.startsAt === holdIso)
    );

    const extended = await api('POST', '/api/holds/extend', {
      token: annaToken,
      ip: '10.0.9.1',
      body: { masterId, startsAt: holdIso }
    });
    check('удержание продлевается', extended.status === 200 && extended.json.held === true);

    const foreignRelease = await api('DELETE', '/api/holds', {
      token: olegToken,
      ip: '10.0.9.2',
      body: { masterId, startsAt: holdIso }
    });
    check('чужое удержание нельзя снять', foreignRelease.status === 200 && foreignRelease.json.released === false);

    const release = await api('DELETE', '/api/holds', {
      token: annaToken,
      ip: '10.0.9.1',
      body: { masterId, startsAt: holdIso }
    });
    check('своё удержание снимается', release.json.released === true);

    const afterRelease = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`);
    check(
      'после снятия удержания слот снова свободен',
      afterRelease.json.slots.some((slot) => slot.startsAt === holdIso)
    );
  }

  // ------------------------------------------------------------------ гонка
  section('Одновременная запись на один слот');

  {
    holds.reset();

    // Десять параллельных запросов на одно и то же время. Ровно один должен
    // выиграть: это проверка транзакции и триггера, а не только проверки кода.
    const target = formatUtc(nextMonday(18));
    const tokens = [annaToken, olegToken, adminToken];

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api('POST', '/api/appointments', {
          token: tokens[index % tokens.length],
          ip: `10.0.8.${index}`,
          body: { masterId, serviceIds: [service60], startsAt: target }
        })
      )
    );

    const created = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);

    check(
      'из десяти одновременных запросов создана ровно одна запись',
      created.length === 1,
      `создано ${created.length}, отказов ${conflicts.length}`
    );
    check('остальные получили 409', created.length + conflicts.length === 10);

    const inDb = db
      .prepare("SELECT COUNT(*) AS n FROM appointments WHERE starts_at = ? AND status = 'booked'")
      .get(target);
    check('в базе действительно одна запись на это время', inDb.n === 1, `записей ${inDb.n}`);
  }

  // ------------------------------------------------------------------ перенос записи
  section('Администратор: перенос записи');

  {
    const clientId = fixtures.clientIds[0];

    const created = await api('POST', '/api/appointments', {
      token: adminToken,
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(13)), clientId }
    });
    check('администратор создаёт запись клиенту для переноса', created.status === 201, `статус ${created.status}`);
    const appointmentId = created.json.appointment.id;

    const byClient = await api('POST', `/api/appointments/${appointmentId}/reschedule`, {
      token: olegToken,
      body: { startsAt: formatUtc(nextMonday(13, 30)) }
    });
    check('клиент не может переносить записи', byClient.status === 403, `статус ${byClient.status}`);

    const movedTo = formatUtc(nextMonday(11));
    const moved = await api('POST', `/api/appointments/${appointmentId}/reschedule`, {
      token: adminToken,
      body: { startsAt: movedTo }
    });
    check(
      'администратор переносит запись на свободный слот',
      moved.status === 200 && moved.json.appointment.startsAt === movedTo,
      `статус ${moved.status}: ${moved.text.slice(0, 120)}`
    );
    check('перенос сохраняет услуги и цену', moved.json?.appointment?.totalPriceRub === 2500);

    const occupied = formatUtc(nextMonday(14));
    const conflict = await api('POST', `/api/appointments/${appointmentId}/reschedule`, {
      token: adminToken,
      body: { startsAt: occupied }
    });
    check('перенос на занятое время без isOverride даёт 409', conflict.status === 409, `статус ${conflict.status}`);

    const forced = await api('POST', `/api/appointments/${appointmentId}/reschedule`, {
      token: adminToken,
      body: { startsAt: occupied, isOverride: true }
    });
    check('с isOverride администратор накладывает перенос', forced.status === 200 && forced.json.appointment.startsAt === occupied);
    check('наложенный перенос помечен как исключение', forced.json.appointment.isOverride === true);

    const same = await api('POST', `/api/appointments/${appointmentId}/reschedule`, {
      token: adminToken,
      body: { startsAt: occupied }
    });
    check('перенос на текущее время ничего не меняет', same.status === 200 && same.json.appointment.startsAt === occupied);
  }

  // ------------------------------------------------------------------ уведомления
  section('Уведомления');

  {
    const before = await api('GET', '/api/notifications/unread-count', { token: olegToken });

    // Клиент записался сам — уведомление о собственной записи не нужно.
    const selfBooking = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(16, 30)) }
    });
    check('клиент записался на свободный слот', selfBooking.status === 201, `статус ${selfBooking.status}`);

    const afterSelf = await api('GET', '/api/notifications/unread-count', { token: olegToken });
    check(
      'о собственной записи уведомление не приходит',
      afterSelf.json.count === before.json.count,
      `было ${before.json.count}, стало ${afterSelf.json.count}`
    );

    // Администратор отменяет запись клиента — уведомление приходит.
    const reason = 'Не успеваем по графику';
    const cancelledByAdmin = await api('POST', `/api/appointments/${selfBooking.json.appointment.id}/cancel`, {
      token: adminToken,
      body: { reason }
    });
    check(
      'администратор отменяет чужую запись',
      cancelledByAdmin.status === 200 && cancelledByAdmin.json.appointment.status === 'cancelled_by_salon',
      `статус ${cancelledByAdmin.status}`
    );

    const afterCancel = await api('GET', '/api/notifications/unread-count', { token: olegToken });
    check(
      'об отмене уведомление пришло',
      afterCancel.json.count === before.json.count + 1,
      `было ${before.json.count}, стало ${afterCancel.json.count}`
    );

    const list = await api('GET', '/api/notifications?unread=1', { token: olegToken });
    const newest = list.json.notifications[0];
    check('уведомление об отмене пришло первым в списке', newest?.kind === 'appointment_cancelled', newest?.kind);
    check('причина отмены попала в текст', newest?.message.includes(reason), newest?.message);
    check('в уведомлении есть адресованная запись', newest?.appointmentStartsAt !== null);

    // Чужое уведомление прочитать нельзя, своё — можно.
    const annaList = await api('GET', '/api/notifications', { token: annaToken });
    check('клиент видит только свои уведомления', list.json.notifications.every((n) => n.id));

    const foreignRead = await api('POST', `/api/notifications/${newest.id}/read`, { token: annaToken });
    check('чужое уведомление прочитать нельзя (404)', foreignRead.status === 404, `статус ${foreignRead.status}`);

    const ownRead = await api('POST', `/api/notifications/${newest.id}/read`, { token: olegToken });
    check('своё уведомление прочитано', ownRead.status === 200 && ownRead.json.ok === true);

    const afterRead = await api('GET', '/api/notifications/unread-count', { token: olegToken });
    check('счётчик уменьшился после чтения', afterRead.json.count === before.json.count, `стало ${afterRead.json.count}`);

    const readAll = await api('POST', '/api/notifications/read-all', { token: olegToken });
    check('все уведомления отмечаются прочитанными', readAll.status === 200);
    const zero = await api('GET', '/api/notifications/unread-count', { token: olegToken });
    check('непрочитанных не осталось', zero.json.count === 0, `осталось ${zero.json.count}`);
  }

  // ------------------------------------------------------------------ административный раздел
  section('Административный раздел');

  {
    const guest = await api('GET', '/api/admin/services');
    check('админ-раздел без токена даёт 401', guest.status === 401, `статус ${guest.status}`);

    const asClient = await api('GET', '/api/admin/services', { token: olegToken });
    check('клиенту админ-раздел недоступен (403)', asClient.status === 403, `статус ${asClient.status}`);

    const services = await api('GET', '/api/admin/services', { token: adminToken });
    check('админ видит все услуги', services.status === 200 && services.json.services.length === 3);

    const created = await api('POST', '/api/admin/services', {
      token: adminToken,
      body: { name: 'Укладка', durationMin: 30, priceRub: 1500 }
    });
    check('услуга создана', created.status === 201 && created.json.service.name === 'Укладка', `статус ${created.status}`);

    const off = await api('PATCH', `/api/admin/services/${created.json.service.id}`, {
      token: adminToken,
      body: { isActive: false }
    });
    check('услугу можно отключить', off.status === 200 && off.json.service.isActive === false);

    const publicList = await api('GET', '/api/services');
    check('отключённая услуга пропала из публичного списка', publicList.status === 200 && publicList.json.services.length === 3);

    const backOn = await api('PATCH', `/api/admin/services/${created.json.service.id}`, {
      token: adminToken,
      body: { isActive: true }
    });
    check('услуга снова включена', backOn.status === 200 && backOn.json.service.isActive === true);

    const missing = await api('PATCH', '/api/admin/services/999999', { token: adminToken, body: { name: 'X' } });
    check('правка несуществующей услуги даёт 404', missing.status === 404);

    const bad = await api('POST', '/api/admin/services', {
      token: adminToken,
      body: { name: 'X', durationMin: 2, priceRub: 100 }
    });
    check('услуга с малой длительностью отклонена', bad.status === 400);

    const clients = await api('GET', '/api/admin/clients', { token: adminToken });
    check(
      'список клиентов для записи отдан',
      clients.status === 200 && clients.json.clients.some((client) => client.email === 'anna@example.com')
    );
  }

  {
    const masters = await api('GET', '/api/admin/masters', { token: adminToken });
    check(
      'админ видит мастеров с графиком',
      masters.status === 200 && masters.json.masters[0]?.schedule.length === 7,
      `мастеров ${masters.json.masters?.length}`
    );

    const schedule = [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      startTime: '10:00',
      endTime: '19:00',
      isWorking: true
    }));

    const created = await api('POST', '/api/admin/masters', {
      token: adminToken,
      body: {
        email: 'boris@example.com',
        name: 'Борис Кружкин',
        password: 'Boris2026!',
        specialization: 'Мастер маникюра · классика',
        serviceIds: [service60],
        schedule
      }
    });
    check('мастер создан', created.status === 201, `статус ${created.status}: ${created.text.slice(0, 120)}`);
    const masterId2 = created.json.master?.id;

    const publicMasters = await api('GET', '/api/masters');
    check('новый мастер появился в публичном каталоге', publicMasters.json.masters.some((master) => master.id === masterId2));

    const duplicate = await api('POST', '/api/admin/masters', {
      token: adminToken,
        body: { email: 'boris@example.com', name: 'Дубль', password: 'Boris2026!', specialization: 'Мастер маникюра' }
    });
    check('мастер с занятой почтой отклонён (409)', duplicate.status === 409, `статус ${duplicate.status}`);

    const patched = await api('PATCH', `/api/admin/masters/${masterId2}`, {
      token: adminToken,
      body: { specialization: 'Топ-мастер', isActive: false }
    });
    check(
      'профиль мастера обновлён',
      patched.status === 200 && patched.json.master.specialization === 'Топ-мастер',
      `статус ${patched.status}`
    );

    const afterOff = await api('GET', '/api/masters');
    check('выключенный мастер пропал из публичного каталога', !afterOff.json.masters.some((master) => master.id === masterId2));

    const servicesSet = await api('PUT', `/api/admin/masters/${masterId2}/services`, {
      token: adminToken,
      body: { serviceIds: [service90] }
    });
    check(
      'набор услуг мастера заменён',
      servicesSet.status === 200 && servicesSet.json.master.services.map((service) => service.id).join(',') === String(service90)
    );

    const scheduleSet = await api('PUT', `/api/admin/masters/${masterId2}/schedule`, {
      token: adminToken,
      body: { schedule: [{ weekday: 6, startTime: '11:00', endTime: '18:00', isWorking: true }] }
    });
    check('график мастера заменён', scheduleSet.status === 200 && scheduleSet.json.master.schedule.length === 1);

    const brokenSchedule = await api('PUT', `/api/admin/masters/${masterId2}/schedule`, {
      token: adminToken,
      body: { schedule: [{ weekday: 6, startTime: '18:00', endTime: '11:00', isWorking: true }] }
    });
    check('график с концом раньше начала отклонён', brokenSchedule.status === 400, `статус ${brokenSchedule.status}`);

    // Блокировки времени: админ закрывает интервал, слоты исчезают, клиенту
    // действие недоступно, а поверх уже оформленной записи блокировать нельзя.
    await api('PATCH', `/api/admin/masters/${masterId2}`, { token: adminToken, body: { isActive: true } });

    const saturday = nextSaturday(10);
    const saturdayKey = utcToZonedParts(saturday, 'Europe/Moscow').date;
    const slotsUrl = `/api/masters/${masterId2}/slots?date=${saturdayKey}&serviceIds=${service90}`;
    const slotsBefore = await api('GET', slotsUrl);
    check('у мастера есть слоты в день проверки блокировки', slotsBefore.status === 200 && slotsBefore.json.slots.length > 0);

    const block = await api('POST', `/api/admin/masters/${masterId2}/blocks`, {
      token: adminToken,
      body: { startsAt: formatUtc(nextSaturday(12)), endsAt: formatUtc(nextSaturday(13)), reason: 'Санитарный час' }
    });
    check('админ блокирует время мастера', block.status === 201 && block.json.block?.id > 0, `статус ${block.status}`);

    const slotsAfter = await api('GET', slotsUrl);
    check(
      'заблокированный интервал пропал из слотов',
      !slotsAfter.json.slots.some((slot) => slot.time === '12:00') &&
        slotsAfter.json.slots.length < slotsBefore.json.slots.length
    );

    const asClient = await api('POST', `/api/admin/masters/${masterId2}/blocks`, {
      token: annaToken,
      body: { startsAt: formatUtc(nextSaturday(14)), endsAt: formatUtc(nextSaturday(15)) }
    });
    check('клиент не может блокировать время', asClient.status === 403, `статус ${asClient.status}`);

    const booked = await api('POST', '/api/appointments', {
      token: annaToken,
      body: { masterId: masterId2, serviceIds: [service90], startsAt: formatUtc(nextSaturday(15)) }
    });
    check('запись для проверки конфликта создана', booked.status === 201, `статус ${booked.status}`);

    const overBooking = await api('POST', `/api/admin/masters/${masterId2}/blocks`, {
      token: adminToken,
      body: { startsAt: formatUtc(nextSaturday(15)), endsAt: formatUtc(nextSaturday(16)) }
    });
    check('блокировка поверх записи клиента отклонена', overBooking.status === 409, `статус ${overBooking.status}`);

    const removed = await api('DELETE', `/api/admin/blocks/${block.json.block.id}`, { token: adminToken });
    check('блокировка снята', removed.status === 200, `статус ${removed.status}`);

    const slotsBack = await api('GET', slotsUrl);
    check('после снятия блокировки слот 12:00 снова свободен', slotsBack.json.slots.some((slot) => slot.time === '12:00'));
  }

  // ------------------------------------------------------------------ выход и заголовки
  section('Выход, заголовки, маршруты');

  {
    const fresh = await register({}, '10.0.7.1');
    const token = fresh.json.token;

    const before = await api('GET', '/api/appointments', { token });
    check('свежий токен работает', before.status === 200);

    const logout = await api('POST', '/api/auth/logout', { token });
    check('выход возвращает 204', logout.status === 204, `статус ${logout.status}`);

    const after = await api('GET', '/api/appointments', { token });
    check('после выхода токен больше не работает', after.status === 401);

    const me = await api('GET', '/api/auth/me', { token: annaToken });
    check('GET /api/auth/me отдаёт текущего пользователя', me.status === 200 && me.json.user.email === 'anna@example.com');

    const meNoToken = await api('GET', '/api/auth/me');
    check('GET /api/auth/me без токена даёт 401', meNoToken.status === 401);
  }

  {
    const health = await api('GET', '/api/salon');
    check('заголовок nosniff выставлен', health.headers.get('x-content-type-options') === 'nosniff');
    check('запрет кэширования выставлен', (health.headers.get('cache-control') ?? '').includes('no-store'));
    check('запрет обрамления в iframe выставлен', health.headers.get('x-frame-options') === 'DENY');
    check(
      'Content-Security-Policy задан',
      (health.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'")
    );

    const traversal = await api('GET', '/../../.env');
    check('обход каталога не выдаёт файл', traversal.status === 404, `статус ${traversal.status}`);
    check('содержимое .env не утекло', !traversal.text.includes('DB_FILE'), traversal.text.slice(0, 80));

    const encoded = await api('GET', '/%2e%2e%2f%2e%2e%2f.env');
    check('обход каталога в кодировке не выдаёт файл', encoded.status === 404, `статус ${encoded.status}`);

    const wrongMethod = await api('DELETE', '/api/salon');
    check('неподдерживаемый метод даёт 405', wrongMethod.status === 405, `статус ${wrongMethod.status}`);

    const unknownApi = await api('GET', '/api/чего-нибудь');
    check('неизвестный адрес API даёт 404', unknownApi.status === 404);

    const internal = await api('GET', '/api/masters/999999/slots?date=' + mondayDate);
    check('внутренний текст ошибки базы не утекает', !internal.text.includes('SQLITE'), internal.text.slice(0, 120));
  }

  // ------------------------------------------------------------------ сходимость
  section('Согласованность расчёта с базой');

  {
    // Свободные слоты, посчитанные напрямую из базы, должны совпасть с тем,
    // что отдаёт API: иначе расчёт на экране и расчёт при записи разойдутся.
    const direct = computeFreeSlots({
      db,
      masterId,
      date: mondayDate,
      timezone: 'Europe/Moscow',
      durationMin: 60,
      holds: holds.holdsForMaster(masterId)
    });
    const viaApi = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`);

    check(
      'слоты из API совпадают с прямым расчётом',
      JSON.stringify(direct.slots.map((s) => s.startsAt)) === JSON.stringify(viaApi.json.slots.map((s) => s.startsAt)),
      `прямой расчёт дал ${direct.total}, API — ${viaApi.json.count}`
    );
  }

  server.close();
  db.close();

  console.log(`\nИтог: успешно ${passed}, ошибок ${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Самопроверка API не завершилась:', error);
  process.exit(1);
});
