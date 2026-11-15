// Enlace para abrir un archivo local en VS Code. Función pura.

/**
 * Arma `vscode://file/<ruta absoluta>` con la raíz del repo y la ruta del
 * archivo (que viene con "/").
 *
 *   Windows: C:\Users\bruno\repo + src/a.ts → vscode://file/C:/Users/bruno/repo/src/a.ts
 *   macOS:   /Users/yered/repo   + src/a.ts → vscode://file/Users/yered/repo/src/a.ts
 *
 * Cada tramo se codifica (espacios, tildes, #, ?) para que la URL sea válida.
 */
export function vscodeUrl(root: string, path: string): string {
  const segments = `${root}/${path}`
    .replace(/\\/g, "/") // Windows usa "\"; la URL necesita "/"
    .split("/")
    .filter((segment) => segment !== "");

  const encoded = segments.map((segment, index) =>
    // La letra de unidad ("C:") va tal cual: VS Code no la acepta como "C%3A".
    index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment),
  );
  return `vscode://file/${encoded.join("/")}`;
}
