# Issue #61 verification

Base: `3c27ba5` (main). Deterministic Day 0 plan fixtures, real Chromium, real AMap JS SDK and real Leaflet/MapLibre fallback. No LLM request was made.

## Change

The map shell now uses a cancellable Web Animations transform between its old visible rectangle and its destination layout. The map canvas renders at the destination size throughout the transition. Rapid reversals capture the currently transformed rectangle before cancelling the old animation; reset and reduced motion skip animation. The controller avoids SDK resize/fit work on animation frames whose layout size is unchanged. Detail entry and plan switching draw once, and focused routes show their complete paths without replaying the route reveal.

Each selected route station owns a safe text name bubble, using the event's title (venue/ID fallback) and its actual route coordinates, including SDK WGS84 conversion when needed. The route layer's existing cancellation/removal handles switching, leaving, and reset. Both map providers reserve additional camera padding for the labels. Exploration's unrelated scenic/activity layers retain their existing behavior.

## Validation

- `npm test`: 1024 passed, 0 failed. Includes the new SDK contract regression for names by event ID, plan switching, reset, and 120 transition frames without resize/refit/rebuilding markers.
- `npm run typecheck`, `npm run check:frontend`, `git diff --check`: passed.
- Real AMap: 16 browser assertions passed at 1440×900 and 390×844. Both plans' labels visible; no previous-plan labels retained; A labels within map bounds; closing removes labels; rapid enter/leave/enter reaches exact final geometry; reset clears labels.
- Real Leaflet fallback: the same 14 applicable browser assertions passed at both sizes.

Comparison with the base, using the same browser probe:

| Operation | Before (desktop / mobile) | After (desktop / mobile) |
| --- | --- | --- |
| Entry SDK resizes | 45 / 45 | 1 / 1 |
| Entry fit calls | 10 / 10 | 2 / 2 |
| Entry route draws | 2 / 2 | 1 / 1 |
| Exit SDK resizes | 45 / 45 | 1 / 1 |
| Exit fit calls | 9 / 9 | 1 / 1 |
| Entry layout sizes | 45 / 45 | 1 / 1 |

After-change AMap frame sampling: entry maximum gap 17.2ms at both sizes; exit 33.3ms desktop / 33.4ms mobile. No gap over 50ms in the sampled entry/exit windows. The baseline on this machine also had no gaps over 50ms; the measurable improvement is removal of repeated SDK resize/fit/draw work and camera stepping. Headless results do not guarantee performance on every device. During motion the map shell (including its labels) scales temporarily; final SDK rendering uses the exact destination size.

## Evidence and reproduction

- [AMap metrics](amap/metrics.json), [baseline metrics](before-metrics.json), [Leaflet metrics](leaflet/metrics.json).
- [Desktop A](amap/desktop-a.png), [desktop B](amap/desktop-b.png), [mobile A](amap/mobile-a.png), [mobile B](amap/mobile-b.png).
- [Browser probe](browser.mjs).

```sh
FRONTEND_PORT=5455 npm run dev:frontend
node docs/issue-61/browser.mjs --amap --port 5471 --out /tmp/issue61-amap
node docs/issue-61/browser.mjs --port 5472 --out /tmp/issue61-leaflet
```

AMap requires the existing local map credentials; the fallback run returns disabled map configuration and does not require those credentials. Browser ports must be free. The probe defaults to locally installed Chrome for Testing / Google Chrome, or accepts `--chrome <path>`. `--root <frontend-directory>` tests another revision with the same probe.
