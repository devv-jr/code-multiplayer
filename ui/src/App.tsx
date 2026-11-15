import { useMemo, useState } from "react";
import { type State, timeAgo, useNow, usePanel } from "./api";
import { BranchIcon } from "./icons";
import { Lobby } from "./Lobby";
import { assignColors } from "./palette";
import { ProjectMap } from "./ProjectMap";
import { joinNames } from "./text";

/** Cuántos choques se listan en el banner antes de resumir. */
const MAX_CLASHES_SHOWN = 3;

export function App() {
  const { state, tree, connected } = usePanel();
  const now = useNow();
  const [onlyActive, setOnlyActive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // El color de cada jugador depende solo de quiénes están en la sala.
  const userKey = state?.players.map((player) => player.user).join("\n") ?? "";
  const colors = useMemo(() => assignColors(userKey === "" ? [] : userKey.split("\n")), [userKey]);

  if (!state) {
    return (
      <main className="page">
        <p className="loading">{connected ? "Cargando la sala…" : "Conectando con mp…"}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-text">
            <strong>mp</strong>
            <span>Code Multiplayer</span>
          </span>
        </div>

        <div className="pills">
          <span className="pill" title="Tu rama actual">
            <BranchIcon /> {state.repo.branch ?? "sin rama"}
          </span>
          <span className={connected ? "pill pill-on" : "pill pill-off"} role="status">
            {connected ? "● conectado" : "Reconectando…"}
          </span>
          <span className="pill pill-quiet">
            {state.fetchedAt
              ? `actualizado ${timeAgo(state.fetchedAt, now)}`
              : "sin actualizar todavía"}
          </span>
          <button
            type="button"
            className="pill switch"
            role="switch"
            aria-checked={onlyActive}
            onClick={() => setOnlyActive(!onlyActive)}
          >
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            Solo archivos con actividad
          </button>
        </div>
      </header>

      {!state.fetch.ok && (
        <p className="band band-warn" role="alert">
          No pude actualizar desde el remoto: <code>{state.fetch.error}</code>. Reintentando…
        </p>
      )}

      <ClashBanner state={state} onSelect={setSelected} />

      <Lobby state={state} colors={colors} now={now} />

      <ProjectMap
        state={state}
        tree={tree}
        colors={colors}
        now={now}
        onlyActive={onlyActive}
        selected={selected}
        onSelect={(path) => setSelected(path === selected ? null : path)}
      />
    </main>
  );
}

/**
 * Aviso de choque. El texto dice "mismo archivo" a propósito: mp solo sabe
 * que coinciden en el archivo, no si sus cambios chocan línea por línea.
 */
function ClashBanner({ state, onSelect }: { state: State; onSelect: (path: string) => void }) {
  const { overlaps } = state;
  if (overlaps.length === 0) return null;

  const shown = overlaps.slice(0, MAX_CLASHES_SHOWN);
  const hidden = overlaps.length - shown.length;

  return (
    <div className="clash" role="alert">
      <span className="clash-icon" aria-hidden="true">
        ⚠️
      </span>
      <ul className="clash-list">
        {shown.map((overlap) => (
          <li key={overlap.file}>
            {joinNames(overlap.users, state.me)} están en el mismo archivo:{" "}
            <button type="button" className="clash-file" onClick={() => onSelect(overlap.file)}>
              {overlap.file}
            </button>
          </li>
        ))}
        {hidden > 0 && (
          <li className="muted">
            y {hidden} {hidden === 1 ? "archivo más" : "archivos más"} (márcalos en el mapa con
            “Solo archivos con actividad”)
          </li>
        )}
      </ul>
    </div>
  );
}
