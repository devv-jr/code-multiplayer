import { realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initConfig, isValidUser, loadConfig } from "../src/config.js";
import { getLocalConfig, git } from "../src/git.js";
import { makeTeam, makeTempDir, removeDir, type Team } from "./helpers.js";

describe("isValidUser", () => {
  it("acepta minúsculas, números, guion y guion bajo (2 a 20)", () => {
    for (const user of ["bruno", "yered", "b2", "ana-maria", "dev_01", "a".repeat(20)]) {
      expect(isValidUser(user), user).toBe(true);
    }
  });

  it("rechaza lo demás", () => {
    for (const user of ["", "b", "Bruno", "bruno ", "a b", "ñu", "a/b", "../x", "a".repeat(21)]) {
      expect(isValidUser(user), user).toBe(false);
    }
  });
});

describe("mp init", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  const saved = (key: string) => getLocalConfig(team.yered, key);

  it("guarda usuario y remoto en la config local, y loadConfig los lee", async () => {
    const config = await initConfig(team.yered, { user: "yered" });

    expect(config.user).toBe("yered");
    expect(config.remote).toBe("origin");
    expect(await realpath(config.repoRoot)).toBe(team.yered);
    expect(await saved("mp.user")).toBe("yered");
    expect(await saved("mp.remote")).toBe("origin");

    expect(await loadConfig(team.yered)).toEqual(config);
    // No agrega archivos al proyecto.
    expect(await git(["status", "--porcelain=v1"], { cwd: team.yered })).toBe("");
  });

  it("sin --user pregunta el nombre y sugiere el ya guardado", async () => {
    const suggestions: (string | null)[] = [];
    const ask = (answer: string) => async (suggestion: string | null) => {
      suggestions.push(suggestion);
      return answer;
    };

    await initConfig(team.yered, {}, ask("  yered  "));
    await initConfig(team.yered, {}, ask("yered2"));

    expect(suggestions).toEqual([null, "yered"]);
    expect(await saved("mp.user")).toBe("yered2");
  });

  it("sin --user y sin terminal interactiva pide usar --user", async () => {
    await expect(initConfig(team.yered)).rejects.toThrow(/mp init --user <nombre>/);
  });

  it("rechaza un usuario inválido y no guarda nada", async () => {
    await expect(initConfig(team.yered, { user: "Yered!" })).rejects.toThrow(
      /Usuario inválido: "Yered!"/,
    );
    expect(await saved("mp.user")).toBeNull();
  });

  it("falla con mensaje claro si no existe el remoto", async () => {
    await git(["remote", "remove", "origin"], { cwd: team.yered });

    await expect(initConfig(team.yered, { user: "yered" })).rejects.toThrow(
      /no tiene el remoto "origin".*git remote add origin <url>/s,
    );
  });

  it("--remote usa otro remoto y lo recuerda", async () => {
    await git(["remote", "rename", "origin", "github"], { cwd: team.yered });

    await initConfig(team.yered, { user: "yered", remote: "github" });

    expect((await loadConfig(team.yered)).remote).toBe("github");
    // Un init posterior sin --remote conserva el guardado.
    expect((await initConfig(team.yered, { user: "yered" })).remote).toBe("github");
  });

  it("si no hay acceso al remoto, lo dice y no guarda nada", async () => {
    await git(["remote", "set-url", "origin", path.join(team.root, "no-existe.git")], {
      cwd: team.yered,
    });

    await expect(initConfig(team.yered, { user: "yered" })).rejects.toThrow(
      /Revisa tu conexión y tus credenciales/,
    );
    expect(await saved("mp.user")).toBeNull();
  });

  it("fuera de un repo falla con mensaje claro", async () => {
    const dir = await makeTempDir();
    try {
      await expect(initConfig(dir, { user: "yered" })).rejects.toThrow(
        /no está dentro de un repositorio git/,
      );
    } finally {
      await removeDir(dir);
    }
  });
});

describe("loadConfig", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  it("sin configurar, indica correr mp init", async () => {
    await expect(loadConfig(team.yered)).rejects.toThrow(/mp init/);
  });

  it("funciona desde una subcarpeta del repo", async () => {
    await initConfig(team.bruno, { user: "bruno" });

    const config = await loadConfig(path.join(team.bruno, ".git", ".."));

    expect(config.user).toBe("bruno");
  });

  it("avisa si el remoto guardado ya no existe", async () => {
    await initConfig(team.yered, { user: "yered" });
    await git(["remote", "remove", "origin"], { cwd: team.yered });

    await expect(loadConfig(team.yered)).rejects.toThrow(/no tiene el remoto "origin"/);
  });

  it("rechaza un usuario guardado a mano que no es válido", async () => {
    await git(["config", "--local", "mp.user", "../heads/main"], { cwd: team.yered });

    await expect(loadConfig(team.yered)).rejects.toThrow(/no es válido/);
  });
});
