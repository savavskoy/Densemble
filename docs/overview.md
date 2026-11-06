# What Densemble does

Densemble turns a folder of agent instructions and knowledge into a team of
personal AI agents you talk to in Telegram. It runs as one local service on an
Apple Silicon Mac: each agent (persona) gets its own Telegram bot, works inside
a knowledge workspace, and thinks with a model from your own subscription
(GitHub Copilot or Claude). There is no cloud control plane and no HTTP server.

Terms used below (persona, workspace, session, module, engine) are defined in
[concepts](concepts.md). Setup and commands are in the [README](../README.md);
technical contracts in [contracts](contracts.md).

## Who it is for

- **The owner** runs the service on their Mac, writes the agents and decides who
  may use which bot and which workspace.
- **Other users** (optional) are people the owner adds by Telegram ID. They talk
  to the bots they are allowed to use, in their own private chats, inside the
  workspaces they are members of.

## What it can do

### Conversations

- One Telegram bot per persona; each private chat, group or forum topic has its
  own separate conversation history.
- Streaming answers, `/stop` to stop the current run, `/new` and `/sessions` to
  start or switch conversations, `/model` to change the model, `/status` for the
  service state.
- Agents ask clarifying questions as ordinary messages, one at a time.
- Messages sent while the agent is answering steer the current answer (Copilot)
  or wait for the next turn (Claude Code).

### Agents

- Personas are Markdown files in the workspace; the owner writes them, Densemble
  loads them. A persona can consult other personas of the same workspace.
- Skills (reusable how-to instructions) are available in the owner's sessions.
- Two engines side by side: **Copilot** (default) and **Claude Code**, chosen per
  bot in the configuration. One persona can be served by a bot of each engine.
- MCP servers are off unless explicitly allowlisted, server by server and tool by
  tool, with secrets passed by reference.
- Permissions: **autopilot** (default) approves ordinary tool actions; **manual**
  asks for each action with buttons in Telegram.

### Input and output

- Voice messages are transcribed **locally** with whisper.cpp; audio never goes
  to the cloud.
- Photos (PNG, JPEG, WebP), text PDFs, DOCX and UTF-8 text files are accepted as
  input.
- Agents send files back only through an explicit export tool, never by
  mentioning a path.

### Proactivity

- Each agent can schedule its own one-off reminders, recurring check-ins and
  silent checks in its own chat.
- Quiet hours, a minimum interval and a per-agent limit keep it from spamming;
  due items for the same chat are bundled into one message.
- The owner sees and controls every item with `/proactive`.

### People and workspaces

- Additional users get access per bot and per workspace.
- Workspaces are `private` (one person) or `shared` (members); a user with
  several workspaces picks one with `/workspace`.
- Members of a shared workspace get the configured MCP servers; skills,
  modules and group chats stay owner-only.

### Modules

Optional features that plug into the core and are switched only in the
configuration:

- **Recording transcription** (`recordings`): a watched folder of calls, lectures
  and meetings is transcribed locally, with timestamps and speaker labels.
  [User guide](user-guide/recordings.md).
- **Reels** (`reels`): an agent prepares a YouTube or workspace video, reads its
  transcript and cuts the requested clips into 9:16 videos with subtitles.
  [Module README](../src/modules/reels/README.md).

Every agent can read module state (`densemble_state`) and explain the cause and
fix of a problem; a coordinator agent tells the owner when a module stops or
recovers.

### Operations

- Background service through a macOS LaunchAgent (`make install`, `make start`,
  `make logs`); `make doctor` checks prerequisites without sending messages.
- Offline backup and restore of conversations and service state.
- Restart is safe: interrupted work is reported, never replayed automatically.
- Logs contain fixed codes, not message content, tokens or tool arguments.

## What it deliberately does not do

- **No cloud of its own.** No hosted service, no HTTP endpoint, no telemetry;
  the Mac must be awake for bots to answer.
- **No Git.** Densemble never initialises, commits, pulls or pushes workspaces.
- **No automatic installs.** It does not create bots, download models or install
  tools; it tells you what is missing.
- **No replay.** A stopped or interrupted action is never retried on its own.
- **No hard isolation between users.** Workspace boundaries are checked on tool
  requests, not by the operating system; give access only to people you trust.

## Current limits

- macOS on Apple Silicon only.
- Models come only from the owner's Copilot or Claude subscription; there is no
  API-key engine.
- Group and forum chats are for the owner only.
- No per-user request limits.
- Conversation history is always stored; there is no history-free mode.
