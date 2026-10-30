// Cliente de mensajes hacia el modulo del Horario Inteligente de la extension (via su bridge.js).
const ORIGIN = window.location.origin;
let seq = 0;

// smartRequest("get") -> datos. Rechaza con Error("no-extension") si la extension no responde a tiempo.
export function smartRequest(op, payload = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const reqId = `r${Date.now().toString(36)}_${++seq}`;
    const done = (fn, value) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      fn(value);
    };
    const onMessage = (e) => {
      const d = e.data;
      if (e.source !== window || d?.source !== "cn-extension" || d.type !== "SMART_RESULT" || d.reqId !== reqId) return;
      if (d.ok) done(resolve, d.data);
      else done(reject, new Error(d.error || "error"));
    };
    const timer = setTimeout(() => done(reject, new Error("no-extension")), timeoutMs);
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "cn-player", type: "SMART", op, payload, reqId }, ORIGIN);
  });
}
