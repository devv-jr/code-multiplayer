// Lector de diffs unificados (el formato de `git diff`) de UN archivo.
// Función pura: convierte el texto en datos listos para dibujar.

export interface DiffLine {
  /** add: línea agregada; del: borrada; context: sin cambio; note: aviso de git. */
  kind: "add" | "del" | "context" | "note";
  text: string;
  /** Número de línea en la versión anterior (null en las agregadas). */
  oldLine: number | null;
  /** Número de línea en la versión nueva (null en las borradas). */
  newLine: number | null;
}

export interface Hunk {
  /** La cabecera completa: "@@ -1,4 +1,5 @@ function x()". */
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  /** Solo en renombres. */
  renamedFrom?: string;
  renamedTo?: string;
  isNew: boolean;
  isDeleted: boolean;
  /** git no muestra el contenido de los binarios. */
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(text: string): ParsedDiff {
  const diff: ParsedDiff = { isNew: false, isDeleted: false, binary: false, hunks: [] };
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split("\n")) {
    // Los archivos con finales CRLF traen un "\r" al final de cada línea.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = { header: line, lines: [] };
      diff.hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }

    // Antes del primer "@@" vienen las cabeceras del archivo.
    if (!hunk) {
      if (line.startsWith("rename from ")) diff.renamedFrom = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) diff.renamedTo = line.slice("rename to ".length);
      else if (line.startsWith("new file mode")) diff.isNew = true;
      else if (line.startsWith("deleted file mode")) diff.isDeleted = true;
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") diff.binary = true;
      continue;
    }

    // Dentro de un hunk, el primer carácter dice qué es cada línea.
    const mark = line[0];
    const content = line.slice(1);
    if (mark === "+") {
      hunk.lines.push({ kind: "add", text: content, oldLine: null, newLine: newLine++ });
    } else if (mark === "-") {
      hunk.lines.push({ kind: "del", text: content, oldLine: oldLine++, newLine: null });
    } else if (mark === " ") {
      hunk.lines.push({ kind: "context", text: content, oldLine: oldLine++, newLine: newLine++ });
    } else if (mark === "\\") {
      // "\ No newline at end of file": se refiere a la línea anterior.
      hunk.lines.push({
        kind: "note",
        text: "Sin salto de línea al final del archivo",
        oldLine: null,
        newLine: null,
      });
    }
    // Una línea vacía es el final del texto (las líneas vacías del archivo
    // llegan como " "), y cualquier otra cosa se ignora.
  }

  return diff;
}
