// Horario Inteligente: motor puro (sin DOM ni chrome.*). Se usa igual desde node (pruebas), la extension
// (service worker y paginas de Max) y la pagina del reproductor (import por efecto secundario -> globalThis.CNSmart).
//
//   generateSchedule({ catalog, config, library, seed })  -> Schedule       (Smart Schedule Generator)
//   resolveSchedule(schedule, nowMs, { debug })           -> { current, next, ... }   (Schedule Resolver)
//   createClock({ fetchServerTime, ... })                 -> reloj del canal sincronizado con el servidor
//
// PRINCIPIOS
//  * TODO en milisegundos ENTEROS: las duraciones se suman exactamente y la linea de tiempo cuadra al ms.
//  * La parrilla es SEMANAL (lunes 00:00 -> domingo 24:00) y se repite. Cada item tiene start/end exactos.
//  * Dos capas: PLAN (bloques: "14:00 -> Clarence, aleatorio") y CONTENIDO (episodios concretos elegidos al generar).
//  * La aleatoriedad ocurre UNA vez, al generar (semilla guardada): todos los reproductores ven lo mismo.
//  * El resolver responde "¿que debe estar al aire AHORA y en que posicion exacta?" a partir de la hora real.
(function (root) {
  "use strict";

  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const DEFAULT_EPISODE_MS = 11 * MIN; // si un episodio no trae duracion
  const DEBUG_SLOT_MS = 15 * SEC;
  const ATTEMPTS = 16;                 // intentos aleatorios por bloque para minimizar el relleno
  const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  const CLIP_KINDS = ["bumper", "promo", "intro", "outro", "clip"];

  // ---------------------------------------------------------------- utilidades
  const clean = (s) => String(s ?? "").replace(/[⁦-⁩‎‏]/g, "").trim();
  const isInt = (n) => Number.isInteger(n);

  function mulberry32(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.u32 = () => Math.floor(next() * 4294967296) >>> 0;
    return next;
  }
  const pickIndex = (rng, n) => Math.min(n - 1, Math.floor(rng() * n));
  const shuffle = (rng, arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = pickIndex(rng, i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ---------------------------------------------------------------- tiempo
  const fmtCache = new Map();
  const WEEKDAY = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  function tzFormatter(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      fmtCache.set(tz, f);
    }
    return f;
  }

  // Milisegundos transcurridos desde el lunes 00:00 (hora de pared de la zona `tz`) hasta `epochMs`.
  function weekMsOf(epochMs, tz) {
    const parts = tzFormatter(tz).formatToParts(new Date(epochMs));
    const get = (t) => parts.find((p) => p.type === t).value;
    const h = Number(get("hour")) % 24;
    const ms = ((epochMs % 1000) + 1000) % 1000;
    return WEEKDAY[get("weekday")] * DAY + h * HOUR + Number(get("minute")) * MIN + Number(get("second")) * SEC + ms;
  }

  const pad = (n) => String(n).padStart(2, "0");
  // "HH:MM:SS" de un instante dentro del dia (acepta ms de semana o de dia).
  function fmtClock(ms) {
    const d = ((Math.floor(ms / SEC) % 86400) + 86400) % 86400;
    return `${pad(Math.floor(d / 3600))}:${pad(Math.floor((d % 3600) / 60))}:${pad(d % 60)}`;
  }
  const fmtHM = (ms) => fmtClock(ms).slice(0, 5);
  // Duracion legible: "11:32" o "1:02:03".
  function fmtDuration(ms) {
    const s = Math.round(ms / SEC);
    const h = Math.floor(s / 3600);
    return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }
  function parseHM(text) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text).trim());
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3] || 0);
    if (h > 23 || mi > 59 || s > 59) return null;
    return h * HOUR + mi * MIN + s * SEC;
  }
  const dayOf = (weekMs) => Math.floor(weekMs / DAY);

  // ---------------------------------------------------------------- configuracion
  function defaultConfig() {
    return {
      timeZone: "UTC",
      defaultBlockMinutes: 60,   // duracion de los bloques automaticos (los huecos entre bloques del usuario)
      bumperEvery: 1,            // un bumper cada N episodios (0 = nunca)
      promoEvery: 2,             // una promo cada N episodios (0 = nunca)
      intros: false,             // un intro al empezar cada bloque
      outros: false,             // un outro al terminar cada bloque
      maxConsecutiveEpisodes: 3, // en bloques automaticos: maximo de episodios seguidos de una misma serie
      randomOrder: true,         // false = los bloques automaticos rotan las series en orden
      allowRepeats: true,        // false = un episodio no se repite en toda la semana
      autoAvoid: 5,              // anti-repeticion en bloques automaticos (ultimos N de la serie)
      preferredSeries: [],
      excludedSeries: [],
      blocks: [],                // bloques del usuario (ver normalizeBlock)
      debug: false,
    };
  }

  function normalizeBlock(b, i, cfg) {
    const startMs = typeof b.startMs === "number" ? b.startMs : parseHM(b.start ?? "00:00") ?? 0;
    const days = (Array.isArray(b.days) && b.days.length ? b.days : [0, 1, 2, 3, 4, 5, 6])
      .map(Number).filter((d) => d >= 0 && d <= 6).sort((a, c) => a - c);
    const sel = b.selection || {};
    return {
      id: String(b.id ?? `b${i + 1}`),
      name: clean(b.name) || "",
      seriesKey: b.seriesKey || null, // null = automatico
      startMs,
      start: fmtHM(startMs),
      days: [...new Set(days)],
      durationMin: Number(b.durationMin) > 0 ? Number(b.durationMin) : cfg.defaultBlockMinutes,
      selection: {
        mode: sel.mode === "specific" ? "specific" : "random",
        episodes: Array.isArray(sel.episodes) ? sel.episodes.map(String) : [],
        order: sel.order === "fixed" ? "fixed" : "random",
        avoid: Number.isFinite(Number(sel.avoid)) ? Math.max(0, Number(sel.avoid)) : 5,
        allowRepeat: sel.allowRepeat !== false, // tras agotar todos, permite repetir
      },
    };
  }

  function normalizeConfig(input) {
    const cfg = { ...defaultConfig(), ...(input || {}) };
    cfg.defaultBlockMinutes = Math.max(5, Number(cfg.defaultBlockMinutes) || 60);
    for (const k of ["bumperEvery", "promoEvery", "maxConsecutiveEpisodes", "autoAvoid"]) cfg[k] = Math.max(0, Math.floor(Number(cfg[k]) || 0));
    // Datos de usuario: cualquier cosa que no sea lo esperado se trata como vacio (nunca lanza).
    const list = (v) => (Array.isArray(v) ? v : []);
    cfg.preferredSeries = [...new Set(list(cfg.preferredSeries).map(String))];
    cfg.excludedSeries = [...new Set(list(cfg.excludedSeries).map(String))];
    cfg.blocks = list(cfg.blocks).filter((b) => b && typeof b === "object").map((b, i) => normalizeBlock(b, i, cfg));
    return cfg;
  }

  // ---------------------------------------------------------------- catalogo y biblioteca
  function episodeMs(e) {
    if (e.durationSec > 0) return Math.round(e.durationSec * SEC);
    if (e.durationMin > 0) return Math.round(e.durationMin * MIN);
    return DEFAULT_EPISODE_MS;
  }

  // catalog = { series: { key: { title, disabledSeasons, episodes: [{url, season, number, title, durationMin, durationSec}] } } }
  function buildSeriesIndex(catalog, cfg) {
    const excluded = new Set(cfg.excludedSeries);
    const index = new Map();
    for (const [key, s] of Object.entries(catalog?.series || {})) {
      if (excluded.has(key)) continue;
      const off = new Set((s.disabledSeasons || []).map(Number));
      const episodes = (s.episodes || [])
        .filter((e) => e.url && !off.has(e.season))
        .map((e) => ({
          id: e.url, url: e.url, seriesKey: key, series: clean(s.title) || key,
          season: e.season, number: e.number, title: clean(e.title),
          durationMs: episodeMs(e), estimated: !(e.durationSec > 0),
        }))
        .filter((e) => e.durationMs > 0);
      if (episodes.length) index.set(key, { key, title: clean(s.title) || key, episodes });
    }
    return index;
  }

  // library = { bumper: [{id,name,durationMs|durationSec}], promo: [...], intro: [...], outro: [...], clip: [...] }
  function normalizeLibrary(lib) {
    const out = {};
    for (const kind of CLIP_KINDS) {
      out[kind] = (lib?.[kind] || [])
        .map((c) => ({ id: String(c.id), name: clean(c.name) || String(c.id), kind, durationMs: c.durationMs > 0 ? Math.round(c.durationMs) : Math.round((c.durationSec || 0) * SEC) }))
        .filter((c) => c.durationMs > 0);
    }
    return out;
  }

  // ---------------------------------------------------------------- estado de generacion
  function newState() {
    return { history: new Map(), used: new Set(), cursors: new Map(), lastSeries: null, consecutive: 0, rr: 0, lastClip: new Map() };
  }
  function cloneState(st) {
    return {
      history: new Map([...st.history].map(([k, v]) => [k, v.slice()])),
      used: new Set(st.used),
      cursors: new Map(st.cursors),
      lastSeries: st.lastSeries,
      consecutive: st.consecutive,
      rr: st.rr,
      lastClip: new Map(st.lastClip),
    };
  }

  // ---------------------------------------------------------------- seleccion de episodios
  // Devuelve { ep, cursorKey? } o null. `maxMs`: solo se consideran episodios que caben en el tiempo restante.
  function pickFromSeries(rng, series, sel, st, maxMs, cursorKey) {
    let pool = series.episodes;

    if (sel.mode === "specific" && sel.episodes.length) {
      const byId = new Map(pool.map((e) => [e.id, e]));
      const list = sel.episodes.map((id) => byId.get(id)).filter(Boolean);
      if (!list.length) return null;
      if (sel.order === "fixed") {
        // Orden fijo: recorre la lista en circulo, recordando por donde iba entre apariciones del bloque.
        const at = (st.cursors.get(cursorKey) || 0) % list.length;
        const ep = list[at];
        return ep.durationMs <= maxMs ? { ep, cursorKey, nextCursor: at + 1 } : null;
      }
      pool = list;
    }

    const hist = st.history.get(series.key) || [];
    const blocked = new Set(sel.avoid > 0 ? hist.slice(-sel.avoid) : []);
    const fits = (e) => e.durationMs <= maxMs;
    const free = pool.filter((e) => !blocked.has(e.id) && (sel.allowRepeat || !st.used.has(e.id)));

    if (free.length) {
      // Hay episodios permitidos: solo se eligen entre los que caben. Si ninguno cabe, el bloque deja de meter
      // episodios (NUNCA se recurre a uno bloqueado por el historial solo porque cabe).
      const avail = free.filter(fits);
      return avail.length ? { ep: avail[pickIndex(rng, avail.length)] } : null;
    }
    // TODOS estan en el historial bloqueado: se reutiliza el contenido MAS ANTIGUO (si se permite repetir).
    if (!sel.allowRepeat) return null;
    const cand = pool.filter(fits);
    if (!cand.length) return null;
    const age = (e) => hist.lastIndexOf(e.id); // -1 = nunca usado
    const oldest = Math.min(...cand.map(age));
    const ties = cand.filter((e) => age(e) === oldest);
    return { ep: ties[pickIndex(rng, ties.length)] };
  }

  function weightedSeries(rng, list, cfg) {
    const pref = new Set(cfg.preferredSeries);
    const weights = list.map((s) => (pref.has(s.key) ? 3 : 1));
    let r = rng() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r < 0) return list[i];
    }
    return list[list.length - 1];
  }

  // Elige la serie de un episodio en un bloque AUTOMATICO respetando el maximo de episodios consecutivos.
  function pickSeriesAuto(rng, all, st, cfg, exclude) {
    let list = all.filter((s) => !exclude.has(s.key));
    if (!list.length) return null;
    if (cfg.maxConsecutiveEpisodes > 0 && st.consecutive >= cfg.maxConsecutiveEpisodes && list.length > 1) {
      const other = list.filter((s) => s.key !== st.lastSeries);
      if (other.length) list = other;
    }
    if (!cfg.randomOrder) {
      const sorted = list.slice().sort((a, b) => a.key.localeCompare(b.key));
      return sorted[st.rr % sorted.length];
    }
    return weightedSeries(rng, list, cfg);
  }

  function pickEpisode(rng, seg, st, ctx, maxMs) {
    const { index, cfg } = ctx;
    const block = seg.block;
    if (block?.seriesKey && index.has(block.seriesKey)) {
      const series = index.get(block.seriesKey);
      const p = pickFromSeries(rng, series, block.selection, st, maxMs, `${block.id}`);
      if (p) return p;
      // Si la serie aun tiene contenido y solo "no cabe" en lo que resta del bloque, el bloque termina de episodios
      // (el resto se rellena con clips): NUNCA se mezclan otras series en un bloque de una serie concreta.
      if (pickFromSeries(mulberry32(1), series, block.selection, st, Infinity, `${block.id}`)) return null;
      // La serie del bloque esta realmente agotada (p. ej. sin repeticion): para que la linea de tiempo siga viva se completa con otra.
    }
    const autoSel = { mode: "random", episodes: [], order: "random", avoid: cfg.autoAvoid, allowRepeat: cfg.allowRepeats };
    const all = [...index.values()];
    const tried = new Set();
    while (tried.size < all.length) {
      const s = pickSeriesAuto(rng, all, st, cfg, tried);
      if (!s) return null;
      const p = pickFromSeries(rng, s, autoSel, st, maxMs, null);
      if (p) return { ...p, fallback: !!block?.seriesKey };
      tried.add(s.key);
    }
    return null;
  }

  function commitPick(st, pick, cfg) {
    const { ep } = pick;
    const h = st.history.get(ep.seriesKey) || [];
    h.push(ep.id);
    st.history.set(ep.seriesKey, h);
    st.used.add(ep.id);
    if (pick.cursorKey != null) st.cursors.set(pick.cursorKey, pick.nextCursor);
    st.consecutive = st.lastSeries === ep.seriesKey ? st.consecutive + 1 : 1;
    st.lastSeries = ep.seriesKey;
    st.rr += 1;
  }

  // ---------------------------------------------------------------- clips (bumpers, promos, intros...)
  function pickClip(rng, kind, maxMs, st, lib) {
    const cand = lib[kind].filter((c) => c.durationMs <= maxMs);
    if (!cand.length) return null;
    const last = st.lastClip.get(kind);
    const fresh = cand.length > 1 ? cand.filter((c) => c.id !== last) : cand;
    const c = fresh[pickIndex(rng, fresh.length)];
    st.lastClip.set(kind, c.id);
    return c;
  }

  // Mejor combinacion de hasta 3 clips cuya suma se acerque mas (sin pasarse) a `left`.
  function bestCombo(rng, left, pool) {
    const cand = shuffle(rng, pool.filter((c) => c.durationMs <= left)).slice(0, 24);
    let best = { rest: left, clips: [] };
    const dfs = (from, rest, chosen) => {
      if (rest < best.rest || (rest === best.rest && chosen.length < best.clips.length)) best = { rest, clips: chosen.slice() };
      if (rest === 0 || chosen.length >= 3) return;
      for (let i = from; i < cand.length; i++) {
        if (cand[i].durationMs <= rest) {
          chosen.push(cand[i]);
          dfs(i, rest - cand[i].durationMs, chosen);
          chosen.pop();
        }
      }
    };
    dfs(0, left, []);
    return best;
  }

  // Rellena `left` ms con clips y, si sobra un resto que no encaja en ninguno, un item "filler" exacto.
  function fillTail(rng, left, st, lib) {
    const items = [];
    if (left <= 0) return items;
    const pool = [...lib.bumper, ...lib.promo, ...lib.clip];
    let rest = left;
    if (pool.length) {
      const seen = new Set();
      const uniq = pool.filter((c) => (seen.has(c.id) ? false : seen.add(c.id)));
      // Puede hacer falta mas de una pasada (cada una encaja hasta 3 clips).
      for (let pass = 0; pass < 6 && rest > 0; pass++) {
        const { rest: r, clips } = bestCombo(rng, rest, uniq);
        if (!clips.length) break;
        for (const c of shuffle(rng, clips)) items.push(clipItem(c));
        rest = r;
      }
    }
    if (rest > 0) items.push({ type: "filler", contentId: "filler", durationMs: rest, meta: { name: "Relleno" } });
    return items;
  }

  const clipItem = (c, type) => ({ type: type || c.kind, contentId: c.id, durationMs: c.durationMs, meta: { clipId: c.id, name: c.name, kind: c.kind } });
  const episodeItem = (ep, fallback) => ({
    type: "episode", contentId: ep.id, durationMs: ep.durationMs,
    meta: { seriesKey: ep.seriesKey, series: ep.series, season: ep.season, number: ep.number, title: ep.title, url: ep.url, estimated: ep.estimated, ...(fallback ? { fallback: true } : {}) },
  });

  // ---------------------------------------------------------------- un bloque
  function buildSequence(seed, seg, total, st, ctx) {
    const { cfg, lib } = ctx;
    const rng = mulberry32(seed);
    const items = [];
    let elapsed = 0;
    let episodes = 0;

    if (cfg.intros && lib.intro.length) {
      const c = pickClip(rng, "intro", total - elapsed, st, lib);
      if (c) { items.push(clipItem(c)); elapsed += c.durationMs; }
    }

    // El outro (si hay) se reserva desde el principio para que siempre quepa, y va al final del bloque.
    const outro = cfg.outros && lib.outro.length ? pickClip(rng, "outro", total - elapsed, st, lib) : null;
    const reserve = outro ? outro.durationMs : 0;

    for (;;) {
      const pick = pickEpisode(rng, seg, st, ctx, total - elapsed - reserve);
      if (!pick) break;
      commitPick(st, pick, cfg);
      items.push(episodeItem(pick.ep, pick.fallback));
      elapsed += pick.ep.durationMs;
      episodes++;

      const breaks = [];
      if (cfg.promoEvery > 0 && episodes % cfg.promoEvery === 0) breaks.push("promo");
      if (cfg.bumperEvery > 0 && episodes % cfg.bumperEvery === 0) breaks.push("bumper");
      for (const kind of breaks) {
        const c = pickClip(rng, kind, total - elapsed - reserve, st, lib);
        if (c) { items.push(clipItem(c)); elapsed += c.durationMs; }
      }
    }

    const tail = fillTail(rng, total - elapsed - reserve, st, lib);
    items.push(...tail);
    if (outro) items.push(clipItem(outro));
    const fillerMs = tail.filter((t) => t.type === "filler").reduce((a, t) => a + t.durationMs, 0);
    return { items, fillerMs, episodes };
  }

  // Varios intentos aleatorios; se conserva el que deja menos relleno (y mas episodios). Cada intento se
  // simula sobre una copia del estado; el ganador se repite (misma semilla) sobre el estado real.
  function fillBlock(seg, ctx) {
    const total = seg.end - seg.start;
    let best = null;
    for (let a = 0; a < ATTEMPTS; a++) {
      const seed = ctx.rng.u32();
      const r = buildSequence(seed, seg, total, cloneState(ctx.state), ctx);
      if (!best || r.fillerMs < best.fillerMs || (r.fillerMs === best.fillerMs && r.episodes > best.episodes)) best = { seed, ...r };
      if (best.fillerMs === 0) break;
    }
    return buildSequence(best.seed, seg, total, ctx.state, ctx);
  }

  // ---------------------------------------------------------------- disposicion semanal
  function pushGap(segs, from, to, cfg) {
    const chunk = cfg.defaultBlockMinutes * MIN;
    for (let s = from; s < to; s += chunk) segs.push({ start: s, end: Math.min(s + chunk, to), block: null });
  }

  function layoutWeek(cfg, warnings) {
    const occ = [];
    for (const b of cfg.blocks) {
      for (const dow of b.days) {
        const start = dow * DAY + b.startMs;
        if (start >= WEEK) continue;
        occ.push({ start, end: Math.min(start + b.durationMin * MIN, WEEK), block: b, dow });
      }
    }
    occ.sort((a, b) => a.start - b.start);
    const segs = [];
    let cursor = 0;
    for (const o of occ) {
      if (o.start < cursor) {
        warnings.push(`El bloque "${o.block.name || o.block.id}" (${DAY_NAMES[o.dow]} ${fmtHM(o.block.startMs)}) se solapa con otro y se omitió.`);
        continue;
      }
      if (o.start > cursor) pushGap(segs, cursor, o.start, cfg);
      segs.push({ start: o.start, end: o.end, block: o.block });
      cursor = o.end;
    }
    if (cursor < WEEK) pushGap(segs, cursor, WEEK, cfg);
    return segs;
  }

  // ---------------------------------------------------------------- generador
  function generateSchedule(input) {
    const cfg = normalizeConfig(input.config);
    const seed = (input.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
    const now = input.now ?? Date.now();
    const warnings = [];
    const index = buildSeriesIndex(input.catalog, cfg);
    const lib = normalizeLibrary(input.library);
    const segs = layoutWeek(cfg, warnings);
    const ctx = { cfg, index, lib, rng: mulberry32(seed), state: newState() };

    if (!index.size) warnings.push("No hay episodios disponibles en el catálogo: la programación es solo relleno.");
    for (const b of cfg.blocks) {
      if (b.seriesKey && !index.has(b.seriesKey)) warnings.push(`El bloque "${b.name || b.id}" usa una serie que no está disponible; se completa con otras series.`);
    }

    const items = [];
    const blocks = [];
    let cursor = 0;

    for (const seg of segs) {
      const seq = fillBlock(seg, ctx);
      const bi = blocks.length;
      const first = items.length;
      let t = seg.start;
      for (const it of seq.items) {
        items.push({
          id: `i${items.length}`, type: it.type, contentId: it.contentId,
          startMs: t, endMs: t + it.durationMs, durationMs: it.durationMs,
          day: dayOf(t), blockIndex: bi, meta: it.meta,
        });
        t += it.durationMs;
      }
      if (t !== seg.end) throw new Error(`Bloque mal cuadrado: termina en ${t} y debia terminar en ${seg.end}`);
      const b = seg.block;
      blocks.push({
        index: bi, blockId: b?.id ?? null, auto: !b, name: b?.name || (b?.seriesKey ? ctx.index.get(b.seriesKey)?.title ?? b.seriesKey : "Programación variada"),
        seriesKey: b?.seriesKey ?? null, mode: b ? b.selection.mode : "auto", day: dayOf(seg.start),
        startMs: seg.start, endMs: seg.end, firstItem: first, lastItem: items.length - 1, fillerMs: seq.fillerMs,
      });
      cursor = seg.end;
    }
    if (cursor !== WEEK) throw new Error("La programacion no cubre la semana completa");

    return {
      version: 1,
      id: `sch_${seed.toString(36)}_${now.toString(36)}`,
      generatedAt: now,
      seed,
      timeZone: input.config?.timeZone || cfg.timeZone,
      cycleMs: WEEK,
      plan: cfg,                 // PROGRAMACION: bloques y reglas
      blocks,                    // ocurrencias de bloques en la semana
      items,                     // CONTENIDO: linea de tiempo concreta
      stats: summarizeItems(items),
      warnings,
    };
  }

  function summarizeItems(items) {
    const byType = {};
    let fillerMs = 0;
    for (const it of items) {
      byType[it.type] = (byType[it.type] || 0) + 1;
      if (it.type === "filler") fillerMs += it.durationMs;
    }
    return { itemCount: items.length, byType, fillerMs, fillerPct: Math.round((fillerMs / WEEK) * 10000) / 100 };
  }

  // Comprueba la invariante fundamental: items contiguos que cubren la semana exacta.
  function validateSchedule(s) {
    const problems = [];
    if (!s?.items?.length) return ["sin items"];
    if (s.items[0].startMs !== 0) problems.push("no empieza en el lunes 00:00");
    for (let i = 0; i < s.items.length; i++) {
      const it = s.items[i];
      if (!(it.durationMs > 0) || it.endMs - it.startMs !== it.durationMs) problems.push(`item ${i}: duracion incoherente`);
      if (i && it.startMs !== s.items[i - 1].endMs) problems.push(`item ${i}: hueco o solape con el anterior`);
    }
    if (s.items[s.items.length - 1].endMs !== (s.cycleMs || WEEK)) problems.push("no termina en el domingo 24:00");
    return problems;
  }

  // ---------------------------------------------------------------- modo debug (15 s por contenido)
  // Misma logica de programacion, linea de tiempo comprimida: cada contenido dura <= 15 s y el ciclo se repite.
  function toDebugSchedule(schedule, slotMs = DEBUG_SLOT_MS) {
    let t = 0;
    const items = schedule.items.map((it) => {
      const d = Math.min(slotMs, it.durationMs);
      const out = { ...it, startMs: t, endMs: t + d, durationMs: d, origDurationMs: it.durationMs };
      t += d;
      return out;
    });
    return { ...schedule, items, cycleMs: t, debug: true, timeZone: "UTC" };
  }

  // ---------------------------------------------------------------- resolver
  // "¿Que debe estar al aire ahora, y en que posicion exacta?"
  function resolveSchedule(schedule, nowMs, opts = {}) {
    let S = schedule;
    if (opts.debug) {
      if (!schedule._debug) Object.defineProperty(schedule, "_debug", { value: toDebugSchedule(schedule), enumerable: false });
      S = schedule._debug;
    }
    const items = S.items;
    const cycle = S.cycleMs;
    const t = opts.debug ? ((nowMs % cycle) + cycle) % cycle : weekMsOf(nowMs, S.timeZone) % cycle;

    let lo = 0, hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (items[mid].startMs <= t) lo = mid; else hi = mid - 1;
    }
    const item = items[lo];
    const positionMs = t - item.startMs;
    const startAbsMs = nowMs - positionMs;
    const endAbsMs = startAbsMs + item.durationMs;
    const nextIndex = (lo + 1) % items.length;

    return {
      nowMs, cycleMs: cycle, debug: !!opts.debug, weekMs: t,
      current: { item, index: lo, startAbsMs, endAbsMs, positionMs, remainingMs: item.endMs - t },
      next: { item: items[nextIndex], index: nextIndex, startAbsMs: endAbsMs },
    };
  }

  // Siguientes `count` items a partir de un resultado del resolver (para preparar/precargar).
  function upcoming(schedule, resolved, count, opts = {}) {
    const S = opts.debug ? schedule._debug || (resolveSchedule(schedule, resolved.nowMs, opts), schedule._debug) : schedule;
    const out = [];
    let idx = resolved.current.index;
    let start = resolved.current.endAbsMs;
    for (let i = 0; i < count; i++) {
      idx = (idx + 1) % S.items.length;
      const item = S.items[idx];
      out.push({ item, index: idx, startAbsMs: start, endAbsMs: start + item.durationMs });
      start += item.durationMs;
    }
    return out;
  }

  // ---------------------------------------------------------------- reloj del canal
  // now() = epoch del servidor + tiempo monotonico transcurrido. Tras sincronizar NO depende del reloj del
  // dispositivo: cambiarlo a mano no altera la programacion.
  function createClock(opts = {}) {
    const deviceNow = opts.now || (() => Date.now());
    const perf = opts.perf || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    const fetchServerTime = opts.fetchServerTime; // async () => epochMs del servidor (o lanza error)
    const samples = opts.samples || 3;
    let base = null; // { epoch, perf, rttMs, source }

    const clock = {
      get synced() { return !!base; },
      get info() {
        return base
          ? { synced: true, source: base.source, rttMs: base.rttMs, offsetMs: Math.round(clock.now() - deviceNow()), lastSyncAt: base.at }
          : { synced: false, source: "device", rttMs: null, offsetMs: 0, lastSyncAt: null };
      },
      now() {
        return base ? Math.round(base.epoch + (perf() - base.perf)) : deviceNow();
      },
      // Fija la referencia con una hora conocida (p. ej. la que envia la extension).
      setServerTime(epochMs, { rttMs = 0, source = "server" } = {}) {
        base = { epoch: epochMs + rttMs / 2, perf: perf(), rttMs, source, at: deviceNow() };
      },
      // Pide la hora al servidor varias veces y se queda con la muestra de menor latencia (RTT).
      async sync() {
        if (!fetchServerTime) return clock.info;
        let best = null;
        for (let i = 0; i < samples; i++) {
          const t0 = perf();
          let server;
          try { server = await fetchServerTime(); } catch (_) { continue; }
          const t1 = perf();
          const rtt = t1 - t0;
          if (typeof server === "number" && Number.isFinite(server) && (!best || rtt < best.rtt)) best = { server, rtt, t1 };
        }
        if (best) {
          base = { epoch: best.server + best.rtt / 2, perf: best.t1, rttMs: Math.round(best.rtt), source: opts.source || "server", at: deviceNow() };
        }
        return clock.info;
      },
    };
    return clock;
  }

  const api = {
    SEC, MIN, HOUR, DAY, WEEK, DAY_NAMES, CLIP_KINDS, DEBUG_SLOT_MS,
    mulberry32, weekMsOf, fmtClock, fmtHM, fmtDuration, parseHM, dayOf,
    defaultConfig, normalizeConfig, buildSeriesIndex, normalizeLibrary,
    generateSchedule, validateSchedule, summarizeItems, toDebugSchedule, resolveSchedule, upcoming, createClock,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNSmart = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
