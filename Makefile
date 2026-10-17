# Makefile — Hermes Voice v1.0 Production Build & Verification Automation

.PHONY: all install build start dev test verify probe app clean

all: build test

install:
	npm install

build:
	npm run build

start:
	npm start

dev:
	npm run dev

test:
	npm test

probe:
	npm run probe

verify:
	npm run verify

app:
	bash scripts/build-macos-app.sh

clean:
	rm -rf dist
