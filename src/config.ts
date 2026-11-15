// Configuración de mp. Se guarda en la config local del repo (.git/config)
// para no agregar archivos al proyecto:
//   mp.user   → nombre del miembro (ej. "bruno")
//   mp.remote → remoto a usar (por defecto "origin")

import {
  ensureGit,
  fetchWipRefs,
  getLocalConfig,
  getRepoRoot,
  hasRemote,
  setLocalConfig,
} from "./git.js";

export const DEFAULT_REMOTE = "origin";

/** Solo minúsculas, números, guion y guion bajo; de 2 a 20 caracteres. */
export function isValidUser(user: string): boolean {
  return /^[a-z0-9_-]{2,20}$/.test(user);
}

export interface Config {
  repoRoot: string;
  user: string;
  remote: string;
}

export interface InitOptions {
  /** Usuario dado con --user. Si falta, se pregunta con `askUser`. */
  user?: string;
  /** Remoto dado con --remote. Si falta, el guardado o "origin". */
  remote?: string;
}

/**
 * Configura mp en el repo: valida todo primero y guarda al final, así un
 * init que falla no deja nada a medias.
 *
 * `askUser` pregunta el nombre por terminal (recibe el nombre ya guardado,
 * si hay, como sugerencia). Es undefined cuando no hay terminal interactiva.
 */
export async function initConfig(
  cwd: string,
  options: InitOptions = {},
  askUser?: (saved: string | null) => Promise<string>,
): Promise<Config> {
  await ensureGit();
  const repoRoot = await getRepoRoot(cwd);

  const remote =
    options.remote ?? (await getLocalConfig(repoRoot, "mp.remote")) ?? DEFAULT_REMOTE;
  if (!(await hasRemote(repoRoot, remote))) {
    throw new Error(
      `El repo no tiene el remoto "${remote}". Agrégalo con: git remote add ${remote} <url>\n  (o indica otro con: mp init --remote <nombre>)`,
    );
  }

  let user = options.user;
  if (user === undefined) {
    if (!askUser) {
      throw new Error("Falta tu nombre de usuario. Indícalo así: mp init --user <nombre>");
    }
    user = await askUser(await getLocalConfig(repoRoot, "mp.user"));
  }
  user = user.trim();
  if (!isValidUser(user)) {
    throw new Error(
      `Usuario inválido: "${user}". Usa solo minúsculas, números, "-" y "_" (de 2 a 20 caracteres). Ejemplo: bruno`,
    );
  }

  // Comprueba el acceso al remoto (red y credenciales) trayendo los wips.
  await fetchWipRefs(repoRoot, remote);

  await setLocalConfig(repoRoot, "mp.user", user);
  await setLocalConfig(repoRoot, "mp.remote", remote);
  return { repoRoot, user, remote };
}

/** Carga la config del repo actual. Lanza errores claros si falta algo. */
export async function loadConfig(cwd: string): Promise<Config> {
  await ensureGit();
  const repoRoot = await getRepoRoot(cwd);

  const user = await getLocalConfig(repoRoot, "mp.user");
  if (!user) {
    throw new Error("mp no está configurado en este repo. Corre primero: mp init");
  }
  if (!isValidUser(user)) {
    throw new Error(`El usuario guardado ("${user}") no es válido. Corre de nuevo: mp init`);
  }

  const remote = (await getLocalConfig(repoRoot, "mp.remote")) ?? DEFAULT_REMOTE;
  if (!(await hasRemote(repoRoot, remote))) {
    throw new Error(
      `El repo no tiene el remoto "${remote}". Agrégalo (git remote add ${remote} <url>) o corre: mp init`,
    );
  }

  return { repoRoot, user, remote };
}
