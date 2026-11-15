import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { DIFF_MAX_BYTES } from "../src/core/constants.js";
import type { State } from "../src/core/state.js";
import { git } from "../src/git.js";
import { createFetcher, type Fetcher, isRefLockError } from "../src/ui-fetcher.js";
import { startUiServer, type UiServer } from "../src/ui-server.js";
import {
  commitAll,
  makeTeam,
  publish,
  removeDir,
  runCli,
  type Team,
  waitFor,
  write,
} from "./helpers.js";

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Petición HTTP cruda a 127.0.0.1 (permite falsear la cabecera Host). */
function request(
  port: number,
  target: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: target, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Abre una conexión SSE y va guardando los eventos que llegan. */
function openStream(port: number) {
  let text = "";
  const stream = { ended: false, events, close: () => req.destroy() };
  const req = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
    res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    res.on("end", () => (stream.ended = true));
  });
  req.on("error", () => {});

  function events(): { event: string; data: unknown }[] {
    return text
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => {
        const [first = "", second = ""] = block.split("\n");
        return {
          event: first.slice("event: ".length),
          data: JSON.parse(second.slice("data: ".length)) as unknown,
        };
      });
  }
  return stream;
}

describe("servidor del panel", () => {
  let team: Team;
  let bruno: Config;
  let yered: Config;
  let fetcher: Fetcher;
  let server: UiServer;
  let port: number;

  beforeEach(async () => {
    team = await makeTeam();
    bruno = { repoRoot: team.bruno, user: "bruno", remote: "origin" };
    yered = { repoRoot: team.yered, user: "yered", remote: "origin" };

    await write(team.bruno, "README.md", "# proyecto\nlinea de bruno\n");
    await write(team.bruno, "carpeta ñ/año nuevo.txt", "hola\n");
    await publish(bruno);

    // Una UI de mentira, y un archivo "secreto" justo fuera de su carpeta.
    await write(team.root, "ui/index.html", "<h1>panel</h1>");
    await write(team.root, "ui/assets/app.js", "console.log(1)");
    await write(team.root, "secreto.txt", "NO DEBE SALIR");

    fetcher = createFetcher(yered, { intervalMs: 50, backoffMs: [50] });
    await fetcher.refresh();
    server = await startUiServer({
      config: yered,
      fetcher,
      port: 0,
      uiDir: path.join(team.root, "ui"),
    });
    port = server.port;
  });
  afterEach(async () => {
    await server.close();
    await removeDir(team.root);
  });

  const diffUrl = (user: string, file: string) =>
    `/api/diff?user=${encodeURIComponent(user)}&file=${encodeURIComponent(file)}`;

  // ───────────── API ─────────────

  it("GET /api/state devuelve el estado", async () => {
    const res = await request(port, "/api/state");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    const state = JSON.parse(res.body) as State;
    expect(state).toEqual(fetcher.getState());
    expect(state.me).toBe("yered");
    expect(state.fetch).toEqual({ ok: true, intervalSec: 0 });
    expect(state.players.map((p) => p.user)).toEqual(["bruno"]);
    expect(state.players[0]!.files.map((f) => f.path)).toEqual([
      "README.md",
      "carpeta ñ/año nuevo.txt",
    ]);
  });

  it("GET /api/tree devuelve los archivos de mi HEAD", async () => {
    const res = await request(port, "/api/tree");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ files: ["README.md"], truncated: false });
  });

  it("GET /api/diff devuelve el diff de ese archivo, también con espacios y tildes", async () => {
    const readme = await request(port, diffUrl("bruno", "README.md"));
    expect(readme.status).toBe(200);
    expect(readme.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(readme.headers["x-truncated"]).toBeUndefined();
    expect(readme.body).toContain("@@ -1 +1,2 @@\n # proyecto\n+linea de bruno\n");
    expect(readme.body).not.toContain("año nuevo");

    const nuevo = await request(port, diffUrl("bruno", "carpeta ñ/año nuevo.txt"));
    expect(nuevo.status).toBe(200);
    expect(nuevo.body).toContain("+hola\n");
  });

  it("GET /api/diff de un binario responde { binary: true }", async () => {
    await write(team.bruno, "logo.bin", "\u0000\u0001\u0000\u0002");
    await publish(bruno);
    await fetcher.refresh();

    const res = await request(port, diffUrl("bruno", "logo.bin"));

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ binary: true });
  });

  it("GET /api/diff muestra un renombre con sus dos rutas", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `linea ${i}\n`).join("");
    await write(team.bruno, "viejo.txt", lines);
    await commitAll(team.bruno, "base con viejo.txt");
    await git(["mv", "viejo.txt", "nuevo-nombre.txt"], { cwd: team.bruno });
    await publish(bruno);
    await fetcher.refresh();

    const res = await request(port, diffUrl("bruno", "nuevo-nombre.txt"));

    expect(res.body).toContain("rename from viejo.txt\nrename to nuevo-nombre.txt");
  });

  it("recorta el diff a 200 KB y lo avisa con X-Truncated", async () => {
    const big = Array.from({ length: 8000 }, (_, i) => `linea ${i} ${"x".repeat(40)}\n`).join("");
    await write(team.bruno, "grande.txt", big);
    await publish(bruno);
    await fetcher.refresh();

    const res = await request(port, diffUrl("bruno", "grande.txt"));

    expect(res.status).toBe(200);
    expect(res.headers["x-truncated"]).toBe("1");
    const size = Buffer.byteLength(res.body);
    expect(size).toBeLessThanOrEqual(DIFF_MAX_BYTES);
    expect(size).toBeGreaterThan(DIFF_MAX_BYTES - 200);
    expect(res.body.endsWith("\n")).toBe(true); // corta en un fin de línea
  });

  // ───────────── Validaciones y seguridad ─────────────

  it("rechaza usuarios desconocidos, archivos fuera de sus cambios y parámetros faltantes", async () => {
    await write(team.yered, "solo-local.txt", "x\n");

    expect((await request(port, diffUrl("ana", "README.md"))).status).toBe(404);
    expect((await request(port, diffUrl("../heads/main", "README.md"))).status).toBe(404);
    expect((await request(port, diffUrl("bruno", "solo-local.txt"))).status).toBe(404);
    expect((await request(port, diffUrl("bruno", "../secreto.txt"))).status).toBe(404);
    expect((await request(port, diffUrl("bruno", "--output=x"))).status).toBe(404);
    expect((await request(port, "/api/diff?user=bruno")).status).toBe(400);
    expect((await request(port, "/api/nada")).status).toBe(404);
  });

  it("rechaza con 403 cualquier Host que no sea localhost o 127.0.0.1 con este puerto", async () => {
    const withHost = (host: string) => request(port, "/api/state", { headers: { Host: host } });

    expect((await withHost("evil.example.com")).status).toBe(403);
    expect((await withHost(`evil.example.com:${port}`)).status).toBe(403);
    expect((await withHost(`127.0.0.1:${port + 1}`)).status).toBe(403);
    expect((await withHost("localhost")).status).toBe(403);
    expect((await request(port, "/", { headers: { Host: "evil.example.com" } })).status).toBe(403);

    expect((await withHost(`localhost:${port}`)).status).toBe(200);
    expect((await withHost(`127.0.0.1:${port}`)).status).toBe(200);
  });

  it("solo acepta GET y no envía cabeceras CORS", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await request(port, "/api/state", { method })).status).toBe(405);
    }

    const res = await request(port, "/api/state", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control"))).toEqual([]);
  });

  it("sirve la UI, con index.html de respaldo, y bloquea el path traversal", async () => {
    const index = await request(port, "/");
    expect(index.status).toBe(200);
    expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(index.body).toBe("<h1>panel</h1>");

    const asset = await request(port, "/assets/app.js");
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.body).toBe("console.log(1)");

    expect((await request(port, "/una/pantalla")).body).toBe("<h1>panel</h1>");
    expect((await request(port, "/assets/no-existe.js")).status).toBe(404);

    for (const attack of [
      "/..%2fsecreto.txt",
      "/..%5csecreto.txt",
      "/assets/..%2f..%2fsecreto.txt",
      "/%2e%2e%2fsecreto.txt",
      "/../secreto.txt",
      "/%00",
      "/%zz",
    ]) {
      const res = await request(port, attack);
      expect(res.status, attack).toBeGreaterThanOrEqual(400);
      expect(res.status, attack).toBeLessThan(500);
      expect(res.body, attack).not.toContain("NO DEBE SALIR");
    }
  });

  it("sin UI compilada muestra un aviso en vez de fallar", async () => {
    const empty = await startUiServer({
      config: yered,
      fetcher,
      port: 0,
      uiDir: path.join(team.root, "no-existe"),
    });
    try {
      const res = await request(empty.port, "/");
      expect(res.status).toBe(200);
      expect(res.body).toContain("todavía no está compilada");
    } finally {
      await empty.close();
    }
  });

  it("si el puerto está ocupado usa uno de los siguientes", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const busy = (blocker.address() as net.AddressInfo).port;

    const other = await startUiServer({ config: yered, fetcher, port: busy });
    try {
      expect(other.port).toBeGreaterThan(busy);
      expect(other.port).toBeLessThanOrEqual(busy + 10);
      expect(other.url).toBe(`http://localhost:${other.port}`);
      expect((await request(other.port, "/api/state")).status).toBe(200);
    } finally {
      await other.close();
      blocker.close();
    }
  });

  // ───────────── SSE ─────────────

  it("SSE: envía el estado al conectar y solo vuelve a enviarlo cuando cambia", async () => {
    const stream = openStream(port);
    try {
      await waitFor(() => stream.events().length === 1);
      const first = stream.events()[0]!;
      expect(first.event).toBe("state");
      expect((first.data as State).players.map((p) => p.user)).toEqual(["bruno"]);

      // Un ciclo sin cambios no envía nada.
      await fetcher.refresh();

      await write(team.bruno, "otro.txt", "x\n");
      await publish(bruno);
      await fetcher.refresh();
      await waitFor(() => stream.events().length === 3);

      const [, second, third] = stream.events();
      expect(second!.event).toBe("state");
      expect((second!.data as State).players[0]!.totals.files).toBe(3);
      expect(third).toEqual({
        event: "activity",
        data: [{ type: "started-file", user: "bruno", file: "otro.txt" }],
      });
    } finally {
      stream.close();
    }
  });

  it("al cerrar el servidor se cierran las conexiones SSE", async () => {
    const stream = openStream(port);
    await waitFor(() => stream.events().length === 1);

    await server.close();

    await waitFor(() => stream.ended);
  });

  // ───────────── Errores que no deben tumbar nada ─────────────

  it("si falta el commit base de un wip, ese jugador sale con error y el servidor sigue", async () => {
    await write(team.bruno, "commiteado.txt", "uno\n");
    await commitAll(team.bruno, "commit local sin push");
    await write(team.bruno, "sin-commit.txt", "dos\n");
    await publish(bruno);
    // Un fetch superficial trae el wip sin su commit padre.
    const remoteUrl = new URL(`file:///${team.remote.replace(/\\/g, "/")}`).href;
    await git(["fetch", "--quiet", "--depth=1", remoteUrl, "+refs/wip/*:refs/wip/*"], {
      cwd: team.yered,
    });
    await fetcher.refresh();

    const state = JSON.parse((await request(port, "/api/state")).body) as State;

    expect(state.players[0]).toMatchObject({ user: "bruno", files: [] });
    expect(state.players[0]!.error).toMatch(/falta su commit base/);
    expect((await request(port, "/api/tree")).status).toBe(200);
  });

  it("si el remoto no responde: fetch.ok=false, sigue vivo, reintenta y se recupera solo", async () => {
    const controller = new AbortController();
    await git(["remote", "set-url", "origin", path.join(team.root, "no-existe.git")], {
      cwd: team.yered,
    });
    const loop = fetcher.run(controller.signal);
    try {
      await waitFor(() => fetcher.getState()?.fetch.ok === false);
      const failed = JSON.parse((await request(port, "/api/state")).body) as State;
      expect(failed.fetch.ok).toBe(false);
      expect(failed.fetch.error).not.toBe("");
      // Los datos viejos se siguen mostrando.
      expect(failed.players.map((p) => p.user)).toEqual(["bruno"]);

      await git(["remote", "set-url", "origin", team.remote], { cwd: team.yered });
      await waitFor(() => fetcher.getState()?.fetch.ok === true);
      expect(fetcher.getState()!.fetch).not.toHaveProperty("error");
    } finally {
      controller.abort();
      await loop;
    }
  });

  it("el panel no modifica el repo: mismo status, HEAD e índice", async () => {
    await write(team.yered, "sin-commit.txt", "y\n");
    await write(team.yered, "preparado.txt", "y\n");
    await git(["add", "preparado.txt"], { cwd: team.yered });
    const snapshot = async () => ({
      status: await git(["status", "--porcelain=v1", "--branch"], { cwd: team.yered }),
      head: await git(["rev-parse", "HEAD"], { cwd: team.yered }),
      branches: await git(["for-each-ref", "refs/heads"], { cwd: team.yered }),
      index: (await readFile(path.join(team.yered, ".git", "index"))).toString("hex"),
    });
    const before = await snapshot();

    await fetcher.refresh();
    await request(port, "/api/state");
    await request(port, "/api/tree");
    await request(port, diffUrl("bruno", "README.md"));
    const stream = openStream(port);
    await waitFor(() => stream.events().length === 1);
    stream.close();
    await fetcher.refresh();

    expect(await snapshot()).toEqual(before);
  });
});

describe("isRefLockError", () => {
  it("reconoce el choque con otro git y no lo confunde con un error de red", () => {
    expect(
      isRefLockError(
        "error: cannot lock ref 'refs/wip/bruno': Unable to create 'C:/repo/.git/refs/wip/bruno.lock': File exists.",
      ),
    ).toBe(true);
    expect(isRefLockError("error: unable to update local ref")).toBe(true);
    expect(
      isRefLockError("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host"),
    ).toBe(false);
    expect(isRefLockError("")).toBe(false);
  });
});

describe("comando mp ui", () => {
  let team: Team;

  beforeEach(async () => {
    team = await makeTeam();
  });
  afterEach(async () => {
    await removeDir(team.root);
  });

  it("sin mp init, indica correrlo", async () => {
    const result = await runCli(["ui", "--no-open"], team.yered);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/mp init/);
  });

  it("valida --port y --interval", async () => {
    const badPort = await runCli(["ui", "--no-open", "--port", "abc"], team.yered);
    expect(badPort.exitCode).toBe(1);
    expect(badPort.stderr).toMatch(/--port debe ser/);

    const badInterval = await runCli(["ui", "--no-open", "--interval", "2"], team.yered);
    expect(badInterval.exitCode).toBe(1);
    expect(badInterval.stderr).toMatch(/--interval debe ser.*mínimo 5/);
  });
});
