# Calorie Tracker

A simple, private, phone-first calorie tracker. No accounts, no server, no
subscription. Everything you log stays on your device (in your browser's
IndexedDB storage) — nothing is uploaded anywhere, except that when you use
AI calorie estimation, the description/photo/weight for *that one meal* is
sent directly from your phone's browser to Google's Gemini API using your
own free API key.

This is intentionally a v1: a solid, working tracker now, built so you can
later layer in your own ML model (e.g. swap the Gemini call for your own
food-recognition model) and a real accounts/sync system without starting
over.

## Features

- **Home screen**: today's total vs. your daily calorie goal, with a
  progress bar, plus a list of everything you've logged today.
- **Log entry**: tap "+ Log your entry for today" to add a meal. You can
  optionally take/attach a photo, optionally enter weight in grams, and
  optionally enter calories directly (e.g. from a nutrition label). The
  only required field is a text description of what you ate.
  - If you type in a calorie number yourself, that's used directly — no AI
    call is made.
  - If you leave calories blank, the app calls Google's Gemini API (vision
    model) with your description + photo + weight to estimate calories,
    protein, carbs and fat.
- **Full log**: the 📋 button top-right opens your entire history, grouped
  by date, with a per-day total. Entries can be edited or deleted here (or
  from the home screen).
- **Goal**: prompted once on first visit; editable any time from "Edit
  goal" on the home screen.
- **Settings** (⚙️ button): where you paste your free Gemini API key and
  (optionally) change the model name.

## Getting a free Gemini API key

1. Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**
   and sign in with a Google account.
2. Click **Create API key** and copy it.
3. In the app, tap the ⚙️ settings icon, paste the key into **Google Gemini
   API key**, and tap **Save Settings**.

Google's free tier has rate limits (requests per minute/day) — if you hit
"429" errors from a lot of rapid logging, just wait a bit and try again.
Google occasionally renames or retires free models; if `gemini-2.0-flash`
stops working, check [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
for the current free vision-capable model name and update it in Settings.

## Deploying to GitHub Pages

1. Create a new **public** GitHub repository (e.g. `calorie-tracker`).
2. Add all the files in this folder to the repo root:
   - `index.html`
   - `style.css`
   - `app.js`
   - `manifest.json`
   - `icons/icon.svg`
   - `README.md`
3. Commit and push to the `main` branch.
4. In the repo, go to **Settings → Pages**.
5. Under **Build and deployment**, set **Source** to `Deploy from a
   branch`, branch `main`, folder `/ (root)`. Save.
6. After a minute or two, GitHub will give you a URL like
   `https://<your-username>.github.io/calorie-tracker/`. Open that on your
   phone.
7. Optional but recommended on mobile: open the site in your phone's
   browser and use **"Add to Home Screen"** — it'll behave like a small app
   (uses the icon/colors from `manifest.json`).

### Quick command-line version

```bash
git init
git add .
git commit -m "Initial calorie tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/calorie-tracker.git
git push -u origin main
```

Then enable Pages as described above.

## Notes, limits & things to know

- **Data is per-browser, per-device.** Your phone and laptop won't share
  entries — this is intentional for v1 (no accounts/sync yet). Don't clear
  your browser's site data for this page, or you'll lose your log. There's
  no built-in backup/export yet — a good next feature to add.
- **Storage**: photos are compressed (resized + JPEG re-encoded) before
  being stored, and everything lives in IndexedDB rather than
  `localStorage`, so you have a lot of headroom (typically hundreds of MB,
  depending on the browser) before storage becomes a concern.
- **AI accuracy**: Gemini's estimate is only as good as your description —
  the more specific you are about ingredients/portions, the better
  ("1.5 cups white rice, 6oz grilled chicken breast, 1 tbsp olive oil" beats
  "chicken and rice"). Treat it as a helpful estimate, not a lab-verified
  number.
- **Privacy**: photos/descriptions you submit for AI estimation are sent to
  Google's Gemini API (subject to Google's terms/privacy policy for that
  API). Entries you enter calories for manually never leave your device.

## Ideas for future phases (per your longer-term plan)

- Swap the Gemini call for your own trained food-recognition/calorie model
  (the `estimateCaloriesWithAI` function in `app.js` is the single place
  that would need to change).
- Add a lightweight username system + a small backend (or a
  sync-to-your-own-storage option) so entries follow you across devices.
- Weekly/monthly charts and trends (total calories, macro breakdown over
  time).
- Export/import your log as JSON for backup.
- Barcode scanning for packaged foods as another optional shortcut, similar
  to how manual calorie entry works today.
