import { useEffect, useRef } from "react";

// Estática de TV analógica: ruido en baja resolución escalado en pixeles gruesos,
// con algunas filas desplazadas de brillo para el aspecto de señal inestable.
export default function NoiseCanvas({ scale = 3, fps = 24 }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext("2d");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let img;
    let px;
    let raf = 0;
    let last = 0;

    const draw = () => {
      for (let y = 0; y < h; y++) {
        const glitch = Math.random() < 0.025;
        const bias = glitch ? (Math.random() - 0.3) * 110 : 0;
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let v = Math.random() * 255 + bias;
          v = v < 0 ? 0 : v > 255 ? 255 : v;
          px[row + x] = 0xff000000 | (v << 16) | (v << 8) | v;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    const resize = () => {
      w = Math.max(1, Math.ceil(window.innerWidth / scale));
      h = Math.max(1, Math.ceil(window.innerHeight / scale));
      canvas.width = w;
      canvas.height = h;
      img = ctx.createImageData(w, h);
      px = new Uint32Array(img.data.buffer);
      draw();
    };

    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 1000 / fps) return;
      last = t;
      draw();
    };

    resize();
    window.addEventListener("resize", resize);
    if (!reduce) raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [scale, fps]);

  return <canvas ref={ref} className="noise" aria-hidden="true" />;
}
