/**
 * Доступ к записям.
 *
 * Здесь сосредоточены правила создания и отмены записи. Три защиты от
 * двойной записи применяются именно в этом порядке:
 *
 *   1. Проверка по списку свободных слотов — отсекает время вне рабочего дня,
 *      внутри блокировки и в прошлом. Даёт понятный ответ человеку.
 *   2. Транзакция BEGIN IMMEDIATE — не даёт второму запросу вклиниться между
 *      проверкой и вставкой.
 *   3. Триггер в базе — окончательная гарантия на момент записи, даже если
 *      вставить строку в обход API.
 *
 * Ни один уровень не заменяет остальные: без первого сообщение об ошибке
 * непонятно, без второго остаётся щель в миллисекунды, без третьего база
 * доверяет только честности кода.
 */

import { badRequest, conflict, notFound } from '../errors.js';
import { withTransaction } from '../db.js';
import { computeFreeSlots } from '../slots.js';
import { formatUtc, utcToZonedParts, zonedToUtc } from '../time.js';
import { utcNow } from '../security.js';
import { getSalon, servicesByIds } from './catalog.js';

/** Запись со списком услуг и именами — то, что возвращается клиенту. */
export function getAppointment(db, id) {
  const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!appointment) return null;

  const services = db
    .prepare(
      `SELECT s.id, s.name, s.duration_min, s.price_rub
         FROM appointment_services aps
         JOIN services s ON s.id = aps.service_id
        WHERE aps.appointment_id = ?
        ORDER BY s.name`
    )
    .all(id);

  const master = db
    .prepare(
      `SELECT m.id, u.name
         FROM masters m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = ?`
    )
    .get(appointment.master_id);

  const client = db
    .prepare('SELECT id, name, email, phone FROM users WHERE id = ?')
    .get(appointment.client_id);

  return {
    ...appointment,
    is_override: Boolean(appointment.is_override),
    master: master ? { id: master.id, name: master.name } : null,
    client,
    services,
    totalPriceRub: services.reduce((sum, service) => sum + service.price_rub, 0),
    totalDurationMin: services.reduce((sum, service) => sum + service.duration_min, 0)
  };
}

/**
 * Список записей, доступных текущему пользователю.
 *
 * Фильтр по владению задан здесь, в SQL, а не в коде после выборки:
 * «сначала достать всё, потом отбросить» — это классическая утечка, когда
 * забывают отбросить.
 *
 * @param {object} params
 * @param {'mine'|'master'|'all'} [params.scope] для кого показываем
 */
export function listAppointments(db, { userId, masterId, isAdmin, scope = 'mine', status = null, fromIso = null, toIso = null }) {
  const conditions = [];
  const params = [];

  if (scope === 'all' || (isAdmin && scope === 'master')) {
    // вся студия: полный список доступен только администратору (проверено в маршруте)
  } else if (scope === 'master') {
    if (!masterId) return [];
    conditions.push('a.master_id = ?');
    params.push(masterId);
  } else {
    conditions.push('a.client_id = ?');
    params.push(userId);
  }

  if (status) {
    conditions.push('a.status = ?');
    params.push(status);
  }
  if (fromIso) {
    conditions.push('a.starts_at >= ?');
    params.push(fromIso);
  }
  if (toIso) {
    conditions.push('a.starts_at < ?');
    params.push(toIso);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT a.id
         FROM appointments a
         ${where}
        ORDER BY a.starts_at DESC
        LIMIT 200`
    )
    .all(...params);

  return rows.map((row) => getAppointment(db, row.id));
}

/**
 * Создаёт запись.
 *
 * @param {object} params
 * @param {number} params.clientId на кого записали
 * @param {number} params.masterId к кому записались
 * @param {number[]} params.serviceIds выбранные услуги
 * @param {string} params.startsAtIso момент начала в UTC
 * @param {number} params.actorId кто создаёт запись (может отличаться от клиента)
 * @param {boolean} [params.isOverride] осознанное наложение, только для админа
 * @param {string|null} [params.notes]
 * @param {object[]} [params.holds] интервалы, удерживаемые в памяти сервера
 * @returns {{appointment: object, alternatives: object[]}}
 */
export function createAppointment(db, { clientId, masterId, serviceIds, startsAtIso, actorId, isOverride = false, notes = null, holds = [] }) {
  const salon = getSalon(db);
  if (!salon) throw new Error('В базе нет студии: выполните npm run seed');

  const master = db
    .prepare('SELECT m.id, m.is_active FROM masters m WHERE m.id = ?')
    .get(masterId);

  if (!master) throw notFound('Мастер не найден.');
  if (master.is_active !== 1) throw badRequest('Этот мастер сейчас не принимает записи.');

  const client = db.prepare('SELECT id, name, is_active FROM users WHERE id = ?').get(clientId);
  if (!client) throw notFound('Клиент не найден.');
  if (client.is_active !== 1) throw badRequest('Аккаунт клиента заблокирован.');

  // Услуги существуют, активны, и мастер выполняет каждую из них.
  const services = servicesByIds(db, serviceIds);
  if (services.length !== serviceIds.length) {
    throw badRequest('Некоторые услуги больше не доступны для записи.');
  }

  const provided = new Set(
    db
      .prepare(
        `SELECT service_id FROM master_services
          WHERE master_id = ? AND service_id IN (${serviceIds.map(() => '?').join(',')})`
      )
      .all(masterId, ...serviceIds)
      .map((row) => row.service_id)
  );

  const missing = serviceIds.filter((id) => !provided.has(id));
  if (missing.length > 0) {
    throw badRequest('Выбранный мастер не выполняет все выбранные услуги.', {
      serviceIds: missing
    });
  }

  const durationMin = services.reduce((sum, service) => sum + service.duration_min, 0);
  const timezone = salon.timezone;
  const local = utcToZonedParts(startsAtIso, timezone);

  // --- Проверка 1: слот должен быть в списке свободных ---
  const computed = computeFreeSlots({
    db,
    masterId,
    date: local.date,
    timezone,
    durationMin,
    holds
  });

  const wanted = formatUtc(new Date(startsAtIso));
  const available = computed.slots.find((slot) => slot.startsAt === wanted);

  if (!available && !isOverride) {
    throw conflict(
      'slot_unavailable',
      computed.reason === 'day_off'
        ? 'В этот день мастер не работает.'
        : 'Это время больше недоступно. Выберите другой слот.',
      {
        reason: computed.reason ?? 'slot_taken',
        requested: wanted,
        totalDurationMin: durationMin,
        availableSlots: computed.slots.slice(0, 12)
      }
    );
  }

  const endsAtIso = available
    ? available.endsAt
    : formatUtc(new Date(new Date(startsAtIso).getTime() + durationMin * 60_000));

  const now = utcNow();

  // --- Проверка 2 и 3: транзакция и триггер ---
  const appointmentId = withTransaction(db, () => {
    let id;
    try {
      id = Number(
        db
          .prepare(
            `INSERT INTO appointments
               (client_id, master_id, starts_at, ends_at, status, is_override, created_by, created_at, notes)
             VALUES (?, ?, ?, ?, 'booked', ?, ?, ?, ?)`
          )
          .run(clientId, masterId, wanted, endsAtIso, isOverride ? 1 : 0, actorId, now, notes).lastInsertRowid
      );
    } catch (error) {
      // Триггер отклонил вставку: между проверкой и записью время заняли.
      if (/SLOT_CONFLICT/.test(error.message)) {
        throw conflict('slot_conflict', 'Это время только что заняли. Выберите другой слот.', {
          reason: 'slot_taken',
          requested: wanted
        });
      }
      throw error;
    }

    const link = db.prepare('INSERT INTO appointment_services (appointment_id, service_id) VALUES (?, ?)');
    for (const serviceId of serviceIds) link.run(id, serviceId);

    return id;
  });

  return { appointment: getAppointment(db, appointmentId), alternatives: [] };
}

/**
 * Отменяет запись.
 *
 * Отменённая запись перестаёт занимать слот: её статус больше не 'booked',
 * поэтому триггер её не считает и расчёт свободного времени её игнорирует.
 */
export function cancelAppointment(db, appointment, { bySalon, reason = null }) {
  const now = utcNow();

  withTransaction(db, () => {
    db.prepare('UPDATE appointments SET status = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?').run(
      bySalon ? 'cancelled_by_salon' : 'cancelled_by_client',
      now,
      reason,
      appointment.id
    );
  });

  return getAppointment(db, appointment.id);
}

/**
 * Переносит запись на другое время.
 *
 * Новые границы уже проверены в маршруте (слот должен быть свободным либо
 * перенос осознанно выполнен с наложением). Здесь — только изменение. Финал
 * по-прежнему контролирует триггер: при наложении без is_override он
 * вернёт ошибку, даже если проверка в маршруте пропустила конфликт.
 *
 * @returns {object} обновлённая запись
 */
export function rescheduleAppointment(db, id, { startsAtIso, endsAtIso, isOverride = false }) {
  withTransaction(db, () => {
    db.prepare(
      'UPDATE appointments SET starts_at = ?, ends_at = ?, is_override = ? WHERE id = ?'
    ).run(startsAtIso, endsAtIso, isOverride ? 1 : 0, id);
  });

  return getAppointment(db, id);
}

/** Создаёт разовую блокировку времени мастера. */
export function createTimeBlock(db, { masterId, startsAtIso, endsAtIso, reason, createdBy }) {
  const id = withTransaction(db, () =>
    Number(
      db
        .prepare(
          `INSERT INTO time_blocks (master_id, starts_at, ends_at, reason, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(masterId, startsAtIso, endsAtIso, reason, createdBy, utcNow()).lastInsertRowid
    )
  );

  return db.prepare('SELECT * FROM time_blocks WHERE id = ?').get(id);
}

/** Границы дня в студии, нужные для выборок по дате. */
export function dayBoundsUtc(date, timezone) {
  const [year, month, day] = date.split('-').map(Number);
  return {
    fromIso: formatUtc(zonedToUtc({ year, month, day, hour: 0, minute: 0 }, timezone)),
    toIso: formatUtc(zonedToUtc({ year, month, day, hour: 23, minute: 59 }, timezone))
  };
}
