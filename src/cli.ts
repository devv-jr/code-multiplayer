#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { initConfig, loadConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { getHead, runGitInTerminal } from "./git.js";
import { peekToJson, preparePeek } from "./peek.js";
import { createFetcher } from "./ui-fetcher.js";
import { startUiServer } from "./ui-server.js";
import { getWho, renderWho, whoToJson } from "./who.js";

const MIN_INTERVAL_SEC = 5;

const program = new Command();

program
  .name("mp")
  .description("Code Multiplayer: ve el trabajo sin commit de tu compañero")
  .version("0.1.0");

/** Pregunta el nombre de usuario por terminal. */
async function askUser(saved: string | null): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = saved ? ` [${saved}]` : " (ej. bruno)";
    const answer = await rl.question(`Tu nombre de usuario en mp${hint}: `);
    return answer.trim() || saved || "";
  } finally {
    rl.close();
  }
}

program
  .command("init")
  .description("Configura mp en este repo (tu usuario y el remoto)")
  .option("--user <nombre>", "tu nombre de usuario (ej. bruno)")
  .option("--remote <nombre>", 'remoto a usar (por defecto "origin")')
  .action(async (options: { user?: string; remote?: string }) => {
    // Solo preguntamos si hay una terminal interactiva.
    const ask = process.stdin.isTTY ? askUser : undefined;
    const config = await initConfig(process.cwd(), options, ask);

    console.log(`${pc.green("✓")} mp configurado`);
    console.log(`  repo:    ${config.repoRoot}`);
    console.log(`  usuario: ${config.user}`);
    console.log(`  remoto:  ${config.remote}`);
    if (!(await getHead(config.repoRoot))) {
      console.log(
        `${pc.yellow("!")} Este repo todavía no tiene commits: haz el primero antes de mp start.`,
      );
    }
    console.log(`Siguiente paso: ${pc.bold("mp start")}`);
  });

program
  .command("start")
  .description("Inicia el daemon que sube tu trabajo sin commit (Ctrl+C para detener)")
  .option("--interval <seg>", "segundos entre instantáneas (mínimo 5)", "15")
  .action(async (options: { interval: string }) => {
    const interval = Number(options.interval);
    if (!Number.isFinite(interval) || interval < MIN_INTERVAL_SEC) {
      throw new Error(
        `--interval debe ser un número de segundos, mínimo ${MIN_INTERVAL_SEC}.`,
      );
    }

    const config = await loadConfig(process.cwd());

    // Ctrl+C (SIGINT) y SIGTERM no matan el proceso de golpe: abortan la
    // señal, el daemon termina su ciclo, suelta el lock y salimos con 0.
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    console.log(
      `mp: subiendo el wip de ${pc.bold(config.user)} a ${config.remote} cada ${interval} s. Ctrl+C para detener.`,
    );
    await runDaemon({ ...config, intervalMs: interval * 1000, signal: controller.signal });
    console.log("mp detenido.");
  });

program
  .command("who")
  .description("Muestra quién está trabajando y cuánto cambió")
  .option("--json", "imprimir los datos como JSON")
  .action(async (options: { json?: boolean }) => {
    const config = await loadConfig(process.cwd());
    const entries = await getWho(config);
    if (options.json) {
      console.log(JSON.stringify(whoToJson(entries), null, 2));
    } else {
      console.log(renderWho(entries));
    }
  });

program
  .command("peek <usuario>")
  .description("Muestra el diff del trabajo sin commit de un usuario")
  .option("--stat", "solo el resumen por archivo")
  .option("--file <ruta>", "limitar el diff a un archivo o carpeta")
  .option("--json", "imprimir los datos como JSON")
  .action(async (user: string, options: { stat?: boolean; file?: string; json?: boolean }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const peek = await preparePeek(config, user, options, cwd);

    if (options.json) {
      console.log(JSON.stringify(await peekToJson(user, peek, cwd), null, 2));
      return;
    }

    if (!peek.hasChanges) {
      const where = options.file ? ` en ${options.file}` : "";
      console.log(`${user} no tiene cambios${where} respecto a tu base.`);
      return;
    }
    await runGitInTerminal(peek.diffArgs, cwd);
  });

program
  .command("ui")
  .description("Abre el panel web local (solo lectura; Ctrl+C para salir)")
  .option("--port <n>", "puerto del panel", "4777")
  .option("--interval <seg>", "segundos entre actualizaciones (mínimo 5)", "10")
  .option("--no-open", "no abrir el navegador")
  .action(async (options: { port: string; interval: string; open: boolean }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("--port debe ser un número de puerto entre 1 y 65535.");
    }
    const interval = Number(options.interval);
    if (!Number.isFinite(interval) || interval < MIN_INTERVAL_SEC) {
      throw new Error(
        `--interval debe ser un número de segundos, mínimo ${MIN_INTERVAL_SEC}.`,
      );
    }

    const config = await loadConfig(process.cwd());
    const fetcher = createFetcher(config, { intervalMs: interval * 1000 });
    await fetcher.refresh(); // primer estado antes de aceptar conexiones
    const server = await startUiServer({ config, fetcher, port });

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    console.log(`mp: panel en ${server.url}  (Ctrl+C para salir)`);
    const fetchState = fetcher.getState()?.fetch;
    if (fetchState && !fetchState.ok) {
      console.log(
        `${pc.yellow("!")} no pude actualizar desde el remoto (se reintenta solo): ${fetchState.error ?? ""}`,
      );
    }
    if (options.open) {
      // Si el navegador no abre, el panel sigue disponible en la URL.
      await open(server.url).catch(() => {
        console.log(`${pc.yellow("!")} no pude abrir el navegador; abre la URL a mano.`);
      });
    }

    await fetcher.run(controller.signal);
    await server.close();
    console.log("mp detenido.");
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  // Mensaje claro en vez de un stack trace.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${pc.red("Error:")} ${message}`);
  process.exitCode = 1;
}
