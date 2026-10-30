import { useCallback, useEffect, useRef, useState } from "react";
import NoiseCanvas from "../components/NoiseCanvas.jsx";
import Logo from "../components/Logo.jsx";
import Remote from "../components/Remote.jsx";
import ConfigPanel from "../components/ConfigPanel.jsx";
import LiveHud from "../components/LiveHud.jsx";
import { playChannel } from "../extensionBridge.js";
import { saveConfig, useSmart } from "../schedule/smartStore.js";

const ERRORS = {
  "no-extension": "SIN SEÑAL · EXTENSIÓN NO DETECTADA",
  "catalog-empty": "SIN CANALES · CATÁLOGO VACÍO",
  "no-schedule": "SIN PARRILLA · GENÉRALA EN AJUSTES",
};

// Por que no se pudieron usar los bumpers (el canal sigue, con pantalla de carga).
const BUMPER_ERRORS = {
  "sin-carpeta": "BUMPERS: ELIGE UNA CARPETA EN CONFIG",
  permiso: "BUMPERS: PERMISO DENEGADO",
  vacio: "BUMPERS: LA CARPETA NO TIENE VIDEOS",
  lectura: "BUMPERS: NO SE PUDO LEER LA CARPETA",
};

export default function TvPage({ go, bumpers }) {
  const [transmitting, setTransmitting] = useState(false);
  const [flash, setFlash] = useState(null); // { text, id }
  const [configOpen, setConfigOpen] = useState(false);
  const smart = useSmart();
  const smartOn = smart.config?.mode === "smart";
  const txTimer = useRef(0);
  const flashTimer = useRef(0);

  useEffect(() => () => {
    clearTimeout(txTimer.current);
    clearTimeout(flashTimer.current);
  }, []);

  // Al pulsar una tecla, el LED infrarrojo del control parpadea.
  const blip = useCallback(() => {
    setTransmitting(true);
    clearTimeout(txTimer.current);
    txTimer.current = setTimeout(() => setTransmitting(false), 200);
  }, []);

  const showOsd = useCallback((text, ms = 1800) => {
    setFlash({ text, id: Date.now() });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), ms);
  }, []);

  // Play. Modo normal: la extension abre un episodio al azar y sigue sola (con bumpers si estan activos).
  // Horario Inteligente: sintoniza el canal -lo que la parrilla dice que esta al aire AHORA, en su posicion exacta-.
  const handlePlay = async () => {
    blip();
    setConfigOpen(false);

    if (smartOn) {
      showOsd("▶ SINTONIZANDO…", 6000);
      if (!smart.schedule) return showOsd(ERRORS["no-schedule"], 4500);
      // Esta pagina reproduce los bumpers/promos de la parrilla: necesita la carpeta (permiso = este clic).
      if (bumpers.folderName) {
        const prep = await bumpers.prepare();
        if (!prep.ok) showOsd(BUMPER_ERRORS[prep.error] ?? "BUMPERS NO DISPONIBLES", 4500);
      }
      const res = await playChannel({ mode: "schedule", bumpers: true, debug: !!smart.config.debug });
      if (!res.ok) showOsd(ERRORS[res.error] ?? `ERROR · ${res.error}`, 4500);
      return;
    }

    showOsd("▶ PLAY", 6000);
    let useBumpers = false;
    if (bumpers.enabled) {
      // Lo primero que se hace en el clic: pedir permiso de la carpeta necesita ese gesto del usuario.
      const prep = await bumpers.prepare();
      if (prep.ok) useBumpers = true;
      else showOsd(BUMPER_ERRORS[prep.error] ?? "BUMPERS NO DISPONIBLES", 4500);
    }

    const res = await playChannel({ bumpers: useBumpers });
    if (!res.ok) showOsd(ERRORS[res.error] ?? `ERROR · ${res.error}`, 4500);
  };

  const handleConfig = () => {
    blip();
    setConfigOpen((open) => !open);
  };

  const setMode = (mode) => {
    if (smart.config) saveConfig({ ...smart.config, mode }).catch(() => showOsd("NO SE PUDO GUARDAR EL MODO", 3000));
  };

  return (
    <main className="tv" data-tx={transmitting}>
      <NoiseCanvas />
      <div className="crt" aria-hidden="true" />

      <header className="tv__top">
        <Logo />
      </header>

      <div className="osd" aria-live="polite">
        <span className="osd__ch">CH&nbsp;03</span>
        {flash ? (
          <p key={flash.id} className="osd__msg osd__msg--flash">{flash.text}</p>
        ) : (
          <p className="osd__msg osd__msg--hint">
            {smartOn ? "PRESIONA ▶ PARA SINTONIZAR" : "PRESIONA ▶ PARA EMPEZAR"}
          </p>
        )}
      </div>

      <div className="tv__remote">
        <Remote onPlay={handlePlay} onConfig={handleConfig} transmitting={transmitting} />
      </div>

      <LiveHud go={go} />
      {!smartOn && (
        <a className="hud__link hud__link--solo" href="/schedule" onClick={(e) => { e.preventDefault(); go("/schedule"); }}>
          VER HORARIO ›
        </a>
      )}

      <ConfigPanel open={configOpen} onClose={() => setConfigOpen(false)} bumpers={bumpers} smart={smart} onMode={setMode} go={go} />
    </main>
  );
}
