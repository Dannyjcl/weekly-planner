# TimeBudget

A weekly planner for college student-athletes that treats the week's **168 hours as a finite budget**. It isn't a calendar app. Fixed commitments (sleep, classes, practice, games and travel, meals, commute, work) come off the top, and what's left is **discretionary time** to allocate across studying, gym, social life, hobbies and free time.

```
fixed          = Σ fixed activities
discretionary  = 168 − fixed
allocated      = Σ flexible activities
unallocated    = discretionary − allocated      (negative ⇒ over-allocated)
```

## Features

- **Overview** – the headline number is the hours still available. It also shows KPIs (total, fixed, discretionary, allocated, unallocated, over-allocated) and a breakdown bar of the 168 hours plus a second bar for how discretionary time is split. A constraint check says exactly where you're over-allocated: fixed > 168, flexible > discretionary, overlapping blocks, or a day with more than 24 h. It also has computed insights and target progress.
- **Schedule** – a Monday–Sunday calendar (an agenda list on phones) that sizes itself to fit your screen, with a Day (06–24) / 24 h toggle, a live “now” line, and the selected day’s free time and to-do list (the same tasks as `tasks.html`) in a side panel on laptop and monitor screens, with a count of open tasks under each day. Activities have a name, category, day(s), start and end time, and a fixed/flexible classification. By default an activity uses its category's type, but you can override it per activity. Blocks can cross midnight, and overlapping blocks are flagged.
- **Budget & Targets** – categories with an optional minimum, target and maximum. Hours = calendar blocks + *unscheduled hours*, so you can budget something like "Meals 14 h" without drawing every meal.
- **Scenarios** – copies of the base week (Exam Week, Tournament Week…) that you can change without touching the base week. A side-by-side table shows the differences, and you can type new hours straight into it.
- **What-If** – deterministic questions such as "add 5 h of study" or "set work to 10 h". It shows whether the change fits, and if it doesn't, which flexible categories would have to shrink (taking from the most slack above each minimum first).
- **History** – every week you plan is stored, and you can chart trends for study, sleep, athletics, social, discretionary time and more.
- Data lives in `localStorage` and can be exported and imported as JSON. **Cloud sync:** tap *Sign in to sync* (bottom right) to mirror it to Firebase/Firestore and keep every device in sync live. The Overview also shows this month's numbers pulled from the [Semester Budget](https://dannyjcl.github.io/semester-budget/) app. The original daily task list is still at `tasks.html`.

## Google Calendar on the schedule

The Schedule tab can show your Google Calendar events as read-only blue, hatched blocks (an agenda row on phones, a count badge in the day header for all-day events). Clicking one opens it in Google Calendar; the planner never changes your calendar, and calendar events don't count toward the 168-hour budget. Times are shown in Central time (`America/Chicago`).

It's off until you add a Google OAuth client ID. One-time setup in the [Google Cloud console](https://console.cloud.google.com/), in the same project as the planner's Firebase (`semester-budget`):

1. **APIs & Services → Library**: enable **Google Calendar API**.
2. **Google Auth Platform → Audience** (OAuth consent screen): if the app is in *Testing*, add your own Google account as a test user.
3. **Google Auth Platform → Clients** (Credentials): open the Web client (Firebase made one, "auto created by Google Service", or create a new *Web application* client) and add `https://dannyjcl.github.io` under **Authorized JavaScript origins**. Save, and copy its **Client ID**.
4. Paste that Client ID into `js/gcal-config.js` (`clientId: '…apps.googleusercontent.com'`) and commit. A client ID is public; never put a client secret or API key there.
5. Open the planner → **Schedule** → **Show Google Calendar**, and allow *View events on all your calendars*. Google may say the app isn't verified; that's expected for your own project.

How access works: Google gives the page a read-only token (`calendar.events.readonly`) that lasts about an hour and is kept only in that browser tab (never in Firestore or the code). After it expires, one tap on **Load Google Calendar** gets a new one without the consent screen. **Disconnect** revokes it. Each device connects on its own.

## Run it

It's a static site with no build step and no dependencies. Open `index.html`, or serve the folder:

```sh
npm start          # or: python3 -m http.server
```

## Tests

```sh
npm test           # node --test, no dependencies
```

`tests/gcal.test.js` checks the Google Calendar conversion (UTC and offset times to Central, midnight-crossing and all-day events, DST, skipped declined events). The tests in `tests/engine.test.js` cover the reference example (114 h fixed → 54 h discretionary, fully allocated), over-allocation, fixed commitments over 168 h, decimals, midnight crossing, overlaps, reclassifying activities as fixed or flexible, edits and deletes, invalid data, targets, scenario isolation, what-if and history.

## Structure

| File | Role |
|---|---|
| `js/engine.js` | Pure calculation engine (integer minutes internally, so decimal hours don't drift). Runs in the browser and in Node. |
| `js/app.js` | UI: state, rendering, dialogs, events |
| `css/styles.css` | Dark dashboard theme (design tokens, type scale) and responsive layout |
| `index.html` | App shell |
| `js/cloud-sync.js` | Shared Firebase sync module (Google sign-in, live Firestore sync, cross-app reads) |
| `js/planner-sync.js` | Planner's sync config + weekly summary published for other apps |
| `js/gcal.js` | Read-only Google Calendar: Google sign-in for calendar access, fetches the week, turns events into schedule blocks in Central time |
| `js/gcal-config.js` | Google Calendar settings (OAuth client ID, calendar, time zone) |
