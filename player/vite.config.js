import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// El logo vive UNA sola vez, en la raiz del repo (../logo.png). La pagina lo sirve directo
// desde ahi (sin copias que se queden viejas): al cambiar el archivo basta recargar la pagina.
// Para la extension hay que copiarlo a su carpeta: `node sync-logo.mjs` (en la raiz).
const LOGO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../logo.png");

const rootLogo = () => ({
  name: "root-logo",
  configureServer(server) {
    server.middlewares.use("/logo.png", (_req, res) => {
      if (!fs.existsSync(LOGO)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store"); // siempre la version actual del archivo
      fs.createReadStream(LOGO).pipe(res);
    });
  },
  generateBundle() {
    if (fs.existsSync(LOGO)) {
      this.emitFile({ type: "asset", fileName: "logo.png", source: fs.readFileSync(LOGO) });
    }
  },
});

export default defineConfig({
  plugins: [react(), rootLogo()],
  server: { port: 5173, fs: { allow: [".."] } }, // permite importar el motor de ../catalog-extension
});
