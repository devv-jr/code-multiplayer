// mp up: el daemon (mp start) y el panel (mp ui) juntos, en un solo proceso.
// No duplica nada: usa runDaemon, createFetcher y startUiServer tal cual.

import type { Config } from "./config.js";
import { type DaemonStatus, isDaemonRunning, LockError, runDaemon } from "./daemon.js";
import { getGitDir, getHead } from "./git.js";
import { NoCommitsError } from "./snapshot.js";
import { createFetcher } from "./ui-fetcher.js";
import { startUiServer } from "./ui-server.js";

export interface UpOptions {
  /** Puerto del panel. Con 0 el sistema elige uno libre (para pruebas). */
  port: number;
  /** Cada cuánto sube el daemon una instantánea. */
  daemonIntervalMs: number;
  /** Cada cuánto trae el panel el trabajo de los demás. */
  panelIntervalMs: number;
  allowSecrets?: boolean;
  /** Dónde escribir las líneas de estado. Por defecto, la consola. */
  log?: (line: string) => void;
}

export interface UpSession {
  /** Dirección del panel. */
  url: string;
  port: number;
  /** false si ya había un daemon en este repo y solo se levantó el panel. */
  daemonStarted: boolean;
  /**
   * Termina cuando todo se detuvo. Falla si el daemon se cae por un error
   * que no puede reintentar (para entonces el panel ya está cerrado).
   */
  done: Promise<void>;
  /** Apagado ordenado: daemon, bucle del panel y servidor. Se puede llamar varias veces. */
  stop(): Promise<void>;
}

export async function startUp(config: Config, options: UpOptions): Promise<UpSession> {
  const log = options.log ?? ((line: string) => console.log(line));
  // Sin commits el daemon no puede trabajar: mejor decirlo antes de abrir nada.
  if (!(await getHead(config.repoRoot))) throw new NoCommitsError();
  const controller = new AbortController();
  const status: DaemonStatus = { uploadPausedFiles: [] };

  const fetcher = createFetcher(config, {
    intervalMs: options.panelIntervalMs,
    daemonStatus: status,
  });

  // Si ya hay un daemon en este repo (otra terminal con mp start o mp up),
  // no se arranca un segundo: subirían dos veces lo mismo.
  let daemonStarted = !(await isDaemonRunning(await getGitDir(config.repoRoot)));
  let daemon: Promise<void> = Promise.resolve();

  if (daemonStarted) {
    daemon = runDaemon({
      ...config,
      intervalMs: options.daemonIntervalMs,
      signal: controller.signal,
      allowSecrets: options.allowSecrets,
      status,
      log,
      // Tras cada subida se refresca el panel, para verme sin esperar al
      // siguiente ciclo.
      onUpload: () => void fetcher.refresh().catch(() => {}),
    }).catch((error: unknown) => {
      // Otro daemon tomó el lock justo entre la comprobación y el arranque:
      // equivale a "ya había uno".
      if (error instanceof LockError) {
        daemonStarted = false;
        return;
      }
      throw error;
    });
  }

  // Se anota de inmediato cómo termina el daemon, para que un error suyo
  // nunca quede "en el aire" mientras arranca lo demás.
  let daemonError: unknown;
  const daemonEnded = daemon.then(
    () => {},
    (error: unknown) => {
      daemonError = error ?? new Error("El daemon se detuvo por un error desconocido");
    },
  );

  await fetcher.refresh(); // primer estado antes de aceptar conexiones
  // Si el daemon ya falló (por ejemplo, el repo no tiene commits), no tiene
  // sentido abrir el panel: se reporta el error tal cual.
  if (daemonError !== undefined) {
    controller.abort();
    throw daemonError;
  }

  const server = await startUiServer({ config, fetcher, port: options.port });
  const panelLoop = fetcher.run(controller.signal);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      controller.abort(); // el daemon termina su ciclo y suelta el lock
      await daemonEnded;
      await panelLoop.catch(() => {});
      await server.close();
    })();
    return stopping;
  };

  // `done` termina cuando todo se detuvo: por stop() (bien) o porque el
  // daemon se cayó solo (falla con ese error, con el panel ya cerrado).
  const done = Promise.race([daemonEnded, waitForAbort(controller.signal)]).then(async () => {
    if (daemonError === undefined && !controller.signal.aborted) {
      // El daemon terminó sin error y sin que nadie lo pidiera (no debería
      // pasar); el panel sigue hasta que llamen a stop().
      await waitForAbort(controller.signal);
    }
    await stop();
    if (daemonError !== undefined) throw daemonError;
  });

  return { url: server.url, port: server.port, daemonStarted, done, stop };
}

/** Espera hasta que se aborte la señal (cuando solo corre el panel). */
function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
