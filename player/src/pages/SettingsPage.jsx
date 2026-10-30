import { useEffect, useMemo, useRef, useState } from "react";
import BlockEditor from "../components/BlockEditor.jsx";
import { channelClock } from "../components/LiveHud.jsx";
import { downloadJson, regenerate } from "../schedule/regenerate.js";
import { importSchedule, loadCatalog, saveConfig, useNow, useSmart } from "../schedule/smartStore.js";
import { linkProps } from "../router.js";

const AVOID = [[0, "Desactivado"], [1, "Último episodio"], [3, "Últimos 3 episodios"], [5, "Últimos 5 episodios"], [10, "Últimos 10 episodios"]];
const ZONES = (() => { try { return Intl.supportedValuesOf("timeZone"); } catch (_) { return ["UTC", "America/Mexico_City", "America/Bogota", "America/Argentina/Buenos_Aires", "Europe/Madrid"]; } })();

const newBlock = (plan) => ({
  id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
  name: "", seriesKey: "", start: "14:00", days: [0, 1, 2, 3, 4, 5, 6], durationMin: plan.defaultBlockMinutes || 60,
  selection: { mode: "random", episodes: [], order: "random", avoid: 5, allowRepeat: true },
});

export default function SettingsPage({ go, bumpers }) {
  const smart = useSmart();
  const now = useNow(1000);
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState(null); // { kind: ok|warn|err, text, list? }
  const [progress, setProgress] = useState("");
  const [saved, setSaved] = useState("");
  const dirty = useRef(false);
  const fileRef = useRef(null);
  const lastAdded = useRef(null);

  useEffect(() => { loadCatalog().catch(() => {}); }, []);
  useEffect(() => { if (smart.config && !draft) setDraft(smart.config); }, [smart.config, draft]);

  // Guardado automatico (con un pequeño retraso para no guardar en cada tecla).
  useEffect(() => {
    if (!draft || !dirty.current) return undefined;
    const t = setTimeout(async () => {
      dirty.current = false;
      try {
        await saveConfig(draft);
        setSaved("Guardado ✔");
        setTimeout(() => setSaved(""), 1500);
      } catch (e) {
        setMsg({ kind: "err", text: `No se pudo guardar: ${e.message}` });
      }
    }, 600);
    return () => clearTimeout(t);
  }, [draft]);

  const edit = (fn) => { dirty.current = true; setDraft(fn); };
  const setPlan = (patch) => edit((d) => ({ ...d, plan: { ...d.plan, ...patch } }));
  const catalog = smart.catalog;

  const seriesList = useMemo(
    () => Object.entries(catalog?.series || {}).map(([key, s]) => ({ key, title: s.title, count: s.episodes.length })).sort((a, b) => a.title.localeCompare(b.title)),
    [catalog]
  );

  if (smart.status === "error") {
    return (
      <Shell go={go} now={now} draft={draft}>
        <div className="banner banner--err">
          {smart.error === "no-extension"
            ? "No se detecta la extensión «CN Catalog Builder». Instálala y recarga esta página."
            : `No se pudo cargar la configuración: ${smart.error}`}
        </div>
      </Shell>
    );
  }
  if (!draft) return <Shell go={go} now={now} draft={draft}><p className="muted">Cargando…</p></Shell>;

  const plan = draft.plan;
  const sch = smart.schedule;
  const toggleIn = (key, id) => setPlan({ [key]: plan[key].includes(id) ? plan[key].filter((x) => x !== id) : [...plan[key], id] });
  const setBlock = (id, patch) => setPlan({ blocks: plan.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });

  async function run(fn) {
    setMsg(null);
    try {
      const { schedule, notes } = await fn();
      dirty.current = false;
      const list = [...notes, ...(schedule.warnings || [])];
      setMsg({ kind: list.length ? "warn" : "ok", text: `Parrilla generada: ${schedule.stats.itemCount.toLocaleString("es")} elementos · relleno ${schedule.stats.fillerPct}% de la semana.`, list });
    } catch (e) {
      setMsg({ kind: "err", text: e.message === "no-extension" ? "La extensión no responde." : `Error: ${e.message}` });
    } finally {
      setProgress("");
    }
  }
  const generate = () => run(() => regenerate({ bumpers, config: draft, onProgress: setProgress }));

  async function onImport(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const s = await importSchedule(JSON.parse(await file.text()));
      setMsg({ kind: "ok", text: `Parrilla importada: ${s.stats?.itemCount ?? s.items.length} elementos.` });
    } catch (err) {
      setMsg({ kind: "err", text: `No se pudo importar: ${err.message}` });
    }
  }

  const busy = !!smart.busy || !!progress;

  return (
    <Shell go={go} now={now} draft={draft} tz={plan.timeZone} saved={saved}>
      {draft.debug && (
        <div className="banner banner--debug" role="alert">DEBUG ACTIVO — los episodios se reproducirán durante 15 segundos.</div>
      )}

      {/* ---------------- MODO ---------------- */}
      <section className="card">
        <h2>Modo de reproducción</h2>
        <div className="seg" role="radiogroup" aria-label="Modo de reproducción">
          {[["normal", "Normal", "Los episodios se reproducen al azar, sin horario fijo."], ["smart", "Horario Inteligente", "Un canal 24/7: cada contenido tiene su hora exacta y todos ven lo mismo."]].map(([v, label, help]) => (
            <label key={v} className={draft.mode === v ? "is-on" : ""}>
              <input type="radio" name="mode" checked={draft.mode === v} onChange={() => edit((d) => ({ ...d, mode: v }))} />
              <b>{label}</b>
              <small>{help}</small>
            </label>
          ))}
        </div>
      </section>

      {/* ---------------- PARRILLA ---------------- */}
      <section className="card">
        <h2>Parrilla</h2>
        {sch ? (
          <dl className="facts">
            <div><dt>Generada</dt><dd>{new Date(sch.generatedAt).toLocaleString("es")}</dd></div>
            <div><dt>Semilla</dt><dd>#{sch.seed}</dd></div>
            <div><dt>Elementos</dt><dd>{sch.stats.itemCount.toLocaleString("es")}</dd></div>
            <div><dt>Episodios</dt><dd>{sch.stats.byType.episode || 0}</dd></div>
            <div><dt>Relleno</dt><dd>{sch.stats.fillerPct}%</dd></div>
            <div><dt>Zona horaria</dt><dd>{sch.timeZone}</dd></div>
          </dl>
        ) : (
          <p className="muted">Todavía no hay una parrilla. Genera una para empezar.</p>
        )}
        <div className="actions">
          <button type="button" className={`btn ${sch ? "" : "btn--primary"}`} disabled={busy} onClick={generate}>Generar horario</button>
          <button type="button" className={`btn ${sch ? "btn--primary" : ""}`} disabled={busy || !sch} onClick={generate} title="Misma configuración y catálogo, otra distribución de episodios">Regenerar horario</button>
          <button type="button" className="btn" disabled={!sch} onClick={() => downloadJson(sch, "horario-cn.json")}>Exportar</button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Importar</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onImport} />
          <a className="btn" {...linkProps("/schedule", go)}>Ver horario ›</a>
        </div>
        {progress && <p className="progress" role="status">{progress}</p>}
        {msg && (
          <div className={`banner banner--${msg.kind}`} role="status">
            {msg.text}
            {msg.list?.length > 0 && <ul>{msg.list.map((t, i) => <li key={i}>{t}</li>)}</ul>}
          </div>
        )}
        <p className="muted small">
          La aleatoriedad ocurre al generar y la parrilla queda guardada: todos los reproductores que usen este horario ven lo mismo.
          Regenerar cambia los episodios elegidos, no los bloques. El catálogo no se modifica.
        </p>
      </section>

      {/* ---------------- DEBUG ---------------- */}
      <section className="card">
        <h2>Modo Debug del Horario Inteligente</h2>
        <label className="switch">
          <input type="checkbox" checked={draft.debug} onChange={(e) => edit((d) => ({ ...d, debug: e.target.checked }))} />
          <span>Cada contenido se reproduce solo 15 segundos</span>
        </label>
        <p className="muted small">Mantiene la misma lógica de programación para probar rápido los cambios de episodio, promos, bumpers y transiciones. Desactívalo para volver a la hora real.</p>
      </section>

      {/* ---------------- REGLAS ---------------- */}
      <section className="card">
        <h2>Reglas de programación</h2>
        <div className="grid3">
          <label className="field"><span>Zona horaria del canal</span>
            <input list="zones" value={plan.timeZone} onChange={(e) => setPlan({ timeZone: e.target.value })} />
            <datalist id="zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
          </label>
          <NumField label="Duración de bloques automáticos (min)" value={plan.defaultBlockMinutes} min={5} max={600} step={5} onChange={(v) => setPlan({ defaultBlockMinutes: v })} />
          <NumField label="Máx. episodios consecutivos de una serie" value={plan.maxConsecutiveEpisodes} min={0} max={20} onChange={(v) => setPlan({ maxConsecutiveEpisodes: v })} hint="0 = sin límite" />
          <NumField label="Bumper cada N episodios" value={plan.bumperEvery} min={0} max={10} onChange={(v) => setPlan({ bumperEvery: v })} hint="0 = nunca" />
          <NumField label="Promo cada N episodios" value={plan.promoEvery} min={0} max={10} onChange={(v) => setPlan({ promoEvery: v })} hint="0 = nunca" />
          <label className="field"><span>Evitar repeticiones (bloques automáticos)</span>
            <select value={plan.autoAvoid} onChange={(e) => setPlan({ autoAvoid: Number(e.target.value) })}>{AVOID.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        </div>
        <div className="checks">
          <label className="switch"><input type="checkbox" checked={plan.randomOrder} onChange={(e) => setPlan({ randomOrder: e.target.checked })} /><span>Orden aleatorio de series en bloques automáticos</span></label>
          <label className="switch"><input type="checkbox" checked={plan.allowRepeats} onChange={(e) => setPlan({ allowRepeats: e.target.checked })} /><span>Permitir repetir episodios (si no, ninguno se repite en la semana)</span></label>
          <label className="switch"><input type="checkbox" checked={plan.intros} onChange={(e) => setPlan({ intros: e.target.checked })} /><span>Intro al empezar cada bloque</span></label>
          <label className="switch"><input type="checkbox" checked={plan.outros} onChange={(e) => setPlan({ outros: e.target.checked })} /><span>Outro al terminar cada bloque</span></label>
        </div>
        <p className="muted small">Los bumpers, promos, intros, outros y clips salen de la carpeta elegida en Config: las subcarpetas <code>promos</code>, <code>intros</code>, <code>outros</code> y <code>clips</code> definen su tipo; el resto son bumpers.</p>
      </section>

      {/* ---------------- SERIES ---------------- */}
      <section className="card">
        <h2>Series</h2>
        {!seriesList.length ? <p className="muted">El catálogo está vacío. Léelo con la extensión primero.</p> : (
          <div className="grid2">
            <div>
              <h3>Preferidas <small className="muted">(salen más seguido)</small></h3>
              <div className="chips">{seriesList.map((s) => <Chip key={s.key} on={plan.preferredSeries.includes(s.key)} disabled={plan.excludedSeries.includes(s.key)} onClick={() => toggleIn("preferredSeries", s.key)}>{s.title}</Chip>)}</div>
            </div>
            <div>
              <h3>Excluidas <small className="muted">(nunca se usan)</small></h3>
              <div className="chips">{seriesList.map((s) => <Chip key={s.key} danger on={plan.excludedSeries.includes(s.key)} onClick={() => setPlan({ excludedSeries: plan.excludedSeries.includes(s.key) ? plan.excludedSeries.filter((x) => x !== s.key) : [...plan.excludedSeries, s.key], preferredSeries: plan.preferredSeries.filter((x) => x !== s.key) })}>{s.title}</Chip>)}</div>
            </div>
          </div>
        )}
      </section>

      {/* ---------------- BLOQUES ---------------- */}
      <section className="card">
        <h2>Bloques y horarios específicos</h2>
        <p className="muted small">La programación define <b>qué serie</b> está al aire a cada hora; el contenido (qué episodio) se resuelve al generar. Lo que no cubran tus bloques se completa con bloques automáticos.</p>
        {plan.blocks.length === 0 && <p className="muted">Sin bloques: toda la semana se programa automáticamente.</p>}
        <div className="blocks">
          {[...plan.blocks].sort((a, b) => a.start.localeCompare(b.start)).map((b) => (
            <BlockEditor
              key={b.id}
              block={b}
              open={lastAdded.current === b.id}
              catalog={catalog}
              seriesList={seriesList}
              onChange={(patch) => setBlock(b.id, patch)}
              onRemove={() => setPlan({ blocks: plan.blocks.filter((x) => x.id !== b.id) })}
            />
          ))}
        </div>
        <button type="button" className="btn" onClick={() => { const nb = newBlock(plan); lastAdded.current = nb.id; setPlan({ blocks: [...plan.blocks, nb] }); }}>+ Añadir bloque</button>
        {sch && dirty.current && <p className="muted small">Cambiaste la configuración: pulsa «Regenerar horario» para aplicarla.</p>}
      </section>
    </Shell>
  );
}

function Shell({ go, now, draft, tz, saved, children }) {
  const zone = tz || draft?.plan?.timeZone;
  return (
    <div className="page">
      <header className="page__head">
        <a className="back" {...linkProps("/", go)}>‹ Televisor</a>
        <h1>Ajustes · Programación</h1>
        <div className="page__clock">
          <span className="saved">{saved}</span>
          <span className="hud__time">{channelClock(now, zone)}</span>
        </div>
      </header>
      <main className="page__body">{children}</main>
    </div>
  );
}

function NumField({ label, value, onChange, min, max, step = 1, hint }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function Chip({ on, danger, disabled, onClick, children }) {
  return <button type="button" disabled={disabled} className={`chip${on ? " is-on" : ""}${danger ? " chip--danger" : ""}`} aria-pressed={!!on} onClick={onClick}>{children}</button>;
}

