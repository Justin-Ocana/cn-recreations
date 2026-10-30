// Biblioteca de bumpers: una carpeta del disco con videos .mp4 que elige el usuario.
//
// El navegador solo deja leer una carpeta si el usuario la elige en un dialogo
// (showDirectoryPicker) y da permiso con un clic. Se guarda el "handle" de la carpeta en
// IndexedDB para no tener que elegirla de nuevo; el permiso, en cambio, hay que volver a
// pedirlo en cada sesion (se hace al pulsar Play, que ya es un clic del usuario).

const DB_NAME = "cn-player";
const STORE = "kv";
const KEY = "bumpers-folder";

const MAX_DEPTH = 6;
const MAX_FILES = 5000;

// Solo .mp4 (y se ignoran los archivos basura "._x.mp4" que macOS deja en discos externos).
export const isVideoName = (name) => /\.mp4$/i.test(name) && !name.startsWith("._");

// Recorre la carpeta (y sus subcarpetas) y devuelve [{ id, name, handle }].
export async function scanFolder(dir, { path = "", depth = 0, limit = MAX_FILES } = {}) {
  const out = [];
  if (depth > MAX_DEPTH) return out;
  for await (const [name, handle] of dir.entries()) {
    if (out.length >= limit) break;
    if (handle.kind === "file") {
      if (isVideoName(name)) out.push({ id: path + name, name, handle });
    } else if (handle.kind === "directory") {
      out.push(...(await scanFolder(handle, { path: `${path}${name}/`, depth: depth + 1, limit: limit - out.length })));
    }
  }
  return out;
}

// Elige un bumper al azar sin repetir los ultimos (aunque haya pocos) y sin los marcados como malos.
export function pickBumper(list, { history = [], bad = new Set(), rand = Math.random } = {}) {
  const ok = list.filter((b) => !bad.has(b.id));
  if (!ok.length) return null;
  const n = Math.min(history.length, Math.max(0, ok.length - 1), 8);
  const recent = new Set(n > 0 ? history.slice(-n) : []);
  const fresh = ok.filter((b) => !recent.has(b.id));
  const pool = fresh.length ? fresh : ok;
  return pool[Math.floor(rand() * pool.length)];
}

// "granted" | "prompt" | "denied". Solo pide permiso (muestra el aviso del navegador) con request:true,
// y eso debe hacerse dentro de un clic del usuario.
export async function ensureReadPermission(handle, { request = false } = {}) {
  const opts = { mode: "read" };
  if ((await handle.queryPermission(opts)) === "granted") return "granted";
  if (!request) return "prompt";
  return (await handle.requestPermission(opts)) === "granted" ? "granted" : "denied";
}

// ---------- Clasificacion por subcarpeta y duraciones (para el Horario Inteligente) ----------
// carpeta/promos/x.mp4 -> promo; intros/ -> intro; outros/ -> outro; clips/ -> clip; todo lo demas -> bumper.
const KIND_DIRS = [["promo", /^promos?$/i], ["intro", /^intros?$/i], ["outro", /^outros?$/i], ["clip", /^clips?$/i]];

export function classifyKind(id) {
  for (const dir of String(id).split("/").slice(0, -1)) {
    for (const [kind, re] of KIND_DIRS) if (re.test(dir)) return kind;
  }
  return "bumper";
}

export const emptyLibrary = () => ({ bumper: [], promo: [], intro: [], outro: [], clip: [] });

// Duracion en segundos de un archivo de video (lee solo los metadatos). Rechaza si no se puede leer.
export function measureVideo(file, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    const finish = (fn, value) => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("timeout")), timeoutMs);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => (Number.isFinite(v.duration) && v.duration > 0 ? finish(resolve, v.duration) : finish(reject, new Error("sin duracion")));
    v.onerror = () => finish(reject, new Error("no se pudo leer"));
    v.src = url;
  });
}

const DUR_KEY = "cn.durations.v1";
export function loadDurationCache(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(DUR_KEY) || "{}"); } catch (_) { return {}; }
}
export function saveDurationCache(cache, storage = globalThis.localStorage) {
  try { storage.setItem(DUR_KEY, JSON.stringify(cache)); } catch (_) {}
}

// list = resultado de scanFolder. Devuelve { library, failed } con library = { bumper:[{id,name,kind,durationMs}], ... }.
// Las duraciones medidas se recuerdan por (ruta, tamaño, fecha de modificacion): un archivo no se mide dos veces.
export async function buildLibrary(list, { measure = measureVideo, cache = loadDurationCache(), save = saveDurationCache, concurrency = 4, onProgress } = {}) {
  const library = emptyLibrary();
  const failed = [];
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < list.length) {
      const item = list[next++];
      try {
        const file = await item.handle.getFile();
        const key = `${item.id}|${file.size}|${file.lastModified}`;
        let sec = cache[key];
        if (!(sec > 0)) {
          sec = await measure(file);
          cache[key] = sec;
        }
        library[classifyKind(item.id)].push({ id: item.id, name: item.name.replace(/\.mp4$/i, ""), kind: classifyKind(item.id), durationMs: Math.round(sec * 1000) });
      } catch (_) {
        failed.push(item.id);
      }
      onProgress?.(++done, list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  save(cache);
  for (const kind of Object.keys(library)) library[kind].sort((a, b) => a.id.localeCompare(b.id));
  return { library, failed };
}

// ---------- IndexedDB (recordar la carpeta elegida) ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const saveFolderHandle = (handle) => withStore("readwrite", (s) => s.put(handle, KEY));
export const loadFolderHandle = () => withStore("readonly", (s) => s.get(KEY)).catch(() => null);
export const clearFolderHandle = () => withStore("readwrite", (s) => s.delete(KEY));

// ---------- Preferencia "bumpers activados" ----------

const ENABLED_KEY = "cn.bumpers.enabled";

export function loadEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function saveEnabled(value) {
  try {
    localStorage.setItem(ENABLED_KEY, value ? "1" : "0");
  } catch (_) {}
}
