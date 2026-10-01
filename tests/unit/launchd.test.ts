import { describe, expect, it } from "vitest";
import { launchdTemplate } from "../../src/operations/launchd.js";

const options = { node: "/opt/node/bin/node", codeRoot: "/srv/densemble",
  config: "/srv/densemble/config.local.json", logs: "/srv/densemble/logs" };
describe("launchd configuration generation", () => {
  it("renders only a direct Node invocation and file references, never shell interpolation", () => {
    const xml = launchdTemplate(options);
    expect(xml).toContain("<string>/opt/node/bin/node</string>");
    expect(xml).toContain("<string>/srv/densemble/dist/main.js</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<key>Umask</key><integer>63</integer>");
    expect(xml).not.toContain("/bin/sh");
    expect(xml).not.toContain("TOKEN");
  });
  it("escapes paths as XML text and rejects ambiguous relative/control paths", () => {
    const xml = launchdTemplate({ ...options, config: '/srv/A&B/"config"<local>.json' });
    expect(xml).toContain("A&amp;B/&quot;config&quot;&lt;local&gt;.json");
    for (const node of ["node", "", "/opt/node\ninjected", "/opt/\0node"]) {
      expect(() => launchdTemplate({ ...options, node })).toThrow("LAUNCHD_ABSOLUTE_PATHS_REQUIRED");
    }
  });
});
