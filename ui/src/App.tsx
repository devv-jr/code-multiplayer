import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ActivityEvent, type State, timeAgo, useNow, usePanel } from "./api";
import { DiffDrawer } from "./DiffDrawer";
import { BranchIcon } from "./icons";
import { Lobby } from "./Lobby";
import {
  askNotificationPermission,
  NoticeGrouper,
  notificationPermission,
  type Permission,
  showSystemNotification,
  SystemThrottle,
} from "./notifications";
import { assignColors } from "./palette";
import { ProjectMap } from "./ProjectMap";
import { joinNames } from "./text";
import { CLASH_TOAST_MS, type Toast, TOAST_MS, Toasts } from "./Toasts";

/** Como mucho, este número de avisos a la vez en pantalla. */
const MAX_TOASTS = 5;

/** Cuántos choques se listan en el banner antes de resumir. */
const MAX_CLASHES_SHOWN = 3;

export function App() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [permission, setPermission] = useState<Permission>(notificationPermission);
  const stateRef = useRef<State | null>(null);
  const grouper = useRef<NoticeGrouper | null>(null);
  const throttle = useRef(new SystemThrottle());

  // Cada lote de novedades del servidor se convierte en avisos.
  const onActivity = (events: ActivityEvent[]) => {
    const current = stateRef.current;
    if (!current) return;
    grouper.current ??= new NoticeGrouper(current.me);
    const nowMs = Date.now();

    const fresh: Toast[] = [];
    for (const notice of grouper.current.push(events, nowMs)) {
      // Pestaña oculta y con permiso: notificación del sistema.
      // Pestaña visible (o sin permiso): aviso dentro de la página.
      const canNotify = document.hidden && notificationPermission() === "granted";
      if (canNotify && throttle.current.allow(notice, nowMs)) {
        showSystemNotification(`mp · ${current.repo.name}`, notice);
      } else {
        const life = notice.kind === "clash" ? CLASH_TOAST_MS : TOAST_MS;
        fresh.push({ ...notice, expiresAt: nowMs + life });
      }
    }
    if (fresh.length > 0) {
      // Un aviso con el mismo id reemplaza al anterior (es su actualización).
      setToasts((old) =>
        [...old.filter((toast) => !fresh.some((f) => f.id === toast.id)), ...fresh].slice(-MAX_TOASTS),
      );
    }
  };

  const { state, tree, connected } = usePanel(onActivity);
  stateRef.current = state;
  const now = useNow();

  // Los avisos vencidos se retiran solos.
  useEffect(() => {
    setToasts((old) =>
      old.some((toast) => toast.expiresAt <= now.getTime())
        ? old.filter((toast) => toast.expiresAt > now.getTime())
        : old,
    );
  }, [now]);
  const dismissToast = useCallback(
    (id: string) => setToasts((old) => old.filter((toast) => toast.id !== id)),
    [],
  );
  const [onlyActive, setOnlyActive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const closeDrawer = useCallback(() => setSelected(null), []);

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
    <main className={selected ? "page with-drawer" : "page"}>
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
          <BellPill permission={permission} onChange={setPermission} />
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

      {/* key: al cambiar de archivo el cajón empieza de cero (pestaña y diff). */}
      {selected && (
        <DiffDrawer
          key={selected}
          file={selected}
          state={state}
          colors={colors}
          now={now}
          onClose={closeDrawer}
        />
      )}

      <Toasts toasts={toasts} state={state} colors={colors} now={now} onDismiss={dismissToast} />
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

/**
 * Estado de las notificaciones del sistema. El permiso solo se puede pedir
 * desde un clic del usuario, por eso es un botón.
 */
function BellPill({
  permission,
  onChange,
}: {
  permission: Permission;
  onChange: (permission: Permission) => void;
}) {
  switch (permission) {
    case "granted":
      return (
        <span className="pill pill-on" title="Te aviso cuando esta pestaña está en segundo plano">
          🔔 Avisos activados
        </span>
      );
    case "denied":
      return (
        <span
          className="pill pill-off"
          title="Están bloqueados para este sitio. Permítelos en los ajustes del navegador."
        >
          🔕 Avisos bloqueados
        </span>
      );
    case "unsupported":
      return <span className="pill pill-quiet">🔕 Avisos no disponibles</span>;
    default:
      return (
        <button
          type="button"
          className="pill bell"
          onClick={() => void askNotificationPermission().then(onChange)}
        >
          🔔 Activar avisos
        </button>
      );
  }
}
