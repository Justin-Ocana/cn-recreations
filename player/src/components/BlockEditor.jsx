import { DAY_NAMES } from "../schedule/engine.js";
import EpisodePicker from "./EpisodePicker.jsx";

const AVOID = [
  [0, "Desactivado"],
  [1, "Último episodio"],
  [3, "Últimos 3 episodios"],
  [5, "Últimos 5 episodios"],
  [10, "Últimos 10 episodios"],
];
const DAY_SHORT = ["L", "M", "X", "J", "V", "S", "D"];

export function blockSummary(b, series) {
  const who = b.seriesKey ? series?.title || b.seriesKey : "Automático";
  const how = !b.seriesKey ? "variado" : b.selection.mode === "specific" ? `${b.selection.episodes.length} episodios específicos` : "aleatorio";
  const days = b.days.length === 7 ? "todos los días" : b.days.map((d) => DAY_SHORT[d]).join(" ");
  return `${b.start} · ${who} · ${b.durationMin} min · ${how} · ${days}`;
}

// Un bloque de programacion: "a esta hora, esta serie, con esta estrategia de seleccion". Independiente de los demas.
export default function BlockEditor({ block: b, catalog, seriesList, onChange, onRemove, open }) {
  const series = b.seriesKey ? catalog?.series?.[b.seriesKey] : null;
  const seriesForPicker = series ? { episodes: series.episodes.filter((e) => !(series.disabledSeasons || []).includes(e.season)) } : null;
  const sel = b.selection;
  const setSel = (patch) => onChange({ selection: { ...sel, ...patch } });
  const specific = sel.mode === "specific" && !!b.seriesKey;

  return (
    <details className="block" open={open}>
      <summary>
        <span className="block__name">{b.name || (series?.title ?? "Bloque automático")}</span>
        <span className="block__sum">{blockSummary(b, series && { title: series.title })}</span>
      </summary>

      <div className="block__body">
        <div className="grid2">
          <label className="field">
            <span>Nombre del bloque</span>
            <input type="text" value={b.name} placeholder="Ej.: Bloque Clarence" onChange={(e) => onChange({ name: e.target.value })} />
          </label>
          <label className="field">
            <span>Serie</span>
            <select value={b.seriesKey || ""} onChange={(e) => onChange({ seriesKey: e.target.value, selection: { ...sel, mode: e.target.value ? sel.mode : "random", episodes: [] } })}>
              <option value="">Automática (todo el catálogo)</option>
              {seriesList.map((s) => <option key={s.key} value={s.key}>{s.title} ({s.count})</option>)}
            </select>
          </label>
          <label className="field">
            <span>Hora de inicio</span>
            <input type="time" value={b.start} onChange={(e) => e.target.value && onChange({ start: e.target.value })} />
          </label>
          <label className="field">
            <span>Duración del bloque (min)</span>
            <input type="number" min="5" max="600" step="5" value={b.durationMin} onChange={(e) => onChange({ durationMin: Math.max(5, Number(e.target.value) || 60) })} />
          </label>
        </div>

        <div className="field">
          <span>Días</span>
          <div className="days">
            {DAY_NAMES.map((n, d) => (
              <button
                key={d}
                type="button"
                className={b.days.includes(d) ? "is-on" : ""}
                title={n}
                aria-pressed={b.days.includes(d)}
                onClick={() => {
                  const days = b.days.includes(d) ? b.days.filter((x) => x !== d) : [...b.days, d].sort();
                  if (days.length) onChange({ days });
                }}
              >
                {DAY_SHORT[d]}
              </button>
            ))}
          </div>
        </div>

        <fieldset className="field radios" disabled={!b.seriesKey}>
          <legend>Selección de episodios</legend>
          <label><input type="radio" checked={sel.mode === "specific"} onChange={() => setSel({ mode: "specific" })} /> Episodios específicos</label>
          <label><input type="radio" checked={sel.mode !== "specific"} onChange={() => setSel({ mode: "random" })} /> Episodios aleatorios</label>
          {!b.seriesKey && <small className="muted">Un bloque automático elige solo el contenido; para elegir episodios selecciona una serie.</small>}
        </fieldset>

        {specific ? (
          <>
            <div className="field radios">
              <legend>Orden</legend>
              <label><input type="radio" checked={sel.order === "fixed"} onChange={() => setSel({ order: "fixed" })} /> Orden fijo</label>
              <label><input type="radio" checked={sel.order !== "fixed"} onChange={() => setSel({ order: "random" })} /> Orden aleatorio</label>
            </div>
            <div className="field">
              <span>Episodios ({sel.episodes.length} seleccionados)</span>
              <EpisodePicker series={seriesForPicker} selected={sel.episodes} onChange={(episodes) => setSel({ episodes })} />
              {!sel.episodes.length && <small className="warn">Sin episodios elegidos, este bloque se completa con otros contenidos.</small>}
            </div>
          </>
        ) : (
          <div className="grid2">
            <label className="field">
              <span>Evitar repeticiones</span>
              <select value={sel.avoid} onChange={(e) => setSel({ avoid: Number(e.target.value) })}>
                {AVOID.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Permitir repetir después de agotar todos</span>
              <select value={sel.allowRepeat ? "1" : "0"} onChange={(e) => setSel({ allowRepeat: e.target.value === "1" })}>
                <option value="1">Sí</option>
                <option value="0">No</option>
              </select>
            </label>
          </div>
        )}

        <div className="block__actions">
          <button type="button" className="btn btn--danger" onClick={onRemove}>Eliminar bloque</button>
        </div>
      </div>
    </details>
  );
}
