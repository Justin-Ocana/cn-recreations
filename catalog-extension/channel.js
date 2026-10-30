// Coordinador del "canal": corre en el service worker.
//
//   channel:start          (bridge.js, al pulsar Play en la pagina)
//   channel:status         (overlay.js / controller.js: ¿esta pestaña es el canal o la precarga?)
//   channel:preload        (controller.js del canal, faltando ~60 s: abre el siguiente en una pestaña oculta)
//   channel:preload-ready  (controller.js de la precarga: ya esta pausado en 0:00)
//   channel:preload-failed (controller.js de la precarga: no cargo)
//   channel:next           (controller.js al terminar un episodio, o el popup)
//   channel:loaded         (controller.js: metricas de tiempo de carga)
//   channel:stop           (popup)
//   channel:bumper-state   (pagina del reproductor, via bridge.js: started | ended | error)
//   channel:sched-advance  (Horario Inteligente: la pestaña/pagina llego al fin de su hueco -> "¿que toca ahora?")
//   channel:sched-reload   (Horario Inteligente: la pestaña del episodio no arranca -> recargarla)
//
// Modo HORARIO INTELIGENTE (mode "schedule"):
//   El canal NO piensa "reproduce este y luego otro": pregunta al resolver "¿que debe estar al aire AHORA y en que
//   posicion exacta?" (hora sincronizada del servidor). scheduleSwitch() es idempotente: si se llama dos veces (la
//   pestaña, la pagina y una alarma de respaldo pueden hacerlo) el resultado es el mismo. Los episodios corren en
//   pestañas de Max (que buscan su posicion exacta); los bumpers/promos/relleno, en la pagina del reproductor.
//
// Modo BUMPERS (opcional, lo activa la pagina del reproductor al pulsar Play):
//   La pagina del reproductor (P) se queda abierta como "sala de bumpers" y los episodios corren en
//   pestañas aparte. Al terminar un episodio se activa P, que reproduce un bumper al azar de la
//   carpeta del usuario; mientras tanto el siguiente episodio termina de cargar en una pestaña
//   oculta. Al acabar el bumper se activa esa pestaña y el episodio arranca saliendo del negro.
//   Si los bumpers estan desactivados, todo funciona como antes (con pantalla de carga).
//
// Una "pieza" (item) es lo que se reproduce: hoy solo episodios. Cuando existan los
// bloques de anuncios/bumpers, tambien seran items y se precargaran igual, porque todo
// pasa por chooseNext() -> startPreload() -> promote().
//
// Concurrencia: las operaciones que modifican el estado corren en cola (locked), de a una.
// Asi, si el usuario adelanta el video y llegan "preload" y "next" casi juntos, se atienden
// en orden y no se pisan. "status" y "preload-ready" no usan la cola (nunca deben esperar,
// porque la precarga los necesita mientras "next" espera a que este lista).
importScripts("scheduler.js");

// Todo va dentro de una funcion para no chocar con los nombres de background.js
// (ambos comparten el ambito global del service worker).
(() => {

  const CH = "channel";
  const READY_KEY = "channelPreloadReady"; // id de la pestaña de precarga que ya esta lista
  const PROMOTE_CLOSE_DELAY_MS = 600;
  const READY_POLL_MS = 200;
  const BUSY_MS = 20000;
  // Bumpers extra si el episodio aun no termino de cargar. 0 = ninguno: tras UN bumper el episodio pasa al
  // frente este listo o no (se ve su pantalla de carga). Las pestañas ocultas no siempre llegan a cargar el
  // reproductor de Max, asi que esperar al episodio con mas bumpers puede no acabar nunca.
  const maxBumperChain = () => globalThis.CN_MAX_BUMPER_CHAIN ?? 0;
  const bumperGraceMs = () => globalThis.CN_BUMPER_GRACE_MS ?? 1500; // espera corta a que el episodio este listo
  const QUICK_FAIL_MS = 30000;         // un episodio que pide "siguiente" antes de esto se cuenta como fallido
  const MAX_QUICK_FAILS = 2;           // tras esto se apagan los bumpers (evita bucles infinitos)
  const LOG_KEY = "channelLog";
  const ALARM = "cn-sched";            // respaldo: a la hora exacta de fin del hueco actual
  const BEAT = "cn-sched-beat";        // respaldo: cada 30 s comprueba que se este emitiendo lo correcto
  const EARLY_TOL_MS = 400;            // "siguiente" antes de su hora se ignora (salvo esta tolerancia)
  const PRELOAD_LEAD_MS = 90000;       // precarga del siguiente episodio 90 s antes de que empiece
  const smart = () => globalThis.CNSmartRuntime;
  const bumperAckMs = () => globalThis.CN_BUMPER_ACK_MS ?? 6000; // la pagina debe confirmar que empezo el bumper
  const readyWaitMs = () => globalThis.CN_READY_WAIT_MS ?? 10000;

  const getChannel = async () => (await chrome.storage.local.get(CH))[CH] || { active: false };
  const setChannel = (c) => chrome.storage.local.set({ [CH]: c });
  const tabExists = (id) => chrome.tabs.get(id).then(() => true, () => false);
  const closeTab = (id) => (id ? chrome.tabs.remove(id).catch(() => {}) : undefined);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isReady = async (tabId) => (await chrome.storage.local.get(READY_KEY))[READY_KEY] === tabId;
  const clearReady = () => chrome.storage.local.set({ [READY_KEY]: null });

  // Mensajes a la pagina del reproductor (llegan por su bridge.js).
  const toPlayer = (ch, type, extra = {}) =>
    ch.playerTabId
      ? chrome.tabs.sendMessage(ch.playerTabId, { type, ...extra }).then(() => true, () => false)
      : Promise.resolve(false);

  // Registro de lo que hace el canal, para el popup ("Registro del canal"). Nunca debe frenar nada.
  let logChain = Promise.resolve();
  function logEvent(text, { reset = false } = {}) {
    logChain = logChain
      .then(async () => {
        const cur = reset ? [] : (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || [];
        await chrome.storage.local.set({ [LOG_KEY]: [...cur, { t: Date.now(), text }].slice(-150) });
      })
      .catch(() => {});
    return logChain;
  }
  const short = (url) => (url ? url.split("/").filter(Boolean).slice(-1)[0].slice(0, 8) : "?");

  let chain = Promise.resolve();
  function locked(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  const toItem = (ep) => ({
    kind: "episode",
    url: ep.url,
    seriesKey: ep.seriesKey,
    seriesTitle: ep.seriesTitle,
    title: ep.title,
    season: ep.season,
    number: ep.number,
  });

  // Elige la siguiente pieza y la anota en el historial.
  async function chooseNext(ch) {
    const { catalog } = await chrome.storage.local.get("catalog");
    const ep = CNSched.pickNext(catalog, {
      history: ch.history,
      lastSeriesKey: (ch.next || ch.current)?.seriesKey,
    });
    if (!ep) return null;
    const item = toItem(ep);
    ch.history = [...ch.history, item.url].slice(-100);
    return item;
  }

  // Camino "en frio": navega la pestaña del canal al siguiente (o al ya elegido).
  async function playNext(ch) {
    if (ch.preloadTabId) {
      await closeTab(ch.preloadTabId);
      ch.preloadTabId = null;
      await clearReady();
    }
    const item = ch.next || (await chooseNext(ch));
    ch.next = null;
    ch.pendingNextAt = 0;
    if (!item) {
      await setChannel(ch);
      return null;
    }

    ch.current = item;
    ch.lastChangeAt = Date.now();
    await setChannel(ch);
    await chrome.tabs.update(ch.tabId, { url: item.url });
    return item;
  }

  // Abre la siguiente pieza en una pestaña oculta de la misma ventana.
  async function startPreload(ch) {
    if (ch.preloadTabId) return { ok: true };
    const item = await chooseNext(ch);
    if (!item) return { ok: false, error: "catalog-empty" };
    return openPreload(ch, item);
  }

  // Abre `item` (un episodio) en una pestaña oculta y la deja registrada como la precarga.
  async function openPreload(ch, item) {
    await clearReady();
    ch.next = item;
    // Se guarda antes de crear la pestaña: mientras no tiene id registrado, "status" la
    // reconoce por la pestaña que la abrio (openerTabId).
    ch.preloadCreating = true;
    await setChannel(ch);
    const tab = await chrome.tabs.create({
      windowId: ch.windowId,
      url: item.url,
      active: false,
      openerTabId: ch.tabId ?? ch.playerTabId ?? undefined,
    });
    ch.preloadTabId = tab.id;
    ch.preloadCreating = false;
    await setChannel(ch);
    logEvent(`⏳ siguiente abierto oculto (pestaña ${tab.id}, ${short(item.url)})`);
    return { ok: true };
  }

  // Cambio instantaneo: la pestaña precargada pasa a ser el canal.
  async function promote(ch, { ready } = {}) {
    const isReadyNow = ready ?? (ch.preloadTabId ? await isReady(ch.preloadTabId) : false);
    const oldTabId = ch.tabId;
    ch.tabId = ch.preloadTabId;
    ch.current = ch.next;
    ch.next = null;
    ch.preloadTabId = null;
    ch.pendingNextAt = 0;
    ch.lastChangeAt = Date.now();
    await setChannel(ch);
    await clearReady();

    await chrome.tabs.update(ch.tabId, { active: true });
    // Comprobacion: si Chrome no la dejo en primer plano, se reintenta enfocando su ventana.
    const now = await chrome.tabs.get(ch.tabId).catch(() => null);
    if (now && now.active === false) {
      logEvent("⚠ la pestaña del episodio NO quedo activa; se reintenta");
      await chrome.windows.update(now.windowId ?? ch.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(ch.tabId, { active: true }).catch(() => {});
    }
    logEvent(`▶ episodio al frente (pestaña ${ch.tabId}, ${short(ch.current?.url)}); ${isReadyNow ? "estaba listo" : "NO estaba listo"}`);
    // Si la pestaña aun no tiene su controlador cargado, este mensaje falla sin problema:
    // al cargar, vera que ya es el canal y arrancara por el camino normal.
    const goMsg = { type: "go", bumpers: !!ch.bumperMode, ready: isReadyNow };
    if (ch.mode === "schedule" && ch.occ) goMsg.sched = schedInfo(ch);
    chrome.tabs.sendMessage(ch.tabId, goMsg).catch(() => {});
    if (oldTabId && oldTabId !== ch.playerTabId) setTimeout(() => closeTab(oldTabId), PROMOTE_CLOSE_DELAY_MS);
  }

  // Espera (fuera de la cola) a que la precarga avise que esta lista, con tope de tiempo.
  async function waitReady(tabId, maxMs = readyWaitMs()) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (await isReady(tabId)) return true;
      if (!(await tabExists(tabId))) return false;
      await sleep(READY_POLL_MS);
    }
    return false;
  }

  // ----- Modo bumpers -----

  // Activa la pagina del reproductor y le pide un bumper al azar. false = no se pudo (se salta el bumper).
  async function playBumper(ch) {
    if (!ch.playerTabId || !(await tabExists(ch.playerTabId))) return false;
    const token = Date.now() + Math.random();
    ch.bumperToken = token;
    ch.bumperAck = false;
    await setChannel(ch);
    await chrome.tabs.update(ch.playerTabId, { active: true }).catch(() => {});
    if (!(await toPlayer(ch, "bumper:play", { token }))) {
      logEvent("✖ la pagina del reproductor no respondio al pedir un bumper");
      return false;
    }
    logEvent(`🎬 bumper pedido a la pagina (cadena ${ch.bumperChain || 0})`);

    // Vigilante: si la pagina no confirma que el bumper arranco, se da por fallido y se sigue.
    setTimeout(async () => {
      const c = await getChannel();
      if (c.active && c.phase === "bumper" && c.bumperToken === token && !c.bumperAck) {
        handleBumperDone(null, { state: "error", token, error: "sin-confirmacion" });
      }
    }, bumperAckMs());
    return true;
  }

  // Cambia al episodio ya precargado (o lo abre si no habia) al terminar el/los bumper(s).
  async function endBumperPhase(ch, ready) {
    ch.phase = "episode";
    if (ch.preloadTabId && ch.next && (await tabExists(ch.preloadTabId))) {
      await promote(ch, { ready });
      return { ok: true };
    }
    // La precarga desaparecio: se abre ahora (cargara detras del negro / pantalla de carga).
    ch.preloadTabId = null;
    const r = await startPreload(ch);
    if (!r.ok) {
      await stopChannel();
      return { ok: false, error: r.error };
    }
    await promote(ch, { ready: false });
    return { ok: true };
  }

  // El bumper termino (o fallo). Si el episodio aun no esta listo, suena otro bumper.
  async function handleBumperDone(fromTab, msg) {
    const step = await locked(async () => {
      const ch = await getChannel();
      if (!ch.active || !ch.bumperMode || ch.phase !== "bumper") return { done: true };
      if (fromTab && fromTab.id !== ch.playerTabId) return { done: true };
      if (msg.token && msg.token !== ch.bumperToken) return { done: true }; // aviso viejo

      const alive = !!ch.preloadTabId && (await tabExists(ch.preloadTabId));
      const readyNow = alive && (await isReady(ch.preloadTabId));
      logEvent(`bumper: ${msg.state}${msg.error ? " (" + msg.error + ")" : ""}; episodio ${alive ? (readyNow ? "listo" : "aun no listo") : "sin pestaña"}`);
      if (msg.state === "ended" && alive && !readyNow && (ch.bumperChain || 0) < maxBumperChain()) {
        ch.bumperChain = (ch.bumperChain || 0) + 1;
        if (await playBumper(ch)) return { chained: true };
      }
      return { promote: alive ? ch.preloadTabId : null };
    });
    if (step.done || step.chained) return { ok: true };

    // Fuera de la cola: espera corta por si el episodio esta a punto de estar listo; si no, pasa igual.
    const ready = step.promote ? await waitReady(step.promote, bumperGraceMs()) : false;

    return locked(async () => {
      const ch = await getChannel();
      if (!ch.active || ch.phase !== "bumper") return { ok: false };
      return endBumperPhase(ch, ready);
    });
  }

  // "Siguiente": usa la precarga si existe (esperandola si aun no esta lista), o va en frio.
  async function handleNext(fromTab, reason) {
    // Paso 1 (en cola): validar y decidir.
    const plan = await locked(async () => {
      const ch = await getChannel();
      if (!ch.active) return { done: { ok: false } };
      if (ch.mode === "schedule") return { done: { ok: false, error: "schedule-locked" } }; // el canal manda, no el usuario
      if (fromTab && fromTab.id !== ch.tabId) return { done: { ok: false } };
      // Freno de seguridad: si los episodios fallan enseguida y piden "siguiente" una y otra vez, se
      // apagan los bumpers en vez de seguir en bucle (episodio que falla -> bumper -> episodio que falla...).
      if (ch.bumperMode && fromTab && ch.phase !== "bumper" && Date.now() - (ch.lastChangeAt || 0) >= 4000) {
        const lived = Date.now() - (ch.lastChangeAt || 0);
        ch.quickFails = lived < QUICK_FAIL_MS ? (ch.quickFails || 0) + 1 : 0;
        logEvent(`⏭ el episodio pide siguiente (${reason || "?"}) tras ${Math.round(lived / 1000)} s`);
        if (ch.quickFails >= MAX_QUICK_FAILS) {
          logEvent("⛔ dos episodios seguidos fallaron enseguida: se APAGAN los bumpers (sigue con pantalla de carga)");
          ch.bumperMode = false;
          ch.quickFails = 0;
        }
        await setChannel(ch);
      }

      // Con bumpers: fin de episodio -> bumper (mientras el siguiente termina de cargar).
      if (ch.bumperMode && ch.playerTabId && (await tabExists(ch.playerTabId))) {
        if (ch.phase === "bumper") return { done: { ok: true, bumper: true } }; // ya hay uno en curso
        if (Date.now() - (ch.lastChangeAt || 0) < 4000) return { done: { ok: false, error: "too-soon" } };
        if (!ch.preloadTabId) {
          const r = await startPreload(ch); // el usuario adelanto tanto que aun no se habia abierto
          if (!r.ok) return { done: { ok: false, error: r.error } };
        }
        ch.phase = "bumper";
        ch.bumperChain = 0;
        ch.lastChangeAt = Date.now();
        await setChannel(ch);
        if (!(await playBumper(ch))) return { done: (await endBumperPhase(ch, false)) };
        return { done: { ok: true, bumper: true } };
      }

      if (Date.now() - (ch.pendingNextAt || 0) < BUSY_MS) return { done: { ok: false, error: "busy" } };
      if (Date.now() - (ch.lastChangeAt || 0) < 4000) return { done: { ok: false, error: "too-soon" } };

      if (ch.preloadTabId && ch.next && (await tabExists(ch.preloadTabId))) {
        await setChannel({ ...ch, pendingNextAt: Date.now() });
        return { preloadTabId: ch.preloadTabId };
      }
      return { done: { ok: !!(await playNext(ch)) } };
    });
    if (plan.done) return plan.done;

    // Paso 2 (fuera de la cola): si la precarga aun no esta lista -por ejemplo porque el usuario
    // adelanto el video-, la pantalla de carga sigue tapando esta pestaña mientras se espera.
    const ready = await waitReady(plan.preloadTabId);

    // Paso 3 (en cola): cambiar. Si la precarga desaparecio mientras tanto, va en frio.
    return locked(async () => {
      const ch = await getChannel();
      if (!ch.active) return { ok: false };
      if (ch.preloadTabId === plan.preloadTabId && ch.next && (await tabExists(ch.preloadTabId))) {
        await promote(ch);
        return { ok: true, preloaded: true, waitedReady: ready };
      }
      return { ok: !!(await playNext(ch)) };
    });
  }

  // ----- Modo Horario Inteligente -----

  const schedInfo = (ch) => ({ startAbsMs: ch.occ.startAbsMs, endAbsMs: ch.occ.endAbsMs, timeZone: ch.occ.tz, serverNowMs: smart().clock.now(), debug: !!ch.debug });

  const itemEpisode = (item) => ({
    kind: "episode", url: item.meta.url, seriesKey: item.meta.seriesKey, seriesTitle: item.meta.series,
    title: item.meta.title, season: item.meta.season, number: item.meta.number, itemId: item.id,
  });

  // Pone al aire el episodio `item`: reutiliza la precarga si era ese, o lo abre ahora (cargara y buscara su posicion).
  async function showEpisode(ch, item) {
    const url = item.meta.url;
    const reusable = ch.preloadTabId && ch.next?.url === url && (await tabExists(ch.preloadTabId));
    if (!reusable) {
      if (ch.preloadTabId) { await closeTab(ch.preloadTabId); ch.preloadTabId = null; await clearReady(); }
      const r = await openPreload(ch, itemEpisode(item));
      if (!r.ok) return r;
      await promote(ch, { ready: false });
      return { ok: true };
    }
    await promote(ch, { ready: await isReady(ch.preloadTabId) });
    return { ok: true };
  }

  // Un clip (bumper/promo/intro/outro/clip) o relleno: lo reproduce la pagina, en su posicion exacta y hasta su hora de fin.
  async function playScheduledClip(ch, item, cur) {
    if (!ch.playerTabId || !(await tabExists(ch.playerTabId))) {
      logEvent("✖ no hay pagina del reproductor para emitir " + item.type);
      return { ok: false, error: "no-player" };
    }
    const token = Date.now() + Math.random();
    ch.bumperToken = token;
    ch.bumperAck = false;
    await chrome.tabs.update(ch.playerTabId, { active: true }).catch(() => {});
    const sent = await toPlayer(ch, "bumper:play", {
      token,
      clip: item.type === "filler" ? null : { id: item.contentId, kind: item.type, name: item.meta?.name },
      filler: item.type === "filler",
      positionMs: cur.positionMs,
      endAbsMs: cur.endAbsMs,
      serverNowMs: smart().clock.now(),
    });
    logEvent(`🎬 ${item.type}${item.meta?.name ? " " + item.meta.name : ""} a la pagina (posicion ${Math.round(cur.positionMs / 1000)} s)${sent ? "" : " — la pagina NO respondio"}`);
    return { ok: true };
  }

  // Abre (oculto) el proximo episodio de la parrilla cuando conviene: durante un clip, o 90 s antes de que toque.
  async function planPreload(ch, r, { force = false } = {}) {
    const up = CNSmart.upcoming(r.schedule, r, 4, { debug: ch.debug });
    const nextEp = up.find((u) => u.item.type === "episode");
    if (!nextEp) return;
    const url = nextEp.item.meta.url;
    if (ch.phase === "episode" && ch.current?.url === url) return; // el mismo episodio otra vez: no se precarga
    if (!force && ch.phase === "episode" && nextEp.startAbsMs - r.nowMs > PRELOAD_LEAD_MS) return; // aun falta mucho
    if (ch.preloadTabId && ch.next?.url === url) return; // ya esta
    if (ch.preloadTabId) { await closeTab(ch.preloadTabId); ch.preloadTabId = null; await clearReady(); }
    await openPreload(ch, itemEpisode(nextEp.item));
  }

  function armAlarm(ch) {
    if (!chrome.alarms?.create || !ch.occ) return;
    const when = Date.now() + Math.max(0, ch.occ.endAbsMs - smart().clock.now()) + 1500;
    chrome.alarms.create(ALARM, { when });
  }

  // "¿Que debe estar al aire AHORA?" y lo pone. Idempotente: si ya se esta emitiendo esa ocurrencia, no hace nada.
  async function scheduleSwitch(ch) {
    const r = await smart().resolveNow(ch.debug);
    if (!r) return { ok: false, error: "no-schedule" };
    const cur = r.current;
    const item = cur.item;
    const occ = { id: item.id, type: item.type, startAbsMs: cur.startAbsMs, endAbsMs: cur.endAbsMs, tz: r.schedule.timeZone };
    const same = !!ch.occ && ch.occ.id === occ.id && ch.occ.startAbsMs === occ.startAbsMs;
    ch.occ = occ;

    let res = { ok: true };
    if (item.type === "episode") {
      const alive = !!ch.tabId && (await tabExists(ch.tabId));
      if (!(same && alive && ch.phase === "episode")) {
        logEvent(`▶ al aire: ${item.meta.series} T${item.meta.season}E${item.meta.number} (posicion ${Math.round(cur.positionMs / 1000)} s)`);
        ch.phase = "episode";
        ch.lastChangeAt = Date.now();
        res = await showEpisode(ch, item);
      }
    } else if (!(same && ch.phase === "clip")) {
      ch.phase = "clip";
      ch.lastChangeAt = Date.now();
      res = await playScheduledClip(ch, item, cur);
    }

    await planPreload(ch, r);
    await setChannel(ch);
    armAlarm(ch);
    return { ...res, occ };
  }

  // La pestaña (o la pagina) llego al fin de su hueco: se decide de nuevo que toca ahora.
  async function handleSchedAdvance(fromTab) {
    return locked(async () => {
      const ch = await getChannel();
      if (!ch.active || ch.mode !== "schedule") return { ok: false };
      if (fromTab && fromTab.id !== ch.tabId && fromTab.id !== ch.playerTabId) return { ok: false };
      const now = smart().clock.now();
      // Aviso prematuro (p. ej. el video termino antes que su hueco): no se cambia hasta la hora exacta.
      if (ch.occ && now < ch.occ.endAbsMs - EARLY_TOL_MS) return { ok: false, early: true, waitMs: ch.occ.endAbsMs - now };
      const r = await scheduleSwitch(ch);
      return { ok: !!r.ok, error: r.error };
    });
  }

  async function startChannel(tab, { bumpers = false, mode = "random", debug = false } = {}) {
    const ch = {
      active: true,
      // Con bumpers, la pagina del reproductor (esta pestaña) queda abierta como sala de bumpers y los
      // episodios corren en pestañas nuevas; sin bumpers, esta misma pestaña pasa a ser el canal.
      mode: "random", // "random" (normal) | "schedule" (Horario Inteligente)
      bumperMode: !!bumpers,
      playerTabId: bumpers ? tab.id : null,
      phase: "episode", // "episode" | "bumper"
      bumperChain: 0,
      quickFails: 0,
      tabId: bumpers ? null : tab.id,
      windowId: tab.windowId,
      returnUrl: tab.url,
      history: [],
      current: null,
      next: null,
      preloadTabId: null,
      pendingNextAt: 0,
      loads: [],
      switches: [],
    };
    // Pantalla completa del navegador (como F11): no necesita gesto del usuario
    // y se mantiene al cambiar de enlace o de pestaña.
    await chrome.windows.update(tab.windowId, { state: "fullscreen" }).catch(() => {});
    await clearReady();
    logEvent(`Canal iniciado ${bumpers ? "CON bumpers" : "sin bumpers"} (pagina = pestaña ${tab.id})`, { reset: true });

    if (mode === "schedule") {
      const schedule = await smart().getSchedule();
      if (!schedule) {
        await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
        return { ok: false, error: "no-schedule" };
      }
      // La pagina del reproductor (esta pestaña) se queda como sala de clips; los episodios corren en pestañas nuevas.
      Object.assign(ch, { mode: "schedule", debug: !!debug, bumperMode: false, playerTabId: tab.id, tabId: null, phase: "episode" });
      logEvent(`Canal iniciado en HORARIO INTELIGENTE${debug ? " (DEBUG 15 s)" : ""} (pagina = pestaña ${tab.id})`, { reset: true });
      await setChannel(ch);
      const r = await scheduleSwitch(ch);
      if (!r.ok) {
        await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
        await setChannel({ ...ch, active: false });
        return { ok: false, error: r.error };
      }
      chrome.alarms?.create?.(BEAT, { periodInMinutes: 0.5 });
      return { ok: true, schedule: true, occ: r.occ };
    }

    if (bumpers) {
      // El primer episodio se abre oculto (como una precarga) mientras suena el primer bumper.
      const r = await startPreload(ch);
      if (!r.ok) {
        await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
        return { ok: false, error: r.error };
      }
      ch.phase = "bumper";
      ch.lastChangeAt = Date.now();
      await setChannel(ch);
      if (!(await playBumper(ch))) await endBumperPhase(ch, false); // sin pagina que reproduzca: directo al episodio
      return { ok: true, episode: ch.next ?? ch.current, bumpers: true };
    }

    const item = await playNext(ch);
    if (!item) {
      await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
      return { ok: false, error: "catalog-empty" };
    }
    return { ok: true, episode: item };
  }

  async function stopChannel({ goBack = true } = {}) {
    const ch = await getChannel();
    if (!ch.active) return;
    await setChannel({ ...ch, active: false, preloadTabId: null, next: null, pendingNextAt: 0, phase: "episode" });
    await clearReady();
    await closeTab(ch.preloadTabId);
    logEvent("Canal detenido");
    chrome.alarms?.clear?.(ALARM);
    chrome.alarms?.clear?.(BEAT);
    if (ch.playerTabId && (await tabExists(ch.playerTabId))) {
      // La pagina del reproductor nunca se cerro: se cierran los episodios y se vuelve a ella.
      await toPlayer(ch, "bumper:stop");
      await closeTab(ch.tabId);
      await chrome.windows.update(ch.windowId, { state: "normal" }).catch(() => {});
      if (ch.playerTabId) await chrome.tabs.update(ch.playerTabId, { active: true }).catch(() => {});
      return;
    }
    await chrome.windows.update(ch.windowId, { state: "normal" }).catch(() => {});
    if (goBack && ch.returnUrl) await chrome.tabs.update(ch.tabId, { url: ch.returnUrl }).catch(() => {});
  }

  chrome.tabs.onRemoved.addListener((tabId) =>
    locked(async () => {
      const ch = await getChannel();
      if (!ch.active) return;
      if (ch.mode === "schedule" && ch.playerTabId === tabId) return stopChannel(); // sin la pagina no hay clips: se detiene
      if (ch.playerTabId === tabId) {
        // Se cerro la pagina del reproductor: sin bumpers de aqui en adelante (vuelve la pantalla de carga).
        ch.bumperMode = false;
        ch.playerTabId = null;
        if (ch.phase === "bumper") await endBumperPhase(ch, false);
        else await setChannel(ch);
      } else if (ch.tabId === tabId) {
        if (ch.playerTabId) return stopChannel(); // el usuario cerro el episodio: se detiene y se vuelve a la pagina
        await setChannel({ ...ch, active: false });
        await closeTab(ch.preloadTabId);
      } else if (ch.preloadTabId === tabId) {
        // Si se cierra la precarga, el siguiente ya elegido se abrira en frio.
        await setChannel({ ...ch, preloadTabId: null });
        await clearReady();
      }
    })
  );

  // Respaldo: aunque ninguna pestaña avise (se colgo, se durmio el service worker...), a la hora del fin del hueco y
  // cada 30 s se vuelve a preguntar "¿que toca ahora?". Como scheduleSwitch es idempotente, no hace nada de mas.
  chrome.alarms?.onAlarm?.addListener((a) => {
    if (a.name !== ALARM && a.name !== BEAT) return;
    locked(async () => {
      const ch = await getChannel();
      if (!ch.active || ch.mode !== "schedule") return;
      await scheduleSwitch(ch);
    }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = String(msg?.type || "");
    if (!type.startsWith("channel:")) return false;
    const fromTab = sender.tab;

    const run = async () => {
      switch (type) {
        case "channel:start":
          if (!fromTab) return { ok: false, error: "no-tab" };
          return locked(() => startChannel(fromTab, { bumpers: !!msg.bumpers, mode: msg.mode === "schedule" ? "schedule" : "random", debug: !!msg.debug }));

        // Solo lectura: sin cola.
        case "channel:status": {
          const ch = await getChannel();
          if (!ch.active || !fromTab) return { active: false };
          const bumpers = !!ch.bumperMode;
          const schedule = ch.mode === "schedule";
          if (ch.tabId === fromTab.id) {
            return { active: true, role: "channel", expectedUrl: ch.current?.url, bumpers, schedule, ...(schedule && ch.occ ? { sched: schedInfo(ch) } : {}) };
          }
          const registered = ch.preloadTabId === fromTab.id;
          const justOpened = ch.preloadCreating && [ch.tabId, ch.playerTabId].includes(fromTab.openerTabId);
          if (registered || justOpened) return { active: true, role: "preload", expectedUrl: ch.next?.url, bumpers, schedule };
          return { active: false };
        }

        // Sin cola: "next" puede estar esperando justo esta señal.
        case "channel:preload-ready": {
          const ch = await getChannel();
          const mine =
            fromTab?.id === ch.preloadTabId ||
            (ch.preloadCreating && [ch.tabId, ch.playerTabId].includes(fromTab?.openerTabId));
          if (ch.active && mine) {
            await chrome.storage.local.set({ [READY_KEY]: fromTab.id });
            logEvent(`✔ siguiente LISTO en su pestaña oculta (${fromTab.id})`);
          }
          return { ok: true };
        }

        case "channel:preload":
          return locked(async () => {
            const ch = await getChannel();
            if (!ch.active || fromTab?.id !== ch.tabId) return { ok: false };
            if (ch.mode === "schedule") {
              // El siguiente episodio lo dicta la parrilla (no se elige al azar).
              const r = await smart().resolveNow(ch.debug);
              if (r) { await planPreload(ch, r, { force: true }); await setChannel(ch); }
              return { ok: true };
            }
            return startPreload(ch);
          });

        case "channel:preload-failed":
          return locked(async () => {
            const ch = await getChannel();
            if (ch.active && fromTab?.id === ch.preloadTabId) {
              logEvent(`✖ la precarga fallo (${msg.reason || "?"}); se cierra su pestaña`);
              await closeTab(ch.preloadTabId);
              await setChannel({ ...ch, preloadTabId: null });
              await clearReady();
            }
            return { ok: true };
          });

        case "channel:next":
          return handleNext(fromTab, msg.reason);

        // Horario Inteligente: fin del hueco actual -> "¿que toca ahora?" (idempotente).
        case "channel:sched-advance":
          return handleSchedAdvance(fromTab);

        // Horario Inteligente: el episodio no arranca; se recarga la pestaña (como mucho una vez cada 25 s).
        case "channel:sched-reload":
          return locked(async () => {
            const ch = await getChannel();
            if (!ch.active || ch.mode !== "schedule" || fromTab?.id !== ch.tabId) return { ok: false };
            if (Date.now() - (ch.lastReloadAt || 0) < 25000) return { ok: false, error: "too-soon" };
            ch.lastReloadAt = Date.now();
            await setChannel(ch);
            logEvent("↻ el episodio no arranco: se recarga su pestaña");
            await chrome.tabs.reload(ch.tabId).catch(() => {});
            return { ok: true };
          });

        // Trazas de las pestañas de Max (para el "Registro del canal" del popup).
        case "channel:log":
          logEvent(`[pestaña ${fromTab?.id ?? "?"}] ${String(msg.text || "").slice(0, 200)}`);
          return { ok: true };

        // La pagina del reproductor informa del bumper: started | ended | error.
        case "channel:bumper-state":
          if (msg.state === "started") {
            return locked(async () => {
              const ch = await getChannel();
              if (ch.active && (ch.phase === "bumper" || ch.phase === "clip") && (!msg.token || msg.token === ch.bumperToken)) {
                await setChannel({ ...ch, bumperAck: true });
              }
              return { ok: true };
            });
          }
          return (async () => {
            const ch = await getChannel();
            if (ch.active && ch.mode === "schedule") {
              // En la parrilla manda la hora, no el clip: el fin del hueco lo avisa la pagina y se resuelve "¿que toca ahora?".
              if (msg.state === "ended") return handleSchedAdvance(fromTab);
              logEvent(`⚠ clip con problema (${msg.error || "?"}); se mantiene negro hasta el fin del hueco`);
              return { ok: true };
            }
            return handleBumperDone(fromTab, msg);
          })();

        case "channel:loaded":
          // Tiempos de carga: sirven para medir cuanto ayuda la precarga.
          return locked(async () => {
            const ch = await getChannel();
            if (ch.active && fromTab?.id === ch.tabId) {
              const key = msg.preloaded ? "switches" : "loads";
              await setChannel({ ...ch, [key]: [...(ch[key] || []), msg.ms].slice(-20) });
            }
            return { ok: true };
          });

        case "channel:stop":
          return locked(async () => {
            await stopChannel();
            return { ok: true };
          });
      }
      return undefined;
    };

    run().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  });
})();
