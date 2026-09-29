'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TB = require('../js/engine.js');

const cats = TB.defaultCategories();
const byName = (b, id) => b.categories.find(c => c.id === id);

function act(categoryId, day, start, end, extra) {
    return Object.assign({
        id: TB.uid('t'), name: categoryId, categoryId, day,
        start: TB.parseTime(start), end: TB.parseTime(end), classification: 'inherit',
    }, extra || {});
}

/** Plan built purely from unscheduled hours: { categoryId: hours }. */
function lump(hours) {
    return { activities: [], adjust: Object.assign({}, hours) };
}

const EXAMPLE = {
    sleep: 56, classes: 15, practice: 10, games: 6, meals: 14, commute: 5, work: 8,
    study: 18, social: 12, gym: 5, entertainment: 4, free: 15,
};

test('reference example: 114 fixed, 54 discretionary, fully allocated', () => {
    const b = TB.computeBudget(lump(EXAMPLE), cats);
    assert.equal(b.totalHours, 168);
    assert.equal(b.fixed, 114);
    assert.equal(b.discretionary, 54);
    assert.equal(b.allocated, 54);
    assert.equal(b.unallocated, 0);
    assert.equal(b.overallocated, 0);
    assert.equal(b.state, 'full');
    assert.deepEqual(b.problems, []);
});

test('demo calendar week reproduces the reference example exactly', () => {
    const b = TB.computeBudget(TB.demoPlan(), cats);
    Object.entries(EXAMPLE).forEach(([id, h]) => assert.equal(byName(b, id).hours, h, id));
    assert.equal(b.fixed, 114);
    assert.equal(b.discretionary, 54);
    assert.equal(b.allocated, 54);
    assert.equal(b.state, 'full');
    assert.equal(b.overlaps.length, 0, 'demo week should have no overlaps');
    b.byDay.forEach(h => assert.ok(h <= 24));
});

test('empty week: 168 discretionary, all unallocated', () => {
    const b = TB.computeBudget(TB.emptyPlan(), cats);
    assert.equal(b.fixed, 0);
    assert.equal(b.discretionary, 168);
    assert.equal(b.unallocated, 168);
    assert.equal(b.state, 'under');
    assert.equal(TB.insights(b)[0].text.includes('empty'), true);
});

test('over-allocated schedule is flagged and explained', () => {
    const b = TB.computeBudget(lump(Object.assign({}, EXAMPLE, { study: 21 })), cats);
    assert.equal(b.state, 'over');
    assert.equal(b.overallocated, 3);
    assert.equal(b.unallocated, 0);
    assert.equal(b.balance, -3);
    assert.ok(b.problems.some(p => p.includes('Over-allocated by 3 h')));
});

test('fixed commitments alone exceeding 168 give negative discretionary', () => {
    const b = TB.computeBudget(lump({ sleep: 100, work: 80 }), cats);
    assert.equal(b.fixed, 180);
    assert.equal(b.discretionary, -12);
    assert.equal(b.fixedExceedsWeek, true);
    assert.equal(b.overallocated, 12);
    assert.equal(b.pctAllocated, null);
    assert.ok(b.problems[0].includes('12 h more than the 168'));
});

test('decimal hours stay exact (no float drift)', () => {
    const acts = [];
    for (let d = 0; d < 7; d++) acts.push(act('study', d, '10:00', '11:30'));
    const b = TB.computeBudget({ activities: acts, adjust: { free: 0.1, gym: 0.2 } }, cats);
    assert.equal(byName(b, 'study').hours, 10.5);
    assert.equal(b.allocated, 10.8);
    assert.equal(b.unallocated, 157.2);
});

test('activity crossing midnight counts full duration and splits across days', () => {
    const b = TB.computeBudget({ activities: [act('sleep', 0, '23:00', '07:00')], adjust: {} }, cats);
    assert.equal(b.fixed, 8);
    assert.equal(b.byDay[0], 1);
    assert.equal(b.byDay[1], 7);
});

test('Sunday-night block wraps to Monday of the same cyclic week', () => {
    const acts = [act('sleep', 6, '22:00', '06:00'), act('study', 0, '05:00', '07:00')];
    const b = TB.computeBudget({ activities: acts, adjust: {} }, cats);
    assert.equal(b.byDay[6], 2);
    assert.equal(b.byDay[0], 8);
    assert.equal(b.overlaps.length, 1);
    assert.equal(b.overlaps[0].day, 0);
    assert.equal(b.overlaps[0].minutes, 60);
});

test('overlapping activities are detected and double-counting measured', () => {
    const acts = [
        act('classes', 1, '09:00', '12:00'),
        act('meals', 1, '11:00', '13:00'),
        act('study', 1, '11:30', '12:30'),
    ];
    const b = TB.computeBudget({ activities: acts, adjust: {} }, cats);
    assert.equal(b.overlaps.length, 3);
    // union 09:00–13:00 = 4 h, sum = 6 h → 2 h double-counted
    assert.equal(b.doubleCounted, 2);
    assert.ok(b.problems.some(p => p.includes('double-counted')));
});

test('a day with more than 24 h of blocks is called out', () => {
    const acts = [act('work', 2, '00:00', '23:00'), act('study', 2, '01:00', '23:30')];
    const b = TB.computeBudget({ activities: acts, adjust: {} }, cats);
    assert.ok(b.problems.some(p => p.startsWith('Wednesday has')));
});

test('activity classification overrides category type', () => {
    const a = act('work', 0, '09:00', '13:00');
    let b = TB.computeBudget({ activities: [a], adjust: {} }, cats);
    assert.equal(b.fixed, 4);
    assert.equal(b.allocated, 0);
    a.classification = 'flexible';
    b = TB.computeBudget({ activities: [a], adjust: {} }, cats);
    assert.equal(b.fixed, 0);
    assert.equal(b.allocated, 4);
    assert.equal(byName(b, 'work').hours, 4);
});

test('changing a category from fixed to flexible moves its hours', () => {
    const edited = cats.map(c => c.id === 'work' ? Object.assign({}, c, { type: 'flexible' }) : c);
    const b = TB.computeBudget(lump(EXAMPLE), edited);
    assert.equal(b.fixed, 106);
    assert.equal(b.discretionary, 62);
    assert.equal(b.allocated, 62);
    assert.equal(b.state, 'full');
});

test('editing a duration and deleting an activity update totals', () => {
    const plan = { activities: [act('study', 0, '10:00', '12:00'), act('study', 1, '10:00', '12:00')], adjust: {} };
    assert.equal(TB.computeBudget(plan, cats).allocated, 4);
    plan.activities[0].end = TB.parseTime('13:30');
    assert.equal(TB.computeBudget(plan, cats).allocated, 5.5);
    plan.activities.splice(1, 1);
    assert.equal(TB.computeBudget(plan, cats).allocated, 3.5);
});

test('duplicate activity names are allowed and both counted', () => {
    const plan = { activities: [act('study', 0, '10:00', '11:00', { name: 'Library' }), act('study', 0, '14:00', '15:00', { name: 'Library' })], adjust: {} };
    assert.equal(TB.computeBudget(plan, cats).allocated, 2);
});

test('invalid activities are ignored, not allowed to corrupt totals', () => {
    const plan = {
        activities: [
            act('study', 0, '10:00', '11:00'),
            { id: 'x1', name: 'Bad', categoryId: 'nope', day: 0, start: 0, end: 60 },
            { id: 'x2', name: 'Zero', categoryId: 'study', day: 0, start: 60, end: 60 },
            { id: 'x3', name: 'NaN', categoryId: 'study', day: 9, start: NaN, end: 60 },
            null,
        ],
        adjust: { study: 'abc', free: Infinity, gym: -5000 },
    };
    const b = TB.computeBudget(plan, cats);
    assert.equal(b.allocated, 1);
    assert.equal(b.invalidCount, 4);
});

test('negative adjustments cannot push a category below zero', () => {
    const plan = { activities: [act('practice', 0, '15:00', '17:00')], adjust: { practice: -5 } };
    const b = TB.computeBudget(plan, cats);
    assert.equal(byName(b, 'practice').hours, 0);
    assert.equal(b.fixed, 0);
    assert.ok(b.problems.some(p => p.includes('Practice')));
});

test('target status is informational: below / met / above / none', () => {
    assert.equal(TB.targetStatus(52, { min: 56 }), 'below');
    assert.equal(TB.targetStatus(60, { min: 56 }), 'met');
    assert.equal(TB.targetStatus(18, { target: 15 }), 'above');
    assert.equal(TB.targetStatus(15, { target: 15 }), 'met');
    assert.equal(TB.targetStatus(9, { max: 8 }), 'above');
    assert.equal(TB.targetStatus(4, {}), 'none');
    assert.equal(TB.hoursToGoal(13, { min: 15 }), 2);
    assert.equal(TB.hoursToGoal(20, { min: 15 }), 0);
});

test('insights report remaining time, % allocated and target gaps', () => {
    const b = TB.computeBudget(lump({ sleep: 56, classes: 15, study: 13, free: 20 }), cats);
    const texts = TB.insights(b).map(i => i.text);
    assert.ok(texts.includes('You have 64 discretionary hours remaining.'));
    assert.ok(texts.some(t => t.startsWith('You have allocated 34%')));
    assert.ok(texts.some(t => t.startsWith('Your study minimum requires 2 additional hours')));
});

test('scenarios: comparing does not mutate the base plan', () => {
    const base = lump(EXAMPLE);
    const snapshot = JSON.stringify(base);
    const scenario = TB.clone(base);
    scenario.adjust.practice = 8;
    scenario.adjust.study = 25;
    scenario.adjust.social = 5;
    const cmp = TB.compareBudgets(TB.computeBudget(base, cats), TB.computeBudget(scenario, cats));
    assert.equal(JSON.stringify(base), snapshot);
    const row = id => cmp.rows.find(r => r.id === id);
    assert.equal(row('practice').delta, -2);
    assert.equal(row('study').delta, 7);
    assert.equal(row('social').delta, -7);
    assert.equal(cmp.totals.fixed.delta, -2);
    assert.equal(cmp.totals.discretionary.delta, 2);
});

test('what-if: adding study within unallocated time fits', () => {
    const plan = lump(Object.assign({}, EXAMPLE, { free: 10 }));   // 5 h unallocated
    const snapshot = JSON.stringify(plan);
    const r = TB.whatIf(plan, cats, [{ categoryId: 'study', op: 'add', hours: 5 }]);
    assert.equal(JSON.stringify(plan), snapshot, 'what-if must not modify the input plan');
    assert.equal(r.fits, true);
    assert.equal(r.after.unallocated, 0);
    assert.equal(r.absorbedByUnallocated, 5);
    assert.deepEqual(r.cuts, []);
});

test('what-if: practice +4 on a full week proposes cuts from largest slack', () => {
    const r = TB.whatIf(lump(EXAMPLE), cats, [{ categoryId: 'practice', op: 'add', hours: 4 }]);
    assert.equal(r.fits, false);
    assert.equal(r.after.discretionary, 50);
    assert.equal(r.after.overallocated, 4);
    // Free Time has 15 h, min 5 → 10 h slack (largest)
    assert.deepEqual(r.cuts.map(c => [c.id, c.hours]), [['free', 4]]);
    assert.equal(r.unresolved, 0);
});

test('what-if: set work to 10 h', () => {
    const r = TB.whatIf(lump(EXAMPLE), cats, [{ categoryId: 'work', op: 'set', hours: 10 }]);
    assert.equal(r.applied[0].delta, 2);
    assert.equal(byName(r.after, 'work').hours, 10);
    assert.equal(r.after.overallocated, 2);
});

test('what-if: remove never goes below zero', () => {
    const r = TB.whatIf(lump({ gym: 3 }), cats, [{ categoryId: 'gym', op: 'remove', hours: 10 }]);
    assert.equal(byName(r.after, 'gym').hours, 0);
    assert.equal(r.applied[0].delta, -3);
});

test('what-if: cuts dip below minimums only when necessary and report leftovers', () => {
    const plan = lump({ sleep: 150, study: 16, social: 2 });   // 168 exactly; study min 15
    const r = TB.whatIf(plan, cats, [{ categoryId: 'sleep', op: 'add', hours: 20 }]);
    // need 20: slack study 1 → then below-min study 15, social 2 → total 18, 2 unresolved
    assert.equal(r.unresolved, 2);
    const study = r.cuts.find(c => c.id === 'study');
    assert.equal(study.hours, 16);
    assert.equal(study.breaksMinimum, true);
});

test('category validation rejects duplicates and bad limits', () => {
    assert.ok(TB.validateCategory({ id: 'n', name: 'study', type: 'flexible' }, cats)[0].includes('already exists'));
    assert.ok(TB.validateCategory({ id: 'n', name: 'X', type: 'flexible', min: 10, max: 5 }, cats).length);
    assert.equal(TB.validateCategory({ id: 'n', name: 'X', type: 'fixed', min: 1.5 }, cats).length, 0);
});

test('history computes weekly series sorted by week, skipping empty weeks', () => {
    const weeks = {
        '2026-09-21': lump(EXAMPLE),
        '2026-09-14': lump(Object.assign({}, EXAMPLE, { study: 10 })),
        '2026-09-07': TB.emptyPlan(),
    };
    const h = TB.history(weeks, cats);
    assert.deepEqual(h.map(r => r.week), ['2026-09-14', '2026-09-21']);
    assert.equal(h[1].athletics, 16);
    assert.equal(h[0].byCat.study, 10);
});

test('week keys are Mondays and shift by 7 days', () => {
    assert.equal(TB.weekKey(new Date(2026, 8, 29)), '2026-09-28');   // Tue
    assert.equal(TB.weekKey(new Date(2026, 9, 4)), '2026-09-28');    // Sun
    assert.equal(TB.shiftWeek('2026-09-28', 1), '2026-10-05');
    assert.equal(TB.shiftWeek('2026-09-28', -5), '2026-08-24');
});

test('sanitizeState drops corrupt data', () => {
    const s = TB.sanitizeState({
        categories: [...cats, { id: 'dup', name: 'Sleep', type: 'fixed' }, { name: 'no id' }],
        weeks: { 'bad-key': {}, '2026-09-28': { activities: [act('sleep', 0, '23:00', '07:00'), { junk: 1 }] } },
        scenarios: [{ id: 's1', name: 'Exam', plan: {} }, { id: 's2', name: '' }],
    });
    assert.equal(s.categories.length, cats.length);
    assert.deepEqual(Object.keys(s.weeks), ['2026-09-28']);
    assert.equal(s.weeks['2026-09-28'].activities.length, 1);
    assert.equal(s.scenarios.length, 1);
    assert.deepEqual(TB.sanitizeState(null).categories, []);
});

test('dayOpenTime: 24 h minus booked time, overlaps counted once', () => {
    const acts = [
        act('sleep', 0, '23:00', '07:00'),          // Mon 23–24 + Tue 00–07
        act('classes', 1, '09:00', '12:00'),
        act('meals', 1, '11:00', '13:00'),          // overlaps class by 1 h
        act('practice', 1, '15:00', '17:00'),
    ];
    const tue = TB.dayOpenTime(acts, 1);
    assert.equal(tue.booked, 7 + 4 + 2);            // 00–07, 09–13, 15–17
    assert.equal(tue.free, 11);
    assert.deepEqual(tue.windows.map(w => [TB.formatTime(w.start), w.minutes / 60]),
        [['07:00', 2], ['13:00', 2], ['17:00', 7]]);
    assert.equal(TB.dayOpenTime(acts, 0).free, 23);
    assert.equal(TB.dayOpenTime([], 3).free, 24);
});

test('dayOpenTime: demo week free time per day', () => {
    const plan = TB.demoPlan();
    const free = [0, 1, 2, 3, 4, 5, 6].map(d => TB.dayOpenTime(plan.activities, d).free);
    const byDay = TB.computeBudget(plan, cats).byDay;
    free.forEach((f, d) => assert.equal(f, 24 - byDay[d]));   // no overlaps in demo
});
