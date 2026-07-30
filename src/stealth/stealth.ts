// ponytail: CloakBrowser handles all stealth at the C++ level —
// canvas noise, WebGL, audio fingerprint, font enumeration, GPU spoofing,
// WebRTC leak prevention, network timing, automation signal removal.
// No JS evasions needed. This file only exports viewport randomization
// for variety in session dimensions.

export type StealthLevel = 'none' | 'basic' | 'full';

// Random but realistic viewport dimensions
export function randomViewport(): { width: number; height: number } {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1600, height: 900 },
  ];
  return viewports[Math.floor(Math.random() * viewports.length)];
}
