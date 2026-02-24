# DK Auto Weekly Points

Static React + Vite application for weekly points tracking with:
- Google OAuth sign-in
- Google Sheets-backed storage
- Guided line-by-line issue resolver for timer text files
- Weekly chart + exports
- Persistent wizard setup values in browser local storage
- Boss token modifiers in parentheses:
  - `brucy` / `brucybonus` => `+5`
  - `fail` / `comp` => `/2`
  - `double` / `doublepoints` => `*2`

## Local Setup

1. Create a Google OAuth **Web** client in Google Cloud.
2. Add your local and deployed origins in OAuth settings.
3. Create `.env` from `.env.example`:

```bash
VITE_GOOGLE_WEB_CLIENT_ID=your_google_web_client_id.apps.googleusercontent.com
```

4. Install and run:

```bash
npm install
npm run dev
```

## Spreadsheet Model

The app expects a **Data Spreadsheet** with tabs (auto-created if missing):
- `Allowlist`
- `Config`
- `Bosses`
- `BossAliases`
- `NameAliases`
- `Weeks`
- `WeekUserTotals`
- `WeekBossBreakdown`

The wizard also requires a separate **Users Spreadsheet ID + Range** for canonical names.

## Auth and Access Control

- Login is Google-only (no spreadsheet ID required on the login screen).
- Allowlist is checked after loading the Data Spreadsheet in the wizard.
- Real access control comes from Google Sheet sharing permissions.

## Deploy (GitHub Pages)

Use the included workflow in `.github/workflows/deploy.yml` and set:
- GitHub repo setting: Pages source `GitHub Actions`
- Repo secret: `VITE_GOOGLE_WEB_CLIENT_ID`
