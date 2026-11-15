import { describe, expect, it } from "vitest";
import { parseDiff } from "../ui/src/diff.js";
import { vscodeUrl } from "../ui/src/vscodeUrl.js";

describe("vscodeUrl", () => {
  it("Windows: usa / y conserva la letra de unidad", () => {
    expect(vscodeUrl("C:\\Users\\bruno\\repo", "src/a.ts")).toBe(
      "vscode://file/C:/Users/bruno/repo/src/a.ts",
    );
    expect(vscodeUrl("d:\\repo\\", "a.ts")).toBe("vscode://file/d:/repo/a.ts");
    expect(vscodeUrl("C:/Users/bruno/repo", "src/a.ts")).toBe(
      "vscode://file/C:/Users/bruno/repo/src/a.ts",
    );
  });

  it("macOS: ruta absoluta sin letra de unidad", () => {
    expect(vscodeUrl("/Users/yered/repo", "src/a.ts")).toBe(
      "vscode://file/Users/yered/repo/src/a.ts",
    );
    expect(vscodeUrl("/Users/yered/repo/", "a.ts")).toBe("vscode://file/Users/yered/repo/a.ts");
  });

  it("codifica espacios, tildes y caracteres especiales en cada tramo", () => {
    expect(vscodeUrl("C:\\Users\\Bruno Pérez\\mi repo", "carpeta ñ/año nuevo.txt")).toBe(
      "vscode://file/C:/Users/Bruno%20P%C3%A9rez/mi%20repo/carpeta%20%C3%B1/a%C3%B1o%20nuevo.txt",
    );
    expect(vscodeUrl("/Users/yered/mi repo", "docs/¿qué?.md")).toBe(
      "vscode://file/Users/yered/mi%20repo/docs/%C2%BFqu%C3%A9%3F.md",
    );
    expect(vscodeUrl("/r", "a#b/100%.txt")).toBe("vscode://file/r/a%23b/100%25.txt");
  });

  it("la URL resultante se puede leer de vuelta", () => {
    const url = new URL(vscodeUrl("C:\\Users\\Bruno Pérez\\repo", "src/año nuevo.ts"));
    expect(url.protocol).toBe("vscode:");
    expect(decodeURIComponent(url.pathname)).toBe("/C:/Users/Bruno Pérez/repo/src/año nuevo.ts");
  });
});

describe("parseDiff", () => {
  it("lee hunks con números de línea viejos y nuevos", () => {
    const diff = parseDiff(
      [
        "diff --git a/app.txt b/app.txt",
        "index de9edb2..68d9e4c 100644",
        "--- a/app.txt",
        "+++ b/app.txt",
        "@@ -1,3 +1,4 @@",
        " linea 1",
        "-linea 2",
        "+linea 2 cambiada",
        "+otra linea",
        " linea 3",
        "@@ -20,2 +21,2 @@ function pagar() {",
        " antes",
        "-  return 1;",
        "+  return 2;",
        "",
      ].join("\n"),
    );

    expect(diff).toMatchObject({ isNew: false, isDeleted: false, binary: false });
    expect(diff.hunks.map((hunk) => hunk.header)).toEqual([
      "@@ -1,3 +1,4 @@",
      "@@ -20,2 +21,2 @@ function pagar() {",
    ]);
    expect(diff.hunks[0]!.lines).toEqual([
      { kind: "context", text: "linea 1", oldLine: 1, newLine: 1 },
      { kind: "del", text: "linea 2", oldLine: 2, newLine: null },
      { kind: "add", text: "linea 2 cambiada", oldLine: null, newLine: 2 },
      { kind: "add", text: "otra linea", oldLine: null, newLine: 3 },
      { kind: "context", text: "linea 3", oldLine: 3, newLine: 4 },
    ]);
    expect(diff.hunks[1]!.lines).toEqual([
      { kind: "context", text: "antes", oldLine: 20, newLine: 21 },
      { kind: "del", text: "  return 1;", oldLine: 21, newLine: null },
      { kind: "add", text: "  return 2;", oldLine: null, newLine: 22 },
    ]);
  });

  it("archivo nuevo y archivo borrado", () => {
    const added = parseDiff(
      "diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..d9cff99\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+hola\n+mundo\n",
    );
    expect(added.isNew).toBe(true);
    expect(added.hunks[0]!.lines).toEqual([
      { kind: "add", text: "hola", oldLine: null, newLine: 1 },
      { kind: "add", text: "mundo", oldLine: null, newLine: 2 },
    ]);

    const deleted = parseDiff(
      "diff --git a/v.txt b/v.txt\ndeleted file mode 100644\nindex d9cff99..0000000\n--- a/v.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-adiós\n",
    );
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.hunks[0]!.lines).toEqual([
      { kind: "del", text: "adiós", oldLine: 1, newLine: null },
    ]);
  });

  it("renombres: con cambios y sin cambios", () => {
    const withChanges = parseDiff(
      [
        "diff --git a/viejo nombre.ts b/nuevo nombre.ts",
        "similarity index 90%",
        "rename from viejo nombre.ts",
        "rename to nuevo nombre.ts",
        "index 1111111..2222222 100644",
        "--- a/viejo nombre.ts",
        "+++ b/nuevo nombre.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
    expect(withChanges).toMatchObject({
      renamedFrom: "viejo nombre.ts",
      renamedTo: "nuevo nombre.ts",
    });
    expect(withChanges.hunks).toHaveLength(1);

    const pure = parseDiff(
      "diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n",
    );
    expect(pure).toMatchObject({ renamedFrom: "a.ts", renamedTo: "b.ts", hunks: [] });
  });

  it('"sin salto de línea al final" queda como nota, sin número de línea', () => {
    const diff = parseDiff(
      "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-viejo\n\\ No newline at end of file\n+nuevo\n\\ No newline at end of file\n",
    );

    expect(diff.hunks[0]!.lines).toEqual([
      { kind: "del", text: "viejo", oldLine: 1, newLine: null },
      { kind: "note", text: "Sin salto de línea al final del archivo", oldLine: null, newLine: null },
      { kind: "add", text: "nuevo", oldLine: null, newLine: 1 },
      { kind: "note", text: "Sin salto de línea al final del archivo", oldLine: null, newLine: null },
    ]);
  });

  it("binarios: lo marca y no inventa líneas", () => {
    const diff = parseDiff(
      "diff --git a/logo.bin b/logo.bin\nnew file mode 100644\nindex 0000000..abc1234\nBinary files /dev/null and b/logo.bin differ\n",
    );

    expect(diff).toMatchObject({ binary: true, isNew: true, hunks: [] });
  });

  it("conserva líneas vacías, líneas que empiezan con signos y finales CRLF", () => {
    const diff = parseDiff(
      "--- a/a.md\n+++ b/a.md\n@@ -1,3 +1,4 @@\n \n-- item\n+++ más\n+-- otro\r\n texto\r\n",
    );

    expect(diff.hunks[0]!.lines).toEqual([
      { kind: "context", text: "", oldLine: 1, newLine: 1 },
      { kind: "del", text: "- item", oldLine: 2, newLine: null },
      { kind: "add", text: "++ más", oldLine: null, newLine: 2 },
      { kind: "add", text: "-- otro", oldLine: null, newLine: 3 },
      { kind: "context", text: "texto", oldLine: 3, newLine: 4 },
    ]);
  });

  it("un diff recortado a media línea no falla", () => {
    const diff = parseDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1,50 +1,60 @@\n uno\n+dos\n+tr");

    expect(diff.hunks[0]!.lines).toHaveLength(3);
    expect(parseDiff("").hunks).toEqual([]);
  });
});
