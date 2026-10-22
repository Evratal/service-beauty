/**
 * Административные маршруты: услуги, мастера, список клиентов.
 *
 * Все маршруты требуют входа и роли admin: обёртка asAdmin вызывает
 * requireRole до обработчика, поэтому в самих обработчиках роль больше
 * не проверяется. Данные только управляются админом — клиентский слой
 * (лендинг и кабинет) их менять не может.
 */

import { badRequest, conflict, notFound } from '../errors.js';
import { requireRole } from '../auth.js';
import { validate, cleanText } from '../validate.js';
import { formatUtc, isValidDateString, parseHhMm, zonedToUtc } from '../time.js';
import { hashPassword } from '../security.js';
import { pathId } from './helpers.js';
import { publicService, publicSchedule } from './catalog.js';
import {
  createMaster,
  createService,
  deleteTimeBlock,
  getMaster,
  getSalon,
  getService,
  listAdminMasters,
  listAdminServices,
  replaceMasterSchedule,
  replaceMasterServices,
  updateMaster,
  updateService
} from '../repo/catalog.js';
import { createTimeBlock } from '../repo/appointments.js';
import { createUser, listClientsForAdmin, updateUserProfile } from '../repo/users.js';

const AUTH = { auth: true };

/** Обёртка: к любому маршруту добавляет проверку роли admin. */
function asAdmin(handler) {
  return (context) => {
    requireRole(context.session, 'admin');
    return handler(context);
  };
}

const SERVICE_RULES = {
  name: { type: 'string', required: true, min: 2, max: 120 },
  description: { type: 'string', required: false, max: 500, nullable: true },
  durationMin: { type: 'int', required: true, min: 5, max: 720 },
  priceRub: { type: 'int', required: true, min: 0, max: 1_000_000 }
};

const MASTER_PATCH_RULES = {
  name: { type: 'string', required: false, min: 2, max: 120 },
  phone: { type: 'string', required: false, max: 32, nullable: true },
  specialization: { type: 'string', required: false, min: 2, max: 120 },
  bio: { type: 'string', required: false, max: 1000, nullable: true },
  isActive: { type: 'boolean', required: false }
};

/** Проверка набора услуг мастера: список положительных целых. */
const serviceIds = (raw) => validate({ serviceIds: raw }, { serviceIds: { type: 'idList', required: true, maxItems: 20 } }).serviceIds;

/**
 * Проверка графика: массив из 7 строк по дням недели.
 * Возвращает строки, готовые к вставке.
 */
function checkSchedule(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 7) {
    throw badRequest('График должен быть списком записей по дням недели (0–6).');
  }

  const weekdays = new Set();
  return raw.map((row) => {
    if (row === null || typeof row !== 'object') throw badRequest('Запись графика должна быть объектом.');

    if (!Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6) {
      throw badRequest('День недели — целое число от 0 (воскресенье) до 6 (суббота).');
    }
    if (weekdays.has(row.weekday)) throw badRequest(`День недели ${row.weekday} указан дважды.`);
    weekdays.add(row.weekday);

    const start = parseHhMm(row.startTime);
    const end = parseHhMm(row.endTime);
    if (start === null || end === null) throw badRequest('Время графика — в формате ЧЧ:ММ.');
    if (end <= start) throw badRequest('Конец рабочего дня должен быть позже начала.');

    return {
      weekday: row.weekday,
      start_time: row.startTime,
      end_time: row.endTime,
      is_working: row.isWorking === true ? 1 : 0
    };
  });
}

export function registerAdminRoutes(router) {
  /* ------------------------------------------------------------- клиенты */

  router.get(
    '/api/admin/clients',
    asAdmin(async ({ db }) => {
      return {
        payload: {
          clients: listClientsForAdmin(db).map((client) => ({
            id: client.id,
            name: client.name,
            email: client.email,
            phone: client.phone ?? null
          }))
        }
      };
    }),
    AUTH
  );

  /* ------------------------------------------------------------- услуги */

  router.get(
    '/api/admin/services',
    asAdmin(async ({ db }) => {
      return {
        payload: {
          services: listAdminServices(db).map(adminService)
        }
      };
    }),
    AUTH
  );

  router.post(
    '/api/admin/services',
    asAdmin(async ({ db, body }) => {
      const data = validate(body, SERVICE_RULES);
      const service = createService(db, {
        name: data.name,
        description: cleanText(data.description ?? null),
        durationMin: data.durationMin,
        priceRub: data.priceRub
      });
      return { status: 201, payload: { service: adminService(service) } };
    }),
    AUTH
  );

  router.patch(
    '/api/admin/services/:id',
    asAdmin(async ({ db, params, body }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор услуги.');

      const service = getService(db, id);
      if (!service) throw notFound('Услуга не найдена.');

      const allowed = {
        name: 'name',
        description: 'description',
        durationMin: 'duration_min',
        priceRub: 'price_rub',
        isActive: 'is_active'
      };

      const updates = {};
      for (const [field, column] of Object.entries(allowed)) {
        if (body[field] === undefined) continue;
        const rule = SERVICE_RULES[field] ?? { type: 'boolean', required: false };
        const value = validate({ [field]: body[field] }, { [field]: rule })[field];
        updates[column] = field === 'description' ? cleanText(value) : value;
        if (field === 'isActive') updates[column] = value ? 1 : 0;
      }

      if (Object.keys(updates).length === 0) {
        throw badRequest('Нет полей для обновления услуги.');
      }

      const updated = updateService(db, id, updates);
      return { payload: { service: adminService(updated) } };
    }),
    AUTH
  );

  /* ------------------------------------------------------------- мастера */

  router.get(
    '/api/admin/masters',
    asAdmin(async ({ db }) => {
      return {
        payload: {
          masters: listAdminMasters(db).map(adminMaster)
        }
      };
    }),
    AUTH
  );

  router.post(
    '/api/admin/masters',
    asAdmin(async ({ db, body }) => {
      const data = validate(body, {
        email: { type: 'email', required: true },
        name: { type: 'string', required: true, min: 2, max: 120 },
        phone: { type: 'string', required: false, max: 32, nullable: true },
        password: { type: 'password', required: true, max: 200 },
        specialization: { type: 'string', required: true, min: 2, max: 120 },
        bio: { type: 'string', required: false, max: 1000, nullable: true }
      });

      // serviceIds и schedule — массивы: валидатор строк для них не подходит,
      // поэтому разбираются отдельно и в правила выше не попадают.
      const ids = body.serviceIds === undefined ? [] : serviceIds(body.serviceIds);
      const schedule = body.schedule === undefined ? [] : checkSchedule(body.schedule);

      const passwordHash = await hashPassword(data.password);
      const user = createUser(db, {
        email: data.email,
        passwordHash,
        name: data.name,
        phone: data.phone ?? null,
        roles: ['client', 'master']
      });

      const master = createMaster(db, {
        userId: user.id,
        specialization: data.specialization,
        bio: cleanText(data.bio ?? null),
        serviceIds: ids,
        schedule
      });

      return { status: 201, payload: { master: adminMaster(master) } };
    }),
    AUTH
  );

  router.patch(
    '/api/admin/masters/:id',
    asAdmin(async ({ db, params, body }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор мастера.');

      const master = getMaster(db, id);
      if (!master) throw notFound('Мастер не найден.');

      const data = validate(body, MASTER_PATCH_RULES);

      // Имя и телефон живут на пользователе, профиль — в таблице masters.
      if (data.name !== undefined || data.phone !== undefined) {
        updateUserProfile(db, master.user_id, {
          name: data.name,
          phone: data.phone === undefined ? undefined : data.phone
        });
      }

      const updates = {};
      if (data.specialization !== undefined) updates.specialization = data.specialization;
      if (data.bio !== undefined) updates.bio = cleanText(data.bio);
      if (data.isActive !== undefined) updates.is_active = data.isActive ? 1 : 0;

      let updated = master;
      if (Object.keys(updates).length > 0) updated = updateMaster(db, id, updates);

      return { payload: { master: adminMaster(getMaster(db, id)) } };
    }),
    AUTH
  );

  router.put(
    '/api/admin/masters/:id/services',
    asAdmin(async ({ db, params, body }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор мастера.');

      const master = getMaster(db, id);
      if (!master) throw notFound('Мастер не найден.');

      const ids = serviceIds(body.serviceIds);
      replaceMasterServices(db, id, ids);

      return { payload: { master: adminMaster(getMaster(db, id)) } };
    }),
    AUTH
  );

  router.put(
    '/api/admin/masters/:id/schedule',
    asAdmin(async ({ db, params, body }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор мастера.');

      const master = getMaster(db, id);
      if (!master) throw notFound('Мастер не найден.');

      const schedule = checkSchedule(body.schedule);
      replaceMasterSchedule(db, id, schedule);

      return { payload: { master: adminMaster(getMaster(db, id)) } };
    }),
    AUTH
  );

  /* ------------------------------------------------ блокировки времени */

  router.post(
    '/api/admin/masters/:id/blocks',
    asAdmin(async ({ db, params, body, session }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор мастера.');

      const master = getMaster(db, id);
      if (!master) throw notFound('Мастер не найден.');

      const salon = getSalon(db);
      if (!salon) throw notFound('Студия не настроена. Выполните npm run seed.');

      const data = validate(body, BLOCK_RULES);

      const start = toUtcMoment(data.startsAt, salon.timezone);
      const end = toUtcMoment(data.endsAt, salon.timezone);
      if (start === null || end === null) {
        throw badRequest('Время блокировки — в формате 2026-10-24T14:00 (местное время студии).');
      }
      if (end.getTime() <= start.getTime()) {
        throw badRequest('Конец блокировки должен быть позже начала.');
      }
      if (start.getTime() <= Date.now()) {
        throw badRequest('Нельзя заблокировать время в прошлом.');
      }

      // Блокировка не должна «съесть» уже оформленную запись: слот занят
      // клиентом, и молча закрыть его нельзя.
      const busy = db
        .prepare(
          `SELECT id FROM appointments
            WHERE master_id = ? AND status = 'booked'
              AND starts_at < ? AND ends_at > ?
            LIMIT 1`
        )
        .get(id, formatUtc(end), formatUtc(start));
      if (busy) {
        throw conflict(
          'block_conflict',
          `На это время у мастера уже есть запись №${busy.id}. Сначала перенесите или отмените её.`
        );
      }

      const block = createTimeBlock(db, {
        masterId: id,
        startsAtIso: formatUtc(start),
        endsAtIso: formatUtc(end),
        reason: cleanText(data.reason ?? null),
        createdBy: session.user.id
      });

      return { status: 201, payload: { block: publicBlock(block), master: adminMaster(getMaster(db, id)) } };
    }),
    AUTH
  );

  router.delete(
    '/api/admin/blocks/:id',
    asAdmin(async ({ db, params }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор блокировки.');

      if (deleteTimeBlock(db, id) === 0) throw notFound('Блокировка не найдена.');

      return { payload: { deletedId: id } };
    }),
    AUTH
  );

  return router;
}

const BLOCK_RULES = {
  startsAt: { type: 'string', required: true, max: 32 },
  endsAt: { type: 'string', required: true, max: 32 },
  reason: { type: 'string', required: false, max: 120, nullable: true }
};

/**
 * Момент времени из строки блокировки.
 *
 * Принимает местное время студии без зоны (`2026-10-24T14:00` — так его
 * отдаёт поле datetime-local) и полный ISO с зоной (`...T11:00:00Z`).
 * Возвращает Date или null, если строку разобрать нельзя.
 */
function toUtcMoment(text, timezone) {
  const trimmed = String(text).trim();

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const moment = new Date(trimmed);
    return Number.isNaN(moment.getTime()) ? null : moment;
  }

  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(trimmed);
  if (!parts) return null;

  const local = {
    year: Number(parts[1]),
    month: Number(parts[2]),
    day: Number(parts[3]),
    hour: Number(parts[4]),
    minute: Number(parts[5])
  };
  if (!isValidDateString(`${parts[1]}-${parts[2]}-${parts[3]}`)) return null;
  if (local.hour > 23 || local.minute > 59) return null;

  return zonedToUtc(local, timezone);
}

function publicBlock(block) {
  return {
    id: block.id,
    masterId: block.master_id,
    startsAt: block.starts_at,
    endsAt: block.ends_at,
    reason: block.reason ?? null
  };
}

function adminService(service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    durationMin: service.duration_min,
    priceRub: service.price_rub,
    isActive: service.is_active === 1
  };
}

function adminMaster(master) {
  return {
    id: master.id,
    name: master.name,
    email: master.email,
    phone: master.phone ?? null,
    specialization: master.specialization,
    bio: master.bio ?? null,
    isActive: master.is_active === 1,
    services: (master.services ?? []).map(publicService),
    schedule: (master.schedule ?? []).map(publicSchedule),
    blocks: (master.blocks ?? []).map(publicBlock)
  };
}