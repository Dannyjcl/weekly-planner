'use strict';

// Google Calendar → schedule conversion (pure part of js/gcal.js; no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/gcal.js');

const TZ = 'America/Chicago';
const WEEK = '2026-11-16';                 // Monday Nov 16 2026 (Central = UTC-6)

const timed = (id, start, end, extra) => Object.assign({ id, summary: id, start: { dateTime: start }, end: { dateTime: end } }, extra || {});

test('uses the read-only events scope', () => {
    assert.equal(G.SCOPE, 'https://www.googleapis.com/auth/calendar.events.readonly');
});

test('Chicago midnight is 06:00 UTC in winter and 05:00 UTC in summer', () => {
    assert.equal(new Date(G.zonedMidnight(2026, 11, 19, TZ)).toISOString(), '2026-11-19T06:00:00.000Z');
    assert.equal(new Date(G.zonedMidnight(2026, 7, 1, TZ)).toISOString(), '2026-07-01T05:00:00.000Z');
});

test('a UTC event lands on the right Central day and time', () => {
    // 15:00Z Thursday = 09:00 Central Thursday
    const w = G.toWeek([timed('Interview', '2026-11-19T15:00:00Z', '2026-11-19T16:30:00Z')], WEEK, TZ);
    assert.equal(w.timed.length, 1);
    const p = w.timed[0];
    assert.equal(p.day, 3);
    assert.equal(p.start, 9 * 60);
    assert.equal(p.end, 10 * 60 + 30);
    assert.equal(p.label, '09:00–10:30');
    assert.equal(p.minutes, 90);
    assert.equal(p.cont, false);
});

test('an event late on Monday evening in Central is not pushed to Tuesday', () => {
    // 03:30Z Tuesday = 21:30 Central Monday
    const w = G.toWeek([timed('Study', '2026-11-17T03:30:00Z', '2026-11-17T04:30:00Z')], WEEK, TZ);
    assert.equal(w.timed[0].day, 0);
    assert.equal(w.timed[0].start, 21 * 60 + 30);
});

test('offset datetimes from Google are honoured', () => {
    const w = G.toWeek([timed('Practice', '2026-11-18T15:00:00-06:00', '2026-11-18T17:00:00-06:00')], WEEK, TZ);
    assert.deepEqual([w.timed[0].day, w.timed[0].start, w.timed[0].end], [2, 15 * 60, 17 * 60]);
});

test('events crossing midnight are split into two pieces', () => {
    const w = G.toWeek([timed('Bus trip', '2026-11-20T22:00:00-06:00', '2026-11-21T02:00:00-06:00')], WEEK, TZ);
    assert.equal(w.timed.length, 2);
    assert.deepEqual(w.timed.map(p => [p.day, p.start, p.end, p.cont]), [[4, 22 * 60, 1440, false], [5, 0, 120, true]]);
});

test('events outside the week are dropped, partial overlaps are clipped', () => {
    const w = G.toWeek([
        timed('Last week', '2026-11-15T10:00:00-06:00', '2026-11-15T11:00:00-06:00'),
        timed('Into Monday', '2026-11-15T23:00:00-06:00', '2026-11-16T01:00:00-06:00'),
        timed('Next week', '2026-11-23T10:00:00-06:00', '2026-11-23T11:00:00-06:00'),
    ], WEEK, TZ);
    assert.equal(w.timed.length, 1);
    assert.deepEqual([w.timed[0].day, w.timed[0].start, w.timed[0].end, w.timed[0].cont], [0, 0, 60, true]);
});

test('all-day events go to each day they cover (end date exclusive)', () => {
    const w = G.toWeek([{ id: 'trip', summary: 'Away game', start: { date: '2026-11-20' }, end: { date: '2026-11-22' } }], WEEK, TZ);
    assert.equal(w.timed.length, 0);
    assert.deepEqual(w.allDay.map(d => d.length), [0, 0, 0, 0, 1, 1, 0]);
});

test('cancelled and declined events are skipped; missing titles get a placeholder', () => {
    const w = G.toWeek([
        timed('gone', '2026-11-19T15:00:00Z', '2026-11-19T16:00:00Z', { status: 'cancelled' }),
        timed('nope', '2026-11-19T15:00:00Z', '2026-11-19T16:00:00Z', { attendees: [{ self: true, responseStatus: 'declined' }] }),
        { id: 'x', start: { dateTime: '2026-11-19T17:00:00Z' }, end: { dateTime: '2026-11-19T18:00:00Z' } },
    ], WEEK, TZ);
    assert.equal(w.timed.length, 1);
    assert.equal(w.timed[0].title, '(No title)');
});

test('only Google Calendar links are kept', () => {
    const w = G.toWeek([
        timed('a', '2026-11-19T15:00:00Z', '2026-11-19T16:00:00Z', { htmlLink: 'https://www.google.com/calendar/event?eid=abc' }),
        timed('b', '2026-11-19T17:00:00Z', '2026-11-19T18:00:00Z', { htmlLink: 'javascript:alert(1)' }),
    ], WEEK, TZ);
    assert.equal(w.timed[0].link, 'https://www.google.com/calendar/event?eid=abc');
    assert.equal(w.timed[1].link, '');
});

test('fall-back DST day: wall-clock times stay right', () => {
    // Nov 1 2026 is the DST change; week of Oct 26. 3 PM CST = 21:00Z
    const w = G.toWeek([timed('Game', '2026-11-01T21:00:00Z', '2026-11-01T23:00:00Z')], '2026-10-26', TZ);
    assert.deepEqual([w.timed[0].day, w.timed[0].start, w.timed[0].end], [6, 15 * 60, 17 * 60]);
});
