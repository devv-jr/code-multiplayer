// Arma el árbol de archivos del mapa del proyecto: los archivos de mi HEAD
// más los archivos nuevos de otros, con quién toca cada uno.
// Función pura y sin Node: la usa la interfaz web.

import type { ChangedFile, Player } from "./types.js";

/** Un jugador tocando un archivo. */
export interface Touch {
  user: string;
  status: ChangedFile["status"];
  added: number | null;
  deleted: number | null;
  /** Fecha ISO del wip de ese jugador (para el resplandor "reciente"). */
  lastWipAt: string;
}

export interface TreeNode {
  /** Nombre del archivo o carpeta (último tramo de la ruta). */
  name: string;
  /** Ruta completa con "/". */
  path: string;
  kind: "dir" | "file";
  /** Carpetas primero, luego archivos; cada grupo en orden alfabético. */
  children: TreeNode[];
  /** Archivos: quiénes lo tocan. Carpetas: vacío. */
  touches: Touch[];
  /** Usuarios con actividad aquí (archivo) o debajo (carpeta), en orden. */
  users: string[];
  /** Cuántos archivos tocados hay aquí o debajo. */
  activeFiles: number;
  /** Carpetas: abierta por defecto solo si tiene actividad debajo. */
  expanded: boolean;
  /** Archivos: no existe en mi HEAD (lo agregó otro). */
  isNew: boolean;
  /** Archivos: lo tocan dos o más personas ("choque": mismo archivo). */
  overlap: boolean;
}

export interface TreeOptions {
  /** Ocultar lo que nadie toca (se conservan las carpetas padre). */
  onlyActive?: boolean;
}

const byName = (a: TreeNode, b: TreeNode) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Construye el árbol. Devuelve los nodos de la raíz. */
export function buildTree(
  headFiles: readonly string[],
  players: readonly Player[],
  options: TreeOptions = {},
): TreeNode[] {
  // Quién toca cada ruta.
  const touchesByPath = new Map<string, Touch[]>();
  for (const player of players) {
    for (const file of player.files) {
      const touches = touchesByPath.get(file.path) ?? [];
      touches.push({
        user: player.user,
        status: file.status,
        added: file.added,
        deleted: file.deleted,
        lastWipAt: player.lastWipAt,
      });
      touchesByPath.set(file.path, touches);
    }
  }

  const inHead = new Set(headFiles);
  const paths = options.onlyActive
    ? [...touchesByPath.keys()]
    : [...new Set([...headFiles, ...touchesByPath.keys()])];

  const root = makeNode("", "", "dir");
  const dirs = new Map<string, TreeNode>([["", root]]);

  for (const filePath of paths) {
    const parts = filePath.split("/");
    let parent = root;

    // Crear (o reutilizar) cada carpeta del camino.
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let dir = dirs.get(dirPath);
      if (!dir) {
        dir = makeNode(parts[i] ?? "", dirPath, "dir");
        dirs.set(dirPath, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }

    const file = makeNode(parts[parts.length - 1] ?? "", filePath, "file");
    file.touches = touchesByPath.get(filePath) ?? [];
    file.isNew = !inHead.has(filePath);
    parent.children.push(file);
  }

  finish(root);
  return root.children;
}

function makeNode(name: string, path: string, kind: TreeNode["kind"]): TreeNode {
  return {
    name,
    path,
    kind,
    children: [],
    touches: [],
    users: [],
    activeFiles: 0,
    expanded: false,
    isNew: false,
    overlap: false,
  };
}

/** Ordena los hijos y sube la actividad de los archivos a sus carpetas. */
function finish(node: TreeNode): void {
  if (node.kind === "file") {
    node.users = node.touches.map((touch) => touch.user).sort();
    node.activeFiles = node.touches.length > 0 ? 1 : 0;
    node.overlap = node.touches.length >= 2;
    return;
  }

  const users = new Set<string>();
  for (const child of node.children) {
    finish(child);
    node.activeFiles += child.activeFiles;
    for (const user of child.users) users.add(user);
  }
  node.users = [...users].sort();
  node.expanded = node.activeFiles > 0;
  node.children = [
    ...node.children.filter((child) => child.kind === "dir").sort(byName),
    ...node.children.filter((child) => child.kind === "file").sort(byName),
  ];
}
