import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { createSnapshot, NoCommitsError, wipRef } from "../src/snapshot.js";
import { commitAll, initRepo, makeTempDir, removeDir, write } from "./helpers.js";

let repo: string;

beforeEach(async () => {
  repo = await makeTempDir();
  await initRepo(repo);
});

afterEach(async () => {
  await removeDir(repo);
});

/** Lista de archivos dentro de un commit. */
async function filesIn(commit: string): Promise<string[]> {
  const output = await git(["ls-tree", "-r", "--name-only", commit], { cwd: repo });
  return output === "" ? [] : output.split("\n");
}

/** Contenido de un archivo dentro de un commit. */
function contentIn(commit: string, file: string): Promise<string> {
  return git(["cat-file", "blob", `${commit}:${file}`], { cwd: repo });
}

describe("createSnapshot", () => {
  it("no modifica el índice, la rama ni el working tree del usuario", async () => {
    await write(repo, "tracked.txt", "uno\n");
    await write(repo, "staged.txt", "uno\n");
    await write(repo, "deleted.txt", "uno\n");
    await commitAll(repo, "base");

    // Mezcla de estados: modificado, preparado (staged), preparado y luego
    // vuelto a modificar, borrado y nuevo sin trackear.
    await write(repo, "tracked.txt", "dos\n");
    await write(repo, "staged.txt", "dos\n");
    await git(["add", "staged.txt"], { cwd: repo });
    await write(repo, "staged.txt", "tres\n");
    await rm(path.join(repo, "deleted.txt"));
    await write(repo, "nuevo.txt", "nuevo\n");

    const state = async () => ({
      // status primero: él mismo puede refrescar el índice.
      status: await git(["status", "--porcelain=v1", "--branch"], { cwd: repo }),
      head: await git(["rev-parse", "HEAD"], { cwd: repo }),
      branch: await git(["symbolic-ref", "HEAD"], { cwd: repo }),
      staged: await git(["diff", "--cached"], { cwd: repo }),
      branches: await git(["for-each-ref", "refs/heads"], { cwd: repo }),
      index: (await readFile(path.join(repo, ".git", "index"))).toString("hex"),
      tracked: await readFile(path.join(repo, "tracked.txt"), "utf8"),
      stagedFile: await readFile(path.join(repo, "staged.txt"), "utf8"),
      nuevo: await readFile(path.join(repo, "nuevo.txt"), "utf8"),
    });

    const before = await state();
    const snapshot = await createSnapshot(repo, "bruno");
    const after = await state();

    expect(after).toEqual(before);
    expect(snapshot.created).toBe(true);

    // Y la instantánea sí refleja el working tree (no lo "staged").
    expect(await filesIn(snapshot.commit)).toEqual(["nuevo.txt", "staged.txt", "tracked.txt"]);
    expect(await contentIn(snapshot.commit, "tracked.txt")).toBe("dos");
    expect(await contentIn(snapshot.commit, "staged.txt")).toBe("tres");
  });

  it("crea un commit suelto con HEAD como padre y lo deja en refs/wip/<usuario>", async () => {
    await write(repo, "a.txt", "uno\n");
    const head = await commitAll(repo, "base");
    await write(repo, "a.txt", "dos\n");

    const snapshot = await createSnapshot(repo, "bruno");

    expect(snapshot.ref).toBe("refs/wip/bruno");
    expect(snapshot.parent).toBe(head);
    expect(snapshot.branch).toBe("main");
    expect(await git(["rev-parse", wipRef("bruno")], { cwd: repo })).toBe(snapshot.commit);
    expect(await git(["rev-parse", `${snapshot.commit}^`], { cwd: repo })).toBe(head);
    expect(await git(["log", "-1", "--format=%s", snapshot.commit], { cwd: repo })).toMatch(
      /^mp wip bruno \d{4}-\d{2}-\d{2}T/,
    );
  });

  it("si no hay cambios, no crea un commit nuevo", async () => {
    await write(repo, "a.txt", "uno\n");
    await commitAll(repo, "base");
    await write(repo, "a.txt", "dos\n");

    const first = await createSnapshot(repo, "bruno");
    const second = await createSnapshot(repo, "bruno");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.commit).toBe(first.commit);
    expect(await git(["rev-parse", wipRef("bruno")], { cwd: repo })).toBe(first.commit);
  });

  it("crea un commit nuevo cuando cambia un archivo, el commit base o la rama", async () => {
    await write(repo, "a.txt", "uno\n");
    await commitAll(repo, "base");
    const first = await createSnapshot(repo, "bruno");

    await write(repo, "a.txt", "dos\n");
    const second = await createSnapshot(repo, "bruno");
    expect(second.created).toBe(true);
    expect(second.commit).not.toBe(first.commit);

    // Mismo contenido, pero ahora con commit: cambia el padre.
    const head = await commitAll(repo, "segundo");
    const third = await createSnapshot(repo, "bruno");
    expect(third.created).toBe(true);
    expect(third.tree).toBe(second.tree);
    expect(third.parent).toBe(head);

    // Mismo contenido y mismo commit, pero en otra rama.
    await git(["switch", "--quiet", "-c", "feature/x"], { cwd: repo });
    const fourth = await createSnapshot(repo, "bruno");
    expect(fourth.created).toBe(true);
    expect(fourth.branch).toBe("feature/x");

    expect((await createSnapshot(repo, "bruno")).created).toBe(false);
  });

  it("los archivos ignorados por .gitignore no entran", async () => {
    await write(repo, ".gitignore", "secreto.env\nnode_modules/\n");
    await write(repo, "a.txt", "uno\n");
    await commitAll(repo, "base");

    await write(repo, "secreto.env", "CLAVE=123\n");
    await write(repo, "node_modules/lib/index.js", "x\n");
    await write(repo, "a.txt", "dos\n");

    const snapshot = await createSnapshot(repo, "bruno");

    expect(await filesIn(snapshot.commit)).toEqual([".gitignore", "a.txt"]);
  });

  it("los archivos nuevos sin trackear sí entran", async () => {
    await write(repo, "a.txt", "uno\n");
    await commitAll(repo, "base");

    await write(repo, "nuevo.txt", "hola\n");
    await write(repo, "carpeta nueva/otro archivo.txt", "con espacios\n");

    const snapshot = await createSnapshot(repo, "bruno");

    expect(await filesIn(snapshot.commit)).toEqual([
      "a.txt",
      "carpeta nueva/otro archivo.txt",
      "nuevo.txt",
    ]);
    expect(await contentIn(snapshot.commit, "nuevo.txt")).toBe("hola");
  });

  it("los archivos borrados desaparecen de la instantánea", async () => {
    await write(repo, "a.txt", "uno\n");
    await write(repo, "b.txt", "uno\n");
    await commitAll(repo, "base");
    await rm(path.join(repo, "b.txt"));

    const snapshot = await createSnapshot(repo, "bruno");

    expect(await filesIn(snapshot.commit)).toEqual(["a.txt"]);
  });

  it("con working tree limpio, la instantánea es igual a HEAD", async () => {
    await write(repo, "a.txt", "uno\n");
    await commitAll(repo, "base");

    const snapshot = await createSnapshot(repo, "bruno");

    expect(snapshot.tree).toBe(await git(["rev-parse", "HEAD^{tree}"], { cwd: repo }));
  });

  it("con core.autocrlf, los finales CRLF no generan un diff falso", async () => {
    // Caso Windows: el repo guarda LF y el archivo en disco tiene CRLF.
    await write(repo, "a.txt", "uno\ndos\n");
    await commitAll(repo, "base");
    await git(["config", "--local", "core.autocrlf", "true"], { cwd: repo });
    await write(repo, "a.txt", "uno\r\ndos\r\n");

    const snapshot = await createSnapshot(repo, "bruno");

    expect(snapshot.tree).toBe(await git(["rev-parse", "HEAD^{tree}"], { cwd: repo }));
  });

  it("funciona aunque git no tenga user.name ni user.email configurados", async () => {
    await write(repo, "a.txt", "uno\n");
    await commitAll(repo, "base");
    await git(["config", "--local", "--unset", "user.name"], { cwd: repo });
    await git(["config", "--local", "--unset", "user.email"], { cwd: repo });
    // user.useConfigOnly impide que git invente una identidad con el nombre
    // del equipo, para que la prueba dé lo mismo en cualquier máquina.
    await git(["config", "--local", "user.useConfigOnly", "true"], { cwd: repo });

    const snapshot = await createSnapshot(repo, "bruno");

    expect(snapshot.created).toBe(true);
    // Si la máquina tiene identidad global se usa esa; si no, la de respaldo.
    expect(await git(["log", "-1", "--format=%an", snapshot.commit], { cwd: repo })).not.toBe("");
  });

  it("cada usuario tiene su propia ref", async () => {
    await write(repo, "a.txt", "uno\n");
    await commitAll(repo, "base");

    const bruno = await createSnapshot(repo, "bruno");
    const yered = await createSnapshot(repo, "yered");

    expect(bruno.ref).toBe("refs/wip/bruno");
    expect(yered.ref).toBe("refs/wip/yered");
  });

  it("en un repo sin commits falla con un mensaje claro", async () => {
    await write(repo, "a.txt", "uno\n");

    const error = await createSnapshot(repo, "bruno").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoCommitsError);
    expect((error as Error).message).toMatch(/todavía no tiene commits/);
  });
});
