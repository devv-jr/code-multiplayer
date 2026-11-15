// `mp who --json` y `mp peek --json`, corriendo la CLI de verdad.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import type { PeekJson } from "../src/peek.js";
import type { WhoJson } from "../src/who.js";
import { makeTeam, publish, removeDir, runCli, type Team, write } from "./helpers.js";

describe("salida --json de la CLI", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
    await git(["config", "--local", "mp.user", "yered"], { cwd: team.yered });

    await write(team.bruno, "README.md", "# proyecto\nlinea nueva\n");
    await write(team.bruno, "nuevo.txt", "hola\n");
    await publish({ repoRoot: team.bruno, user: "bruno", remote: "origin" });
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  it("mp who --json devuelve el contrato esperado", async () => {
    const result = await runCli(["who", "--json"], team.yered);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as WhoJson[];
    expect(data).toEqual([
      {
        user: "bruno",
        isMe: false,
        branch: "main",
        lastWipAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
        stat: { files: 2, insertions: 2, deletions: 0 },
      },
    ]);
  });

  it("mp who sin --json sigue imprimiendo la tabla", async () => {
    const result = await runCli(["who"], team.yered);

    expect(result.exitCode).toBe(0);
    const [header, row] = result.stdout.trim().split("\n");
    expect(header).toMatch(/^USUARIO\s+RAMA\s+ÚLTIMO WIP\s+CAMBIOS$/);
    expect(row).toMatch(/^bruno\s+main\s+hace \d+ s\s+2 archivos, \+2 −0$/);
  });

  it("mp peek <usuario> --json devuelve el contrato esperado", async () => {
    const result = await runCli(["peek", "bruno", "--json", "--file", "nuevo.txt"], team.yered);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as PeekJson;
    expect(data).toMatchObject({
      user: "bruno",
      branch: "main",
      hasChanges: true,
      base: await git(["rev-parse", "HEAD"], { cwd: team.yered }),
      commit: await git(["rev-parse", "refs/wip/bruno"], { cwd: team.yered }),
    });
    expect(data.lastWipAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.diff).toContain("+++ b/nuevo.txt\n@@ -0,0 +1 @@\n+hola\n");
    expect(data.diff).not.toContain("README.md");
    expect(data.diff).not.toContain("\u001b["); // sin colores
  });

  it("mp peek sin --json sigue imprimiendo el diff, y los errores no cambian", async () => {
    const ok = await runCli(["peek", "bruno", "--stat"], team.yered);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toMatch(/README\.md \| 1 \+/);

    const missing = await runCli(["peek", "ana", "--json"], team.yered);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain(
      'Error: No hay trabajo subido de "ana". Usuarios disponibles: bruno',
    );
  });
});
