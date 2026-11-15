import { readFile, rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { buildState, type FetchStatus, getTreeFiles } from "../src/core/state.js";
import { fetchWipRefs, git } from "../src/git.js";
import {
  commitAll,
  initRepo,
  makeTeam,
  makeTempDir,
  publish,
  removeDir,
  type Team,
  write,
} from "./helpers.js";

const FETCH: FetchStatus = { ok: true, intervalSec: 10, fetchedAt: "2026-01-01T12:00:00.000Z" };
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `linea ${i + 1}\n`).join("");

describe("buildState", () => {
  let team: Team;
  let bruno: Config;
  let yered: Config;

  beforeEach(async () => {
    team = await makeTeam();
    bruno = { repoRoot: team.bruno, user: "bruno", remote: "origin" };
    yered = { repoRoot: team.yered, user: "yered", remote: "origin" };

    // Base común con varios archivos, ya en los dos clones.
    await write(team.bruno, ".gitignore", "secreto.env\n");
    await write(team.bruno, "src/app.ts", TEN_LINES);
    await write(team.bruno, "viejo.txt", TEN_LINES);
    await write(team.bruno, "borrar.txt", "adiós\n");
    await commitAll(team.bruno, "base");
    await git(["push", "--quiet", "origin", "main"], { cwd: team.bruno });
    await git(["pull", "--quiet"], { cwd: team.yered });
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  /** El estado que vería Yered después de un fetch. */
  async function stateForYered() {
    await fetchWipRefs(team.yered, "origin");
    return buildState(yered, FETCH);
  }

  it("lista archivos nuevos, modificados, borrados, renombrados y binarios", async () => {
    await write(
      team.bruno,
      "src/app.ts",
      TEN_LINES.replace("linea 5\n", "linea 5 cambiada\notra\n"),
    );
    await write(team.bruno, "carpeta ñ/año nuevo.txt", "hola\n");
    await rm(path.join(team.bruno, "borrar.txt"));
    await rename(path.join(team.bruno, "viejo.txt"), path.join(team.bruno, "renombrado.txt"));
    await writeFile(path.join(team.bruno, "logo.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
    await write(team.bruno, "secreto.env", "CLAVE=1\n"); // ignorado: no debe aparecer
    await publish(bruno);

    const state = await stateForYered();

    expect(state.players).toHaveLength(1); // Yered no tiene wip: no aparece
    const player = state.players[0]!;
    expect(player.files).toEqual([
      { path: "borrar.txt", status: "D", added: 0, deleted: 1, existsLocal: true },
      { path: "carpeta ñ/año nuevo.txt", status: "A", added: 1, deleted: 0, existsLocal: false },
      {
        path: "logo.bin",
        status: "A",
        added: null,
        deleted: null,
        binary: true,
        existsLocal: false,
      },
      {
        path: "renombrado.txt",
        status: "R",
        oldPath: "viejo.txt",
        added: 0,
        deleted: 0,
        existsLocal: false,
      },
      { path: "src/app.ts", status: "M", added: 2, deleted: 1, existsLocal: true },
    ]);
    expect(player.totals).toEqual({ files: 5, added: 3, deleted: 2 });
  });

  it("arma el resto del contrato: repo, yo, fetch y datos del jugador", async () => {
    await write(team.bruno, "nuevo.txt", "hola\n");
    await publish(bruno);
    const brunoHead = await git(["rev-parse", "HEAD"], { cwd: team.bruno });

    const state = await stateForYered();

    expect(state.repo).toEqual({
      name: "yered",
      root: team.yered,
      branch: "main",
      remote: "origin",
    });
    expect(state.me).toBe("yered");
    expect(state.fetchedAt).toBe(FETCH.fetchedAt);
    expect(state.fetch).toEqual({ ok: true, intervalSec: 10 });
    expect(state.overlaps).toEqual([]);

    const player = state.players[0]!;
    expect(player).toMatchObject({
      user: "bruno",
      isMe: false,
      baseBranch: "main",
      baseCommit: brunoHead.slice(0, 7),
    });
    expect(Date.now() - new Date(player.lastWipAt).getTime()).toBeLessThan(60_000);
    expect(player).not.toHaveProperty("daemonRunning"); // solo para mí
    expect(player).not.toHaveProperty("error");
  });

  it("solo cuenta el trabajo sin commit, no los commits que aún no tengo", async () => {
    await write(team.bruno, "commiteado.txt", "uno\n");
    await commitAll(team.bruno, "commit local sin push");
    await write(team.bruno, "sin-commit.txt", "dos\n");
    await publish(bruno);

    const state = await stateForYered();

    expect(state.players[0]!.files.map((file) => file.path)).toEqual(["sin-commit.txt"]);
  });

  it("detecta el choque cuando dos tocan la misma ruta, y no con rutas distintas", async () => {
    await write(team.bruno, "src/app.ts", `${TEN_LINES}de bruno\n`);
    await write(team.bruno, "solo-bruno.txt", "x\n");
    await publish(bruno);
    await write(team.yered, "solo-yered.txt", "y\n");
    await publish(yered);

    expect((await stateForYered()).overlaps).toEqual([]);

    await write(team.yered, "src/app.ts", `de yered\n${TEN_LINES}`);
    await publish(yered);

    const state = await stateForYered();
    expect(state.overlaps).toEqual([{ file: "src/app.ts", users: ["bruno", "yered"] }]);
    expect(state.players.map((player) => [player.user, player.isMe])).toEqual([
      ["bruno", false],
      ["yered", true],
    ]);
  });

  it("daemonRunning refleja el lock de mi daemon", async () => {
    await publish(yered);
    const mine = async () => (await stateForYered()).players.find((player) => player.isMe)!;

    expect((await mine()).daemonRunning).toBe(false);

    // Un lock con un PID vivo (el de este proceso de pruebas).
    await writeFile(path.join(team.yered, ".git", "mp.lock"), String(process.pid));
    expect((await mine()).daemonRunning).toBe(true);
  });

  it("si falta el commit base de un wip, ese jugador queda con error y el resto sigue", async () => {
    // El wip de Bruno se apoya en un commit que Yered no tiene...
    await write(team.bruno, "commiteado.txt", "uno\n");
    await commitAll(team.bruno, "commit local sin push");
    await write(team.bruno, "sin-commit.txt", "dos\n");
    await publish(bruno);
    await write(team.yered, "mio.txt", "y\n");
    await publish(yered);

    // ...y un fetch superficial (--depth=1) trae el wip sin su padre.
    const remoteUrl = new URL(`file:///${team.remote.replace(/\\/g, "/")}`).href;
    await git(["fetch", "--quiet", "--depth=1", remoteUrl, "+refs/wip/*:refs/wip/*"], {
      cwd: team.yered,
    });

    const state = await buildState(yered, FETCH);

    const [first, second] = state.players;
    expect(first).toMatchObject({ user: "bruno", files: [] });
    expect(first!.error).toMatch(/falta su commit base/);
    expect(second!.user).toBe("yered");
    expect(second).not.toHaveProperty("error");
  });

  it("pasa el estado del fetch tal cual, también cuando falló", async () => {
    const state = await buildState(yered, {
      ...FETCH,
      ok: false,
      error: "sin red",
    });

    expect(state.fetch).toEqual({ ok: false, error: "sin red", intervalSec: 10 });
    expect(state.players).toEqual([]);
  });

  it("no modifica el repo: mismo status, HEAD e índice", async () => {
    await write(team.bruno, "src/app.ts", `${TEN_LINES}de bruno\n`);
    await publish(bruno);
    await write(team.yered, "sin-commit.txt", "y\n");
    await write(team.yered, "preparado.txt", "y\n");
    await git(["add", "preparado.txt"], { cwd: team.yered });
    await fetchWipRefs(team.yered, "origin");

    const snapshot = async () => ({
      status: await git(["status", "--porcelain=v1", "--branch"], { cwd: team.yered }),
      head: await git(["rev-parse", "HEAD"], { cwd: team.yered }),
      index: (await readFile(path.join(team.yered, ".git", "index"))).toString("hex"),
    });

    const before = await snapshot();
    await buildState(yered, FETCH);
    await getTreeFiles(team.yered);

    expect(await snapshot()).toEqual(before);
  });
});

describe("getTreeFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
    await initRepo(dir);
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("lista los archivos de HEAD con / y nombres con espacios y tildes", async () => {
    await write(dir, "README.md", "x\n");
    await write(dir, "src/app.ts", "x\n");
    await write(dir, "carpeta ñ/año nuevo.txt", "x\n");
    await commitAll(dir, "base");
    await write(dir, "sin-commit.txt", "x\n"); // no está en HEAD

    expect(await getTreeFiles(dir)).toEqual({
      files: ["README.md", "carpeta ñ/año nuevo.txt", "src/app.ts"],
      truncated: false,
    });
  });

  it("recorta la lista al tope y lo avisa", async () => {
    await write(dir, "a.txt", "x\n");
    await write(dir, "b.txt", "x\n");
    await write(dir, "c.txt", "x\n");
    await commitAll(dir, "base");

    expect(await getTreeFiles(dir, 2)).toEqual({ files: ["a.txt", "b.txt"], truncated: true });
    expect(await getTreeFiles(dir, 3)).toEqual({
      files: ["a.txt", "b.txt", "c.txt"],
      truncated: false,
    });
  });

  it("en un repo sin commits devuelve una lista vacía", async () => {
    expect(await getTreeFiles(dir)).toEqual({ files: [], truncated: false });
  });
});
