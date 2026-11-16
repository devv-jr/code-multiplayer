// mp doctor: revisa que todo esté listo para usar mp y, si algo falla, dice
// qué pasó, por qué y qué hacer.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { DEFAULT_REMOTE, isValidUser } from "./config.js";
import {
  deleteRemoteRef,
  ensureGit,
  fetchWipRefs,
  getHead,
  getLocalConfig,
  getRepoRoot,
  git,
  hasRemote,
  pushCommitToRef,
} from "./git.js";
import { findSecretFiles, secretsHelp } from "./secret-guard.js";
import { identityArgs } from "./snapshot.js";

/** Versión mínima de Node. */
const MIN_NODE_MAJOR = 20;

/**
 * ok: bien. warn: funciona, pero conviene saberlo. fail: hay que arreglarlo.
 * skip: no se pudo revisar porque falló algo anterior.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  /** Solo en la guardia de secretos ("secrets"), para poder saltarla con --allow-secrets. */
  id?: string;
  status: CheckStatus;
  /** Una línea: qué se revisó y cómo salió. */
  title: string;
  /** Por qué pasa (para warn y fail). */
  why?: string;
  /** Qué hacer: el comando a copiar o el paso exacto. */
  fix?: string;
}

/** Extrae el número mayor de una versión de Node como "v24.21.0" o "20.11.1". */
export function parseNodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
}

export interface PushCheck {
  /** ¿Se pudo subir la ref de prueba? */
  ok: boolean;
  /** ¿Se borró la ref de prueba del remoto? (solo importa si ok) */
  cleaned: boolean;
  /** Nombre de la ref de prueba. */
  ref: string;
  /** Primera línea del error de git, si falló. */
  error?: string;
}

/**
 * Comprueba si se puede subir a refs/wip/ del remoto, por la misma ruta que
 * usa el daemon (un git push a una ref bajo refs/wip/).
 *
 * Qué se sube: un commit vacío recién creado (sin archivos y sin historial).
 * No lleva nada del proyecto, ni siquiera commits sin subir.
 *
 * Nombre de la ref: refs/wip/DOCTOR.<usuario>.<al azar>. Las mayúsculas y los
 * puntos no se permiten en un nombre de usuario, así que nunca coincide con
 * un jugador, y mp who y el panel ignoran las refs con nombre inválido.
 * Al terminar, la ref se borra del remoto.
 */
export async function checkPushAccess(
  repoRoot: string,
  remote: string,
  user: string,
): Promise<PushCheck> {
  const ref = `refs/wip/DOCTOR.${user}.${randomBytes(3).toString("hex")}`;
  try {
    // "git mktree" sin entradas crea el árbol vacío.
    const tree = await git(["mktree"], { cwd: repoRoot, input: "" });
    const commit = await git(
      [
        ...(await identityArgs(repoRoot, user)),
        "commit-tree",
        tree,
        "-m",
        "mp doctor: prueba de permiso de escritura (se puede borrar)",
      ],
      { cwd: repoRoot },
    );
    await pushCommitToRef(repoRoot, remote, commit, ref);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const line = text.split(/\r?\n/).find((l) => /rejected|denied|fatal|error|remote:/i.test(l));
    return { ok: false, cleaned: true, ref, error: (line ?? text.split(/\r?\n/)[0] ?? "").trim() };
  }
  return { ok: true, cleaned: await deleteRemoteRef(repoRoot, remote, ref), ref };
}

/** Convierte el resultado de la prueba de push en una comprobación. */
export function pushCheckResult(push: PushCheck, remote: string): Check {
  if (!push.ok) {
    return {
      status: "fail",
      title: `No pude subir a refs/wip/ en "${remote}"`,
      why: `git respondió: ${push.error ?? "(sin detalle)"}\n  Lo más común: tu cuenta no tiene permiso de escritura en ese repo, o el remoto tiene una regla que rechaza estas refs. También puede ser un fallo de red justo ahora.`,
      fix: "Pídele a quien creó el repo que te agregue como colaborador con permiso de escritura (en GitHub: Settings → Collaborators). Luego corre de nuevo: mp doctor",
    };
  }
  if (!push.cleaned) {
    return {
      status: "warn",
      title: `Puedes subir a refs/wip/ en "${remote}", pero no pude borrar la ref de prueba`,
      why: `Quedó en el remoto la ref ${push.ref}. No estorba (mp la ignora), pero es basura.`,
      fix: `Bórrala con: git push ${remote} --delete ${push.ref}`,
    };
  }
  return {
    status: "ok",
    title: `Puedes subir a refs/wip/ en "${remote}" (subí una ref de prueba vacía y la borré)`,
  };
}

export interface DoctorOptions {
  /** Solo lo local: sin fetch ni push de prueba (para el arranque de mp up). */
  quick?: boolean;
  /** Para pruebas. Por defecto, los valores reales del proceso. */
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Corre todas las comprobaciones, en orden. Nunca lanza errores. */
export async function runDoctor(cwd: string, options: DoctorOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const skip = (title: string) => checks.push({ status: "skip", title });

  // 1. git
  let gitOk = true;
  try {
    checks.push({ status: "ok", title: `git ${await ensureGit()}` });
  } catch (error) {
    gitOk = false;
    checks.push({
      status: "fail",
      title: "git no está instalado o es muy viejo",
      why: error instanceof Error ? error.message : String(error),
      fix: "macOS: brew install git   ·   Windows: winget install Git.Git   (después cierra y abre la terminal)",
    });
  }

  // 2. Node
  const nodeVersion = options.nodeVersion ?? process.version;
  const major = parseNodeMajor(nodeVersion);
  if (major !== null && major >= MIN_NODE_MAJOR) {
    checks.push({ status: "ok", title: `Node ${nodeVersion.replace(/^v/, "")}` });
  } else {
    checks.push({
      status: "fail",
      title: `Node ${nodeVersion} es muy viejo`,
      why: `mp necesita Node ${MIN_NODE_MAJOR} o más nuevo.`,
      fix: "macOS: brew install node   ·   Windows: winget install OpenJS.NodeJS.LTS   (o descárgalo de https://nodejs.org)",
    });
  }

  // 3. Repo y primer commit
  let repoRoot: string | null = null;
  if (!gitOk) {
    skip("Estar dentro de un repo git");
  } else {
    try {
      repoRoot = await getRepoRoot(cwd);
    } catch {
      checks.push({
        status: "fail",
        title: "Esta carpeta no es un repo git",
        why: "mp trabaja dentro de la carpeta de un proyecto que usa git (un \"repo\").",
        fix: "Entra a la carpeta del proyecto compartido con: cd <carpeta del proyecto>",
      });
    }
  }
  let hasCommits = false;
  if (repoRoot) {
    hasCommits = (await getHead(repoRoot)) !== null;
    checks.push(
      hasCommits
        ? { status: "ok", title: `Repo: ${repoRoot}` }
        : {
            status: "fail",
            title: "El repo todavía no tiene ningún commit",
            why: "mp compara tu trabajo contra el último commit, y aquí aún no hay ninguno.",
            fix: 'Guarda un primer commit:  git add -A   y luego   git commit -m "primer commit"',
          },
    );
  }

  // 4. Remoto
  let remote: string | null = null;
  if (!repoRoot) {
    skip("Remoto compartido");
  } else {
    const name = (await getLocalConfig(repoRoot, "mp.remote")) ?? DEFAULT_REMOTE;
    if (await hasRemote(repoRoot, name)) {
      remote = name;
      checks.push({ status: "ok", title: `Remoto "${name}"` });
    } else {
      checks.push({
        status: "fail",
        title: `El repo no tiene el remoto "${name}"`,
        why: "El remoto es la copia del proyecto en internet (por ejemplo en GitHub) por donde se comparte el trabajo.",
        fix: `Conéctalo con: git remote add ${name} <dirección del repo>`,
      });
    }
  }

  // 5. Usuario de mp
  let user: string | null = null;
  if (!repoRoot) {
    skip("Tu usuario de mp");
  } else {
    const saved = await getLocalConfig(repoRoot, "mp.user");
    if (saved && isValidUser(saved)) {
      user = saved;
      checks.push({ status: "ok", title: `Tu usuario de mp: ${saved}` });
    } else {
      checks.push({
        status: "fail",
        title: saved ? `Tu usuario de mp ("${saved}") no es válido` : "Falta tu usuario de mp",
        why: "mp necesita un nombre corto para mostrarte en la sala (minúsculas, números, - y _).",
        fix: "Corre: mp init   (o simplemente mp up, que te lo pregunta)",
      });
    }
  }

  // 6 y 7. Red: leer y escribir en el remoto
  if (!options.quick) {
    let fetchOk = false;
    if (!repoRoot || !remote) {
      skip("Leer del remoto");
    } else {
      try {
        await fetchWipRefs(repoRoot, remote);
        fetchOk = true;
        checks.push({ status: "ok", title: `Puedo leer del remoto "${remote}"` });
      } catch (error) {
        const lines = (error instanceof Error ? error.message : String(error)).split(/\r?\n/);
        checks.push({
          status: "fail",
          title: `No pude leer del remoto "${remote}"`,
          why: (lines.find((l) => l.includes("Detalle:")) ?? lines[0] ?? "").trim(),
          fix: `Revisa tu conexión a internet. Si hay conexión, prueba: git fetch ${remote}   y sigue lo que te pida (suele ser iniciar sesión).`,
        });
      }
    }

    if (!repoRoot || !remote || !fetchOk) {
      skip("Subir al remoto (refs/wip/)");
    } else {
      // Sin usuario todavía, la ref de prueba usa un nombre genérico.
      checks.push(pushCheckResult(await checkPushAccess(repoRoot, remote, user ?? "nuevo"), remote));
    }
  }

  // 8. Guardia de secretos
  if (!repoRoot) {
    skip("Archivos sensibles sin ignorar");
  } else {
    const secrets = await findSecretFiles(repoRoot);
    checks.push(
      secrets.length === 0
        ? { status: "ok", title: "Sin archivos sensibles sin ignorar (revisión por nombre de archivo)" }
        : {
            id: "secrets",
            status: "fail",
            title: `Hay archivos que parecen secretos sin ignorar: ${secrets.map((f) => f.path).join(", ")}`,
            why: "mp sube todo lo que no esté en .gitignore; estos archivos llegarían al remoto.",
            // secretsHelp ya empieza con "Cómo arreglarlo:"; aquí va tras "Solución:".
            fix: secretsHelp(secrets).replace(/^Cómo arreglarlo: a/, "A"),
          },
    );
  }

  // 9. Finales de línea (informativo)
  if (repoRoot) {
    const attributes = await readFile(path.join(repoRoot, ".gitattributes"), "utf8").catch(() => "");
    checks.push(
      /^\s*\*\s+text=auto\b/m.test(attributes)
        ? { status: "ok", title: "Finales de línea normalizados (.gitattributes)" }
        : {
            status: "warn",
            title: "El repo no normaliza los finales de línea",
            why: "Windows y macOS terminan las líneas distinto. Sin esto, mp puede mostrar archivos enteros como cambiados cuando nadie los tocó.",
            fix: 'Crea un archivo llamado .gitattributes en la carpeta principal del repo con esta línea:   * text=auto   y haz commit.',
          },
    );
  }

  // 10. Solo Windows: el alias de PowerShell
  if ((options.platform ?? process.platform) === "win32" && isPowerShell(options.env ?? process.env)) {
    checks.push({
      status: "warn",
      title: "Estás en PowerShell: escribe codemp en vez de mp",
      why: 'En PowerShell, "mp" ya es otro comando (un alias de Move-ItemProperty) y le gana a este.',
      fix: "Usa codemp para todo: codemp up, codemp doctor, codemp who.",
    });
  }

  return checks;
}

/**
 * ¿Parece que esta terminal es PowerShell? No hay una forma oficial de
 * saberlo. PowerShell agrega al PSModulePath la carpeta de módulos del
 * usuario (dentro de su carpeta personal); cmd y Git Bash no.
 */
function isPowerShell(env: NodeJS.ProcessEnv): boolean {
  const modulePath = (env.PSModulePath ?? "").toLowerCase();
  return modulePath.includes(os.homedir().toLowerCase());
}

const SYMBOL: Record<CheckStatus, string> = {
  ok: pc.green("✓"),
  warn: pc.yellow("⚠"),
  fail: pc.red("✗"),
  skip: pc.dim("—"),
};

/** ¿Hay algún problema que impida usar mp? */
export function hasFailures(checks: readonly Check[]): boolean {
  return checks.some((check) => check.status === "fail");
}

/** El texto que imprime mp doctor. */
export function renderDoctor(checks: readonly Check[]): string {
  const lines: string[] = [];
  const indent = (text: string) => text.split("\n").join("\n      ");

  for (const check of checks) {
    const title = check.status === "skip" ? pc.dim(`${check.title} (no se revisó: falta algo de arriba)`) : check.title;
    lines.push(` ${SYMBOL[check.status]} ${title}`);
    if (check.why) lines.push(`      Por qué: ${indent(check.why)}`);
    if (check.fix) lines.push(`      Solución: ${indent(check.fix)}`);
  }

  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  lines.push("");
  if (failed > 0) {
    lines.push(
      `${count(failed, "problema", "problemas")} por arreglar${warned > 0 ? ` y ${count(warned, "aviso", "avisos")}` : ""}. Arregla lo marcado con ✗ y corre de nuevo: mp doctor`,
    );
  } else if (warned > 0) {
    lines.push(`Todo lo necesario está bien (${count(warned, "aviso", "avisos")}). Siguiente paso: mp up`);
  } else {
    lines.push("Todo bien. Siguiente paso: mp up");
  }
  return lines.join("\n");
}
