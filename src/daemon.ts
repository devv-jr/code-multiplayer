// El daemon: un loop que cada N segundos crea la instantánea y, si hay algo
// nuevo, la sube a refs/wip/<usuario> en el remoto.

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { clock, formatStat } from "./format.js";
import { getDiffStat, getGitDir, GitError, pushCommitToRef } from "./git.js";
import { createSnapshot, NoCommitsError } from "./snapshot.js";

// ───────────────────────────── Lock ─────────────────────────────

/** Ya hay otro daemon corriendo en este repo. */
export class LockError extends Error {
  constructor(readonly pid: number) {
    super(
      `Ya hay un daemon de mp corriendo en este repo (PID ${pid}). Detenlo con Ctrl+C antes de iniciar otro.`,
    );
    this.name = "LockError";
  }
}

/** ¿Existe un proceso con ese PID? Funciona igual en Windows y macOS. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // la señal 0 no mata: solo comprueba que exista
    return true;
  } catch (error) {
    // EPERM: existe pero es de otro usuario. ESRCH: no existe.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Toma el lock (.git/mp.lock, con nuestro PID adentro) y devuelve una función
 * para soltarlo. Si el lock es de un proceso que ya no existe, lo reemplaza.
 */
export async function acquireLock(gitDir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(gitDir, "mp.lock");

  // Dos intentos: el segundo es para después de borrar un lock abandonado.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" falla si el archivo ya existe: así crear el lock es atómico.
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const pid = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      throw new LockError(pid);
    }
    await rm(lockPath, { force: true }); // lock abandonado (o ilegible)
  }

  throw new Error(`No se pudo tomar el lock en ${lockPath}. Intenta de nuevo.`);
}

/** ¿Hay un daemon corriendo en este repo? (lock con un PID que sigue vivo) */
export async function isDaemonRunning(gitDir: string): Promise<boolean> {
  const content = await readFile(path.join(gitDir, "mp.lock"), "utf8").catch(() => "");
  const pid = Number(content.trim());
  return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
}

// ──────────────────────────── Daemon ────────────────────────────

/** Esperas tras errores seguidos: 15 s → 30 s → 60 s (y se queda en 60 s). */
const BACKOFF_MS = [15_000, 30_000, 60_000];

export interface DaemonOptions {
  repoRoot: string;
  user: string;
  remote: string;
  intervalMs: number;
  /** Al abortar esta señal (Ctrl+C), el daemon termina limpio. */
  signal: AbortSignal;
  /** Dónde escribir las líneas de estado. Por defecto, la consola. */
  log?: (line: string) => void;
  /** Solo para pruebas: esperas de reintento más cortas. */
  backoffMs?: readonly number[];
}

/** Espera `ms` milisegundos, o menos si se aborta la señal. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/** Primera línea útil de un error, para un aviso de una sola línea. */
export function shortError(error: unknown): string {
  const text =
    error instanceof GitError && error.stderr.trim() !== ""
      ? error.stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.trim().split(/\r?\n/)[0] ?? "";
}

/**
 * Corre el loop hasta que se aborte la señal. Los errores de red o de push
 * no lo detienen: avisa y reintenta con esperas cada vez más largas.
 * Sí lanza si hay otro daemon corriendo o si el repo no tiene commits.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const { repoRoot, user, remote, intervalMs, signal } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const backoff = options.backoffMs ?? BACKOFF_MS;

  const releaseLock = await acquireLock(await getGitDir(repoRoot));

  // Último commit que sabemos que está en el remoto. Empieza en null para
  // que el primer ciclo siempre haga push (el remoto puede estar atrasado).
  let lastPushed: string | null = null;
  let failures = 0;

  try {
    while (!signal.aborted) {
      let wait = intervalMs;

      try {
        const snapshot = await createSnapshot(repoRoot, user);

        if (snapshot.commit === lastPushed) {
          log(pc.dim(`${clock()} · sin cambios`));
        } else {
          await pushCommitToRef(repoRoot, remote, snapshot.commit, snapshot.ref);
          lastPushed = snapshot.commit;
          const stat = await getDiffStat(repoRoot, snapshot.parent, snapshot.commit);
          log(`${clock()} ${pc.green("✓")} wip actualizado (${formatStat(stat)})`);
        }
        failures = 0;
      } catch (error) {
        // Ctrl+C también interrumpe al git que esté corriendo: no es un error.
        if (signal.aborted) break;
        // Sin commits no hay nada que reintentar.
        if (error instanceof NoCommitsError) throw error;

        failures += 1;
        const step = backoff[Math.min(failures, backoff.length) - 1] ?? intervalMs;
        wait = Math.max(intervalMs, step);
        const seconds = Math.round(wait / 1000);
        log(
          `${clock()} ${pc.yellow("!")} no se pudo actualizar el wip (reintento en ${seconds} s): ${shortError(error)}`,
        );
      }

      await sleep(wait, signal);
    }
  } finally {
    await releaseLock();
  }
}
