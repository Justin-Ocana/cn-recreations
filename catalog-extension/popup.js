const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function flash(text) { $("msg").textContent = text; }

function renderJob(job) {
  const busy = job && (job.status === "running" || job.status === "needs_choice");
  $("start").disabled = busy;
  $("startCurrent").disabled = busy;
  $("cancel").hidden = !busy;

  $("progress").hidden = !busy;
  if (busy) $("progress").textContent = `Serie ${Math.min((job.done || 0) + 1, job.total)} de ${job.total}: ${job.current || ""}`;

  const choosing = job?.status === "needs_choice" && job.candidates?.length;
  $("choice").hidden = !choosing;
  if (choosing) {
    $("choiceQuery").textContent = job.query;
    const list = $("choiceList");
    list.replaceChildren();
    job.candidates.forEach((c) => {
      const b = document.createElement("button");
      b.textContent = c.title;
      b.onclick = () => send({ type: "choose", candidate: c });
      list.append(b);
    });
  }

  const lines = (job?.log || []).map((l) => `${new Date(l.t).toLocaleTimeString()}  ${l.text}`);
  const logEl = $("log");
  logEl.textContent = lines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

// Guarda el cambio en el catalogo (la vista se redibuja sola con storage.onChanged).
async function editCatalog(mutate) {
  const { catalog } = await chrome.storage.local.get("catalog");
  if (!catalog) return;
  mutate(catalog);
  await chrome.storage.local.set({ catalog });
}

const openSeries = new Set(); // series desplegadas; se recuerdan entre redibujados

function renderCatalog(catalog) {
  const series = Object.entries(catalog?.series || {});
  const total = series.reduce((n, [, s]) => n + s.episodes.length, 0);
  const active = series.reduce((n, [, s]) => n + CNCatalog.activeCount(s), 0);
  $("totals").textContent = !series.length
    ? "(vacío)"
    : `(${series.length} series · ${active}${active === total ? "" : ` de ${total}`} episodios activos)`;

  const ul = $("catalog");
  ul.replaceChildren();

  series.forEach(([key, s]) => {
    const seasons = CNCatalog.seasonsOf(s);
    const on = CNCatalog.activeCount(s);
    const missing = s.failedSeasons?.length ? ` ⚠ faltan temp. ${s.failedSeasons.join(", ")}` : "";

    const del = el("button", { textContent: "✕", title: "Quitar del catálogo", className: "del" });
    del.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSeries.delete(key);
      editCatalog((c) => { delete c.series[key]; });
    };

    const summary = el(
      "summary", {},
      el("span", { className: "stitle" }, s.title + " ", el("small", { textContent: `${on}/${s.episodes.length} ep.${missing}` })),
      del
    );

    const rows = seasons.map(({ season, count, enabled }) => {
      const cb = el("input", { type: "checkbox", checked: enabled });
      cb.onchange = () => editCatalog((c) => CNCatalog.setSeasonEnabled(c, key, season, cb.checked));
      return el("label", { className: "season" + (enabled ? "" : " off") }, cb, ` Temporada ${season} `, el("small", { textContent: `${count} ep.` }));
    });

    const all = el("button", { textContent: "Todas" });
    const none = el("button", { textContent: "Ninguna" });
    all.onclick = () => editCatalog((c) => CNCatalog.setAllSeasons(c, key, true));
    none.onclick = () => editCatalog((c) => CNCatalog.setAllSeasons(c, key, false));

    const details = el(
      "details", { open: openSeries.has(key) },
      summary,
      el("div", { className: "seasons" }, ...rows, el("div", { className: "bulk" }, all, none))
    );
    details.addEventListener("toggle", () => (details.open ? openSeries.add(key) : openSeries.delete(key)));

    ul.append(el("li", {}, details));
  });
}

$("start").onclick = async () => {
  const names = $("names").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!names.length) return flash("Escribe al menos una serie.");
  const base = $("base").value.trim();
  await chrome.storage.local.set({ base });
  const res = await send({ type: "start", names, base });
  flash(res?.ok ? "" : res?.error || "No se pudo iniciar.");
};

let readyTab = null;
let lastChannel = null;

function renderChannel(ch) {
  lastChannel = ch;
  const on = !!ch?.active;
  $("chNext").disabled = !on;
  $("chStop").disabled = !on;
  const cur = ch?.current;
  const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / xs.length / 1000).toFixed(1);
  const cold = ch?.loads || [];
  const warm = ch?.switches || [];
  const parts = [];
  if (cold.length) parts.push(`carga en frío ${avg(cold)}s (${cold.length})`);
  if (warm.length) parts.push(`cambio precargado ${avg(warm)}s (${warm.length})`);
  if (on) parts.push(ch.bumperMode ? (ch.phase === "bumper" ? "🎬 bumper en curso" : "con bumpers") : "con pantalla de carga");
  if (ch?.preloadTabId) parts.push(readyTab === ch.preloadTabId ? "siguiente listo ✔" : "precargando siguiente…");

  $("channelInfo").textContent = on
    ? (cur ? `▶ ${cur.seriesTitle} — T${cur.season} E${cur.number}: ${cur.title}` : "Iniciando...") +
      (parts.length ? `\n${parts.join(" · ")}` : "")
    : "Detenido. Pulsa ▶ en la página del reproductor para empezar.";
}

// Registro del canal: ultimas lineas de lo que hicieron la extension y las pestañas (sirve para diagnosticar).
function renderChannelLog(entries) {
  const lines = (entries || []).slice(-60).map((e) => {
    const d = new Date(e.t);
    return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, "0")}  ${e.text}`;
  });
  const pre = $("chLog");
  pre.textContent = lines.length ? lines.join("\n") : "(vacío: aún no se ha iniciado el canal)";
  pre.scrollTop = pre.scrollHeight;
}

$("chLogCopy").onclick = async () => {
  const { channelLog } = await chrome.storage.local.get("channelLog");
  const text = (channelLog || []).map((e) => `${new Date(e.t).toISOString().slice(11, 23)}  ${e.text}`).join("\n");
  try {
    await navigator.clipboard.writeText(text || "(vacío)");
    flash("Registro copiado al portapapeles.");
  } catch (_) {
    flash("No se pudo copiar.");
  }
};

$("chNext").onclick = () => send({ type: "channel:next" });
$("chStop").onclick = () => send({ type: "channel:stop" });

$("startCurrent").onclick = async () => {
  const res = await send({ type: "startCurrent", full: $("full").checked });
  flash(res?.ok ? "" : res?.error || "No se pudo iniciar.");
};

$("cancel").onclick = () => send({ type: "cancel" });
$("skip").onclick = () => send({ type: "choose", candidate: null });

$("download").onclick = async () => {
  const { catalog } = await chrome.storage.local.get("catalog");
  if (!catalog || !Object.keys(catalog.series).length) return flash("El catálogo está vacío.");
  const url = URL.createObjectURL(new Blob([JSON.stringify(catalog, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "catalog.json" });
  a.click();
  URL.revokeObjectURL(url);
};

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

// Importar: fusiona el JSON elegido con el catalogo actual (no borra nada).
$("import").onclick = () => $("importFile").click();

$("importFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // permite volver a elegir el mismo archivo
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) return flash("El archivo es demasiado grande (máx. 50 MB).");

  let incoming;
  try {
    incoming = JSON.parse(await file.text());
  } catch (_) {
    return flash(`"${file.name}" no es un JSON válido.`);
  }

  const { catalog } = await chrome.storage.local.get("catalog");
  const res = CNCatalog.mergeImport(catalog, incoming);
  if (!res.ok) return flash(res.error);

  await chrome.storage.local.set({ catalog: res.catalog });
  const s = res.stats;
  const parts = [
    `${s.seriesNew} series nuevas`,
    `${s.seriesUpdated} actualizadas`,
    `${s.episodesNew} episodios nuevos`,
    `${s.episodesUpdated} actualizados`,
  ];
  const skipped = s.skippedEpisodes + s.skippedSeries;
  flash(`Importado: ${parts.join(", ")}.${skipped ? ` Omitidos por inválidos: ${s.skippedEpisodes} episodios, ${s.skippedSeries} series.` : ""}`);
};

$("diag").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const dump = await chrome.tabs.sendMessage(tab.id, { cmd: "dump" });
    await navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
    flash("Diagnóstico copiado al portapapeles. Pégalo en el chat.");
  } catch (e) {
    flash("Abre una pestaña de Max (página de una serie) y reintenta.");
  }
};

(async () => {
  const { job, catalog, base, channel, channelPreloadReady, channelLog } = await chrome.storage.local.get([
    "job", "catalog", "base", "channel", "channelPreloadReady", "channelLog",
  ]);
  renderChannelLog(channelLog);
  readyTab = channelPreloadReady ?? null;
  if (base) $("base").value = base;
  renderJob(job);
  renderCatalog(catalog);
  renderChannel(channel);
})();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.channelLog) renderChannelLog(changes.channelLog.newValue);
  if (changes.channelPreloadReady) {
    readyTab = changes.channelPreloadReady.newValue ?? null;
    renderChannel(lastChannel);
  }
  if (changes.channel) renderChannel(changes.channel.newValue);
  if (changes.job) renderJob(changes.job.newValue);
  if (changes.catalog) renderCatalog(changes.catalog.newValue);
});
