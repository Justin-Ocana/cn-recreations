import { useEffect, useMemo, useRef, useState } from "react";
import { channelClock, nowNext } from "../components/LiveHud.jsx";
import { CN, DAY, DAY_NAMES } from "../schedule/engine.js";
import { regenerate } from "../schedule/regenerate.js";
import { describeItem, resolveNow, TYPE_LABEL, useNow, useSmart } from "../schedule/smartStore.js";
import { linkProps } from "../router.js";

const MODE_LABEL = { random: "Aleatorio", specific: "Específicos", auto: "Automático" };

// Guia de programacion tipo EPG: el dia elegido, bloque por bloque, con hora exacta de inicio y fin.
export default function SchedulePage({ go, bumpers }) {
  const smart = useSmart();
  const now = useNow(1000);
  const sch = smart.schedule;
  const tz = sch?.timeZone;
  const today = sch ? Math.floor(CN.weekMsOf(now, tz) / DAY) : 0;
  const [day, setDay] = useState(null);
  const [showClips, setShowClips] = useState(true);
  const [progress, setProgress] = useState("");
  const [note, setNote] = useState(null);
  const nowRef = useRef(null);
  const d = day ?? today;

  const byDay = useMemo(() => {
    const days = Array.from({ length: 7 }, () => []);
    if (sch) for (const it of sch.items) days[it.day].push(it);
    return days;
  }, [sch]);

  const cur = sch ? resolveNow(sch, now, false) : null;
  const curId = cur?.current.item.id;
  const nn = sch ? nowNext(sch, now, false) : null;
  const debug = !!smart.config?.debug;

  // Al abrir (o al pulsar "Ahora") la guia se centra en lo que esta al aire.
  const [jump, setJump] = useState(0);
  useEffect(() => { nowRef.current?.scrollIntoView({ block: "center" }); }, [sch, d === today, jump]); // eslint-disable-line react-hooks/exhaustive-deps

  async function regen() {
    setNote(null);
    try {
      const { schedule, notes } = await regenerate({ bumpers, config: smart.config, onProgress: setProgress });
      setNote({ kind: notes.length ? "warn" : "ok", text: `Nueva parrilla generada (semilla #${schedule.seed}).`, list: notes });
    } catch (e) {
      setNote({ kind: "err", text: `No se pudo regenerar: ${e.message}` });
    } finally {
      setProgress("");
    }
  }

  const groups = useMemo(() => {
    const out = [];
    for (const it of byDay[d]) {
      if (!showClips && it.type !== "episode") continue;
      const last = out[out.length - 1];
      if (last && last.blockIndex === it.blockIndex) last.items.push(it);
      else out.push({ blockIndex: it.blockIndex, block: sch.blocks[it.blockIndex], items: [it] });
    }
    return out;
  }, [byDay, d, showClips, sch]);

  return (
    <div className="page epg">
      <header className="page__head">
        <a className="back" {...linkProps("/", go)}>‹ Televisor</a>
        <h1>Guía de programación</h1>
        <div className="page__clock">
          <span className="hud__time">{channelClock(now, tz)}</span>
          <span className="hud__live"><i aria-hidden="true" /> EN VIVO</span>
        </div>
      </header>

      <main className="page__body">
        {debug && <div className="banner banner--debug" role="alert">DEBUG ACTIVO — los episodios se reproducirán durante 15 segundos. Esta guía muestra la parrilla real.</div>}

        {smart.status === "error" && (
          <div className="banner banner--err">
            {smart.error === "no-extension" ? "No se detecta la extensión «CN Catalog Builder»." : `Error: ${smart.error}`}
          </div>
        )}

        {smart.status !== "error" && !sch && (
          <section className="card empty">
            <h2>Todavía no hay una parrilla</h2>
            <p className="muted">Genera una desde los ajustes de Programación.</p>
            <a className="btn btn--primary" {...linkProps("/settings", go)}>Ir a Ajustes ›</a>
          </section>
        )}

        {sch && (
          <>
            <section className="card nowcard">
              <div className="nowcard__live"><i aria-hidden="true" /> EN VIVO</div>
              <div className="nowcard__main">
                <div className="nowcard__title">{nn.current.title}</div>
                <div className="nowcard__sub">{nn.current.subtitle || nn.current.typeLabel}</div>
                <div className="nowcard__time">{nn.current.pos} / {nn.current.dur} <span>· {nn.current.span}</span></div>
                <div className="hud__bar"><i style={{ width: `${nn.current.pct}%` }} /></div>
              </div>
              <div className="nowcard__next">
                <b>SIGUIENTE</b>
                <div>{nn.next.title}{nn.next.subtitle ? ` — ${nn.next.subtitle}` : ""}</div>
                <small>{nn.next.span}</small>
              </div>
            </section>

            <div className="epg__bar">
              <div className="tabs" role="tablist" aria-label="Día">
                {DAY_NAMES.map((n, i) => (
                  <button key={n} type="button" role="tab" aria-selected={d === i} className={`${d === i ? "is-on" : ""}${i === today ? " is-today" : ""}`} onClick={() => setDay(i)}>
                    {n}{i === today && <em>hoy</em>}
                  </button>
                ))}
              </div>
              <div className="epg__tools">
                <label className="switch"><input type="checkbox" checked={showClips} onChange={(e) => setShowClips(e.target.checked)} /><span>Bumpers y promos</span></label>
                <button type="button" className="btn" onClick={() => { setDay(null); setJump((j) => j + 1); }}>Ahora</button>
                <button type="button" className="btn btn--primary" disabled={!!progress} onClick={regen}>Regenerar horario</button>
                <a className="btn" {...linkProps("/settings", go)}>Ajustes</a>
              </div>
            </div>

            {progress && <p className="progress" role="status">{progress}</p>}
            {note && (
              <div className={`banner banner--${note.kind}`} role="status">
                {note.text}
                {note.list?.length > 0 && <ul>{note.list.map((t, i) => <li key={i}>{t}</li>)}</ul>}
              </div>
            )}

            <h2 className="epg__day">{DAY_NAMES[d]}{d === today && <em> · hoy</em>}</h2>

            <div className="epg__list">
              {groups.map((g) => (
                <section key={`${g.blockIndex}`} className="epg__block">
                  <header>
                    <b>{CN.fmtHM(g.block.startMs)} — {CN.fmtHM(g.block.endMs === 7 * DAY ? 0 : g.block.endMs)}</b>
                    <span>{g.block.name}</span>
                    <em className={`mode mode--${g.block.mode}`}>{MODE_LABEL[g.block.mode]}</em>
                  </header>
                  {g.items.map((it) => {
                    const info = describeItem(it);
                    const live = it.id === curId;
                    return (
                      <div key={it.id} ref={live ? nowRef : null} className={`epg__row epg__row--${it.type}${live ? " is-now" : ""}`}>
                        <span className="t">{CN.fmtClock(it.startMs)}</span>
                        <span className="t t--end">{CN.fmtClock(it.endMs === 7 * DAY ? 0 : it.endMs)}</span>
                        <span className={`badge badge--${it.type}`}>{TYPE_LABEL[it.type]}</span>
                        <span className="what"><b>{info.title}</b>{info.subtitle && <small>{info.subtitle}</small>}</span>
                        <span className="dur">{CN.fmtDuration(it.durationMs)}</span>
                        {live && <span className="tag">AHORA</span>}
                      </div>
                    );
                  })}
                </section>
              ))}
              {!groups.length && <p className="muted">Este día no tiene contenido con los filtros actuales.</p>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
