import { useCallback, useEffect, useState } from "react";

// Enrutado minimo sin dependencias: "/" (television), "/schedule" (guia) y "/settings" (programacion).
const clean = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p) || "/";

export function usePath() {
  const [path, setPath] = useState(() => clean(window.location.pathname));

  useEffect(() => {
    const onPop = () => setPath(clean(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((to) => {
    const target = clean(to);
    if (target !== clean(window.location.pathname)) window.history.pushState({}, "", target);
    setPath(target);
    window.scrollTo?.(0, 0);
  }, []);

  return [path, go];
}

// <a> que navega sin recargar la pagina (respeta ctrl/cmd-clic y clic central).
export function linkProps(to, go) {
  return {
    href: to,
    onClick: (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go(to);
    },
  };
}
