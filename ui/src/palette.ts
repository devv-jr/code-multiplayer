// Color y rasgos del avatar de cada jugador, siempre los mismos para el
// mismo nombre. Funciones puras (sin React) para poder probarlas.

/**
 * Paleta fija: 8 colores que se distinguen entre sí también con daltonismo
 * (basada en la paleta Okabe-Ito, aclarada para fondo oscuro).
 */
export const PALETTE = [
  { name: "cielo", hex: "#5cc8ff" },
  { name: "ámbar", hex: "#ffa630" },
  { name: "menta", hex: "#2fe0a5" },
  { name: "limón", hex: "#f5e663" },
  { name: "chicle", hex: "#ff8fd0" },
  { name: "coral", hex: "#ff6b4a" },
  { name: "lila", hex: "#b69cff" },
  { name: "hielo", hex: "#dfe8ff" },
] as const;

/** Hash FNV-1a de 32 bits: simple, rápido y bien repartido para nombres cortos. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Asigna un color a cada usuario sin repetir.
 *
 * A cada quien le "toca" un color por el hash de su nombre. Si ya está
 * ocupado, toma el siguiente libre. Se recorre en orden alfabético para que
 * el resultado no dependa del orden en que llegan los usuarios.
 * Con más de 8 jugadores ya no quedan colores libres y se repiten.
 */
export function assignColors(users: readonly string[]): Map<string, string> {
  const colors = new Map<string, string>();
  const taken = new Set<number>();

  for (const user of [...new Set(users)].sort()) {
    let index = hashString(user) % PALETTE.length;
    if (taken.size < PALETTE.length) {
      while (taken.has(index)) index = (index + 1) % PALETTE.length;
    }
    taken.add(index);
    colors.set(user, PALETTE[index]!.hex);
  }
  return colors;
}

export const BODIES = ["gota", "cubo", "semilla", "nube"] as const;
export const EYES = ["redondos", "visor", "ciclope"] as const;
export const EXTRAS = ["antena", "cuernos", "aro", "cresta", "ninguno"] as const;

export interface AvatarTraits {
  body: (typeof BODIES)[number];
  eyes: (typeof EYES)[number];
  extra: (typeof EXTRAS)[number];
}

/** Rasgos del avatar de un usuario: cuerpo, ojos y accesorio. */
export function avatarTraits(user: string): AvatarTraits {
  const hash = hashString(`avatar:${user}`);
  return {
    body: BODIES[hash % BODIES.length]!,
    eyes: EYES[(hash >>> 8) % EYES.length]!,
    extra: EXTRAS[(hash >>> 16) % EXTRAS.length]!,
  };
}
