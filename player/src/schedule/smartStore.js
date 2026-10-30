import { useEffect, useState, useSyncExternalStore } from "react";
import { CN } from "./engine.js";
import { smartRequest } from "./smartApi.js";

// ---------------------------------------------------------------------------------------------
// Almacen de estado del Horario Inteligente, compartido por todas las pantallas (TV, /schedule, /settings).
// La fuente de verdad (configuracion y parrilla) esta en la extension; aqui solo se refleja.
// ---------------------------------------------------------------------------------------------

const RESYNC_MS = 10 * 60 * 1000;

let state = {
  status: "idle", // idle | loading | ready | error
  error: null,
  config: null,   // { mode, debug, plan }
  schedule: null, // parrilla vigente (o null)
  catalog: null,  // para configurar bloques
  busy: "",       // "generando" | "guardando" | ""
};
const listeners = new Set();
const setState = (patch) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

// ---------- reloj del canal ----------
// Referencia = hora del servidor (via la extension) + tiempo monotonico. Si la extension no esta, cae al reloj del dispositivo.
export const clock = CN.createClock({
  fetchServerTime: async () => (await smartRequest("time", {}, 3000)).epochMs,
  samples: 3,
});
let clockTimer = 0;
export function startClockSync() {
  if (clockTimer) return;
  clock.sync().catch(() => {});
  clockTimer = setInterval(() => clock.sync().catch(() => {}), RESYNC_MS);
}

// ---------- acciones ----------
let loading = null;
export function loadSmart({ force = false } = {}) {
  if (loading && !force) return loading;
  setState({ status: state.config ? state.status : "loading", error: null });
  loading = smartRequest("get")
    .then((data) => setState({ status: "ready", config: data.config, schedule: data.schedule, error: null }))
    .catch((e) => setState({ status: "error", error: e.message }))
    .finally(() => { loading = null; });
  return loading;
}

export async function loadCatalog() {
  const { catalog } = await smartRequest("catalog");
  setState({ catalog });
  return catalog;
}

export async function saveConfig(config) {
  setState({ config }); // optimista: la interfaz responde al instante
  const data = await smartRequest("save-config", { config });
  setState({ config: data.config });
  return data.config;
}

// library: { bumper:[{id,name,durationMs}], promo:[...], intro:[...], outro:[...], clip:[...] }
// seed: sin semilla = una nueva cada vez (REGENERAR).
export async function generateSchedule({ library = {}, seed } = {}) {
  setState({ busy: "generando" });
  try {
    const data = await smartRequest("generate", { library, seed }, 30000);
    setState({ schedule: data.schedule });
    return data.schedule;
  } finally {
    setState({ busy: "" });
  }
}

export async function importSchedule(schedule) {
  const data = await smartRequest("import", { schedule }, 30000);
  setState({ schedule: data.schedule });
  return data.schedule;
}

export function useSmart() {
  const snap = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    startClockSync();
    // Al abrir una pantalla se (re)intenta la carga: si la extension no estaba lista la primera vez, se recupera sola.
    if (state.status === "idle" || state.status === "error") loadSmart();
  }, []);
  return snap;
}

// Hora del canal, actualizada cada `everyMs`. Devuelve epoch ms.
export function useNow(everyMs = 250) {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    const id = setInterval(() => setNow(clock.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

// ---------- utilidades de presentacion ----------
export function describeItem(item) {
  if (!item) return { title: "—", subtitle: "" };
  const m = item.meta || {};
  if (item.type === "episode") {
    const code = `T${m.season} · E${m.number}`;
    return { title: m.series || "Episodio", subtitle: `${code}${m.title ? ` — ${m.title}` : ""}`, code };
  }
  const label = { bumper: "Bumper", promo: "Promo", intro: "Intro", outro: "Outro", clip: "Clip", filler: "Relleno" }[item.type] || item.type;
  return { title: label, subtitle: m.name && item.type !== "filler" ? m.name : "" };
}

export const TYPE_LABEL = { episode: "Episodio", bumper: "Bumper", promo: "Promo", intro: "Intro", outro: "Outro", clip: "Clip", filler: "Relleno" };

// Que esta al aire ahora segun la parrilla (real, o la comprimida de debug).
export function resolveNow(schedule, nowMs, debug) {
  return schedule ? CN.resolveSchedule(schedule, nowMs, { debug: !!debug }) : null;
}
