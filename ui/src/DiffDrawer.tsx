// Cajón de detalle: el diff del archivo seleccionado, con una pestaña por
// cada jugador que lo toca, y el botón para abrirlo en VS Code.

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { type DiffResult, getDiff, type State, timeAgo } from "./api";
import { type DiffLine, parseDiff } from "./diff";
import { Face } from "./ProjectMap";
import { STATUS_WORD } from "./text";
import { vscodeUrl } from "./vscodeUrl";

export interface DiffDrawerProps {
  file: string;
  state: State;
  colors: Map<string, string>;
  now: Date;
  onClose: () => void;
}

type Loaded = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; diff: DiffResult };

export function DiffDrawer({ file, state, colors, now, onClose }: DiffDrawerProps) {
  // Quiénes tocan este archivo ahora mismo.
  const touchers = state.players.filter((player) => player.files.some((f) => f.path === file));
  const [tab, setTab] = useState<string | null>(null);
  const player = touchers.find((p) => p.user === tab) ?? touchers[0];
  const change = player?.files.find((f) => f.path === file);

  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  // Se vuelve a pedir el diff cuando cambia la pestaña o cuando llega una
  // instantánea nueva de ese jugador (su lastWipAt cambia).
  const user = player?.user;
  const version = player?.lastWipAt;
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getDiff(user, file)
      .then((diff) => !cancelled && setLoaded({ status: "ok", diff }))
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoaded({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [user, file, version]);

  // Escape cierra el cajón.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Si nadie lo toca, el archivo es de mi HEAD: existe en mi carpeta.
  const existsLocal = change ? change.existsLocal : true;
  const slash = file.lastIndexOf("/");

  return (
    <aside className="drawer" aria-label={`Detalle de ${file}`}>
      <header className="drawer-head">
        <div className="drawer-title">
          <p className="eyebrow">Archivo</p>
          <h2 className="drawer-path">
            <span className="drawer-dir">{file.slice(0, slash + 1)}</span>
            {file.slice(slash + 1)}
          </h2>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Cerrar detalle">
          ✕
        </button>
      </header>

      <div className="drawer-actions">
        {existsLocal ? (
          <a className="action" href={vscodeUrl(state.repo.root, file)} title="Abre tu copia local">
            Abrir en VS Code
          </a>
        ) : (
          <button
            type="button"
            className="action"
            disabled
            title="Este archivo aún no existe en tu carpeta"
          >
            Abrir en VS Code
          </button>
        )}
        <p className="action-hint">
          {existsLocal
            ? "Abre tu copia local, no la versión de tu compañero."
            : "Este archivo aún no existe en tu carpeta."}
        </p>
      </div>

      {touchers.length === 0 ? (
        <p className="muted drawer-empty">Nadie está tocando este archivo ahora mismo.</p>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Jugadores que tocan este archivo">
            {touchers.map((p) => (
              <button
                key={p.user}
                type="button"
                role="tab"
                aria-selected={p.user === player?.user}
                className="tab"
                style={{ "--c": colors.get(p.user) } as CSSProperties}
                onClick={() => {
                  setLoaded({ status: "loading" });
                  setTab(p.user);
                }}
              >
                <Face user={p.user} state={state} colors={colors} now={now} />
                {p.user}
                {p.isMe && " (tú)"}
              </button>
            ))}
          </div>

          {player && change && (
            <p className="drawer-meta">
              <span className={`badge badge-${change.status}`}>{change.status}</span>
              {STATUS_WORD[change.status]}
              {change.oldPath && (
                <>
                  {" "}
                  desde <code>{change.oldPath}</code>
                </>
              )}
              {change.added !== null && (
                <span className="touch-lines">
                  <span className="plus">+{change.added}</span>{" "}
                  <span className="minus">−{change.deleted}</span>
                </span>
              )}
              <span className="muted">· {timeAgo(player.lastWipAt, now)}</span>
            </p>
          )}

          <DiffBody loaded={loaded} />
        </>
      )}
    </aside>
  );
}

function DiffBody({ loaded }: { loaded: Loaded }) {
  const text = loaded.status === "ok" && loaded.diff.kind === "text" ? loaded.diff.text : null;
  const parsed = useMemo(() => (text === null ? null : parseDiff(text)), [text]);

  if (loaded.status === "loading") return <p className="muted drawer-empty">Cargando diff…</p>;
  if (loaded.status === "error") {
    return (
      <p className="notice notice-danger" role="alert">
        {loaded.message}
      </p>
    );
  }
  if (loaded.diff.kind === "binary" || parsed?.binary) {
    return <p className="muted drawer-empty">Archivo binario: no hay diff que mostrar.</p>;
  }
  if (!parsed) return null;

  return (
    <>
      {loaded.diff.truncated && (
        <p className="notice notice-warn" role="status">
          Diff recortado (200 KB): solo se muestra el principio.
        </p>
      )}
      {parsed.hunks.length === 0 ? (
        <p className="muted drawer-empty">Sin cambios de contenido.</p>
      ) : (
        <div className="diff" tabIndex={0} aria-label="Diff del archivo">
          <div className="diff-lines">
            {parsed.hunks.map((hunk, index) => (
              <div key={index} className="hunk">
                <div className="dl dl-hunk">
                  <span className="dl-num" />
                  <span className="dl-num" />
                  <span className="dl-mark" />
                  <span className="dl-text">{hunk.header}</span>
                </div>
                {hunk.lines.map((line, i) => (
                  <Line key={i} line={line} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** El signo (+, −) va escrito, no solo el color. */
const MARK: Record<DiffLine["kind"], string> = { add: "+", del: "−", context: "", note: "" };

function Line({ line }: { line: DiffLine }) {
  return (
    <div className={`dl dl-${line.kind}`}>
      <span className="dl-num">{line.oldLine ?? ""}</span>
      <span className="dl-num">{line.newLine ?? ""}</span>
      <span className="dl-mark">{MARK[line.kind]}</span>
      <span className="dl-text">{line.text}</span>
    </div>
  );
}
