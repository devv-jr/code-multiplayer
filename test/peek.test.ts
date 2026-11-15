import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { git, pushCommitToRef } from "../src/git.js";
import { preparePeek, type PeekOptions } from "../src/peek.js";
import { createSnapshot } from "../src/snapshot.js";
import { makeTeam, removeDir, type Team, write } from "./helpers.js";

describe("mp peek", () => {
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

  /** El diff que vería Yered, como texto sin colores. */
  async function peekText(user: string, options: PeekOptions = {}, cwd = team.yered) {
    const peek = await preparePeek(yered, user, options, cwd);
    const [command = "", ...rest] = peek.diffArgs;
    const text = await git([command, "--no-color", ...rest], { cwd });
    // Las líneas "index abc..def" llevan hashes; no aportan a la comparación.
    return text
      .split("\n")
      .filter((line) => !line.startsWith("index "))
      .join("\n");
  }

  it("muestra exactamente el diff del trabajo sin commit del otro", async () => {
    await write(team.bruno, "README.md", "# proyecto\nlinea nueva\n");
    await write(team.bruno, "nuevo.txt", "hola\n");
    await publish(bruno);

    expect(await peekText("bruno")).toBe(
      [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1,2 @@",
        " # proyecto",
        "+linea nueva",
        "diff --git a/nuevo.txt b/nuevo.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/nuevo.txt",
        "@@ -0,0 +1 @@",
        "+hola",
      ].join("\n"),
    );

    // peek no tocó la rama ni el working tree de Yered.
    expect(await git(["status", "--porcelain=v1"], { cwd: team.yered })).toBe("");
  });

  it("--file limita el diff a una ruta, relativa a la carpeta actual", async () => {
    await write(team.bruno, "README.md", "# cambiado\n");
    await write(team.bruno, "src/app.ts", "let x = 1;\n");
    await publish(bruno);

    const fromRoot = await peekText("bruno", { file: "src/app.ts" });
    expect(fromRoot).toContain("+let x = 1;");
    expect(fromRoot).not.toContain("README.md");

    // Desde una subcarpeta, la ruta es relativa a esa subcarpeta.
    await write(team.yered, "src/otro.ts", "");
    const fromSub = await peekText("bruno", { file: "app.ts" }, path.join(team.yered, "src"));
    expect(fromSub).toContain("+let x = 1;");
  });

  it("--stat muestra el resumen por archivo", async () => {
    await write(team.bruno, "README.md", "# cambiado\n");
    await write(team.bruno, "nuevo.txt", "hola\n");
    await publish(bruno);

    const text = await peekText("bruno", { stat: true });

    expect(text).toMatch(/README\.md \| 2 \+-/);
    expect(text).toMatch(/nuevo\.txt \| 1 \+/);
    expect(text).not.toContain("@@");
  });

  it("avisa cuando no hay cambios (en total o en la ruta pedida)", async () => {
    await publish(bruno); // working tree limpio
    expect((await preparePeek(yered, "bruno")).hasChanges).toBe(false);

    await write(team.bruno, "nuevo.txt", "hola\n");
    await publish(bruno);
    expect((await preparePeek(yered, "bruno")).hasChanges).toBe(true);
    expect((await preparePeek(yered, "bruno", { file: "README.md" })).hasChanges).toBe(false);
  });

  it("si el usuario no existe, lista los disponibles", async () => {
    await publish(bruno);
    await publish(yered);

    await expect(preparePeek(yered, "ana")).rejects.toThrow(
      'No hay trabajo subido de "ana". Usuarios disponibles: bruno, yered',
    );
  });

  it("si nadie ha subido nada, lo dice y sugiere mp start", async () => {
    await expect(preparePeek(yered, "bruno")).rejects.toThrow(/Nadie ha subido trabajo.*mp start/);
  });
});
