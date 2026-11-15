import { describe, expect, it } from "vitest";
import {
  assignColors,
  avatarTraits,
  BODIES,
  EXTRAS,
  EYES,
  hashString,
  PALETTE,
} from "../ui/src/palette.js";

const NAMES = [
  "bruno", "yered", "ana", "luis", "sofia", "dev_01", "ana-maria", "b2", "mateo", "vale",
  "santi", "regina", "emi", "leo", "ximena", "diego", "pau", "fer", "caro", "nico",
];

describe("assignColors", () => {
  it("dos usuarios cualesquiera nunca obtienen el mismo color", () => {
    for (const a of NAMES) {
      for (const b of NAMES) {
        if (a === b) continue;
        const colors = assignColors([a, b]);
        expect(colors.get(a), `${a} y ${b}`).not.toBe(colors.get(b));
      }
    }
  });

  it("hasta 8 usuarios, todos reciben colores distintos", () => {
    // Todas las ventanas de 8 nombres seguidos de la lista (dando la vuelta).
    for (let start = 0; start < NAMES.length; start++) {
      const group = Array.from({ length: 8 }, (_, i) => NAMES[(start + i) % NAMES.length]!);
      const colors = assignColors(group);
      expect(new Set(colors.values()).size, group.join(",")).toBe(8);
    }
  });

  it("resuelve una colisión de hash dando el siguiente color libre", () => {
    // Buscar dos nombres a los que les "toca" el mismo color.
    const slot = (name: string) => hashString(name) % PALETTE.length;
    const first = NAMES.find((a) => NAMES.some((b) => b !== a && slot(b) === slot(a)))!;
    const second = NAMES.find((b) => b !== first && slot(b) === slot(first))!;
    const [early, late] = [first, second].sort() as [string, string];

    const colors = assignColors([late, early]);

    // El primero en orden alfabético conserva su color; el otro toma el siguiente.
    expect(colors.get(early)).toBe(PALETTE[slot(early)]!.hex);
    expect(colors.get(late)).toBe(PALETTE[(slot(early) + 1) % PALETTE.length]!.hex);
  });

  it("es determinista y no depende del orden ni de repetidos", () => {
    const a = assignColors(["yered", "bruno", "ana"]);
    const b = assignColors(["ana", "bruno", "yered", "bruno"]);

    expect([...a].sort()).toEqual([...b].sort());
    expect(assignColors(["bruno", "yered"]).get("bruno")).toBe(
      assignColors(["bruno", "yered"]).get("bruno"),
    );
  });

  it("solo usa colores de la paleta, también con más de 8 usuarios", () => {
    const colors = assignColors(NAMES);
    const valid = new Set<string>(PALETTE.map((color) => color.hex));

    expect(colors.size).toBe(NAMES.length);
    for (const color of colors.values()) expect(valid.has(color)).toBe(true);
  });

  it("sin usuarios devuelve un mapa vacío", () => {
    expect(assignColors([]).size).toBe(0);
  });
});

describe("avatarTraits", () => {
  it("es determinista y siempre da rasgos válidos", () => {
    for (const name of NAMES) {
      const traits = avatarTraits(name);
      expect(traits).toEqual(avatarTraits(name));
      expect(BODIES).toContain(traits.body);
      expect(EYES).toContain(traits.eyes);
      expect(EXTRAS).toContain(traits.extra);
    }
  });

  it("reparte variedad: no todos los jugadores se ven igual", () => {
    const looks = new Set(NAMES.map((name) => JSON.stringify(avatarTraits(name))));
    expect(looks.size).toBeGreaterThan(NAMES.length / 2);
  });
});
