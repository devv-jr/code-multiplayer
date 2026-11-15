// Servidor HTTP local del panel: API de solo lectura, SSE y archivos de la UI.
//
// Sirve contenido del repo, así que la seguridad importa:
//   - Escucha solo en 127.0.0.1: nadie más en la red puede conectarse.
//   - Rechaza peticiones cuyo Host no sea localhost/127.0.0.1 con nuestro
//     puerto. Defiende contra "DNS rebinding": una página maliciosa que hace
//     que su dominio apunte a 127.0.0.1 para leer este servidor.
//   - No envía cabeceras CORS: otras páginas no pueden leer las respuestas.
//   - Solo acepta GET y nunca escribe en el repo.

import { readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { DIFF_MAX_BYTES } from "./core/constants.js";
import { getTreeFiles } from "./core/state.js";
import { PLAIN_DIFF, runGit } from "./git.js";
import { readWip, wipRef } from "./snapshot.js";
import type { Fetcher } from "./ui-fetcher.js";

const HOST = "127.0.0.1";
const PING_MS = 25_000;
/** Si el puerto está ocupado, se prueban este número de puertos siguientes. */
const PORT_RETRIES = 10;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>mp</title>
<p>La interfaz de mp todavía no está compilada. Corre <code>npm run build</code>.</p>
<p>La API ya funciona: <a href="/api/state">/api/state</a></p>`;

export interface UiServerOptions {
  config: Config;
  fetcher: Fetcher;
  /** Puerto deseado. Con 0 el sistema elige uno libre (para pruebas). */
  port: number;
  /** Carpeta con la UI compilada. Por defecto, "ui" junto a este archivo. */
  uiDir?: string;
}

export interface UiServer {
  port: number;
  url: string;
  /** Cierra el servidor y todas las conexiones abiertas (incluido SSE). */
  close(): Promise<void>;
}

/** Error de la API con su código HTTP. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const { config, fetcher } = options;
  // import.meta.url es una URL (file:///C:/...); fileURLToPath la convierte
  // bien a ruta en Windows y macOS.
  const uiDir = path.resolve(
    options.uiDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "ui"),
  );
  const streams = new Set<ServerResponse>();
  let port = options.port;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // No se registra el detalle: podría incluir contenido de diffs.
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "Error interno del servidor";
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const allowedHosts = [`${HOST}:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) {
      throw new HttpError(403, "Host no permitido");
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      throw new HttpError(405, "Solo se permite GET");
    }

    const url = new URL(req.url ?? "/", `http://${HOST}`);
    switch (url.pathname) {
      case "/api/state": {
        const state = fetcher.getState();
        if (!state) throw new HttpError(503, "El estado todavía no está listo");
        return sendJson(res, 200, state);
      }
      case "/api/tree":
        return sendJson(res, 200, await getTreeFiles(config.repoRoot));
      case "/api/diff":
        return sendDiff(res, url.searchParams.get("user"), url.searchParams.get("file"));
      case "/api/events":
        return openStream(req, res);
    }
    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "No existe ese endpoint");
    return sendStatic(res, url.pathname);
  }

  /** Diff de un archivo dentro de los cambios en curso de un usuario. */
  async function sendDiff(
    res: ServerResponse,
    user: string | null,
    file: string | null,
  ): Promise<void> {
    if (!user || !file) throw new HttpError(400, "Faltan los parámetros user y file");

    // Solo se aceptan usuarios y archivos que ya están en el estado: así no
    // se puede pedir el diff de una ruta o una ref arbitraria.
    const player = fetcher.getState()?.players.find((p) => p.user === user);
    if (!player) throw new HttpError(404, "Usuario desconocido");
    const change = player.files.find((f) => f.path === file);
    if (!change) throw new HttpError(404, "Ese archivo no está en los cambios de ese usuario");

    if (change.binary) return sendJson(res, 200, { binary: true });

    const wip = await readWip(config.repoRoot, wipRef(player.user));
    if (!wip || wip.parent === "") throw new HttpError(404, "Ya no hay trabajo de ese usuario");

    // Las rutas van después de "--" para que git nunca las lea como opciones.
    // En renombres se pasan las dos rutas para que el diff muestre el renombre.
    const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
    const result = await runGit(
      ["diff", ...PLAIN_DIFF, "-M", wip.parent, wip.commit, "--", ...paths],
      { cwd: config.repoRoot },
    );
    if (!result.ok) throw new HttpError(500, "No se pudo calcular el diff");

    let body = Buffer.from(result.stdout, "utf8");
    if (body.length > DIFF_MAX_BYTES) {
      // Cortar en un salto de línea para no partir una línea ni un carácter.
      const cut = body.lastIndexOf("\n", DIFF_MAX_BYTES - 1);
      body = body.subarray(0, cut + 1);
      res.setHeader("X-Truncated", "1");
    }
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end(body);
  }

  /** Conexión SSE: el estado al conectar, y luego cada novedad. */
  function openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const state = fetcher.getState();
    if (state) send("state", state);

    const unsubscribe = fetcher.subscribe((message) => {
      if (message.type === "state") send("state", message.state);
      else send("activity", message.events);
    });
    // Latido: un comentario SSE para que la conexión no se cierre por inactiva.
    const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);

    streams.add(res);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
      streams.delete(res);
    });
  }

  /** Archivos de la UI, con index.html como respaldo para rutas de la app. */
  async function sendStatic(res: ServerResponse, pathname: string): Promise<void> {
    let relative: string;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "Ruta inválida");
    }
    if (relative.includes("\0")) throw new HttpError(400, "Ruta inválida");

    // Anti "path traversal": tras resolver la ruta (con sus ".."), debe
    // seguir dentro de la carpeta de la UI.
    const target = path.resolve(uiDir, `.${path.sep}${relative}`);
    if (target !== uiDir && !target.startsWith(uiDir + path.sep)) {
      throw new HttpError(403, "Ruta fuera de la interfaz");
    }

    const isFile = async (file: string) =>
      (await stat(file).catch(() => null))?.isFile() ?? false;

    let file = target;
    if (!(await isFile(file))) {
      // Un recurso con extensión que no existe es un 404 de verdad; cualquier
      // otra ruta es una pantalla de la app y recibe index.html.
      if (path.extname(target) !== "") throw new HttpError(404, "No encontrado");
      file = path.join(uiDir, "index.html");
      if (!(await isFile(file))) {
        res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" });
        res.end(PLACEHOLDER);
        return;
      }
    }

    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": type });
    res.end(await readFile(file));
  }

  // Si el puerto está ocupado, probar los siguientes.
  const lastPort = options.port === 0 ? 0 : options.port + PORT_RETRIES;
  for (;;) {
    try {
      await listen(server, port);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (port >= lastPort) {
        throw new Error(
          `No hay un puerto libre entre ${options.port} y ${lastPort}. Indica otro con: --port <n>`,
        );
      }
      port += 1;
    }
  }
  const address = server.address();
  if (address && typeof address === "object") port = address.port;

  return {
    port,
    url: `http://localhost:${port}`,
    close() {
      for (const res of streams) res.end();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}
