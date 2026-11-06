# How Densemble is built

The mental model behind Densemble: its terms, how they fit together, what
happens to a message, who may do what and where everything is stored. What the
product can do is in the [overview](overview.md); exact rules are in
[contracts](contracts.md).

## Glossary

| Term | Meaning |
|---|---|
| **Owner** | The person who runs the service. Identified by `ownerId` (Telegram user ID); has every right. |
| **User** | Another person the owner adds in `users`, with the bots they may use. |
| **Workspace** | A folder an agent works in: its agent part, its knowledge and its current context (see [Workspace](#workspace)). |
| **Persona (agent)** | A character with a role, defined by a Markdown file in the workspace's agent part. Users talk to personas. |
| **Worker (subagent)** | An agent definition that is not user-invocable: personas may delegate to it, but it has no bot. |
| **Skill** | Reusable "how to" instructions an agent loads for a class of tasks. |
| **Bot** | A Telegram bot (`bots[]`) bound to exactly one persona and one engine. |
| **Binding** | Permission for a bot to serve one chat: a private chat, a group or a forum topic (`bindings[]`). |
| **Scope** | One conversation place: owner or user, bot, chat and topic. Every scope has its own history. |
| **Session** | One conversation in a scope: a persona, a workspace, a model and an engine. `/new` starts another. |
| **Run (turn)** | One answer of the agent to one input, from the message to the final reply. |
| **Engine** | What runs the model: Copilot (default) or Claude Code. Fixed per bot and per session. |
| **Module** | An optional feature in `src/modules/<id>/`, switched only in the configuration. |
| **Ability** | A tool a module gives to the agents allowed in `modules.<id>.agents`. |
| **Proactive item** | A reminder, check-in or silent check an agent schedules in its own chat. |
| **Coordinator** | The persona (`coordinatorAgentId`) that tells the owner about module failures. |

## Workspace

A workspace is the unit Densemble works with. It holds three kinds of content:

- **Agent part:** personas (`agent/agents/<name>/AGENT.md`), their launchers
  (`.github/agents/*.agent.md`: model, tools, user-invocable), skills
  (`agent/skills/`) and tools, plus the workspace rules in `AGENTS.md`. Agents are
  written for their workspace, so most of their instructions refer to it.
- **Knowledge base:** durable knowledge, organised as an LLM wiki the agents read
  and maintain.
- **Current context:** operational files about what the team is focused on now.
  When work settles, its lasting results move into the knowledge base.

Densemble does not impose a folder layout beyond the agent part; the knowledge
base and current context are conventions of the workspace, described in its own
`AGENTS.md`.

How this maps to the configuration today:

- `workspacePath` is the **main workspace**: it contains the agent part
  (`agentDefinitionsPath`, `agentLaunchersPath`, `skillDirectories`) and is the
  owner's default workspace. Agents always come from here.
- `workspaces[]` adds further workspaces with their own members
  (`access: private | shared`) and the personas allowed there (`agentIds`). Such a
  workspace may be exactly the main workspace (agent part and knowledge together)
  or a separate folder that uses the main workspace's agents and its own
  `AGENTS.md`.
- A workspace is a plain local folder. It may be a Git repository, but Densemble
  does not use Git.

## How the pieces fit

```text
                 config.local.json
                        │
        ┌───────────────┼──────────────────┐
        ▼               ▼                  ▼
   owner, users      bots ──► persona   workspaces ──► members, allowed personas
        │               │                  │
        └──── binding: bot × chat ─────────┘
                        │
                        ▼
      scope (person, bot, chat, topic) ──► sessions ──► runs
                        │
          session = persona × workspace × model × engine
```

- A persona can have several bots (one per engine); a bot has one persona.
- A person reaches a bot only through a binding of their own private chat;
  groups and forum topics are bound for the owner only.
- A session opens only in a workspace the person is a member of and only with a
  persona that workspace allows.
- Inside a session the agent sees the other personas of the workspace and can
  consult them as subagents; Densemble's built-in generic subagents are disabled.

## Life of a message

1. **Telegram → ingress.** The bot polls Telegram. Each update is checked first:
   known person, bound chat, exact topic. Anything else is ignored before any
   model, media or tool work.
2. **Admission.** The input is stored in SQLite with deduplication; albums are
   grouped. If a run is active, the input waits (or steers it, on Copilot).
3. **Media.** Voice is transcribed locally; documents and photos are checked and
   prepared. Failures are reported, never sent to a cloud fallback.
4. **Run.** The engine opens or resumes the session with the persona, the
   workspace rules, the allowed tools, MCP servers and module abilities.
5. **Tools.** Every tool request passes the permission policy (autopilot or
   manual), the workspace boundary for non-owners and the list of forbidden
   actions (detached processes, excluded tools).
6. **Delivery.** The final answer is stored in the outbox and sent by Telegram's
   delivery worker with retries; an ambiguous send is reported as uncertain, not
   repeated.
7. **Stop and restart.** `/stop` stops the run and its processes; after a crash,
   interrupted work is marked and waits for an explicit decision.

Proactive items and module wake-ups run through the same pipeline, so stop,
recovery and delivery behave the same for them. Coordinator notices are fixed
texts without a model and use the same delivery.

## Rights

| | Owner | User |
|---|---|---|
| Bots | all bound | only `allowedBotIds`, private chat only |
| Workspaces | main workspace and own | only where a member |
| Personas | all | only the workspace's `agentIds` |
| Skills | yes | no |
| MCP servers | yes | only in a configured (non-default) workspace |
| Module abilities, module state | yes | no (empty state report) |
| Files outside the workspace | yes | denied on tool requests |

The owner's agents act with the owner's rights on the Mac. For users, the
workspace boundary is a check of paths in tool requests: it stops ordinary and
accidental access, not a determined attempt through the shell. It is not an
operating-system boundary, and the Mac's account can read every workspace.

## Where things are stored

| What | Where |
|---|---|
| Configuration | `config.local.json` (ignored by Git) |
| Secrets (bot tokens, MCP secrets) | external `secrets.local.json`, referenced by key |
| Service state: sessions, inbox, runs, outbox, proactive items | SQLite in `runtimeDataPath` |
| Incoming and outgoing files | `runtimeDataPath`; incoming files expire after at most seven days |
| Conversation history, Copilot | `runtimeHomePath` (service-only Copilot home) |
| Conversation history, Claude Code | `claudeCode.homePath/projects/` |
| Module data and state | `runtimeDataPath/modules/` |
| Logs | fixed codes and scalar metadata only, beneath the data directory |
| Agents, knowledge, current context | the workspaces; Densemble writes there only through agent tools and modules |

Agent memory between sessions is disabled: what an agent should remember must be
written into the workspace.

## Design rules

- **Configuration decides, agents don't.** Engines, modules, permissions and
  access change only in `config.local.json` and take effect on restart.
- **Fail explicitly.** Missing prerequisites, invalid settings and unknown
  outcomes are reported with a fixed code, a cause and a fix, never hidden behind
  a fallback.
- **Never replay.** Stopped, interrupted or uncertain work is not repeated
  automatically.
- **Local first.** Audio, files and history stay on the Mac; only the prompt and
  its context go to the model provider.
- **Modules stay outside the core.** A module plugs in through one contract and
  can fail without taking chat, voice or proactivity down.
