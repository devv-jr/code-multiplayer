// Avisos de actividad: convierte los eventos del servidor en mensajes,
// los agrupa por jugador y decide cuándo molestar con una notificación del
// sistema. La lógica es pura (recibe la hora) para poder probarla.

import type { ActivityEvent } from "../../src/core/types.js";
import { joinNames } from "./text";

/** Los eventos del mismo jugador dentro de esta ventana se juntan en un aviso. */
export const GROUP_WINDOW_MS = 10_000;

/** Como máximo una notificación del sistema por jugador en este tiempo. */
export const SYSTEM_GAP_MS = 60_000;

export interface Notice {
  /** Si llega otro aviso con el mismo id, reemplaza al anterior. */
  id: string;
  /** clash: dos personas en el mismo archivo. Siempre se muestra. */
  kind: "activity" | "clash";
  /** El jugador del aviso; null en los choques. */
  user: string | null;
  /** Texto en español. Lo que va entre `acentos graves` es código. */
  text: string;
  /** false si es la actualización de un aviso que ya se mostró. */
  isNew: boolean;
}

/** "yered" → "Yered" (los usuarios de mp van en minúsculas). */
export function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Un solo mensaje para todo lo que hizo un jugador en la ventana. */
export function activityText(user: string, events: readonly ActivityEvent[]): string {
  const name = capitalize(user);
  if (events.some((event) => event.type === "joined")) return `¡${name} se unió a la sala!`;

  const files = [
    ...new Set(events.flatMap((event) => (event.type === "started-file" ? [event.file] : []))),
  ];
  const editing =
    files.length === 1
      ? `empezó a editar \`${baseName(files[0]!)}\``
      : `empezó a editar ${files.length} archivos`;

  if (events.some((event) => event.type === "woke-up")) {
    return files.length === 0 ? `${name} se despertó` : `${name} se despertó y ${editing}`;
  }
  return `${name} ${editing}`;
}

/** Aviso de choque. Dice "están en": es el mismo archivo, no un conflicto seguro. */
export function clashText(file: string, users: readonly string[], me: string): string {
  return `⚠️ ${joinNames(users.map(capitalize), capitalize(me))} están en \`${baseName(file)}\``;
}

/**
 * Agrupa los eventos por jugador. El primer evento de alguien crea un aviso;
 * lo que haga en los 10 s siguientes actualiza ESE aviso ("empezó a editar
 * 3 archivos") en lugar de crear otros. Los choques van siempre aparte.
 */
export class NoticeGrouper {
  private readonly me: string;
  private readonly windowMs: number;
  private readonly open = new Map<
    string,
    { id: string; startedAt: number; events: ActivityEvent[] }
  >();
  private counter = 0;

  constructor(me: string, windowMs: number = GROUP_WINDOW_MS) {
    this.me = me;
    this.windowMs = windowMs;
  }

  /** Recibe un lote de eventos y devuelve los avisos a mostrar o actualizar. */
  push(events: readonly ActivityEvent[], now: number): Notice[] {
    const notices: Notice[] = [];
    const touched = new Map<string, boolean>(); // usuario → ¿aviso nuevo?

    for (const event of events) {
      if (event.type === "overlap") {
        notices.push({
          id: `clash-${++this.counter}`,
          kind: "clash",
          user: null,
          text: clashText(event.file, event.users, this.me),
          isNew: true,
        });
        continue;
      }
      // El servidor no manda eventos sobre mí; por si acaso, se descartan.
      if (event.user === this.me) continue;

      let group = this.open.get(event.user);
      if (!group || now - group.startedAt > this.windowMs) {
        group = { id: `activity-${++this.counter}`, startedAt: now, events: [] };
        this.open.set(event.user, group);
        touched.set(event.user, true);
      } else if (!touched.has(event.user)) {
        touched.set(event.user, false);
      }
      group.events.push(event);
    }

    for (const [user, isNew] of touched) {
      const group = this.open.get(user)!;
      notices.push({
        id: group.id,
        kind: "activity",
        user,
        text: activityText(user, group.events),
        isNew,
      });
    }
    return notices;
  }
}

/**
 * Decide si un aviso merece notificación del sistema: los choques siempre;
 * lo demás, una vez por jugador cada 60 s, y nunca por una actualización.
 */
export class SystemThrottle {
  private readonly last = new Map<string, number>();

  allow(notice: Notice, now: number): boolean {
    if (notice.kind === "clash") return true;
    if (!notice.isNew || notice.user === null) return false;

    const previous = this.last.get(notice.user);
    if (previous !== undefined && now - previous < SYSTEM_GAP_MS) return false;
    this.last.set(notice.user, now);
    return true;
  }
}

// ───────────── Notificaciones del navegador ─────────────

/** unsupported: el navegador no tiene notificaciones. */
export type Permission = "unsupported" | "default" | "granted" | "denied";

export function notificationPermission(): Permission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Pide el permiso. Debe llamarse desde un clic: el navegador lo exige. */
export async function askNotificationPermission(): Promise<Permission> {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.requestPermission();
}

export function showSystemNotification(title: string, notice: Notice): void {
  // El texto plano no tiene formato: se quitan los acentos graves del código.
  // tag: un aviso con el mismo id reemplaza al anterior en vez de apilarse.
  new Notification(title, { body: notice.text.replaceAll("`", ""), tag: notice.id });
}
