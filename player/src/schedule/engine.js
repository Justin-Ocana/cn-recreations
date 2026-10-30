// El motor del Horario Inteligente vive en la extension (catalog-extension/smart-schedule.js) y es EL MISMO
// archivo que usan el service worker y las pruebas: una sola copia del generador y del resolver.
// Al importarlo por efecto secundario publica globalThis.CNSmart.
import "../../../catalog-extension/smart-schedule.js";

export const CN = globalThis.CNSmart;
export const { MIN, SEC, HOUR, DAY, WEEK, DAY_NAMES } = CN;
