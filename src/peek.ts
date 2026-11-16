// mp peek <usuario>: el diff del trabajo de otro miembro contra tu base.

import type { Config } from "./config.js";
import { fetchWipRefs, runGit } from "./git.js";
import type { Wip } from "./snapshot.js";
import { getWipBase, listWips } from "./who.js";

export interface PeekOptions {
  /** Solo el resumen por archivo (git diff --stat). */
  stat?: boolean;
  /** Limitar el diff a un archivo o carpeta. */
  file?: string;
}

export interface Peek {
  wip: Wip;
  /** Commit contra el que se compara (ver getWipBase en who.ts). */
  base: string;
  /** false si no hay nada que mostrar. */
  hasChanges: boolean;
  /** Argumentos de "git diff" para mostrar el resultado. */
  diffArgs: string[];
}

/** Forma de la salida de `mp peek <usuario> --json`. */
export interface PeekJson {
  user: string;
  branch: string | null;
  /** Fecha ISO de su última instantánea. */
  lastWipAt: string;
  /** Commit contra el que se compara. */
  base: string;
  /** Commit de la instantánea. */
  commit: string;
  hasChanges: boolean;
  /** Texto del diff (o del resumen, con --stat), sin colores. */
  diff: string;
}

/** Ejecuta el diff ya preparado y lo devuelve como datos (para `--json`). */
export async function peekToJson(user: string, peek: Peek, cwd: string): Promise<PeekJson> {
  const [command = "diff", ...rest] = peek.diffArgs;
  // Sin colores ni herramientas de diff externas: texto plano y estable.
  const result = await runGit(
    [command, "--no-color", "--no-ext-diff", "--no-textconv", ...rest],
    { cwd },
  );
  return {
    user,
    branch: peek.wip.branch,
    lastWipAt: peek.wip.date.toISOString(),
    base: peek.base,
    commit: peek.wip.commit,
    hasChanges: peek.hasChanges,
    diff: result.stdout,
  };
}

/**
 * Trae los wips y prepara el diff de un usuario. No imprime nada: devuelve
 * los argumentos de git diff para que la CLI lo muestre en la terminal.
 *
 * `cwd` es la carpeta desde la que se correrá el diff: --file se interpreta
 * relativo a ella, como en cualquier comando de git.
 */
export async function preparePeek(
  config: Config,
  user: string,
  options: PeekOptions = {},
  cwd: string = config.repoRoot,
): Promise<Peek> {
  const { repoRoot, remote } = config;
  await fetchWipRefs(repoRoot, remote);

  // Buscamos al usuario en la lista (en vez de armar la ref con lo que
  // escribió) para poder decir quiénes sí están disponibles.
  const wips = await listWips(repoRoot);
  const found = wips.find((entry) => entry.user === user);
  if (!found) {
    const available = wips.map((entry) => entry.user).join(", ");
    throw new Error(
      available === ""
        ? `No hay trabajo subido de "${user}". Nadie ha subido trabajo todavía: cada quien debe correr mp start.`
        : `No hay trabajo subido de "${user}". Usuarios disponibles: ${available}\n  Qué hacer: revisa cómo está escrito el nombre; para ver quién está, corre  mp who`,
    );
  }

  const base = await getWipBase(repoRoot, found.wip);
  const range = [base, found.wip.commit];
  // "--" separa los commits de las rutas, por si un archivo se llama como una ref.
  const paths = options.file ? ["--", options.file] : [];

  // --quiet no imprime nada: termina con 0 si no hay diferencias.
  const same = await runGit(["diff", "--quiet", ...range, ...paths], { cwd });

  return {
    wip: found.wip,
    base,
    hasChanges: !same.ok,
    diffArgs: ["diff", ...(options.stat ? ["--stat"] : []), ...range, ...paths],
  };
}
