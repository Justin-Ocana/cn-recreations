// Corre dentro de las paginas de Max. Segun lo que responda el service worker, esta
// pestaña es:
//   - "channel": el episodio que se esta viendo. Lo deja en 0:00, detecta el final,
//                y faltando ~90 s pide precargar el siguiente.
//   - "preload": el siguiente episodio, abierto en una pestaña oculta. Se queda
//                PAUSADO, SILENCIADO y en 0:00 hasta que llega el mensaje "go".
//
// En HORARIO INTELIGENTE (status.schedule) el episodio no decide nada por si mismo: su posicion es SIEMPRE
//   (hora sincronizada del servidor - inicio del hueco en la parrilla). Al entrar busca esa posicion exacta, y cada
//   250 ms comprueba que el video siga ahi (corrige pausas, seeks, buffering); el usuario no puede alterarlo. Al llegar
//   la hora de fin del hueco avisa al service worker, que resuelve "¿que toca ahora?".
(() => {
  if (window.__cnController) return;
  window.__cnController = true;

  const TICK_MS = 500;
  const START_WINDOW_MS = 12000;     // tiempo durante el que forzamos el inicio en 0:00
  const NO_VIDEO_TIMEOUT_MS = 45000;
  const PRELOAD_LEAD_S = 90;         // cuantos segundos antes del final se precarga el siguiente
  const GO_PLAY_LEAD_MS = 600;       // se da play un poco antes de que termine la pantalla de carga
  const COVER_DELAY_MS = 1200;       // al terminar, "cargando" solo aparece si el cambio se demora
  const FADE_MS = 1000;              // con bumpers: fundido a negro al final y desde negro al inicio

  // Boton/aviso de "siguiente episodio" que Max muestra durante los creditos.
  const NEXT_RE = /(siguiente|pr[oó]ximo|next)\s+(episodio|episode|cap[ií]tulo)|ver\s+siguiente|watch\s+next/i;
  const START_OVER_RE = /desde el principio|empezar de nuevo|comenzar de nuevo|start over|from (?:the )?beginning|restart/i;
  // Boton de Max para quedarse en los creditos: al pulsarlo Max cancela su autoplay del siguiente.
  const CREDITS_RE = /ver\s+cr[eé]ditos|watch\s+credits/i;

  const watchId = (url) => {
    try {
      return new URL(url, location.href).pathname.split("/watch/")[1]?.split("/")[0] || null;
    } catch (_) {
      return null;
    }
  };
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
  const labelOf = (el) => `${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`.trim();
  const mainVideo = () =>
    [...document.querySelectorAll("video")].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
  const findButton = (re) =>
    [...document.querySelectorAll('button,[role="button"],a')].find((el) => visible(el) && re.test(labelOf(el)));
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => undefined);
  const DRIFT_TOL_S = 1.2;          // desvio tolerado respecto de la posicion que manda la parrilla
  const CORRECT_EVERY_MS = 1500;    // no se corrige mas seguido (el buffering no debe provocar saltos en cadena)
  const ADV_RETRY_MS = 1500;
  const SCHED_TICK_MS = 250;
  // Traza para el "Registro del canal" del popup (ayuda a ver que pasa en cada pestaña).
  const note = (text) => send({ type: "channel:log", text });

  let role = null;            // "channel" | "preload"
  let expectedId = null;
  let loadedAt = Date.now();
  let videoSeenAt = 0;
  let prevT = null;
  let nextSent = false;
  let coverTimer = 0;
  let coverHidden = false;    // pantalla de carga propia ya retirada
  let playingTicks = 0;
  let playingTicksNeeded = 2; // 2 en frio; 1 si vino precargado (ya esta en buffer)
  let playAllowed = true;
  let preloadRequested = false;
  let readySent = false;
  let savedMuted = null;
  let goAt = 0;
  let pendingGo = null;
  let creditsClicked = false;
  let videoLogged = false;
  let lastReason = null;
  let bumperMode = false;     // con bumpers: fundidos a/desde negro en vez de la pantalla de carga
  let coverKind = "loading";  // que cubre esta pestaña: "loading" (CARGANDO) o "black" (negro liso)
  let fading = false;         // el fundido a negro del final ya empezo
  // ----- Horario Inteligente -----
  let schedMode = false;
  let sched = null;           // { startAbsMs, endAbsMs, timeZone, debug } de la ocurrencia que esta al aire
  let clockBase = null;       // { serverMs, perf }: hora del servidor + tiempo monotonico (no depende del reloj del PC)
  let expectedUrl = null;
  let joined = false;         // ya se busco la posicion exacta
  let advSentAt = 0;
  let advDone = false;        // el service worker ya confirmo el cambio: no se insiste
  let lastCorrectAt = 0;
  let ownSeekUntil = 0;       // los seeks que hacemos nosotros no cuentan como intentos del usuario
  let ownSeekTo = 0;
  let durationSent = false;
  let lastRestore = 0;
  let blackedOut = false;

  const setClock = (serverNowMs) => { clockBase = { serverMs: serverNowMs, perf: performance.now() }; };
  const syncedNow = () => (clockBase ? clockBase.serverMs + (performance.now() - clockBase.perf) : Date.now());
  const clockText = (ms, tz) => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: tz || undefined, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(ms);
    } catch (_) {
      return "--:--:--";
    }
  };

  // Duracion REAL del episodio (la parrilla usa los minutos redondeados del catalogo hasta conocerla).
  function reportDuration(v) {
    if (durationSent || !expectedUrl || !isFinite(v.duration) || v.duration < 30) return;
    durationSent = true;
    send({ type: "smart:record-duration", url: expectedUrl, sec: v.duration });
  }

  const sendWithRetry = (msg, onFail) =>
    chrome.runtime
      .sendMessage(msg)
      .then((r) => { if (!r?.ok) onFail(); })
      .catch(onFail);

  // ----- Silenciador -----
  // Cuando ya se pidio el siguiente (o Max cambio por su cuenta), nada de lo que reproduzca
  // esta pestaña debe oirse ni verse: Max puede arrancar SU siguiente episodio antes de que
  // el nuestro este listo. Se pausa y silencia cualquier video al instante (por evento, sin
  // esperar al reloj de 0,5 s), con un barrido de respaldo.
  let guarding = false;
  let guardTimer = 0;
  const mediaEls = () => [...document.querySelectorAll("video,audio")];
  const silence = (el) => {
    try {
      el.muted = true;
      if (!el.paused) el.pause();
    } catch (_) {}
  };
  const onMediaEvent = (e) => { if (guarding && e.target?.tagName) silence(e.target); };
  for (const ev of ["play", "playing", "loadeddata", "volumechange"]) document.addEventListener(ev, onMediaEvent, true);

  function startGuard() {
    if (guarding || role !== "channel") return;
    guarding = true;
    mediaEls().forEach(silence);
    guardTimer = setInterval(() => mediaEls().forEach(silence), 250);
  }

  // Cambio de URL sin recarga (el router de Max): se detecta en el acto, no en el siguiente tick.
  try {
    window.navigation?.addEventListener("navigate", (e) => {
      const to = e.destination?.url;
      if (role !== "channel" || !e.destination?.sameDocument || !to || !/\/video\/watch\//.test(to)) return;
      if (watchId(to) === expectedId) return;
      startGuard();
      requestNext("navegacion-inesperada");
    });
  } catch (_) {}

  function requestNext(reason) {
    if (nextSent) return;
    nextSent = true;
    lastReason = reason;
    startGuard();
    console.log("[CN canal] siguiente episodio:", reason);
    const v0 = mainVideo();
    note(`pide siguiente: ${reason}${v0 ? ` (t=${Math.round(v0.currentTime)}s de ${isFinite(v0.duration) ? Math.round(v0.duration) : "?"}s)` : " (sin video)"}`);

    // Final normal: el episodio (y su outro) ya terminaron; si la precarga esta lista el
    // cambio es inmediato y NO debe verse "cargando" en esta pestaña. Solo si el cambio
    // se demora se tapa la pantalla. En cualquier otro caso (Max ya cambio solo, o no hay
    // video) se tapa de inmediato.
    // Con bumpers el negro ya lo puso el fundido del final, asi que no hace falta tapar nada.
    if (reason === "terminado") {
      if (!bumperMode) coverTimer = setTimeout(() => window.CNOverlay?.show(), COVER_DELAY_MS);
    } else {
      window.CNOverlay?.show();
    }

    const retry = () => setTimeout(() => { nextSent = false; clearTimeout(coverTimer); }, 5000);
    sendWithRetry({ type: "channel:next", reason }, retry);
  }

  function preloadFailed(reason) {
    console.log("[CN canal] la precarga fallo:", reason);
    send({ type: "channel:preload-failed", reason });
    role = null; // deja de vigilar; el service worker cierra esta pestaña
  }

  // ----- Pestaña precargada: pausada, silenciada y en 0:00 -----
  function holdPaused(v) {
    if (savedMuted === null) savedMuted = v.muted;
    v.muted = true;
    if (!v.paused) v.pause();
    if (Date.now() - videoSeenAt < START_WINDOW_MS) findButton(START_OVER_RE)?.click();
    if (!v.seeking && v.currentTime > 1.5) v.currentTime = 0; // reanudacion de Max
    if (!readySent && v.paused && v.readyState >= 3 && v.currentTime < 1.5) {
      readySent = true;
      const ms = Math.round(Date.now() - performance.timeOrigin);
      console.log(`[CN canal] precarga lista en 0:00 (${ms} ms)`);
      send({ type: "channel:preload-ready", ms });
    }
  }

  // ----- La precarga pasa a ser el canal -----
  async function onGo(msg = {}) {
    if (role !== "preload") { pendingGo = role === null ? msg : null; return; }
    role = "channel";
    goAt = Date.now();
    // IMPORTANTE: esta pestaña se abrio oculta hace un rato (mientras sonaba el bumper). El plazo de
    // "45 s sin video" debe contar desde AHORA, que es cuando por fin puede cargar el reproductor;
    // si no, se declaraba fallida al instante y se caia en un bucle de bumpers.
    loadedAt = Date.now();
    videoLogged = false;
    note(`recibe "go" (bumpers=${!!msg.bumpers}, listo=${msg.ready !== false}); ${mainVideo() ? "ya hay video" : "aun sin video"}`);
    nextSent = false;
    coverHidden = false;
    playingTicks = 0;
    playingTicksNeeded = 1;
    preloadRequested = false;
    playAllowed = false;
    videoSeenAt = Date.now();
    prevT = null;
    bumperMode = !!msg.bumpers;

    if (msg.sched) {
      // Horario Inteligente: NO se arranca desde 0:00; schedTick busca la posicion que corresponde a la hora actual.
      schedMode = true;
      sched = msg.sched;
      setClock(sched.serverNowMs);
      joined = false;
      blackedOut = false;
      advSentAt = 0;
      advDone = false;
      guarding = false;
      coverKind = msg.ready === false ? "loading" : "black";
      window.CNOverlay?.setMode?.(coverKind);
      window.CNOverlay?.showBug?.();
      window.CNOverlay?.hold();
      window.CNOverlay?.lock?.();
      playAllowed = true;
      note(`recibe "go" del HORARIO (posicion ${Math.round((syncedNow() - sched.startAbsMs) / 1000)} s del hueco)`);
      return;
    }

    if (bumperMode) {
      // El bumper acaba de terminar: el episodio arranca YA y sale del negro (fundido de 1 s).
      // Si por algo aun no esta listo, se ve "cargando" en vez de negro hasta que corra.
      coverKind = msg.ready === false ? "loading" : "black";
      window.CNOverlay?.setMode?.(coverKind);
      window.CNOverlay?.showBug?.();
      window.CNOverlay?.hold();
      playAllowed = true;
      const v = mainVideo();
      if (v) {
        if (savedMuted !== null) v.muted = savedMuted;
        if (v.currentTime > 1.5) v.currentTime = 0;
        v.play().catch(() => {});
      }
      return;
    }

    window.CNOverlay?.showBug?.(); // esta pestaña ya es el canal: el logo no debe faltar
    window.CNOverlay?.restart(); // vuelve a contar el minimo de 1,5 s
    await window.CNOverlay?.whenMinVisible(GO_PLAY_LEAD_MS);

    const v = mainVideo();
    if (v) {
      if (savedMuted !== null) v.muted = savedMuted;
      if (v.currentTime > 1.5) v.currentTime = 0;
      v.play().catch(() => {});
    }
    playAllowed = true;
  }

  // ===== Horario Inteligente: la posicion la manda la hora =====
  const ownSeek = (v, sec) => {
    ownSeekUntil = performance.now() + 1000;
    ownSeekTo = Math.max(0, sec);
    try { v.currentTime = ownSeekTo; } catch (_) {}
  };

  // Deja el video EXACTAMENTE donde manda la parrilla: mismo punto, reproduciendo y a velocidad normal.
  function enforce(v, { force = false } = {}) {
    if (!schedMode || role !== "channel" || !joined || guarding || !sched) return;
    const d = v.duration;
    if (!isFinite(d) || d <= 0) return;
    const now = performance.now();
    const target = Math.min((syncedNow() - sched.startAbsMs) / 1000, d - 0.25);
    if (Math.abs(v.currentTime - target) > DRIFT_TOL_S && (force || now - lastCorrectAt > CORRECT_EVERY_MS)) {
      lastCorrectAt = now;
      ownSeek(v, target);
    }
    if (v.paused && v.readyState >= 2) v.play().catch(() => {});
    if (v.playbackRate !== 1) v.playbackRate = 1;
  }

  // Cualquier intento de cambiar la posicion / pausar / cambiar la velocidad se revierte al instante (por evento).
  for (const ev of ["seeking", "pause", "ratechange"]) {
    document.addEventListener(
      ev,
      (e) => {
        if (!schedMode || e.target?.tagName !== "VIDEO") return;
        // el seek que hicimos nosotros (mismo destino) no cuenta; cualquier otro, se revierte
        if (ev === "seeking" && performance.now() < ownSeekUntil && Math.abs(e.target.currentTime - ownSeekTo) < 2) return;
        enforce(e.target, { force: true });
      },
      true
    );
  }

  // Fin del hueco: se calla la pestaña y se pregunta al service worker "¿que toca ahora?" (idempotente; reintenta).
  function finishSlot() {
    const t = performance.now();
    if (advDone || t - advSentAt < ADV_RETRY_MS) return;
    if (!advSentAt) {
      startGuard();
      note("fin del hueco: pide \"¿que toca ahora?\"");
    }
    advSentAt = t;
    // Solo se da por hecho si el service worker responde ok; "early" o un fallo -> se reintenta.
    chrome.runtime.sendMessage({ type: "channel:sched-advance" }).then((r) => { if (r?.ok) advDone = true; }).catch(() => {});
  }

  function schedTick() {
    const now = syncedNow();
    const left = sched.endAbsMs - now;
    const posS = (now - sched.startAbsMs) / 1000;
    window.CNOverlay?.setClock?.(clockText(now, sched.timeZone));

    if (left <= 0) return finishSlot();

    if (!preloadRequested && left <= PRELOAD_LEAD_S * 1000) {
      preloadRequested = true;
      sendWithRetry({ type: "channel:preload" }, () => setTimeout(() => { preloadRequested = false; }, 10000));
    }

    if (watchId(location.href) !== expectedId) {
      // Max cambio de episodio por su cuenta: se restaura el que manda la parrilla.
      if (Date.now() - lastRestore > 20000 && expectedUrl) {
        lastRestore = Date.now();
        note("la URL cambio sola: se restaura el episodio de la parrilla");
        location.replace(expectedUrl);
      }
      return;
    }

    const v = mainVideo();
    if (!v) {
      if (Date.now() - loadedAt > NO_VIDEO_TIMEOUT_MS) {
        loadedAt = Date.now();
        note("sin video tras 45 s: se pide recargar la pestaña");
        send({ type: "channel:sched-reload" });
      }
      return;
    }
    if (!videoSeenAt) videoSeenAt = Date.now();
    const d = v.duration;
    if (!isFinite(d) || d <= 0) return;
    reportDuration(v);
    if (!videoLogged) {
      videoLogged = true;
      note(`video visto: dura ${Math.round(d)}s; la parrilla pide la posicion ${Math.round(posS)}s`);
    }

    // El video dura menos que su hueco (o ya paso su final): negro (con el logo) hasta la hora exacta de fin.
    if (posS >= d - 0.25) {
      if (!v.paused) v.pause();
      if (!blackedOut) {
        blackedOut = true;
        window.CNOverlay?.setMode?.("black");
        window.CNOverlay?.fadeOut?.(0);
        note(`el video termino antes que su hueco (${Math.round(d)}s < ${Math.round(posS)}s): negro hasta el fin`);
      }
      return;
    }
    if (blackedOut) { blackedOut = false; window.CNOverlay?.reveal?.(300); }

    // Entrar en la posicion exacta: hora actual - inicio del hueco (calculada AHORA, no cuando se dio la orden).
    if (!joined) {
      joined = true;
      ownSeek(v, posS);
      if (savedMuted !== null) v.muted = savedMuted;
      v.play().catch(() => {});
      note(`entra en la posicion exacta ${posS.toFixed(1)} s`);
      return;
    }

    enforce(v);

    if (!coverHidden && !v.seeking && !v.paused && v.readyState >= 3) {
      coverHidden = true;
      const ms = Math.round(Date.now() - (goAt || performance.timeOrigin));
      note(`REPRODUCIENDO en sincronia (${ms} ms)`);
      window.CNOverlay?.reveal?.(400);
      window.CNOverlay?.showBug?.();
      send({ type: "channel:loaded", ms, preloaded: goAt > 0 });
    }
  }

  function tick() {
    if (!role) return;
    if (schedMode && role === "channel") return schedTick();

    // Max puede saltar solo al siguiente episodio (autoplay) sin recargar la pagina.
    if (watchId(location.href) !== expectedId) {
      return role === "preload" ? preloadFailed("navegacion-inesperada") : requestNext("navegacion-inesperada");
    }

    const v = mainVideo();
    if (!v) {
      if (Date.now() - loadedAt > NO_VIDEO_TIMEOUT_MS) {
        role === "preload" ? preloadFailed("sin-video") : requestNext("sin-video");
      }
      return;
    }
    const now = Date.now();
    if (!videoSeenAt) videoSeenAt = now;
    reportDuration(v);
    if (!videoLogged && isFinite(v.duration)) {
      videoLogged = true;
      note(`video visto (${role}): dura ${Math.round(v.duration)}s, readyState=${v.readyState}, ${v.paused ? "en pausa" : "reproduciendo"}`);
    }

    if (role === "preload") return holdPaused(v);

    // Ya se pidio el siguiente: esta pestaña queda callada; si el pedido fallo, se repite.
    if (guarding) {
      if (!nextSent) requestNext(lastReason);
      return;
    }

    // --- Inicio siempre en 0:00 ---
    if (now - videoSeenAt < START_WINDOW_MS) {
      findButton(START_OVER_RE)?.click();
      const t = v.currentTime;
      // Un salto grande hacia adelante en la ventana inicial es la reanudacion de Max.
      if ((prevT === null && t > 1.5) || (prevT !== null && t - prevT > 2)) v.currentTime = 0;
      if (playAllowed && v.paused && v.readyState >= 2) v.play().catch(() => {});
    }
    prevT = v.currentTime;

    // --- Retirar la pantalla de carga: el video ya corre de verdad desde el inicio ---
    if (!coverHidden) {
      const playing = !v.seeking && !v.paused && v.readyState >= 3 && v.currentTime > 0.05 && v.currentTime < 4;
      playingTicks = playing ? playingTicks + 1 : 0;
      if (playingTicks >= playingTicksNeeded) {
        coverHidden = true;
        const preloaded = goAt > 0;
        const ms = Math.round(preloaded ? Date.now() - goAt : Date.now() - performance.timeOrigin);
        console.log(`[CN canal] reproduciendo (${ms} ms${preloaded ? " desde el cambio, precargado" : " desde el inicio de la carga"})`);
        note(`REPRODUCIENDO (${ms} ms ${preloaded ? "desde el cambio" : "desde que cargo la pagina"})`);
        if (bumperMode && coverKind === "black") window.CNOverlay?.reveal?.(FADE_MS); // sale del negro
        else window.CNOverlay?.hide();
        window.CNOverlay?.showBug?.(); // marca de agua del canal mientras se ve el episodio
        send({ type: "channel:loaded", ms, preloaded });
      }
    }

    const d = v.duration;
    if (!isFinite(d) || d <= 0) return;
    const t = v.currentTime;

    // --- Precarga del siguiente (invisible para el usuario) ---
    // Se pide faltando ~60 s, o antes si Max ya muestra su aviso de "siguiente episodio"
    // (empiezan los creditos). El aviso solo cuenta pasada la mitad, porque la barra de
    // controles puede tenerlo visible desde el inicio.
    if (!preloadRequested) {
      const nearEnd = d - t <= Math.min(PRELOAD_LEAD_S, d * 0.3);
      if (nearEnd || (t > d * 0.5 && findButton(NEXT_RE))) {
        preloadRequested = true;
        sendWithRetry({ type: "channel:preload" }, () => setTimeout(() => { preloadRequested = false; }, 10000));
      }
    }

    // Con el aviso de Max a la vista, se pulsa "Ver creditos" para que Max no salte por su
    // cuenta a SU siguiente episodio y la outro suene completa.
    if (!creditsClicked && t > d * 0.5) {
      const credits = findButton(CREDITS_RE);
      if (credits) {
        creditsClicked = true;
        credits.click();
        console.log("[CN canal] pulsado 'Ver creditos' para cancelar el autoplay de Max");
      }
    }

    // --- Final: solo cuando el episodio termina de verdad (la outro se escucha completa) ---
    if (bumperMode) {
      // Fundido a negro durante el ultimo segundo; al terminar se pasa al bumper.
      const left = d - t;
      if (!fading && (left <= FADE_MS / 1000 + 0.05 || v.ended)) {
        fading = true;
        window.CNOverlay?.fadeOut?.(Math.max(250, Math.round(left * 1000)));
      }
      if (v.ended || left <= 0.15) return requestNext("terminado");
      return;
    }
    if (v.ended || d - t <= 1.5) return requestNext("terminado");
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "go") onGo(msg);
  });

  (async () => {
    if (!/\/video\/watch\//.test(location.pathname)) return;
    let status;
    try {
      // overlay.js ya pregunto en document_start; reutiliza esa respuesta.
      status = await (window.__cnStatus || chrome.runtime.sendMessage({ type: "channel:status" }));
    } catch (_) {
      return;
    }
    if (!status?.active) return;

    role = status.role;
    bumperMode = !!status.bumpers;
    coverKind = bumperMode ? "black" : "loading";
    expectedId = watchId(status.expectedUrl);
    expectedUrl = status.expectedUrl || null;
    if (status.schedule) {
      schedMode = true;
      if (status.sched) {
        sched = status.sched;
        setClock(sched.serverNowMs);
        window.CNOverlay?.lock?.(); // el usuario solo mira: se bloquean los controles desde el primer instante
      }
    }
    loadedAt = Date.now();
    console.log(`[CN canal] ${role === "preload" ? "precargando" : "controlando"} episodio`, expectedId);
    note(`controlador iniciado como ${role} (bumpers=${bumperMode})`);
    if (role === "preload") window.CNOverlay?.hold(); // que la pantalla siga puesta hasta el cambio
    setInterval(tick, schedMode ? SCHED_TICK_MS : TICK_MS);
    if (pendingGo && role === "preload") onGo(pendingGo); // "go" llego mientras se consultaba el estado
  })();
})();
