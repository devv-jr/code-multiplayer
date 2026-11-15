// Formato de texto para la terminal.

import type { DiffStat } from "./git.js";

/** Hora local como "12:03:15". */
export function clock(date: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Resumen de cambios como "3 archivos, +42 −7". */
export function formatStat(stat: DiffStat): string {
  const files = stat.files === 1 ? "1 archivo" : `${stat.files} archivos`;
  return `${files}, +${stat.insertions} −${stat.deletions}`;
}

/** Tiempo transcurrido como "hace 3 min". */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} días`;
}

/**
 * Alinea filas en columnas. Devuelve una línea por fila, sin colores (así
 * el ancho se calcula bien; los colores se aplican después a la línea entera).
 */
export function formatTable(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("   ")
      .trimEnd(),
  );
}
