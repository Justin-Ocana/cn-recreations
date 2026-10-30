<div align="center">

<img src="logo.png" alt="Logo" width="220" />

# 📺 CN Recreations

**Revive la tele de los 2010s: un canal 24/7 que se reproduce solo desde tu cuenta de HBO Max.**

*Series al azar (o con horario de verdad), bumpers entre episodios, pantalla de carga retro y una guía de programación, todo con una extensión de Chrome y una página de control remoto.*

![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Estado](https://img.shields.io/badge/estado-proyecto%20personal-orange)

</div>

---

## 🎯 ¿Qué es esto?

Antes veías Cartoon Network esperando a que pasara lo que pasara: un episodio, unos bumpers, comerciales, otro episodio... Este proyecto intenta **recrear esa sensación** con tus propias series de HBO Max:

- Pulsas ▶ y el canal arranca solo, a **pantalla completa**.
- Cuando un episodio termina, sale un **bumper** y entra el siguiente, sin que tengas que tocar nada.
- Puedes dejarlo en modo **aleatorio**, o activar el **Horario Inteligente**: una parrilla semanal real (Lunes a Domingo) donde cada serie tiene su hora, y si entras a las 14:04 caes *en el minuto 4* del episodio que empezó a las 14:00, como en la tele de verdad.

> ⚠️ **Necesitas tu propia suscripción a HBO Max.** Este proyecto no incluye ni distribuye ningún video: solo controla las pestañas de Max que abres tú con tu cuenta.

## ✨ Características

| | |
|---|---|
| 🔎 **Catálogo automático** | La extensión lee una serie de Max (episodios, temporadas, duración, URL) y arma un catálogo JSON. Puedes importar/exportar, y activar o desactivar temporadas. |
| 🎲 **Modo aleatorio** | Elige el siguiente episodio al azar, evitando repetir series y episodios seguidos. |
| 🗓️ **Horario Inteligente** | Genera una parrilla de 24/7 con bloques por serie, horas exactas, promos y bumpers que **encajan al milisegundo**. Botón *Regenerar* con nueva semilla, reglas de no repetición y modo Debug (cada contenido dura 15 s para probar). |
| 📖 **Guía de programación (EPG)** | La página `/schedule` muestra la semana completa, qué está **AHORA** y qué viene **SIGUIENTE**, con reloj en vivo. |
| 🎞️ **Bumpers propios** | Eliges una carpeta con tus `.mp4` y se reproducen entre episodios (`promos/`, `intros/`, `outros/`, `clips/` según la subcarpeta). Fundido a negro de 1 s. |
| ⚡ **Precarga invisible** | El siguiente episodio se abre oculto 90 s antes y se activa al instante, para que el cambio no se note. |
| 🔒 **Reproductor bloqueado** | En horario no se puede adelantar, pausar ni cambiar la velocidad: la posición la manda la hora. |
| 🕹️ **Control remoto** | La página principal es un control remoto estilo años 2010 con pantalla de estática. |
| 🪵 **Registro del canal** | El popup muestra paso a paso lo que hizo el canal, útil para diagnosticar. |

## 🧩 ¿Cómo funciona?

HBO Max usa DRM, así que **no se puede incrustar ni filtrar** en otra página. La solución: una extensión de Chrome que controla las **pestañas reales de Max** y una página aparte que hace de "tele".

```
┌─────────────────────┐   mensajes    ┌──────────────────────────┐
│  Página (React)     │ ────────────▶ │  Extensión (service      │
│  localhost:5173     │ ◀──────────── │  worker): canal, horario │
│  control remoto,    │               └───────────┬──────────────┘
│  bumpers, EPG       │                           │ abre / controla
└─────────────────────┘                           ▼
                                      ┌──────────────────────────┐
                                      │  Pestañas de HBO Max     │
                                      │  (episodio actual +      │
                                      │   siguiente precargado)  │
                                      └──────────────────────────┘
```

No usa IA ni mira la pantalla para saber cuándo termina un episodio: lo detecta leyendo el `<video>` de la propia pestaña.

## 🚀 Instalación

**Requisitos:** Google Chrome, [Node.js](https://nodejs.org) 18+ y una cuenta de HBO Max con la sesión iniciada en ese Chrome.

### 1. La extensión

1. Abre `chrome://extensions` y activa el **Modo desarrollador**.
2. Pulsa **Cargar descomprimida** y elige la carpeta [`catalog-extension/`](catalog-extension).

### 2. La página (el control remoto)

```bash
cd player
npm install
npm run dev
```

Abre **http://localhost:5173** en el mismo Chrome.

## 🕹️ Uso

1. **Arma tu catálogo.** Entra a la página de una serie en HBO Max, abre el popup de la extensión y pulsa para leerla. Repite con tus series. Con *Descargar* guardas el JSON y con *Importar JSON* lo recuperas.
2. **Elige tus bumpers** (opcional) en la pantalla principal: una carpeta con tus `.mp4`.
3. **Pulsa ▶** y disfruta.
4. **Horario Inteligente:** en `/settings` genera la parrilla, cambia el modo de reproducción y consulta la guía en `/schedule`. Activa **Debug** para ver los cambios cada 15 s sin esperar horas.

## 🗂️ Estructura

```
catalog-extension/     Extensión de Chrome (Manifest V3)
├─ background.js       Service worker (catálogo)
├─ channel.js          Motor del canal: pestañas, precarga, bumpers, horario
├─ smart-schedule.js   Generador y resolvedor de la parrilla (puro, probable con Node)
├─ smart.js            API del Horario Inteligente en el service worker
├─ controller.js       Corre en las pestañas de Max: detecta el fin, sincroniza la posición
├─ overlay.js          Pantalla de carga, negro, logo, bloqueo y reloj
├─ bridge.js           Puente entre la página y la extensión
└─ popup.*             Interfaz de la extensión

player/                Página de control (React + Vite)
└─ src/                Control remoto, /settings, /schedule, bumpers
```

## 🧭 Límites conocidos

Es un proyecto personal y está probado sobre todo con simulaciones en Node; úsalo con ese ojo.

- Las pestañas ocultas de Chrome a veces no cargan el reproductor de Max, y entonces el episodio se carga en frío y tarda más.
- Las duraciones de los episodios son las del catálogo (redondeadas a minutos) hasta que se reproduce cada uno y se mide la real.
- La hora del canal se pide a un servicio externo de hora; si no responde, se usa el reloj del equipo.
- Max cambia su página de vez en cuando, así que los selectores del lector pueden necesitar ajustes.

## ⚖️ Aviso legal

Proyecto **no oficial**, sin relación con Cartoon Network, Warner Bros. Discovery ni HBO Max. Los nombres y logotipos pertenecen a sus dueños y aparecen solo como referencia visual. No distribuye contenido protegido: cada persona debe usar su propia suscripción. Pensado para uso personal y educativo.

---

<div align="center">

Hecho con nostalgia 💛 por [@Justin-Ocana](https://github.com/Justin-Ocana)

</div>
