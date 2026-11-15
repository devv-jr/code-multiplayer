// Constantes compartidas entre el servidor y la interfaz web.
// Este archivo no importa nada de Node: la UI (navegador) también lo usa.

/** Hasta este tiempo desde su último cambio, un jugador está "editando". */
export const EDITING_MAX_MS = 2 * 60 * 1000;

/** Pasado este tiempo sin cambios, un jugador está "dormido" (inactivo). */
export const ASLEEP_AFTER_MS = 30 * 60 * 1000;

/** Tamaño máximo de un diff servido por la API. */
export const DIFF_MAX_BYTES = 200 * 1024;

/** Máximo de archivos que devuelve el árbol del proyecto. */
export const TREE_MAX_FILES = 20_000;

export type PlayerStatus = "editando" | "pausa" | "dormido";

/**
 * Estado de un jugador según hace cuánto fue su último cambio.
 * Se calcula en el cliente (no viaja en el JSON) para que se actualice solo
 * con el paso del tiempo, sin esperar al servidor.
 */
export function playerStatus(lastWipAt: string | Date, now: Date = new Date()): PlayerStatus {
  const age = now.getTime() - new Date(lastWipAt).getTime();
  if (age <= EDITING_MAX_MS) return "editando";
  if (age <= ASLEEP_AFTER_MS) return "pausa";
  return "dormido";
}
