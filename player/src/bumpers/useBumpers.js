import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildLibrary,
  clearFolderHandle,
  emptyLibrary,
  ensureReadPermission,
  loadEnabled,
  loadFolderHandle,
  pickBumper,
  saveEnabled,
  saveFolderHandle,
  scanFolder,
} from "./library.js";

// Estado de los bumpers en la pagina: carpeta elegida, videos encontrados, activado/desactivado,
// y las operaciones para prepararlos (al pulsar Play) y elegir uno al azar.
export function useBumpers() {
  const supported = typeof window !== "undefined" && "showDirectoryPicker" in window;

  const [enabled, setEnabledState] = useState(loadEnabled);
  const [folderName, setFolderName] = useState(null);
  const [count, setCount] = useState(null); // null = aun sin escanear en esta sesion
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const handleRef = useRef(null);
  const listRef = useRef([]);
  const historyRef = useRef([]);
  const badRef = useRef(new Set());
  const urlRef = useRef(null);

  const scan = useCallback(async () => {
    const found = await scanFolder(handleRef.current);
    listRef.current = found;
    badRef.current = new Set();
    setCount(found.length);
    return found.length;
  }, []);

  // Al abrir la pagina: recuerda la carpeta; si el navegador conserva el permiso, tambien la escanea.
  useEffect(() => {
    if (!supported) return undefined;
    let alive = true;
    (async () => {
      const handle = await loadFolderHandle();
      if (!alive || !handle) return;
      handleRef.current = handle;
      setFolderName(handle.name);
      try {
        if ((await ensureReadPermission(handle)) === "granted") await scan();
      } catch (_) {}
    })();
    return () => { alive = false; };
  }, [supported, scan]);

  const setEnabled = useCallback((value) => {
    setEnabledState(value);
    saveEnabled(value);
  }, []);

  // Dialogo del navegador para elegir la carpeta (debe llamarse desde un clic).
  const chooseFolder = useCallback(async () => {
    if (!supported) return;
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: "cn-bumpers", mode: "read" });
    } catch (e) {
      if (e?.name !== "AbortError") setStatus("No se pudo abrir la carpeta.");
      return;
    }
    setBusy(true);
    setStatus("Analizando videos…");
    try {
      handleRef.current = handle;
      // Recordar la carpeta es opcional: si el almacenamiento falla (modo privado...) se usa igual esta sesion.
      const remembered = await saveFolderHandle(handle).then(() => true, () => false);
      setFolderName(handle.name);
      const n = await scan();
      setStatus(!n ? "La carpeta no tiene videos .mp4." : remembered ? "" : "Lista, pero no se pudo recordar para la próxima vez.");
      if (n) setEnabled(true); // acaba de configurarla: lo esperable es usarla
    } catch (_) {
      setStatus("No se pudo leer la carpeta.");
    } finally {
      setBusy(false);
    }
  }, [supported, scan, setEnabled]);

  const forgetFolder = useCallback(async () => {
    handleRef.current = null;
    listRef.current = [];
    setFolderName(null);
    setCount(null);
    setStatus("");
    setEnabled(false);
    await clearFolderHandle().catch(() => {});
  }, [setEnabled]);

  // Pide permiso (si hace falta) y vuelve a escanear. Llamar desde un clic.
  // Devuelve { ok: true, count } o { ok: false, error: "sin-carpeta" | "permiso" | "vacio" | "lectura" }.
  const prepare = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return { ok: false, error: "sin-carpeta" };
    setBusy(true);
    try {
      if ((await ensureReadPermission(handle, { request: true })) !== "granted") {
        setStatus("Sin permiso para leer la carpeta.");
        return { ok: false, error: "permiso" };
      }
      const n = await scan();
      setStatus(n ? "" : "La carpeta no tiene videos .mp4.");
      return n ? { ok: true, count: n } : { ok: false, error: "vacio" };
    } catch (_) {
      setStatus("No se pudo leer la carpeta.");
      return { ok: false, error: "lectura" };
    } finally {
      setBusy(false);
    }
  }, [scan]);

  // Un bumper al azar listo para reproducir: { id, name, url } o null. Libera el archivo anterior.
  const pick = useCallback(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = pickBumper(listRef.current, { history: historyRef.current, bad: badRef.current });
      if (!item) return null;
      try {
        const file = await item.handle.getFile();
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(file);
        historyRef.current = [...historyRef.current, item.id].slice(-20);
        return { id: item.id, name: item.name, url: urlRef.current };
      } catch (_) {
        badRef.current.add(item.id); // borrado o ilegible: se descarta y se prueba otro
      }
    }
    return null;
  }, []);

  const markBad = useCallback((id) => badRef.current.add(id), []);

  // Un clip CONCRETO por su id (el que dicta la parrilla del Horario Inteligente): { id, name, url } o null.
  const pickById = useCallback(async (id) => {
    const item = listRef.current.find((b) => b.id === id);
    if (!item) return null;
    try {
      const file = await item.handle.getFile();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(file);
      return { id: item.id, name: item.name, url: urlRef.current };
    } catch (_) {
      return null;
    }
  }, []);

  // Escanea la carpeta y mide la duracion exacta de cada video, agrupados por tipo (bumper, promo, intro, outro, clip).
  // Pide permiso si hace falta: llamar desde un clic. Devuelve { ok, library, failed } o { ok:false, error, library }.
  const buildLib = useCallback(async (onProgress) => {
    const prep = await prepare();
    if (!prep.ok) return { ok: false, error: prep.error, library: emptyLibrary() };
    setBusy(true);
    try {
      const { library, failed } = await buildLibrary(listRef.current, { onProgress });
      return { ok: true, library, failed };
    } catch (_) {
      return { ok: false, error: "lectura", library: emptyLibrary() };
    } finally {
      setBusy(false);
    }
  }, [prepare]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  return { supported, enabled, setEnabled, folderName, count, busy, status, chooseFolder, forgetFolder, prepare, pick, pickById, markBad, buildLibrary: buildLib };
}
