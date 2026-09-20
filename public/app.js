(() => {
  "use strict";

  const TIME_ZONE = "Asia/Qyzylorda";
  const STORAGE_PREFIX = "signal-attendance:";
  const DEVICE_KEY = "signal-device-id";

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    form: $("#student-form"),
    fullName: $("#fullName"),
    group: $("#group"),
    groupStep: $("#group-step"),
    nameStep: $("#name-step"),
    submit: $("#submit-button"),
    message: $("#form-message"),
    stamp: $("#success-stamp"),
    successTime: $("#success-time"),
    dateKeyLabel: $("#dateKeyLabel"),
    formDate: $("#formDate"),
    todayDate: $("#todayDate"),
    todayWeekday: $("#todayWeekday"),
    liveClock: $("#liveClock"),
    path: $(".signal-path"),
    teacherTrigger: $("#teacher-trigger"),
    pinDialog: $("#pin-dialog"),
    pinForm: $("#pin-form"),
    pinInput: $("#admin-pin"),
    pinMessage: $("#pin-message"),
    adminLayer: $("#admin-layer"),
    adminClose: $("#admin-close"),
    adminDate: $("#admin-date"),
    refresh: $("#refresh-button"),
    export: $("#export-button"),
    total: $("#total-count"),
    groupCount: $("#group-count"),
    search: $("#student-search"),
    journalStatus: $("#journal-status"),
    groupGrid: $("#group-grid"),
    emptyTemplate: $("#empty-journal-template"),
  };

  const state = {
    dateKey: localDateKey(),
    dateLabel: "",
    // Токен преподавателя живёт только в памяти этой вкладки.
    adminToken: null,
    dashboardGroups: [],
    submitting: false,
  };

  function localDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value || "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function formatDate(dateKey) {
    const date = new Date(`${dateKey}T12:00:00+05:00`);
    return new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: TIME_ZONE,
    }).format(date);
  }

  function formatWeekday(dateKey) {
    const date = new Date(`${dateKey}T12:00:00+05:00`);
    return new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: TIME_ZONE })
      .format(date)
      .toUpperCase();
  }

  function formatTime(value = new Date()) {
    const date = typeof value === "string" || typeof value === "number" ? new Date(value) : value;
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: TIME_ZONE,
    }).format(date);
  }

  function formatShortTime(value) {
    const full = formatTime(value);
    return full === "—" ? full : full.slice(0, 5);
  }

  function safeRead(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeWrite(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // The server-side duplicate check remains active if storage is blocked.
    }
  }

  function getDeviceId() {
    const stored = safeRead(DEVICE_KEY);
    if (stored && /^[a-zA-Z0-9_-]{16,120}$/.test(stored)) return stored;
    const generated = window.crypto?.randomUUID
      ? window.crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    safeWrite(DEVICE_KEY, generated);
    return generated;
  }

  const deviceId = getDeviceId();

  function attendanceStorageKey() {
    return `${STORAGE_PREFIX}${state.dateKey}:${deviceId}`;
  }

  function loadAttendanceReceipt() {
    const raw = safeRead(attendanceStorageKey());
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function normalizeWords(value) {
    return value.trim().replace(/\s+/g, " ");
  }

  function validFullName(value) {
    const clean = normalizeWords(value);
    const words = clean.split(" ").filter(Boolean);
    return clean.length >= 5 && words.length >= 2;
  }

  function validGroup(value) {
    return normalizeWords(value).length >= 2;
  }

  function setMessage(message, type = "error") {
    elements.message.hidden = !message;
    elements.message.textContent = message || "";
    elements.message.classList.toggle("is-success", type === "success");
  }

  function setPinMessage(message = "") {
    elements.pinMessage.textContent = message;
  }

  function syncPath(step) {
    const items = elements.path?.querySelectorAll("li") || [];
    items.forEach((item, index) => item.classList.toggle("is-active", index <= step));
  }

  function unlockGroup() {
    elements.groupStep.disabled = false;
    elements.groupStep.classList.remove("is-locked");
    syncPath(1);
  }

  function lockGroup() {
    elements.groupStep.disabled = true;
    elements.groupStep.classList.add("is-locked");
    elements.submit.disabled = true;
    syncPath(0);
  }

  function syncStudentForm() {
    if (loadAttendanceReceipt()) return;
    const hasValidName = validFullName(elements.fullName.value);
    if (hasValidName) unlockGroup();
    else lockGroup();

    const canSubmit = hasValidName && validGroup(elements.group.value);
    elements.submit.disabled = !canSubmit || state.submitting;
    if (canSubmit) syncPath(2);
    elements.fullName.setAttribute("aria-invalid", String(elements.fullName.value.length > 0 && !hasValidName));
    elements.group.setAttribute("aria-invalid", String(elements.group.value.length > 0 && !validGroup(elements.group.value)));
  }

  function markSubmitted(receipt, message = "Отметка зарегистрирована. До встречи на занятии!") {
    elements.fullName.value = receipt.fullName || receipt.name || elements.fullName.value;
    elements.group.value = receipt.group || elements.group.value;
    elements.fullName.disabled = true;
    elements.group.disabled = true;
    elements.groupStep.disabled = false;
    elements.groupStep.classList.remove("is-locked");
    elements.submit.disabled = true;
    elements.submit.querySelector("span:nth-child(2)").textContent = "ШТАМП УЖЕ ПОСТАВЛЕН";
    const serverTime = receipt.markedAt || receipt.submittedAt || receipt.createdAt || new Date().toISOString();
    elements.successTime.textContent = formatShortTime(serverTime);
    elements.stamp.classList.add("is-visible");
    setMessage(message, "success");
    syncPath(2);
  }

  function updateHeaderDates() {
    const label = state.dateLabel || formatDate(state.dateKey);
    elements.dateKeyLabel.textContent = state.dateKey;
    elements.formDate.textContent = state.dateKey;
    elements.todayDate.textContent = label;
    elements.todayWeekday.textContent = formatWeekday(state.dateKey);
    elements.adminDate.value = state.dateKey;
    elements.adminDate.max = state.dateKey;
  }

  function updateClock() {
    elements.liveClock.textContent = formatTime();
  }

  async function jsonFetch(url, options = {}) {
    const response = await fetch(url, options);
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(payload?.message || `Ошибка сервера (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function loadStatus() {
    try {
      const status = await jsonFetch("/api/status", { cache: "no-store" });
      if (/^\d{4}-\d{2}-\d{2}$/.test(status?.dateKey || "")) state.dateKey = status.dateKey;
      if (typeof status?.dateLabel === "string" && status.dateLabel) state.dateLabel = status.dateLabel;
    } catch {
      // The interface still works when the initial health call temporarily fails.
    }
    updateHeaderDates();
    const storedReceipt = loadAttendanceReceipt();
    if (storedReceipt) {
      markSubmitted(storedReceipt, "С этого устройства отметка уже была отправлена сегодня.");
    } else {
      syncStudentForm();
    }
  }

  async function submitAttendance(event) {
    event.preventDefault();
    if (state.submitting) return;

    const fullName = normalizeWords(elements.fullName.value);
    const group = normalizeWords(elements.group.value);
    if (!validFullName(fullName)) {
      elements.fullName.focus();
      setMessage("Введите как минимум фамилию и имя.");
      syncStudentForm();
      return;
    }
    if (!validGroup(group)) {
      elements.group.focus();
      setMessage("Укажите группу, чтобы запись попала в нужный журнал.");
      syncStudentForm();
      return;
    }

    const receipt = loadAttendanceReceipt();
    if (receipt) {
      markSubmitted(receipt, "Повторная отметка с этого устройства заблокирована.");
      return;
    }

    state.submitting = true;
    elements.submit.disabled = true;
    elements.submit.querySelector("span:nth-child(2)").textContent = "ПРОВЕРЯЕМ СИГНАЛ…";
    setMessage("");

    try {
      const result = await jsonFetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, group, deviceId }),
      });
      const stored = {
        fullName,
        group,
        submittedAt: result?.record?.markedAt || result?.record?.submittedAt || result?.submittedAt || new Date().toISOString(),
        id: result?.record?.id || result?.id || "",
      };
      safeWrite(attendanceStorageKey(), JSON.stringify(stored));
      markSubmitted(stored);
    } catch (error) {
      if (error.status === 409) {
        setMessage(error.payload?.message || "Эта отметка уже есть в журнале. Повторная запись не создана.");
        elements.submit.querySelector("span:nth-child(2)").textContent = "ПОВТОР ЗАБЛОКИРОВАН";
      } else {
        setMessage(error.message || "Не удалось передать отметку. Проверьте соединение и попробуйте снова.");
        elements.submit.querySelector("span:nth-child(2)").textContent = "ПОСТАВИТЬ ШТАМП";
      }
      state.submitting = false;
      syncStudentForm();
    }
  }

  function clearJournal() {
    elements.groupGrid.replaceChildren();
  }

  function getRecordName(record) {
    return String(record.fullName || record.name || record.student || "Неизвестный студент");
  }

  function getRecordTime(record) {
    return record.markedAt || record.submittedAt || record.createdAt || record.time || "";
  }

  function groupRecords(records) {
    const grouped = new Map();
    (Array.isArray(records) ? records : []).forEach((record) => {
      const name = String(record.group || record.groupName || "Без группы");
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(record);
    });
    return [...grouped.entries()]
      .map(([name, attendees]) => ({ name, attendees }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }

  function normalizeGroups(payload) {
    if (Array.isArray(payload?.groups)) {
      return payload.groups.map((entry) => {
        if (Array.isArray(entry)) return { name: "Без группы", attendees: entry };
        return {
          name: String(entry.group || entry.name || entry.groupName || "Без группы"),
          attendees: Array.isArray(entry.attendees)
            ? entry.attendees
            : Array.isArray(entry.students)
              ? entry.students
              : Array.isArray(entry.records)
                ? entry.records
                : [],
        };
      });
    }
    if (payload?.groups && typeof payload.groups === "object") {
      return Object.entries(payload.groups).map(([name, attendees]) => ({
        name,
        attendees: Array.isArray(attendees) ? attendees : [],
      }));
    }
    return groupRecords(payload?.records || payload?.attendees || []);
  }

  function setJournalStatus(message = "", isError = false) {
    elements.journalStatus.textContent = message;
    elements.journalStatus.classList.toggle("is-error", isError);
  }

  function createAttendee(record) {
    const row = document.createElement("li");
    row.className = "attendee";
    const name = document.createElement("span");
    name.className = "attendee-name";
    name.textContent = getRecordName(record);
    name.title = name.textContent;
    const time = document.createElement("time");
    time.className = "attendee-time";
    time.dateTime = getRecordTime(record);
    time.textContent = formatShortTime(getRecordTime(record));
    row.append(name, time);
    return row;
  }

  function createGroupLane(group) {
    const card = document.createElement("article");
    card.className = "group-lane";
    const queryText = `${group.name} ${group.attendees.map(getRecordName).join(" ")}`.toLocaleLowerCase("ru");
    card.dataset.search = queryText;

    const header = document.createElement("header");
    header.className = "group-header";
    const title = document.createElement("div");
    title.className = "group-title";
    const overline = document.createElement("span");
    overline.textContent = "ГРУППА / ПОТОК";
    const groupName = document.createElement("strong");
    groupName.textContent = group.name;
    title.append(overline, groupName);
    const total = document.createElement("span");
    total.className = "group-total";
    total.title = "Количество отметок";
    total.textContent = String(group.attendees.length).padStart(2, "0");
    header.append(title, total);

    const list = document.createElement("ol");
    list.className = "attendee-list";
    group.attendees
      .slice()
      .sort((a, b) => String(getRecordTime(a)).localeCompare(String(getRecordTime(b))))
      .forEach((record) => list.append(createAttendee(record)));
    card.append(header, list);
    return card;
  }

  function renderJournal(groups) {
    clearJournal();
    const cleanedGroups = groups.filter((group) => group.attendees.length > 0);
    const total = cleanedGroups.reduce((sum, group) => sum + group.attendees.length, 0);
    elements.total.textContent = String(total).padStart(2, "0");
    elements.groupCount.textContent = String(cleanedGroups.length).padStart(2, "0");
    if (!cleanedGroups.length) {
      elements.groupGrid.append(elements.emptyTemplate.content.cloneNode(true));
      return;
    }
    cleanedGroups
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "ru"))
      .forEach((group) => elements.groupGrid.append(createGroupLane(group)));
    filterJournal();
  }

  function filterJournal() {
    const query = elements.search.value.trim().toLocaleLowerCase("ru");
    let visibleGroups = 0;
    elements.groupGrid.querySelectorAll(".group-lane").forEach((lane) => {
      const show = !query || lane.dataset.search.includes(query);
      lane.classList.toggle("is-hidden", !show);
      if (show) visibleGroups += 1;
    });
    if (query && visibleGroups === 0) setJournalStatus("По этому запросу никого не найдено.");
    else if (state.dashboardGroups.length) setJournalStatus(`Журнал обновлён: ${formatDate(elements.adminDate.value)}.`);
  }

  function authHeaders() {
    return state.adminToken ? { Authorization: `Bearer ${state.adminToken}` } : {};
  }

  async function loadJournal() {
    if (!state.adminToken) return;
    const date = elements.adminDate.value || state.dateKey;
    setJournalStatus("Загружаем журнал…");
    try {
      const payload = await jsonFetch(`/api/admin/attendance?date=${encodeURIComponent(date)}`, {
        headers: authHeaders(),
        cache: "no-store",
      });
      state.dashboardGroups = normalizeGroups(payload);
      renderJournal(state.dashboardGroups);
      filterJournal();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        state.adminToken = null;
        closeDashboard();
        elements.pinDialog.showModal();
        setPinMessage("Сеанс завершён. Введите код ещё раз.");
        return;
      }
      setJournalStatus(error.message || "Журнал недоступен. Попробуйте обновить страницу.", true);
    }
  }

  function openDashboard() {
    elements.adminLayer.hidden = false;
    document.body.style.overflow = "hidden";
    elements.search.value = "";
    elements.adminDate.value = state.dateKey;
    loadJournal();
  }

  function closeDashboard() {
    elements.adminLayer.hidden = true;
    document.body.style.overflow = "";
  }

  async function openTeacherArea() {
    setPinMessage("");
    if (state.adminToken) {
      openDashboard();
      return;
    }
    elements.pinInput.value = "";
    elements.pinDialog.showModal();
    window.setTimeout(() => elements.pinInput.focus(), 100);
  }

  async function submitPin(event) {
    event.preventDefault();
    const pin = elements.pinInput.value.trim();
    if (!pin) {
      setPinMessage("Введите код доступа.");
      elements.pinInput.focus();
      return;
    }
    const button = elements.pinForm.querySelector("button[type=submit]");
    button.disabled = true;
    setPinMessage("Проверяем доступ…");
    try {
      const result = await jsonFetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!result?.token) throw new Error("Сервер не выдал токен доступа.");
      state.adminToken = result.token;
      elements.pinDialog.close();
      openDashboard();
    } catch (error) {
      setPinMessage(error.message || "Не удалось открыть журнал.");
      elements.pinInput.select();
    } finally {
      button.disabled = false;
    }
  }

  async function exportCsv() {
    if (!state.adminToken) return;
    const date = elements.adminDate.value || state.dateKey;
    elements.export.disabled = true;
    const initialText = elements.export.textContent;
    elements.export.textContent = "Готовим файл…";
    try {
      const response = await fetch(`/api/admin/export?date=${encodeURIComponent(date)}`, {
        headers: authHeaders(),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const error = new Error(payload?.message || `Не удалось выгрузить CSV (${response.status})`);
        error.status = response.status;
        throw error;
      }
      const file = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = `журнал-посещаемости-${date}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 500);
      setJournalStatus("CSV-файл подготовлен и скачан.");
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        state.adminToken = null;
        closeDashboard();
        elements.pinDialog.showModal();
        setPinMessage("Сеанс завершён. Введите код ещё раз.");
      } else {
        setJournalStatus(error.message, true);
      }
    } finally {
      elements.export.disabled = false;
      elements.export.textContent = initialText;
    }
  }

  elements.fullName.addEventListener("input", () => {
    setMessage("");
    syncStudentForm();
  });
  elements.group.addEventListener("input", () => {
    setMessage("");
    syncStudentForm();
  });
  elements.form.addEventListener("submit", submitAttendance);
  elements.teacherTrigger.addEventListener("click", openTeacherArea);
  elements.pinForm.addEventListener("submit", submitPin);
  elements.pinDialog.addEventListener("close", () => setPinMessage(""));
  elements.adminClose.addEventListener("click", closeDashboard);
  elements.refresh.addEventListener("click", loadJournal);
  elements.adminDate.addEventListener("change", loadJournal);
  elements.search.addEventListener("input", filterJournal);
  elements.export.addEventListener("click", exportCsv);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.adminLayer.hidden) closeDashboard();
  });

  updateClock();
  window.setInterval(updateClock, 1000);
  loadStatus();
})();
