import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSignal } from "./types.js";

export function createRegistry(home: string): AgentSignal[] {
  const inHome = (...parts: string[]): string => join(home, ...parts);

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      kind: "cloud",
      binaryPatterns: [
        /(?:^|\/)\.local\/bin\/claude(?:\s|$)/i,
        /(?:^|\/)claude(?:\s+(?:bg-pty-host|bg-spare))?(?:\s|$)/i,
      ],
      excludePatterns: [/\/Applications\/Claude\.app\//i],
      configDirs: [inHome(".claude")],
      staticPaths: [inHome(".local", "bin", "claude")],
      sessionGlobs: [inHome(".claude", "projects", "**", "*.jsonl")],
    },
    {
      id: "codex-cli",
      label: "Codex CLI",
      kind: "cloud",
      binaryPatterns: [
        /@openai\/codex-darwin-[^/]+\/.*\/bin\/codex(?:\s|$)/i,
        /(?:^|\/)codex(?:\s|$)/i,
        /codex-code-mode-host/i,
      ],
      excludePatterns: [
        /\/Applications\/ChatGPT\.app\//i,
        /\/\.codex\/computer-use\/Codex Computer Use\.app\//i,
        /SkyComputerUseService/i,
      ],
      configDirs: [inHome(".codex")],
      sessionGlobs: [inHome(".codex", "sessions", "**", "rollout-*.jsonl")],
    },
    {
      id: "cursor-agent",
      label: "Cursor Agent",
      kind: "cloud",
      binaryPatterns: [/(?:^|\/)cursor-agent(?:\s|$)/i],
      excludePatterns: [/CursorUIViewService/i],
      configDirs: [inHome(".cursor")],
      staticPaths: [inHome(".local", "bin", "cursor-agent")],
    },
    {
      id: "comet",
      label: "Comet",
      kind: "cloud",
      binaryPatterns: [
        /^\/Applications\/Comet\.app\/Contents\/(?:MacOS|Frameworks)\//i,
      ],
      configDirs: [inHome("Library", "Application Support", "Comet")],
      staticPaths: ["/Applications/Comet.app"],
      networkActivity: false,
    },
    {
      id: "antigravity",
      label: "Antigravity",
      kind: "cloud",
      binaryPatterns: [
        /\/Applications\/Antigravity(?: IDE)?\.app\/Contents\//i,
        /(?:^|\/)agy(?:\s|$)/i,
      ],
      configDirs: [
        inHome("Library", "Application Support", "Antigravity IDE"),
        inHome("Library", "Application Support", "Antigravity"),
      ],
      staticPaths: [
        "/Applications/Antigravity IDE.app",
        inHome(".local", "bin", "agy"),
      ],
    },
    {
      id: "ollama",
      label: "Ollama",
      kind: "local",
      binaryPatterns: [/\/Applications\/Ollama\.app\//i, /\/Resources\/ollama(?:\s|$)/i],
      configDirs: [inHome(".ollama")],
      localProbe: { defaultPort: 11434, path: "/api/ps" },
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      kind: "local",
      binaryPatterns: [
        /\.lmstudio\/\.internal\/utils\/node(?:\s|$)/i,
        /\/Applications\/LM Studio\.app\//i,
      ],
      configDirs: [inHome(".lmstudio")],
      localProbe: { defaultPort: 1234, path: "/api/v0/models" },
    },
  ];
}

export const SIGNALS = createRegistry(homedir());
