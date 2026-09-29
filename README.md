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
- **Schedule** – a Monday–Sunday calendar (an agenda list on phones). Activities have a name, category, day(s), start and end time, and a fixed/flexible classification. By default an activity uses its category's type, but you can override it per activity. Blocks can cross midnight, and overlapping blocks are flagged.
- **Budget & Targets** – categories with an optional minimum, target and maximum. Hours = calendar blocks + *unscheduled hours*, so you can budget something like "Meals 14 h" without drawing every meal.
- **Scenarios** – copies of the base week (Exam Week, Tournament Week…) that you can change without touching the base week. A side-by-side table shows the differences, and you can type new hours straight into it.
- **What-If** – deterministic questions such as "add 5 h of study" or "set work to 10 h". It shows whether the change fits, and if it doesn't, which flexible categories would have to shrink (taking from the most slack above each minimum first).
- **History** – every week you plan is stored, and you can chart trends for study, sleep, athletics, social, discretionary time and more.
- Data lives in `localStorage` and can be exported and imported as JSON. The original daily task list is still at `tasks.html`.

## Run it

It's a static site with no build step and no dependencies. Open `index.html`, or serve the folder:

```sh
npm start          # or: python3 -m http.server
```

## Tests

```sh
npm test           # node --test, no dependencies
```

The tests in `tests/engine.test.js` cover the reference example (114 h fixed → 54 h discretionary, fully allocated), over-allocation, fixed commitments over 168 h, decimals, midnight crossing, overlaps, reclassifying activities as fixed or flexible, edits and deletes, invalid data, targets, scenario isolation, what-if and history.

## Structure

| File | Role |
|---|---|
| `js/engine.js` | Pure calculation engine (integer minutes internally, so decimal hours don't drift). Runs in the browser and in Node. |
| `js/app.js` | UI: state, rendering, dialogs, events |
| `css/styles.css` | Dark dashboard theme and responsive layout |
| `index.html` | App shell |
