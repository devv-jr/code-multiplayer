import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../src/core/types.js";
import {
  activityText,
  clashText,
  NoticeGrouper,
  SystemThrottle,
} from "../ui/src/notifications.js";

const started = (user: string, file: string): ActivityEvent => ({ type: "started-file", user, file });
const joined = (user: string): ActivityEvent => ({ type: "joined", user });
const wokeUp = (user: string): ActivityEvent => ({ type: "woke-up", user });
const overlap = (file: string, users: string[]): ActivityEvent => ({ type: "overlap", file, users });

describe("textos de los avisos", () => {
  it("un archivo: usa el nombre del archivo, sin la carpeta", () => {
    expect(activityText("yered", [started("yered", "src/pagos/pagos.ts")])).toBe(
      "Yered empezó a editar `pagos.ts`",
    );
  });

  it("varios archivos: los cuenta", () => {
    expect(
      activityText("yered", [
        started("yered", "a.ts"),
        started("yered", "b.ts"),
        started("yered", "c.ts"),
        started("yered", "a.ts"), // repetido: no cuenta dos veces
      ]),
    ).toBe("Yered empezó a editar 3 archivos");
  });

  it("unirse, despertar, y despertar editando", () => {
    expect(activityText("yered", [joined("yered")])).toBe("¡Yered se unió a la sala!");
    expect(activityText("yered", [wokeUp("yered")])).toBe("Yered se despertó");
    expect(activityText("yered", [wokeUp("yered"), started("yered", "pagos.ts")])).toBe(
      "Yered se despertó y empezó a editar `pagos.ts`",
    );
  });

  it("choque: dice quiénes y en qué archivo, conmigo como Tú", () => {
    expect(clashText("src/pagos.ts", ["bruno", "yered"], "bruno")).toBe(
      "⚠️ Tú y Yered están en `pagos.ts`",
    );
    expect(clashText("pagos.ts", ["ana", "yered"], "bruno")).toBe(
      "⚠️ Ana y Yered están en `pagos.ts`",
    );
  });
});

describe("NoticeGrouper", () => {
  it("un lote con varios eventos del mismo jugador da un solo aviso", () => {
    const grouper = new NoticeGrouper("bruno");

    const notices = grouper.push([started("yered", "a.ts"), started("yered", "b.ts")], 0);

    expect(notices).toEqual([
      {
        id: "activity-1",
        kind: "activity",
        user: "yered",
        text: "Yered empezó a editar 2 archivos",
        isNew: true,
      },
    ]);
  });

  it("dentro de 10 s actualiza el mismo aviso; después crea uno nuevo", () => {
    const grouper = new NoticeGrouper("bruno");

    const [first] = grouper.push([started("yered", "a.ts")], 0);
    const [update] = grouper.push([started("yered", "b.ts"), started("yered", "c.ts")], 10_000);
    const [later] = grouper.push([started("yered", "d.ts")], 10_001);

    expect(first).toMatchObject({ id: "activity-1", isNew: true, text: "Yered empezó a editar `a.ts`" });
    expect(update).toMatchObject({
      id: "activity-1",
      isNew: false,
      text: "Yered empezó a editar 3 archivos",
    });
    expect(later).toMatchObject({ id: "activity-2", isNew: true, text: "Yered empezó a editar `d.ts`" });
  });

  it("cada jugador tiene su propio aviso", () => {
    const grouper = new NoticeGrouper("bruno");

    const notices = grouper.push(
      [started("yered", "a.ts"), joined("ana"), started("yered", "b.ts")],
      0,
    );

    expect(notices.map((notice) => [notice.user, notice.text])).toEqual([
      ["yered", "Yered empezó a editar 2 archivos"],
      ["ana", "¡Ana se unió a la sala!"],
    ]);
  });

  it("los choques van aparte, uno por archivo, y nunca se agrupan", () => {
    const grouper = new NoticeGrouper("bruno");

    const notices = grouper.push(
      [
        started("yered", "pagos.ts"),
        overlap("pagos.ts", ["bruno", "yered"]),
        overlap("app.ts", ["bruno", "yered"]),
      ],
      0,
    );

    expect(notices.map((notice) => [notice.kind, notice.isNew, notice.text])).toEqual([
      ["clash", true, "⚠️ Tú y Yered están en `pagos.ts`"],
      ["clash", true, "⚠️ Tú y Yered están en `app.ts`"],
      ["activity", true, "Yered empezó a editar `pagos.ts`"],
    ]);
    expect(new Set(notices.map((notice) => notice.id)).size).toBe(3);
  });

  it("nunca avisa sobre mi propio trabajo", () => {
    const grouper = new NoticeGrouper("bruno");

    expect(grouper.push([started("bruno", "a.ts"), joined("bruno"), wokeUp("bruno")], 0)).toEqual([]);
    expect(grouper.push([], 0)).toEqual([]);
  });
});

describe("SystemThrottle", () => {
  const notice = (user: string, isNew = true) => ({
    id: "x",
    kind: "activity" as const,
    user,
    text: "",
    isNew,
  });
  const clash = { id: "c", kind: "clash" as const, user: null, text: "", isNew: true };

  it("máximo una notificación por jugador cada 60 s", () => {
    const throttle = new SystemThrottle();

    expect(throttle.allow(notice("yered"), 0)).toBe(true);
    expect(throttle.allow(notice("yered"), 30_000)).toBe(false);
    expect(throttle.allow(notice("yered"), 59_999)).toBe(false);
    expect(throttle.allow(notice("yered"), 60_000)).toBe(true);
    // El límite es por jugador.
    expect(throttle.allow(notice("ana"), 60_001)).toBe(true);
  });

  it("la actualización de un aviso ya mostrado no notifica de nuevo", () => {
    const throttle = new SystemThrottle();

    expect(throttle.allow(notice("yered", false), 0)).toBe(false);
    // ...y no gasta el turno del jugador.
    expect(throttle.allow(notice("yered"), 1)).toBe(true);
  });

  it("los choques siempre pasan", () => {
    const throttle = new SystemThrottle();
    throttle.allow(notice("yered"), 0);

    expect(throttle.allow(clash, 1)).toBe(true);
    expect(throttle.allow(clash, 2)).toBe(true);
  });
});
