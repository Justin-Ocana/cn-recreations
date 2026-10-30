import { CN, DAY } from "../schedule/engine.js";
import { describeItem, resolveNow, TYPE_LABEL, useNow, useSmart } from "../schedule/smartStore.js";
import { linkProps } from "../router.js";

const deviceTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (_) { return "UTC"; }
};

// "HH:MM:SS" de un instante en la zona horaria del canal.
export const channelClock = (ms, tz) => CN.fmtClock(CN.weekMsOf(ms, tz || deviceTz()) % DAY);
const channelHM = (ms, tz) => channelClock(ms, tz).slice(0, 5);

// Ahora / siguiente a partir del resolver. En debug las horas son las de la linea comprimida (mm:ss).
export function nowNext(schedule, nowMs, debug) {
  const r = resolveNow(schedule, nowMs, debug);
  if (!r) return null;
  const tz = schedule.timeZone;
  const span = (startAbs, durMs) => (debug ? `${CN.fmtDuration(0)} — ${CN.fmtDuration(durMs)}` : `${channelHM(startAbs, tz)} — ${channelHM(startAbs + durMs, tz)}`);
  const c = r.current;
  const n = r.next;
  return {
    current: { ...describeItem(c.item), type: c.item.type, typeLabel: TYPE_LABEL[c.item.type], span: span(c.startAbsMs, c.item.durationMs), pos: CN.fmtDuration(c.positionMs), dur: CN.fmtDuration(c.item.durationMs), pct: Math.min(100, (c.positionMs / c.item.durationMs) * 100) },
    next: { ...describeItem(n.item), type: n.item.type, typeLabel: TYPE_LABEL[n.item.type], span: span(n.startAbsMs, n.item.durationMs) },
  };
}

// Reloj del canal, EN VIVO, aviso de debug y el "AHORA / SIGUIENTE". Solo se ve en Horario Inteligente.
export default function LiveHud({ go }) {
  const smart = useSmart();
  const now = useNow(250);
  const on = smart.config?.mode === "smart";
  if (!on) return null;

  const debug = !!smart.config.debug;
  const tz = smart.schedule?.timeZone || smart.config.plan?.timeZone;
  const nn = smart.schedule ? nowNext(smart.schedule, now, debug) : null;

  return (
    <>
      {debug && (
        <div className="hud__debug" role="alert">
          DEBUG ACTIVO — los episodios se reproducirán durante 15 segundos.
        </div>
      )}

      <div className="hud__clock" aria-label="Hora del canal">
        <span className="hud__time">{channelClock(now, tz)}</span>
        <span className="hud__live"><i aria-hidden="true" /> EN VIVO</span>
      </div>

      <div className="hud__card" aria-live="off">
        {nn ? (
          <>
            <div className="hud__label">AHORA <em>{nn.current.typeLabel}</em></div>
            <div className="hud__title">{nn.current.title}</div>
            {nn.current.subtitle && <div className="hud__sub">{nn.current.subtitle}</div>}
            <div className="hud__span">{nn.current.span} <span>· {nn.current.pos} / {nn.current.dur}</span></div>
            <div className="hud__bar"><i style={{ width: `${nn.current.pct}%` }} /></div>
            <div className="hud__next">
              <b>SIGUIENTE</b> {nn.next.title}
              {nn.next.subtitle ? ` — ${nn.next.subtitle}` : ""} <span>{nn.next.span}</span>
            </div>
          </>
        ) : (
          <div className="hud__sub">Sin parrilla: genera una en Ajustes → Programación.</div>
        )}
        <a className="hud__link" {...linkProps("/schedule", go)}>VER HORARIO ›</a>
      </div>
    </>
  );
}
