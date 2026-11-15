// Iconos pequeños en SVG. Se dibujan igual en cualquier sistema, a diferencia
// de los símbolos Unicode, que dependen de las fuentes instaladas.

/** Icono de rama de git. */
export function BranchIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.8" />
      <circle cx="4" cy="12.5" r="1.8" />
      <circle cx="12" cy="5.5" r="1.8" />
      <path d="M4 5.3v5.4M12 7.3c0 2.6-3.4 2.2-8 3.4" />
    </svg>
  );
}

/** Icono de luna (jugador dormido). */
export function MoonIcon() {
  return (
    <svg className="icon icon-solid" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
      <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z" />
    </svg>
  );
}

/** Flecha de una carpeta (gira con CSS cuando está abierta). */
export function CaretIcon() {
  return (
    <svg className="icon caret" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** Icono de carpeta. */
export function FolderIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
      <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v5.9c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2Z" />
    </svg>
  );
}
