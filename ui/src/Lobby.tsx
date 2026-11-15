// El lobby: el "núcleo" del repo a la izquierda y una tarjeta por jugador,
// unidas por líneas curvas de luz.

import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ASLEEP_AFTER_MS, playerStatus, type PlayerStatus } from "../../src/core/constants.js";
import { type Player, type State, timeAgo } from "./api";
import { Avatar } from "./avatar";
import { BranchIcon, MoonIcon } from "./icons";

const STATUS_LABEL: Record<PlayerStatus, { icon: ReactNode; text: string }> = {
  editando: { icon: "▶", text: "Editando" },
  pausa: { icon: "❚❚", text: "En pausa" },
  dormido: { icon: <MoonIcon />, text: "Dormido" },
};

/** Posición de un elemento dentro de `root`, sin contar transformaciones CSS. */
function offsetWithin(element: HTMLElement, root: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = element;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, width: element.offsetWidth, height: element.offsetHeight };
}

interface Link {
  user: string;
  /** Curva del núcleo a la tarjeta. */
  path: string;
  /** Punto donde la curva toca la tarjeta. */
  x: number;
  y: number;
}

export interface LobbyProps {
  state: State;
  colors: Map<string, string>;
  now: Date;
}

export function Lobby({ state, colors, now }: LobbyProps) {
  const { players } = state;
  const stageRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [links, setLinks] = useState<Link[]>([]);

  // Las curvas se dibujan midiendo dónde quedó cada tarjeta. Se vuelve a
  // medir cuando cambia el tamaño de la sala o de alguna tarjeta.
  const userKey = players.map((player) => player.user).join("\n");
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const core = coreRef.current;
    if (!stage || !core) return;

    const measure = () => {
      const from = offsetWithin(core, stage);
      const x0 = from.x + from.width / 2;
      const y0 = from.y + from.height / 2;

      const next: Link[] = [];
      for (const [user, card] of cardRefs.current) {
        const to = offsetWithin(card, stage);
        const x1 = to.x;
        const y1 = to.y + to.height / 2;
        const bend = x0 + (x1 - x0) * 0.55;
        next.push({ user, x: x1, y: y1, path: `M ${x0} ${y0} C ${bend} ${y0}, ${bend} ${y1}, ${x1} ${y1}` });
      }
      setLinks(next);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    for (const card of cardRefs.current.values()) observer.observe(card);
    return () => observer.disconnect();
  }, [userKey]);

  const meInRoom = players.some((player) => player.isMe);
  const filesInPlay = new Set(players.flatMap((player) => player.files.map((file) => file.path)));

  return (
    <section className="lobby" aria-labelledby="lobby-title">
      <header className="lobby-head">
        <p className="eyebrow">Sala</p>
        <h2 id="lobby-title">
          Sala de <span className="lobby-repo">{state.repo.name}</span>
        </h2>
        <p className="lobby-count">
          Jugadores en la sala: <strong>{players.length}</strong>
        </p>
      </header>

      <div className="stage" ref={stageRef}>
        {/* Líneas de luz del núcleo a cada jugador (decorativas). */}
        <svg className="links" aria-hidden="true">
          {links.map((link) => {
            const player = players.find((p) => p.user === link.user);
            if (!player) return null;
            const status = playerStatus(player.lastWipAt, now);
            return (
              <g
                key={link.user}
                className={`link link-${status}`}
                style={{ "--c": colors.get(link.user) } as CSSProperties}
              >
                <path className="link-line" d={link.path} />
                <path className="link-flow" d={link.path} />
                <circle className="link-dot" cx={link.x} cy={link.y} r="4" />
              </g>
            );
          })}
        </svg>

        <div className="core">
          <div className="core-orbit" ref={coreRef}>
            <span className="core-halo" />
            <span className="core-ring" />
            <span className="core-sphere" />
          </div>
          <p className="core-name">{state.repo.name}</p>
          <p className="core-branch">{state.repo.branch ?? "sin rama"}</p>
          <div className="core-chips">
            <span className="tag">
              <b>{filesInPlay.size}</b> {filesInPlay.size === 1 ? "archivo" : "archivos"} en juego
            </span>
            <span className={state.overlaps.length > 0 ? "tag tag-danger" : "tag"}>
              <b>{state.overlaps.length}</b> {state.overlaps.length === 1 ? "choque" : "choques"}
            </span>
          </div>
        </div>

        <div className="players">
          {players.length === 0 && (
            <div className="empty">
              <p className="empty-title">La sala está vacía</p>
              <p>
                Nadie ha subido trabajo todavía. Corre <code>mp start</code> en este repo para
                aparecer aquí, y dile a tu compañero que haga lo mismo.
              </p>
            </div>
          )}

          {players.map((player, index) => (
            <PlayerCard
              key={player.user}
              player={player}
              color={colors.get(player.user) ?? "#ffffff"}
              now={now}
              index={index}
              cardRef={(element) => {
                if (element) cardRefs.current.set(player.user, element);
                else cardRefs.current.delete(player.user);
              }}
            />
          ))}

          {players.length > 0 && !meInRoom && (
            <div className="ghost">
              <strong>{state.me} (tú)</strong> aún no está en la sala. Corre <code>mp start</code>{" "}
              para entrar.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface PlayerCardProps {
  player: Player;
  color: string;
  now: Date;
  index: number;
  cardRef: (element: HTMLElement | null) => void;
}

function PlayerCard({ player, color, now, index, cardRef }: PlayerCardProps) {
  const status = playerStatus(player.lastWipAt, now);
  const label = STATUS_LABEL[status];

  // "Energía": llena con un cambio reciente y se vacía en 30 min sin cambios
  // (el mismo umbral con el que pasa a "dormido").
  const age = Math.max(0, now.getTime() - new Date(player.lastWipAt).getTime());
  const energy = Math.round(Math.max(0, 1 - age / ASLEEP_AFTER_MS) * 100);

  return (
    <article
      ref={cardRef}
      className={`player player-${status}${player.isMe ? " player-me" : ""}`}
      style={{ "--c": color, "--i": index } as CSSProperties}
    >
      <div className="player-orb">
        <Avatar user={player.user} color={color} status={status} size={68} />
      </div>

      <div className="player-body">
        <div className="player-top">
          <h3 className="player-name">
            {player.user}
            {player.isMe && <span className="you">tú</span>}
          </h3>
          <span className={`status status-${status}`}>
            <span className="status-icon" aria-hidden="true">
              {label.icon}
            </span>
            {label.text}
          </span>
        </div>

        <p className="player-meta">
          <span className="branch" title="Rama en la que trabaja">
            <BranchIcon /> {player.baseBranch ?? "sin rama"}
          </span>
          <span>{timeAgo(player.lastWipAt, now)}</span>
        </p>

        <div className="energy" title="Se vacía en 30 min sin cambios">
          <span className="energy-label">Energía</span>
          <span
            className="energy-bar"
            role="meter"
            aria-label={`Energía de ${player.user}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={energy}
          >
            <span className="energy-fill" style={{ width: `${energy}%` }} />
          </span>
          <span className="energy-value">{energy}%</span>
        </div>

        {player.error ? (
          <p className="notice notice-danger" role="alert">
            {player.error}
          </p>
        ) : (
          <p className="player-stats">
            <span>
              <b>{player.totals.files}</b> {player.totals.files === 1 ? "archivo" : "archivos"}
            </span>
            <span className="sep">·</span>
            <span className="plus">+{player.totals.added}</span>
            <span className="minus">−{player.totals.deleted}</span>
          </p>
        )}

        {player.isMe && player.daemonRunning === false && (
          <p className="notice notice-warn" role="alert">
            Tu daemon está apagado: corre <code>mp start</code>
          </p>
        )}
      </div>
    </article>
  );
}
