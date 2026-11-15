// Avatar de un jugador: una criatura en SVG dibujada en código. El cuerpo,
// los ojos y el accesorio salen del hash del nombre, así que cada quien
// tiene siempre la misma. Es arte propio de mp.

import type { PlayerStatus } from "../../src/core/constants.js";
import { avatarTraits } from "./palette";

const INK = "#071012"; // color de ojos y boca

/** Silueta del cuerpo, en un lienzo de 100×100. */
function Body({ kind, color }: { kind: string; color: string }) {
  switch (kind) {
    case "cubo":
      return <rect x="17" y="24" width="66" height="62" rx="20" fill={color} />;
    case "semilla":
      return (
        <path
          d="M50 16 C70 16 80 38 80 60 C80 79 67 89 50 89 C33 89 20 79 20 60 C20 38 30 16 50 16 Z"
          fill={color}
        />
      );
    case "nube":
      return (
        <path
          d="M24 88 C13 88 12 72 20 67 C12 55 22 40 35 44 C37 28 62 26 66 42 C79 37 91 52 82 66 C90 72 88 88 76 88 Z"
          fill={color}
        />
      );
    default: // gota
      return (
        <path
          d="M50 14 C74 14 87 34 87 56 C87 78 71 90 50 90 C29 90 13 78 13 56 C13 34 26 14 50 14 Z"
          fill={color}
        />
      );
  }
}

/** Accesorio sobre la cabeza. */
function Extra({ kind, color }: { kind: string; color: string }) {
  switch (kind) {
    case "antena":
      return (
        <g>
          <path d="M50 20 C50 12 54 8 58 5" stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" />
          <circle className="avatar-spark" cx="59" cy="4.5" r="4" fill="#fff" />
        </g>
      );
    case "cuernos":
      return (
        <g fill={color}>
          <path d="M28 30 L22 10 L40 22 Z" />
          <path d="M72 30 L78 10 L60 22 Z" />
        </g>
      );
    case "aro":
      return (
        <ellipse cx="50" cy="9" rx="20" ry="4.5" fill="none" stroke="#fff" strokeWidth="2.5" opacity="0.85" />
      );
    case "cresta":
      return (
        <g fill={color}>
          <path d="M38 24 L42 8 L48 22 Z" />
          <path d="M46 22 L51 3 L56 22 Z" />
          <path d="M54 22 L60 8 L63 24 Z" />
        </g>
      );
    default:
      return null;
  }
}

/** Ojos abiertos (parpadean con CSS) o cerrados cuando duerme. */
function Eyes({ kind, asleep }: { kind: string; asleep: boolean }) {
  if (asleep) {
    // Dos arcos: párpados cerrados.
    const lid = { stroke: INK, strokeWidth: 3, fill: "none", strokeLinecap: "round" as const };
    return kind === "ciclope" ? (
      <path d="M40 52 Q50 59 60 52" {...lid} />
    ) : (
      <g>
        <path d="M30 52 Q37 58 44 52" {...lid} />
        <path d="M56 52 Q63 58 70 52" {...lid} />
      </g>
    );
  }

  switch (kind) {
    case "visor":
      return (
        <g className="avatar-eyes">
          <rect x="24" y="42" width="52" height="18" rx="9" fill={INK} />
          <circle cx="38" cy="51" r="3.5" fill="#fff" />
          <circle cx="62" cy="51" r="3.5" fill="#fff" />
        </g>
      );
    case "ciclope":
      return (
        <g className="avatar-eyes">
          <circle cx="50" cy="50" r="14" fill="#fff" />
          <circle cx="52" cy="51" r="7" fill={INK} />
          <circle cx="55" cy="48" r="2.2" fill="#fff" />
        </g>
      );
    default: // redondos
      return (
        <g className="avatar-eyes">
          <circle cx="37" cy="50" r="9" fill="#fff" />
          <circle cx="63" cy="50" r="9" fill="#fff" />
          <circle cx="39" cy="51" r="4.5" fill={INK} />
          <circle cx="65" cy="51" r="4.5" fill={INK} />
        </g>
      );
  }
}

export interface AvatarProps {
  user: string;
  color: string;
  status: PlayerStatus;
  /** Tamaño en píxeles. */
  size?: number;
  /** Versión pequeña (para el mapa): sin el "zZz" flotante. */
  mini?: boolean;
}

export function Avatar({ user, color, status, size = 64, mini = false }: AvatarProps) {
  const traits = avatarTraits(user);
  const asleep = status === "dormido";

  return (
    <span className={`avatar avatar-${status}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <g className="avatar-figure">
          <Extra kind={traits.extra} color={color} />
          <Body kind={traits.body} color={color} />
          {/* Brillo arriba y sombra abajo, para dar volumen. */}
          <ellipse cx="38" cy="33" rx="13" ry="6" fill="#fff" opacity="0.28" />
          <ellipse cx="50" cy="80" rx="24" ry="7" fill="#000" opacity="0.16" />
          <Eyes kind={traits.eyes} asleep={asleep} />
          {asleep ? (
            <circle cx="50" cy="70" r="3" fill={INK} />
          ) : (
            <path d="M43 69 Q50 75 57 69" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
          )}
        </g>
      </svg>
      {asleep && !mini && <span className="avatar-zzz">zZz</span>}
    </span>
  );
}
