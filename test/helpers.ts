// Utilidades para las pruebas: repos git reales en carpetas temporales.

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, pushCommitToRef } from "../src/git.js";
import { createSnapshot } from "../src/snapshot.js";

/** Crea una carpeta temporal y devuelve su ruta real (sin symlinks). */
export async function makeTempDir(prefix = "mp-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  // En macOS /var es un symlink a /private/var; git devuelve la ruta real.
  return realpath(dir);
}

/** Borra una carpeta temporal. Reintenta porque Windows a veces la bloquea. */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Escribe un archivo (ruta relativa al repo) creando sus carpetas. */
export async function write(repo: string, file: string, content: string): Promise<void> {
  const full = path.join(repo, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

/** Hace commit de todo lo que haya en el repo y devuelve el hash. */
export async function commitAll(repo: string, message: string): Promise<string> {
  await git(["add", "-A"], { cwd: repo });
  await git(["commit", "--quiet", "-m", message], { cwd: repo });
  return git(["rev-parse", "HEAD"], { cwd: repo });
}

/** Inicializa un repo vacío con identidad de prueba (sin commits). */
export async function initRepo(dir: string): Promise<void> {
  await git(["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  await git(["config", "--local", "user.name", "Prueba"], { cwd: dir });
  await git(["config", "--local", "user.email", "prueba@example.com"], { cwd: dir });
  await git(["config", "--local", "commit.gpgsign", "false"], { cwd: dir });
  // Fijo para que las pruebas den lo mismo en Windows y macOS.
  await git(["config", "--local", "core.autocrlf", "false"], { cwd: dir });
}

export interface Team {
  /** Carpeta que contiene todo (para borrarla al final). */
  root: string;
  /** Remoto bare local: hace el papel de GitHub. */
  remote: string;
  /** Clon de Bruno, con un commit inicial ya subido. */
  bruno: string;
  /** Clon de Yered. */
  yered: string;
}

/** Crea un remoto bare y dos clones que simulan a Bruno y Yered. */
export async function makeTeam(): Promise<Team> {
  const root = await makeTempDir("mp-team-");
  const remote = path.join(root, "remote.git");
  const bruno = path.join(root, "bruno");
  const yered = path.join(root, "yered");

  await git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);

  await mkdir(bruno);
  await initRepo(bruno);
  await git(["remote", "add", "origin", remote], { cwd: bruno });
  await write(bruno, "README.md", "# proyecto\n");
  await commitAll(bruno, "commit inicial");
  await git(["push", "--quiet", "-u", "origin", "main"], { cwd: bruno });

  // autocrlf=false desde el clone: si no, en Windows el checkout usaría CRLF
  // y al fijar la config después los archivos parecerían modificados.
  await git(["clone", "--quiet", "-c", "core.autocrlf=false", remote, yered]);
  await initRepo(yered); // en un repo existente solo aplica la config de prueba

  return { root, remote, bruno, yered };
}

/** Espera hasta que `check` devuelva true (o falla tras `timeoutMs`). */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: tiempo agotado");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Crea la instantánea de un usuario y la sube (lo que hace un ciclo del daemon). */
export async function publish(config: {
  repoRoot: string;
  user: string;
  remote: string;
}): Promise<void> {
  const snapshot = await createSnapshot(config.repoRoot, config.user);
  await pushCommitToRef(config.repoRoot, config.remote, snapshot.commit, snapshot.ref);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Corre la CLI de verdad (src/cli.ts con tsx) y devuelve su salida. */
export function runCli(
  args: string[],
  cwd: string,
  /** Variables de entorno extra (por ejemplo, un PATH vacío para simular que no hay git). */
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const tsx = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const cli = path.join(projectRoot, "src", "cli.ts");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsx, cli, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1", ...env } },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}
