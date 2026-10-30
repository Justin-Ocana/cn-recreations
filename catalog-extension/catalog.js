// Importar catalogos JSON: valida, limpia y fusiona con el catalogo existente.
// Funciones puras (sin chrome.*), se prueban con node.
(function (root) {
  const INVISIBLE = /[⁦-⁩‎‏]/g; // marcas de direccion que Max mete en los titulos
  const clean = (s) => String(s ?? "").replace(INVISIBLE, "").trim();
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  // El canal navega a estas URLs, asi que solo se aceptan paginas de reproduccion de Max.
  function maxUrl(raw, pathRe) {
    try {
      const u = new URL(raw);
      const ok = u.protocol === "https:" && /(^|\.)(max|hbomax)\.com$/i.test(u.hostname) && pathRe.test(u.pathname);
      return ok ? u.origin + u.pathname : null;
    } catch (_) {
      return null;
    }
  }

  function cleanEpisode(e) {
    if (!isObj(e)) return null;
    const url = maxUrl(e.url, /\/video\/watch\//);
    if (!url) return null;
    return {
      season: num(e.season) ?? 1,
      number: num(e.number) ?? 0,
      title: clean(e.title).slice(0, 200),
      description: clean(e.description).slice(0, 1000),
      durationMin: num(e.durationMin),
      ...(num(e.durationSec) > 0 ? { durationSec: num(e.durationSec) } : {}), // duracion real medida
      year: num(e.year),
      rating: e.rating ? clean(e.rating).slice(0, 12) : null,
      url,
    };
  }

  const bySeasonNumber = (a, b) => a.season - b.season || a.number - b.number;

  // existing: catalogo actual (o undefined). incoming: JSON ya parseado.
  // Devuelve { ok, error?, catalog, stats }.
  function mergeImport(existing, incoming) {
    if (!isObj(incoming) || !isObj(incoming.series)) {
      return { ok: false, error: 'Formato no reconocido: el JSON debe tener un objeto "series".' };
    }

    const catalog = JSON.parse(JSON.stringify(existing && isObj(existing.series) ? existing : { version: 1, series: {} }));
    const stats = { seriesNew: 0, seriesUpdated: 0, episodesNew: 0, episodesUpdated: 0, skippedEpisodes: 0, skippedSeries: 0 };

    for (const [rawKey, s] of Object.entries(incoming.series)) {
      const key = clean(rawKey).slice(0, 200);
      // "__proto__" como clave cambiaria el prototipo del objeto en vez de crear una serie.
      if (!key || key === "__proto__" || !isObj(s) || !Array.isArray(s.episodes)) { stats.skippedSeries++; continue; }

      const valid = [];
      for (const e of s.episodes) {
        const ce = cleanEpisode(e);
        if (ce) valid.push(ce); else stats.skippedEpisodes++;
      }
      if (!valid.length) { stats.skippedSeries++; continue; }

      const prev = Object.hasOwn(catalog.series, key) ? catalog.series[key] : undefined;
      const byUrl = new Map((prev?.episodes || []).map((e) => [e.url, e]));
      for (const e of valid) {
        if (byUrl.has(e.url)) stats.episodesUpdated++; else stats.episodesNew++;
        byUrl.set(e.url, e);
      }
      const episodes = [...byUrl.values()].sort(bySeasonNumber);

      const failed = new Set([...(prev?.failedSeasons || []), ...(Array.isArray(s.failedSeasons) ? s.failedSeasons : [])]);
      const failedSeasons = [...failed]
        .map(Number)
        .filter((n) => Number.isFinite(n) && !episodes.some((e) => e.season === n))
        .sort((a, b) => a - b);

      // Si el archivo trae su propio estado de temporadas desactivadas, manda; si no, se conserva el actual.
      const disabledSeasons = Array.isArray(s.disabledSeasons)
        ? [...new Set(s.disabledSeasons.map(num).filter((n) => n !== null))].sort((a, b) => a - b)
        : prev?.disabledSeasons || [];

      catalog.series[key] = {
        title: clean(s.title).slice(0, 200) || prev?.title || key,
        query: clean(s.query).slice(0, 200) || prev?.query || "",
        url: maxUrl(s.url, /\/show\//) || prev?.url || "",
        scrapedAt: typeof s.scrapedAt === "string" ? s.scrapedAt : new Date().toISOString(),
        failedSeasons,
        disabledSeasons,
        episodes,
      };
      if (prev) stats.seriesUpdated++; else stats.seriesNew++;
    }

    if (!stats.seriesNew && !stats.seriesUpdated) {
      return { ok: false, error: "El archivo no tiene ninguna serie con episodios válidos de Max.", stats };
    }
    return { ok: true, catalog, stats };
  }

  // ----- Temporadas activas / desactivadas -----
  // Una temporada desactivada sigue guardada (se puede reactivar) pero el canal la ignora.

  // [{ season, count, enabled }] ordenado por temporada.
  function seasonsOf(s) {
    const off = new Set((s?.disabledSeasons || []).map(Number));
    const counts = new Map();
    for (const e of s?.episodes || []) counts.set(e.season, (counts.get(e.season) || 0) + 1);
    return [...counts]
      .sort((a, b) => a[0] - b[0])
      .map(([season, count]) => ({ season, count, enabled: !off.has(season) }));
  }

  const activeCount = (s) => seasonsOf(s).reduce((n, x) => n + (x.enabled ? x.count : 0), 0);

  const ownSeries = (catalog, key) =>
    catalog?.series && Object.hasOwn(catalog.series, key) ? catalog.series[key] : null;

  function setSeasonEnabled(catalog, key, season, enabled) {
    const s = ownSeries(catalog, key);
    if (!s) return catalog;
    const off = new Set((s.disabledSeasons || []).map(Number));
    if (enabled) off.delete(Number(season)); else off.add(Number(season));
    s.disabledSeasons = [...off].sort((a, b) => a - b);
    return catalog;
  }

  function setAllSeasons(catalog, key, enabled) {
    const s = ownSeries(catalog, key);
    if (!s) return catalog;
    s.disabledSeasons = enabled ? [] : seasonsOf(s).map((x) => x.season);
    return catalog;
  }

  const api = { clean, mergeImport, cleanEpisode, seasonsOf, activeCount, setSeasonEnabled, setAllSeasons };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
