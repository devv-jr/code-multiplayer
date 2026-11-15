// Avisos dentro de la página ("toasts"): aparecen abajo a la izquierda y se
// van solos a los pocos segundos.

import type { State } from "./api";
import type { Notice } from "./notifications";
import { Face } from "./ProjectMap";

export interface Toast extends Notice {
  /** Momento (ms) en que el aviso desaparece solo. */
  expiresAt: number;
}

/** Cuánto dura un aviso en pantalla. Los choques duran más. */
export const TOAST_MS = 8_000;
export const CLASH_TOAST_MS = 15_000;

export interface ToastsProps {
  toasts: readonly Toast[];
  state: State;
  colors: Map<string, string>;
  now: Date;
  onDismiss: (id: string) => void;
}

/** Muestra `texto con código` poniendo lo que va entre acentos graves como código. */
function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? <code key={index}>{part}</code> : <span key={index}>{part}</span>,
      )}
    </>
  );
}

export function Toasts({ toasts, state, colors, now, onDismiss }: ToastsProps) {
  return (
    // aria-live: los lectores de pantalla anuncian cada aviso nuevo.
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={toast.kind === "clash" ? "toast toast-clash" : "toast"}
          style={toast.user ? { "--c": colors.get(toast.user) } as React.CSSProperties : undefined}
        >
          {toast.user && <Face user={toast.user} state={state} colors={colors} now={now} />}
          <p className="toast-text">
            <RichText text={toast.text} />
          </p>
          <button
            type="button"
            className="toast-close"
            onClick={() => onDismiss(toast.id)}
            aria-label="Cerrar aviso"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
