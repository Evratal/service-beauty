/* ==========================================================================
   Административная панель «Ноготочки»: Записи, Услуги, Мастера.

   Подключается вторым скриптом после app.js и переиспользует его
   глобальную лексическую область ($$, esc, money, api, state, inZone,
   showToast, headerHtml, applyHeaderHandlers, DATE- constants). Сама
   панель доступна только пользователю с ролью admin — проверка роли
   выполняется и в маршрутизаторе app.js, и здесь, чтобы закрыть раздел
   клиенту даже при прямом переходе.

   Никаких инлайновых скриптов: Content-Security-Policy это запрещает.
   ========================================================================== */

'use strict';

const adminState = {
  tab: 'appointments',
  services: [],
  masters: [],
  clients: [],
  /* Правка записи: выбор нового слота для переноса. */
  move: { appointmentId: null, date: null, slots: [], selected: null, override: false },
  /* Новая запись: выбор клиента, услуг, мастера и слота. */
  create: { clientId: null, serviceIds: [], masterId: null, date: null, slots: [], selected: null, override: false, busyStarts: [] }
};

function weekdaysChips(days) {
  return days
    .map((day) => {
      const value = localDateKey(day, state.salon?.timezone ?? 'Europe/Moscow');
      return `
        <button class="date-chip" data-role="admin-day" data-date="${value}">
          ${bookingDayLabel(day, state.salon?.timezone ?? 'Europe/Moscow').split(',')[0]}
          <strong>${bookingDayLabel(day, state.salon?.timezone ?? 'Europe/Moscow').split(',')[1]}</strong>
        </button>`;
    })
    .join('');
}

function slotChipsHtml(slots, selected) {
  if (!slots || slots.length === 0) return '<p class="muted small">На эту дату свободных окон нет.</p>';
  return `<div class="slot-grid">${slots
    .map(
      (slot) => `
        <button class="slot ${selected === slot.startsAt ? 'is-active' : ''}" data-role="admin-slot" data-start="${slot.startsAt}" data-end="${slot.endsAt}">
          ${slot.time}
        </button>`
    )
    .join('')}</div>
    <p class="muted tiny">Доступно окон: ${slots.length}.</p>`;
}

function readServiceIdsFromPanel(panel) {
  return [...panel.querySelectorAll('[data-role="admin-service"]:checked')].map((el) => Number(el.value));
}

function adminServiceOptions(selected) {
  return adminState.services
    .map(
      (service) => `
        <label class="option">
          <input type="checkbox" value="${service.id}" data-role="admin-service" ${
            (selected || []).includes(service.id) ? 'checked' : ''
          } />
          <span class="option__text"><strong>${esc(service.name)}</strong> · ${money(service.priceRub)}</span>
          <span class="option__hint">${service.durationMin} мин</span>
        </label>`
    )
    .join('');
}

function adminMasterOptions(selected) {
  const ids = selected || [];
  const filtered = ids.length
    ? adminState.masters.filter((master) => ids.every((id) => master.services.some((s) => s.id === id)))
    : adminState.masters;

  if (filtered.length === 0) return '<p class="muted small">Ни один мастер не выполняет выбранные услуги.</p>';

  return filtered
    .map(
      (master) => `
        <label class="option option--radio">
          <input type="radio" name="admin-master" value="${master.id}" data-role="admin-master" ${
            adminState.create.masterId === master.id ? 'checked' : ''
          } />
          <span class="option__text"><strong>${esc(master.name)}</strong></span>
          <span class="option__hint">${esc(master.specialization)}</span>
        </label>`
    )
    .join('');
}

function clientOptions(selected) {
  return adminState.clients
    .map(
      (client) => `
        <option value="${client.id}" ${selected === client.id ? 'selected' : ''}>${esc(client.name)} — ${esc(client.email)}</option>`
    )
    .join('');
}

/* Редактор графика: 7 строк по дням недели с переключателем и временем. */
function scheduleEditorHtml(schedule) {
  let rows = '';
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const current = (schedule || []).find((s) => s.weekday === weekday);
    const working = current ? current.isWorking : weekday !== 0;
    const start = current ? current.startTime : '10:00';
    const end = current ? current.endTime : '20:00';
    rows += `
      <div class="schedule-row">
        <label class="schedule-row__day">
          <input type="checkbox" name="schedule-work" value="${weekday}" ${working ? 'checked' : ''} />
          <span>${WEEKDAYS[weekday]}</span>
        </label>
        <input class="input input--sm" type="time" name="schedule-start" data-weekday="${weekday}" value="${start}" />
        <span class="muted">—</span>
        <input class="input input--sm" type="time" name="schedule-end" data-weekday="${weekday}" value="${end}" />
      </div>`;
  }
  return rows;
}

function readScheduleFrom(form) {
  const rows = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const working = form.querySelector(`input[name="schedule-work"][value="${weekday}"]`).checked;
    const startInput = form.querySelector(`input[name="schedule-start"][data-weekday="${weekday}"]`);
    const endInput = form.querySelector(`input[name="schedule-end"][data-weekday="${weekday}"]`);
    rows.push({
      weekday,
      startTime: working ? startInput.value : '10:00',
      endTime: working ? endInput.value : '20:00',
      isWorking: working
    });
  }
  return rows;
}

function adminTabsHtml(active) {
  const tabs = [
    ['appointments', 'Записи'],
    ['services', 'Услуги'],
    ['masters', 'Мастера']
  ];
  return `
    <nav class="admin-tabs">
      ${tabs
        .map(
          ([key, label]) => `
            <button class="admin-tab ${active === key ? 'is-active' : ''}" data-admin-tab="${key}">${label}</button>`
        )
        .join('')}
    </nav>`;
}

function statusText(status) {
  return (
    {
      booked: 'Подтверждена',
      completed: 'Выполнена',
      cancelled_by_client: 'Отменена клиентом',
      cancelled_by_salon: 'Отменена салоном',
      no_show: 'Не пришёл'
    }[status] ?? status
  );
}

/* ---------------------------------------------------------------- загрузчик */

async function renderAdmin(app) {
  if (!state.user || !(state.user.roles || []).includes('admin')) {
    app.replaceChildren($$(`<div class="shell">${headerHtml()}${forbiddenHtml()}</div>`));
    applyHeaderHandlers(app);
    return;
  }

  if (!state.salon) {
    const salon = await get('/api/salon');
    state.salon = salon.json ?? null;
  }

  app.replaceChildren(
    $$(`<div class="shell">${headerHtml()}<main class="page section">
      <h1 class="block__title">Административная панель</h1>
      ${adminTabsHtml(adminState.tab)}
      <div id="admin-panel" class="block section--soft"><p class="muted">Загружаю…</p></div>
    </main></div>`)
  );
  applyHeaderHandlers(app);

  app.querySelectorAll('[data-admin-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      adminState.tab = button.dataset.adminTab;
      app.replaceChildren(
        $$(`<div class="shell">${headerHtml()}<main class="page section">
          <h1 class="block__title">Административная панель</h1>
          ${adminTabsHtml(adminState.tab)}
          <div id="admin-panel" class="block section--soft"><p class="muted">Загружаю…</p></div>
        </main></div>`)
      );
      applyHeaderHandlers(app);
      renderPanel(app);
    });
  });

  renderPanel(app);
}

async function renderPanel(app) {
  const panel = app.querySelector('#admin-panel');
  if (!panel) return;
  if (adminState.tab === 'appointments') await renderAppointments(app, panel);
  else if (adminState.tab === 'services') await renderServices(app, panel);
  else await renderMasters(app, panel);
  refreshNoticeCount();
}

/* ---------------------------------------------------------------- Записи */

async function renderAppointments(app, panel) {
  panel.innerHTML = '<p class="muted">Загружаю записи…</p>';

  const [listResult, servicesResult, mastersResult, clientsResult] = await Promise.all([
    get('/api/appointments?scope=all'),
    get('/api/admin/services'),
    get('/api/admin/masters'),
    get('/api/admin/clients')
  ]);

  const appointments = listResult.json?.appointments ?? [];
  adminState.services = servicesResult.json?.services ?? [];
  adminState.masters = mastersResult.json?.masters ?? [];
  adminState.clients = clientsResult.json?.clients ?? [];

  panel.innerHTML = `
    <div class="admin-toolbar">
      <button class="btn btn--primary btn--sm" data-action="admin-new-appointment">Записать клиента</button>
      <button class="btn btn--ghost btn--sm" data-action="admin-reload">Обновить</button>
      <span class="muted small">Всего записей: ${appointments.length} · сначала новые</span>
    </div>

    <div id="admin-create-box" hidden></div>
    <div id="admin-move-box" hidden></div>

    <div class="admin-list">
      ${appointmentCards(appointments)}
    </div>`;

  bindAppointments(app, panel, appointments);
}

function appointmentCards(appointments) {
  const sorted = [...appointments].sort((a, b) => {
    const byCreated = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
    return byCreated !== 0 ? byCreated : b.id - a.id;
  });
  const tz = state.salon?.timezone;

  if (sorted.length === 0) return '<p class="muted">Записей пока нет.</p>';

  return sorted
    .map((appointment) => {
      const serviceNames = appointment.services.map((s) => esc(s.name)).join(', ');
      const override = appointment.isOverride
        ? '<span class="badge badge--warn">Наложена администратором</span>'
        : '';
      const actions =
        appointment.status === 'booked'
          ? `
            <button class="btn btn--ghost btn--sm" data-action="admin-cancel" data-id="${appointment.id}">Отменить</button>
            <button class="btn btn--ghost btn--sm" data-action="admin-move" data-id="${appointment.id}" data-master="${appointment.master.id}" data-services="${appointment.services.map((s) => s.id).join(',')}" data-duration="${appointment.services.reduce((sum, s) => sum + s.durationMin, 0)}">Перенести</button>`
          : '';

      return `
        <div class="work-card admin-appointment" data-appointment="${appointment.id}">
          <div class="summary__row">
            <span>${inZone(appointment.startsAt, tz, 'full')}</span>
            <strong>${esc(appointment.client?.name ?? '')} · ${esc(appointment.client?.email ?? '')}</strong>
          </div>
          <p class="small">${esc(appointment.master?.name)} · ${serviceNames} · ${money(appointment.totalPriceRub)}</p>
          <div class="admin-card__badges">
            <span class="badge ${appointment.status === 'booked' ? 'badge--success' : 'badge--muted'}">${statusText(appointment.status)}</span>
            ${override}
          </div>
          <div class="admin-card__actions">${actions}</div>
        </div>`;
    })
    .join('');
}

async function bindAppointments(app, panel, appointments) {
  const reload = panel.querySelector('[data-action="admin-reload"]');
  if (reload) reload.addEventListener('click', () => renderPanel(app));

  const newBtn = panel.querySelector('[data-action="admin-new-appointment"]');
  if (newBtn) {
    newBtn.addEventListener('click', async () => {
      // Обновляем список клиентов перед показом формы, чтобы новорегистрации
      // не пропускались.
      const clientsResult = await get('/api/admin/clients');
      if (clientsResult.json?.clients) adminState.clients = clientsResult.json.clients;
      adminState.create = { clientId: adminState.clients[0]?.id ?? null, serviceIds: [], masterId: null, date: null, slots: [], selected: null, override: false, busyStarts: [] };
      const box = panel.querySelector('#admin-create-box');
      box.innerHTML = createAppointmentHtml();
      box.hidden = false;
      bindCreateForm(app, panel, box);
    });
  }

  // Отмена с причиной — маленькая форма, добавляется в конец карточки.
  // Слушатели подтверждения вешаются здесь же, при создании формы:
  // querySelectorAll по панели их бы не нашёл — кнопка появляется динамически.
  panel.querySelectorAll('[data-action="admin-cancel"]').forEach((button) => {
    button.addEventListener('click', () => {
      panel.querySelectorAll('.admin-inline-form').forEach((el) => el.remove());
      const card = button.closest('.admin-appointment');
      const form = document.createElement('div');
      form.className = 'admin-inline-form';
      form.innerHTML = `
        <label class="field">Причина отмены (видна клиенту)
          <input class="input" type="text" data-role="cancel-reason" maxlength="200" placeholder="Например: мастер заболел" />
        </label>
        <div class="admin-row">
          <button class="btn btn--primary btn--sm" data-action="admin-cancel-confirm">Отменить запись</button>
          <button class="btn btn--ghost btn--sm" data-action="admin-cancel-close">Закрыть</button>
        </div>`;
      card.appendChild(form);

      form.querySelector('[data-action="admin-cancel-confirm"]').addEventListener('click', async () => {
        const id = Number(button.dataset.id);
        const reason = form.querySelector('[data-role="cancel-reason"]')?.value ?? '';
        const result = await api('POST', `/api/appointments/${id}/cancel`, { reason: reason || null });
        if (result.json?.appointment?.id) {
          showToast('Запись отменена, клиенту отправлено уведомление.', 'success');
        } else {
          showToast(result.json?.error?.message ?? 'Не удалось отменить запись.');
        }
        renderPanel(app);
      });

      form.querySelector('[data-action="admin-cancel-close"]').addEventListener('click', () => form.remove());
    });
  });

  panel.querySelectorAll('[data-action="admin-move"]').forEach((button) => {
    button.addEventListener('click', () => {
      panel.querySelectorAll('.admin-inline-form').forEach((el) => el.remove());
      adminState.move = {
        appointmentId: Number(button.dataset.id),
        masterId: Number(button.dataset.master),
        serviceIds: button.dataset.services ? button.dataset.services.split(',').map(Number) : [],
        durationMin: Number(button.dataset.duration) || 30,
        date: null,
        slots: [],
        selected: null,
        override: false
      };
      const box = panel.querySelector('#admin-move-box');
      box.innerHTML = moveAppointmentHtml();
      box.hidden = false;
      bindMoveForm(app, panel, box);
    });
  });
}

function createAppointmentHtml() {
  return `
    <div class="block section--soft admin-form-box">
      <h3 class="block__title">Новая запись</h3>
      <label class="field">Клиент
        <select class="input" data-role="admin-client">${clientOptions(adminState.create.clientId)}</select>
      </label>
      <h4 class="admin-h">Услуги</h4>
      <div class="option-grid">${adminServiceOptions(adminState.create.serviceIds)}</div>
      <h4 class="admin-h">Мастер</h4>
      <div data-role="admin-masters-box" class="option-grid">${adminMasterOptions(adminState.create.serviceIds)}</div>
      <h4 class="admin-h">Дата</h4>
      <div class="date-row" data-role="admin-days">${weekdaysChips(nextDays(10))}</div>
      <div data-role="admin-slots-box"><p class="muted small">Выберите услугу, мастера и дату.</p></div>
      <label class="option">
        <input type="checkbox" data-role="admin-create-override" />
        <span class="option__text muted">Показать занятые окна и разрешить наложение (крайний случай)</span>
      </label>
      <div class="admin-row">
        <button class="btn btn--primary btn--sm" data-action="admin-create-submit">Создать запись</button>
        <button class="btn btn--ghost btn--sm" data-action="admin-create-close">Закрыть</button>
      </div>
    </div>`;
}

function moveAppointmentHtml() {
  return `
    <div class="block section--soft admin-form-box">
      <h3 class="block__title">Перенос записи №${adminState.move.appointmentId}</h3>
      <h4 class="admin-h">Новая дата</h4>
      <div class="date-row" data-role="admin-move-days">${weekdaysChips(nextDays(10))}</div>
      <div data-role="admin-move-slots"><p class="muted small">Выберите дату, чтобы увидеть свободные окна.</p></div>
      <label class="option">
        <input type="checkbox" data-role="admin-move-override" />
        <span class="option__text muted">Разрешить наложение на занятое время (крайний случай)</span>
      </label>
      <div class="admin-row">
        <button class="btn btn--primary btn--sm" data-action="admin-move-submit">Перенести</button>
        <button class="btn btn--ghost btn--sm" data-action="admin-create-close">Закрыть</button>
      </div>
    </div>`;
}

async function createLoadSlots(panel, box) {
  const m = adminState.create;
  if (!m.masterId || !m.date || m.serviceIds.length === 0) return;
  const params = new URLSearchParams({ date: m.date });
  params.set('serviceIds', m.serviceIds.join(','));
  const slotsBox = box.querySelector('[data-role="admin-slots-box"]');
  slotsBox.innerHTML = '<p class="muted small">Считаю свободное время…</p>';

  // Занятые окна нужны только при включённом наложении: по умолчанию форма
  // показывает свободное время, чтобы не спровоцировать случайный конфликт.
  const busyResult =
    m.override === true
      ? await get(`/api/appointments?scope=all&date=${m.date}&masterId=${m.masterId}`)
      : null;
  const busyAppointments = (busyResult?.json?.appointments ?? []).filter((a) => a.status === 'booked');

  m.slots = (await get(`/api/masters/${m.masterId}/slots?${params}`)).json?.slots ?? [];
  m.busyStarts = busyAppointments.map((a) => a.startsAt);
  m.selected = null;

  const busyHtml =
    busyAppointments.length === 0
      ? ''
      : `<h5 class="admin-h">Занятые окна</h5><div class="slot-grid">${busyAppointments
          .map(
            (a) => `
          <button class="slot slot--busy" data-role="admin-slot" data-busy="1" data-start="${a.startsAt}">
            ${inZone(a.startsAt, state.salon.timezone, 'time')} (занято)
          </button>`
          )
          .join('')}</div>
      <p class="muted tiny">Выбранное занятое окно потребует подтверждения.</p>`;

  slotsBox.innerHTML = `${slotChipsHtml(m.slots, m.selected)}${busyHtml}`;
  bindSlotClicks(box);
}

async function moveLoadSlots(panel, box) {
  const m = adminState.move;
  if (!m.masterId || !m.date) return;
  const params = new URLSearchParams({ date: m.date });
  if (m.serviceIds.length) params.set('serviceIds', m.serviceIds.join(','));

  const slotsBox = box.querySelector('[data-role="admin-move-slots"]');
  slotsBox.innerHTML = '<p class="muted small">Считаю свободное время…</p>';
  const response = await get(`/api/masters/${m.masterId}/slots?${params}`);
  m.slots = response.json?.slots ?? [];
  m.selected = null;
  slotsBox.innerHTML = slotChipsHtml(m.slots, m.selected);
  bindSlotClicks(box);
}

function bindSlotClicks(box) {
  box.querySelectorAll('[data-role="admin-slot"]').forEach((slot) => {
    slot.addEventListener('click', () => {
      const isCreateBox = Boolean(box.querySelector('[data-role="admin-slots-box"]'));
      // Занятое окно в форме создания выбирается только при включённом наложении.
      if (isCreateBox && slot.dataset.busy === '1' && !adminState.create.override) return;
      box.querySelectorAll('[data-role="admin-slot"]').forEach((el) => el.classList.remove('is-active'));
      slot.classList.add('is-active');
      if (isCreateBox) adminState.create.selected = slot.dataset.start;
      if (box.querySelector('[data-role="admin-move-slots"]')) adminState.move.selected = slot.dataset.start;
    });
  });
}

function bindCreateForm(app, panel, box) {
  const client = box.querySelector('[data-role="admin-client"]');
  if (client) client.addEventListener('change', () => (adminState.create.clientId = Number(client.value)));

  box.querySelectorAll('[data-role="admin-service"]').forEach((input) => {
    input.addEventListener('change', () => {
      adminState.create.serviceIds = readServiceIdsFromPanel(box);
      adminState.create.masterId = null;
      adminState.create.date = null;
      adminState.create.slots = [];
      adminState.create.selected = null;
      box.querySelector('[data-role="admin-masters-box"]').innerHTML = adminMasterOptions(adminState.create.serviceIds);
      box.querySelector('[data-role="admin-slots-box"]').innerHTML = '<p class="muted small">Выберите дату.</p>';
      bindMasterOptions(box);
      box.querySelectorAll('[data-role="admin-day"]').forEach((day) => day.classList.remove('is-active'));
    });
  });

  bindMasterOptions(box);

  const overrideInput = box.querySelector('[data-role="admin-create-override"]');
  if (overrideInput) {
    overrideInput.addEventListener('change', () => {
      adminState.create.override = overrideInput.checked;
      if (adminState.create.masterId && adminState.create.date) createLoadSlots(app, box);
    });
  }

  box.querySelectorAll('[data-role="admin-day"]').forEach((day) => {
    day.addEventListener('click', () => {
      box.querySelectorAll('[data-role="admin-day"]').forEach((el) => el.classList.remove('is-active'));
      day.classList.add('is-active');
      adminState.create.date = day.dataset.date;
      adminState.create.selected = null;
      createLoadSlots(app, box);
    });
  });

  const close = box.querySelector('[data-action="admin-create-close"]');
  if (close) close.addEventListener('click', () => createClose(panel));

  const submit = box.querySelector('[data-action="admin-create-submit"]');
  if (submit) {
    submit.addEventListener('click', async () => {
      const m = adminState.create;
      if (!m.clientId) return showToast('Выберите клиента.');
      if (m.serviceIds.length === 0) return showToast('Выберите хотя бы одну услугу.');
      if (!m.masterId) return showToast('Выберите мастера.');
      if (!m.selected) return showToast('Выберите время.');

      // Наложение на занятое время — только по явному подтверждению.
      const isOverride = (m.busyStarts || []).includes(m.selected);
      if (isOverride && !window.confirm('Выбранное время занято записью другого клиента. Создать запись с наложением?')) {
        return;
      }

      const result = await api('POST', '/api/appointments', {
        masterId: m.masterId,
        serviceIds: m.serviceIds,
        clientId: m.clientId,
        startsAt: m.selected,
        isOverride: isOverride
      });
      if (result.json?.appointment?.id) {
        showToast('Запись создана, клиенту отправлено уведомление.', 'success');
        createClose(panel);
        renderPanel(app);
      } else {
        showToast(result.json?.error?.message ?? 'Не удалось создать запись.');
      }
    });
  }
}

function bindMasterOptions(box) {
  box.querySelectorAll('[data-role="admin-master"]').forEach((input) => {
    input.addEventListener('change', () => {
      adminState.create.masterId = Number(input.value);
      adminState.create.date = null;
      adminState.create.slots = [];
      adminState.create.selected = null;
      box.querySelector('[data-role="admin-slots-box"]').innerHTML = '<p class="muted small">Выберите дату.</p>';
      box.querySelectorAll('[data-role="admin-day"]').forEach((day) => day.classList.remove('is-active'));
    });
  });
}

function bindMoveForm(app, panel, box) {
  const dayButtons = box.querySelectorAll('[data-role="admin-day"]');
  dayButtons.forEach((day) => {
    day.addEventListener('click', () => {
      dayButtons.forEach((el) => el.classList.remove('is-active'));
      day.classList.add('is-active');
      adminState.move.date = day.dataset.date;
      adminState.move.selected = null;
      moveLoadSlots(app, box);
    });
  });

  const override = box.querySelector('[data-role="admin-move-override"]');
  if (override) {
    override.addEventListener('change', () => {
      adminState.move.override = override.checked;
    });
  }

  const submit = box.querySelector('[data-action="admin-move-submit"]');
  if (submit) {
    submit.addEventListener('click', async () => {
      const m = adminState.move;
      if (!m.date) return showToast('Выберите новую дату.');
      if (!m.selected) return showToast('Выберите новое время.');

      const result = await api('POST', `/api/appointments/${m.appointmentId}/reschedule`, {
        startsAt: m.selected,
        isOverride: m.override
      });
      if (result.json?.appointment?.id) {
        showToast('Запись перенесена, клиенту отправлено уведомление.', 'success');
        createClose(panel);
        renderPanel(app);
      } else {
        showToast(result.json?.error?.message ?? 'Не удалось перенести запись.');
      }
    });
  }

  const close = box.querySelector('[data-action="admin-create-close"]');
  if (close) close.addEventListener('click', () => createClose(panel));
}

function createClose(panel) {
  const box = panel.querySelector('#admin-create-box');
  const moveBox = panel.querySelector('#admin-move-box');
  if (box) {
    box.innerHTML = '';
    box.hidden = true;
  }
  if (moveBox) {
    moveBox.innerHTML = '';
    moveBox.hidden = true;
  }
}

/* ---------------------------------------------------------------- услуги */

async function renderServices(app, panel) {
  panel.innerHTML = '<p class="muted">Загружаю услуги…</p>';

  const result = await get('/api/admin/services');
  const services = result.json?.services ?? [];

  panel.innerHTML = `
    <div class="admin-toolbar">
      <button class="btn btn--ghost btn--sm" data-action="admin-reload">Обновить</button>
    </div>

    <div class="block section--soft admin-form-box" id="admin-service-form-box">
      <h3 class="block__title">Добавить услугу</h3>
      <form data-role="admin-service-form" class="admin-form">
        <label class="field">Название<input class="input" name="name" required minlength="2" maxlength="120" /></label>
        <label class="field">Описание<textarea class="notes" name="description" maxlength="500"></textarea></label>
        <div class="admin-form__row">
          <label class="field">Длительность, мин<input class="input" name="durationMin" type="number" min="5" max="720" required /></label>
          <label class="field">Цена, ₽<input class="input" name="priceRub" type="number" min="0" max="1000000" required /></label>
        </div>
        <button class="btn btn--primary btn--sm" type="submit">Добавить</button>
      </form>
    </div>

    <div class="admin-list">${serviceCards(services)}</div>`;

  const form = panel.querySelector('[data-role="admin-service-form"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    body.durationMin = Number(body.durationMin);
    body.priceRub = Number(body.priceRub);
    const result = await api('POST', '/api/admin/services', body);
    if (result.json?.service?.id) {
      showToast('Услуга добавлена.', 'success');
      renderPanel(app);
    } else {
      showToast(result.json?.error?.message ?? 'Не удалось добавить услугу.');
    }
  });

  const reload = panel.querySelector('[data-action="admin-reload"]');
  if (reload) reload.addEventListener('click', () => renderPanel(app));

  panel.querySelectorAll('[data-action="admin-service-toggle"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.id);
      const endpoint = `/api/admin/services/${id}`;
      await api('PATCH', endpoint, { isActive: button.dataset.state !== '1' });
      renderPanel(app);
    });
  });

  panel.querySelectorAll('[data-role="admin-service-edit"]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = Number(form.dataset.id);
      const body = Object.fromEntries(new FormData(form).entries());
      body.durationMin = Number(body.durationMin);
      body.priceRub = Number(body.priceRub);
      const result = await api('PATCH', `/api/admin/services/${id}`, body);
      if (result.json?.service?.id) {
        showToast('Услуга сохранена.', 'success');
        renderPanel(app);
      } else {
        showToast(result.json?.error?.message ?? 'Не удалось сохранить услугу.');
      }
    });
  });
}

function serviceCards(services) {
  if (services.length === 0) return '<p class="muted">Услуг пока нет.</p>';
  return services
    .map(
      (service) => `
        <div class="work-card">
          <form data-role="admin-service-edit" data-id="${service.id}" class="admin-form">
            <div class="admin-form__row">
              <label class="field">Название<input class="input" name="name" value="${esc(service.name)}" required /></label>
              <label class="field">Длительность<input class="input" name="durationMin" type="number" value="${service.durationMin}" required /></label>
              <label class="field">Цена<input class="input" name="priceRub" type="number" value="${service.priceRub}" required /></label>
            </div>
            <label class="field">Описание<textarea class="notes" name="description" maxlength="500">${esc(service.description ?? '')}</textarea></label>
            <div class="admin-row">
              <button class="btn btn--primary btn--sm" type="submit">Сохранить</button>
              <button class="btn btn--ghost btn--sm" type="button" data-action="admin-service-toggle" data-id="${service.id}" data-state="${service.isActive ? '1' : '0'}">
                ${service.isActive ? 'Выключить' : 'Включить'}
              </button>
              <span class="badge ${service.isActive ? 'badge--success' : 'badge--muted'}">${service.isActive ? 'Активна' : 'Выключена'}</span>
            </div>
          </form>
        </div>`
    )
    .join('');
}

/* ---------------------------------------------------------------- мастера */

async function renderMasters(app, panel) {
  panel.innerHTML = '<p class="muted">Загружаю мастеров…</p>';

  const [mastersResult, servicesResult] = await Promise.all([
    get('/api/admin/masters'),
    get('/api/admin/services')
  ]);
  const masters = mastersResult.json?.masters ?? [];
  adminState.services = servicesResult.json?.services ?? [];

  panel.innerHTML = `
    <div class="admin-toolbar">
      <button class="btn btn--ghost btn--sm" data-action="admin-reload">Обновить</button>
    </div>

    <div class="block section--soft admin-form-box" id="admin-master-form-box">
      <h3 class="block__title">Добавить мастера</h3>
      <form data-role="admin-master-form" class="admin-form">
        <div class="admin-form__row">
          <label class="field">Имя<input class="input" name="name" required minlength="2" /></label>
          <label class="field">E-mail<input class="input" name="email" type="email" required /></label>
        </div>
        <div class="admin-form__row">
          <label class="field">Телефон<input class="input" name="phone" /></label>
          <label class="field">Пароль для входа<input class="input" name="password" type="password" minlength="8" required /></label>
        </div>
        <label class="field">Специализация<input class="input" name="specialization" required minlength="2" /></label>
        <label class="field">О себе<textarea class="notes" name="bio" maxlength="1000"></textarea></label>
        <h4 class="admin-h">Услуги</h4>
        <div class="option-grid" data-role="master-services">${adminServiceOptions([])}</div>
        <h4 class="admin-h">График</h4>
        <div class="schedule-editor" data-role="master-schedule">${scheduleEditorHtml([])}</div>
        <button class="btn btn--primary btn--sm" type="submit">Добавить мастера</button>
      </form>
    </div>

    <div class="admin-list">${masterCards(masters)}</div>`;

  const form = panel.querySelector('[data-role="admin-master-form"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    const serviceIds = readServiceIdsFromPanel(form);
    const schedule = readScheduleFrom(form);
    const result = await api('POST', '/api/admin/masters', { ...body, serviceIds, schedule });
    if (result.json?.master?.id) {
      showToast('Мастер добавлен.', 'success');
      renderPanel(app);
    } else {
      showToast(result.json?.error?.message ?? 'Не удалось добавить мастера.');
    }
  });

  const reload = panel.querySelector('[data-action="admin-reload"]');
  if (reload) reload.addEventListener('click', () => renderPanel(app));

  panel.querySelectorAll('[data-action="admin-master-toggle"]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api('PATCH', `/api/admin/masters/${button.dataset.id}`, { isActive: button.dataset.state !== '1' });
      renderPanel(app);
    });
  });

  panel.querySelectorAll('[data-role="admin-master-edit"]').forEach((editForm) => {
    editForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = Number(editForm.dataset.id);
      const overrides = {
        name: editForm.querySelector('[name="edit-name"]')?.value,
        phone: editForm.querySelector('[name="edit-phone"]')?.value,
        specialization: editForm.querySelector('[name="edit-specialization"]')?.value,
        bio: editForm.querySelector('[name="edit-bio"]')?.value
      };
      const payload = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
      const result = await api('PATCH', `/api/admin/masters/${id}`, payload);
      if (result.json?.master?.id) {
        showToast('Профиль мастера сохранён.', 'success');
        renderPanel(app);
      } else {
        showToast(result.json?.error?.message ?? 'Не удалось сохранить.');
      }
    });
  });

  panel.querySelectorAll('[data-role="admin-master-services"]').forEach((servicesForm) => {
    servicesForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = Number(servicesForm.dataset.id);
      const serviceIds = readServiceIdsFromPanel(servicesForm);
      const result = await api('PUT', `/api/admin/masters/${id}/services`, { serviceIds });
      if (result.json?.master?.id) {
        showToast('Набор услуг мастера сохранён.', 'success');
        renderPanel(app);
      } else {
        showToast(result.json?.error?.message ?? 'Не удалось сохранить.');
      }
    });
  });

  panel.querySelectorAll('[data-role="admin-master-schedule"]').forEach((scheduleForm) => {
    scheduleForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = Number(scheduleForm.dataset.id);
      const schedule = readScheduleFrom(scheduleForm);
      const result = await api('PUT', `/api/admin/masters/${id}/schedule`, { schedule });
      if (result.json?.master?.id) {
        showToast('График мастера сохранён.', 'success');
        renderPanel(app);
      } else {
        showToast(result.json?.error?.message ?? 'Не удалось сохранить.');
      }
    });
  });

  panel.querySelectorAll('[data-role="admin-block-form"]').forEach((blockForm) => {
    blockForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = Number(blockForm.dataset.id);
      const body = Object.fromEntries(new FormData(blockForm).entries());
      const result = await api('POST', `/api/admin/masters/${id}/blocks`, {
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        reason: body.reason ? body.reason : null
      });
      if (result.json?.block?.id) {
        showToast('Время заблокировано.', 'success');
        renderPanel(app);
      } else {
        showToast(result.json?.error?.message ?? 'Не удалось заблокировать время.');
      }
    });
  });

  panel.querySelectorAll('[data-action="admin-block-delete"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await api('DELETE', `/api/admin/blocks/${button.dataset.id}`);
      if (result.json?.deletedId) {
        showToast('Блокировка снята.', 'success');
        renderPanel(app);
      } else {
        showToast(result.json?.error?.message ?? 'Не удалось снять блокировку.');
      }
    });
  });
}

function masterCards(masters) {
  if (masters.length === 0) return '<p class="muted">Мастеров пока нет.</p>';
  const tz = state.salon?.timezone;

  return masters
    .map((master) => {
      const workingDays = (master.schedule || []).filter((s) => s.isWorking).length;
      const scheduleSummary =
        workingDays > 0
          ? `работает ${workingDays} дн. в неделю`
          : 'нет рабочего графика';

      return `
        <div class="work-card admin-master">
          <div class="summary__row">
            <span><strong>${esc(master.name)}</strong> · ${esc(master.email)}</span>
            <span class="badge ${master.isActive ? 'badge--success' : 'badge--muted'}">${master.isActive ? 'Активен' : 'Выключен'}</span>
          </div>
          <p class="small">${esc(master.specialization)} · ${esc(master.phone ?? '')} · ${scheduleSummary}</p>
          <p class="muted small">Услуги: ${master.services.map((s) => esc(s.name)).join(', ') || 'не выбраны'}</p>

          <details class="admin-details">
            <summary>Изменить профиль</summary>
            <form data-role="admin-master-edit" data-id="${master.id}" class="admin-form">
              <div class="admin-form__row">
                <label class="field">Имя<input class="input" name="edit-name" value="${esc(master.name)}" /></label>
                <label class="field">Телефон<input class="input" name="edit-phone" value="${esc(master.phone ?? '')}" /></label>
              </div>
              <label class="field">Специализация<input class="input" name="edit-specialization" value="${esc(master.specialization)}" /></label>
              <label class="field">О себе<textarea class="notes" name="edit-bio" maxlength="1000">${esc(master.bio ?? '')}</textarea></label>
              <div class="admin-row">
                <button class="btn btn--primary btn--sm" type="submit">Сохранить</button>
                <button class="btn btn--ghost btn--sm" type="button" data-action="admin-master-toggle" data-id="${master.id}" data-state="${master.isActive ? '1' : '0'}">
                  ${master.isActive ? 'Выключить' : 'Включить'}
                </button>
              </div>
            </form>
          </details>

          <details class="admin-details">
            <summary>Услуги мастера</summary>
            <form data-role="admin-master-services" data-id="${master.id}" class="admin-form">
              <div class="option-grid">${adminServiceOptions(master.services.map((s) => s.id))}</div>
              <button class="btn btn--primary btn--sm" type="submit">Сохранить услуги</button>
            </form>
          </details>

          <details class="admin-details">
            <summary>График</summary>
            <form data-role="admin-master-schedule" data-id="${master.id}" class="admin-form">
              <div class="schedule-editor">${scheduleEditorHtml(master.schedule)}</div>
              <button class="btn btn--primary btn--sm" type="submit">Сохранить график</button>
            </form>
          </details>

          <details class="admin-details">
            <summary>Блокировки времени</summary>
            <form data-role="admin-block-form" data-id="${master.id}" class="admin-form">
              <div class="admin-form__row">
                <label class="field">Начало<input class="input" name="startsAt" type="datetime-local" required /></label>
                <label class="field">Конец<input class="input" name="endsAt" type="datetime-local" required /></label>
              </div>
              <label class="field">Причина<input class="input" name="reason" maxlength="120" placeholder="Обед, санитарный час, отпуск" /></label>
              <button class="btn btn--primary btn--sm" type="submit">Заблокировать время</button>
            </form>
            ${blockRows(master.blocks, tz)}
          </details>
        </div>`;
    })
    .join('');
}

/* Список разовых блокировок мастера с кнопкой снятия. */
function blockRows(blocks, tz) {
  if (!blocks || blocks.length === 0) {
    return '<p class="muted small">Разовых блокировок нет.</p>';
  }

  return `<ul class="admin-list admin-blocks">${blocks
    .map(
      (block) => `
        <li class="summary__row">
          <span class="small">${esc(inZone(block.startsAt, tz, 'full'))} — ${esc(inZone(block.endsAt, tz, 'time'))}${block.reason ? ' · ' + esc(block.reason) : ''}</span>
          <button class="btn btn--ghost btn--sm" type="button" data-action="admin-block-delete" data-id="${block.id}">Снять</button>
        </li>`
    )
    .join('')}</ul>`;
}

/* Экспорт для маршрутизатора app.js. */
window.__topbroAdmin = { renderAdmin };