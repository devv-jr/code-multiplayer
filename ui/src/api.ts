// Cliente de la API de `mp ui`: peticiones normales y la conexión SSE.
// El estado global es un solo hook (usePanel), sin librerías.

import { useEffect, useRef, useState } from "react";
import type { ActivityEvent, State, TreeFiles } from "../../src/core/types.js";

export type { ActivityEvent, ChangedFile, Player, State, TreeFiles } from "../../src/core/types.js";

/** Archivos de mi HEAD, para armar el mapa del proyecto. */
export async function getTree(): Promise<TreeFiles> {
  const res = await fetch("/api/tree");
  if (!res.ok) throw new Error(`No se pudo leer el árbol (${res.status})`);
  return (await res.json()) as TreeFiles;
}

export type DiffResult =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "binary" };

/** Diff de un archivo dentro de los cambios en curso de un usuario. */
export async function getDiff(user: string, file: string): Promise<DiffResult> {
  const query = new URLSearchParams({ user, file });
  const res = await fetch(`/api/diff?${query}`);
  if (!res.ok) throw new Error(`No se pudo leer el diff (${res.status})`);

  // Los binarios llegan como JSON ({ binary: true }); los demás, como texto.
  if (res.headers.get("Content-Type")?.includes("application/json")) {
    return { kind: "binary" };
  }
  return {
    kind: "text",
    text: await res.text(),
    truncated: res.headers.get("X-Truncated") === "1",
  };
}

export interface Panel {
  /** Último estado recibido; null mientras llega el primero. */
  state: State | null;
  /** Archivos de mi HEAD; null mientras cargan. */
  tree: TreeFiles | null;
  /** ¿Está viva la conexión con `mp ui`? */
  connected: boolean;
}

/**
 * Mantiene el estado del panel al día con SSE.
 * `onActivity` recibe cada lote de novedades (para avisos y notificaciones).
 */
export function usePanel(onActivity?: (events: ActivityEvent[]) => void): Panel {
  const [state, setState] = useState<State | null>(null);
  const [tree, setTree] = useState<TreeFiles | null>(null);
  const [connected, setConnected] = useState(false);

  // En un ref para que cambiar el callback no reabra la conexión.
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;

  useEffect(() => {
    const source = new EventSource("/api/events");

    source.onopen = () => setConnected(true);
    // EventSource reintenta solo; aquí solo reflejamos que se cayó.
    source.onerror = () => setConnected(false);

    source.addEventListener("state", (event) => {
      setState(JSON.parse((event as MessageEvent<string>).data) as State);
      // El árbol se vuelve a pedir con cada cambio: mi HEAD pudo moverse.
      getTree()
        .then(setTree)
        .catch(() => {});
    });
    source.addEventListener("activity", (event) => {
      const events = JSON.parse((event as MessageEvent<string>).data) as ActivityEvent[];
      activityRef.current?.(events);
    });

    return () => source.close();
  }, []);

  return { state, tree, connected };
}

/** La hora actual, actualizada cada segundo (para los "hace 12 s"). */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Tiempo transcurrido como "hace 3 min" (igual que la CLI). */
export function timeAgo(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} días`;
}
