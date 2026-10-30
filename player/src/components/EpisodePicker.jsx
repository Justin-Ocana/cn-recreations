import { useMemo } from "react";

// Elegir episodios concretos de una serie ("Episodios específicos"), agrupados por temporada.
// selected = urls elegidas. Al cambiar se devuelven en el orden del catalogo (temporada, episodio): asi el
// "orden fijo" es siempre el natural y no depende del orden en que se fueron marcando.
export default function EpisodePicker({ series, selected, onChange }) {
  const seasons = useMemo(() => {
    const map = new Map();
    for (const e of series?.episodes || []) {
      if (!map.has(e.season)) map.set(e.season, []);
      map.get(e.season).push(e);
    }
    return [...map].sort((a, b) => a[0] - b[0]).map(([season, eps]) => ({ season, eps: eps.sort((a, b) => a.number - b.number) }));
  }, [series]);

  const order = useMemo(() => new Map(seasons.flatMap((s) => s.eps).map((e, i) => [e.url, i])), [seasons]);
  const set = new Set(selected);
  const emit = (ids) => onChange([...new Set(ids)].filter((id) => order.has(id)).sort((a, b) => order.get(a) - order.get(b)));

  if (!series) return <p className="muted">Elige primero una serie para seleccionar sus episodios.</p>;

  return (
    <div className="epick">
      {seasons.map(({ season, eps }) => {
        const on = eps.filter((e) => set.has(e.url)).length;
        return (
          <details key={season} open={on > 0 && seasons.length > 1 ? false : seasons.length <= 2} className="epick__season">
            <summary>
              <span>Temporada {season}</span>
              <small>{on}/{eps.length}</small>
            </summary>
            <div className="epick__bulk">
              <button type="button" onClick={() => emit([...selected, ...eps.map((e) => e.url)])}>Todos</button>
              <button type="button" onClick={() => emit(selected.filter((id) => !eps.some((e) => e.url === id)))}>Ninguno</button>
            </div>
            <div className="epick__grid">
              {eps.map((e) => (
                <label key={e.url} className={set.has(e.url) ? "is-on" : ""} title={e.title}>
                  <input
                    type="checkbox"
                    checked={set.has(e.url)}
                    onChange={(ev) => emit(ev.target.checked ? [...selected, e.url] : selected.filter((id) => id !== e.url))}
                  />
                  <span>E{e.number}</span>
                </label>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
