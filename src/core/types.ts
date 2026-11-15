// El contrato de la API del panel: lo que devuelve el servidor y consume la
// interfaz web. Solo tipos y sin nada de Node, para que la UI pueda importarlo.

/** Respuesta de GET /api/state (y dato de los eventos SSE "state"). */
export interface State {
  repo: { name: string; root: string; branch: string | null; remote: string };
  /** Mi usuario (mp.user). */
  me: string;
  /** Fecha ISO del último fetch correcto; "" si todavía no hubo ninguno. */
  fetchedAt: string;
  fetch: { ok: boolean; error?: string; intervalSec: number };
  /** Todos los que tienen un wip, ordenados por nombre. Me incluye si tengo wip. */
  players: Player[];
  /** Archivos tocados por dos o más personas. */
  overlaps: Overlap[];
}

export interface Player {
  user: string;
  isMe: boolean;
  /** Fecha ISO de su instantánea: la última vez que su trabajo cambió. */
  lastWipAt: string;
  baseBranch: string | null;
  /** Hash corto del commit sobre el que trabaja. */
  baseCommit: string;
  files: ChangedFile[];
  totals: { files: number; added: number; deleted: number };
  /** Solo para mí: ¿está corriendo mi daemon (mp start)? */
  daemonRunning?: boolean;
  /** Si no se pudo leer su trabajo, por qué. */
  error?: string;
}

export interface ChangedFile {
  /** Ruta con "/". En renombres, la nueva. */
  path: string;
  /** A: nuevo, M: modificado, D: borrado, R: renombrado. */
  status: "A" | "M" | "D" | "R";
  /** Solo en renombres: la ruta anterior. */
  oldPath?: string;
  /** Líneas agregadas y borradas; null si el archivo es binario. */
  added: number | null;
  deleted: number | null;
  binary?: boolean;
  /** ¿Existe esa ruta en MI carpeta de trabajo? (para "Abrir en VS Code") */
  existsLocal: boolean;
}

export interface Overlap {
  file: string;
  users: string[];
}

/** Respuesta de GET /api/tree. */
export interface TreeFiles {
  /** Archivos de mi HEAD, con "/". */
  files: string[];
  /** true si había más del tope y se recortó la lista. */
  truncated: boolean;
}

/** Dato de los eventos SSE "activity": una lista de estos. */
export type ActivityEvent =
  /** Otro jugador empezó a tocar un archivo que antes no tocaba. */
  | { type: "started-file"; user: string; file: string }
  /** Otro jugador llevaba más de 30 min sin cambios y llegó un wip nuevo. */
  | { type: "woke-up"; user: string }
  /** Apareció un jugador que antes no estaba. */
  | { type: "joined"; user: string }
  /** Un archivo pasó a estar tocado por dos o más personas. */
  | { type: "overlap"; file: string; users: string[] };
