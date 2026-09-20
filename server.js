'use strict';

/**
 * Небольшой сервер отметки посещаемости без сторонних зависимостей.
 * Данные намеренно хранятся за пределами public/ и записываются атомарно.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
const DATA_FILE = path.join(DATA_DIR, 'attendance.json');
const MAX_JSON_BYTES = 16 * 1024;
const KAZAKHSTAN_TIME_ZONE = process.env.KZ_TIME_ZONE || 'Asia/Qyzylorda';

const PORT = readIntegerConfig('PORT', 3000, 1, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_SESSION_TTL_MINUTES = readIntegerConfig(
  'ADMIN_SESSION_TTL_MINUTES',
  480,
  5,
  1440,
);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const ADMIN_PIN = String(process.env.ADMIN_PIN || '');

const resolvedPublicDir = path.resolve(PUBLIC_DIR);
if (DATA_DIR === resolvedPublicDir || DATA_DIR.startsWith(`${resolvedPublicDir}${path.sep}`)) {
  throw new Error('DATA_DIR не может находиться внутри public/.');
}

if (ADMIN_PIN && !/^\d{4,64}$/.test(ADMIN_PIN)) {
  throw new Error('ADMIN_PIN должен состоять из 4–64 цифр.');
}

// Проверяем временную зону сразу: неверная настройка не должна незаметно менять дату отметки.
try {
  new Intl.DateTimeFormat('en-CA', { timeZone: KAZAKHSTAN_TIME_ZONE }).format();
} catch {
  throw new Error(`Недопустимая временная зона KZ_TIME_ZONE: ${KAZAKHSTAN_TIME_ZONE}`);
}

const datePartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KAZAKHSTAN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dateLabelFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: KAZAKHSTAN_TIME_ZONE,
  dateStyle: 'long',
});
const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: KAZAKHSTAN_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const sessions = new Map();
const rateBuckets = new Map();
let attendanceData = loadAttendanceData();

const server = http.createServer(async (request, response) => {
  setBaseHeaders(response);

  try {
    const requestUrl = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`,
    );

    if (requestUrl.pathname.startsWith('/api/')) {
      await handleApiRequest(request, response, requestUrl);
      return;
    }

    await serveStaticFile(request, response, requestUrl.pathname);
  } catch (error) {
    if (response.writableEnded) return;

    if (error instanceof HttpError) {
      sendJson(response, error.statusCode, { ok: false, message: error.message }, request.method);
      return;
    }

    console.error('[server error]', error);
    sendJson(
      response,
      500,
      { ok: false, message: 'Внутренняя ошибка сервера. Попробуйте ещё раз.' },
      request.method,
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Attendance server: http://${HOST}:${PORT}`);
  console.log(`Дата отметки: ${KAZAKHSTAN_TIME_ZONE}`);
  console.log(`Файл данных: ${DATA_FILE}`);
  if (!ADMIN_PIN) {
    console.warn('Панель преподавателя отключена: перед запуском задайте ADMIN_PIN из 4–64 цифр.');
  }
});

// Не даём интервальным таймерам удерживать процесс, когда сервер уже остановлен.
setInterval(cleanExpiredState, 5 * 60 * 1000).unref();

function readIntegerConfig(name, fallback, min, max) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} должен быть целым числом.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} должен быть в диапазоне ${min}–${max}.`);
  }
  return number;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function handleApiRequest(request, response, requestUrl) {
  const { pathname, searchParams } = requestUrl;
  const method = request.method || 'GET';

  response.setHeader('Cache-Control', 'no-store');

  if (pathname === '/api/status') {
    requireMethod(method, 'GET');
    const dateKey = getKazakhstanDateKey();
    sendJson(response, 200, { dateKey, dateLabel: getDateLabel(dateKey) }, method);
    return;
  }

  if (pathname === '/api/attendance') {
    requireMethod(method, 'POST');
    enforceRateLimit(request, 'attendance', 120, 60 * 1000);
    const body = await readJsonBody(request);
    const fullName = validateFullName(body.fullName);
    const group = validateGroup(body.group);
    const deviceId = validateDeviceId(body.deviceId);
    const dateKey = getKazakhstanDateKey();
    const normalizedFullName = normalizeIdentity(fullName);
    const normalizedGroup = normalizeIdentity(group);
    const deviceHash = hashDeviceId(deviceId);

    const duplicate = findDuplicate(
      dateKey,
      normalizedFullName,
      normalizedGroup,
      deviceHash,
    );
    if (duplicate === 'identity') {
      throw new HttpError(409, 'Вы уже отметились сегодня в этой группе.');
    }
    if (duplicate === 'device') {
      throw new HttpError(
        409,
        'С этого устройства уже отправлена отметка на сегодня. Если это ошибка, обратитесь к преподавателю.',
      );
    }

    const record = {
      id: crypto.randomUUID(),
      fullName,
      group,
      normalizedFullName,
      normalizedGroup,
      deviceHash,
      dateKey,
      markedAt: new Date().toISOString(),
    };

    attendanceData.records.push(record);
    try {
      persistAttendanceData();
    } catch (error) {
      attendanceData.records.pop();
      console.error('[persistence error]', error);
      throw new HttpError(503, 'Не удалось сохранить отметку. Попробуйте ещё раз через минуту.');
    }

    sendJson(
      response,
      201,
      {
        ok: true,
        message: 'Отметка принята.',
        record: {
          id: record.id,
          fullName: record.fullName,
          group: record.group,
          dateKey: record.dateKey,
          markedAt: record.markedAt,
        },
      },
      method,
    );
    return;
  }

  if (pathname === '/api/admin/login') {
    requireMethod(method, 'POST');
    enforceRateLimit(request, 'admin-login', 5, 15 * 60 * 1000);
    if (!ADMIN_PIN) {
      throw new HttpError(503, 'Панель преподавателя не настроена. Укажите ADMIN_PIN на сервере.');
    }

    const body = await readJsonBody(request);
    if (typeof body.pin !== 'string' || !/^\d{4,64}$/.test(body.pin)) {
      throw new HttpError(400, 'Введите PIN из цифр.');
    }
    if (!safePinEqual(body.pin, ADMIN_PIN)) {
      throw new HttpError(401, 'Неверный PIN.');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ADMIN_SESSION_TTL_MINUTES * 60 * 1000;
    sessions.set(token, { expiresAt });
    sendJson(
      response,
      200,
      { ok: true, token, expiresAt: new Date(expiresAt).toISOString() },
      method,
    );
    return;
  }

  if (pathname === '/api/admin/attendance') {
    requireMethod(method, 'GET');
    enforceRateLimit(request, 'admin-read', 120, 60 * 1000);
    requireAdminSession(request);
    const dateKey = getSelectedDate(searchParams.get('date'));
    sendJson(response, 200, buildAttendanceReport(dateKey), method);
    return;
  }

  if (pathname === '/api/admin/export') {
    requireMethod(method, 'GET');
    enforceRateLimit(request, 'admin-export', 30, 60 * 1000);
    requireAdminSession(request);
    const dateKey = getSelectedDate(searchParams.get('date'));
    const csv = buildCsv(dateKey);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="attendance-${dateKey}.csv"`);
    response.setHeader('Content-Length', Buffer.byteLength(csv));
    response.end(method === 'HEAD' ? undefined : csv);
    return;
  }

  throw new HttpError(404, 'Маршрут API не найден.');
}

function requireMethod(actual, expected) {
  if (actual !== expected) {
    throw new HttpError(405, `Используйте метод ${expected}.`);
  }
}

function getSelectedDate(value) {
  const dateKey = value || getKazakhstanDateKey();
  if (!isValidDateKey(dateKey)) {
    throw new HttpError(400, 'Дата должна иметь вид ГГГГ-ММ-ДД.');
  }
  return dateKey;
}

function getKazakhstanDateKey(date = new Date()) {
  const parts = datePartsFormatter.formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function getDateLabel(dateKey) {
  // Полдень UTC исключает сдвиг календарной даты для часовых поясов Казахстана.
  return dateLabelFormatter.format(new Date(`${dateKey}T12:00:00.000Z`));
}

function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateFullName(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Укажите ФИО текстом.');
  }
  const fullName = normalizeDisplayText(value);
  if (fullName.length < 5 || fullName.length > 120) {
    throw new HttpError(400, 'ФИО должно содержать от 5 до 120 символов.');
  }

  const parts = fullName.split(' ');
  const namePart = /^[\p{L}\p{M}][\p{L}\p{M}'-]*$/u;
  if (parts.length < 2 || !parts.every((part) => namePart.test(part))) {
    throw new HttpError(
      400,
      'Введите ФИО без цифр и служебных символов: минимум фамилию и имя.',
    );
  }
  return fullName;
}

function validateGroup(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Укажите группу текстом.');
  }
  const group = normalizeDisplayText(value).toLocaleUpperCase('ru-RU');
  if (group.length < 2 || group.length > 32) {
    throw new HttpError(400, 'Название группы должно содержать от 2 до 32 символов.');
  }
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N} ./_-]*[\p{L}\p{N}])?$/u.test(group)) {
    throw new HttpError(400, 'В названии группы допустимы буквы, цифры, пробел, дефис, «_», «/» и точка.');
  }
  return group;
}

function validateDeviceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new HttpError(400, 'Не удалось подтвердить устройство. Обновите страницу и попробуйте ещё раз.');
  }
  return value;
}

function normalizeDisplayText(value) {
  return value
    .normalize('NFKC')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeIdentity(value) {
  return normalizeDisplayText(value)
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е');
}

function hashDeviceId(deviceId) {
  return crypto.createHash('sha256').update(deviceId, 'utf8').digest('hex');
}

function findDuplicate(dateKey, normalizedFullName, normalizedGroup, deviceHash) {
  for (const record of attendanceData.records) {
    if (record.dateKey !== dateKey) continue;
    if (
      record.normalizedFullName === normalizedFullName &&
      record.normalizedGroup === normalizedGroup
    ) {
      return 'identity';
    }
    if (record.deviceHash === deviceHash) return 'device';
  }
  return null;
}

function safePinEqual(candidate, expected) {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    candidateBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

function requireAdminSession(request) {
  const header = request.headers.authorization;
  const match = typeof header === 'string' && /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  if (!match) {
    throw new HttpError(401, 'Требуется вход преподавателя.');
  }
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(match[1]);
    throw new HttpError(401, 'Сессия преподавателя истекла. Войдите снова.');
  }
}

function buildAttendanceReport(dateKey) {
  const records = recordsForDate(dateKey);
  const groupsByKey = new Map();

  for (const record of records) {
    const groupKey = record.normalizedGroup;
    if (!groupsByKey.has(groupKey)) {
      groupsByKey.set(groupKey, { group: record.group, records: [] });
    }
    groupsByKey.get(groupKey).records.push({
      id: record.id,
      fullName: record.fullName,
      markedAt: record.markedAt,
    });
  }

  const groups = Array.from(groupsByKey.values())
    .map(({ group, records: groupRecords }) => ({
      group,
      total: groupRecords.length,
      students: groupRecords.sort(compareStudents),
    }))
    .sort((left, right) => left.group.localeCompare(right.group, 'ru-RU'));

  return {
    dateKey,
    dateLabel: getDateLabel(dateKey),
    total: records.length,
    groups,
  };
}

function recordsForDate(dateKey) {
  return attendanceData.records
    .filter((record) => record.dateKey === dateKey)
    .slice()
    .sort((left, right) => {
      const groupOrder = left.group.localeCompare(right.group, 'ru-RU');
      return groupOrder || compareStudents(left, right);
    });
}

function compareStudents(left, right) {
  const nameOrder = left.fullName.localeCompare(right.fullName, 'ru-RU');
  return nameOrder || left.markedAt.localeCompare(right.markedAt);
}

function buildCsv(dateKey) {
  const header = ['ФИО', 'Группа', 'Дата', 'Время (Казахстан)'];
  const rows = recordsForDate(dateKey).map((record) => [
    record.fullName,
    record.group,
    record.dateKey,
    timeFormatter.format(new Date(record.markedAt)),
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

function csvCell(value) {
  let cell = String(value);
  // Предотвращает формулы при открытии CSV в Excel/LibreOffice.
  if (/^\s*[=+\-@]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}

function readJsonBody(request) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new HttpError(415, 'Используйте Content-Type: application/json.');
  }

  const announcedSize = Number(request.headers['content-length']);
  if (Number.isFinite(announcedSize) && announcedSize > MAX_JSON_BYTES) {
    request.resume();
    throw new HttpError(413, 'Слишком большой запрос.');
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > MAX_JSON_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => reject(new HttpError(400, 'Не удалось прочитать запрос.')));
    request.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, 'Слишком большой запрос.'));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) throw new Error('empty');
        const parsed = JSON.parse(text);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          throw new Error('not an object');
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Некорректный JSON-запрос.'));
      }
    });
  });
}

function enforceRateLimit(request, scope, limit, windowMs) {
  const ip = getClientIp(request);
  const bucketKey = `${scope}:${ip}`;
  const now = Date.now();
  let bucket = rateBuckets.get(bucketKey);

  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0, windowMs };
    rateBuckets.set(bucketKey, bucket);
  }
  bucket.count += 1;

  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000));
    throw new HttpError(429, `Слишком много запросов. Повторите через ${retryAfter} с.`);
  }
}

function getClientIp(request) {
  if (TRUST_PROXY) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const firstIp = forwarded.split(',')[0].trim();
      if (firstIp) return firstIp;
    }
  }
  return request.socket.remoteAddress || 'unknown';
}

function cleanExpiredState() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.startedAt > bucket.windowMs) rateBuckets.delete(key);
  }
}

function loadAttendanceData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    return { version: 1, records: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`Не удалось прочитать ${DATA_FILE}. Файл не будет перезаписан: ${error.message}`);
  }

  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new Error(`Некорректная структура ${DATA_FILE}. Файл не будет перезаписан.`);
  }

  for (const [index, record] of parsed.records.entries()) {
    validateStoredRecord(record, index);
  }
  return { version: 1, records: parsed.records };
}

function validateStoredRecord(record, index) {
  const invalid =
    !record ||
    typeof record !== 'object' ||
    typeof record.id !== 'string' ||
    typeof record.fullName !== 'string' ||
    typeof record.group !== 'string' ||
    typeof record.normalizedFullName !== 'string' ||
    typeof record.normalizedGroup !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.deviceHash) ||
    !isValidDateKey(record.dateKey) ||
    typeof record.markedAt !== 'string' ||
    Number.isNaN(new Date(record.markedAt).getTime());
  if (invalid) {
    throw new Error(`Некорректная запись №${index + 1} в ${DATA_FILE}. Файл не будет перезаписан.`);
  }
}

function persistAttendanceData() {
  const payload = `${JSON.stringify(
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      records: attendanceData.records,
    },
    null,
    2,
  )}\n`;
  const tempFile = path.join(
    DATA_DIR,
    `.attendance-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let fileDescriptor;

  try {
    fileDescriptor = fs.openSync(tempFile, 'wx', 0o600);
    fs.writeFileSync(fileDescriptor, payload, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(tempFile, DATA_FILE);
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Не скрываем успешную запись из-за невозможности убрать временный файл.
      }
    }
  }
}

async function serveStaticFile(request, response, pathname) {
  const method = request.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw new HttpError(405, 'Для файлов сайта используйте GET.');
  }

  let filePath = resolvePublicPath(pathname);
  if (!filePath) throw new HttpError(400, 'Некорректный путь к файлу.');

  let fileStats;
  try {
    fileStats = fs.statSync(filePath);
  } catch {
    // Удобно для клиентского маршрута /teacher: файл index.html отдаётся как SPA fallback.
    if (!path.extname(pathname)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
      try {
        fileStats = fs.statSync(filePath);
      } catch {
        throw new HttpError(404, 'Страница не найдена.');
      }
    } else {
      throw new HttpError(404, 'Файл не найден.');
    }
  }

  if (!fileStats.isFile()) throw new HttpError(404, 'Файл не найден.');

  const extension = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes.get(extension) || 'application/octet-stream';
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', fileStats.size);
  response.setHeader(
    'Cache-Control',
    extension === '.html' ? 'no-cache' : 'public, max-age=3600',
  );

  if (method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(filePath).on('error', () => {
    if (!response.writableEnded) response.destroy();
  }).pipe(response);
}

function resolvePublicPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes('\0') || decodedPath.includes('\\')) return null;

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(PUBLIC_DIR, relativePath);
  const publicPrefix = `${path.resolve(PUBLIC_DIR)}${path.sep}`;
  if (resolvedPath !== path.resolve(PUBLIC_DIR) && !resolvedPath.startsWith(publicPrefix)) return null;
  return resolvedPath;
}

function setBaseHeaders(response) {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
}

function sendJson(response, statusCode, body, method) {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(payload));
  response.end(method === 'HEAD' ? undefined : payload);
}
