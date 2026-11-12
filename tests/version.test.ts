import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USER_AGENT } from "../src/openmeteo/http.js";
import { SERVER_VERSION } from "../src/server.js";
import { VERSION } from "../src/version.js";

describe("version", () => {
  it("matches package.json, and is the one used for the server info and User-Agent", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(VERSION);
    expect(USER_AGENT).toBe(`windwise-mcp/${VERSION}`);
  });
});
