// Detección de novedades entre dos estados consecutivos. Es una función pura:
// no lee el reloj ni el repo, solo compara lo que recibe.

import { ASLEEP_AFTER_MS } from "./constants.js";
import type { ActivityEvent, State } from "./types.js";

export type { ActivityEvent } from "./types.js";

/**
 * Compara el estado anterior con el nuevo y devuelve lo que pasó.
 *
 * - Sin estado anterior (primera carga) no hay eventos: lo que ya estaba al
 *   abrir el panel no es una novedad.
 * - Nunca hay eventos sobre mi propio trabajo, salvo el choque, que me
 *   interesa aunque lo haya provocado yo.
 */
export function diffStates(prev: State | null, next: State): ActivityEvent[] {
  if (!prev) return [];
  const events: ActivityEvent[] = [];

  for (const player of next.players) {
    if (player.isMe) continue;

    const before = prev.players.find((p) => p.user === player.user);
    if (!before) {
      // Un jugador nuevo se anuncia una sola vez, no archivo por archivo.
      events.push({ type: "joined", user: player.user });
      continue;
    }

    // "Dormido" se mide entre sus dos instantáneas, sin mirar el reloj:
    // si la nueva llegó más de 30 min después de la anterior, estaba dormido.
    const gap = new Date(player.lastWipAt).getTime() - new Date(before.lastWipAt).getTime();
    if (gap > ASLEEP_AFTER_MS) {
      events.push({ type: "woke-up", user: player.user });
    }

    // Si antes no se pudo leer su trabajo, no sabemos qué archivos tocaba:
    // ahora todos parecerían nuevos. Mejor no avisar.
    if (before.error) continue;

    const known = new Set(before.files.map((file) => file.path));
    for (const file of player.files) {
      if (!known.has(file.path)) {
        events.push({ type: "started-file", user: player.user, file: file.path });
      }
    }
  }

  const knownOverlaps = new Set(prev.overlaps.map((overlap) => overlap.file));
  for (const overlap of next.overlaps) {
    if (!knownOverlaps.has(overlap.file)) {
      events.push({ type: "overlap", file: overlap.file, users: overlap.users });
    }
  }

  return events;
}
