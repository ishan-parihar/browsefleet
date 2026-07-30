# Stealth

BrowseFleet uses [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) — 71 C++ source-level patches on Chromium that defeat bot detection at the binary level. This doc explains what is on by default, when to turn it down, and the ethics.

## What `STEALTH_DEFAULT=full` actually does

Two layers of behavior:

1. **CloakBrowser binary.** The patched Chromium applies C++-level evasions against bot-detection fingerprints: canvas noise, WebGL vendor/renderer spoofing, audio fingerprint perturbation, font enumeration blocking, GPU info spoofing, WebRTC leak prevention, network timing normalization, and automation signal removal (`navigator.webdriver`, `chrome.runtime`, etc.). Unlike JS-based evasions, these leave no injection traces — the patches are compiled into the binary. Source: [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser).

2. **Per-session randomization.** When the session is created (and no explicit `userAgent` or `viewport` are passed), BrowseFleet samples a viewport from a curated list of common real-world sizes (1920x1080, 1366x768, 1440x900, etc.). Source: [`src/stealth/stealth.ts`](../src/stealth/stealth.ts).

The intent is to make a BrowseFleet session look indistinguishable from a real human's browser on a real desktop. CloakBrowser's C++ patches are the strongest available approach — no JS injection, no detectable runtime patches, no CDP protocol leaks.

## When to turn it down

`STEALTH_DEFAULT` accepts three values. Each can be overridden per-session via the `stealth` field on `POST /v1/sessions` or on any one-shot endpoint.

| Setting          | CloakBrowser binary | Per-session randomization | CPU overhead |
| ---------------- | ------------------- | ------------------------- | ------------ |
| `full` (default) | on                  | on                        | highest      |
| `basic`          | on                  | off                       | medium       |
| `none`           | off (vanilla Chrome)| off                       | lowest       |

Use `none` when:

- You are scraping a site that is cooperative or that you operate. The CPU overhead of stealth is real and there is no benefit if the target is not actively detecting.
- You are running synthetic monitoring against your own infrastructure.
- You are debugging the BrowseFleet pipeline itself and want to rule out stealth as a variable.

## Pro vs Free

| Tier | Chromium version | Patches | Concurrent sessions |
|------|-----------------|---------|-------------------|
| Free | 146 | 58 | 1 |
| Pro  | 150 | 71 | Unlimited |

Set `CLOAKBROWSER_LICENSE_KEY` in your `.env` to enable Pro. Get a free key at [cloakbrowser.dev/free](https://cloakbrowser.dev/free).

## Ethics

Stealth browsing has legitimate uses: competitive research, ad verification, price monitoring, security testing, and QA automation. It also enables abuse: credential stuffing, scalping, disinformation campaigns.

BrowseFleet does not make ethical judgments for you. The `stealth` parameter exists so you can match your approach to the target's tolerance and your own ethical standards. If you are unsure, start with `full` and reduce only when you have a specific reason.
