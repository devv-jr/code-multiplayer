import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, LockError, runDaemon } from "../src/daemon.js";
import { git, runGit } from "../src/git.js";
import { NoCommitsError } from "../src/snapshot.js";
import {
  initRepo,
  makeTeam,
  makeTempDir,
  removeDir,
  type Team,
  waitFor,
  write,
} from "./helpers.js";

/** PID de un proceso que ya terminó. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", ""], (error) => {
      if (error) reject(error);
      else resolve(child.pid!);
    });
  });
}

describe("lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("no deja tomar el lock dos veces y lo libera al soltarlo", async () => {
    const release = await acquireLock(dir);
    expect(await readFile(path.join(dir, "mp.lock"), "utf8")).toBe(String(process.pid));

    const error = await acquireLock(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LockError);
    expect((error as Error).message).toMatch(/Ya hay un daemon de mp corriendo/);

    await release();
    expect(existsSync(path.join(dir, "mp.lock"))).toBe(false);
    await (await acquireLock(dir))();
  });

  it("toma el lock si el PID guardado ya no existe", async () => {
    await writeFile(path.join(dir, "mp.lock"), String(await deadPid()));

    const release = await acquireLock(dir);

    expect(await readFile(path.join(dir, "mp.lock"), "utf8")).toBe(String(process.pid));
    await release();
  });
});

describe("runDaemon", () => {
  let team: Team;
  let controller: AbortController;
  let lines: string[];

  beforeEach(async () => {
    team = await makeTeam();
    controller = new AbortController();
    lines = [];
  });
  afterEach(async () => {
    controller.abort();
    await removeDir(team.root);
  });

  const start = (overrides: { remote?: string } = {}) =>
    runDaemon({
      repoRoot: team.bruno,
      user: "bruno",
      remote: overrides.remote ?? "origin",
      intervalMs: 100,
      backoffMs: [100, 200, 300],
      signal: controller.signal,
      log: (line) => lines.push(line),
    });

  const count = (text: string) => lines.filter((line) => line.includes(text)).length;

  /** Commit al que apunta refs/wip/bruno en el remoto (o "" si no existe). */
  const remoteWip = async () =>
    (await runGit(["rev-parse", "--verify", "--quiet", "refs/wip/bruno"], { cwd: team.remote }))
      .stdout.trim();

  it("sube el wip al remoto, lo actualiza al cambiar archivos y termina limpio", async () => {
    await write(team.bruno, "nuevo.txt", "uno\ndos\n");
    const daemon = start();

    await waitFor(() => count("✓") === 1);
    const first = await remoteWip();
    expect(first).toBe(await git(["rev-parse", "refs/wip/bruno"], { cwd: team.bruno }));
    expect(lines.find((line) => line.includes("✓"))).toContain("(1 archivo, +2 −0)");

    // Sin cambios: avisa y no sube nada nuevo.
    await waitFor(() => count("sin cambios") >= 2);
    expect(await remoteWip()).toBe(first);
    expect(count("✓")).toBe(1);

    await write(team.bruno, "README.md", "# cambiado\n");
    await waitFor(() => count("✓") === 2);
    const second = await remoteWip();
    expect(second).not.toBe(first);
    expect(await git(["cat-file", "blob", `${second}:README.md`], { cwd: team.remote })).toBe(
      "# cambiado",
    );

    // "Ctrl+C": termina sin error y suelta el lock.
    controller.abort();
    await expect(daemon).resolves.toBeUndefined();
    expect(existsSync(path.join(team.bruno, ".git", "mp.lock"))).toBe(false);

    // El daemon nunca tocó la rama ni el working tree de Bruno.
    expect(await git(["status", "--porcelain=v1"], { cwd: team.bruno })).toBe(
      " M README.md\n?? nuevo.txt",
    );
    expect(await git(["rev-parse", "HEAD"], { cwd: team.bruno })).toBe(
      await git(["rev-parse", "main"], { cwd: team.remote }),
    );
  });

  it("no permite dos daemons en el mismo repo", async () => {
    const daemon = start();
    await waitFor(() => count("✓") === 1);

    await expect(start()).rejects.toBeInstanceOf(LockError);

    controller.abort();
    await daemon;
  });

  it("un push fallido no mata el daemon: avisa, reintenta y se recupera", async () => {
    await git(["remote", "add", "roto", path.join(team.root, "no-existe.git")], {
      cwd: team.bruno,
    });
    const daemon = start({ remote: "roto" });

    await waitFor(() => count("no se pudo actualizar el wip") >= 2);
    expect(count("✓")).toBe(0);

    // Se "arregla la red": el remoto ahora apunta a uno que sí existe.
    await git(["remote", "set-url", "roto", team.remote], { cwd: team.bruno });
    await waitFor(() => count("✓") === 1);
    expect(await remoteWip()).not.toBe("");

    controller.abort();
    await expect(daemon).resolves.toBeUndefined();
  });

  it("en un repo sin commits falla con mensaje claro y suelta el lock", async () => {
    const empty = path.join(team.root, "vacio");
    await write(empty, "a.txt", "uno\n");
    await initRepo(empty);

    await expect(
      runDaemon({
        repoRoot: empty,
        user: "bruno",
        remote: "origin",
        intervalMs: 100,
        signal: controller.signal,
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(NoCommitsError);
    expect(existsSync(path.join(empty, ".git", "mp.lock"))).toBe(false);
  });
});
