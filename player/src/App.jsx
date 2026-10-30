import { useEffect, useState } from "react";
import { usePath } from "./router.js";
import TvPage from "./pages/TvPage.jsx";
import SchedulePage from "./pages/SchedulePage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import BumperLayer from "./components/BumperLayer.jsx";
import ChannelBug from "./components/ChannelBug.jsx";
import { useBumpers } from "./bumpers/useBumpers.js";
import { onExtensionMessage, sendBumperState } from "./extensionBridge.js";

// "/" televisor · "/schedule" guia de programacion · "/settings" programacion (ajustes)
//
// Los bumpers y el logo viven AQUI (siempre montados): esta pestaña es la "sala de bumpers" del canal y debe poder
// reproducirlos aunque el usuario tenga abierta la guia o los ajustes.
export default function App() {
  const [path, go] = usePath();
  const bumpers = useBumpers();
  const [bumper, setBumper] = useState(null); // { token, id, name, url, ended, scheduled?, ... } | null
  const { pick, pickById, markBad } = bumpers;

  // La extension pide un bumper (BUMPER_PLAY) o que se pare (BUMPER_STOP).
  useEffect(
    () =>
      onExtensionMessage(async (msg) => {
        if (msg.type === "BUMPER_PLAY") {
          if (msg.filler || msg.clip || msg.endAbsMs != null) {
            // Horario Inteligente: un clip CONCRETO (o relleno), entrando en su posicion exacta, hasta su hora de fin.
            const recvPerf = performance.now();
            const item = msg.clip && !msg.filler ? await pickById(msg.clip.id) : null;
            const endAt = msg.endAbsMs != null && msg.serverNowMs != null ? recvPerf + (msg.endAbsMs - msg.serverNowMs) : null;
            setBumper({
              token: msg.token, id: msg.clip?.id, name: msg.clip?.name, url: item?.url ?? null, ended: false,
              scheduled: true, startAtMs: msg.positionMs || 0, recvPerf, endAt,
            });
            return;
          }
          const item = await pick();
          if (!item) return sendBumperState("error", msg.token, "sin-bumpers");
          setBumper({ token: msg.token, ...item, ended: false });
        } else if (msg.type === "BUMPER_STOP") {
          setBumper(null);
        }
      }),
    [pick, pickById]
  );

  const page =
    path === "/schedule" ? <SchedulePage go={go} bumpers={bumpers} /> :
    path === "/settings" ? <SettingsPage go={go} bumpers={bumpers} /> :
    <TvPage go={go} bumpers={bumpers} />;

  return (
    <>
      {page}

      <BumperLayer
        bumper={bumper}
        onStarted={(token) => sendBumperState("started", token)}
        onEnded={(token) => {
          setBumper((b) => (b && b.token === token ? { ...b, ended: true } : b)); // queda en negro
          sendBumperState("ended", token);
        }}
        onError={(token, id, error) => {
          markBad(id);
          // En la parrilla el hueco manda: si un clip falla se queda en negro hasta su hora de fin.
          setBumper((b) => (b && b.token === token && !b.scheduled ? { ...b, ended: true } : b));
          sendBumperState("error", token, error);
        }}
      />

      {(path === "/" || bumper) && <ChannelBug />}
    </>
  );
}
