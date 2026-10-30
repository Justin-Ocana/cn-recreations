import { generateSchedule, saveConfig } from "./smartStore.js";

const BUMPER_ERR = {
  "sin-carpeta": "no hay carpeta de bumpers",
  permiso: "permiso denegado",
  vacio: "la carpeta no tiene videos",
  lectura: "no se pudo leer la carpeta",
};

// Genera (o REGENERA) la parrilla: guarda la configuracion, mide la biblioteca de bumpers/promos y pide una
// parrilla nueva a la extension (nueva semilla, mismo catalogo y mismo plan). Llamar desde un clic (permiso de carpeta).
// Devuelve { schedule, notes[] } (notes = avisos para el usuario). No modifica el catalogo.
export async function regenerate({ bumpers, config, onProgress }) {
  const notes = [];
  if (config) {
    onProgress?.("Guardando configuración…");
    await saveConfig(config);
  }

  let library = {};
  if (bumpers?.folderName) {
    onProgress?.("Analizando bumpers y promos…");
    const r = await bumpers.buildLibrary((done, total) => onProgress?.(`Midiendo videos ${done}/${total}`));
    if (r.ok) {
      library = r.library;
      if (r.failed?.length) notes.push(`${r.failed.length} video(s) no se pudieron leer y se omitieron.`);
    } else {
      notes.push(`Sin bumpers (${BUMPER_ERR[r.error] || "error"}): la parrilla solo tiene relleno entre episodios.`);
    }
  } else {
    notes.push("No hay carpeta de bumpers: la parrilla solo tiene episodios y relleno. Elige una carpeta en Config para añadir bumpers y promos.");
  }

  onProgress?.("Generando parrilla…");
  const schedule = await generateSchedule({ library });
  return { schedule, notes };
}

export function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
