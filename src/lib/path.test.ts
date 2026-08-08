import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { expandHome, homeRelative } from "./path.js";

describe("expandHome / homeRelative", () => {
  it("round-trips: what homeRelative prints, expandHome accepts back", () => {
    const abs = resolve(homedir(), "statements", "a.pdf");
    const printed = homeRelative(abs);
    expect(printed).toBe("~" + sep + "statements" + sep + "a.pdf");
    expect(expandHome(printed)).toBe(abs);
  });

  it("expands bare `~` and leaves non-tilde and non-home paths alone", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("plain/relative")).toBe("plain/relative");
    expect(homeRelative("disk I/O error")).toBe("disk I/O error");
    expect(homeRelative(resolve(sep, "srv", "x"))).toBe(resolve(sep, "srv", "x"));
  });

  it.skipIf(process.platform === "win32")(
    "leaves `~\\x` alone on POSIX, where backslash is a filename byte",
    () => {
      expect(expandHome("~\\x")).toBe("~\\x");
    },
  );
});
