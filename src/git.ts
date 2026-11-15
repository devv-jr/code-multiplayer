// Wrapper de git: todas las llamadas a git del proyecto pasan por aquí.
//
// Usamos execFile con los argumentos en un array (nunca un string para un
// shell). Así no hay problemas de comillas ni de seguridad, y funciona igual
// en Windows y macOS.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Versión mínima de git soportada: [mayor, menor]. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 30];

/** Error de git con el detalle necesario para dar mensajes claros. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitOptions {
  /** Carpeta donde se ejecuta git. Por defecto, la carpeta actual. */
  cwd?: string;
  /**
   * Variables de entorno extra (se suman a las del proceso).
   * Clave para las instantáneas: con GIT_INDEX_FILE git usa un índice
   * temporal en vez del índice real del usuario.
   */
  env?: Record<string, string>;
  /** Cancela git si tarda más que esto (para operaciones de red). */
  timeoutMs?: number;
}

export interface GitResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Ejecuta git y devuelve el resultado SIN lanzar error si git termina con
 * código distinto de 0 (útil cuando un fallo es una respuesta válida, por
 * ejemplo "esa config no existe"). Solo lanza si git no se pudo ejecutar.
 */
export function runGit(
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        env: { ...process.env, ...options.env },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024, // los diffs pueden ser grandes
        windowsHide: true, // no abrir ventanas de consola en Windows
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, exitCode: 0, stdout, stderr });
          return;
        }

        // Si code es un número, git corrió y terminó con error.
        if (typeof error.code === "number") {
          resolve({ ok: false, exitCode: error.code, stdout, stderr });
          return;
        }

        // Node mató a git porque se pasó de timeoutMs.
        if (error.killed && options.timeoutMs) {
          const seconds = Math.round(options.timeoutMs / 1000);
          resolve({
            ok: false,
            exitCode: -1,
            stdout,
            stderr: `git tardó más de ${seconds} s y fue cancelado (¿problemas de red?)`,
          });
          return;
        }

        // Si no, git ni siquiera arrancó. ENOENT puede ser "no existe git"
        // o "no existe la carpeta cwd"; distinguimos para dar un mensaje útil.
        if (error.code === "ENOENT" && !existsSync(cwd)) {
          reject(new GitError(`La carpeta no existe: ${cwd}`, args, null, ""));
        } else if (error.code === "ENOENT") {
          reject(
            new GitError(
              "No se encontró git. Instala git (2.30 o superior) y verifica que esté en el PATH.",
              args,
              null,
              "",
            ),
          );
        } else {
          reject(
            new GitError(
              `No se pudo ejecutar git: ${error.message}`,
              args,
              null,
              stderr,
            ),
          );
        }
      },
    );
  });
}

/**
 * Ejecuta git y devuelve su salida (sin el salto de línea final).
 * Lanza GitError si git termina con error.
 */
export async function git(
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  const result = await runGit(args, options);
  if (!result.ok) {
    const detail = result.stderr.trim() || `código de salida ${result.exitCode}`;
    throw new GitError(
      `git ${args.join(" ")} falló: ${detail}`,
      args,
      result.exitCode,
      result.stderr,
    );
  }
  return result.stdout.trimEnd();
}

/** Extrae [mayor, menor] de un texto como "git version 2.56.0.windows.2". */
export function parseGitVersion(text: string): [number, number] | null {
  const match = /(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

/** Verifica que git esté instalado y sea ≥ 2.30. Devuelve la versión. */
export async function ensureGit(): Promise<string> {
  const output = await git(["--version"]);
  const version = parseGitVersion(output);
  const [minMajor, minMinor] = MIN_GIT_VERSION;

  if (!version) {
    throw new Error(`No se pudo leer la versión de git: "${output}"`);
  }
  const [major, minor] = version;
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    throw new Error(
      `Tu git es ${major}.${minor} y mp necesita ${minMajor}.${minMinor} o superior. Actualiza git.`,
    );
  }
  return `${major}.${minor}`;
}

/** Carpeta raíz del repo (donde está el working tree). */
export async function getRepoRoot(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "--show-toplevel"], { cwd });
  if (!result.ok) {
    throw new GitError(
      "Esta carpeta no está dentro de un repositorio git.",
      ["rev-parse", "--show-toplevel"],
      result.exitCode,
      result.stderr,
    );
  }
  // git devuelve rutas con "/" también en Windows; path.resolve las normaliza.
  return path.resolve(result.stdout.trim());
}

/** Ruta absoluta de la carpeta .git (ahí vive el lock del daemon). */
export async function getGitDir(cwd: string): Promise<string> {
  const output = await git(["rev-parse", "--absolute-git-dir"], { cwd });
  return path.resolve(output);
}

/**
 * Hash del commit actual (HEAD), o null si el repo todavía no tiene commits.
 * No usamos ningún shell, así que "^{commit}" llega a git tal cual.
 */
export async function getHead(cwd: string): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    { cwd },
  );
  return result.ok ? result.stdout.trim() : null;
}

/** Nombre de la rama actual, o null si HEAD está "detached" (sin rama). */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--short", "--quiet", "HEAD"], { cwd });
  return result.ok ? result.stdout.trim() : null;
}

/** Lee un valor de la config local del repo, o null si no existe. */
export async function getLocalConfig(
  cwd: string,
  key: string,
): Promise<string | null> {
  const result = await runGit(["config", "--local", "--get", key], { cwd });
  return result.ok ? result.stdout.trim() : null;
}

/** Guarda un valor en la config local del repo (.git/config). */
export async function setLocalConfig(
  cwd: string,
  key: string,
  value: string,
): Promise<void> {
  await git(["config", "--local", key, value], { cwd });
}

/** Indica si existe un remoto con ese nombre (por ejemplo "origin"). */
export async function hasRemote(cwd: string, name: string): Promise<boolean> {
  const result = await runGit(["remote", "get-url", name], { cwd });
  return result.ok;
}

// Las operaciones de red no deben quedarse colgadas: sin preguntar
// credenciales por terminal y con un tiempo máximo.
const NETWORK_ENV = { GIT_TERMINAL_PROMPT: "0" };
const NETWORK_TIMEOUT_MS = 60_000;

/**
 * Sube un commit a una ref del remoto (por ejemplo refs/wip/bruno).
 * --force: la ref es solo nuestra y cada instantánea reemplaza a la anterior.
 * --no-verify: no ejecutar el hook pre-push del usuario en cada ciclo.
 */
export async function pushCommitToRef(
  cwd: string,
  remote: string,
  commit: string,
  ref: string,
): Promise<void> {
  await git(["push", "--force", "--no-verify", "--quiet", remote, `${commit}:${ref}`], {
    cwd,
    env: NETWORK_ENV,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Cuenta archivos y líneas cambiadas entre dos commits.
 * Usamos --numstat (y no --shortstat) porque su salida son solo números:
 * no depende del idioma en que esté configurado git.
 */
export async function getDiffStat(cwd: string, from: string, to: string): Promise<DiffStat> {
  const output = await git(["diff", "--numstat", from, to], { cwd });
  const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };

  for (const line of output.split("\n")) {
    if (line === "") continue;
    const [added = "", removed = ""] = line.split("\t");
    stat.files += 1;
    // Los archivos binarios aparecen como "-": cuentan como archivo, sin líneas.
    stat.insertions += Number(added) || 0;
    stat.deletions += Number(removed) || 0;
  }
  return stat;
}

/**
 * Trae del remoto todas las refs wip (el trabajo de cada miembro).
 * El "+" permite sobrescribir las locales: cada instantánea reemplaza a la
 * anterior, no es un historial que avance.
 */
export async function fetchWipRefs(cwd: string, remote: string): Promise<void> {
  const result = await runGit(
    ["fetch", "--quiet", "--no-tags", remote, "+refs/wip/*:refs/wip/*"],
    { cwd, env: NETWORK_ENV, timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (!result.ok) {
    const detail = result.stderr.trim().split(/\r?\n/)[0] ?? "";
    throw new GitError(
      `No se pudo traer el trabajo del remoto "${remote}". Revisa tu conexión y tus credenciales de git.\n  Detalle: ${detail}`,
      ["fetch", remote],
      result.exitCode,
      result.stderr,
    );
  }
}

/** Nombres de las refs locales que empiezan con un prefijo (ej. "refs/wip"). */
export async function listRefs(cwd: string, prefix: string): Promise<string[]> {
  const output = await git(["for-each-ref", "--format=%(refname)", prefix], { cwd });
  return output === "" ? [] : output.split("\n");
}

/** Ancestro común más reciente de dos commits, o null si no tienen. */
export async function getMergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  const result = await runGit(["merge-base", a, b], { cwd });
  return result.ok ? result.stdout.trim() : null;
}

/**
 * Ejecuta git conectado directamente a la terminal del usuario. Así git
 * decide solo si usa colores y su pager (less) cuando la salida es larga,
 * igual que si el usuario lo hubiera escrito a mano.
 */
export function runGitInTerminal(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, stdio: "inherit" });
    child.on("error", (error) => {
      reject(new GitError(`No se pudo ejecutar git: ${error.message}`, args, null, ""));
    });
    // No miramos el código de salida: salir del pager antes de tiempo
    // (con "q") puede dar un código distinto de 0 y no es un error.
    child.on("close", () => resolve());
  });
}

/**
 * Opciones para diffs que lee un programa: sin colores y sin las herramientas
 * de diff externas que el usuario pueda tener en su config.
 */
export const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv"] as const;

export interface FileChange {
  /** Ruta con "/" (git la da así también en Windows). En renombres, la nueva. */
  path: string;
  /** A: nuevo, M: modificado, D: borrado, R: renombrado. */
  status: "A" | "M" | "D" | "R";
  /** Solo en renombres: la ruta anterior. */
  oldPath?: string;
  /** Líneas agregadas y borradas; null si el archivo es binario. */
  added: number | null;
  deleted: number | null;
  binary?: boolean;
}

/**
 * Archivos que cambiaron entre dos commits, con sus líneas.
 *
 * Usamos -z: git separa los campos con el carácter NUL y entrega los nombres
 * tal cual. Sin -z, los nombres con espacios, tildes o unicode llegan entre
 * comillas y escapados según la config (core.quotepath) del usuario.
 * -M detecta renombres.
 */
export async function getChangedFiles(
  cwd: string,
  from: string,
  to: string,
): Promise<FileChange[]> {
  const base = ["diff", ...PLAIN_DIFF, "-z", "-M"];
  const nameStatus = await runGit([...base, "--name-status", from, to], { cwd });
  const numstat = await runGit([...base, "--numstat", from, to], { cwd });
  for (const result of [nameStatus, numstat]) {
    if (!result.ok) {
      throw new GitError(
        `git diff falló: ${result.stderr.trim()}`,
        base,
        result.exitCode,
        result.stderr,
      );
    }
  }

  // --numstat -z: "agregadas<TAB>borradas<TAB>ruta<NUL>". En renombres la ruta
  // va vacía y siguen dos campos más: "ruta vieja<NUL>ruta nueva<NUL>".
  const lines = new Map<string, { added: number | null; deleted: number | null }>();
  const stats = numstat.stdout.split("\0");
  for (let i = 0; i < stats.length; ) {
    const head = stats[i++] ?? "";
    if (head === "") break;
    const [added = "", deleted = "", ...rest] = head.split("\t");
    let file = rest.join("\t");
    if (file === "") {
      i++; // ruta vieja
      file = stats[i++] ?? "";
    }
    // Los binarios traen "-" en vez de números.
    const binary = added === "-" || deleted === "-";
    lines.set(file, {
      added: binary ? null : Number(added),
      deleted: binary ? null : Number(deleted),
    });
  }

  // --name-status -z: "letra<NUL>ruta<NUL>". En renombres:
  // "R100<NUL>ruta vieja<NUL>ruta nueva<NUL>" (el número es el % de parecido).
  const changes: FileChange[] = [];
  const names = nameStatus.stdout.split("\0");
  for (let i = 0; i < names.length; ) {
    const code = names[i++] ?? "";
    if (code === "") break;
    const letter = code[0];
    const oldPath = letter === "R" ? names[i++] : undefined;
    const file = names[i++] ?? "";
    const stat = lines.get(file) ?? { added: null, deleted: null };

    const change: FileChange = {
      path: file,
      // Cualquier otra letra (por ejemplo T, cambio de tipo) cuenta como modificado.
      status: letter === "A" || letter === "D" || letter === "R" ? letter : "M",
      added: stat.added,
      deleted: stat.deleted,
    };
    if (oldPath !== undefined) change.oldPath = oldPath;
    if (stat.added === null) change.binary = true;
    changes.push(change);
  }
  return changes;
}

/** ¿Existe ese commit en el repo local? */
export async function commitExists(cwd: string, commit: string): Promise<boolean> {
  const result = await runGit(["cat-file", "-e", `${commit}^{commit}`], { cwd });
  return result.ok;
}

/** Todos los archivos de un commit, con "/" como separador. */
export async function listFiles(cwd: string, commit: string): Promise<string[]> {
  const output = await git(["ls-tree", "-r", "-z", "--name-only", commit], { cwd });
  return output.split("\0").filter((file) => file !== "");
}
