// Pantalla propia que tapa a Max. Dos modos, los dos sobre el MISMO negro liso (asi el paso de uno a
// otro, o de un fundido a la pantalla de carga, no se nota):
//   "loading": negro con un indicador discreto ("CARGANDO" tenue y tres cuadritos) - cuando no hay bumpers.
//   "black":   negro liso, sin indicador - con bumpers, para los fundidos a/desde negro.
// En ambos se ve el logo del canal (abajo a la derecha, como en la TV).
// Corre en document_start para cubrir la pagina desde el primer instante. Comparte el mundo
// aislado con controller.js, que la retira cuando el video ya se esta reproduciendo.
(() => {
  if (window.CNOverlay) return;

  const MIN_VISIBLE_MS = 1500; // tiempo minimo en pantalla (tambien evita parpadeos)
  const FAILSAFE_MS = 25000;   // si algo se atasca, deja ver Max en vez de tapar el error
  const FADE_MS = 400;

  let host = null;
  let mode = "loading"; // "loading" | "black"
  let shownAt = 0;
  let failsafe = 0;

  // Logo del canal (marca de agua abajo a la derecha, como en la TV). Es el MISMO estilo en la
  // pantalla de carga y suelto sobre el video, para que no se mueva ni cambie al alternar entre ambos.
  // El logo va tal cual es (sin placa ni contorno), como en el original.
  const BUG_RULE = `
    .bug {
      position: fixed; right: clamp(14px, 3vw, 44px); bottom: clamp(14px, 3.5vh, 40px);
      width: clamp(84px, 9vw, 170px); height: auto; opacity: .94;
      z-index: 2147483646; pointer-events: none; user-select: none;
      filter: drop-shadow(0 2px 5px rgba(0,0,0,.55));
    }`;

  // <img> del logo; si logo.png no existe, se retira solo (sin icono de imagen rota).
  function makeBug() {
    const img = document.createElement("img");
    img.className = "bug";
    img.alt = "";
    img.draggable = false;
    img.onerror = () => img.remove();
    img.src = chrome.runtime.getURL("logo.png");
    return img;
  }

  // Discreta a proposito: fondo negro, sin estatica ni colores fuertes; el indicador va en gris
  // apagado y pequeño, y aparece con un fundido suave para que no "salte" a la vista.
  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; inset: 0; z-index: 2147483647; background: #000;
      display: grid; place-items: center; cursor: none; opacity: 1;
      transition: opacity var(--dur, ${FADE_MS}ms) ease;
    }
    .wrap.out { opacity: 0; pointer-events: none; }
    .wrap:not(.black) { animation: soft-in .45s ease-out backwards; }
    .wrap.black .center { display: none; }
    .center {
      display: grid; justify-items: center; gap: clamp(10px, 1.6vh, 16px);
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    }
    .sq { display: flex; gap: 6px; }
    .sq i { width: 7px; height: 7px; background: #5d5d5d; opacity: .2; animation: sq 1.3s ease-in-out infinite; }
    .sq i:nth-child(2) { animation-delay: .16s; }
    .sq i:nth-child(3) { animation-delay: .32s; }
    .txt {
      padding-left: .42em; color: #5f5f5f; text-transform: uppercase;
      font-size: clamp(10px, .95vw, 13px); font-weight: 700; letter-spacing: .42em;
    }
    @keyframes sq { 0%, 100% { opacity: .2; } 40% { opacity: .85; } }
    @keyframes soft-in { from { opacity: 0; } to { opacity: 1; } }
    ${BUG_RULE}
  `;

  const HTML = `
    <div class="wrap">
      <div class="center">
        <div class="sq"><i></i><i></i><i></i></div>
        <div class="txt">Cargando</div>
      </div>
    </div>`;

  function mount() {
    const parent = document.documentElement;
    if (!parent) return document.addEventListener("readystatechange", mount, { once: true });
    if (host?.isConnected) return;

    host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    parent.append(host);
    host.__wrap = root.querySelector(".wrap");
    host.__wrap.classList.toggle("black", mode === "black");
    host.__wrap.append(makeBug()); // el logo tambien se ve durante la carga
  }

  function teardown() {
    clearTimeout(failsafe);
    host?.remove();
    host = null;
    shownAt = 0;
  }

  // ----- Logo suelto sobre el video (cuando no hay pantalla de carga) -----
  let bugHost = null;

  function showBug() {
    if (bugHost?.isConnected) return;
    const parent = document.documentElement;
    if (!parent) return;
    bugHost = document.createElement("div");
    const root = bugHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ":host { all: initial; }" + BUG_RULE;
    const img = makeBug();
    img.addEventListener("error", () => hideBug());
    root.append(style, img);
    parent.append(bugHost);
  }

  function hideBug() {
    bugHost?.remove();
    bugHost = null;
  }

  // ----- Bloqueo del reproductor (Horario Inteligente): el usuario solo mira -----
  // Una capa transparente a pantalla completa se traga los clics/toques/rueda (asi no se llega a los controles de Max)
  // y se interceptan las teclas que mueven la posicion. Ocultar controles NO basta: la posicion real la vigila el
  // controlador (controller.js) y revierte cualquier cambio.
  const BLOCKED_KEYS = new Set([" ", "k", "K", "j", "J", "l", "L", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", ",", ".", "<", ">",
    "MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "MediaRewind", "MediaFastForward", "MediaStop", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  const LOCK_CSS = `
    :host { all: initial; }
    .shield { position: fixed; inset: 0; z-index: 2147483645; background: transparent; cursor: none; }
    .clock {
      position: fixed; left: clamp(14px, 3vw, 44px); bottom: clamp(14px, 3.5vh, 40px); z-index: 2147483646;
      display: flex; align-items: center; gap: 10px; padding: 4px 10px; color: #fff; opacity: .85; pointer-events: none;
      font: 700 clamp(15px, 1.5vw, 22px)/1 "Helvetica Neue", Helvetica, Arial, sans-serif; letter-spacing: .06em;
      background: rgba(0,0,0,.45); text-shadow: 0 1px 3px #000; font-variant-numeric: tabular-nums;
    }
    .clock i { display: inline-flex; align-items: center; gap: 6px; font-style: normal; font-size: .62em; color: #ff5148; letter-spacing: .14em; }
    .clock i::before { content: ""; width: .7em; height: .7em; border-radius: 50%; background: #ff3b30; box-shadow: 0 0 8px #ff3b30; }
  `;
  let lockHost = null;
  let clockEl = null;
  let keyBlock = null;

  function lock() {
    if (lockHost?.isConnected) return;
    const parent = document.documentElement;
    if (!parent) return;
    lockHost = document.createElement("div");
    const root = lockHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = LOCK_CSS;
    const shield = document.createElement("div");
    shield.className = "shield";
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    for (const ev of ["click", "dblclick", "mousedown", "mouseup", "contextmenu", "wheel", "touchstart", "touchend", "pointerdown", "pointerup"]) {
      shield.addEventListener(ev, swallow, { passive: false });
    }
    clockEl = document.createElement("div");
    clockEl.className = "clock";
    clockEl.innerHTML = "<span></span><i>EN VIVO</i>";
    root.append(style, shield, clockEl);
    parent.append(lockHost);

    keyBlock = (e) => {
      if (BLOCKED_KEYS.has(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener("keydown", keyBlock, true);
    window.addEventListener("keyup", keyBlock, true);
    try {
      for (const a of ["play", "pause", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack", "stop"]) {
        navigator.mediaSession?.setActionHandler(a, () => {});
      }
    } catch (_) {}
  }

  function unlock() {
    lockHost?.remove();
    lockHost = null;
    clockEl = null;
    if (keyBlock) {
      window.removeEventListener("keydown", keyBlock, true);
      window.removeEventListener("keyup", keyBlock, true);
      keyBlock = null;
    }
  }

  window.CNOverlay = {
    showBug,
    hideBug,
    lock,
    unlock,
    isLocked: () => !!lockHost?.isConnected,
    setClock(text) {
      const el = clockEl?.firstChild;
      if (el && el.textContent !== text) el.textContent = text;
    },
    show() {
      if (!shownAt) shownAt = Date.now();
      clearTimeout(failsafe);
      failsafe = setTimeout(() => this.hide(), FAILSAFE_MS);
      if (host?.__wrap) host.__wrap.classList.remove("out");
      mount();
    },
    // La pantalla se queda puesta indefinidamente (pestaña precargada, oculta): sin el
    // seguro de 25 s, para que al activarse la pestaña no se vea Max sin tapar.
    hold() {
      clearTimeout(failsafe);
    },
    // Vuelve a contar el tiempo minimo desde ahora (p. ej. al activarse una pestaña precargada).
    restart() {
      shownAt = 0;
      this.show();
    },
    // Se cumple cuando falten `leadMs` para completar el tiempo minimo visible.
    whenMinVisible(leadMs = 0) {
      const wait = Math.max(0, MIN_VISIBLE_MS - leadMs - (Date.now() - shownAt));
      return new Promise((resolve) => setTimeout(resolve, wait));
    },
    // Se oculta con fundido, respetando un minimo de tiempo visible.
    hide() {
      if (!host) return;
      const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
      setTimeout(() => {
        host?.__wrap?.classList.add("out");
        setTimeout(teardown, FADE_MS + 50);
      }, wait);
    },
    // Quita la pantalla sin fundido (cuando esta pestaña no es el canal).
    remove: teardown,

    // ----- Modo con bumpers -----
    setMode(m) {
      mode = m === "black" ? "black" : "loading";
      host?.__wrap?.classList.toggle("black", mode === "black");
    },
    getMode: () => mode,

    // Fundido A negro (final de episodio): el negro aparece durante `ms`.
    fadeOut(ms = 1000) {
      mode = "black";
      clearTimeout(failsafe); // este negro no debe retirarse solo
      const wasUp = !!host?.isConnected && !host.__wrap.classList.contains("out");
      mount();
      const wrap = host?.__wrap;
      if (!wrap) return;
      wrap.classList.add("black");
      if (wasUp) return; // ya estaba tapando: nada que animar
      wrap.style.setProperty("--dur", "0ms");
      wrap.classList.add("out");
      void wrap.offsetWidth; // fija opacidad 0 antes de animar
      wrap.style.setProperty("--dur", ms + "ms");
      wrap.classList.remove("out");
    },

    // Fundido DESDE negro (inicio de episodio): el negro se retira durante `ms`, sin tiempo minimo.
    reveal(ms = 1000) {
      clearTimeout(failsafe);
      const wrap = host?.__wrap;
      if (!wrap) return;
      wrap.style.setProperty("--dur", ms + "ms");
      wrap.classList.add("out");
      setTimeout(teardown, ms + 50);
    },
  };

  // En paginas de reproduccion, tapa Max de inmediato y confirma despues si es el canal.
  if (/\/video\/watch\//.test(location.pathname)) {
    window.CNOverlay.show();
    window.__cnStatus = chrome.runtime
      .sendMessage({ type: "channel:status" })
      .catch(() => ({ active: false }));
    window.__cnStatus.then((s) => {
      if (!s?.active) return window.CNOverlay.remove();
      if (s.bumpers) window.CNOverlay.setMode("black"); // con bumpers no hay "cargando": fundidos a negro
      if (s.role === "channel") window.CNOverlay.showBug(); // la marca de agua no debe faltar en ningun momento
    });
  }
})();
