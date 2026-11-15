import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { runDaemon } from "../src/daemon.js";
import { formatTable, relativeTime } from "../src/format.js";
import { git, pushCommitToRef } from "../src/git.js";
import { createSnapshot } from "../src/snapshot.js";
import { getWho, renderWho, type WhoEntry } from "../src/who.js";
import { commitAll, makeTeam, removeDir, type Team, waitFor, write } from "./helpers.js";

describe("formato", () => {
  it("relativeTime", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const ago = (seconds: number) => relativeTime(new Date(now.getTime() - seconds * 1000), now);

    expect(ago(0)).toBe("hace 0 s");
    expect(ago(59)).toBe("hace 59 s");
    expect(ago(60)).toBe("hace 1 min");
    expect(ago(3 * 60 + 20)).toBe("hace 3 min");
    expect(ago(2 * 3600)).toBe("hace 2 h");
    expect(ago(3 * 24 * 3600)).toBe("hace 3 días");
    expect(ago(-5)).toBe("hace 0 s"); // relojes desincronizados: nunca negativo
  });

  it("formatTable alinea las columnas", () => {
    expect(
      formatTable([
        ["A", "BBB", "C"],
        ["aaaa", "b", "c"],
      ]),
    ).toEqual(["A      BBB   C", "aaaa   b     c"]);
  });
});

describe("mp who", () => {
  let team: Team;
  let bruno: Config;
  let yered: Config;

  beforeEach(async () => {
    team = await makeTeam();
    bruno = { repoRoot: team.bruno, user: "bruno", remote: "origin" };
    yered = { repoRoot: team.yered, user: "yered", remote: "origin" };
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  /** Crea la instantánea y la sube (lo que hace un ciclo del daemon). */
  async function publish(config: Config): Promise<void> {
    const snapshot = await createSnapshot(config.repoRoot, config.user);
    await pushCommitToRef(config.repoRoot, config.remote, snapshot.commit, snapshot.ref);
  }

  it("sin wips devuelve una lista vacía y sugiere mp start", async () => {
    const entries = await getWho(yered);

    expect(entries).toEqual([]);
    expect(renderWho(entries)).toMatch(/mp start/);
  });

  it("ve el wip del otro clon después de que su daemon hace push", async () => {
    await write(team.bruno, "nuevo.txt", "uno\ndos\n");
    await write(team.bruno, "README.md", "# cambiado\n");

    const controller = new AbortController();
    const lines: string[] = [];
    const daemon = runDaemon({
      ...bruno,
      intervalMs: 100,
      signal: controller.signal,
      log: (line) => lines.push(line),
    });
    await waitFor(() => lines.some((line) => line.includes("✓")));
    controller.abort();
    await daemon;

    const entries = await getWho(yered);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      user: "bruno",
      branch: "main",
      isMe: false,
      stat: { files: 2, insertions: 3, deletions: 1 },
    });
    expect(Date.now() - entries[0]!.date.getTime()).toBeLessThan(60_000);

    // who no tocó la rama ni el working tree de Yered.
    expect(await git(["status", "--porcelain=v1"], { cwd: team.yered })).toBe("");
  });

  it("marca al usuario actual y ordena por actividad reciente", async () => {
    await write(team.bruno, "a.txt", "bruno\n");
    await publish(bruno);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // fechas con 1 s de precisión
    await write(team.yered, "b.txt", "yered\n");
    await publish(yered);

    const entries = await getWho(yered);

    expect(entries.map((e) => [e.user, e.isMe])).toEqual([
      ["yered", true],
      ["bruno", false],
    ]);
  });

  it("cuenta también los commits del otro que tú todavía no tienes", async () => {
    await git(["switch", "--quiet", "-c", "feature"], { cwd: team.bruno });
    await write(team.bruno, "commiteado.txt", "uno\n");
    await commitAll(team.bruno, "commit local sin push");
    await write(team.bruno, "sin-commit.txt", "dos\n");
    await publish(bruno);

    const [entry] = await getWho(yered);

    expect(entry).toMatchObject({ branch: "feature", stat: { files: 2, insertions: 2 } });
  });

  it("refleja la instantánea más nueva cuando el otro vuelve a subir", async () => {
    await write(team.bruno, "a.txt", "uno\n");
    await publish(bruno);
    expect((await getWho(yered))[0]!.stat.insertions).toBe(1);

    await write(team.bruno, "a.txt", "uno\ndos\ntres\n");
    await publish(bruno);
    expect((await getWho(yered))[0]!.stat.insertions).toBe(3);
  });

  it("falla con mensaje claro si no se puede contactar al remoto", async () => {
    await git(["remote", "set-url", "origin", path.join(team.root, "no-existe.git")], {
      cwd: team.yered,
    });

    await expect(getWho(yered)).rejects.toThrow(/No se pudo traer el trabajo del remoto "origin"/);
  });
});

describe("renderWho", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const entry = (user: string, minutesAgo: number, extra: Partial<WhoEntry> = {}): WhoEntry => ({
    user,
    branch: "main",
    date: new Date(now.getTime() - minutesAgo * 60_000),
    stat: { files: 3, insertions: 42, deletions: 7 },
    isMe: false,
    ...extra,
  });

  it("muestra la tabla con (tú), inactivo y sin cambios", () => {
    const text = renderWho(
      [
        entry("yered", 2),
        entry("bruno", 30, { isMe: true, branch: null }),
        entry("ana", 31, { stat: { files: 0, insertions: 0, deletions: 0 } }),
      ],
      now,
    );

    // Sin colores cuando la salida no es una terminal (como en las pruebas).
    expect(text.split("\n")).toEqual([
      "USUARIO      RAMA         ÚLTIMO WIP               CAMBIOS",
      "yered        main         hace 2 min               3 archivos, +42 −7",
      "bruno (tú)   (sin rama)   hace 30 min              3 archivos, +42 −7",
      "ana          main         hace 31 min · inactivo   sin cambios",
    ]);
  });
});
