import { describe, expect, it } from "vitest";
import { measure, SCHEMA_VERSION } from "../src/index";

describe("core smoke", () => {
  it("sizes text in bytes, code points and estimated tokens", () => {
    expect(measure("Always run tests.\n")).toEqual({ bytes: 18, chars: 18, estTokens: 5 });
  });
  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(measure("é🙂")).toMatchObject({ bytes: 6, chars: 2 });
  });
  it("has a schema version", () => {
    expect(SCHEMA_VERSION).toBeTruthy();
  });
});
