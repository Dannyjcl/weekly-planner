/*
 * TimeBudget calculation engine.
 *
 * Pure, deterministic functions with no DOM access. Loaded as a global (`TB`)
 * in the browser and as a CommonJS module in Node for tests.
 *
 * All arithmetic is done in integer MINUTES to avoid floating-point drift
 * (e.g. 1.5 h + 1.5 h + ... never becomes 167.99999). Hours are only produced
 * at the edges (minutes / 60).
 */
(function (root, factory) {
    const TB = factory();
    if (typeof module === 'object' && module.exports) module.exports = TB;
    else root.TB = TB;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const WEEK_HOURS = 168;
    const DAY_MIN = 24 * 60;
    const WEEK_MIN = WEEK_HOURS * 60;
    const MAX_ADJUST = 1000;
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const TYPES = ['fixed', 'flexible'];
    const CLASSIFICATIONS = ['inherit', 'fixed', 'flexible'];

    /* ── Small helpers ─────────────────────────────────────── */

    function isNum(v) {
        return typeof v === 'number' && Number.isFinite(v);
    }

    function hoursToMin(h) {
        return isNum(h) ? Math.round(h * 60) : 0;
    }

    function minToHours(m) {
        return m / 60;
    }

    /** Round to 2 decimals for display-safe numbers. */
    function round2(n) {
        return Math.round(n * 100) / 100;
    }

    /** "1.5", "12", "0.25" — trims trailing zeros. */
    function fmtHours(h) {
        const r = round2(h);
        return (Object.is(r, -0) ? 0 : r).toString();
    }

    function parseTime(str) {
        if (typeof str !== 'string') return null;
        const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
        if (!m) return null;
        const hh = Number(m[1]);
        const mm = Number(m[2]);
        if (hh > 23 || mm > 59) return null;
        return hh * 60 + mm;
    }

    function formatTime(min) {
        const m = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN;
        return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    }

    /**
     * Duration of a block on the 24h clock. If end <= start the activity
     * crosses midnight into the next day (e.g. 23:00 → 07:00 = 8 h).
     * start === end is treated as invalid (0), not as 24 h.
     */
    function durationMin(start, end) {
        if (start === end) return 0;
        return end > start ? end - start : DAY_MIN - start + end;
    }

    function uid(prefix) {
        return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function clone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    /* ── Validation / sanitisation ─────────────────────────── */

    function cleanLimit(v) {
        if (v === '' || v === null || v === undefined) return null;
        const n = typeof v === 'string' ? Number(v) : v;
        if (!isNum(n) || n < 0 || n > WEEK_HOURS) return null;
        return round2(n);
    }

    /** Validate a category draft. Returns list of human-readable errors. */
    function validateCategory(cat, allCategories) {
        const errors = [];
        const name = (cat.name || '').trim();
        if (!name) errors.push('Category name is required.');
        const dup = (allCategories || []).find(c =>
            c.id !== cat.id && c.name.trim().toLowerCase() === name.toLowerCase());
        if (dup) errors.push(`A category named "${dup.name}" already exists.`);
        if (!TYPES.includes(cat.type)) errors.push('Type must be fixed or flexible.');
        ['min', 'target', 'max'].forEach(k => {
            const v = cat[k];
            if (v === null || v === undefined || v === '') return;
            if (!isNum(v) || v < 0 || v > WEEK_HOURS) errors.push(`${k} must be between 0 and 168 hours.`);
        });
        if (isNum(cat.min) && isNum(cat.max) && cat.min > cat.max) errors.push('Minimum cannot exceed maximum.');
        return errors;
    }

    function sanitizeCategory(c) {
        if (!c || typeof c !== 'object') return null;
        const name = typeof c.name === 'string' ? c.name.trim().slice(0, 40) : '';
        if (!name || typeof c.id !== 'string' || !c.id) return null;
        const min = cleanLimit(c.min);
        let max = cleanLimit(c.max);
        if (min !== null && max !== null && min > max) max = null;
        return {
            id: c.id,
            name,
            type: TYPES.includes(c.type) ? c.type : 'flexible',
            color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#8a8f98',
            min,
            target: cleanLimit(c.target),
            max,
            athletic: !!c.athletic,
        };
    }

    /** Validate an activity draft against the category list. */
    function validateActivity(a, categories) {
        const errors = [];
        if (!a || typeof a !== 'object') return ['Invalid activity.'];
        if (typeof a.name !== 'string' || !a.name.trim()) errors.push('Activity name is required.');
        if (!categories.some(c => c.id === a.categoryId)) errors.push('Choose a valid category.');
        if (!Number.isInteger(a.day) || a.day < 0 || a.day > 6) errors.push('Choose a day.');
        const okStart = Number.isInteger(a.start) && a.start >= 0 && a.start < DAY_MIN;
        const okEnd = Number.isInteger(a.end) && a.end >= 0 && a.end < DAY_MIN;
        if (!okStart) errors.push('Start time is invalid.');
        if (!okEnd) errors.push('End time is invalid.');
        if (okStart && okEnd && a.start === a.end) errors.push('Start and end cannot be the same time.');
        if (a.classification !== undefined && !CLASSIFICATIONS.includes(a.classification)) {
            errors.push('Classification must be inherit, fixed or flexible.');
        }
        return errors;
    }

    function sanitizeActivity(a, categories) {
        if (!a || typeof a !== 'object') return null;
        const out = {
            id: typeof a.id === 'string' && a.id ? a.id : uid('act'),
            name: typeof a.name === 'string' ? a.name.trim().slice(0, 60) : '',
            categoryId: a.categoryId,
            day: a.day,
            start: a.start,
            end: a.end,
            classification: CLASSIFICATIONS.includes(a.classification) ? a.classification : 'inherit',
        };
        if (!out.name) {
            const cat = categories.find(c => c.id === a.categoryId);
            out.name = cat ? cat.name : '';
        }
        return validateActivity(out, categories).length ? null : out;
    }

    /**
     * A plan = one version of a week: scheduled calendar blocks plus optional
     * per-category unscheduled hours ("adjust"). Adjustments let a user budget
     * e.g. "Meals: 14 h" without drawing every meal on the calendar, and let a
     * scenario trim a category (negative values) without deleting blocks.
     */
    function sanitizePlan(plan, categories) {
        const src = plan && typeof plan === 'object' ? plan : {};
        const activities = (Array.isArray(src.activities) ? src.activities : [])
            .map(a => sanitizeActivity(a, categories))
            .filter(Boolean);
        const seen = new Set();
        activities.forEach(a => {                     // guarantee unique ids
            if (seen.has(a.id)) a.id = uid('act');
            seen.add(a.id);
        });
        const adjust = {};
        const rawAdj = src.adjust && typeof src.adjust === 'object' ? src.adjust : {};
        categories.forEach(c => {
            const v = rawAdj[c.id];
            // Values above 168 are kept (and reported as over-allocation) rather than
            // silently dropped; only absurd magnitudes are treated as corrupt.
            if (isNum(v) && v !== 0 && Math.abs(v) <= MAX_ADJUST) adjust[c.id] = round2(v);
        });
        return { activities, adjust };
    }

    function emptyPlan() {
        return { activities: [], adjust: {} };
    }

    /* ── Core model ────────────────────────────────────────── */

    function effectiveType(activity, category) {
        if (activity.classification === 'fixed' || activity.classification === 'flexible') {
            return activity.classification;
        }
        return category.type;
    }

    /**
     * Break an activity into absolute-minute segments on a cyclic week
     * (0 = Monday 00:00, 10080 = next Monday 00:00). A Sunday-night block that
     * crosses midnight wraps to Monday morning — the planner models a recurring
     * week, so that time still belongs to this week's 168 hours.
     */
    function segments(a) {
        const s = a.day * DAY_MIN + a.start;
        const e = s + durationMin(a.start, a.end);
        if (e <= WEEK_MIN) return [[s, e]];
        return [[s, WEEK_MIN], [0, e - WEEK_MIN]];
    }

    function unionLength(ranges) {
        const sorted = ranges.slice().sort((x, y) => x[0] - y[0]);
        let total = 0;
        let cur = null;
        sorted.forEach(([s, e]) => {
            if (!cur || s > cur[1]) {
                if (cur) total += cur[1] - cur[0];
                cur = [s, e];
            } else if (e > cur[1]) {
                cur[1] = e;
            }
        });
        if (cur) total += cur[1] - cur[0];
        return total;
    }

    /** Pairwise overlaps between calendar blocks. */
    function findOverlaps(activities) {
        const segs = [];
        activities.forEach(a => segments(a).forEach(([s, e]) => segs.push({ a, s, e })));
        const pairs = [];
        for (let i = 0; i < segs.length; i++) {
            for (let j = i + 1; j < segs.length; j++) {
                const x = segs[i];
                const y = segs[j];
                if (x.a.id === y.a.id) continue;
                const s = Math.max(x.s, y.s);
                const e = Math.min(x.e, y.e);
                if (e > s) {
                    pairs.push({
                        aId: x.a.id, aName: x.a.name,
                        bId: y.a.id, bName: y.a.name,
                        day: Math.floor(s / DAY_MIN),
                        start: s % DAY_MIN,
                        end: e % DAY_MIN,
                        minutes: e - s,
                    });
                }
            }
        }
        const totalMin = segs.reduce((t, x) => t + (x.e - x.s), 0);
        const doubleCountedMin = totalMin - unionLength(segs.map(x => [x.s, x.e]));
        return { pairs, doubleCountedMin };
    }

    /** Minutes of calendar time falling on each day (Mon..Sun). */
    function minutesByDay(activities) {
        const days = [0, 0, 0, 0, 0, 0, 0];
        activities.forEach(a => segments(a).forEach(([s, e]) => {
            let t = s;
            while (t < e) {
                const d = Math.floor(t / DAY_MIN);
                const dayEnd = (d + 1) * DAY_MIN;
                const chunk = Math.min(e, dayEnd) - t;
                days[d] += chunk;
                t += chunk;
            }
        }));
        return days;
    }

    /**
     * Informational status against optional limits.
     * - min only:    below | met
     * - max only:    met | above
     * - target:      below | met (exact to the minute) | above
     * - none:        none
     */
    function targetStatus(hours, cat) {
        const m = hoursToMin(hours);
        const has = k => isNum(cat[k]);
        if (!has('min') && !has('target') && !has('max')) return 'none';
        if (has('min') && m < hoursToMin(cat.min)) return 'below';
        if (has('max') && m > hoursToMin(cat.max)) return 'above';
        if (has('target')) {
            const t = hoursToMin(cat.target);
            if (m < t) return 'below';
            if (m > t) return 'above';
        }
        return 'met';
    }

    /** Hours still needed to reach the binding lower limit (target or min), else 0. */
    function hoursToGoal(hours, cat) {
        const goal = isNum(cat.target) ? cat.target : isNum(cat.min) ? cat.min : null;
        if (goal === null) return 0;
        return Math.max(0, minToHours(hoursToMin(goal) - hoursToMin(hours)));
    }

    /**
     * The central calculation.
     *
     *   fixed         = Σ fixed activity time
     *   discretionary = 168 − fixed                (can be negative)
     *   allocated     = Σ flexible activity time
     *   unallocated   = discretionary − allocated  (negative ⇒ over-allocated)
     */
    function computeBudget(plan, categories) {
        const cats = categories.map(c => ({
            id: c.id, name: c.name, type: c.type, color: c.color,
            min: c.min, target: c.target, max: c.max, athletic: !!c.athletic,
            scheduledMin: 0, adjustMin: 0, fixedMin: 0, flexibleMin: 0, count: 0,
        }));
        const byId = new Map(cats.map(c => [c.id, c]));

        const clean = sanitizePlan(plan, categories);
        const invalidCount = (plan && Array.isArray(plan.activities) ? plan.activities.length : 0)
            - clean.activities.length;

        clean.activities.forEach(a => {
            const c = byId.get(a.categoryId);
            const d = durationMin(a.start, a.end);
            c.scheduledMin += d;
            c.count += 1;
            if (effectiveType(a, c) === 'fixed') c.fixedMin += d;
            else c.flexibleMin += d;
        });

        // Unscheduled adjustments use the category's own type. A negative
        // adjustment can at most cancel that type's scheduled time (never < 0).
        cats.forEach(c => {
            const raw = hoursToMin(clean.adjust[c.id] || 0);
            const key = c.type === 'fixed' ? 'fixedMin' : 'flexibleMin';
            const applied = Math.max(raw, -c[key]);
            c.adjustMin = applied;
            c.adjustClamped = applied !== raw;
            c[key] += applied;
        });

        let fixedMin = 0;
        let flexMin = 0;
        cats.forEach(c => {
            c.totalMin = c.fixedMin + c.flexibleMin;
            c.hours = minToHours(c.totalMin);
            c.scheduled = minToHours(c.scheduledMin);
            c.adjust = minToHours(c.adjustMin);
            c.fixedHours = minToHours(c.fixedMin);
            c.flexibleHours = minToHours(c.flexibleMin);
            c.status = targetStatus(c.hours, c);
            c.toGoal = hoursToGoal(c.hours, c);
            fixedMin += c.fixedMin;
            flexMin += c.flexibleMin;
        });

        const discretionaryMin = WEEK_MIN - fixedMin;
        const unallocatedMin = discretionaryMin - flexMin;
        const usedMin = fixedMin + flexMin;
        const overlaps = findOverlaps(clean.activities);
        const dayMin = minutesByDay(clean.activities);

        const result = {
            totalHours: WEEK_HOURS,
            fixed: minToHours(fixedMin),
            discretionary: minToHours(discretionaryMin),
            allocated: minToHours(flexMin),
            unallocated: minToHours(Math.max(0, unallocatedMin)),
            overallocated: minToHours(Math.max(0, -unallocatedMin)),
            balance: minToHours(unallocatedMin),               // signed
            used: minToHours(usedMin),
            fixedExceedsWeek: fixedMin > WEEK_MIN,
            pctAllocated: discretionaryMin > 0 ? flexMin / discretionaryMin : null,
            state: unallocatedMin < 0 ? 'over' : unallocatedMin === 0 ? 'full' : 'under',
            categories: cats,
            byDay: dayMin.map(minToHours),
            overlaps: overlaps.pairs,
            doubleCounted: minToHours(overlaps.doubleCountedMin),
            invalidCount,
            activityCount: clean.activities.length,
        };
        result.problems = explainProblems(result);
        return result;
    }

    /** Plain-language explanation of every constraint violation. */
    function explainProblems(b) {
        const out = [];
        const h = fmtHours;
        if (b.fixedExceedsWeek) {
            out.push(`Fixed commitments alone total ${h(b.fixed)} h — ${h(b.fixed - WEEK_HOURS)} h more than the 168 h in a week. Discretionary time is ${h(b.discretionary)} h before any flexible activity.`);
        }
        if (b.state === 'over') {
            out.push(`Over-allocated by ${h(b.overallocated)} h: fixed ${h(b.fixed)} h + flexible ${h(b.allocated)} h = ${h(b.used)} h, but a week has 168 h.`);
            if (!b.fixedExceedsWeek) {
                out.push(`Flexible activities (${h(b.allocated)} h) exceed the ${h(b.discretionary)} h of discretionary time left after fixed commitments.`);
            }
        }
        if (b.doubleCounted > 0) {
            out.push(`${h(b.doubleCounted)} h is double-counted by ${b.overlaps.length} overlapping calendar block${b.overlaps.length === 1 ? '' : 's'}.`);
        }
        b.byDay.forEach((hours, i) => {
            if (hours > 24) out.push(`${DAYS[i]} has ${h(hours)} h of calendar time scheduled in a 24 h day.`);
        });
        b.categories.forEach(c => {
            if (c.adjustClamped) out.push(`${c.name}: the unscheduled adjustment was limited so the category cannot go below 0 h.`);
        });
        if (b.invalidCount > 0) out.push(`${b.invalidCount} invalid activit${b.invalidCount === 1 ? 'y was' : 'ies were'} ignored.`);
        return out;
    }

    /* ── Insights ──────────────────────────────────────────── */

    function insights(b) {
        const h = fmtHours;
        const out = [];
        if (b.activityCount === 0 && b.used === 0) {
            out.push({ tone: 'info', text: 'This week is empty — all 168 h are unallocated. Add fixed commitments first, then budget the rest.' });
            return out;
        }
        if (b.state === 'over') {
            out.push({ tone: 'bad', text: `Your schedule is over-allocated by ${h(b.overallocated)} h.` });
        } else if (b.state === 'full') {
            out.push({ tone: 'good', text: 'Every discretionary hour is allocated — the week is fully budgeted and not over-allocated.' });
        } else {
            out.push({ tone: 'info', text: `You have ${h(b.unallocated)} discretionary hours remaining.` });
        }
        if (b.pctAllocated !== null) {
            out.push({ tone: 'info', text: `You have allocated ${Math.round(b.pctAllocated * 100)}% of your ${h(b.discretionary)} h of discretionary time.` });
        }
        out.push({ tone: 'info', text: `Fixed commitments use ${Math.round(b.fixed / WEEK_HOURS * 100)}% of the week (${h(b.fixed)} of 168 h).` });
        b.categories.forEach(c => {
            if (c.status === 'below' && c.toGoal > 0) {
                const label = isNum(c.target) ? 'target' : 'minimum';
                const fits = b.unallocated >= c.toGoal;
                out.push({
                    tone: 'warn',
                    text: `Your ${c.name.toLowerCase()} ${label} requires ${h(c.toGoal)} additional hour${c.toGoal === 1 ? '' : 's'}` +
                        (c.type === 'flexible'
                            ? (fits ? ' — it fits in your unallocated time.' : ` — ${b.unallocated > 0 ? `only ${h(b.unallocated)} h is unallocated` : 'no unallocated time remains'}, so another flexible category would need to shrink.`)
                            : '.'),
                });
            } else if (c.status === 'above' && isNum(c.max)) {
                out.push({ tone: 'warn', text: `${c.name} is ${h(c.hours - c.max)} h above its ${h(c.max)} h maximum.` });
            }
        });
        if (b.doubleCounted > 0) {
            out.push({ tone: 'warn', text: `${h(b.doubleCounted)} h of calendar time overlaps and is counted twice.` });
        }
        const flex = b.categories.filter(c => c.flexibleMin > 0).sort((x, y) => y.flexibleMin - x.flexibleMin);
        if (flex.length && b.allocated > 0) {
            out.push({ tone: 'info', text: `${flex[0].name} is your largest discretionary use at ${h(flex[0].flexibleHours)} h (${Math.round(flex[0].flexibleMin / (b.allocated * 60) * 100)}% of allocated time).` });
        }
        return out;
    }

    /* ── Scenario comparison ───────────────────────────────── */

    function compareBudgets(base, scen) {
        const rows = base.categories.map(bc => {
            const sc = scen.categories.find(c => c.id === bc.id) || { hours: 0 };
            return { id: bc.id, name: bc.name, type: bc.type, color: bc.color, base: bc.hours, scenario: sc.hours, delta: minToHours(hoursToMin(sc.hours) - hoursToMin(bc.hours)) };
        });
        const d = k => minToHours(hoursToMin(scen[k]) - hoursToMin(base[k]));
        return {
            rows,
            totals: {
                fixed: { base: base.fixed, scenario: scen.fixed, delta: d('fixed') },
                discretionary: { base: base.discretionary, scenario: scen.discretionary, delta: d('discretionary') },
                allocated: { base: base.allocated, scenario: scen.allocated, delta: d('allocated') },
                balance: { base: base.balance, scenario: scen.balance, delta: d('balance') },
            },
        };
    }

    /* ── What-if analysis ──────────────────────────────────── */

    /**
     * changes: [{ categoryId, op: 'add' | 'remove' | 'set', hours }]
     * Applies the changes as unscheduled adjustments on a COPY of the plan,
     * recomputes, and — if the week no longer fits — proposes which flexible
     * categories would have to give up time (largest slack above minimum first).
     */
    function whatIf(plan, categories, changes) {
        const before = computeBudget(plan, categories);
        const next = sanitizePlan(clone(plan), categories);
        const applied = [];
        (changes || []).forEach(ch => {
            const cat = before.categories.find(c => c.id === ch.categoryId);
            const hrs = Number(ch.hours);
            if (!cat || !isNum(hrs) || hrs < 0 || hrs > WEEK_HOURS) return;
            const current = before.categories.find(c => c.id === ch.categoryId).hours
                + minToHours(applied.filter(x => x.id === cat.id).reduce((t, x) => t + x.deltaMin, 0));
            let targetMin;
            if (ch.op === 'set') targetMin = hoursToMin(hrs);
            else if (ch.op === 'remove') targetMin = Math.max(0, hoursToMin(current) - hoursToMin(hrs));
            else targetMin = hoursToMin(current) + hoursToMin(hrs);
            const deltaMin = targetMin - hoursToMin(current);
            next.adjust[cat.id] = minToHours(hoursToMin(next.adjust[cat.id] || 0) + deltaMin);
            applied.push({ id: cat.id, name: cat.name, type: cat.type, op: ch.op, hours: hrs, deltaMin, delta: minToHours(deltaMin) });
        });
        const after = computeBudget(next, categories);

        const changedIds = new Set(applied.map(a => a.id));
        let needMin = hoursToMin(after.overallocated);
        const cuts = [];
        let unresolvedMin = 0;
        if (needMin > 0) {
            const pool = after.categories
                .filter(c => c.flexibleMin > 0 && !changedIds.has(c.id))
                .map(c => {
                    const floor = isNum(c.min) ? Math.min(hoursToMin(c.min), c.flexibleMin) : 0;
                    return { c, slack: c.flexibleMin - floor, belowMin: floor };
                });
            // Pass 1: take from time above each category's minimum, largest pool first.
            pool.slice().sort((x, y) => y.slack - x.slack || x.c.name.localeCompare(y.c.name)).forEach(p => {
                if (needMin <= 0 || p.slack <= 0) return;
                const take = Math.min(p.slack, needMin);
                needMin -= take;
                cuts.push({ id: p.c.id, name: p.c.name, hours: minToHours(take), from: p.c.flexibleHours, breaksMinimum: false });
            });
            // Pass 2: only if still short, dip below minimums.
            pool.slice().sort((x, y) => y.belowMin - x.belowMin || x.c.name.localeCompare(y.c.name)).forEach(p => {
                if (needMin <= 0 || p.belowMin <= 0) return;
                const take = Math.min(p.belowMin, needMin);
                needMin -= take;
                const existing = cuts.find(x => x.id === p.c.id);
                if (existing) { existing.hours = minToHours(hoursToMin(existing.hours) + take); existing.breaksMinimum = true; }
                else cuts.push({ id: p.c.id, name: p.c.name, hours: minToHours(take), from: p.c.flexibleHours, breaksMinimum: true });
            });
            unresolvedMin = needMin;
        }

        const absorbedMin = Math.min(hoursToMin(before.unallocated), Math.max(0, hoursToMin(after.used) - hoursToMin(before.used)));
        return {
            before, after, applied, plan: next,
            netChange: minToHours(hoursToMin(after.used) - hoursToMin(before.used)),
            absorbedByUnallocated: minToHours(absorbedMin),
            fits: after.state !== 'over',
            cuts,
            unresolved: minToHours(unresolvedMin),
            comparison: compareBudgets(before, after),
        };
    }

    /* ── Weeks & history ───────────────────────────────────── */

    function weekKey(date) {
        const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const dow = d.getDay();                           // 0 = Sunday
        d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function parseWeekKey(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function shiftWeek(key, n) {
        const d = parseWeekKey(key);
        d.setDate(d.getDate() + n * 7);
        return weekKey(d);
    }

    /** One row per stored week (oldest first) with totals + per-category hours. */
    function history(weeks, categories) {
        return Object.keys(weeks || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().map(k => {
            const b = computeBudget(weeks[k], categories);
            const byCat = {};
            let athletics = 0;
            b.categories.forEach(c => {
                byCat[c.id] = c.hours;
                if (c.athletic) athletics += c.totalMin;
            });
            return {
                week: k,
                fixed: b.fixed,
                discretionary: b.discretionary,
                allocated: b.allocated,
                balance: b.balance,
                athletics: minToHours(athletics),
                byCat,
                empty: b.used === 0,
            };
        }).filter(r => !r.empty);
    }

    /* ── Persistence shape ─────────────────────────────────── */

    function sanitizeState(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const cats = [];
        (Array.isArray(src.categories) ? src.categories : []).forEach(c => {
            const s = sanitizeCategory(c);
            if (s && !cats.some(x => x.id === s.id || x.name.toLowerCase() === s.name.toLowerCase())) cats.push(s);
        });
        const weeks = {};
        Object.keys(src.weeks && typeof src.weeks === 'object' ? src.weeks : {}).forEach(k => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(k)) weeks[k] = sanitizePlan(src.weeks[k], cats);
        });
        const scenarios = (Array.isArray(src.scenarios) ? src.scenarios : [])
            .filter(s => s && typeof s.id === 'string' && typeof s.name === 'string' && s.name.trim())
            .map(s => ({ id: s.id, name: s.name.trim().slice(0, 40), plan: sanitizePlan(s.plan, cats), createdAt: s.createdAt || null }));
        return { version: 1, categories: cats, weeks, scenarios };
    }

    /* ── Defaults & demo data ──────────────────────────────── */

    function defaultCategories() {
        const c = (id, name, type, color, extra) => Object.assign(
            { id, name, type, color, min: null, target: null, max: null, athletic: false }, extra || {});
        return [
            c('sleep', 'Sleep', 'fixed', '#5b6b8c', { min: 56 }),
            c('classes', 'Classes', 'fixed', '#3987e5'),
            c('practice', 'Practice', 'fixed', '#d95926', { athletic: true }),
            c('games', 'Games & Travel', 'fixed', '#c98500', { athletic: true }),
            c('meals', 'Meals', 'fixed', '#7d7a70'),
            c('commute', 'Commute', 'fixed', '#63605a'),
            c('work', 'Work', 'fixed', '#9085e9'),
            c('study', 'Study', 'flexible', '#199e70', { min: 15 }),
            c('gym', 'Gym', 'flexible', '#e66767'),
            c('social', 'Social', 'flexible', '#d55181', { min: 6 }),
            c('hobbies', 'Hobbies', 'flexible', '#2fb3c9'),
            c('entertainment', 'Entertainment', 'flexible', '#b58cf0'),
            c('projects', 'Personal Projects', 'flexible', '#8fbf3f'),
            c('free', 'Free Time', 'flexible', '#4fd18b', { min: 5 }),
        ];
    }

    /**
     * Demo week that reproduces the reference example exactly:
     * fixed 114 h (sleep 56, classes 15, practice 10, games 6, meals 14,
     * commute 5, work 8) and flexible 54 h (study 18, social 12, gym 5,
     * entertainment 4, free 15) → 0 h unallocated.
     */
    function demoPlan() {
        const t = parseTime;
        const acts = [];
        const add = (name, categoryId, day, start, end) =>
            acts.push({ id: uid('act'), name, categoryId, day, start: t(start), end: t(end), classification: 'inherit' });
        for (let d = 0; d < 7; d++) add('Sleep', 'sleep', d, '23:00', '07:00');
        [0, 2, 4].forEach(d => add('Lectures', 'classes', d, '09:00', '12:00'));
        [1, 3].forEach(d => add('Lectures', 'classes', d, '09:30', '12:30'));
        for (let d = 0; d < 5; d++) add('Team practice', 'practice', d, '15:00', '17:00');
        add('Game + bus', 'games', 5, '12:00', '18:00');
        [1, 3].forEach(d => add('Campus job', 'work', d, '18:00', '22:00'));
        for (let d = 0; d < 5; d++) add('Lift', 'gym', d, '07:00', '08:00');
        [0, 2].forEach(d => add('Library', 'study', d, '19:00', '22:00'));
        [1, 3, 4].forEach(d => add('Study block', 'study', d, '13:00', '15:00'));
        add('Review', 'study', 5, '09:00', '11:00');
        add('Weekly prep', 'study', 6, '13:00', '17:00');
        [4, 5].forEach(d => add('Out with friends', 'social', d, '19:00', '23:00'));
        add('Team dinner', 'social', 6, '18:00', '22:00');
        [0, 1, 3, 6].forEach(d => add('Games / TV', 'entertainment', d, '22:00', '23:00'));
        return { activities: acts, adjust: { meals: 14, commute: 5, free: 15 } };
    }

    return {
        WEEK_HOURS, DAY_MIN, WEEK_MIN, DAYS, DAYS_SHORT, TYPES, CLASSIFICATIONS,
        hoursToMin, minToHours, round2, fmtHours, parseTime, formatTime, durationMin, uid, clone,
        validateCategory, sanitizeCategory, validateActivity, sanitizeActivity, sanitizePlan, emptyPlan,
        effectiveType, segments, findOverlaps, minutesByDay, targetStatus, hoursToGoal,
        computeBudget, insights, compareBudgets, whatIf,
        weekKey, parseWeekKey, shiftWeek, history, sanitizeState,
        defaultCategories, demoPlan,
    };
});
