import { useEffect, useRef } from "react";
import { linkProps } from "../router.js";

// Menu de configuracion en pantalla (estilo OSD de TV). Se abre con el boton CONFIG del control.
export default function ConfigPanel({ open, onClose, bumpers, smart, onMode, go }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const { supported, folderName, count, busy, status } = bumpers;
  const hasFolder = !!folderName;
  // Estado efectivo: "activado" solo cuenta si hay carpeta (la preferencia puede quedar guardada sin ella).
  const enabled = bumpers.enabled && hasFolder;
  const mode = smart?.config?.mode || "normal";

  return (
    <div className="cfg-backdrop" onClick={onClose}>
      <section className="cfg" role="dialog" aria-modal="true" aria-labelledby="cfg-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="cfg-title" className="cfg__title">CONFIGURACIÓN</h2>

        <div className="cfg__row">
          <span>MODO</span>
          <div className="cfg__seg" role="radiogroup" aria-label="Modo de reproducción">
            <button type="button" role="radio" aria-checked={mode === "normal"} className={mode === "normal" ? "is-on" : ""} disabled={!smart?.config} onClick={() => onMode("normal")}>NORMAL</button>
            <button type="button" role="radio" aria-checked={mode === "smart"} className={mode === "smart" ? "is-on" : ""} disabled={!smart?.config} onClick={() => onMode("smart")}>HORARIO</button>
          </div>
        </div>
        {!smart?.config && <p className="cfg__hint">Instala/activa la extensión para cambiar el modo.</p>}
        <a className="cfg__link" {...linkProps("/settings", go)}>PROGRAMACIÓN ›</a>

        <h3 className="cfg__sub">BUMPERS</h3>
        {!supported ? (
          <p className="cfg__warn">Este navegador no permite elegir carpetas. Usa Chrome o Edge.</p>
        ) : (
          <>
            <div className="cfg__row">
              <span>BUMPERS</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                className={`cfg__switch${enabled ? " is-on" : ""}`}
                disabled={!hasFolder}
                onClick={() => bumpers.setEnabled(!enabled)}
              >
                {enabled ? "SÍ" : "NO"}
              </button>
            </div>
            <div className="cfg__row">
              <span>CARPETA</span>
              <b title={folderName ?? ""}>{folderName ?? "— NINGUNA —"}</b>
            </div>
            <div className="cfg__row">
              <span>VIDEOS .MP4</span>
              <b>{!hasFolder ? "—" : count === null ? "SIN ANALIZAR" : count}</b>
            </div>

            <div className="cfg__actions">
              <button type="button" onClick={bumpers.chooseFolder} disabled={busy}>ELEGIR CARPETA</button>
              {hasFolder && <button type="button" onClick={bumpers.prepare} disabled={busy}>ANALIZAR</button>}
              {hasFolder && <button type="button" onClick={bumpers.forgetFolder} disabled={busy}>QUITAR</button>}
            </div>

            <p className="cfg__hint">
              {mode === "smart"
                ? "En Horario Inteligente los bumpers y promos salen donde dicta la parrilla."
                : enabled && hasFolder
                  ? "Entre episodios sonará un bumper al azar mientras carga el siguiente."
                  : "Sin bumpers se usa la pantalla de carga."}
              {(enabled || mode === "smart") && hasFolder && " Al pulsar ▶ el navegador puede pedir permiso para leer la carpeta."}
            </p>
            {status && <p className="cfg__status" role="status">{status}</p>}
          </>
        )}

        <button type="button" ref={closeRef} className="cfg__close" onClick={onClose}>CERRAR</button>
      </section>
    </div>
  );
}
