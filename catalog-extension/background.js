importScripts("parse.js", "smart-schedule.js", "channel.js", "smart.js");

const DEFAULT_BASE = "https://play.hbomax.com";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

let running = false;
let cancelled = false;
let choiceResolver = null;

// ---------- estado compartido con el popup (chrome.storage) ----------
let jobChain = Promise.resolve();
function updateJob(mutate) {
  jobChain = jobChain
    .then(async () => {
      const { job } = await chrome.storage.local.get("job");
      const j = job || { status: "idle", log: [] };
      mutate(j);
      j.log = (j.log || []).slice(-200);
      await chrome.storage.local.set({ job: j });
    })
    .catch(() => {});
  return jobChain;
}
const log = (text) => updateJob((j) => j.log.push({ t: Date.now(), text }));

const seriesKey = (url) => new URL(url).pathname.split("/").filter(Boolean).pop();

// Guarda la serie. Si la lectura fue parcial (solo temporadas reintentadas) fusiona
// con lo que ya habia; si fue completa, reemplaza. Recuerda las temporadas que fallaron.
async function saveSeries(query, result) {
  const { catalog } = await chrome.storage.local.get("catalog");
  const c = catalog || { version: 1, series: {} };
  const key = seriesKey(result.url) || CNParse.norm(result.title);
  const prev = c.series[key];

  let episodes = result.episodes;
  let failedSeasons = result.failedSeasons;
  if (result.partial && prev) {
    const byUrl = new Map(prev.episodes.map((e) => [e.url, e]));
    result.episodes.forEach((e) => byUrl.set(e.url, e));
    episodes = [...byUrl.values()].sort((a, b) => a.season - b.season || a.number - b.number);
    const untouched = (prev.failedSeasons || []).filter((n) => !result.attempted.includes(n));
    failedSeasons = [...new Set([...untouched, ...result.failedSeasons])].sort((a, b) => a - b);
  }

  // Volver a leer la serie no debe perder la duracion REAL de los episodios ya medida al reproducirlos.
  const measured = new Map((prev?.episodes || []).filter((e) => e.durationSec).map((e) => [e.url, e.durationSec]));
  episodes = episodes.map((e) => (!e.durationSec && measured.has(e.url) ? { ...e, durationSec: measured.get(e.url) } : e));

  c.series[key] = {
    title: result.title,
    query,
    url: result.url,
    scrapedAt: new Date().toISOString(),
    failedSeasons,
    // Volver a leer la serie no debe reactivar las temporadas que el usuario desactivo.
    disabledSeasons: prev?.disabledSeasons || [],
    episodes,
  };
  await chrome.storage.local.set({ catalog: c });
  return c.series[key];
}

// ---------- utilidades de pestaña ----------
function waitTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("La pagina tardo demasiado en cargar."));
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function goto(tabId, url) {
  const loaded = waitTabComplete(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

async function ask(tabId, msg) {
  for (let i = 0; i < 20; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      const m = String(e?.message || e);
      if (!/Receiving end|Could not establish/i.test(m)) throw e;
      await pause(750);
    }
  }
  throw new Error("El lector no respondio en la pagina de Max (¿sesion iniciada / perfil elegido?).");
}

function chooseCandidate(query, candidates) {
  return new Promise((resolve) => {
    choiceResolver = resolve;
    updateJob((j) => {
      j.status = "needs_choice";
      j.query = query;
      j.candidates = candidates.slice(0, 8);
    });
  });
}

// ---------- trabajo principal ----------
async function runJob(names, base) {
  running = true;
  cancelled = false;
  await updateJob((j) => {
    j.status = "running";
    j.queue = names;
    j.done = 0;
    j.total = names.length;
    j.candidates = null;
    j.log = [];
  });

  let win;
  try {
    win = await chrome.windows.create({ url: base, focused: false, width: 1280, height: 900 });
    const tabId = win.tabs[0].id;
    await waitTabComplete(tabId).catch(() => {});

    for (const name of names) {
      if (cancelled) break;
      await updateJob((j) => { j.current = name; });
      try {
        await log(`Buscando "${name}"...`);
        await goto(tabId, `${base}/search?q=${encodeURIComponent(name)}`);
        const search = await ask(tabId, { cmd: "search" });
        if (!search.ok) throw new Error(search.error);
        if (!search.candidates.length) {
          throw new Error("Sin resultados. Si ves login o selector de perfil en la ventana de trabajo, resuelvelo y reintenta.");
        }

        let pick = CNParse.pickAuto(name, search.candidates);
        if (!pick) {
          await log(`Varios resultados para "${name}", elige uno en el popup.`);
          pick = await chooseCandidate(name, search.candidates);
          await updateJob((j) => { j.status = "running"; j.candidates = null; });
          if (!pick) { await log(`"${name}" omitida.`); continue; }
        }

        await log(`Serie: ${pick.title}`);
        await goto(tabId, pick.url);
        const res = await ask(tabId, { cmd: "scrape" });
        if (!res.ok) throw new Error(res.error);

        const saved = await saveSeries(name, res);
        await log(`✔ ${saved.title}: ${saved.episodes.length} episodios guardados.`);
        if (saved.failedSeasons.length) await log(`⚠ Faltan las temporadas ${saved.failedSeasons.join(", ")}.`);
      } catch (e) {
        await log(`✖ "${name}": ${e.message}`);
      }
      await updateJob((j) => { j.done += 1; });
      if (!cancelled) await pause(rand(3000, 6000));
    }
  } catch (e) {
    await log(`✖ Error general: ${e.message}`);
  } finally {
    if (win?.id) chrome.windows.remove(win.id).catch(() => {});
    running = false;
    await updateJob((j) => { j.status = cancelled ? "cancelled" : "done"; j.current = null; });
  }
}

// Lee la serie que ya esta abierta en la pestaña activa (sin buscar).
async function runCurrentTab(full) {
  running = true;
  cancelled = false;
  await updateJob((j) => {
    j.status = "running";
    j.done = 0;
    j.total = 1;
    j.candidates = null;
    j.current = "pestaña actual";
    j.log = [];
  });
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url || !/^https?:\/\/[^/]*(max|hbomax)\.com\/(?:[a-z-]+\/)?show\//i.test(tab.url)) {
      throw new Error("La pestaña activa no es la pagina de una serie de Max (URL con /show/).");
    }
    // Si la ultima lectura de esta serie dejo temporadas con fallo, reintenta solo esas.
    const { catalog } = await chrome.storage.local.get("catalog");
    const failedBefore = catalog?.series?.[seriesKey(tab.url)]?.failedSeasons || [];
    const only = !full && failedBefore.length ? failedBefore : undefined;
    await log(only ? `Reintentando solo las temporadas que fallaron: ${only.join(", ")}` : "Leyendo la serie de la pestaña activa...");

    const res = await ask(tab.id, { cmd: "scrape", only });
    if (!res.ok) throw new Error(res.error);
    const saved = await saveSeries(res.title, res);
    await log(`✔ ${saved.title}: ${saved.episodes.length} episodios en el catálogo.`);
    if (saved.failedSeasons.length) {
      await log(`⚠ Faltan las temporadas ${saved.failedSeasons.join(", ")}. Pulsa de nuevo para reintentarlas.`);
    }
  } catch (e) {
    await log(`✖ ${e.message}`);
  } finally {
    running = false;
    await updateJob((j) => { j.status = "done"; j.done = 1; j.current = null; });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "startCurrent":
      if (running) { sendResponse({ ok: false, error: "Ya hay un trabajo en curso." }); break; }
      runCurrentTab(!!msg.full);
      sendResponse({ ok: true });
      break;
    case "start":
      if (running) { sendResponse({ ok: false, error: "Ya hay un trabajo en curso." }); break; }
      runJob(msg.names, (msg.base || DEFAULT_BASE).replace(/\/+$/, ""));
      sendResponse({ ok: true });
      break;
    case "choose":
      if (choiceResolver) { choiceResolver(msg.candidate || null); choiceResolver = null; }
      sendResponse({ ok: true });
      break;
    case "cancel":
      cancelled = true;
      if (choiceResolver) { choiceResolver(null); choiceResolver = null; }
      sendResponse({ ok: true });
      break;
    case "progress":
      log(msg.text);
      break;
  }
  return false;
});
