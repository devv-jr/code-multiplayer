import { describe, expect, it } from "vitest";
import { joinNames } from "../ui/src/text.js";

describe("joinNames", () => {
  it("une dos o más nombres en español", () => {
    expect(joinNames(["ana", "bruno"], "yered")).toBe("ana y bruno");
    expect(joinNames(["ana", "bruno", "luis"], "yered")).toBe("ana, bruno y luis");
    expect(joinNames(["ana"], "yered")).toBe("ana");
    expect(joinNames([], "yered")).toBe("");
  });

  it("mi usuario se muestra como Tú y va primero", () => {
    expect(joinNames(["bruno", "yered"], "yered")).toBe("Tú y bruno");
    expect(joinNames(["ana", "bruno", "yered"], "bruno")).toBe("Tú, ana y yered");
  });
});
