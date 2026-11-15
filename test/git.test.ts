import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureGit,
  getGitDir,
  getHead,
  getLocalConfig,
  getRepoRoot,
  git,
  GitError,
  hasRemote,
  parseGitVersion,
  runGit,
  setLocalConfig,
} from "../src/git.js";
import { initRepo, makeTempDir, removeDir } from "./helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await removeDir(dir);
});

describe("parseGitVersion", () => {
  it("lee la versión en Windows, macOS y Linux", () => {
    expect(parseGitVersion("git version 2.56.0.windows.2")).toEqual([2, 56]);
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual([2, 39]);
    expect(parseGitVersion("git version 2.30.0")).toEqual([2, 30]);
  });

  it("devuelve null si no hay versión", () => {
    expect(parseGitVersion("algo raro")).toBeNull();
  });
});

describe("ensureGit", () => {
  it("acepta el git instalado", async () => {
    await expect(ensureGit()).resolves.toMatch(/^\d+\.\d+$/);
  });
});

describe("runGit y git", () => {
  it("runGit no lanza cuando git falla; devuelve el código y stderr", async () => {
    await initRepo(dir);
    const result = await runGit(["rev-parse", "--verify", "no-existe"], { cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe("");
  });

  it("git lanza GitError con el detalle cuando git falla", async () => {
    await initRepo(dir);
    const error = await git(["rev-parse", "--verify", "no-existe"], { cwd: dir }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).exitCode).not.toBe(0);
    expect((error as GitError).args).toEqual(["rev-parse", "--verify", "no-existe"]);
  });

  it("da un error claro si la carpeta no existe", async () => {
    const missing = path.join(dir, "no-existe");
    await expect(runGit(["status"], { cwd: missing })).rejects.toThrow(/La carpeta no existe/);
  });

  it("pasa variables de entorno extra a git", async () => {
    await initRepo(dir);
    const ident = await git(["var", "GIT_AUTHOR_IDENT"], {
      cwd: dir,
      env: { GIT_AUTHOR_NAME: "Otro Nombre" },
    });
    expect(ident).toContain("Otro Nombre");
  });

  it("no rompe argumentos con espacios ni caracteres de shell", async () => {
    await initRepo(dir);
    const value = 'hola "mundo" & $HOME; echo x';
    await setLocalConfig(dir, "mp.prueba", value);
    expect(await getLocalConfig(dir, "mp.prueba")).toBe(value);
  });
});

describe("consultas del repo", () => {
  it("getRepoRoot devuelve la raíz, también desde una subcarpeta", async () => {
    await initRepo(dir);
    const sub = path.join(dir, "a", "b con espacio");
    await mkdir(sub, { recursive: true });

    expect(await realpath(await getRepoRoot(dir))).toBe(dir);
    expect(await realpath(await getRepoRoot(sub))).toBe(dir);
  });

  it("getRepoRoot falla con mensaje claro fuera de un repo", async () => {
    await expect(getRepoRoot(dir)).rejects.toThrow(/no está dentro de un repositorio git/);
  });

  it("getGitDir devuelve la carpeta .git", async () => {
    await initRepo(dir);
    expect(await realpath(await getGitDir(dir))).toBe(path.join(dir, ".git"));
  });

  it("getHead es null sin commits y un hash después del primer commit", async () => {
    await initRepo(dir);
    expect(await getHead(dir)).toBeNull();

    await writeFile(path.join(dir, "a.txt"), "hola\n");
    await git(["add", "a.txt"], { cwd: dir });
    await git(["commit", "--quiet", "-m", "primer commit"], { cwd: dir });

    expect(await getHead(dir)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("getLocalConfig devuelve null si la clave no existe", async () => {
    await initRepo(dir);
    expect(await getLocalConfig(dir, "mp.user")).toBeNull();
  });

  it("setLocalConfig guarda y getLocalConfig lee", async () => {
    await initRepo(dir);
    await setLocalConfig(dir, "mp.user", "bruno");
    expect(await getLocalConfig(dir, "mp.user")).toBe("bruno");
  });

  it("hasRemote detecta si existe el remoto", async () => {
    await initRepo(dir);
    expect(await hasRemote(dir, "origin")).toBe(false);
    await git(["remote", "add", "origin", "https://example.com/repo.git"], { cwd: dir });
    expect(await hasRemote(dir, "origin")).toBe(true);
  });
});
