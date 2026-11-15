// El mapa del proyecto: el árbol de archivos con los avatares de quienes
// tocan cada uno.

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { playerStatus } from "../../src/core/constants.js";
import { buildTree, type Touch, type TreeNode } from "../../src/core/tree.js";
import type { Player, State, TreeFiles } from "./api";
import { Avatar } from "./avatar";
import { CaretIcon, FolderIcon } from "./icons";
import { joinNames, STATUS_WORD } from "./text";

/** Un archivo "brilla" durante este tiempo después de cambiar. */
const HOT_MS = 60_000;

/**
 * Recuerda qué archivos acaban de cambiar, para iluminarlos 60 s.
 *
 * El servidor solo dice cuándo cambió el trabajo de un jugador, no qué
 * archivo. Así que comparamos cada estado con el anterior: un archivo cuenta
 * como "recién tocado" si aparece o si cambian su estado o sus líneas.
 * En la primera carga no brilla nada: no sabemos qué es reciente.
 */
function useHotFiles(players: readonly Player[]): Map<string, { user: string; at: number }> {
  const previous = useRef<Map<string, string> | null>(null);
  const [hot, setHot] = useState(() => new Map<string, { user: string; at: number }>());

  useEffect(() => {
    const current = new Map<string, string>();
    const changed: [string, string][] = [];
    for (const player of players) {
      for (const file of player.files) {
        const key = `${player.user}\n${file.path}`;
        const signature = `${file.status}:${file.added}:${file.deleted}`;
        current.set(key, signature);
        if (previous.current && previous.current.get(key) !== signature) {
          changed.push([file.path, player.user]);
        }
      }
    }
    previous.current = current;

    if (changed.length > 0) {
      const at = Date.now();
      setHot((old) => {
        const next = new Map(old);
        for (const [path, user] of changed) next.set(path, { user, at });
        return next;
      });
    }
  }, [players]);

  return hot;
}

export interface ProjectMapProps {
  state: State;
  tree: TreeFiles | null;
  colors: Map<string, string>;
  now: Date;
  onlyActive: boolean;
  /** Archivo seleccionado (se resalta), o null. */
  selected: string | null;
  onSelect: (path: string) => void;
}

export function ProjectMap(props: ProjectMapProps) {
  const { state, tree, onlyActive } = props;
  const hot = useHotFiles(state.players);

  const nodes = useMemo(
    () => buildTree(tree?.files ?? [], state.players, { onlyActive }),
    [tree, state.players, onlyActive],
  );

  // Carpetas que el usuario abrió o cerró a mano. Las demás siguen la regla:
  // abiertas si tienen actividad, cerradas si no.
  const [toggled, setToggled] = useState(() => new Map<string, boolean>());
  const toggle = (path: string, open: boolean) =>
    setToggled((old) => new Map(old).set(path, open));

  const activeFiles = nodes.reduce((sum, node) => sum + node.activeFiles, 0);

  return (
    <section className="map glass" aria-labelledby="map-title">
      <header className="map-head">
        <div>
          <p className="eyebrow">Mapa</p>
          <h2 id="map-title">Mapa del proyecto</h2>
        </div>
        <div className="map-tags">
          {tree && (
            <span className="tag">
              <b>{tree.files.length}</b> en tu HEAD
            </span>
          )}
          <span className="tag">
            <b>{activeFiles}</b> con actividad
          </span>
        </div>
      </header>

      {tree?.truncated && (
        <p className="notice notice-warn" role="status">
          El repo tiene demasiados archivos: el mapa muestra solo los primeros{" "}
          {tree.files.length.toLocaleString("es")}.
        </p>
      )}

      {!tree ? (
        <p className="muted">Cargando archivos…</p>
      ) : nodes.length === 0 ? (
        <p className="muted">
          {onlyActive
            ? "Nadie está tocando archivos ahora mismo."
            : "Este repo todavía no tiene archivos."}
        </p>
      ) : (
        <ul className="tree">
          {nodes.map((node) => (
            <TreeItem key={node.path} node={node} {...props} hot={hot} toggled={toggled} toggle={toggle} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface TreeItemProps extends ProjectMapProps {
  node: TreeNode;
  hot: Map<string, { user: string; at: number }>;
  toggled: Map<string, boolean>;
  toggle: (path: string, open: boolean) => void;
}

function TreeItem(props: TreeItemProps) {
  const { node } = props;
  return (
    <li className={node.activeFiles > 0 ? "tree-item tree-item-active" : "tree-item"}>
      {node.kind === "dir" ? <FolderRow {...props} /> : <FileRow {...props} />}
    </li>
  );
}

function FolderRow(props: TreeItemProps) {
  const { node, state, colors, now, toggled, toggle } = props;
  const open = toggled.get(node.path) ?? node.expanded;

  return (
    <>
      {/* Un <button> ya es enfocable y responde a Enter y Espacio. */}
      <button
        type="button"
        className={open ? "row row-dir row-open" : "row row-dir"}
        aria-expanded={open}
        onClick={() => toggle(node.path, !open)}
      >
        <CaretIcon />
        <FolderIcon />
        <span className="row-name">{node.name}</span>

        {/* Carpeta cerrada con actividad: resumen de quién anda adentro. */}
        {!open && node.activeFiles > 0 && (
          <span className="row-summary">
            <span className="faces">
              {node.users.map((user) => (
                <Face key={user} user={user} state={state} colors={colors} now={now} />
              ))}
            </span>
            <span className="tag">
              <b>{node.activeFiles}</b> {node.activeFiles === 1 ? "archivo" : "archivos"}
            </span>
          </span>
        )}
      </button>

      {open && (
        <ul className="tree-children">
          {node.children.map((child) => (
            <TreeItem key={child.path} {...props} node={child} />
          ))}
        </ul>
      )}
    </>
  );
}

function FileRow(props: TreeItemProps) {
  const { node, state, colors, now, hot, selected, onSelect } = props;
  const touched = node.touches.length > 0;

  // ¿Sigue "caliente"? Brilla con el color de quien lo tocó.
  const recent = hot.get(node.path);
  const isHot = recent !== undefined && now.getTime() - recent.at < HOT_MS;

  const classes = ["row", "row-file"];
  if (touched) classes.push("row-touched");
  if (isHot) classes.push("row-hot");
  if (node.overlap) classes.push("row-clash");
  if (selected === node.path) classes.push("row-selected");
  if (node.touches.some((touch) => touch.status === "D")) classes.push("row-deleted");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      style={isHot ? ({ "--c": colors.get(recent.user) } as CSSProperties) : undefined}
      aria-pressed={selected === node.path}
      onClick={() => onSelect(node.path)}
    >
      <span className="row-dot" aria-hidden="true" />
      <span className="row-name">{node.name}</span>

      {node.overlap && (
        <span
          className="clash-tag"
          title={`${joinNames(node.users, state.me)} tocan el mismo archivo`}
        >
          💥 choque
        </span>
      )}

      {touched && (
        <span className="touches">
          {node.touches.map((touch) => (
            <TouchChip key={touch.user} touch={touch} state={state} colors={colors} now={now} />
          ))}
        </span>
      )}
    </button>
  );
}

interface FaceProps {
  user: string;
  state: State;
  colors: Map<string, string>;
  now: Date;
}

/** Avatar pequeño de un jugador, dentro de un aro de su color. */
export function Face({ user, state, colors, now }: FaceProps) {
  const player = state.players.find((p) => p.user === user);
  const color = colors.get(user) ?? "#ffffff";
  const status = player ? playerStatus(player.lastWipAt, now) : "dormido";
  return (
    <span className="face" style={{ "--c": color } as CSSProperties} title={user}>
      <Avatar user={user} color={color} status={status} size={18} mini />
    </span>
  );
}

/** Quién toca un archivo: su avatar, el estado con letra y las líneas. */
function TouchChip({ touch, ...rest }: { touch: Touch } & Omit<FaceProps, "user">) {
  const word = STATUS_WORD[touch.status];
  return (
    <span className="touch">
      <Face user={touch.user} {...rest} />
      <span className={`badge badge-${touch.status}`} title={`${touch.user}: ${word}`}>
        {touch.status}
        <span className="sr-only"> ({word})</span>
      </span>
      {touch.added === null ? (
        <span className="touch-lines">binario</span>
      ) : (
        <span className="touch-lines">
          <span className="plus">+{touch.added}</span> <span className="minus">−{touch.deleted}</span>
        </span>
      )}
    </span>
  );
}
