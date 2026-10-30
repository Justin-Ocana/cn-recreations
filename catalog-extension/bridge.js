// Puente entre la pagina del reproductor (localhost) y la extension.
// La pagina habla con window.postMessage; aqui se reenvia al service worker (y viceversa).
//
//   pagina -> extension:  PLAY {bumpers, mode, debug} -> channel:start
//                         SMART {op, payload, reqId}  -> smart:<op>            (respuesta: SMART_RESULT {reqId, ok, data|error})
//                         BUMPER_STATE {state,...} -> channel:bumper-state   (started | ended | error)
//   extension -> pagina:  bumper:play / bumper:stop -> BUMPER_PLAY {token, clip?, filler?, positionMs?, endAbsMs?, serverNowMs?} / BUMPER_STOP
(() => {
  // Operaciones del Horario Inteligente que la pagina puede pedir ("record-duration" es solo de las pestañas de Max).
  const SMART_OPS = new Set(["get", "catalog", "save-config", "generate", "import", "time"]);

  const reply = (type, data = {}) =>
    window.postMessage({ source: "cn-extension", type, ...data }, window.location.origin);

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.source !== "cn-player") return;

    if (e.data.type === "PING") return reply("PONG");

    if (e.data.type === "PLAY") {
      try {
        reply("START_RESULT", await chrome.runtime.sendMessage({
          type: "channel:start", bumpers: !!e.data.bumpers,
          mode: e.data.mode === "schedule" ? "schedule" : "random", debug: e.data.debug === true,
        }));
      } catch (err) {
        reply("START_RESULT", { ok: false, error: String(err?.message || err) });
      }
    }

    if (e.data.type === "SMART") {
      const { op, payload, reqId } = e.data;
      if (!SMART_OPS.has(op)) return reply("SMART_RESULT", { reqId, ok: false, error: "operacion no permitida: " + op });
      try {
        const res = await chrome.runtime.sendMessage({ type: "smart:" + op, ...(payload || {}) });
        reply("SMART_RESULT", { reqId, ...(res || { ok: false, error: "sin respuesta" }) });
      } catch (err) {
        reply("SMART_RESULT", { reqId, ok: false, error: String(err?.message || err) });
      }
      return;
    }

    if (e.data.type === "BUMPER_STATE") {
      const { state, token, error } = e.data;
      if (["started", "ended", "error"].includes(state)) {
        chrome.runtime.sendMessage({ type: "channel:bumper-state", state, token, error: error ? String(error) : undefined }).catch(() => {});
      }
    }
  });

  // La extension le pide a la pagina que reproduzca (o pare) un bumper.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "bumper:play") {
      const { token, clip, filler, positionMs, endAbsMs, serverNowMs } = msg;
      reply("BUMPER_PLAY", { token, clip, filler, positionMs, endAbsMs, serverNowMs });
    }
    if (msg?.type === "bumper:stop") reply("BUMPER_STOP");
  });
})();
