# Switch Seed Finder (Traveling Cart) - Stardew Valley 1.6 (Nintendo Switch)

Purpose: brute-force your save's world **Game ID** from a Traveling Cart screenshot, so you can use the **MouseyPounds Stardew Predictor**.

## Files
- `index.html` - UI (first 4 cart slots + status + candidates + advanced options)
- `main.js` - UI logic + worker scheduling
- `worker.js` - deterministic cart RNG + matcher (even-only scanning internally)

## Setup
You must provide `objects.json` next to `index.html`.

Run a local server (required for WebWorkers / fetch):

```bash
python3 -m http.server 8000
```

Open:
- http://localhost:8000

## Notes
- Enter the **first 4 visible cart items in order**, including **price** and **qty** (if qty is not shown, use 1).
- Candidates appear as they are found; each row includes a MouseyPounds link (`?id=<gameId>&dp=<daysPlayed>`).
