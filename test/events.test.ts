import { describe, expect, it } from "vitest";
import { playerStatus } from "../src/core/constants.js";
import { diffStates } from "../src/core/events.js";
import { findOverlaps, type Player, type State } from "../src/core/state.js";

const T0 = "2026-01-01T12:00:00.000Z";
const minutesAfter = (minutes: number) =>
  new Date(new Date(T0).getTime() + minutes * 60_000).toISOString();

/** Un jugador con los archivos dados (todos como modificados). */
function player(user: string, files: string[], extra: Partial<Player> = {}): Player {
  return {
    user,
    isMe: false,
    lastWipAt: T0,
    baseBranch: "main",
    baseCommit: "abc1234",
    files: files.map((path) => ({
      path,
      status: "M" as const,
      added: 1,
      deleted: 0,
      existsLocal: true,
    })),
    totals: { files: files.length, added: files.length, deleted: 0 },
    ...extra,
  };
}

/** Un estado con esos jugadores; los choques se calculan igual que en el servidor. */
function state(players: Player[]): State {
  return {
    repo: { name: "repo", root: "/repo", branch: "main", remote: "origin" },
    me: "bruno",
    fetchedAt: T0,
    fetch: { ok: true, intervalSec: 10 },
    players,
    overlaps: findOverlaps(players),
  };
}

const me = (files: string[], extra: Partial<Player> = {}) =>
  player("bruno", files, { isMe: true, ...extra });

describe("diffStates", () => {
  it("no hay eventos en el primer estado", () => {
    const first = state([me(["a.ts"]), player("yered", ["a.ts", "b.ts"])]);

    expect(diffStates(null, first)).toEqual([]);
  });

  it("no hay eventos si nada cambió", () => {
    const same = () => state([me(["a.ts"]), player("yered", ["b.ts"])]);

    expect(diffStates(same(), same())).toEqual([]);
  });

  it("started-file: otro jugador empieza a tocar un archivo", () => {
    const prev = state([player("yered", ["a.ts"])]);
    const next = state([player("yered", ["a.ts", "b.ts", "c d/ñ.ts"])]);

    expect(diffStates(prev, next)).toEqual([
      { type: "started-file", user: "yered", file: "b.ts" },
      { type: "started-file", user: "yered", file: "c d/ñ.ts" },
    ]);
  });

  it("started-file: no se repite por un archivo que ya tocaba, ni al dejar de tocarlo", () => {
    const prev = state([player("yered", ["a.ts", "b.ts"])]);
    const next = state([player("yered", ["a.ts"], { lastWipAt: minutesAfter(1) })]);

    expect(diffStates(prev, next)).toEqual([]);
  });

  it("started-file: si lo deja y lo retoma, vuelve a avisar", () => {
    const withFile = state([player("yered", ["a.ts"])]);
    const without = state([player("yered", [])]);

    expect(diffStates(withFile, without)).toEqual([]);
    expect(diffStates(without, withFile)).toEqual([
      { type: "started-file", user: "yered", file: "a.ts" },
    ]);
  });

  it("joined: aparece un jugador nuevo, y se anuncia una sola vez", () => {
    const prev = state([me([])]);
    const next = state([me([]), player("yered", ["a.ts", "b.ts"])]);

    expect(diffStates(prev, next)).toEqual([{ type: "joined", user: "yered" }]);
  });

  it("woke-up: llega un wip nuevo tras más de 30 min", () => {
    const prev = state([player("yered", ["a.ts"])]);

    const at30 = state([player("yered", ["a.ts"], { lastWipAt: minutesAfter(30) })]);
    expect(diffStates(prev, at30)).toEqual([]);

    const at31 = state([player("yered", ["a.ts"], { lastWipAt: minutesAfter(31) })]);
    expect(diffStates(prev, at31)).toEqual([{ type: "woke-up", user: "yered" }]);
  });

  it("woke-up y started-file pueden llegar juntos", () => {
    const prev = state([player("yered", ["a.ts"])]);
    const next = state([player("yered", ["a.ts", "b.ts"], { lastWipAt: minutesAfter(90) })]);

    expect(diffStates(prev, next)).toEqual([
      { type: "woke-up", user: "yered" },
      { type: "started-file", user: "yered", file: "b.ts" },
    ]);
  });

  it("overlap: un archivo pasa a estar tocado por dos personas", () => {
    const prev = state([me(["a.ts"]), player("yered", ["b.ts"])]);
    const next = state([me(["a.ts"]), player("yered", ["b.ts", "a.ts"])]);

    expect(diffStates(prev, next)).toEqual([
      { type: "started-file", user: "yered", file: "a.ts" },
      { type: "overlap", file: "a.ts", users: ["bruno", "yered"] },
    ]);
  });

  it("overlap: no se repite mientras el choque sigue, ni cuando se suma un tercero", () => {
    const prev = state([me(["a.ts"]), player("yered", ["a.ts"])]);
    const still = state([
      me(["a.ts"], { lastWipAt: minutesAfter(1) }),
      player("yered", ["a.ts"], { lastWipAt: minutesAfter(1) }),
    ]);
    expect(diffStates(prev, still)).toEqual([]);

    const third = state([me(["a.ts"]), player("yered", ["a.ts"]), player("ana", ["a.ts"])]);
    expect(diffStates(prev, third)).toEqual([{ type: "joined", user: "ana" }]);
  });

  it("overlap: vuelve a avisar si el choque se resuelve y reaparece", () => {
    const clash = state([me(["a.ts"]), player("yered", ["a.ts"])]);
    const calm = state([me(["a.ts"]), player("yered", [])]);

    expect(diffStates(clash, calm)).toEqual([]);
    expect(diffStates(calm, clash)).toEqual([
      { type: "started-file", user: "yered", file: "a.ts" },
      { type: "overlap", file: "a.ts", users: ["bruno", "yered"] },
    ]);
  });

  it("nunca hay eventos sobre mí: ni archivos, ni despertar, ni unirme", () => {
    const prev = state([player("yered", [])]);
    const next = state([me(["a.ts", "b.ts"], { lastWipAt: minutesAfter(120) }), player("yered", [])]);

    expect(diffStates(prev, next)).toEqual([]);

    const later = state([me(["a.ts", "b.ts", "c.ts"], { lastWipAt: minutesAfter(300) }), player("yered", [])]);
    expect(diffStates(next, later)).toEqual([]);
  });

  it("el choque sí se avisa aunque lo provoque yo", () => {
    const prev = state([me([]), player("yered", ["a.ts"])]);
    const next = state([me(["a.ts"]), player("yered", ["a.ts"])]);

    expect(diffStates(prev, next)).toEqual([
      { type: "overlap", file: "a.ts", users: ["bruno", "yered"] },
    ]);
  });

  it("un jugador que se recupera de un error no dispara started-file por todo", () => {
    const broken = state([player("yered", [], { error: "falta su commit base" })]);
    const fixed = state([player("yered", ["a.ts", "b.ts"])]);

    expect(diffStates(broken, fixed)).toEqual([]);
    // Y con el siguiente cambio ya avisa normal.
    const more = state([player("yered", ["a.ts", "b.ts", "c.ts"])]);
    expect(diffStates(fixed, more)).toEqual([
      { type: "started-file", user: "yered", file: "c.ts" },
    ]);
  });

  it("un jugador que desaparece no genera eventos", () => {
    const prev = state([me([]), player("yered", ["a.ts"])]);
    const next = state([me([])]);

    expect(diffStates(prev, next)).toEqual([]);
  });

  it("no modifica los estados que recibe", () => {
    const prev = state([me(["a.ts"]), player("yered", ["b.ts"])]);
    const next = state([me(["a.ts"]), player("yered", ["a.ts", "b.ts"])]);
    const copies = [structuredClone(prev), structuredClone(next)];

    diffStates(prev, next);

    expect([prev, next]).toEqual(copies);
  });
});

describe("playerStatus", () => {
  const now = new Date(minutesAfter(60));
  const ago = (minutes: number) => playerStatus(minutesAfter(60 - minutes), now);

  it("editando hasta 2 min, pausa hasta 30 min, dormido después", () => {
    expect(ago(0)).toBe("editando");
    expect(ago(2)).toBe("editando");
    expect(ago(2.1)).toBe("pausa");
    expect(ago(30)).toBe("pausa");
    expect(ago(30.1)).toBe("dormido");
    expect(ago(600)).toBe("dormido");
  });

  it("un reloj adelantado (fecha futura) cuenta como editando", () => {
    expect(ago(-5)).toBe("editando");
  });
});
