/**
 * Доступ к справочным данным: студия, услуги, мастера, расписание.
 *
 * Это публичная часть сервиса — её видит любой посетитель сайта, поэтому
 * запросы здесь не фильтруются по пользователю. Административные функции
 * (создание, изменение, мягкое отключение) собраны в конце файла.
 */

import { withTransaction } from '../db.js';
import { utcNow } from '../security.js';

export function getSalon(db) {
  return db.prepare('SELECT * FROM salon WHERE id = 1').get() ?? null;
}

export function listServices(db, { onlyActive = true } = {}) {
  const where = onlyActive ? 'WHERE is_active = 1' : '';
  return db.prepare(`SELECT * FROM services ${where} ORDER BY name`).all();
}

export function getService(db, id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id) ?? null;
}

/**
 * Услуги по списку идентификаторов. Возвращает только те, что найдены и активны.
 * Порядок сохраняется, чтобы ответ совпадал с порядком на экране.
 */
export function servicesByIds(db, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM services WHERE id IN (${placeholders}) AND is_active = 1`)
    .all(...ids);

  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Мастера, у которых есть ВСЕ перечисленные услуги.
 *
 * Именно «все», а не «хотя бы одна»: клиент отметил стрижку и камуфляж,
 * и мастер, который делает только стрижку, попасть в список не должен.
 */
export function listMasters(db, { serviceIds = [], onlyActive = true } = {}) {
  const masters = db
    .prepare(
      `SELECT m.id, m.user_id, m.specialization, m.bio, m.is_active,
              u.name, u.phone
         FROM masters m
         JOIN users u ON u.id = m.user_id
        WHERE (? = 0 OR m.is_active = 1)
        ORDER BY u.name`
    )
    .all(onlyActive ? 1 : 0);

  if (serviceIds.length === 0) return masters.map((master) => ({ ...master, services: servicesOfMaster(db, master.id) }));

  const placeholders = serviceIds.map(() => '?').join(',');
  const fitting = new Set(
    db
      .prepare(
        `SELECT master_id
           FROM master_services
          WHERE service_id IN (${placeholders})
          GROUP BY master_id
         HAVING COUNT(DISTINCT service_id) = ?`
      )
      .all(...serviceIds, serviceIds.length)
      .map((row) => row.master_id)
  );

  return masters
    .filter((master) => fitting.has(master.id))
    .map((master) => ({ ...master, services: servicesOfMaster(db, master.id) }));
}

export function getMaster(db, id) {
  const master = db
    .prepare(
      `SELECT m.id, m.user_id, m.specialization, m.bio, m.is_active, u.name, u.phone
         FROM masters m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = ?`
    )
    .get(id);
  if (!master) return null;
  return {
    ...master,
    services: servicesOfMaster(db, id),
    schedule: getSchedule(db, id),
    blocks: listMasterBlocks(db, id)
  };
}

/**
 * Разовые блокировки времени мастера (таблица time_blocks): санитарный час,
 * отпуск, личное время на конкретную дату. Повторяющиеся блокировки живут
 * в schedule_blocks и в этот список не попадают.
 */
export function listMasterBlocks(db, masterId) {
  return db
    .prepare('SELECT * FROM time_blocks WHERE master_id = ? ORDER BY starts_at')
    .all(masterId);
}

/** Удаляет разовую блокировку. Возвращает число удалённых строк. */
export function deleteTimeBlock(db, id) {
  return db.prepare('DELETE FROM time_blocks WHERE id = ?').run(id).changes;
}

export function servicesOfMaster(db, masterId) {
  return db
    .prepare(
      `SELECT s.*
         FROM master_services ms
         JOIN services s ON s.id = ms.service_id
        WHERE ms.master_id = ? AND s.is_active = 1
        ORDER BY s.name`
    )
    .all(masterId);
}

/** График мастера по дням недели, 0 — воскресенье. */
export function getSchedule(db, masterId) {
  return db
    .prepare('SELECT * FROM schedules WHERE master_id = ? ORDER BY weekday')
    .all(masterId);
}

/** Заменяет график мастера целиком. Использует только администратор. */
export function replaceSchedule(db, masterId, rows) {
  const insert = db.prepare(
    'INSERT INTO schedules (master_id, weekday, start_time, end_time, is_working) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(masterId, row.weekday, row.start_time, row.end_time, row.is_working ? 1 : 0);
  }
}

export function listTimeBlocks(db, masterId, fromIso, toIso) {
  return db
    .prepare(
      `SELECT * FROM time_blocks
        WHERE master_id = ? AND starts_at < ? AND ends_at > ?
        ORDER BY starts_at`
    )
    .all(masterId, toIso, fromIso);
}

/* ---------------------------------------------------------------------------
   Административные функции.
   Здесь работают только с ролью admin: проверка роли живёт в маршруте,
   а этот слой лишь выполняет запросы. Мягкое отключение (is_active = 0)
   прячет объект из клиентских списков, но сохраняет его в истории записей.
   --------------------------------------------------------------------------- */

/** Все услуги, включая отключённые, и одна услуга. */
export function listAdminServices(db) {
  return db.prepare('SELECT * FROM services ORDER BY name').all();
}

/** Создаёт услугу. */
export function createService(db, { name, description = null, durationMin, priceRub }) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO services (name, description, duration_min, price_rub, is_active, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`
      )
      .run(name, description, durationMin, priceRub, utcNow()).lastInsertRowid
  );
  return getService(db, id);
}

/** Обновляет услугу. updates — объект с колонками из белого списка маршрута. */
export function updateService(db, id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) throw new Error('Нет полей для обновления услуги');

  const sets = keys.map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE services SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
  return getService(db, id);
}

/** Все мастера, включая отключённых, с услугами и графиком. */
export function listAdminMasters(db) {
  const masters = db
    .prepare(
      `SELECT m.id, m.user_id, m.specialization, m.bio, m.is_active, u.name, u.email, u.phone
         FROM masters m
         JOIN users u ON u.id = m.user_id
        ORDER BY u.name`
    )
    .all();

  return masters.map((master) => ({
    ...master,
    services: servicesOfMaster(db, master.id),
    schedule: getSchedule(db, master.id),
    blocks: listMasterBlocks(db, master.id)
  }));
}

/**
 * Создаёт мастера.
 *
 * Учётная запись пользователя (e-mail, пароль, роли client+master) создаётся
 * маршрутом до вызова этой функции: пароль хешируется там же, где и при
 * регистрации.
 */
export function createMaster(db, { userId, specialization, bio = null, serviceIds = [], schedule = [] }) {
  const id = withTransaction(db, () => {
    const masterId = Number(
      db
        .prepare('INSERT INTO masters (user_id, specialization, bio, is_active) VALUES (?, ?, ?, 1)')
        .run(userId, specialization, bio).lastInsertRowid
    );

    const link = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
    for (const serviceId of serviceIds) link.run(masterId, serviceId);

    insertScheduleRows(db, masterId, schedule);
    return masterId;
  });

  return getMaster(db, id);
}

/** Обновляет профиль мастера. updates — колонки таблицы masters. */
export function updateMaster(db, id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) throw new Error('Нет полей для обновления мастера');

  const sets = keys.map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE masters SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
  return getMaster(db, id);
}

/** Заменяет набор услуг мастера целиком. */
export function replaceMasterServices(db, masterId, serviceIds) {
  withTransaction(db, () => {
    db.prepare('DELETE FROM master_services WHERE master_id = ?').run(masterId);
    const link = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
    for (const serviceId of serviceIds) link.run(masterId, serviceId);
  });
}

/** Заменяет график мастера целиком. */
export function replaceMasterSchedule(db, masterId, schedule) {
  withTransaction(db, () => {
    db.prepare('DELETE FROM schedules WHERE master_id = ?').run(masterId);
    insertScheduleRows(db, masterId, schedule);
  });
}

function insertScheduleRows(db, masterId, rows) {
  const insert = db.prepare(
    'INSERT INTO schedules (master_id, weekday, start_time, end_time, is_working) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(masterId, row.weekday, row.start_time, row.end_time, row.is_working ? 1 : 0);
  }
}
