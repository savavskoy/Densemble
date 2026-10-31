.DEFAULT_GOAL := help

CONFIG ?= config.local.json
PLIST := $(HOME)/Library/LaunchAgents/dev.densemble.agent.plist
DOMAIN := gui/$(shell id -u)
SERVICE := $(DOMAIN)/dev.densemble.agent
NBUV_SYNC_REPO := /Users/oleh/StudioProjects/nbuv-management
NBUV_SYNC_MAKEFILE := $(NBUV_SYNC_REPO)/Makefile
# TODO(oleh): nbuv-management autosync is unreliable and temporarily disabled. When it is fixed,
# set NBUV_SYNC_ENABLED := 1 (or run `make start NBUV_SYNC_ENABLED=1`) to start/stop it with the service again.
NBUV_SYNC_ENABLED ?= 0

# The service requires Node 24 (see .nvmrc). The IDE/launchd may invoke make with a
# PATH that resolves a different node (e.g. Homebrew), so pin the pinned nvm binary
# explicitly and fall back to any installed v24.x, then finally to PATH node.
NODE_VERSION := $(shell cat .nvmrc 2>/dev/null)
NODE := $(firstword \
	$(wildcard $(HOME)/.nvm/versions/node/v$(NODE_VERSION)/bin/node) \
	$(sort $(wildcard $(HOME)/.nvm/versions/node/v24.*/bin/node)) \
	node)

.PHONY: help build typecheck test doctor claude-login run install start stop restart status logs transcribe-status modules-status

help:
	@printf '%s\n' \
		'make install    Build and install the macOS LaunchAgent (does not start it)' \
		'make start      Load the installed background service' \
		'make stop       Unload the background service for this login session' \
		'make restart    Gracefully stop, rebuild, and start the background service' \
		'make status     Show launchd service state (not an application health check)' \
		'make logs       Follow service output and error logs; Ctrl+C stops following' \
		'make run        Build and run in this terminal; Ctrl+C stops the service' \
		'make build      Compile TypeScript into dist/' \
		'make typecheck  Check application and test types' \
		'make test       Run offline tests' \
		'make doctor     Check prerequisites (stop the service first)' \
		'make transcribe-status  Show recording transcription progress, queue and failures' \
		'make modules-status  Show each module: enabled, state, cause and fix, status line' \
		'make claude-login  Log the service-owned Claude Code home in with your Claude subscription' \
		'' \
		'First background launch: make install && make start' \
		'Stop any existing npm/foreground instance before starting via launchd.' \
		'Use CONFIG=/absolute/path/to/config.local.json to select another configuration.'

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

doctor: build
	$(NODE) dist/main.js doctor --config "$(CONFIG)"

# Read-only; works while the service runs (no process lock).
transcribe-status:
	$(NODE) dist/main.js recordings-status --config "$(CONFIG)"

# Read-only; works while the service runs (no process lock).
modules-status:
	$(NODE) dist/main.js modules-status --config "$(CONFIG)"

# One-time, interactive: logs the pinned Claude Code binary in under the service-owned CLAUDE_CONFIG_DIR
# from claudeCode.homePath. It never touches the interactive ~/.claude or stores an API key.
claude-login:
	@set -eu; \
	home="$$($(NODE) -e 'const p=require("path"),f=p.resolve(process.argv[1]),c=JSON.parse(require("fs").readFileSync(f,"utf8"));if(!c.claudeCode)process.exit(3);console.log(p.resolve(p.dirname(f),c.claudeCode.homePath))' "$(CONFIG)")" || \
		{ echo "claudeCode.homePath is not configured in $(CONFIG)" >&2; exit 2; }; \
	mkdir -p "$$home"; chmod 700 "$$home"; \
	env -i HOME="$$HOME" USER="$$USER" LOGNAME="$$USER" PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
		CLAUDE_CONFIG_DIR="$$home" DISABLE_AUTOUPDATER=1 \
		./node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude auth login

run: build
	@set -eu; \
	if [ "$(NBUV_SYNC_ENABLED)" = 1 ] && [ -f "$(NBUV_SYNC_MAKEFILE)" ]; then \
		$(MAKE) -C "$(NBUV_SYNC_REPO)" sync-start; \
		trap '$(MAKE) -C "$(NBUV_SYNC_REPO)" sync-stop >/dev/null 2>&1 || true' EXIT INT TERM; \
	fi; \
	$(NODE) dist/main.js start --config "$(CONFIG)"

install: build
	@set -eu; \
	mkdir -p "$(HOME)/Library/LaunchAgents"; \
	tmp=$$(mktemp "$(PLIST).XXXXXX"); \
	trap 'rm -f "$$tmp"' EXIT HUP INT TERM; \
	$(NODE) dist/main.js launchd --config "$(CONFIG)" > "$$tmp"; \
	plutil -lint "$$tmp"; \
	chmod 600 "$$tmp"; \
	mv "$$tmp" "$(PLIST)"; \
	printf '%s\n' 'LaunchAgent installed. Run make start (or make restart if already loaded).'

start:
	@test -f "$(PLIST)" || { printf '%s\n' 'LaunchAgent is not installed. Run make install first.' >&2; exit 1; }
	launchctl bootstrap "$(DOMAIN)" "$(PLIST)"
	@if [ "$(NBUV_SYNC_ENABLED)" = 1 ] && [ -f "$(NBUV_SYNC_MAKEFILE)" ]; then \
		$(MAKE) -C "$(NBUV_SYNC_REPO)" sync-start; \
	fi

stop:
	@set -eu; \
	launchctl bootout "$(SERVICE)"; \
	if [ "$(NBUV_SYNC_ENABLED)" = 1 ] && [ -f "$(NBUV_SYNC_MAKEFILE)" ]; then \
		$(MAKE) -C "$(NBUV_SYNC_REPO)" sync-stop; \
	fi

restart:
	$(MAKE) stop
	$(MAKE) install CONFIG="$(CONFIG)"
	$(MAKE) start

status:
	launchctl print "$(SERVICE)"

logs:
	@set -eu; \
	out=$$(/usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$(PLIST)"); \
	err=$$(/usr/libexec/PlistBuddy -c 'Print :StandardErrorPath' "$(PLIST)"); \
	tail -n 100 -F "$$out" "$$err"
