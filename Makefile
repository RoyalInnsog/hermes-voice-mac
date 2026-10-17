# Makefile — Hermes Voice v1.0 Production Build & Verification Targets (Spec §3.6).

.PHONY: all start dev build test verify macos-app probe clean

all: build test

## Build production single-file UI bundle (dist/index.html)
build:
	npm run build

## Start self-contained production server (serves dist/ + /api/* on 127.0.0.1:20130)
start: build
	node server/index.mjs

## Start Vite dev server
dev:
	npm run dev

## Run backend unit + subprocess integration tests (30 cases)
test:
	node server/selftest.mjs

## Run end-to-end v1.0 verification suite (scripts/verify-v1.mjs)
verify: build
	node scripts/verify-v1.mjs

## Run live HTTP/SSE bridge probe
probe:
	node scripts/probe-bridge.mjs

## Build native macOS Floating HUD app bundle (dist/Hermes Voice.app)
macos-app:
	bash scripts/build-macos-app.sh

clean:
	rm -rf dist
