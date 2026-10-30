import { useEffect, useRef, useState } from "react";

// Reproduce un bumper a pantalla completa (sobre todo lo demas, menos el logo del canal).
// Al terminar se queda en negro -sin dejar el ultimo cuadro- hasta que la extension cambie de pestaña.
//
// bumper (modo normal):    { token, id, name, url, ended }
// bumper (Horario Inteligente, "scheduled"): ademas
//   startAtMs  posicion a la que hay que entrar (llegar a mitad de un clip)
//   recvPerf   performance.now() en que llego la orden (para descontar lo que tarde en cargar)
//   endAt      performance.now() exacto en que termina su hueco en la parrilla (hora real, no el evento "ended")
//   url null   = relleno: negro hasta la hora de fin
// En este modo el clip NUNCA decide cuando termina: si dura menos que su hueco queda en negro hasta la hora
// exacta, y si dura mas se corta a esa hora.
export default function BumperLayer({ bumper, onStarted, onEnded, onError }) {
  const videoRef = useRef(null);
  const doneRef = useRef(null); // token ya resuelto (evita avisar dos veces)
  const [videoDone, setVideoDone] = useState(false); // el clip acabo antes que su hueco: queda en negro

  useEffect(() => {
    setVideoDone(false);
    if (!bumper) return undefined;
    doneRef.current = null;

    if (bumper.scheduled) {
      if (!bumper.url) onStarted(bumper.token); // relleno / clip ausente: no hay nada que "arrancar"
      if (bumper.endAt == null) return undefined;
      const timer = setInterval(() => {
        if (performance.now() < bumper.endAt || doneRef.current === bumper.token) return;
        doneRef.current = bumper.token;
        clearInterval(timer);
        onEnded(bumper.token);
      }, 100);
      return () => clearInterval(timer);
    }

    const video = videoRef.current;
    if (!video) return undefined;
    video.currentTime = 0;
    // Chrome permite el sonido porque esta pagina recibio el clic en Play.
    video.play().catch((err) => {
      if (doneRef.current === bumper.token) return;
      doneRef.current = bumper.token;
      onError(bumper.token, bumper.id, err?.name || "play");
    });
    return undefined;
  }, [bumper?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!bumper) return null;

  const once = (fn) => (...args) => {
    if (doneRef.current === bumper.token) return;
    doneRef.current = bumper.token;
    fn(...args);
  };

  const onMeta = (e) => {
    if (!bumper.scheduled) return;
    const v = e.currentTarget;
    // Posicion que corresponde AHORA: la de la orden + lo que tardo en cargar el archivo.
    const posSec = ((bumper.startAtMs || 0) + (performance.now() - bumper.recvPerf)) / 1000;
    if (posSec >= v.duration - 0.05) { setVideoDone(true); return; } // ya paso su final: negro hasta el fin del hueco
    v.currentTime = Math.max(0, posSec);
    v.play().catch((err) => onError(bumper.token, bumper.id, err?.name || "play"));
  };

  const scheduledEnded = () => setVideoDone(true); // no avisa "ended": manda la hora, no el video
  const hidden = bumper.ended || videoDone;

  return (
    <div className={`bumper${hidden ? " bumper--ended" : ""}`} aria-hidden="true">
      {bumper.url && (
        <video
          ref={videoRef}
          src={bumper.url}
          autoPlay={!bumper.scheduled}
          playsInline
          onLoadedMetadata={onMeta}
          onPlaying={() => onStarted(bumper.token)}
          onEnded={bumper.scheduled ? scheduledEnded : once(() => onEnded(bumper.token))}
          onError={bumper.scheduled ? () => { setVideoDone(true); onError(bumper.token, bumper.id, "decode"); } : once(() => onError(bumper.token, bumper.id, "decode"))}
        />
      )}
    </div>
  );
}
