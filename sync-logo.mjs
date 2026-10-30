// Copia el logo original (logo.png, en la raiz) a la carpeta de la extension.
// Uso, desde la raiz del repo:   node sync-logo.mjs
// Despues recarga la extension en chrome://extensions.
//
// (La pagina del reproductor no necesita esto: lee ../logo.png directamente.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, "logo.png");
const dst = path.join(root, "catalog-extension", "logo.png");

if (!fs.existsSync(src)) {
  console.error(`No existe ${src}`);
  process.exit(1);
}

const same = fs.existsSync(dst) && fs.readFileSync(src).equals(fs.readFileSync(dst));
fs.copyFileSync(src, dst);
console.log(same ? "La extension ya tenia este logo (copia igual)." : "logo.png copiado a catalog-extension/.");
console.log("Recarga la extension en chrome://extensions para que lo use.");
