// Corre dentro de la pagina de Max. Recibe ordenes del service worker:
//   search -> lista de series candidatas en la pagina de busqueda
//   scrape -> lee todas las temporadas/episodios de la pagina de una serie
//   dump   -> diagnostico del DOM (para ajustar selectores)
(() => {
  if (window.__cnCatalogLoaded) return;
  window.__cnCatalogLoaded = true;

  const { SEASON_RE, parseCardText } = CNParse;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const WATCH = 'a[href*="/video/watch/"]';

  function progress(text) {
    try { chrome.runtime.sendMessage({ type: "progress", text }); } catch (_) {}
  }

  async function waitFor(fn, timeout = 20000, step = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v && (!Array.isArray(v) || v.length)) return v;
      await sleep(step);
    }
    return null;
  }

  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
  const shortText = (el) => (el.innerText || "").trim();
  const isSeasonLabel = (el) => {
    const t = shortText(el);
    return t.length <= 30 && !t.includes("\n") && SEASON_RE.test(t);
  };
  const seasonNumber = (el) => Number(SEASON_RE.exec(shortText(el))[1]);
  const cleanUrl = (href) => {
    const u = new URL(href, location.href);
    return u.origin + u.pathname;
  };

  // ---------- busqueda ----------
  function searchCandidates() {
    const seen = new Map();
    document.querySelectorAll('a[href*="/show/"]').forEach((a) => {
      const url = cleanUrl(a.href);
      if (seen.has(url)) return;
      const title =
        a.getAttribute("aria-label") ||
        a.querySelector("img")?.getAttribute("alt") ||
        shortText(a).split("\n")[0] ||
        "";
      if (title.trim()) seen.set(url, { title: title.trim(), url });
    });
    return [...seen.values()];
  }

  async function cmdSearch() {
    if (/login|signin|sign-in|auth/i.test(location.pathname)) {
      return { ok: false, error: "Max pide iniciar sesion en la ventana de trabajo." };
    }
    const found = await waitFor(searchCandidates, 15000);
    return { ok: true, candidates: found || [] };
  }

  // ---------- episodios ----------
  function episodeAnchors() {
    return [...document.querySelectorAll(WATCH)];
  }

  // Sube desde el enlace hasta el contenedor mas grande que solo contiene ese episodio.
  function cardContainer(a) {
    const href = cleanUrl(a.href);
    let el = a;
    for (let i = 0; i < 8; i++) {
      const p = el.parentElement;
      if (!p || p === document.body) break;
      const others = [...p.querySelectorAll(WATCH)].some((x) => cleanUrl(x.href) !== href);
      if (others || (p.innerText || "").length > 1200) break;
      el = p;
    }
    return el;
  }

  function collectEpisodes(season) {
    const byUrl = new Map();
    for (const a of episodeAnchors()) {
      const url = cleanUrl(a.href);
      if (byUrl.has(url)) continue;
      const parsed = parseCardText(cardContainer(a).innerText || "");
      if (parsed) byUrl.set(url, { season, ...parsed, url });
    }
    return [...byUrl.values()];
  }

  async function loadAll() {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      const n = episodeAnchors().length;
      if (n === last) stable++;
      else { stable = 0; last = n; }
      window.scrollBy(0, window.innerHeight * 0.8);
      await sleep(500);
    }
    window.scrollTo(0, 0);
    await sleep(300);
  }

  const signature = () => episodeAnchors().map((a) => cleanUrl(a.href)).join("|");

  // true si la lista de episodios cambio (es decir, la temporada realmente cambio).
  async function waitForChange(prev) {
    const changed = await waitFor(() => signature() !== prev && episodeAnchors().length, 8000);
    await sleep(900);
    return !!changed;
  }

  const cleanTitle = (t) =>
    (t || "")
      .replace(/[⁦-⁩‎‏]/g, "")
      .replace(/\s*[•|–-]\s*(?:HBO\s*)?Max.*$/i, "")
      .trim();

  // Abre una temporada desde el menu desplegable. Reintenta porque el menu puede
  // estar ya abierto (un clic al disparador lo cerraria en vez de abrirlo).
  async function pickFromDropdown(n) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = findTrigger();
      const opt = t && findOption(n, t);
      if (opt) { opt.click(); return true; }
      if (t) { t.click(); await sleep(700); }
    }
    return false;
  }

  const SEASON_TRIGGER = 'button,[role="button"],[role="combobox"]';
  const SEASON_OPTION = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="tab"],li,a,button,div';

  const findTrigger = () =>
    [...document.querySelectorAll(SEASON_TRIGGER)].find((el) => visible(el) && isSeasonLabel(el));

  const findOption = (n, trigger) =>
    [...document.querySelectorAll(SEASON_OPTION)].find(
      (el) => visible(el) && isSeasonLabel(el) && seasonNumber(el) === n && el !== trigger && !el.contains(trigger)
    );

  function seasonLabels() {
    const map = new Map();
    document.querySelectorAll(SEASON_OPTION + "," + SEASON_TRIGGER).forEach((el) => {
      if (visible(el) && isSeasonLabel(el)) map.set(seasonNumber(el), el);
    });
    return map;
  }

  async function scrapeCurrent(season) {
    progress(`Leyendo temporada ${season}...`);
    await loadAll();
    const eps = collectEpisodes(season);
    progress(`Temporada ${season}: ${eps.length} episodios`);
    return eps;
  }

  // msg.only: lista de temporadas a (re)leer; sin ella se lee la serie completa.
  async function cmdScrape(msg = {}) {
    const ready = await waitFor(() => episodeAnchors().length, 20000);
    if (!ready) return { ok: false, error: "No aparecieron episodios en la pagina de la serie." };

    const only = Array.isArray(msg.only) && msg.only.length ? new Set(msg.only) : null;
    const want = (n) => !only || only.has(n);
    const title = cleanTitle(document.querySelector("h1")?.innerText) || cleanTitle(document.title);

    const trigger = findTrigger();
    const visibleSeasons = seasonLabels();
    const episodes = [];
    const attempted = [];
    const failed = [];

    // Cambia de temporada con `open()` y la lee; si la lista no cambio, cuenta como fallo.
    async function readSeason(n, open) {
      attempted.push(n);
      const prev = signature();
      if (!(await open()) || !(await waitForChange(prev))) {
        failed.push(n);
        progress(`No pude abrir la temporada ${n}`);
        return;
      }
      episodes.push(...(await scrapeCurrent(n)));
    }

    if (visibleSeasons.size > 1 && !trigger) {
      // Temporadas como pestañas visibles.
      for (const n of [...visibleSeasons.keys()].sort((a, b) => a - b)) {
        if (want(n)) await readSeason(n, async () => { visibleSeasons.get(n)?.click(); return true; });
      }
    } else if (trigger) {
      // Menu desplegable de temporadas.
      const current = seasonNumber(trigger);
      if (want(current)) {
        attempted.push(current);
        episodes.push(...(await scrapeCurrent(current)));
      }

      let numbers;
      if (only) {
        numbers = [...only];
      } else {
        trigger.click();
        await sleep(700);
        numbers = [...new Set(
          [...document.querySelectorAll(SEASON_OPTION)]
            .filter((el) => visible(el) && isSeasonLabel(el) && el !== trigger && !el.contains(trigger))
            .map(seasonNumber)
        )];
      }
      for (const n of numbers.filter((x) => x !== current).sort((a, b) => a - b)) {
        await readSeason(n, () => pickFromDropdown(n));
      }
    } else {
      attempted.push(1);
      episodes.push(...(await scrapeCurrent(1)));
    }

    episodes.sort((a, b) => a.season - b.season || a.number - b.number);
    return {
      ok: true,
      title,
      url: cleanUrl(location.href),
      episodes,
      attempted,
      failedSeasons: failed,
      partial: !!only,
    };
  }

  // ---------- diagnostico ----------
  const attrsOf = (el) =>
    Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 120)]));

  // Busca donde vive el texto "N. Titulo" y describe su cadena de ancestros.
  function episodeTextProbe() {
    const leaves = [...document.querySelectorAll("body *")].filter(
      (el) => el.children.length === 0 && /^\d+\s*[.\-–]\s*\S/.test((el.textContent || "").trim())
    );
    return leaves.slice(0, 3).map((leaf) => {
      const chain = [];
      let el = leaf;
      for (let i = 0; i < 9 && el && el !== document.body; i++, el = el.parentElement) {
        chain.push({ tag: el.tagName, attrs: attrsOf(el), textLen: (el.innerText || "").length });
      }
      const card = leaf.closest("[role], li, article") || leaf.parentElement?.parentElement?.parentElement;
      return { text: leaf.textContent.trim().slice(0, 80), chain, cardHtml: card?.outerHTML.slice(0, 2500) };
    });
  }

  function cmdDump() {
    const anchors = episodeAnchors();
    const html = document.documentElement.innerHTML;
    const idx = html.indexOf("/video/watch/");
    return {
      ok: true,
      url: location.href,
      title: document.title,
      watchAnchors: anchors.length,
      // Para ajustar la deteccion de fin de episodio en la pagina de reproduccion.
      player: {
        videos: [...document.querySelectorAll("video")].map((v) => ({
          duration: v.duration, currentTime: v.currentTime, paused: v.paused, ended: v.ended,
        })),
        nextButtons: [...document.querySelectorAll('button,[role="button"],a')]
          .filter((el) => visible(el) && /siguiente|pr[oó]ximo|next|cr[eé]ditos|credits/i.test(`${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`))
          .map((el) => ({ tag: el.tagName, label: (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 80) })),
      },
      allAnchors: [...document.querySelectorAll("a[href]")]
        .slice(0, 60)
        .map((a) => ({ href: a.getAttribute("href"), text: shortText(a).slice(0, 50) })),
      videoWatchInSource: { count: html.split("/video/watch/").length - 1, sample: idx >= 0 ? html.slice(Math.max(0, idx - 200), idx + 200) : null },
      episodeTextProbe: episodeTextProbe(),
      sampleCards: anchors.slice(0, 3).map((a) => {
        const c = cardContainer(a);
        return { href: a.href, text: c.innerText, html: c.outerHTML.slice(0, 1500), parsed: parseCardText(c.innerText || "") };
      }),
      seasonCandidates: [...document.querySelectorAll(SEASON_OPTION + "," + SEASON_TRIGGER)]
        .filter((el) => visible(el) && isSeasonLabel(el))
        .map((el) => ({ tag: el.tagName, role: el.getAttribute("role"), text: shortText(el) })),
      showAnchors: [...document.querySelectorAll('a[href*="/show/"]')].slice(0, 5).map((a) => ({ href: a.href, text: shortText(a).slice(0, 80) })),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handlers = { search: cmdSearch, scrape: cmdScrape, dump: async () => cmdDump() };    const h = handlers[msg?.cmd];
    if (!h) return false;
    // Latido: evita que el service worker (MV3) se duerma en scrapes largos.
    const beat = setInterval(() => { try { chrome.runtime.sendMessage({ type: "ping" }); } catch (_) {} }, 10000);
    h(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }))
      .finally(() => clearInterval(beat));
    return true;
  });
})();
