import { describe, expect, it } from "vitest";
import type { ChangedFile, Player } from "../src/core/state.js";
import { buildTree, type TreeNode } from "../src/core/tree.js";

const T0 = "2026-01-01T12:00:00.000Z";

function player(user: string, files: [string, ChangedFile["status"]][]): Player {
  return {
    user,
    isMe: false,
    lastWipAt: T0,
    baseBranch: "main",
    baseCommit: "abc1234",
    files: files.map(([path, status]) => ({
      path,
      status,
      added: 3,
      deleted: 1,
      existsLocal: status !== "A",
    })),
    totals: { files: files.length, added: 0, deleted: 0 },
  };
}

const HEAD_FILES = ["README.md", "docs/guia.md", "src/app.ts", "src/util/a.ts", "src/util/b.ts"];
const PLAYERS = [
  player("yered", [
    ["src/app.ts", "M"],
    ["src/nuevo/pagos.ts", "A"],
  ]),
  player("bruno", [["src/app.ts", "M"]]),
];

/** Resumen compacto del árbol: una línea por nodo, con sangría. */
function outline(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const marks = [
      node.kind === "dir" ? (node.expanded ? "abierta" : "cerrada") : "",
      node.users.join("+"),
      node.overlap ? "choque" : "",
      node.isNew ? "nuevo" : "",
    ].filter((mark) => mark !== "");
    const label = `${"  ".repeat(depth)}${node.name}${node.kind === "dir" ? "/" : ""}`;
    return [
      marks.length > 0 ? `${label} [${marks.join(", ")}]` : label,
      ...outline(node.children, depth + 1),
    ];
  });
}

/** Busca un nodo por su ruta. */
function find(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const inside = find(node.children, path);
    if (inside) return inside;
  }
  return undefined;
}

describe("buildTree", () => {
  it("arma el árbol: carpetas primero, en orden, y abiertas solo si tienen actividad", () => {
    expect(outline(buildTree(HEAD_FILES, PLAYERS))).toEqual([
      "docs/ [cerrada]",
      "  guia.md",
      "src/ [abierta, bruno+yered]",
      "  nuevo/ [abierta, yered]",
      "    pagos.ts [yered, nuevo]",
      "  util/ [cerrada]",
      "    a.ts",
      "    b.ts",
      "  app.ts [bruno+yered, choque]",
      "README.md",
    ]);
  });

  it("los archivos nuevos de otros entran aunque no estén en mi HEAD", () => {
    const tree = buildTree(HEAD_FILES, PLAYERS);

    expect(find(tree, "src/nuevo/pagos.ts")).toMatchObject({
      kind: "file",
      name: "pagos.ts",
      isNew: true,
      overlap: false,
    });
    expect(find(tree, "src/app.ts")!.isNew).toBe(false);
  });

  it("cada archivo tocado lleva quién lo toca, su estado y sus líneas", () => {
    const file = find(buildTree(HEAD_FILES, PLAYERS), "src/app.ts")!;

    expect(file.touches).toEqual([
      { user: "yered", status: "M", added: 3, deleted: 1, lastWipAt: T0 },
      { user: "bruno", status: "M", added: 3, deleted: 1, lastWipAt: T0 },
    ]);
    expect(file.users).toEqual(["bruno", "yered"]);
    expect(file.overlap).toBe(true);
  });

  it("las carpetas resumen la actividad de adentro", () => {
    const tree = buildTree(HEAD_FILES, PLAYERS);

    expect(find(tree, "src")).toMatchObject({ activeFiles: 2, users: ["bruno", "yered"] });
    expect(find(tree, "src/nuevo")).toMatchObject({ activeFiles: 1, users: ["yered"] });
    expect(find(tree, "src/util")).toMatchObject({ activeFiles: 0, users: [], expanded: false });
  });

  it('"solo actividad" oculta lo que nadie toca y conserva las carpetas padre', () => {
    expect(outline(buildTree(HEAD_FILES, PLAYERS, { onlyActive: true }))).toEqual([
      "src/ [abierta, bruno+yered]",
      "  nuevo/ [abierta, yered]",
      "    pagos.ts [yered, nuevo]",
      "  app.ts [bruno+yered, choque]",
    ]);
  });

  it("sin actividad: todo cerrado; y con solo actividad, vacío", () => {
    expect(outline(buildTree(HEAD_FILES, []))).toEqual([
      "docs/ [cerrada]",
      "  guia.md",
      "src/ [cerrada]",
      "  util/ [cerrada]",
      "    a.ts",
      "    b.ts",
      "  app.ts",
      "README.md",
    ]);
    expect(buildTree(HEAD_FILES, [], { onlyActive: true })).toEqual([]);
  });

  it("un archivo borrado o renombrado se muestra con su estado", () => {
    const tree = buildTree(HEAD_FILES, [
      player("yered", [
        ["docs/guia.md", "D"],
        ["src/util/c.ts", "R"],
      ]),
    ]);

    expect(find(tree, "docs/guia.md")!.touches[0]).toMatchObject({ user: "yered", status: "D" });
    expect(find(tree, "src/util/c.ts")).toMatchObject({ isNew: true });
    expect(find(tree, "docs")!.expanded).toBe(true);
  });

  it("no repite archivos ni carpetas, y soporta nombres con espacios y tildes", () => {
    const tree = buildTree(
      ["carpeta ñ/año nuevo.txt", "carpeta ñ/otro.txt"],
      [player("yered", [["carpeta ñ/año nuevo.txt", "M"]])],
    );

    expect(outline(tree)).toEqual([
      "carpeta ñ/ [abierta, yered]",
      "  año nuevo.txt [yered]",
      "  otro.txt",
    ]);
  });
});
