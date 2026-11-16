import { chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Check,
  checkPushAccess,
  hasFailures,
  parseNodeMajor,
  renderDoctor,
  runDoctor,
} from "../src/doctor.js";
import { git, runGit } from "../src/git.js";
import { getWho } from "../src/who.js";
import {
  commitAll,
  initRepo,
  makeTeam,
  makeTempDir,
  removeDir,
  runCli,
  type Team,
  write,
} from "./helpers.js";

/** Busca la comprobación cuyo título contiene el texto. */
const find = (checks: Check[], text: string) => checks.find((check) => check.title.includes(text));

/** Hace que el remoto rechace cualquier push a refs/wip/ (simula "sin permiso"). */
async function rejectWipPushes(remote: string): Promise<void> {
  const hook = path.join(remote, "hooks", "pre-receive");
  await write(
    remote,
    "hooks/pre-receive",
    '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/wip/*) echo "sin permiso para $ref" >&2; exit 1 ;; esac\ndone\nexit 0\n',
  );
  await chmod(hook, 0o755);
}

const remoteWipRefs = async (remote: string) =>
  (await runGit(["for-each-ref", "--format=%(refname)", "refs/wip"], { cwd: remote })).stdout.trim();

describe("parseNodeMajor", () => {
  it("lee la versión mayor de Node", () => {
    expect(parseNodeMajor("v24.21.0")).toBe(24);
    expect(parseNodeMajor("20.11.1")).toBe(20);
    expect(parseNodeMajor("v18.19.0\n")).toBe(18);
    expect(parseNodeMajor("algo raro")).toBeNull();
  });
});

describe("mp doctor", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
    await git(["config", "--local", "mp.user", "yered"], { cwd: team.yered });
    await write(team.bruno, ".gitattributes", "* text=auto\n");
    await commitAll(team.bruno, "gitattributes");
    await git(["push", "--quiet", "origin", "main"], { cwd: team.bruno });
    await git(["pull", "--quiet"], { cwd: team.yered });
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  const doctor = (cwd = team.yered, options = {}) =>
    runDoctor(cwd, { platform: "darwin", ...options });

  it("todo en verde en un repo sano, y no deja la ref de prueba en el remoto", async () => {
    const checks = await doctor();

    expect(checks.map((check) => check.status)).toEqual(Array(9).fill("ok"));
    expect(hasFailures(checks)).toBe(false);
    expect(find(checks, "git ")).toBeDefined();
    expect(find(checks, "Node ")).toBeDefined();
    expect(find(checks, "Tu usuario de mp: yered")).toBeDefined();
    expect(find(checks, "Puedo leer del remoto")).toBeDefined();
    expect(find(checks, "Puedes subir a refs/wip/")!.title).toContain("la borré");
    expect(renderDoctor(checks)).toContain("Todo bien. Siguiente paso: mp up");

    expect(await remoteWipRefs(team.remote)).toBe("");
    // Y no tocó el repo.
    expect(await git(["status", "--porcelain=v1"], { cwd: team.yered })).toBe("");
  });

  it("Node viejo: lo marca con la forma de instalarlo", async () => {
    const node = find(await doctor(team.yered, { nodeVersion: "v18.19.0", quick: true }), "Node")!;

    expect(node.status).toBe("fail");
    expect(node.fix).toContain("brew install node");
    expect(node.fix).toContain("winget install OpenJS.NodeJS.LTS");
  });

  it("fuera de un repo: lo dice y se salta lo que depende de eso", async () => {
    const dir = await makeTempDir();
    try {
      const checks = await doctor(dir);

      expect(find(checks, "no es un repo git")!.status).toBe("fail");
      expect(find(checks, "Remoto compartido")!.status).toBe("skip");
      expect(find(checks, "Leer del remoto")!.status).toBe("skip");
      expect(find(checks, "Subir al remoto")!.status).toBe("skip");
      expect(hasFailures(checks)).toBe(true);
      expect(renderDoctor(checks)).toContain("1 problema por arreglar");
    } finally {
      await removeDir(dir);
    }
  });

  it("sin commits: explica cómo hacer el primero", async () => {
    const dir = await makeTempDir();
    try {
      await initRepo(dir);
      const check = find(await doctor(dir, { quick: true }), "ningún commit")!;

      expect(check.status).toBe("fail");
      expect(check.fix).toContain("git commit -m");
    } finally {
      await removeDir(dir);
    }
  });

  it("sin remoto: explica cómo agregarlo y se salta la red", async () => {
    await git(["remote", "remove", "origin"], { cwd: team.yered });

    const checks = await doctor();

    const remote = find(checks, 'no tiene el remoto "origin"')!;
    expect(remote.status).toBe("fail");
    expect(remote.fix).toContain("git remote add origin");
    expect(find(checks, "Leer del remoto")!.status).toBe("skip");
    expect(find(checks, "Subir al remoto")!.status).toBe("skip");
  });

  it("mp.user ausente o inválido", async () => {
    await git(["config", "--local", "--unset", "mp.user"], { cwd: team.yered });
    const missing = find(await doctor(team.yered, { quick: true }), "Falta tu usuario de mp")!;
    expect(missing.status).toBe("fail");
    expect(missing.fix).toContain("mp init");

    await git(["config", "--local", "mp.user", "Yered Pérez"], { cwd: team.yered });
    const invalid = find(await doctor(team.yered, { quick: true }), "no es válido")!;
    expect(invalid.status).toBe("fail");
  });

  it("remoto inaccesible: falla la lectura y no intenta subir", async () => {
    await git(["remote", "set-url", "origin", path.join(team.root, "no-existe.git")], {
      cwd: team.yered,
    });

    const checks = await doctor();

    expect(find(checks, "No pude leer del remoto")!.status).toBe("fail");
    expect(find(checks, "Subir al remoto")!.status).toBe("skip");
  });

  it("remoto sin permiso de escritura en refs/wip: lo detecta y no deja basura", async () => {
    await rejectWipPushes(team.remote);

    const checks = await doctor();

    expect(find(checks, "Puedo leer del remoto")!.status).toBe("ok");
    const push = find(checks, "No pude subir a refs/wip/")!;
    expect(push.status).toBe("fail");
    expect(push.why).toContain("permiso de escritura");
    expect(push.fix).toContain("colaborador");
    expect(hasFailures(checks)).toBe(true);
    expect(await remoteWipRefs(team.remote)).toBe("");
  });

  it("archivo sensible sin ignorar: lo marca con las líneas para .gitignore", async () => {
    await write(team.yered, "config/.env.local", "CLAVE=1\n");

    const check = find(await doctor(team.yered, { quick: true }), "parecen secretos")!;

    expect(check.status).toBe("fail");
    expect(check.title).toContain("config/.env.local");
    expect(check.fix).toMatch(/^ {4}\.env\.local$/m);
  });

  it("sin .gitattributes: aviso informativo, no un error", async () => {
    const checks = await doctor(team.yered, { quick: true });
    expect(find(checks, "Finales de línea normalizados")!.status).toBe("ok");

    const dir = await makeTempDir();
    try {
      await initRepo(dir);
      await write(dir, "a.txt", "x\n");
      await commitAll(dir, "base");
      const check = find(await doctor(dir, { quick: true }), "no normaliza los finales de línea")!;

      expect(check.status).toBe("warn");
      expect(check.fix).toContain("* text=auto");
      // Un aviso no cuenta como fallo de esa comprobación.
      expect(hasFailures([check])).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });

  it("solo en Windows con PowerShell recuerda usar codemp", async () => {
    const inPowerShell = { PSModulePath: `${path.join(os.homedir(), "Documents", "WindowsPowerShell", "Modules")};C:\\Windows\\system32` };
    const inCmd = { PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules" };
    const run = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
      runDoctor(team.yered, { quick: true, platform, env });

    const powershell = find(await run("win32", inPowerShell), "codemp")!;
    expect(powershell.status).toBe("warn");
    expect(find(await run("win32", inCmd), "codemp")).toBeUndefined();
    expect(find(await run("darwin", inPowerShell), "codemp")).toBeUndefined();
  });

  it("modo rápido: no toca la red", async () => {
    await git(["remote", "set-url", "origin", path.join(team.root, "no-existe.git")], {
      cwd: team.yered,
    });

    const checks = await doctor(team.yered, { quick: true });

    expect(hasFailures(checks)).toBe(false);
    expect(find(checks, "leer del remoto")).toBeUndefined();
  });
});

describe("la ref de prueba de mp doctor", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  it("es un commit vacío bajo refs/wip/DOCTOR… y se borra al terminar", async () => {
    const push = await checkPushAccess(team.yered, "origin", "yered");

    expect(push).toMatchObject({ ok: true, cleaned: true });
    expect(push.ref).toMatch(/^refs\/wip\/DOCTOR\.yered\.[0-9a-f]{6}$/);
    expect(await remoteWipRefs(team.remote)).toBe("");
  });

  it("si quedara en el remoto, mp who y el panel la ignoran (no es un jugador)", async () => {
    // Se deja a propósito una ref con ese nombre, como si no se hubiera borrado.
    const head = await git(["rev-parse", "HEAD"], { cwd: team.bruno });
    await git(["push", "--quiet", "origin", `${head}:refs/wip/DOCTOR.bruno.abc123`], {
      cwd: team.bruno,
    });

    const entries = await getWho({ repoRoot: team.yered, user: "yered", remote: "origin" });

    expect(entries).toEqual([]);
  });
});

describe("comandos doctor e init (CLI real)", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  it("mp doctor: código 0 si todo lo necesario está bien", async () => {
    await git(["config", "--local", "mp.user", "yered"], { cwd: team.yered });

    const result = await runCli(["doctor"], team.yered);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ Tu usuario de mp: yered");
    expect(result.stdout).toContain("⚠ El repo no normaliza los finales de línea");
    expect(result.stdout).toContain("Siguiente paso: mp up");
  });

  it("mp doctor: código distinto de cero y la solución cuando algo falla", async () => {
    const result = await runCli(["doctor"], team.yered);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("✗ Falta tu usuario de mp");
    expect(result.stdout).toContain("Solución: Corre: mp init");
    expect(result.stdout).toContain("1 problema por arreglar");
  });

  it("mp init avisa si no hay permiso de escritura, pero guarda la configuración", async () => {
    await rejectWipPushes(team.remote);

    const result = await runCli(["init", "--user", "yered"], team.yered);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ mp configurado");
    expect(result.stdout).toContain("No pude subir a refs/wip/");
    expect(result.stdout).toContain("La configuración quedó guardada");
    expect(await git(["config", "--local", "mp.user"], { cwd: team.yered })).toBe("yered");
  });

  it("mp init con permiso: lo confirma y no deja la ref de prueba", async () => {
    const result = await runCli(["init", "--user", "yered"], team.yered);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ Puedes subir a refs/wip/");
    expect(await remoteWipRefs(team.remote)).toBe("");
  });
});
