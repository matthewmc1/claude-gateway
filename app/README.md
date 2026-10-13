# Gateway Budgets: the web app

React Native Web (Expo) front end for the budget service in `../api`. Data is visible without signing in; every change (save a budget,
grant or cancel a temporary boost) asks for an admin sign-in first and then carries on with what you were doing. The API contract is
`../docs/ARCHITECTURE.md`; this app only talks to it, and the session token travels in `x-app-token` (never `Authorization`).

## Pages
`#/people` (and `#/people/<sub>` for the person drawer) · `#/my-usage` · `#/company` · `#/models` · `#/activity`.
`?theme=light|dark` forces a theme (handy for screenshots and does not change the saved preference).

## Dev loop
```bash
cd app && npm install
npx tsc --noEmit                                        # typecheck
node --experimental-strip-types --test test/*.test.ts   # unit tests (Node 23+), pure logic only
npx expo export -p web                                  # builds dist/, which the backends serve

# 1. against the mock API (fake data, no backend needed), http://127.0.0.1:19110, admin password "demo"
node dev/mock-api.mjs                 # MOCK_DEMO=1 sample-data banner, MOCK_VIEW=admin sign-in wall, MOCK_USAGE=none,
                                      # MOCK_ACCOUNTS=1 (email + password), MOCK_EMPTY=1, MOCK_FAIL=1, MOCK_PORT=...
# 2. against the real backend in demo mode, admin@example.com / demo-admin
APP_DEMO=1 APP_PORT=19111 APP_DATA_DIR=/tmp/gwb-data node ../api/server.mjs
# 3. hot reload: `npx expo start --web` (port 8081) talks to http://localhost:8792, or set EXPO_PUBLIC_API_BASE.
#    The API only allows that cross-origin dev server when it is started with APP_DEV=1 (CORS).
```
After a UI change run `npx expo export -p web` again; the backends serve `dist/` straight from disk.

## Structure
```
App.tsx                 shell: sidebar / top bar, page header + controls, hash routing, status footer
src/logic/*.ts          PURE logic, no react-native imports, unit tested: format, budget state, override window maths,
                        coach ordering, model usage shares, routing + default person, types for the API contract
src/api.ts              fetch wrapper (x-app-token, 401 handling) and the typed endpoints
src/auth.tsx            AuthProvider: /api/health, sign-in dialog, runAdmin(), the full-page gate (viewAccess=admin)
src/ui.tsx charts.tsx   design system: Card, Button, Chip, Segmented, Select, CommandBox, Dialog, rings, bars, charts
src/screens/            People, UserDrawer (+BoostCard), MyUsage, Company, Models, Activity
src/Logo.tsx            the one place the brand mark is drawn (from ../assets/brand, copies in assets/brand/)
dev/mock-api.mjs        contract-shaped mock backend that also serves dist/
test/*.test.ts          node:test files for src/logic
```
Rules of thumb: put anything with arithmetic or decisions in `src/logic` (import siblings with a `.ts` suffix so Node can run it);
wrap every write in `runAdmin(why, () => api.call())` and treat `isCancelled(e)` as "the user closed the sign-in dialog".

## Screenshots (headless Chrome, no extra tools)
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1440,1000 --virtual-time-budget=12000 --screenshot=people-dark.png \
  "http://127.0.0.1:19110/?theme=dark#/people"
```
`--window-size` cannot go below roughly 500px wide, so for a true 390px phone layout drive Chrome over the DevTools protocol with
`Emulation.setDeviceMetricsOverride` (width 390, mobile true), then `Page.captureScreenshot`.
