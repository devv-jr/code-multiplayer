// Instantánea ("WIP") del trabajo sin commit, SIN tocar nada del usuario.
//
// La idea: git guarda en ".git/index" la lista de archivos preparados para el
// próximo commit. Si hiciéramos "git add -A" normal, cambiaríamos ese índice y
// el usuario lo notaría. En cambio:
//
//   1. Copiamos el índice real a un archivo temporal.
//   2. Con la variable GIT_INDEX_FILE le decimos a git que use esa copia.
//   3. "git add -A" sobre la copia: registra todo el working tree
//      (modificados, nuevos y borrados), respetando .gitignore.
//   4. "git write-tree" convierte la copia en un objeto "árbol".
//   5. "git commit-tree" crea un commit con ese árbol y HEAD como padre,
//      pero sin mover ninguna rama (es un commit "suelto").
//   6. "git update-ref" apunta refs/wip/<usuario> a ese commit. Es una ref
//      fuera de refs/heads, así que no aparece como rama.
//
// El índice real, la rama actual y los archivos del usuario no cambian.

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCurrentBranch, getGitDir, getHead, git, runGit } from "./git.js";

/** El repo no tiene commits: no hay HEAD que usar como base. */
export class NoCommitsError extends Error {
  constructor() {
    super(
      "Este repo todavía no tiene commits. Haz un primer commit (git commit) y vuelve a intentar.",
    );
    this.name = "NoCommitsError";
  }
}

export interface Snapshot {
  /** Ref local donde queda la instantánea: refs/wip/<usuario>. */
  ref: string;
  /** Commit de la instantánea. */
  commit: string;
  /** Árbol (contenido completo del working tree). */
  tree: string;
  /** Commit base: el HEAD del usuario al momento de la instantánea. */
  parent: string;
  /** Rama en la que estaba el usuario, o null si no estaba en una rama. */
  branch: string | null;
  /** true si se creó un commit nuevo; false si nada cambió desde la anterior. */
  created: boolean;
}

/** Nombre de la ref donde vive el WIP de un usuario. */
export function wipRef(user: string): string {
  return `refs/wip/${user}`;
}

// Trailer del mensaje del commit donde guardamos la rama del usuario.
// (Del commit solo no se puede saber en qué rama estaba.)
const BRANCH_TRAILER = "Mp-Branch";

/** Datos de una instantánea ya guardada en una ref (propia o de otro miembro). */
export interface Wip {
  ref: string;
  commit: string;
  tree: string;
  /** Commit base: el HEAD que tenía su autor. */
  parent: string;
  /** Rama en la que estaba su autor, o null. */
  branch: string | null;
  /** Cuándo se creó la instantánea. */
  date: Date;
}

/** Lee la instantánea guardada en una ref local, o null si la ref no existe. */
export async function readWip(repoRoot: string, ref: string): Promise<Wip | null> {
  // %H commit, %T árbol, %P padre, %ct fecha (segundos Unix), y el trailer.
  const format = `%H%n%T%n%P%n%ct%n%(trailers:key=${BRANCH_TRAILER},valueonly)`;
  const result = await runGit(["log", "-1", `--format=${format}`, ref, "--"], {
    cwd: repoRoot,
  });
  if (!result.ok) return null; // la ref todavía no existe

  const [commit = "", tree = "", parent = "", seconds = "", branch = ""] =
    result.stdout.split("\n");
  if (!commit || !tree) return null;
  return {
    ref,
    commit,
    tree,
    parent,
    branch: branch.trim() || null,
    date: new Date(Number(seconds) * 1000),
  };
}

/**
 * Crea (si hace falta) la instantánea del working tree y la deja en la ref
 * local refs/wip/<usuario>. No hace push: eso es trabajo del daemon.
 *
 * Si el contenido, el commit base y la rama son iguales a los de la
 * instantánea anterior, no crea nada y devuelve la anterior con created=false.
 */
export async function createSnapshot(repoRoot: string, user: string): Promise<Snapshot> {
  const parent = await getHead(repoRoot);
  if (!parent) throw new NoCommitsError();

  const ref = wipRef(user);
  const branch = await getCurrentBranch(repoRoot);
  const tree = await writeWorkingTree(repoRoot);

  const previous = await readWip(repoRoot, ref);
  if (
    previous &&
    previous.tree === tree &&
    previous.parent === parent &&
    previous.branch === branch
  ) {
    return { ref, commit: previous.commit, tree, parent, branch, created: false };
  }

  const messages = ["-m", `mp wip ${user} ${new Date().toISOString()}`];
  if (branch) messages.push("-m", `${BRANCH_TRAILER}: ${branch}`);

  // Un commit necesita autor. Si el usuario no configuró user.name/user.email
  // en git, usamos su nombre de mp solo para este commit (no se guarda nada).
  const hasIdentity = (await runGit(["var", "GIT_COMMITTER_IDENT"], { cwd: repoRoot })).ok;
  const identity = hasIdentity
    ? []
    : ["-c", `user.name=${user}`, "-c", `user.email=${user}@mp.invalid`];

  // commit-tree crea el commit pero no lo conecta a ninguna rama.
  const commit = await git(
    [...identity, "commit-tree", tree, "-p", parent, ...messages],
    { cwd: repoRoot },
  );
  await git(["update-ref", ref, commit], { cwd: repoRoot });

  return { ref, commit, tree, parent, branch, created: true };
}

/**
 * Escribe un objeto "árbol" con el estado actual del working tree usando un
 * índice temporal. Devuelve el hash del árbol.
 */
async function writeWorkingTree(repoRoot: string): Promise<string> {
  const gitDir = await getGitDir(repoRoot);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mp-index-"));
  const tempIndex = path.join(tempDir, "index");

  try {
    // Partimos del índice real: trae los datos de caché de cada archivo, así
    // "git add -A" solo relee los que cambiaron (mucho más rápido), y se
    // comporta igual que el git del usuario con los finales de línea.
    try {
      await copyFile(path.join(gitDir, "index"), tempIndex);
    } catch (error) {
      // Sin índice real (repo recién creado) empezamos con uno vacío.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const env = { GIT_INDEX_FILE: tempIndex };
    await git(["add", "-A"], { cwd: repoRoot, env });
    return await git(["write-tree"], { cwd: repoRoot, env });
  } finally {
    // Limpiar siempre, también si git falló.
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
