// La CLI de verdad: ayuda, versión y mensajes de error.
// Regla de los errores: qué pasó, por qué y qué hacer; sin stack trace.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import {
  initRepo,
  makeTeam,
  makeTempDir,
  publish,
  removeDir,
  runCli,
  type Team,
  write,
} from "./helpers.js";

/** Un PATH vacío: el sistema no encuentra git. (En Windows la variable es "Path".) */
const NO_GIT = { PATH: "", Path: "" };
/** Sin rastro de un stack trace ("    at función (archivo:línea)"). */
const NO_STACK = /\n\s+at .+:\d+/;

describe("ayuda y versión", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("sin argumentos muestra la ayuda corta: solo up, doctor y who", async () => {
    const result = await runCli([], dir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/(code)?mp up +Empieza/);
    expect(result.stdout).toMatch(/(code)?mp doctor +Revisa/);
    expect(result.stdout).toMatch(/(code)?mp who +Muestra/);
    expect(result.stdout).toContain("--help");
    for (const advanced of ["init", "start", "peek", " ui"]) {
      expect(result.stdout, advanced).not.toContain(advanced);
    }
  });

  it("--help muestra todo, en español, con lo básico primero y lo avanzado aparte", async () => {
    const { stdout, exitCode } = await runCli(["--help"], dir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Uso:");
    expect(stdout).toContain("Opciones:");
    expect(stdout).not.toMatch(/Usage:|Options:|display help/);

    const basic = stdout.indexOf("Para empezar:");
    const advanced = stdout.indexOf("Avanzado:");
    expect(basic).toBeGreaterThan(-1);
    expect(advanced).toBeGreaterThan(basic);
    const basicBlock = stdout.slice(basic, advanced);
    for (const command of ["up", "doctor", "who"]) expect(basicBlock).toMatch(new RegExp(`^  ${command}\\b`, "m"));
    const advancedBlock = stdout.slice(advanced);
    for (const command of ["init", "start", "peek", "ui"]) {
      expect(advancedBlock).toMatch(new RegExp(`^  ${command}\\b`, "m"));
    }
  });

  it("--version y -v dan la versión de package.json", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      version: string;
    };

    expect((await runCli(["--version"], dir)).stdout.trim()).toBe(version);
    expect((await runCli(["-v"], dir)).stdout.trim()).toBe(version);
  });

  it("la ayuda de un comando sale en español", async () => {
    const { stdout } = await runCli(["help", "up"], dir);

    expect(stdout).toMatch(/Uso: (code)?mp up/);
    expect(stdout).toContain("--allow-secrets");
    expect(stdout).toContain("--no-open");
  });
});

describe("errores de uso", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  const fails = async (args: string[], message: RegExp) => {
    const result = await runCli(args, dir);
    expect(result.exitCode, args.join(" ")).toBe(1);
    expect(result.stderr, args.join(" ")).toMatch(message);
    expect(result.stderr).not.toMatch(/error: |unknown|missing|too many/); // nada en inglés
    expect(result.stderr).not.toMatch(NO_STACK);
  };

  it("comando que no existe, opción que no existe, dato faltante y palabras de más", async () => {
    await fails(["volar"], /Error: No existe el comando "volar".*--help/);
    await fails(["who", "--nada"], /Error: No existe la opción "--nada"/);
    await fails(["peek"], /Error: Falta un dato después del comando: <usuario>/);
    await fails(["up", "--port"], /Error: A la opción --port <n> le falta su valor/);
    await fails(["who", "sobra"], /Error: Sobran palabras después de "(code)?mp who"/);
  });
});

describe("errores comunes: qué pasó, por qué y qué hacer", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
    await git(["config", "--local", "mp.user", "yered"], { cwd: team.yered });
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  /** Corre un comando que debe fallar y revisa la forma del mensaje. */
  const fails = async (args: string[], cwd: string, env = {}) => {
    const result = await runCli(args, cwd, env);
    expect(result.exitCode, args.join(" ")).toBe(1);
    expect(result.stderr, args.join(" ")).toMatch(/^Error: /);
    expect(result.stderr, args.join(" ")).not.toMatch(NO_STACK);
    return result.stderr;
  };

  it("sin git instalado", async () => {
    for (const command of [["who"], ["start"], ["ui", "--no-open"], ["init", "--user", "yered"]]) {
      const stderr = await fails(command, team.yered, NO_GIT);
      expect(stderr).toContain("No encontré git en esta computadora");
      expect(stderr).toContain("Por qué:");
      expect(stderr).toMatch(/Qué hacer: instálalo.*brew install git.*winget install Git\.Git/);
    }
  });

  it("fuera de un repo", async () => {
    const dir = await makeTempDir();
    try {
      for (const command of [["who"], ["start"], ["peek", "bruno"], ["ui", "--no-open"], ["init", "--user", "x1"]]) {
        const stderr = await fails(command, dir);
        expect(stderr).toContain("no está dentro de un repositorio git");
        expect(stderr).toMatch(/Qué hacer: entra a la carpeta del proyecto con {2}cd/);
      }
    } finally {
      await removeDir(dir);
    }
  });

  it("sin remoto", async () => {
    await git(["remote", "remove", "origin"], { cwd: team.yered });

    for (const command of [["who"], ["start"], ["init", "--user", "yered"]]) {
      const stderr = await fails(command, team.yered);
      expect(stderr).toMatch(/no tiene el remoto "origin".*git remote add origin <url>/s);
    }
  });

  it("sin red (remoto inaccesible)", async () => {
    await git(["remote", "set-url", "origin", path.join(team.root, "no-existe.git")], {
      cwd: team.yered,
    });

    for (const command of [["who"], ["peek", "bruno"], ["init", "--user", "yered"]]) {
      const stderr = await fails(command, team.yered);
      expect(stderr).toContain('No se pudo traer el trabajo del remoto "origin"');
      expect(stderr).toContain("Por qué:");
      expect(stderr).toContain("Detalle:");
      expect(stderr).toMatch(/Qué hacer: comprueba tu internet.*git fetch origin/);
    }
  });

  it("sin commits", async () => {
    const empty = path.join(team.root, "vacio");
    await write(empty, "a.txt", "x\n");
    await initRepo(empty);
    await git(["remote", "add", "origin", team.remote], { cwd: empty });
    await git(["config", "--local", "mp.user", "yered"], { cwd: empty });

    const stderr = await fails(["start"], empty);

    expect(stderr).toContain("Este repo todavía no tiene commits");
    expect(stderr).toMatch(/Qué hacer: guarda un primer commit con {2}git add -A/);
  });

  it("usuario inexistente en peek", async () => {
    await publish({ repoRoot: team.bruno, user: "bruno", remote: "origin" });

    const stderr = await fails(["peek", "ana"], team.yered);

    expect(stderr).toContain('No hay trabajo subido de "ana". Usuarios disponibles: bruno');
    expect(stderr).toMatch(/Qué hacer: .*mp who/);
  });

  it("sin configurar: indica el siguiente paso", async () => {
    await git(["config", "--local", "--unset", "mp.user"], { cwd: team.yered });

    for (const command of [["who"], ["start"], ["peek", "bruno"], ["ui", "--no-open"]]) {
      expect(await fails(command, team.yered)).toContain("Corre primero: mp init");
    }
  });

  it("al final sugiere mp doctor y --debug; con --debug muestra el detalle técnico", async () => {
    const dir = await makeTempDir();
    try {
      const normal = await runCli(["who"], dir);
      expect(normal.stderr).toMatch(/¿No sabes qué hacer\? Corre: (code)?mp doctor/);
      expect(normal.stderr).toContain("--debug");
      expect(normal.stderr).not.toMatch(NO_STACK);

      // --debug funciona antes o después del comando.
      for (const args of [["who", "--debug"], ["--debug", "who"]]) {
        const debug = await runCli(args, dir);
        expect(debug.exitCode).toBe(1);
        expect(debug.stderr).toContain("no está dentro de un repositorio git");
        expect(debug.stderr).toContain("detalle técnico (--debug)");
        expect(debug.stderr).toContain("git rev-parse --show-toplevel");
        expect(debug.stderr).toMatch(NO_STACK);
      }
    } finally {
      await removeDir(dir);
    }
  });
});
