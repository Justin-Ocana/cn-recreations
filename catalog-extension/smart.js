// Horario Inteligente en el service worker: guarda configuracion y parrilla, sincroniza la hora del canal y
// atiende las peticiones de la pagina (settings, /schedule) y de las pestañas de Max.
//
//   smart:get              -> { config, schedule, clock, nowMs }
//   smart:catalog          -> { catalog }            (series y episodios, para configurar bloques)
//   smart:save-config      -> { config }
//   smart:generate         -> { schedule }           (genera o REGENERA: nueva semilla, mismo catalogo y plan)
//   smart:import           -> { schedule }           (parrilla exportada por otro dispositivo)
//   smart:time             -> { epochMs, info }      (hora del canal)
//   smart:record-duration  -> { ok }                 (duracion real de un episodio, medida al reproducirlo)
//
// Tambien expone globalThis.CNSmartRuntime para channel.js (el modo horario resuelve "que toca ahora").
(() => {
  const CFG_KEY = "smartConfig";
  const SCH_KEY = "smartSchedule";
  const RESYNC_MS = 10 * 60 * 1000;
  const MIN_DURATION_S = 30;
  const MAX_DURATION_S = 4 * 3600;

  const systemTz = () => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (_) { return "UTC"; }
  };

  // Hora del servidor: Cloudflare devuelve "ts=<epoch con decimales>"; si falla, la cabecera Date de la respuesta.
  async function fetchServerEpoch() {
    const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { cache: "no-store" });
    const m = /ts=(\d+(?:\.\d+)?)/.exec(await res.text());
    if (m) return Math.round(parseFloat(m[1]) * 1000);
    const d = Date.parse(res.headers.get("date") || "");
    if (Number.isFinite(d)) return d;
    throw new Error("sin hora del servidor");
  }

  const clock = CNSmart.createClock({ fetchServerTime: globalThis.CN_FETCH_SERVER_TIME || fetchServerEpoch, samples: 3, source: "cloudflare" });
  let lastSyncTry = 0;
  async function ensureClock(force = false) {
    if (force || !clock.synced || Date.now() - lastSyncTry > RESYNC_MS) {
      lastSyncTry = Date.now();
      await clock.sync().catch(() => {});
    }
    return clock;
  }

  // ---------- almacenamiento ----------
  const defaultSmart = () => ({ mode: "normal", debug: false, plan: { ...CNSmart.defaultConfig(), timeZone: systemTz() } });

  async function getConfig() {
    const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY];
    const base = defaultSmart();
    return stored ? { ...base, ...stored, plan: { ...base.plan, ...(stored.plan || {}) } } : base;
  }

  function sanitizeConfig(input) {
    const base = defaultSmart();
    const plan = CNSmart.normalizeConfig({ ...base.plan, ...(input?.plan || {}) });
    try { new Intl.DateTimeFormat("en-US", { timeZone: plan.timeZone }); } catch (_) { plan.timeZone = systemTz(); }
    return { mode: input?.mode === "smart" ? "smart" : "normal", debug: !!input?.debug, plan };
  }

  let scheduleCache; // undefined = no cargada
  async function getSchedule() {
    if (scheduleCache === undefined) scheduleCache = (await chrome.storage.local.get(SCH_KEY))[SCH_KEY] || null;
    return scheduleCache;
  }
  chrome.storage.onChanged?.addListener?.((changes) => {
    if (changes[SCH_KEY]) scheduleCache = changes[SCH_KEY].newValue || null;
  });

  async function saveSchedule(schedule) {
    const problems = CNSmart.validateSchedule(schedule);
    if (problems.length) throw new Error("Parrilla invalida: " + problems.slice(0, 3).join("; "));
    scheduleCache = schedule;
    await chrome.storage.local.set({ [SCH_KEY]: schedule });
    return schedule;
  }

  // ---------- API ----------
  async function handle(op, msg) {
    switch (op) {
      case "get":
        await ensureClock();
        return { config: await getConfig(), schedule: await getSchedule(), clock: clock.info, nowMs: clock.now() };

      case "catalog":
        return { catalog: (await chrome.storage.local.get("catalog")).catalog || { version: 1, series: {} } };

      case "save-config": {
        const config = sanitizeConfig(msg.config);
        await chrome.storage.local.set({ [CFG_KEY]: config });
        return { config };
      }

      case "generate": {
        const cfg = await getConfig();
        const catalog = (await chrome.storage.local.get("catalog")).catalog || { series: {} };
        await ensureClock();
        const schedule = CNSmart.generateSchedule({
          catalog,
          config: cfg.plan,
          library: msg.library || {},
          seed: Number.isFinite(msg.seed) ? msg.seed : undefined, // sin semilla: una nueva cada vez
          now: clock.now(),
        });
        await saveSchedule(schedule);
        return { schedule };
      }

      case "import": {
        const s = msg.schedule;
        if (!s || !Array.isArray(s.items) || !s.timeZone) throw new Error("El archivo no es una parrilla valida.");
        return { schedule: await saveSchedule(s) };
      }

      case "time":
        await ensureClock(msg.force);
        return { epochMs: clock.now(), info: clock.info };

      case "record-duration": {
        const sec = Number(msg.sec);
        if (!msg.url || !(sec >= MIN_DURATION_S && sec <= MAX_DURATION_S)) return { ok: false };
        const { catalog } = await chrome.storage.local.get("catalog");
        let changed = false;
        for (const s of Object.values(catalog?.series || {})) {
          for (const e of s.episodes || []) {
            if (e.url === msg.url && Math.abs((e.durationSec || 0) - sec) > 0.5) {
              e.durationSec = Math.round(sec * 1000) / 1000;
              changed = true;
            }
          }
        }
        if (changed) await chrome.storage.local.set({ catalog });
        return { ok: true, changed };
      }
    }
    throw new Error("operacion desconocida: " + op);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!/^smart:/.test(String(msg?.type || ""))) return false;
    handle(msg.type.slice(6), msg).then(
      (data) => sendResponse({ ok: true, data }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true;
  });

  // ---------- para channel.js ----------
  globalThis.CNSmartRuntime = {
    clock,
    ensureClock,
    getConfig,
    getSchedule,
    // ¿Que toca ahora? -> resultado del resolver (o null si no hay parrilla).
    async resolveNow(debug) {
      const schedule = await getSchedule();
      if (!schedule) return null;
      await ensureClock();
      const nowMs = clock.now();
      return { schedule, nowMs, ...CNSmart.resolveSchedule(schedule, nowMs, { debug: !!debug }) };
    },
  };
})();
