import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { State } from "../src/core/types.js";
import { git, runGit } from "../src/git.js";
import { NoCommitsError } from "../src/snapshot.js";
import { startUp, type UpSession } from "../src/up.js";
import {
  initRepo,
  makeTeam,
  removeDir,
  runCli,
  type Team,
  waitFor,
  write,
} from "./helpers.js";

/** GET al panel; devuelve el JSON. */
function getJson<T>(port: number, target: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: target }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolve(JSON.parse(body) as T));
      })
      .on("error", reject);
  });
}

describe("mp up", () => {
  let team: Team;
  let bruno: Config;
  let sessions: UpSession[];
  let lines: string[];
  let tempDir: string;
  const savedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };

  beforeEach(async () => {
    team = await makeTeam();
    bruno = { repoRoot: team.bruno, user: "bruno", remote: "origin" };
    sessions = [];
    lines = [];

    // Carpeta temporal propia de esta prueba, para comprobar que al apagar
    // no quedan los índices temporales de las instantáneas.
    tempDir = path.join(team.root, "tmp");
    await mkdir(tempDir);
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = tempDir;
  });
  afterEach(async () => {
    for (const session of sessions) await session.stop();
    Object.assign(process.env, savedTemp);
    await removeDir(team.root);
  });

  const up = async (config: Config = bruno) => {
    const session = await startUp(config, {
      port: 0,
      daemonIntervalMs: 100,
      panelIntervalMs: 100,
      log: (line) => lines.push(line),
    });
    sessions.push(session);
    return session;
  };
  const state = (session: UpSession) => getJson<State>(session.port, "/api/state");
  const me = async (session: UpSession) => (await state(session)).players.find((p) => p.isMe);
  const remoteWip = async () =>
    (await runGit(["rev-parse", "--verify", "--quiet", "refs/wip/bruno"], { cwd: team.remote }))
      .stdout.trim();

  it("arranca el daemon y el panel juntos: subo mi trabajo y me veo con daemonRunning", async () => {
    await write(team.bruno, "nuevo.txt", "hola\n");

    const session = await up();

    expect(session.daemonStarted).toBe(true);
    expect(session.url).toBe(`http://localhost:${session.port}`);
    await waitFor(async () => (await me(session))?.daemonRunning === true);
    const mine = (await me(session))!;
    expect(mine.files.map((file) => file.path)).toEqual(["nuevo.txt"]);
    expect(mine).not.toHaveProperty("uploadPausedFiles");
    expect(await remoteWip()).not.toBe("");
    expect(await readFile(path.join(team.bruno, ".git", "mp.lock"), "utf8")).toBe(String(process.pid));
  });

  it("un segundo mp up en el mismo repo no duplica el daemon: solo abre otro panel", async () => {
    const first = await up();
    await waitFor(() => lines.some((line) => line.includes("✓ wip actualizado")));

    const second = await up();

    expect(second.daemonStarted).toBe(false);
    expect(second.port).not.toBe(first.port);
    expect((await state(second)).me).toBe("bruno");

    // Cerrar el segundo no apaga el daemon del primero.
    await second.stop();
    await second.done;
    expect(existsSync(path.join(team.bruno, ".git", "mp.lock"))).toBe(true);
    await write(team.bruno, "sigue.txt", "x\n");
    await waitFor(() => lines.filter((line) => line.includes("✓ wip actualizado")).length >= 2);
  });

  it("el apagado ordenado suelta el lock, cierra el panel y no deja temporales", async () => {
    await write(team.bruno, "nuevo.txt", "hola\n");
    const session = await up();
    await waitFor(() => lines.some((line) => line.includes("✓ wip actualizado")));

    await session.stop();
    await expect(session.done).resolves.toBeUndefined();
    await session.stop(); // llamarlo dos veces no rompe nada

    expect(existsSync(path.join(team.bruno, ".git", "mp.lock"))).toBe(false);
    await expect(state(session)).rejects.toThrow(); // el servidor ya no responde
    expect((await readdir(tempDir)).filter((name) => name.startsWith("mp-index-"))).toEqual([]);

    // Y el trabajo del usuario sigue como estaba.
    expect(await git(["status", "--porcelain=v1"], { cwd: team.bruno })).toBe("?? nuevo.txt");
  });

  it("uploadPausedFiles aparece en mi tarjeta mientras la subida está pausada", async () => {
    await write(team.bruno, "a.txt", "uno\n");
    const session = await up();
    await waitFor(async () => (await me(session))?.daemonRunning === true);
    const before = await remoteWip();

    await write(team.bruno, "config/.env.local", "CLAVE=1\n");
    await waitFor(async () => (await me(session))?.uploadPausedFiles !== undefined);
    expect((await me(session))!.uploadPausedFiles).toEqual(["config/.env.local"]);
    expect(await remoteWip()).toBe(before);

    // Al ignorarlo, la subida se reanuda y el aviso desaparece del estado.
    await write(team.bruno, ".gitignore", ".env.local\n");
    await waitFor(async () => (await me(session))?.uploadPausedFiles === undefined);
    await waitFor(async () => (await remoteWip()) !== before);
    const files = await git(["ls-tree", "-r", "--name-only", "refs/wip/bruno"], { cwd: team.remote });
    expect(files).not.toContain(".env.local");
  });

  it("si el daemon no puede arrancar (repo sin commits), no abre el panel y da el error", async () => {
    const empty = path.join(team.root, "vacio");
    await write(empty, "a.txt", "x\n");
    await initRepo(empty);
    await git(["remote", "add", "origin", team.remote], { cwd: empty });

    await expect(
      startUp(
        { repoRoot: empty, user: "bruno", remote: "origin" },
        { port: 0, daemonIntervalMs: 100, panelIntervalMs: 100, log: () => {} },
      ),
    ).rejects.toBeInstanceOf(NoCommitsError);
    expect(existsSync(path.join(empty, ".git", "mp.lock"))).toBe(false);
  });
});

describe("comando mp up (CLI real)", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  it("con un archivo sensible sin ignorar se niega y explica cómo arreglarlo", async () => {
    await git(["config", "--local", "mp.user", "yered"], { cwd: team.yered });
    await write(team.yered, ".env", "CLAVE=1\n");

    const result = await runCli(["up", "--no-open", "--port", "4795"], team.yered);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("No puedo arrancar todavía");
    expect(result.stdout).toContain("✗ Hay archivos que parecen secretos sin ignorar: .env");
    expect(result.stdout).toMatch(/^ {10}\.env$/m); // la línea para .gitignore
    expect((await runGit(["for-each-ref", "refs/wip"], { cwd: team.remote })).stdout).toBe("");
  });

  it("sin configurar y sin terminal interactiva: dice cómo dar el nombre", async () => {
    const result = await runCli(["up", "--no-open", "--port", "4795"], team.yered);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Es tu primera vez con mp en este repo");
    expect(result.stderr).toContain("mp init --user <nombre>");
  });

  it("valida --port y --interval", async () => {
    await git(["config", "--local", "mp.user", "yered"], { cwd: team.yered });

    expect((await runCli(["up", "--no-open", "--port", "abc"], team.yered)).stderr).toMatch(/--port debe ser/);
    expect((await runCli(["up", "--no-open", "--interval", "1"], team.yered)).stderr).toMatch(
      /--interval debe ser.*mínimo 5/,
    );
  });
});
