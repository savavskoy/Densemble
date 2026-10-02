.DEFAULT_GOAL := help

CONFIG ?= config.local.json
PLIST := $(HOME)/Library/LaunchAgents/dev.densemble.agent.plist
DOMAIN := gui/$(shell id -u)
SERVICE := $(DOMAIN)/dev.densemble.agent

.PHONY: help build typecheck test doctor run install start stop restart status logs

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
	node dist/main.js doctor --config "$(CONFIG)"

run: build
	node dist/main.js start --config "$(CONFIG)"

install: build
	@set -eu; \
	mkdir -p "$(HOME)/Library/LaunchAgents"; \
	tmp=$$(mktemp "$(PLIST).XXXXXX"); \
	trap 'rm -f "$$tmp"' EXIT HUP INT TERM; \
	node dist/main.js launchd --config "$(CONFIG)" > "$$tmp"; \
	plutil -lint "$$tmp"; \
	chmod 600 "$$tmp"; \
	mv "$$tmp" "$(PLIST)"; \
	printf '%s\n' 'LaunchAgent installed. Run make start (or make restart if already loaded).'

start:
	@test -f "$(PLIST)" || { printf '%s\n' 'LaunchAgent is not installed. Run make install first.' >&2; exit 1; }
	launchctl bootstrap "$(DOMAIN)" "$(PLIST)"

stop:
	launchctl bootout "$(SERVICE)"

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
