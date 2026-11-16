import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { type DaemonStatus, runDaemon } from "../src/daemon.js";
import { git, runGit } from "../src/git.js";
import { createSnapshot } from "../src/snapshot.js";
import {
  findSecretFiles,
  findSecretsInSnapshot,
  isSecretPath,
  secretIgnoreLine,
  SecretsError,
  secretsHelp,
} from "../src/secret-guard.js";
import {
  commitAll,
  initRepo,
  makeTeam,
  makeTempDir,
  removeDir,
  runCli,
  type Team,
  waitFor,
  write,
} from "./helpers.js";

describe("isSecretPath (solo por nombre)", () => {
  it("detecta cada tipo de archivo sensible", () => {
    const secrets = [
      ".env",
      ".env.local",
      ".env.production",
      "server.pem",
      "privada.key",
      "cert.p12",
      "cert.pfx",
      "android.keystore",
      "id_rsa",
      "id_ed25519",
      "credentials.json",
      "secrets.json",
      "secrets.yaml",
      "service-account.json",
      "service-account-prod.json",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".aws/credentials",
      ".aws/config",
      ".ssh/known_hosts",
      "copia/.ssh/config",
    ];
    for (const file of secrets) expect(isSecretPath(file), file).toBe(true);
  });

  it("permite las plantillas de .env y los archivos normales", () => {
    const safe = [
      ".env.example",
      ".env.sample",
      ".env.template",
      "README.md",
      "src/app.ts",
      "env.ts",
      "mi.env",
      "keys.ts",
      "llave.key.md",
      "secrets",
      "mis-secrets.json",
      "service-account.md",
      "id_rsa.pub",
      "aws/config",
      "package.json",
      ".key",
    ];
    for (const file of safe) expect(isSecretPath(file), file).toBe(false);
  });

  it("los detecta dentro de carpetas", () => {
    expect(isSecretPath("config/.env.local")).toBe(true);
    expect(isSecretPath("a/b/c/server.pem")).toBe(true);
    expect(isSecretPath("carpeta ñ/mi llave.key")).toBe(true);
  });

  it("no distingue mayúsculas de minúsculas", () => {
    for (const file of [".ENV", ".Env.Local", "SERVER.PEM", "ID_RSA", "Credentials.JSON", ".AWS/config"]) {
      expect(isSecretPath(file), file).toBe(true);
    }
    expect(isSecretPath(".ENV.EXAMPLE")).toBe(false);
  });

  it("da la línea exacta de .gitignore para cada caso", () => {
    expect(secretIgnoreLine(".env")).toBe(".env");
    expect(secretIgnoreLine("config/.env.local")).toBe(".env.local");
    expect(secretIgnoreLine("certs/server.pem")).toBe("*.pem");
    expect(secretIgnoreLine("secrets.yaml")).toBe("secrets.*");
    expect(secretIgnoreLine("service-account-prod.json")).toBe("service-account*.json");
    expect(secretIgnoreLine(".aws/credentials")).toBe(".aws/");
    expect(secretIgnoreLine("README.md")).toBeNull();
  });
});

describe("findSecretFiles", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempDir();
    await initRepo(repo);
    await write(repo, "README.md", "# demo\n");
    await commitAll(repo, "base");
  });
  afterEach(async () => {
    await removeDir(repo);
  });

  const found = async () => (await findSecretFiles(repo)).map((file) => file.path);

  it("un repo sin archivos sensibles da una lista vacía", async () => {
    await write(repo, "src/app.ts", "x\n");
    expect(await found()).toEqual([]);
  });

  it("marca un .env nuevo, pero no si está en .gitignore", async () => {
    await write(repo, ".env", "CLAVE=1\n");
    expect(await found()).toEqual([".env"]);

    await write(repo, ".gitignore", ".env\n");
    expect(await found()).toEqual([]);
  });

  it("permite .env.example y marca los anidados", async () => {
    await write(repo, ".env.example", "CLAVE=\n");
    await write(repo, "config/.env.local", "CLAVE=1\n");
    await write(repo, ".aws/credentials", "x\n");

    expect(await found()).toEqual([".aws/credentials", "config/.env.local"]);
  });

  it("rastreado con cambios sí; rastreado sin cambios no", async () => {
    await write(repo, ".npmrc", "registry=https://example.com\n");
    await commitAll(repo, "npmrc en el repo");
    expect(await found()).toEqual([]);

    await write(repo, ".npmrc", "//registry/:_authToken=abc\n");
    const files = await findSecretFiles(repo);
    expect(files).toEqual([{ path: ".npmrc", ignoreLine: ".npmrc", tracked: true }]);
  });

  it("un rastreado que se borró no cuenta (no sube contenido)", async () => {
    await write(repo, "server.pem", "x\n");
    await commitAll(repo, "pem en el repo");
    await rm(path.join(repo, "server.pem"));

    expect(await found()).toEqual([]);
  });

  it("nombres con mayúsculas, espacios y tildes", async () => {
    await write(repo, "Config/.ENV.Local", "x\n");
    await write(repo, "carpeta ñ/mi llave año.PEM", "x\n");

    expect(await found()).toEqual(["Config/.ENV.Local", "carpeta ñ/mi llave año.PEM"]);
  });

  it("no modifica el repo", async () => {
    await write(repo, ".env", "x\n");
    await write(repo, "preparado.txt", "x\n");
    await git(["add", "preparado.txt"], { cwd: repo });
    const status = () => git(["status", "--porcelain=v1"], { cwd: repo });
    const before = await status();

    await findSecretFiles(repo);

    expect(await status()).toBe(before);
  });
});

describe("findSecretsInSnapshot (lo que de verdad se subiría)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempDir();
    await initRepo(repo);
    await write(repo, "README.md", "# demo\n");
    await write(repo, ".npmrc", "registry=https://example.com\n");
    await write(repo, "viejo.pem", "x\n");
    await commitAll(repo, "base");
  });
  afterEach(async () => {
    await removeDir(repo);
  });

  it("ve un secreto que ya quedó dentro de la instantánea", async () => {
    // Caso de la carrera: el archivo se crea después de revisar la carpeta
    // y antes de tomar la instantánea. La instantánea ya lo trae.
    await write(repo, "config/.env.local", "CLAVE=1\n");
    await write(repo, "src/app.ts", "x\n");
    const snapshot = await createSnapshot(repo, "bruno");

    expect(await findSecretsInSnapshot(repo, snapshot.parent, snapshot.commit)).toEqual([
      { path: "config/.env.local", ignoreLine: ".env.local", tracked: false },
    ]);
  });

  it("marca un rastreado modificado, y no uno sin cambios ni uno borrado", async () => {
    await write(repo, ".npmrc", "//registry/:_authToken=abc\n");
    await rm(path.join(repo, "viejo.pem"));
    const snapshot = await createSnapshot(repo, "bruno");

    expect(await findSecretsInSnapshot(repo, snapshot.parent, snapshot.commit)).toEqual([
      { path: ".npmrc", ignoreLine: ".npmrc", tracked: true },
    ]);
  });

  it("una instantánea sin secretos da una lista vacía, con nombres raros incluidos", async () => {
    await write(repo, "carpeta ñ/año nuevo.txt", "x\n");
    const snapshot = await createSnapshot(repo, "bruno");

    expect(await findSecretsInSnapshot(repo, snapshot.parent, snapshot.commit)).toEqual([]);
  });
});

describe("mensajes de la guardia", () => {
  it("lista los archivos y las líneas exactas para .gitignore, sin comandos de shell", () => {
    const error = new SecretsError([
      { path: ".env", ignoreLine: ".env", tracked: false },
      { path: "certs/a.pem", ignoreLine: "*.pem", tracked: false },
      { path: "certs/b.pem", ignoreLine: "*.pem", tracked: false },
    ]);

    expect(error.message).toContain("No arranco");
    expect(error.message).toContain("    certs/a.pem");
    expect(error.message).toContain(".gitignore");
    expect(error.message.match(/^ {4}\*\.pem$/gm)).toHaveLength(1); // sin repetir
    expect(error.message).toContain("--allow-secrets");
    expect(error.message).not.toMatch(/echo|>>/);
  });

  it("explica que ignorar no basta para un archivo ya rastreado", () => {
    const help = secretsHelp([{ path: ".npmrc", ignoreLine: ".npmrc", tracked: true }]);

    expect(help).toContain("git ya los sigue");
    expect(help).toContain("    .npmrc");
  });
});

describe("la guardia en el daemon", () => {
  let team: Team;
  let bruno: Config;
  let controller: AbortController;
  let lines: string[];
  let status: DaemonStatus;

  beforeEach(async () => {
    team = await makeTeam();
    bruno = { repoRoot: team.bruno, user: "bruno", remote: "origin" };
    controller = new AbortController();
    lines = [];
    status = { uploadPausedFiles: [] };
  });
  afterEach(async () => {
    controller.abort();
    await removeDir(team.root);
  });

  const start = (extra: { allowSecrets?: boolean } = {}) =>
    runDaemon({
      ...bruno,
      intervalMs: 100,
      signal: controller.signal,
      log: (line) => lines.push(line),
      status,
      ...extra,
    });
  const count = (text: string) => lines.filter((line) => line.includes(text)).length;
  const remoteWip = async () =>
    (await runGit(["rev-parse", "--verify", "--quiet", "refs/wip/bruno"], { cwd: team.remote }))
      .stdout.trim();
  const remoteFiles = async () =>
    (await git(["ls-tree", "-r", "--name-only", "refs/wip/bruno"], { cwd: team.remote })).split("\n");

  it("se niega a arrancar antes de la primera instantánea y no sube ni deja nada", async () => {
    await write(team.bruno, ".env", "CLAVE=1\n");

    const error = await start().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretsError);
    expect((error as SecretsError).files.map((file) => file.path)).toEqual([".env"]);
    expect(await remoteWip()).toBe("");
    expect((await runGit(["rev-parse", "--verify", "--quiet", "refs/wip/bruno"], { cwd: team.bruno })).ok).toBe(false);
    expect(existsSync(path.join(team.bruno, ".git", "mp.lock"))).toBe(false);
  });

  it("--allow-secrets lo sube igual, con una advertencia visible", async () => {
    await write(team.bruno, ".env", "CLAVE=1\n");
    const daemon = start({ allowSecrets: true });

    await waitFor(() => count("✓ wip actualizado") === 1);

    expect(count("--allow-secrets: se van a subir")).toBe(1);
    expect(await remoteFiles()).toContain(".env");
    controller.abort();
    await daemon;
  });

  it("si aparece un secreto a mitad de sesión: pausa, avisa una vez, no sube nada y reanuda solo", async () => {
    await write(team.bruno, "a.txt", "uno\n");
    const daemon = start();
    await waitFor(() => count("✓ wip actualizado") === 1);
    const before = await remoteWip();

    // Aparece un .env y, además, cambia otro archivo.
    await write(team.bruno, ".env", "CLAVE=1\n");
    await write(team.bruno, "a.txt", "uno\ndos\n");
    await waitFor(() => count("subida en pausa") === 1);
    expect(status.uploadPausedFiles).toEqual([".env"]);
    expect(lines.find((line) => line.includes("subida en pausa"))).toContain("    .env");

    // Varios ciclos después: sigue vivo, avisó una sola vez y no subió nada.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(count("subida en pausa")).toBe(1);
    expect(count("✓ wip actualizado")).toBe(1);
    expect(await remoteWip()).toBe(before);
    expect(await git(["rev-parse", "refs/wip/bruno"], { cwd: team.bruno })).toBe(before);

    // Otro archivo sensible: es un conjunto distinto, avisa de nuevo.
    await write(team.bruno, "server.pem", "x\n");
    await waitFor(() => count("subida en pausa") === 2);
    expect(status.uploadPausedFiles).toEqual([".env", "server.pem"]);

    // El usuario los agrega a .gitignore: reanuda sin reiniciar.
    await write(team.bruno, ".gitignore", ".env\n*.pem\n");
    await waitFor(() => count("reanudo la subida") === 1);
    await waitFor(() => count("✓ wip actualizado") === 2);
    expect(status.uploadPausedFiles).toEqual([]);

    const files = await remoteFiles();
    expect(files).toContain("a.txt");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain(".env");
    expect(files).not.toContain("server.pem");

    controller.abort();
    await expect(daemon).resolves.toBeUndefined();
  });
});

describe("mp start con la guardia (CLI real)", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
    await git(["config", "--local", "mp.user", "bruno"], { cwd: team.bruno });
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  it("se niega, lista los archivos y termina con código distinto de cero", async () => {
    await write(team.bruno, "config/.env.local", "CLAVE=1\n");

    const result = await runCli(["start"], team.bruno);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No arranco");
    expect(result.stderr).toContain("config/.env.local");
    expect(result.stderr).toMatch(/^ {4}\.env\.local$/m);
    expect(result.stderr).not.toMatch(/\n\s+at /); // sin stack trace
    expect((await runGit(["for-each-ref", "refs/wip"], { cwd: team.remote })).stdout).toBe("");
  });
});
