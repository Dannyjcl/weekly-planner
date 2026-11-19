/*
 * Google Calendar → Schedule tab (read-only).
 *
 * Shows events from your Google Calendar as read-only blocks on the planner's
 * schedule, so anything added to Google Calendar (by you or by an assistant)
 * also appears here. The planner never writes to Google Calendar.
 *
 * How access works
 *   - Google Identity Services (GIS) asks you, in a Google popup, to let this
 *     site *view* your calendar events (scope: calendar.events.readonly).
 *   - Google returns a short-lived access token (about 1 hour). It is kept only
 *     in this browser tab (sessionStorage), never in Firestore, localStorage
 *     sync or the code. When it expires, one tap on "Load Google Calendar"
 *     gets a new one (no consent screen after the first time).
 *   - "Disconnect" revokes the token with Google and forgets this device.
 *
 * Pure helpers (time-zone maths, turning API events into per-day pieces) are
 * exported for Node tests; the browser part only runs when `window` exists.
 */
(function (root, factory) {
    const api = factory(typeof window !== 'undefined' ? window : null);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.GCal = api;
})(typeof self !== 'undefined' ? self : this, function (win) {
    'use strict';

    const DAY_MIN = 24 * 60;
    const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
    const API = 'https://www.googleapis.com/calendar/v3/calendars/';
    const GIS_SRC = 'https://accounts.google.com/gsi/client';
    const CONNECTED_KEY = 'gcal:connected';   // localStorage, this device only (not a cloud-synced key)
    const TOKEN_KEY = 'gcal:token';           // sessionStorage, this tab only
    const STALE_MS = 5 * 60 * 1000;           // re-fetch a week after 5 minutes

    /* ── Pure helpers ──────────────────────────────────────── */

    const fmtCache = {};
    function partsIn(ms, tz) {
        const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }));
        const p = {};
        f.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
        return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
    }

    /** UTC ms of 00:00 on the calendar date y-m-d in time zone tz (DST-safe). */
    function zonedMidnight(y, m, d, tz) {
        const guess = Date.UTC(y, m - 1, d);
        const offsetAt = t => {
            const p = partsIn(t, tz);
            return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - t;
        };
        const first = guess - offsetAt(guess);
        return guess - offsetAt(first);
    }

    /** 'YYYY-MM-DD' + n days. */
    function addDays(ymd, n) {
        const [y, m, d] = ymd.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1, d + n));
        return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0');
    }

    /** Midnights (UTC ms) for the 7 days of the week starting Monday weekKey, plus the next Monday. */
    function weekBounds(weekKey, tz) {
        return [0, 1, 2, 3, 4, 5, 6, 7].map(i => {
            const [y, m, d] = addDays(weekKey, i).split('-').map(Number);
            return zonedMidnight(y, m, d, tz);
        });
    }

    function clock(min) {
        return String(Math.floor(min / 60) % 24).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
    }

    function safeLink(url) {
        return typeof url === 'string' && /^https:\/\/(www\.)?google\.com\/calendar\//.test(url) ? url : '';
    }

    /**
     * Turn Calendar API events into what the schedule draws.
     *   timed:  [{ id, title, day, start, end, cont, label, minutes, link, location }]
     *           start/end are wall-clock minutes in tz on that day (end ≤ 1440);
     *           events crossing midnight are split, later parts have cont: true.
     *   allDay: 7 arrays of { id, title, link }
     * Cancelled events and events you declined are skipped.
     */
    function toWeek(items, weekKey, tz) {
        const bounds = weekBounds(weekKey, tz);
        const timed = [];
        const allDay = [[], [], [], [], [], [], []];
        const dates = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(weekKey, i));
        (items || []).forEach(ev => {
            if (!ev || ev.status === 'cancelled' || !ev.start || !ev.end) return;
            const me = (ev.attendees || []).find(a => a && a.self);
            if (me && me.responseStatus === 'declined') return;
            const title = (ev.summary && String(ev.summary).trim()) || '(No title)';
            const link = safeLink(ev.htmlLink);
            const id = String(ev.id || title);
            if (ev.start.date) {
                const from = ev.start.date;
                const to = ev.end.date || addDays(from, 1);    // end date is exclusive
                dates.forEach((ds, i) => { if (ds >= from && ds < to) allDay[i].push({ id, title, link }); });
                return;
            }
            const s = Date.parse(ev.start.dateTime);
            const e = Date.parse(ev.end.dateTime);
            if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
            const sp = partsIn(s, tz);
            const ep = partsIn(e, tz);
            const label = clock(sp.h * 60 + sp.mi) + '–' + clock(ep.h * 60 + ep.mi);
            const minutes = Math.round((e - s) / 60000);
            for (let i = 0; i < 7; i++) {
                const d0 = bounds[i];
                const d1 = bounds[i + 1];
                if (e <= d0 || s >= d1) continue;
                const a = Math.max(s, d0);
                const pa = partsIn(a, tz);
                const start = a === d0 ? 0 : pa.h * 60 + pa.mi;
                let end;
                if (e >= d1) end = DAY_MIN;
                else { const pb = partsIn(e, tz); end = pb.h * 60 + pb.mi; }
                if (end <= start) end = Math.min(DAY_MIN, start + 1);
                timed.push({ id, title, day: i, start, end, cont: s < d0, label, minutes, link, location: ev.location ? String(ev.location) : '' });
            }
        });
        return { timed, allDay };
    }

    const pure = { SCOPE, zonedMidnight, weekBounds, addDays, toWeek, partsIn };
    if (!win) return pure;

    /* ── Browser part ──────────────────────────────────────── */

    const cfg = Object.assign({ clientId: '', calendarId: 'primary', timeZone: 'America/Chicago' }, win.GCAL_CONFIG || {});
    const configured = /\.apps\.googleusercontent\.com$/.test(String(cfg.clientId || '').trim());
    const listeners = new Set();
    const weeks = {};                 // weekKey -> { data, at, loading, error }
    let tokenClient = null;
    let gisPromise = null;
    let error = '';                   // last connection-level error
    let busy = false;                 // waiting for the Google popup

    const lsGet = k => { try { return win.localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { if (v === null) win.localStorage.removeItem(k); else win.localStorage.setItem(k, v); } catch (e) { /* ignore */ } };

    function getToken() {
        try {
            const t = JSON.parse(win.sessionStorage.getItem(TOKEN_KEY));
            if (t && t.token && t.exp > Date.now() + 30000) return t.token;
        } catch (e) { /* ignore */ }
        return null;
    }
    function setToken(token, seconds) {
        try {
            if (!token) win.sessionStorage.removeItem(TOKEN_KEY);
            else win.sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + (Number(seconds) || 3600) * 1000 }));
        } catch (e) { /* ignore */ }
    }

    function emit() { listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

    function loadGis() {
        if (win.google && win.google.accounts && win.google.accounts.oauth2) return Promise.resolve();
        if (gisPromise) return gisPromise;
        gisPromise = new Promise((resolve, reject) => {
            const s = win.document.createElement('script');
            s.src = GIS_SRC; s.async = true; s.defer = true;
            s.onload = () => resolve();
            s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in.')); };
            win.document.head.appendChild(s);
        });
        return gisPromise;
    }

    function ensureClient() {
        if (tokenClient) return tokenClient;
        tokenClient = win.google.accounts.oauth2.initTokenClient({
            client_id: cfg.clientId.trim(),
            scope: SCOPE,
            callback: resp => {
                busy = false;
                if (!resp || resp.error || !resp.access_token) {
                    error = resp && resp.error === 'access_denied' ? 'Calendar access was not allowed.' : 'Google sign-in did not finish.';
                    emit();
                    return;
                }
                if (win.google.accounts.oauth2.hasGrantedAllScopes && !win.google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
                    error = 'Tick the box to let the planner see your calendar events, then try again.';
                    emit();
                    return;
                }
                error = '';
                setToken(resp.access_token, resp.expires_in);
                lsSet(CONNECTED_KEY, '1');
                Object.keys(weeks).forEach(k => delete weeks[k]);
                emit();
            },
            error_callback: err => {
                busy = false;
                error = err && err.type === 'popup_failed_to_open' ? 'Your browser blocked the Google popup. Allow popups for this site and try again.' : '';
                emit();
            },
        });
        return tokenClient;
    }

    /** Must run from a tap/click (Google opens a popup). */
    function connect() {
        if (!configured) return;
        const go = () => {
            busy = true; error = ''; emit();
            ensureClient().requestAccessToken({ prompt: lsGet(CONNECTED_KEY) ? '' : 'consent' });
        };
        if (win.google && win.google.accounts && win.google.accounts.oauth2) go();
        else loadGis().then(go, e => { error = e.message; emit(); });
    }

    function disconnect() {
        const t = getToken();
        if (t && win.google && win.google.accounts && win.google.accounts.oauth2) {
            try { win.google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ }
        }
        setToken(null);
        lsSet(CONNECTED_KEY, null);
        Object.keys(weeks).forEach(k => delete weeks[k]);
        error = '';
        emit();
    }

    async function fetchWeek(weekKey) {
        const token = getToken();
        if (!token) return;
        const w = weeks[weekKey] || (weeks[weekKey] = {});
        w.loading = true; w.error = '';
        const bounds = weekBounds(weekKey, cfg.timeZone);
        const items = [];
        try {
            let page = '';
            for (let n = 0; n < 5; n++) {
                const q = new URLSearchParams({
                    singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeZone: cfg.timeZone,
                    timeMin: new Date(bounds[0]).toISOString(), timeMax: new Date(bounds[7]).toISOString(),
                    fields: 'nextPageToken,items(id,status,summary,location,htmlLink,start,end,attendees(self,responseStatus))',
                });
                if (page) q.set('pageToken', page);
                const res = await win.fetch(API + encodeURIComponent(cfg.calendarId || 'primary') + '/events?' + q, {
                    headers: { Authorization: 'Bearer ' + token },
                });
                if (res.status === 401) {          // token expired or revoked: one tap reconnects
                    setToken(null);
                    delete weeks[weekKey];
                    emit();
                    return;
                }
                if (!res.ok) throw new Error(res.status === 403 ? 'Google refused the request (is the Calendar API enabled?)' : 'Google Calendar error ' + res.status);
                const body = await res.json();
                items.push(...(body.items || []));
                page = body.nextPageToken || '';
                if (!page) break;
            }
            w.data = toWeek(items, weekKey, cfg.timeZone);
            w.at = Date.now();
        } catch (e) {
            w.error = e && e.message ? e.message : 'Could not load Google Calendar.';
            w.at = Date.now();
        }
        w.loading = false;
        emit();
    }

    /** Events for a week if we have them; starts a fetch when needed. */
    function forWeek(weekKey) {
        if (!configured || !getToken()) return null;
        const w = weeks[weekKey];
        if (!w || (!w.loading && Date.now() - (w.at || 0) > STALE_MS)) fetchWeek(weekKey);
        return w && w.data ? w.data : null;
    }

    function refresh(weekKey) {
        if (weeks[weekKey] && weeks[weekKey].loading) return;
        delete weeks[weekKey];
        forWeek(weekKey);
        emit();
    }

    /**
     * What the toolbar should show:
     *   off       not set up (no client ID): show nothing
     *   connect   never connected on this device
     *   reload    connected before, token expired: one tap to reload
     *   busy      waiting for Google
     *   loading   fetching this week
     *   ok        events loaded ({ count })
     *   error     last attempt failed ({ message })
     */
    function status(weekKey) {
        if (!configured) return { state: 'off' };
        if (busy) return { state: 'busy' };
        if (!getToken()) return { state: lsGet(CONNECTED_KEY) ? 'reload' : 'connect', message: error };
        const w = weeks[weekKey];
        if (w && w.error) return { state: 'error', message: w.error };
        if (!w || !w.data) return { state: 'loading' };
        const n = w.data.timed.filter(p => !p.cont).length + new Set([].concat(...w.data.allDay).map(a => a.id)).size;
        return { state: w.loading ? 'loading' : 'ok', count: n };
    }

    // Preload Google's script so the first tap can open the popup straight away.
    if (configured) loadGis().catch(() => {});

    return Object.assign({}, pure, {
        configured, timeZone: cfg.timeZone,
        connect, disconnect, refresh, forWeek, status,
        onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    });
});
