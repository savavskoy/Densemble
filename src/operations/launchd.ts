import { isAbsolute, join } from "node:path";

export interface LaunchdOptions {
  node: string;
  codeRoot: string;
  config: string;
  logs: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function launchdTemplate(options: LaunchdOptions): string {
  if (Object.values(options).some((path) => !isAbsolute(path) || /[\u0000-\u001f]/.test(path))) {
    throw new Error("LAUNCHD_ABSOLUTE_PATHS_REQUIRED");
  }
  const text = (value: string) => `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.densemble.agent</string>
  <key>ProgramArguments</key><array>
    ${[options.node, join(options.codeRoot, "dist", "main.js"), "start", "--config", options.config].map(text).join("\n    ")}
  </array>
  <key>WorkingDirectory</key>${text(options.codeRoot)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key>${text(join(options.logs, "service.log"))}
  <key>StandardErrorPath</key>${text(join(options.logs, "service-error.log"))}
</dict></plist>
`;
}
