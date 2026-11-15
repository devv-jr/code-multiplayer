// Textos en español que arma la interfaz. Funciones puras, para probarlas.

/**
 * Une nombres como "Tú y yered" o "ana, bruno y yered".
 * Mi propio usuario se muestra como "Tú" y va primero.
 */
export function joinNames(users: readonly string[], me: string): string {
  const names = users.includes(me)
    ? ["Tú", ...users.filter((user) => user !== me)]
    : [...users];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

/** Palabra para cada estado de archivo (la insignia no depende solo del color). */
export const STATUS_WORD = {
  A: "nuevo",
  M: "modificado",
  D: "borrado",
  R: "renombrado",
} as const;
