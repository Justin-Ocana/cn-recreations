import { useState } from "react";

// Logo del canal, abajo a la derecha (la "marca de agua" de la TV).
// Usa player/public/logo.png; si el archivo no existe, no se muestra nada.
export default function ChannelBug() {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img
      className="bug"
      src="/logo.png"
      alt="Cartoon Network"
      draggable={false}
      onError={() => setOk(false)}
    />
  );
}
