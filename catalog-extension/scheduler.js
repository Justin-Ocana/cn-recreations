// Algoritmo del canal: decide que episodio sigue. Funciones puras (se prueban con node).
(function (root) {
  const clean = (s) => (s || "").replace(/[⁦-⁩‎‏]/g, "").trim();

  function flatten(catalog) {
    const out = [];
    for (const [seriesKey, s] of Object.entries(catalog?.series || {})) {
      // Temporadas desactivadas en el popup: siguen guardadas pero el canal no las toma en cuenta.
      const off = new Set((s.disabledSeasons || []).map(Number));
      for (const e of s.episodes || []) {
        if (off.has(e.season)) continue;
        out.push({ ...e, title: clean(e.title), seriesKey, seriesTitle: clean(s.title) });
      }
    }
    return out;
  }

  // Aleatorio: primero una serie al azar (para que una serie con 200 episodios no domine
  // el canal) y luego un episodio al azar. Evita repetir los ultimos episodios y no pone
  // dos veces seguidas la misma serie (si hay mas de una).
  function pickNext(catalog, { history = [], lastSeriesKey = null, rand = Math.random } = {}) {
    const all = flatten(catalog);
    if (!all.length) return null;

    const bySeries = new Map();
    for (const e of all) {
      if (!bySeries.has(e.seriesKey)) bySeries.set(e.seriesKey, []);
      bySeries.get(e.seriesKey).push(e);
    }
    let keys = [...bySeries.keys()];
    if (keys.length > 1 && lastSeriesKey) keys = keys.filter((k) => k !== lastSeriesKey);
    const eps = bySeries.get(keys[Math.floor(rand() * keys.length)]);

    // Dentro de la serie, evita lo visto recientemente (si ya se vio todo, vale cualquiera).
    const n = Math.min(30, Math.floor(all.length / 2));
    const recent = new Set(n > 0 ? history.slice(-n) : []);
    const fresh = eps.filter((e) => !recent.has(e.url));
    const pool = fresh.length ? fresh : eps;
    return pool[Math.floor(rand() * pool.length)];
  }

  const api = { flatten, pickNext };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNSched = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
