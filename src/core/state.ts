// Construye el "estado" que muestra el panel: quién está, qué archivos toca
// cada quien y dónde coinciden. Solo lee del repo local; no hace fetch.

import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { isDaemonRunning } from "../daemon.js";
import {
  commitExists,
  getChangedFiles,
  getCurrentBranch,
  getGitDir,
  getHead,
  listFiles,
} from "../git.js";
import type { Wip } from "../snapshot.js";
import { listWips } from "../who.js";
import { TREE_MAX_FILES } from "./constants.js";
import type { Overlap, Player, State, TreeFiles } from "./types.js";

// Los tipos del contrato (State, Player...) viven en types.ts, que la UI
// también importa. Se reexportan aquí por comodidad.
export type { ChangedFile, Overlap, Player, State, TreeFiles } from "./types.js";

/** Resultado del último fetch; lo aporta el bucle de fetch. */
export interface FetchStatus {
  ok: boolean;
  error?: string;
  intervalSec: number;
  fetchedAt: string;
}

// ─────────────────────── Construcción ───────────────────────

/** Lee los wips locales y arma el estado completo. */
export async function buildState(
  config: Config,
  fetch: FetchStatus,
  /** Lo que solo sabe el daemon cuando corre en este mismo proceso (mp up). */
  local: { uploadPausedFiles?: readonly string[] } = {},
): Promise<State> {
  const { repoRoot, user: me, remote } = config;
  const gitDir = await getGitDir(repoRoot);

  const players: Player[] = [];
  for (const { user, wip } of await listWips(repoRoot)) {
    const player = await buildPlayer(repoRoot, user, wip, user === me);
    if (player.isMe) {
      player.daemonRunning = await isDaemonRunning(gitDir);
      if (local.uploadPausedFiles && local.uploadPausedFiles.length > 0) {
        player.uploadPausedFiles = [...local.uploadPausedFiles];
      }
    }
    players.push(player);
  }
  // Orden fijo, para que dos estados iguales se vean iguales al compararlos.
  players.sort((a, b) => (a.user < b.user ? -1 : 1));

  return {
    repo: {
      name: path.basename(repoRoot),
      root: repoRoot,
      branch: await getCurrentBranch(repoRoot),
      remote,
    },
    me,
    fetchedAt: fetch.fetchedAt,
    fetch: {
      ok: fetch.ok,
      ...(fetch.error !== undefined ? { error: fetch.error } : {}),
      intervalSec: fetch.intervalSec,
    },
    players,
    overlaps: findOverlaps(players),
  };
}

/**
 * Los "cambios en curso" de alguien son el diff entre el padre de su wip (su
 * HEAD cuando se tomó la instantánea) y el wip: exactamente su trabajo sin
 * commit. (mp peek compara distinto: contra el ancestro común con tu HEAD.)
 */
async function buildPlayer(
  repoRoot: string,
  user: string,
  wip: Wip,
  isMe: boolean,
): Promise<Player> {
  const player: Player = {
    user,
    isMe,
    lastWipAt: wip.date.toISOString(),
    baseBranch: wip.branch,
    baseCommit: wip.parent.slice(0, 7),
    files: [],
    totals: { files: 0, added: 0, deleted: 0 },
  };

  // Un error con un jugador no debe tumbar el estado de los demás.
  try {
    if (wip.parent === "" || !(await commitExists(repoRoot, wip.parent))) {
      player.error = `No se puede leer el trabajo de ${user}: falta su commit base en tu repo. Prueba: git fetch`;
      return player;
    }

    const changes = await getChangedFiles(repoRoot, wip.parent, wip.commit);
    player.files = changes
      .map((change) => ({
        ...change,
        // La ruta viene con "/"; path.join la adapta al sistema.
        existsLocal: existsSync(path.join(repoRoot, ...change.path.split("/"))),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));

    player.totals = {
      files: player.files.length,
      added: player.files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      deleted: player.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    player.error = `No se puede leer el trabajo de ${user}: ${message.split(/\r?\n/)[0] ?? ""}`;
  }
  return player;
}

/** Archivos que aparecen en los cambios de dos o más jugadores. */
export function findOverlaps(players: readonly Player[]): Overlap[] {
  const usersByFile = new Map<string, string[]>();
  for (const player of players) {
    for (const file of player.files) {
      const users = usersByFile.get(file.path) ?? [];
      users.push(player.user);
      usersByFile.set(file.path, users);
    }
  }

  return [...usersByFile]
    .filter(([, users]) => users.length >= 2)
    .map(([file, users]) => ({ file, users: [...users].sort() }))
    .sort((a, b) => (a.file < b.file ? -1 : 1));
}

// ─────────────── El contrato de GET /api/tree ───────────────

/** Lista los archivos de mi HEAD, con un tope para repos enormes. */
export async function getTreeFiles(
  repoRoot: string,
  limit: number = TREE_MAX_FILES,
): Promise<TreeFiles> {
  const head = await getHead(repoRoot);
  if (!head) return { files: [], truncated: false };

  const files = await listFiles(repoRoot, head);
  return { files: files.slice(0, limit), truncated: files.length > limit };
}
