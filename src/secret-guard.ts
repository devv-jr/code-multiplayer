// Guardia de secretos: evita subir por accidente archivos con claves.
//
// mp sube en cada instantánea todo lo que no esté en .gitignore. Si alguien
// tiene un ".env" con contraseñas sin ignorar, llegaría al remoto. Esta
// guardia mira los nombres de los archivos que entrarían a la instantánea y
// detiene la subida si alguno parece un secreto.
//
// Las reglas (qué nombres cuentan) están en core/secret-rules.ts.

import { existsSync } from "node:fs";
import path from "node:path";
import { secretIgnoreLine } from "./core/secret-rules.js";
import { git, listFilesByStatus, PLAIN_DIFF } from "./git.js";

export { isSecretPath, secretIgnoreLine } from "./core/secret-rules.js";

export interface SecretFile {
  /** Ruta con "/". */
  path: string;
  /** Línea de .gitignore que lo taparía. */
  ignoreLine: string;
  /** true si git ya lo rastrea: ignorarlo no basta (ver secretsHelp). */
  tracked: boolean;
}

/**
 * Busca archivos sensibles entre los que entrarían a la instantánea:
 * los nuevos sin ignorar y los rastreados que tienen cambios.
 * No cuentan los ya ignorados ni los rastreados sin cambios (esos ya son
 * parte del repo).
 */
export async function findSecretFiles(repoRoot: string): Promise<SecretFile[]> {
  // -z (dentro de listFilesByStatus): nombres tal cual, con espacios y tildes.
  const untracked = await listFilesByStatus(repoRoot, ["--others", "--exclude-standard"]);
  const modified = await listFilesByStatus(repoRoot, ["--modified"]);

  const found = new Map<string, SecretFile>();
  const consider = (file: string, tracked: boolean) => {
    const ignoreLine = secretIgnoreLine(file);
    if (!ignoreLine) return;
    // "--modified" también lista los borrados; un archivo que ya no está en
    // disco no sube ningún contenido.
    if (!existsSync(path.join(repoRoot, ...file.split("/")))) return;
    found.set(file, { path: file, ignoreLine, tracked });
  };
  for (const file of untracked) consider(file, false);
  for (const file of modified) consider(file, true);

  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Busca archivos sensibles dentro de una instantánea ya creada: los que
 * agrega o modifica respecto a su commit base, que es justo lo que se subiría.
 *
 * Es la revisión que decide si se sube o no. Mirar solo la carpeta de trabajo
 * deja un hueco: un archivo creado después de mirar y antes de tomar la
 * instantánea entraría sin que nadie lo viera.
 */
export async function findSecretsInSnapshot(
  repoRoot: string,
  parent: string,
  commit: string,
): Promise<SecretFile[]> {
  // --diff-filter=d: sin los borrados (no suben contenido).
  // --no-renames: cada archivo con su propia ruta, sin emparejar renombres.
  const output = await git(
    ["diff", ...PLAIN_DIFF, "--name-status", "-z", "--no-renames", "--diff-filter=d", parent, commit],
    { cwd: repoRoot },
  );

  // Con -z llega "letra<NUL>ruta<NUL>" por cada archivo.
  const fields = output.split("\0");
  const found: SecretFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? "";
    const file = fields[i + 1] ?? "";
    const ignoreLine = secretIgnoreLine(file);
    // "A" es un archivo nuevo; cualquier otra letra ya estaba en el repo.
    if (ignoreLine) found.push({ path: file, ignoreLine, tracked: status !== "A" });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Explica cómo arreglarlo, sin comandos propios de un shell (PowerShell y
 * zsh escriben distinto): solo qué líneas poner en .gitignore.
 */
export function secretsHelp(files: readonly SecretFile[]): string {
  const lines: string[] = [];
  const untracked = files.filter((file) => !file.tracked);
  const tracked = files.filter((file) => file.tracked);

  if (untracked.length > 0) {
    const ignoreLines = [...new Set(untracked.map((file) => file.ignoreLine))];
    lines.push(
      "Cómo arreglarlo: abre el archivo .gitignore de este repo (si no existe, créalo en la",
      "carpeta principal) y agrega estas líneas, una por renglón:",
      "",
      ...ignoreLines.map((line) => `    ${line}`),
    );
  }
  if (tracked.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "Estos ya están guardados en el repo y tienen cambios sin commit:",
      "",
      ...tracked.map((file) => `    ${file.path}`),
      "",
      "Agregarlos a .gitignore no basta, porque git ya los sigue. Si de verdad tienen claves,",
      "pídele ayuda a tu compañero para sacarlos del repo. Si no son secretos, usa --allow-secrets.",
    );
  }
  return lines.join("\n");
}

/** Hay archivos sensibles sin ignorar: mp se niega a arrancar. */
export class SecretsError extends Error {
  constructor(readonly files: readonly SecretFile[]) {
    super(
      [
        "No arranco: encontré archivos que parecen tener secretos (claves o contraseñas).",
        "mp sube todo lo que no esté en .gitignore, así que estos archivos llegarían al remoto:",
        "",
        ...files.map((file) => `    ${file.path}`),
        "",
        secretsHelp(files),
        "",
        "Si estás seguro de que no son secretos, puedes saltarte esta revisión con --allow-secrets.",
      ].join("\n"),
    );
    this.name = "SecretsError";
  }
}
