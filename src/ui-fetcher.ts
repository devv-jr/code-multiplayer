// Bucle de fetch del panel: cada N segundos trae los wips del remoto,
// reconstruye el estado y avisa a quien esté suscrito (las conexiones SSE).

import type { Config } from "./config.js";
import { type ActivityEvent, diffStates } from "./core/events.js";
import { buildState, type State } from "./core/state.js";
import { shortError, sleep } from "./daemon.js";
import { fetchWipRefs, GitError } from "./git.js";

/** Esperas tras fetch fallidos seguidos: 10 s → 30 s → 60 s. */
const BACKOFF_MS = [10_000, 30_000, 60_000];

export type FetcherMessage =
  | { type: "state"; state: State }
  | { type: "activity"; events: ActivityEvent[] };

export interface Fetcher {
  /** Último estado construido, o null antes del primer ciclo. */
  getState(): State | null;
  /** Recibe cada estado nuevo y cada lote de eventos. Devuelve cómo desuscribirse. */
  subscribe(listener: (message: FetcherMessage) => void): () => void;
  /** Un ciclo: fetch + reconstruir + avisar. Devuelve si el fetch salió bien. */
  refresh(): Promise<boolean>;
  /** Repite ciclos hasta que se aborte la señal. */
  run(signal: AbortSignal): Promise<void>;
}

export interface FetcherOptions {
  intervalMs: number;
  /** Solo para pruebas: esperas de reintento más cortas. */
  backoffMs?: readonly number[];
}

/**
 * ¿El fetch falló porque otro git estaba actualizando las mismas refs?
 * Pasa si corres `mp who` mientras el panel hace fetch. No es un problema:
 * el siguiente ciclo lo resuelve, así que no se muestra como error.
 */
export function isRefLockError(stderr: string): boolean {
  return /cannot lock ref|unable to lock|unable to update local ref|\.lock'?: File exists/i.test(
    stderr,
  );
}

export function createFetcher(config: Config, options: FetcherOptions): Fetcher {
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const intervalSec = Math.round(options.intervalMs / 1000);
  const listeners = new Set<(message: FetcherMessage) => void>();

  let state: State | null = null;
  let fetchedAt = ""; // vacío hasta el primer fetch correcto
  let failures = 0;

  /** Dos estados son "iguales" si solo cambia la hora del fetch. */
  const fingerprint = (s: State) => JSON.stringify({ ...s, fetchedAt: "" });

  const emit = (message: FetcherMessage) => {
    for (const listener of listeners) listener(message);
  };

  async function refresh(): Promise<boolean> {
    let ok = true;
    let error: string | undefined;

    try {
      await fetchWipRefs(config.repoRoot, config.remote);
      fetchedAt = new Date().toISOString();
    } catch (e) {
      if (e instanceof GitError && isRefLockError(e.stderr)) {
        // Choque con otro git: se reintenta en el siguiente ciclo, sin ruido.
        ok = state?.fetch.ok ?? true;
        error = state?.fetch.error;
      } else {
        ok = false;
        error = shortError(e);
      }
    }

    // El estado se reconstruye aunque el fetch falle: lo local (mi propio
    // wip, mi daemon) puede haber cambiado, y lo viejo se sigue mostrando.
    let next: State;
    try {
      next = await buildState(config, {
        ok,
        intervalSec,
        fetchedAt,
        ...(error !== undefined ? { error } : {}),
      });
    } catch (e) {
      if (!state) throw e; // sin ningún estado previo no hay nada que mostrar
      next = { ...state, fetch: { ok: false, error: shortError(e), intervalSec } };
      ok = false;
    }

    const prev = state;
    state = next;
    if (!prev || fingerprint(prev) !== fingerprint(next)) {
      emit({ type: "state", state: next });
    }
    // diffStates no da eventos sin estado previo (la carga inicial).
    const events = diffStates(prev, next);
    if (events.length > 0) emit({ type: "activity", events });

    return ok;
  }

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let wait = options.intervalMs;
      const ok = await refresh().catch(() => false);
      if (ok) {
        failures = 0;
      } else {
        failures += 1;
        const step = backoff[Math.min(failures, backoff.length) - 1] ?? options.intervalMs;
        wait = Math.max(options.intervalMs, step);
      }
      await sleep(wait, signal);
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    run,
  };
}
