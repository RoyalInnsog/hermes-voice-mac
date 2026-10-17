# Makefile — Hermes Voice v1.0 Production Build & macOS Bundler

.PHONY: all install build start dev test verify macos-app hud clean

all: build test macos-app

install:
	npm install

build:
	npm run build

start:
	node server/index.mjs

dev:
	npm run dev

test:
	node server/selftest.mjs

verify:
	node scripts/verify-v1.mjs

macos-app:
	bash scripts/build-macos-app.sh

hud:
	node scripts/launch-hud.mjs

clean:
	rm -rf dist
