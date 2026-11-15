// mp who: quién está trabajando, en qué rama, hace cuánto y cuánto cambió.

import pc from "picocolors";
import type { Config } from "./config.js";
import { ASLEEP_AFTER_MS as INACTIVE_AFTER_MS } from "./core/constants.js";
import { formatStat, formatTable, relativeTime } from "./format.js";
import {
  type DiffStat,
  fetchWipRefs,
  getDiffStat,
  getHead,
  getMergeBase,
  listRefs,
} from "./git.js";
import { readWip, type Wip } from "./snapshot.js";


const WIP_PREFIX = "refs/wip/";

export interface WhoEntry {
  user: string;
  /** Rama en la que está trabajando, o null si no está en una rama. */
  branch: string | null;
  /** Fecha de su última instantánea. */
  date: Date;
  /** Cambios de su instantánea respecto a la base (ver getWipBase). */
  stat: DiffStat;
  /** true si es el usuario de este repo. */
  isMe: boolean;
}

/**
 * Commit contra el que se compara un wip: el ancestro común entre ese wip y
 * tu HEAD. Así el diff muestra "lo que esa persona tiene y tú no": su trabajo
 * sin commit y también sus commits que todavía no tienes.
 * Si no hay ancestro común, se usa la base del propio wip (solo lo sin commit).
 */
export async function getWipBase(repoRoot: string, wip: Wip): Promise<string> {
  const head = await getHead(repoRoot);
  const base = head ? await getMergeBase(repoRoot, head, wip.commit) : null;
  return base ?? wip.parent;
}

/** Lee todos los wips que hay en las refs locales (sin hacer fetch). */
export async function listWips(repoRoot: string): Promise<{ user: string; wip: Wip }[]> {
  const wips = [];
  for (const ref of await listRefs(repoRoot, WIP_PREFIX)) {
    const wip = await readWip(repoRoot, ref);
    if (wip) wips.push({ user: ref.slice(WIP_PREFIX.length), wip });
  }
  return wips;
}

/** Trae los wips del remoto y devuelve la actividad, lo más reciente primero. */
export async function getWho(config: Config): Promise<WhoEntry[]> {
  const { repoRoot, remote, user: me } = config;
  await fetchWipRefs(repoRoot, remote);

  const entries: WhoEntry[] = [];
  for (const { user, wip } of await listWips(repoRoot)) {
    const base = await getWipBase(repoRoot, wip);
    entries.push({
      user,
      branch: wip.branch,
      date: wip.date,
      stat: await getDiffStat(repoRoot, base, wip.commit),
      isMe: user === me,
    });
  }
  return entries.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Forma de cada usuario en `mp who --json`. */
export interface WhoJson {
  user: string;
  isMe: boolean;
  branch: string | null;
  /** Fecha ISO de su última instantánea. */
  lastWipAt: string;
  stat: DiffStat;
}

/** Convierte la actividad en datos listos para JSON (para `--json`). */
export function whoToJson(entries: readonly WhoEntry[]): WhoJson[] {
  return entries.map((entry) => ({
    user: entry.user,
    isMe: entry.isMe,
    branch: entry.branch,
    lastWipAt: entry.date.toISOString(),
    stat: entry.stat,
  }));
}

/** Convierte la actividad en el texto que se imprime. */
export function renderWho(entries: readonly WhoEntry[], now: Date = new Date()): string {
  if (entries.length === 0) {
    return "Nadie ha subido trabajo todavía. Para compartir el tuyo, corre: mp start";
  }

  const inactive = entries.map((e) => now.getTime() - e.date.getTime() > INACTIVE_AFTER_MS);
  const rows = entries.map((entry, i) => [
    entry.isMe ? `${entry.user} (tú)` : entry.user,
    entry.branch ?? "(sin rama)",
    relativeTime(entry.date, now) + (inactive[i] ? " · inactivo" : ""),
    entry.stat.files === 0 ? "sin cambios" : formatStat(entry.stat),
  ]);

  const [header = "", ...lines] = formatTable([
    ["USUARIO", "RAMA", "ÚLTIMO WIP", "CAMBIOS"],
    ...rows,
  ]);
  return [pc.bold(header), ...lines.map((line, i) => (inactive[i] ? pc.dim(line) : line))].join(
    "\n",
  );
}
