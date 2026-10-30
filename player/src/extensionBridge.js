// Comunicacion con la extension "CN Catalog Builder" (su bridge.js vive en esta pagina).
const ORIGIN = window.location.origin;

// Pide a la extension iniciar el canal. Responde { ok, error?, bumpers? }.
// error: "no-extension" | "catalog-empty" | otro texto.
// bumpers: true si el canal usara bumpers (esta pagina los reproducira).
// mode: "random" (modo normal) | "schedule" (Horario Inteligente). debug: linea de tiempo comprimida a 15 s.
export function playChannel({ bumpers = false, mode = "random", debug = false, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(result);
    };
    const onMessage = (e) => {
      if (e.source !== window || e.data?.source !== "cn-extension" || e.data.type !== "START_RESULT") return;
      finish(e.data);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "no-extension" }), timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage({ source: "cn-player", type: "PLAY", bumpers, mode, debug }, ORIGIN);
  });
}

// Mensajes que la extension le manda a la pagina: BUMPER_PLAY {token} | BUMPER_STOP. Devuelve como dejar de escuchar.
export function onExtensionMessage(handler) {
  const listener = (e) => {
    if (e.source !== window || e.data?.source !== "cn-extension") return;
    handler(e.data);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

// Le cuenta a la extension como va el bumper: "started" | "ended" | "error".
export function sendBumperState(state, token, error) {
  window.postMessage({ source: "cn-player", type: "BUMPER_STATE", state, token, error }, ORIGIN);
}
