// Funciones puras (sin DOM) para interpretar el texto de Max. Se prueban con node.
(function (root) {
  const RATING_RE = /^(?:TV-?(?:Y7-FV|Y7|Y|G|PG|14|MA)|\d{1,2}\+|ALL|TODOS?|G|PG|PG-13|R)$/i;
  const SEASON_RE = /^(?:temporada|season|temp\.?)\s*(\d+)\b/i;

  function norm(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseDuration(s) {
    const h = /(\d+)\s*h/i.exec(s);
    const m = /(\d+)\s*min/i.exec(s);
    if (!h && !m) return null;
    return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  }

  // Texto de una tarjeta de episodio:
  //   "1. El Cumpleaños De Steven / 10+ 12min 2016 / Steven celebra ..."
  function parseCardText(text) {
    const lines = String(text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => /^\d+\s*[.\-–]\s*\S/.test(l));
    if (ti < 0) return null;
    const m = /^(\d+)\s*[.\-–]\s*(.+)$/.exec(lines[ti]);
    const rest = lines.slice(ti + 1);

    let di = -1;
    let best = 0;
    rest.forEach((l, i) => {
      if (l.length > best) { best = l.length; di = i; }
    });
    const description = di >= 0 && best > 25 ? rest[di] : "";
    const metaText = rest.filter((_, i) => !(description && i === di)).join(" ");

    const year = /\b((?:19|20)\d{2})\b/.exec(metaText);
    const rating = metaText.split(/\s+/).find((t) => RATING_RE.test(t)) || null;

    return {
      number: Number(m[1]),
      title: m[2].trim(),
      description,
      durationMin: parseDuration(metaText),
      year: year ? Number(year[1]) : null,
      rating,
    };
  }

  // Devuelve el candidato si la eleccion es obvia, o null si hay que preguntar.
  function pickAuto(query, candidates) {
    if (!candidates.length) return null;
    const q = norm(query);
    const exact = candidates.filter((c) => norm(c.title) === q);
    if (exact.length === 1) return exact[0];
    if (candidates.length === 1) return candidates[0];
    return null;
  }

  const api = { RATING_RE, SEASON_RE, norm, parseDuration, parseCardText, pickAuto };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNParse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
