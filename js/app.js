/*
 * TimeBudget UI. All time math lives in engine.js (global `TB`); this file
 * only reads/writes state, renders views and wires events.
 */
(function () {
    'use strict';

    const STORE_KEY = 'timebudget:v1';
    const UI_KEY = 'timebudget:ui';
    const HOUR_PX = 36;
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const PRESETS = ['Normal Week', 'Exam Week', 'Game Week', 'Tournament Week', 'Internship Week'];
    const AGG_SERIES = {
        discretionary: { name: 'Discretionary', color: '#ffab2e' },
        allocated: { name: 'Allocated', color: '#c3c9d2' },
        athletics: { name: 'Athletics', color: '#ff7a45' },
    };

    const $ = sel => document.querySelector(sel);
    const H = TB.fmtHours;

    /* ── State ─────────────────────────────────────────────── */

    let state;
    const todayIdx = (new Date().getDay() + 6) % 7;
    const ui = {
        week: TB.weekKey(new Date()),
        plan: 'base',
        tab: 'overview',
        agendaDay: todayIdx,
        compareId: null,
        whatif: null,
        series: ['study', 'sleep', 'athletics', 'social', 'discretionary'],
    };

    function loadState() {
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { raw = null; }
        if (!raw) {
            // First run: seed the current week with the reference demo week.
            const categories = TB.defaultCategories();
            state = { version: 1, categories, weeks: { [ui.week]: TB.demoPlan() }, scenarios: [], meta: { demoNotice: true } };
            save();
            return;
        }
        state = TB.sanitizeState(raw);
        state.meta = { demoNotice: !!(raw.meta && raw.meta.demoNotice) };
        try {
            const u = JSON.parse(localStorage.getItem(UI_KEY)) || {};
            if (typeof u.tab === 'string') ui.tab = u.tab;
            if (Array.isArray(u.series)) ui.series = u.series.filter(s => typeof s === 'string');
        } catch (e) { /* ignore */ }
    }

    function save() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(state));
            localStorage.setItem(UI_KEY, JSON.stringify({ tab: ui.tab, series: ui.series }));
        } catch (e) {
            toast('Could not save — browser storage is unavailable or full.');
        }
    }

    function commit() {
        save();
        render();
    }

    /* ── Accessors ─────────────────────────────────────────── */

    const cat = id => state.categories.find(c => c.id === id);
    const scenario = () => (ui.plan === 'base' ? null : state.scenarios.find(s => s.id === ui.plan) || null);
    const basePlan = () => state.weeks[ui.week] || null;
    const activePlan = () => (scenario() ? scenario().plan : basePlan());

    function editablePlan() {
        const s = scenario();
        if (s) return s.plan;
        if (!state.weeks[ui.week]) state.weeks[ui.week] = TB.emptyPlan();
        return state.weeks[ui.week];
    }

    const budget = plan => TB.computeBudget(plan || TB.emptyPlan(), state.categories);

    function findActivity(id) {
        const p = activePlan();
        return p ? p.activities.find(a => a.id === id) : null;
    }

    /** Latest stored non-empty week before `key`. */
    function previousWeekWithData(key) {
        return Object.keys(state.weeks).filter(k => k < key && budget(state.weeks[k]).used > 0).sort().pop() || null;
    }

    /* ── Formatting ────────────────────────────────────────── */

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function signed(n) {
        const r = TB.round2(n);
        if (r === 0) return '±0';
        return (r > 0 ? '+' : '−') + H(Math.abs(r));
    }

    function deltaClass(n) {
        const r = TB.round2(n);
        return r > 0 ? 'delta-up' : r < 0 ? 'delta-down' : 'delta-zero';
    }

    function fmtDate(d) { return MON[d.getMonth()] + ' ' + d.getDate(); }

    function weekTitle(key) {
        const cur = TB.weekKey(new Date());
        if (key === cur) return 'This Week';
        if (key === TB.shiftWeek(cur, -1)) return 'Last Week';
        if (key === TB.shiftWeek(cur, 1)) return 'Next Week';
        return 'Week of ' + fmtDate(TB.parseWeekKey(key));
    }

    function weekRange(key) {
        const s = TB.parseWeekKey(key);
        const e = new Date(s);
        e.setDate(e.getDate() + 6);
        return (fmtDate(s) + ' – ' + fmtDate(e)).toUpperCase();
    }

    function dayDate(i) {
        const d = TB.parseWeekKey(ui.week);
        d.setDate(d.getDate() + i);
        return d;
    }

    function timeRange(a) {
        return TB.formatTime(a.start) + '–' + TB.formatTime(a.end);
    }

    function typeOf(a) {
        const c = cat(a.categoryId);
        return c ? TB.effectiveType(a, c) : 'flexible';
    }

    function statusLabel(c) {
        if (c.status === 'none') return 'No target';
        if (c.status === 'below') return 'Below';
        if (c.status === 'above') return 'Above';
        return c.target !== null ? 'On target' : 'Met';
    }

    function limitText(c) {
        const parts = [];
        if (c.min !== null) parts.push('min ' + H(c.min));
        if (c.target !== null) parts.push('target ' + H(c.target));
        if (c.max !== null) parts.push('max ' + H(c.max));
        return parts.join(' · ');
    }

    /* ── Render root ───────────────────────────────────────── */

    function render() {
        if (ui.plan !== 'base' && !scenario()) ui.plan = 'base';

        // Preserve focus/caret across full re-renders (live inputs).
        const act = document.activeElement;
        const fk = act && act.dataset ? act.dataset.fk : null;
        const caret = fk && typeof act.selectionStart === 'number' ? [act.selectionStart, act.selectionEnd] : null;
        const typed = fk && act.tagName === 'INPUT' ? act.value : null;   // keep partial input like "1."
        const typedBorder = fk && act.tagName === 'INPUT' ? act.style.borderColor : '';
        const scroller = $('.cal-scroll');
        const calScroll = scroller ? scroller.scrollTop : null;

        renderHeader();
        renderBanner();
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === ui.tab));
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + ui.tab));
        const views = { overview: renderOverview, schedule: renderSchedule, budget: renderBudget, scenarios: renderScenarios, whatif: renderWhatIf, history: renderHistory };
        (views[ui.tab] || renderOverview)();

        if (fk) {
            const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
            if (el) {
                if (typed !== null) { el.value = typed; el.style.borderColor = typedBorder; }
                el.focus();
                if (caret) try { el.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text input */ }
            }
        }
        const sc = $('.cal-scroll');
        if (sc) sc.scrollTop = calScroll !== null ? calScroll : 6 * HOUR_PX;
    }

    function renderHeader() {
        $('#week-title').textContent = weekTitle(ui.week);
        $('#week-range').textContent = weekRange(ui.week);
        $('#btn-today').classList.toggle('hidden', ui.week === TB.weekKey(new Date()));
        const sel = $('#plan-select');
        sel.innerHTML = '<option value="base">Base week</option>' +
            (state.scenarios.length ? '<optgroup label="Scenarios">' + state.scenarios.map(s => `<option value="${esc(s.id)}">◆ ${esc(s.name)}</option>`).join('') + '</optgroup>' : '') +
            '<option value="__new">+ New scenario…</option>';
        sel.value = ui.plan;
        sel.classList.toggle('is-scenario', ui.plan !== 'base');
    }

    function renderBanner() {
        const s = scenario();
        let html = '';
        if (s) {
            html = `<div class="banner scenario"><span>◆ <b>SCENARIO: ${esc(s.name)}</b> — a hypothetical copy. Edits here never change your base week (compared against ${esc(weekTitle(ui.week).toLowerCase())}).</span>
                <span class="spacer"></span>
                <button class="btn sm" data-action="goto-compare" data-id="${esc(s.id)}">Compare</button>
                <button class="btn sm" data-action="exit-scenario">Back to base week</button></div>`;
        } else if (!basePlan()) {
            const prev = previousWeekWithData(ui.week);
            html = `<div class="banner info"><span><b>No plan for ${esc(weekTitle(ui.week).toLowerCase())} yet.</b> All 168 h are unallocated.</span><span class="spacer"></span>
                ${prev ? `<button class="btn sm primary" data-action="copy-week" data-from="${prev}">Copy week of ${esc(fmtDate(TB.parseWeekKey(prev)))}</button>` : ''}
                <button class="btn sm" data-action="start-empty">Start empty</button></div>`;
        } else if (state.meta.demoNotice) {
            html = `<div class="banner info"><span>Demo week loaded — it reproduces the reference example (114 h fixed, 54 h discretionary, fully allocated). Edit it or clear it to start fresh.</span><span class="spacer"></span>
                <button class="btn sm" data-action="clear-week">Clear this week</button>
                <button class="btn sm ghost" data-action="dismiss-demo">Dismiss</button></div>`;
        }
        $('#banner').innerHTML = html;
    }

    /* ── Overview ──────────────────────────────────────────── */

    function renderOverview() {
        const B = budget(activePlan());
        const s = scenario();
        const base = s ? budget(basePlan()) : null;
        $('#view-overview').innerHTML = `
            <div class="grid overview-grid">
                <div class="col">
                    <div class="panel">${heroHtml(B, base)}</div>
                    ${kpisHtml(B, base)}
                    <div class="panel">
                        <div class="panel-hd"><span class="panel-title">Where the 168 hours go</span><span class="panel-note">Hover a segment for detail</span></div>
                        ${weekBarHtml(B)}
                        ${discBarHtml(B)}
                    </div>
                    <div class="panel">
                        <div class="panel-hd"><span class="panel-title">Calendar load by day</span><span class="panel-note">${unscheduledTotal(B) ? H(unscheduledTotal(B)) + ' h budgeted without a time slot' : 'Scheduled blocks only'}</span></div>
                        ${dayLoadHtml(B)}
                    </div>
                </div>
                <div class="col">
                    ${problemsHtml(B)}
                    <div class="panel insights">
                        <div class="panel-hd"><span class="panel-title">Allocation insights</span></div>
                        <ul>${TB.insights(B).map(i => `<li class="insight ${i.tone}"><span class="ic">${{ info: 'i', good: '✓', warn: '!', bad: '▲' }[i.tone]}</span><span>${esc(i.text)}</span></li>`).join('')}</ul>
                    </div>
                    ${targetsHtml(B)}
                </div>
            </div>`;
    }

    function unscheduledTotal(B) {
        return B.categories.reduce((t, c) => t + c.adjust, 0);
    }

    function heroHtml(B, base) {
        const cls = B.state === 'over' ? 'over' : B.state === 'full' ? 'full' : '';
        const label = B.state === 'over' ? 'Hours over-allocated' : 'Hours available';
        const value = B.state === 'over' ? '−' + H(B.overallocated) : H(B.unallocated);
        const pill = { under: 'Room to spare', full: 'Fully allocated', over: 'Over-allocated' }[B.state];
        const pillIc = { under: '●', full: '■', over: '▲' }[B.state];
        return `<div class="hero">
            <div>
                <div class="hero-num ${cls}">${value}</div>
                <div class="hero-label">${label}</div>
                <div class="hero-sub">of <span class="num">${H(B.discretionary)}</span> h discretionary · <span class="num">${H(B.fixed)}</span> h fixed · <span class="num">168</span> h week</div>
                ${base ? `<div class="hero-delta ${deltaClass(B.balance - base.balance)}">${signed(B.balance - base.balance)} h vs base week</div>` : ''}
            </div>
            <span class="status-pill ${B.state}">${pillIc} ${pill}</span>
        </div>`;
    }

    function kpisHtml(B, base) {
        const k = (label, v, extra, key, alert) => {
            const d = base && key ? `<span class="${deltaClass(B[key] - base[key])}">${signed(B[key] - base[key])} vs base</span>` : `<span class="op">${extra}</span>`;
            return `<div class="kpi${alert ? ' alert' : ''}"><div class="k">${label}</div><div class="v">${v}<small>h</small></div><div class="d">${d}</div></div>`;
        };
        return `<div class="kpis">
            ${k('Total', 168, 'fixed budget', null)}
            ${k('Fixed', H(B.fixed), 'commitments', 'fixed')}
            ${k('Discretionary', H(B.discretionary), '= 168 − ' + H(B.fixed), 'discretionary', B.discretionary < 0)}
            ${k('Allocated', H(B.allocated), B.pctAllocated !== null ? Math.round(B.pctAllocated * 100) + '% of discr.' : '—', 'allocated')}
            ${k('Unallocated', H(B.unallocated), '= ' + H(B.discretionary) + ' − ' + H(B.allocated), 'unallocated')}
            ${k('Over-allocated', H(B.overallocated), B.overallocated > 0 ? 'exceeds 168 h' : 'none', 'overallocated', B.overallocated > 0)}
        </div>`;
    }

    function seg(pct, color, label, tip, cls) {
        // Full label on wide segments, just the hours on medium ones, nothing on slivers.
        const text = pct >= 13 ? label : pct >= 4 ? label.split(' ').pop() : '';
        return `<div class="seg ${cls || ''}" style="flex:0 0 calc(${pct}% - 2px);${color ? 'background:' + color : ''}" data-tip="${esc(tip)}">${text ? `<span class="seg-label">${esc(text)}</span>` : ''}</div>`;
    }

    function legendItem(sw, name, hours) {
        return `<div class="legend-item">${sw}<span class="name">${esc(name)}</span><span class="num">${H(hours)}</span></div>`;
    }

    function weekBarHtml(B) {
        const scale = Math.max(168, B.fixed + Math.max(0, B.discretionary));
        const fixedCats = B.categories.filter(c => c.fixedMin > 0);
        let segs = fixedCats.map(c => seg(c.fixedHours / scale * 100, c.color, `${c.name} ${H(c.fixedHours)}`, `${c.name} · ${H(c.fixedHours)} h fixed · ${Math.round(c.fixedHours / 168 * 100)}% of week`)).join('');
        if (B.discretionary > 0) {
            segs += seg(B.discretionary / scale * 100, null, `Discretionary ${H(B.discretionary)}`, `Discretionary · ${H(B.discretionary)} h = 168 − ${H(B.fixed)} fixed`, 'group-disc');
        }
        const over = scale > 168 ? `<div class="seg overflow" style="position:absolute;left:${168 / scale * 100}%;right:0;top:0;bottom:0" data-tip="Fixed commitments exceed the week by ${H(B.fixed - 168)} h"></div>` : '';
        const limit = scale > 168 ? `<div class="bar-limit" style="left:${168 / scale * 100}%" data-label="168 h"></div>` : '';
        return `<div class="alloc">
            <div class="alloc-hd"><b>Week · 168 h</b><span class="num">${B.fixedExceedsWeek ? H(B.fixed) + ' fixed — ' + H(B.fixed - 168) + ' over the │ 168 h limit' : H(B.fixed) + ' fixed + ' + H(B.discretionary) + ' discretionary'}</span></div>
            <div class="bar">${segs}${over}${limit}</div>
            <div class="bar-scale"><span>0</span><span>${H(scale / 2)}</span><span>${H(scale)} h</span></div>
            <div class="legend">${fixedCats.map(c => legendItem(`<span class="sw" style="background:${c.color}"></span>`, c.name, c.fixedHours)).join('')}
                ${legendItem('<span class="sw disc"></span>', 'Discretionary', B.discretionary)}</div>
        </div>`;
    }

    function discBarHtml(B) {
        const disc = Math.max(0, B.discretionary);
        const scale = Math.max(disc, B.allocated) || 1;
        const flexCats = B.categories.filter(c => c.flexibleMin > 0);
        let segs = flexCats.map(c => seg(c.flexibleHours / scale * 100, c.color, `${c.name} ${H(c.flexibleHours)}`,
            `${c.name} · ${H(c.flexibleHours)} h · ${disc > 0 ? Math.round(c.flexibleHours / disc * 100) + '% of discretionary' : 'no discretionary time'}`)).join('');
        if (B.unallocated > 0) segs += seg(B.unallocated / scale * 100, null, `Unallocated ${H(B.unallocated)}`, `Unallocated · ${H(B.unallocated)} h still free to budget`, 'unalloc');
        const overlay = B.overallocated > 0 && B.allocated > 0
            ? `<div class="seg overflow" style="position:absolute;left:${disc / scale * 100}%;right:0;top:0;bottom:0" data-tip="Over-allocated · ${H(B.overallocated)} h beyond the ${H(disc)} h available"><span class="seg-label">${(B.overallocated / scale) >= 0.07 ? 'OVER ' + H(B.overallocated) : ''}</span></div>
               <div class="bar-limit" style="left:${disc / scale * 100}%" data-label="${H(disc)} h"></div>`
            : '';
        const empty = !flexCats.length && B.unallocated <= 0 && !overlay ? '<div class="muted" style="font-size:12px;padding:6px">No discretionary time available.</div>' : '';
        return `<div class="alloc">
            <div class="alloc-hd"><b>Discretionary · ${H(B.discretionary)} h</b><span class="num">${H(B.allocated)} allocated · ${B.state === 'over' ? H(B.overallocated) + ' over the │ ' + H(disc) + ' h limit' : H(B.unallocated) + ' free'}</span></div>
            <div class="bar">${segs}${overlay}${empty}</div>
            <div class="bar-scale"><span>0</span><span>${H(scale / 2)}</span><span>${H(scale)} h</span></div>
            <div class="legend">${flexCats.map(c => legendItem(`<span class="sw" style="background:${c.color}"></span>`, c.name, c.flexibleHours)).join('')}
                ${B.unallocated > 0 ? legendItem('<span class="sw unalloc"></span>', 'Unallocated', B.unallocated) : ''}
                ${B.overallocated > 0 ? legendItem('<span class="sw overflow"></span>', 'Over-allocated', B.overallocated) : ''}</div>
        </div>`;
    }

    function dayLoadHtml(B) {
        return `<div class="dayload">${B.byDay.map((h, i) => {
            const over = h > 24;
            const pct = Math.min(100, h / 24 * 100);
            return `<div class="dcol" data-tip="${TB.DAYS[i]} · ${H(h)} h scheduled of 24">
                <span class="dv ${over ? 'delta-down' : ''}">${H(h)}</span>
                <div class="dbar${over ? ' over' : ''}" style="height:100%"><div class="dfill" style="height:${pct}%;${over ? 'background:var(--bad)' : ''}"></div></div>
                <span class="dl">${TB.DAYS_SHORT[i]}</span></div>`;
        }).join('')}</div>`;
    }

    function problemsHtml(B) {
        if (!B.problems.length) return '';
        const clashes = B.overlaps.slice(0, 8).map(o =>
            `<button data-action="edit-act" data-id="${esc(o.aId)}">${TB.DAYS_SHORT[o.day]} ${TB.formatTime(o.start)}–${TB.formatTime(o.end)} · ${esc(o.aName)} ↔ ${esc(o.bName)} (${H(o.minutes / 60)} h)</button>`).join('');
        return `<div class="panel problems">
            <div class="panel-hd"><span class="panel-title">▲ Constraint check</span></div>
            <ul>${B.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
            ${clashes ? `<div class="clash-list"><span class="muted">Overlaps (click to edit):</span>${clashes}${B.overlaps.length > 8 ? `<span class="faint">+${B.overlaps.length - 8} more</span>` : ''}</div>` : ''}
        </div>`;
    }

    function targetsHtml(B) {
        const withT = B.categories.filter(c => c.status !== 'none');
        const without = B.categories.length - withT.length;
        const rows = withT.map(c => {
            const goal = c.target !== null ? c.target : c.min !== null ? c.min : c.max;
            const scale = Math.max(c.hours, goal || 0, c.max || 0) * 1.15 || 1;
            let val = `${H(c.hours)} / ${H(goal)}`;
            if (c.min !== null && c.max !== null && c.target === null) val = `${H(c.hours)} · ${H(c.min)}–${H(c.max)}`;
            return `<div class="target-row" data-tip="${esc(c.name)} · ${H(c.hours)} h · ${esc(limitText(c))}">
                <div class="nm"><span class="sw" style="background:${c.color}"></span><span>${esc(c.name)}</span><span class="chip ${c.status}">${statusLabel(c)}</span></div>
                <div class="val">${val} h</div>
                <div class="target-track"><div class="target-fill" style="width:${c.hours / scale * 100}%;background:${c.color}"></div>
                    ${goal !== null ? `<div class="target-mark" style="left:${goal / scale * 100}%"></div>` : ''}
                    ${c.max !== null && c.max !== goal ? `<div class="target-mark" style="left:${c.max / scale * 100}%;opacity:.5"></div>` : ''}</div>
            </div>`;
        }).join('');
        return `<div class="panel">
            <div class="panel-hd"><span class="panel-title">Targets</span><button class="btn sm ghost" data-tab-go="budget">Edit targets</button></div>
            ${rows ? `<div class="targets">${rows}</div>` : '<div class="muted" style="font-size:13px">No targets set yet.</div>'}
            ${without ? `<div class="panel-note" style="margin-top:12px">${without} categor${without === 1 ? 'y has' : 'ies have'} no target — that's fine; targets are optional.</div>` : ''}
        </div>`;
    }

    /* ── Schedule ──────────────────────────────────────────── */

    /** Split activities into per-day visual pieces (midnight-crossing blocks become two). */
    function pieces(plan) {
        const out = [];
        (plan ? plan.activities : []).forEach(a => {
            TB.segments(a).forEach(([s, e]) => {
                let t = s;
                while (t < e) {
                    const d = Math.floor(t / TB.DAY_MIN);
                    const end = Math.min(e, (d + 1) * TB.DAY_MIN);
                    out.push({ a, day: d, start: t - d * TB.DAY_MIN, end: end - d * TB.DAY_MIN, cont: t !== a.day * TB.DAY_MIN + a.start });
                    t = end;
                }
            });
        });
        return out;
    }

    /** Side-by-side lanes for overlapping pieces within a day. */
    function layoutLanes(list) {
        list.sort((x, y) => x.start - y.start || y.end - x.end);
        let cluster = [];
        let lanes = [];
        let clusterEnd = -1;
        const flush = () => { cluster.forEach(p => { p.lanes = lanes.length; }); cluster = []; lanes = []; };
        list.forEach(p => {
            if (p.start >= clusterEnd) { flush(); clusterEnd = -1; }
            let lane = lanes.findIndex(end => end <= p.start);
            if (lane === -1) { lane = lanes.length; lanes.push(p.end); } else lanes[lane] = p.end;
            p.lane = lane;
            cluster.push(p);
            clusterEnd = Math.max(clusterEnd, p.end);
        });
        flush();
        return list;
    }

    function renderSchedule() {
        const plan = activePlan();
        const B = budget(plan);
        const clashIds = new Set(B.overlaps.flatMap(o => [o.aId, o.bId]));
        const all = pieces(plan);
        const byDay = [0, 1, 2, 3, 4, 5, 6].map(d => layoutLanes(all.filter(p => p.day === d)));
        const todayKey = TB.weekKey(new Date());
        const isThisWeek = ui.week === todayKey;
        const scheduled = B.categories.reduce((t, c) => t + c.scheduled, 0);

        const blockHtml = p => {
            const c = cat(p.a.categoryId);
            const top = p.start / 60 * HOUR_PX;
            const height = Math.max((p.end - p.start) / 60 * HOUR_PX - 2, 14);
            const w = 100 / p.lanes;
            const dur = TB.durationMin(p.a.start, p.a.end) / 60;
            const flex = typeOf(p.a) === 'flexible';
            const clash = clashIds.has(p.a.id);
            const tip = `${p.a.name} · ${c.name} · ${flex ? 'flexible' : 'fixed'}\n${TB.DAYS_SHORT[p.a.day]} ${timeRange(p.a)} · ${H(dur)} h${clash ? ' · overlaps another block' : ''}`;
            return `<div class="block${flex ? ' flex' : ''}${clash ? ' clash' : ''}" data-action="edit-act" data-id="${esc(p.a.id)}" data-tip="${esc(tip)}"
                style="--c:${c.color};top:${top}px;height:${height}px;left:calc(${p.lane * w}% + 2px);width:calc(${w}% - 4px)">
                <div class="bn">${clash ? '<span class="warn-ic">⚠ </span>' : ''}${p.cont ? '↪ ' : ''}${esc(p.a.name)}</div>
                ${height > 26 ? `<div class="bt">${timeRange(p.a)} · ${H(dur)}h</div>` : ''}
            </div>`;
        };

        const calendar = `<div class="calendar">
            <div class="cal-head"><div></div>${TB.DAYS_SHORT.map((d, i) => {
                const over = B.byDay[i] > 24;
                return `<div class="${isThisWeek && i === todayIdx ? 'today' : ''}"><b>${d} ${dayDate(i).getDate()}</b><span class="${over ? 'over' : ''}">${H(B.byDay[i])} h</span></div>`;
            }).join('')}</div>
            <div class="cal-scroll"><div class="cal-body" style="--hour:${HOUR_PX}px">
                <div class="cal-hours">${Array.from({ length: 24 }, (_, h) => `<div>${String(h).padStart(2, '0')}:00</div>`).join('')}</div>
                ${byDay.map((list, i) => `<div class="cal-day${isThisWeek && i === todayIdx ? ' today' : ''}" data-day="${i}" style="height:${24 * HOUR_PX}px">${list.map(blockHtml).join('')}</div>`).join('')}
            </div></div>
        </div>`;

        const dayList = byDay[ui.agendaDay];
        const agenda = `<div class="agenda">
            <div class="day-pills">${TB.DAYS_SHORT.map((d, i) => `<button class="day-pill${i === ui.agendaDay ? ' active' : ''}${B.byDay[i] > 24 ? ' over' : ''}" data-action="agenda-day" data-day="${i}"><b>${d}</b><span>${H(B.byDay[i])}h</span></button>`).join('')}</div>
            <div class="agenda-list">${dayList.length ? dayList.map(p => {
                const c = cat(p.a.categoryId);
                const flex = typeOf(p.a) === 'flexible';
                return `<button class="agenda-item${clashIds.has(p.a.id) ? ' clash' : ''}" style="--c:${c.color}" data-action="edit-act" data-id="${esc(p.a.id)}">
                    <span class="t">${p.cont ? '↪ ' : ''}${TB.formatTime(p.start)}–${TB.formatTime(p.end)}</span>
                    <span style="min-width:0"><span class="n" style="display:block">${clashIds.has(p.a.id) ? '⚠ ' : ''}${esc(p.a.name)}</span><span class="c">${esc(c.name)} · ${flex ? 'flexible' : 'fixed'}</span></span>
                    <span class="h">${H(TB.durationMin(p.a.start, p.a.end) / 60)}h</span></button>`;
            }).join('') : `<div class="empty"><b>Nothing scheduled on ${TB.DAYS[ui.agendaDay]}</b>Tap “Add activity” to block out time.</div>`}</div>
        </div>`;

        const unsched = B.categories.filter(c => c.adjustMin !== 0);
        $('#view-schedule').innerHTML = `
            <div class="sched-toolbar">
                <button class="btn primary" data-action="new-act">+ Add activity</button>
                <div class="key sched-key-desktop"><span><i class="k-fixed"></i>Fixed</span><span><i class="k-flex"></i>Flexible</span><span><i class="k-clash"></i>Overlap</span><span>↪ continues past midnight</span></div>
                <span class="spacer"></span>
                <span class="muted num" style="font-size:12px">${B.activityCount} blocks · ${H(scheduled)} h scheduled</span>
            </div>
            ${B.problems.length ? `<div class="banner" style="border-color:rgba(255,92,92,.45);background:var(--bad-bg);color:#ffc2c2">▲ ${esc(B.problems[0])}${B.problems.length > 1 ? ` <button class="btn sm" data-tab-go="overview">See all ${B.problems.length}</button>` : ''}</div>` : ''}
            ${calendar}${agenda}
            <div class="unsched-note">${unsched.length
                ? `Also budgeted without a time slot: ${unsched.map(c => `<b>${esc(c.name)} ${signed(c.adjust)} h</b>`).join(' · ')}. <button class="btn sm ghost" data-tab-go="budget">Edit in Budget</button>`
                : 'Tip: categories you don’t want to schedule block-by-block (meals, commute) can be budgeted as unscheduled hours in Budget & Targets.'}</div>`;
    }

    /* ── Budget & targets ──────────────────────────────────── */

    function renderBudget() {
        const B = budget(activePlan());
        const groups = [['fixed', 'Fixed commitments'], ['flexible', 'Flexible / discretionary']];
        const plan = activePlan();
        const adjInput = c => {
            const raw = plan && plan.adjust[c.id];
            return `<input class="input sm num" inputmode="decimal" data-input="adjust" data-cat="${esc(c.id)}" data-fk="adj-${esc(c.id)}" value="${raw ? H(raw) : ''}" placeholder="0" aria-label="Unscheduled hours for ${esc(c.name)}">`;
        };
        const rows = groups.map(([type, label]) => {
            const cs = B.categories.filter(c => c.type === type);
            const total = cs.reduce((t, c) => t + c.hours, 0);
            return `<tr class="group"><td colspan="9">${label}</td></tr>` + cs.map(c => `
                <tr>
                    <td><div class="cat-name"><span class="sw" style="background:${c.color}"></span>${esc(c.name)}${c.athletic ? ' <span class="faint" title="Counts toward athletics">⚑</span>' : ''}</div></td>
                    <td class="r num">${H(c.scheduled)}</td>
                    <td class="r">${adjInput(c)}</td>
                    <td class="r num"><b>${H(c.hours)}</b>${c.fixedMin && c.flexibleMin ? `<div class="faint" style="font-size:10.5px">${H(c.fixedHours)} fx / ${H(c.flexibleHours)} flex</div>` : ''}</td>
                    <td class="r num">${c.min !== null ? H(c.min) : '<span class="faint">—</span>'}</td>
                    <td class="r num">${c.target !== null ? H(c.target) : '<span class="faint">—</span>'}</td>
                    <td class="r num">${c.max !== null ? H(c.max) : '<span class="faint">—</span>'}</td>
                    <td><span class="chip ${c.status}">${statusLabel(c)}</span>${c.toGoal > 0 ? ` <span class="faint num" style="font-size:11px">+${H(c.toGoal)}</span>` : ''}</td>
                    <td class="r"><button class="btn sm ghost" data-action="edit-cat" data-id="${esc(c.id)}">Edit</button></td>
                </tr>`).join('') + `<tr class="total"><td>Total ${type}</td><td></td><td></td><td class="r num">${H(total)}</td><td colspan="5"></td></tr>`;
        }).join('');

        const cards = groups.map(([type, label]) => `<div class="panel-title" style="margin:8px 0 2px">${label}</div>` + B.categories.filter(c => c.type === type).map(c => `
            <div class="bcard">
                <div class="bcard-top"><span class="sw" style="background:${c.color}"></span><span class="n">${esc(c.name)}</span><span class="chip ${c.status}">${statusLabel(c)}</span><span class="h">${H(c.hours)}h</span></div>
                <div class="bcard-meta">
                    <label class="field"><span>Unscheduled ±h</span>${adjInput(c).replace(`data-fk="adj-`, `data-fk="adjm-`)}</label>
                    <div style="font-size:12px" class="muted">${H(c.scheduled)} h on calendar${limitText(c) ? '<br>' + esc(limitText(c)) : ''}</div>
                </div>
                <div style="margin-top:8px;text-align:right"><button class="btn sm" data-action="edit-cat" data-id="${esc(c.id)}">Edit category</button></div>
            </div>`).join('')).join('');

        $('#view-budget').innerHTML = `
            <div class="panel">
                <div class="panel-hd">
                    <div><div class="panel-title">Budget &amp; targets</div>
                    <div class="panel-note" style="margin-top:4px">Total = calendar blocks + unscheduled hours. Negative unscheduled hours trim a category (handy in scenarios). Targets are optional and informational.</div></div>
                    <button class="btn primary" data-action="new-cat">+ Add category</button>
                </div>
                <div class="table-wrap budget-table"><table class="data">
                    <thead><tr><th>Category</th><th class="r">Scheduled</th><th class="r">Unscheduled ±</th><th class="r">Total h</th><th class="r">Min</th><th class="r">Target</th><th class="r">Max</th><th>Status</th><th></th></tr></thead>
                    <tbody>${rows}</tbody>
                </table></div>
                <div class="budget-cards">${cards}</div>
                <div class="table-wrap" style="margin-top:18px"><table class="data">
                    <tbody>
                        <tr><td>Total weekly hours</td><td class="r num">168</td></tr>
                        <tr><td>Fixed commitments</td><td class="r num">${H(B.fixed)}</td></tr>
                        <tr><td>Discretionary <span class="faint">= 168 − fixed</span></td><td class="r num">${H(B.discretionary)}</td></tr>
                        <tr><td>Allocated discretionary</td><td class="r num">${H(B.allocated)}</td></tr>
                        <tr class="total${B.state === 'over' ? ' alert' : ''}"><td>${B.state === 'over' ? 'Over-allocated' : 'Unallocated'} <span class="faint">= discretionary − allocated</span></td><td class="r num">${B.state === 'over' ? '−' + H(B.overallocated) : H(B.unallocated)}</td></tr>
                    </tbody>
                </table></div>
            </div>`;
    }

    /* ── Scenarios ─────────────────────────────────────────── */

    function renderScenarios() {
        const baseB = budget(basePlan());
        if (!ui.compareId || !state.scenarios.some(s => s.id === ui.compareId)) {
            ui.compareId = scenario() ? scenario().id : (state.scenarios[0] ? state.scenarios[0].id : null);
        }
        const list = state.scenarios.map(s => {
            const b = budget(s.plan);
            const active = ui.plan === s.id;
            return `<div class="scen-card${active ? ' active' : ''}">
                <div class="top"><b>◆ ${esc(s.name)}</b><span class="status-pill ${b.state}" style="font-size:11px">${b.state === 'over' ? '−' + H(b.overallocated) + ' h over' : H(b.unallocated) + ' h free'}</span></div>
                <div class="muted num" style="font-size:12px">Fixed ${H(b.fixed)} · Discr. ${H(b.discretionary)} · Alloc. ${H(b.allocated)} <span class="${deltaClass(b.balance - baseB.balance)}">(${signed(b.balance - baseB.balance)} vs base)</span></div>
                <div class="actions">
                    ${active ? '<button class="btn sm" data-action="exit-scenario">Close</button>' : `<button class="btn sm" data-action="open-scenario" data-id="${esc(s.id)}">Open &amp; edit</button>`}
                    <button class="btn sm" data-action="compare" data-id="${esc(s.id)}">Compare</button>
                    <button class="btn sm ghost" data-action="rename-scenario" data-id="${esc(s.id)}">Rename</button>
                    <button class="btn sm ghost" data-action="apply-scenario" data-id="${esc(s.id)}">Apply to week</button>
                    <button class="btn sm ghost danger" data-action="delete-scenario" data-id="${esc(s.id)}">Delete</button>
                </div>
            </div>`;
        }).join('');

        $('#view-scenarios').innerHTML = `
            <div class="grid scen-grid">
                <div class="col">
                    <div class="panel">
                        <div class="panel-hd"><span class="panel-title">New scenario</span></div>
                        <p class="panel-note" style="margin-bottom:12px">A scenario starts as a copy of ${esc(weekTitle(ui.week).toLowerCase())}'s base plan. Changing it never touches the base week.</p>
                        <div class="new-scen"><input class="input" id="scen-name" placeholder="Scenario name" maxlength="40" data-fk="scen-name"><button class="btn primary" data-action="create-scenario">Create</button></div>
                        <div class="presets">${PRESETS.map(p => `<button class="preset" data-action="create-scenario" data-name="${esc(p)}">${esc(p)}</button>`).join('')}</div>
                    </div>
                    <div class="panel">
                        <div class="panel-hd"><span class="panel-title">Your scenarios</span><span class="panel-note">${state.scenarios.length}</span></div>
                        ${list ? `<div class="scen-list">${list}</div>` : '<div class="empty"><b>No scenarios yet</b>Create an Exam Week or Tournament Week to test a different allocation.</div>'}
                    </div>
                </div>
                <div class="col">${compareHtml(baseB)}</div>
            </div>`;
    }

    function compareHtml(baseB) {
        const s = state.scenarios.find(x => x.id === ui.compareId);
        if (!s) return '<div class="panel"><div class="panel-hd"><span class="panel-title">Base vs scenario</span></div><div class="empty"><b>Nothing to compare yet</b>Create a scenario to see it side by side with your base week.</div></div>';
        const sb = budget(s.plan);
        const cmp = TB.compareBudgets(baseB, sb);
        const maxAbs = Math.max(1, ...cmp.rows.map(r => Math.abs(r.delta)));
        const row = r => {
            const w = Math.abs(r.delta) / maxAbs * 50;
            return `<tr>
                <td><div class="cat-name"><span class="sw" style="background:${r.color}"></span>${esc(r.name)}</div></td>
                <td class="r num">${H(r.base)}</td>
                <td class="r"><input class="input sm num" inputmode="decimal" data-input="scen-hours" data-scen="${esc(s.id)}" data-cat="${esc(r.id)}" data-fk="sh-${esc(r.id)}" value="${H(r.scenario)}" aria-label="${esc(r.name)} hours in ${esc(s.name)}"></td>
                <td class="r num ${deltaClass(r.delta)}">${signed(r.delta)}</td>
                <td class="hide-sm"><div class="delta-bar">${r.delta ? `<i class="${r.delta > 0 ? 'pos' : 'neg'}" style="width:${w}%"></i>` : ''}</div></td>
            </tr>`;
        };
        const trow = (label, k, neg) => {
            const t = cmp.totals[k];
            const f = v => neg && v < 0 ? '−' + H(-v) : H(v);
            return `<tr class="total"><td>${label}</td><td class="r num">${f(t.base)}</td><td class="r num">${f(t.scenario)}</td><td class="r num ${deltaClass(t.delta)}">${signed(t.delta)}</td><td class="hide-sm"></td></tr>`;
        };
        const byType = type => cmp.rows.filter(r => r.type === type && (r.base || r.scenario));
        return `<div class="panel">
            <div class="panel-hd">
                <span class="panel-title">Base vs scenario</span>
                <select class="select" style="width:auto" data-input="compare-select" aria-label="Scenario to compare">${state.scenarios.map(x => `<option value="${esc(x.id)}"${x.id === s.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
            </div>
            <div class="ba">
                <div class="kpi"><div class="k">Base available</div><div class="v ${baseB.state === 'over' ? 'delta-down' : ''}">${baseB.state === 'over' ? '−' + H(baseB.overallocated) : H(baseB.unallocated)}<small>h</small></div></div>
                <div class="kpi"><div class="k">${esc(s.name)}</div><div class="v" style="color:${sb.state === 'over' ? 'var(--bad)' : 'var(--good)'}">${sb.state === 'over' ? '−' + H(sb.overallocated) : H(sb.unallocated)}<small>h</small></div></div>
                <div class="kpi"><div class="k">Δ Fixed</div><div class="v ${deltaClass(cmp.totals.fixed.delta)}">${signed(cmp.totals.fixed.delta)}</div></div>
                <div class="kpi"><div class="k">Δ Allocated</div><div class="v ${deltaClass(cmp.totals.allocated.delta)}">${signed(cmp.totals.allocated.delta)}</div></div>
            </div>
            ${sb.problems.length ? `<div class="banner" style="border-color:rgba(255,92,92,.45);background:var(--bad-bg);color:#ffc2c2">▲ ${esc(sb.problems[0])}</div>` : ''}
            <p class="panel-note" style="margin-bottom:8px">Type new hours in the scenario column to see the allocation change instantly. Hours you type are stored as unscheduled adjustments in the scenario only.</p>
            <div class="table-wrap"><table class="data">
                <thead><tr><th>Category</th><th class="r">Base</th><th class="r">${esc(s.name)}</th><th class="r">Δ h</th><th class="hide-sm"></th></tr></thead>
                <tbody>
                    <tr class="group"><td colspan="5">Fixed</td></tr>${byType('fixed').map(row).join('')}
                    <tr class="group"><td colspan="5">Flexible</td></tr>${byType('flexible').map(row).join('')}
                    ${trow('Fixed total', 'fixed')}
                    ${trow('Discretionary (168 − fixed)', 'discretionary', true)}
                    ${trow('Allocated', 'allocated')}
                    ${trow('Available (− = over)', 'balance', true)}
                </tbody>
            </table></div>
            <div class="panel-note" style="margin-top:10px">Categories with 0 h in both plans are hidden. Open the scenario to add them.</div>
        </div>`;
    }

    /** Set a category's total hours inside a plan by adjusting its unscheduled hours. */
    function setCategoryTotal(plan, catId, hours) {
        const b = budget(plan);
        const c = b.categories.find(x => x.id === catId);
        if (!c) return;
        const scheduledPart = c.hours - c.adjust;                  // calendar-driven hours
        const nextAdj = TB.round2(hours - scheduledPart);
        if (nextAdj === 0) delete plan.adjust[catId];
        else plan.adjust[catId] = nextAdj;
    }

    function createScenario(name, plan) {
        name = (name || '').trim().slice(0, 40);
        if (!name) { toast('Give the scenario a name.'); return; }
        let final = name;
        let n = 2;
        while (state.scenarios.some(s => s.name.toLowerCase() === final.toLowerCase())) final = `${name} (${n++})`;
        const s = { id: TB.uid('scn'), name: final, plan: TB.sanitizePlan(TB.clone(plan || basePlan() || TB.emptyPlan()), state.categories), createdAt: new Date().toISOString() };
        state.scenarios.push(s);
        ui.compareId = s.id;
        return s;
    }

    /* ── What-if ───────────────────────────────────────────── */

    function defaultWhatIf() {
        const study = cat('study') || state.categories.find(c => c.type === 'flexible') || state.categories[0];
        return study ? [{ categoryId: study.id, op: 'add', hours: 5 }] : [];
    }

    function validWhatIf() {
        return ui.whatif.filter(w => {
            const n = Number(w.hours);
            return String(w.hours).trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 168;
        });
    }

    function renderWhatIf() {
        if (!ui.whatif) ui.whatif = defaultWhatIf();
        ui.whatif = ui.whatif.filter(w => cat(w.categoryId));
        const plan = activePlan() || TB.emptyPlan();
        const valid = validWhatIf();
        const r = TB.whatIf(plan, state.categories, valid);
        const catOptions = sel => ['fixed', 'flexible'].map(t => `<optgroup label="${t === 'fixed' ? 'Fixed' : 'Flexible'}">${state.categories.filter(c => c.type === t).map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('');

        const rows = ui.whatif.map((w, i) => `<div class="wi-row">
            <span>What if I</span>
            <select class="select" data-input="wi-op" data-i="${i}" aria-label="Operation">${[['add', 'add'], ['remove', 'remove'], ['set', 'set total to']].map(([v, l]) => `<option value="${v}"${w.op === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <input class="input num" inputmode="decimal" data-input="wi-hours" data-i="${i}" data-fk="wi-h-${i}" value="${esc(w.hours)}" aria-label="Hours">
            <span>hours of</span>
            <select class="select" data-input="wi-cat" data-i="${i}" aria-label="Category">${catOptions(w.categoryId)}</select>
            ${ui.whatif.length > 1 ? `<button class="btn sm ghost rm" data-action="wi-remove" data-i="${i}" aria-label="Remove change">✕</button>` : ''}
        </div>`).join('');

        const presets = [
            ['study', 'add', 5, 'Add 5 h of studying'],
            ['practice', 'add', 4, 'Practice +4 h'],
            ['work', 'set', 10, 'Work 10 h this week'],
            ['social', 'remove', 3, 'Cut social by 3 h'],
        ].filter(p => cat(p[0]));

        const a = r.after;
        const b = r.before;
        let verdict;
        if (!valid.length) {
            verdict = '<div class="verdict ok"><h3>Pick a change</h3><p>Enter hours between 0 and 168.</p></div>';
        } else if (r.fits) {
            const net = r.netChange;
            verdict = `<div class="verdict ok"><h3>✓ It fits — ${H(a.unallocated)} h still unallocated</h3>
                <p>${net > 0 ? `This uses ${H(net)} h more of your week${r.absorbedByUnallocated > 0 ? `, absorbed by unallocated time (${H(b.unallocated)} → ${H(a.unallocated)} h)` : ''}. No other category has to change.`
                    : net < 0 ? `This frees ${H(-net)} h (${b.state === 'over' ? 'reduces the over-allocation' : 'unallocated ' + H(b.unallocated) + ' → ' + H(a.unallocated) + ' h'}).` : 'No net change in used time.'}</p></div>`;
        } else {
            verdict = `<div class="verdict no"><h3>▲ Doesn't fit — over by ${H(a.overallocated)} h</h3>
                <p>After this change, fixed ${H(a.fixed)} h + flexible ${H(a.allocated)} h = ${H(a.used)} h, but a week has 168 h.
                ${r.cuts.length ? ' To make room, these flexible categories would have to shrink (largest slack above its minimum first):' : ''}</p>
                ${r.cuts.length ? `<ul class="cuts">${r.cuts.map(c => {
                    const cc = cat(c.id);
                    return `<li><span class="sw" style="background:${cc.color}"></span>${esc(c.name)}${c.breaksMinimum ? ' <span class="chip below">below minimum</span>' : ''}<span class="num">${H(c.from)} → ${H(c.from - c.hours)} h (−${H(c.hours)})</span></li>`;
                }).join('')}</ul>` : ''}
                ${r.unresolved > 0 ? `<p style="margin-top:10px"><b>Even cutting every flexible hour leaves ${H(r.unresolved)} h over</b> — a fixed commitment has to change.</p>` : ''}
            </div>`;
        }

        const kpi = (label, from, to, neg) => {
            const f = v => (neg && v < 0 ? '−' + H(-v) : H(v));
            return `<div class="kpi"><div class="k">${label}</div><div class="v">${f(to)}<small>h</small></div><div class="d"><span class="faint">${f(from)} →</span> <span class="${deltaClass(to - from)}">${signed(to - from)}</span></div></div>`;
        };
        const changed = r.comparison.rows.filter(x => x.delta !== 0);

        $('#view-whatif').innerHTML = `
            <div class="grid wi-grid">
                <div class="col">
                    <div class="panel">
                        <div class="panel-hd"><span class="panel-title">Ask what-if</span><span class="panel-note">Runs on: ${scenario() ? '◆ ' + esc(scenario().name) : 'base week'}</span></div>
                        ${rows}
                        <div class="wi-actions">
                            <button class="btn sm" data-action="wi-add">+ Another change</button>
                            <button class="btn sm ghost" data-action="wi-reset">Reset</button>
                            <span style="flex:1"></span>
                            <button class="btn sm primary" data-action="wi-save" ${valid.length ? '' : 'disabled'}>Save as scenario</button>
                        </div>
                        <div class="panel-title" style="margin:18px 0 8px">Quick questions</div>
                        <div class="presets">${presets.map(p => `<button class="preset" data-action="wi-preset" data-cat="${p[0]}" data-op="${p[1]}" data-hours="${p[2]}">${esc(p[3])}</button>`).join('')}</div>
                        <p class="panel-note" style="margin-top:16px">Deterministic: the change is applied to a copy of the plan and the 168-hour model is recomputed. Nothing is saved unless you click “Save as scenario”.</p>
                    </div>
                </div>
                <div class="col">
                    <div class="panel">
                        ${verdict}
                        <div class="ba">
                            ${kpi('Fixed', b.fixed, a.fixed)}
                            ${kpi('Discretionary', b.discretionary, a.discretionary, true)}
                            ${kpi('Allocated', b.allocated, a.allocated)}
                            ${kpi('Available', b.balance, a.balance, true)}
                        </div>
                        ${changed.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Changed category</th><th class="r">Now</th><th class="r">After</th><th class="r">Δ</th></tr></thead><tbody>
                            ${changed.map(x => `<tr><td><div class="cat-name"><span class="sw" style="background:${x.color}"></span>${esc(x.name)}</div></td><td class="r num">${H(x.base)}</td><td class="r num">${H(x.scenario)}</td><td class="r num ${deltaClass(x.delta)}">${signed(x.delta)}</td></tr>`).join('')}
                        </tbody></table></div>` : ''}
                    </div>
                </div>
            </div>`;
    }

    /* ── History ───────────────────────────────────────────── */

    function seriesDef(id) {
        if (AGG_SERIES[id]) return Object.assign({ id }, AGG_SERIES[id]);
        const c = cat(id);
        return c ? { id, name: c.name, color: c.color } : null;
    }

    function seriesValue(row, id) {
        if (id === 'discretionary' || id === 'allocated' || id === 'athletics') return row[id];
        return row.byCat[id] || 0;
    }

    function renderHistory() {
        const rows = TB.history(state.weeks, state.categories);
        ui.series = ui.series.filter(id => seriesDef(id));
        const allSeries = ['discretionary', 'allocated', 'athletics', ...state.categories.map(c => c.id)];
        const chips = allSeries.map(id => {
            const d = seriesDef(id);
            const on = ui.series.includes(id);
            return `<button class="series-chip${on ? ' on' : ''}" data-action="toggle-series" data-id="${esc(id)}" aria-pressed="${on}"><span class="sw" style="background:${d.color}"></span>${esc(d.name)}</button>`;
        }).join('');

        const table = rows.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>Week of</th><th class="r">Fixed</th><th class="r">Discr.</th><th class="r">Alloc.</th><th class="r">Avail.</th><th class="r">Athletics</th>${['study', 'sleep', 'social'].filter(cat).map(id => `<th class="r">${esc(cat(id).name)}</th>`).join('')}<th></th></tr></thead>
            <tbody>${rows.slice().reverse().map(r => `<tr${r.week === ui.week ? ' style="background:var(--panel-2)"' : ''}>
                <td class="num">${fmtDate(TB.parseWeekKey(r.week))}</td>
                <td class="r num">${H(r.fixed)}</td><td class="r num">${H(r.discretionary)}</td><td class="r num">${H(r.allocated)}</td>
                <td class="r num ${r.balance < 0 ? 'delta-down' : ''}">${r.balance < 0 ? '−' + H(-r.balance) : H(r.balance)}</td>
                <td class="r num">${H(r.athletics)}</td>
                ${['study', 'sleep', 'social'].filter(cat).map(id => `<td class="r num">${H(r.byCat[id] || 0)}</td>`).join('')}
                <td class="r"><button class="btn sm ghost" data-action="goto-week" data-week="${r.week}">Open</button></td>
            </tr>`).join('')}</tbody></table></div>` : '';

        $('#view-history').innerHTML = `
            <div class="panel">
                <div class="panel-hd"><span class="panel-title">Hours per week over time</span><span class="panel-note">${rows.length} week${rows.length === 1 ? '' : 's'} with data · base weeks only</span></div>
                <div class="series-chips">${chips}</div>
                ${rows.length >= 2 ? `<div class="chart" id="hist-chart">${chartSvg(rows)}</div>` : `<div class="empty"><b>History builds as you plan more weeks</b>Each week you plan is stored automatically. Use → to move to next week and copy this week as a starting point.
                    <div class="actions"><button class="btn sm" data-action="sample-history">Load sample history (6 past weeks)</button></div></div>`}
            </div>
            ${table ? `<div class="panel" style="margin-top:16px"><div class="panel-hd"><span class="panel-title">Weekly allocations</span></div>${table}</div>` : ''}`;
        const chart = $('#hist-chart');
        if (chart) wireChart(chart, rows);
    }

    function niceMax(v) {
        if (v <= 0) return 10;
        const step = v > 80 ? 20 : v > 40 ? 10 : 5;
        return Math.ceil(v / step) * step;
    }

    function chartSvg(rows) {
        const W = 860;
        const HGT = 300;
        const m = { l: 36, r: 110, t: 12, b: 26 };
        const series = ui.series.map(seriesDef).filter(Boolean);
        const maxV = niceMax(Math.max(1, ...rows.flatMap(r => series.map(s => seriesValue(r, s.id)))));
        const x = i => m.l + (rows.length === 1 ? 0 : i / (rows.length - 1)) * (W - m.l - m.r);
        const y = v => m.t + (1 - v / maxV) * (HGT - m.t - m.b);
        const ticks = 5;
        let g = '';
        for (let i = 0; i <= ticks; i++) {
            const v = maxV / ticks * i;
            g += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${H(v)}</text>`;
        }
        const every = Math.ceil(rows.length / 8);
        rows.forEach((r, i) => {
            if (i % every === 0 || i === rows.length - 1) g += `<text class="axis-label" x="${x(i)}" y="${HGT - 6}" text-anchor="middle">${fmtDate(TB.parseWeekKey(r.week))}</text>`;
        });
        // End labels, nudged apart so they don't collide.
        const ends = series.map(s => ({ s, y: y(seriesValue(rows[rows.length - 1], s.id)) })).sort((p, q) => p.y - q.y);
        for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
        const lines = series.map(s => {
            const pts = rows.map((r, i) => `${x(i)},${y(seriesValue(r, s.id))}`).join(' ');
            const dots = rows.length <= 16 ? rows.map((r, i) => `<circle class="dot" cx="${x(i)}" cy="${y(seriesValue(r, s.id))}" r="4" fill="${s.color}"/>`).join('') : '';
            return `<polyline class="series" points="${pts}" stroke="${s.color}"/>${dots}`;
        }).join('');
        const labels = ends.map(e => `<text class="endlabel" x="${W - m.r + 10}" y="${e.y + 3}">${esc(e.s.name)} ${H(seriesValue(rows[rows.length - 1], e.s.id))}</text>`).join('');
        return `<svg viewBox="0 0 ${W} ${HGT}" role="img" aria-label="Line chart of weekly hours by series">${g}${lines}${labels}
            <line class="crosshair hidden" id="hist-cross" x1="0" x2="0" y1="${m.t}" y2="${HGT - m.b}"/>
            <rect id="hist-hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${HGT - m.t - m.b}" fill="transparent"/></svg>`;
    }

    function wireChart(el, rows) {
        const svg = el.querySelector('svg');
        const hit = el.querySelector('#hist-hit');
        const cross = el.querySelector('#hist-cross');
        const W = 860;
        const mL = 36;
        const mR = 110;
        const move = ev => {
            const rect = svg.getBoundingClientRect();
            const vx = (ev.clientX - rect.left) / rect.width * W;
            const i = Math.max(0, Math.min(rows.length - 1, Math.round((vx - mL) / (W - mL - mR) * (rows.length - 1))));
            const cx = mL + (rows.length === 1 ? 0 : i / (rows.length - 1)) * (W - mL - mR);
            cross.setAttribute('x1', cx);
            cross.setAttribute('x2', cx);
            cross.classList.remove('hidden');
            const r = rows[i];
            const lines = ui.series.map(seriesDef).filter(Boolean).map(s => `<div style="display:flex;gap:8px;align-items:center"><span class="sw" style="background:${s.color}"></span><span style="flex:1">${esc(s.name)}</span><span class="num">${H(seriesValue(r, s.id))} h</span></div>`).join('');
            showTip(`<b>Week of ${fmtDate(TB.parseWeekKey(r.week))}</b>${lines}`, ev.clientX, ev.clientY, true);
        };
        hit.addEventListener('mousemove', move);
        hit.addEventListener('mouseleave', () => { cross.classList.add('hidden'); hideTip(); });
        hit.addEventListener('touchstart', e => move(e.touches[0]), { passive: true });
    }

    /** Deterministic sample history so trends are visible on first use. */
    function loadSampleHistory() {
        const offsets = [
            { study: -4, social: 2, free: 2 }, { study: 2, social: -2, practice: 2, free: -2 },
            { study: -2, sleep: -3, free: 5 }, { study: 7, social: -4, practice: -2, free: -1 },
            { study: 0, games: 6, social: -3, free: -3 }, { study: 3, sleep: -2, free: -1 },
        ];
        let added = 0;
        offsets.forEach((off, i) => {
            const key = TB.shiftWeek(ui.week, -(6 - i));
            if (state.weeks[key] && budget(state.weeks[key]).used > 0) return;
            const p = TB.sanitizePlan(TB.demoPlan(), state.categories);
            Object.entries(off).forEach(([id, d]) => { if (cat(id)) p.adjust[id] = TB.round2((p.adjust[id] || 0) + d); });
            state.weeks[key] = p;
            added++;
        });
        toast(added ? `Added ${added} sample week${added === 1 ? '' : 's'}.` : 'Past weeks already have data.');
    }

    /* ── Activity dialog ───────────────────────────────────── */

    function categorySelect(selected, name) {
        return `<select class="select" name="${name}">${['fixed', 'flexible'].map(t => `<optgroup label="${t === 'fixed' ? 'Fixed commitments' : 'Flexible'}">${state.categories.filter(c => c.type === t).map(c => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
    }

    function openActivityDialog(existing, preset) {
        if (!state.categories.length) { toast('Create a category first.'); return; }
        const a = existing || Object.assign({ name: '', categoryId: state.categories[0].id, day: ui.agendaDay, start: 9 * 60, end: 10 * 60, classification: 'inherit' }, preset || {});
        const names = [...new Set((activePlan() ? activePlan().activities : []).map(x => x.name))];
        const dlg = $('#dlg');
        dlg.innerHTML = `<form method="dialog" id="act-form" novalidate>
            <div class="dlg-hd"><h2>${existing ? 'Edit activity' : 'New activity'}${scenario() ? ` <span style="color:var(--scen);font-size:12px">◆ ${esc(scenario().name)}</span>` : ''}</h2><button type="button" class="btn ghost icon" data-close aria-label="Close">✕</button></div>
            <div class="dlg-body">
                <label class="field"><span>Activity name</span><input class="input" name="name" list="act-names" maxlength="60" value="${esc(a.name)}" placeholder="e.g. Team practice" autocomplete="off"></label>
                <datalist id="act-names">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
                <div class="row2">
                    <label class="field"><span>Category</span>${categorySelect(a.categoryId, 'categoryId')}</label>
                    <label class="field"><span>Counts as</span><select class="select" name="classification"></select></label>
                </div>
                ${existing ? `<label class="field"><span>Day</span><select class="select" name="day">${TB.DAYS.map((d, i) => `<option value="${i}"${i === a.day ? ' selected' : ''}>${d}</option>`).join('')}</select></label>`
                    : `<div class="field"><span>Days (pick one or more)</span><div class="days-pick">${TB.DAYS_SHORT.map((d, i) => `<label><input type="checkbox" name="days" value="${i}"${i === a.day ? ' checked' : ''}><span>${d}</span></label>`).join('')}</div></div>`}
                <div class="row2">
                    <label class="field"><span>Start</span><input class="input" type="time" name="start" step="300" value="${TB.formatTime(a.start)}" required></label>
                    <label class="field"><span>End</span><input class="input" type="time" name="end" step="300" value="${TB.formatTime(a.end)}" required></label>
                </div>
                <div class="preview" id="act-preview"></div>
                <div class="errors hidden" id="act-errors"></div>
            </div>
            <div class="dlg-ft">
                ${existing ? '<button type="button" class="btn danger" data-dlg="delete">Delete</button><button type="button" class="btn" data-dlg="duplicate">Duplicate</button>' : ''}
                <span class="spacer"></span>
                <button type="button" class="btn ghost" data-close>Cancel</button>
                <button type="submit" class="btn primary">${existing ? 'Save' : 'Add'}</button>
            </div>
        </form>`;
        const form = $('#act-form');

        const syncClass = () => {
            const c = cat(form.categoryId.value);
            const cur = form.classification.value || a.classification;
            form.classification.innerHTML = `<option value="inherit">Category default (${c.type})</option><option value="fixed">Fixed</option><option value="flexible">Flexible</option>`;
            form.classification.value = cur;
        };

        const readDraft = () => {
            const days = existing ? [Number(form.day.value)] : [...form.querySelectorAll('input[name=days]:checked')].map(i => Number(i.value));
            const c = cat(form.categoryId.value);
            const name = form.name.value.trim() || (c ? c.name : '');
            return days.map((day, i) => ({
                id: existing && i === 0 ? existing.id : TB.uid('act'),
                name, categoryId: form.categoryId.value, day,
                start: TB.parseTime(form.start.value), end: TB.parseTime(form.end.value),
                classification: form.classification.value,
            }));
        };

        const errorsFor = drafts => {
            const errs = [];
            if (!drafts.length) errs.push('Pick at least one day.');
            drafts.slice(0, 1).forEach(d => TB.validateActivity(d, state.categories).forEach(e => errs.push(e)));
            return [...new Set(errs)];
        };

        const update = () => {
            const drafts = readDraft();
            const errs = errorsFor(drafts);
            const pv = $('#act-preview');
            if (errs.length) { pv.innerHTML = '<span class="muted">Enter a valid time range to see the impact.</span>'; return; }
            const d0 = drafts[0];
            const dur = TB.durationMin(d0.start, d0.end) / 60;
            const plan = TB.clone(activePlan() || TB.emptyPlan());
            if (existing) plan.activities = plan.activities.filter(x => x.id !== existing.id);
            const before = budget(plan);
            plan.activities.push(...drafts);
            const after = budget(plan);
            const ids = new Set(drafts.map(x => x.id));
            const clashes = after.overlaps.filter(o => ids.has(o.aId) !== ids.has(o.bId));
            const type = TB.effectiveType(d0, cat(d0.categoryId));
            pv.innerHTML = `<span class="num">${H(dur)} h</span> ${drafts.length > 1 ? `× ${drafts.length} days = <span class="num">${H(dur * drafts.length)} h</span>` : ''} · ${type}${d0.end <= d0.start ? ' · <span style="color:var(--accent)">crosses midnight</span>' : ''}<br>
                Available after this: <span class="num" style="color:${after.state === 'over' ? 'var(--bad)' : 'var(--good)'}">${after.state === 'over' ? '−' + H(after.overallocated) + ' h (over-allocated)' : H(after.unallocated) + ' h'}</span> <span class="faint">(now ${before.state === 'over' ? '−' + H(before.overallocated) : H(before.unallocated)} h)</span>
                ${clashes.length ? `<span class="warn">⚠ Overlaps ${clashes.slice(0, 3).map(o => `${esc(ids.has(o.aId) ? o.bName : o.aName)} (${TB.DAYS_SHORT[o.day]} ${TB.formatTime(o.start)}–${TB.formatTime(o.end)})`).join(', ')}${clashes.length > 3 ? '…' : ''} — overlapping time is counted twice.</span>` : ''}`;
        };

        syncClass();
        form.classification.value = a.classification;
        form.addEventListener('input', update);
        form.categoryId.addEventListener('change', () => { syncClass(); update(); });
        form.addEventListener('submit', e => {
            e.preventDefault();
            const drafts = readDraft();
            const errs = errorsFor(drafts);
            const box = $('#act-errors');
            if (errs.length) { box.innerHTML = errs.map(esc).join('<br>'); box.classList.remove('hidden'); return; }
            const plan = editablePlan();
            if (existing) {
                const idx = plan.activities.findIndex(x => x.id === existing.id);
                if (idx >= 0) plan.activities[idx] = drafts[0];
            } else {
                plan.activities.push(...drafts);
            }
            closeDialog();
            commit();
        });
        dlg.querySelectorAll('[data-dlg]').forEach(b => b.addEventListener('click', () => {
            const plan = editablePlan();
            if (b.dataset.dlg === 'delete') {
                plan.activities = plan.activities.filter(x => x.id !== existing.id);
                closeDialog();
                commit();
                toast(`Deleted “${existing.name}”.`);
            } else if (b.dataset.dlg === 'duplicate') {
                closeDialog();
                openActivityDialog(null, { name: existing.name, categoryId: existing.categoryId, day: (existing.day + 1) % 7, start: existing.start, end: existing.end, classification: existing.classification });
            }
        }));
        update();
        showDialog();
        if (!existing) form.name.focus();
    }

    /* ── Category dialog ───────────────────────────────────── */

    function usageCount(catId) {
        let n = 0;
        Object.values(state.weeks).forEach(p => { n += p.activities.filter(a => a.categoryId === catId).length + (p.adjust[catId] ? 1 : 0); });
        state.scenarios.forEach(s => { n += s.plan.activities.filter(a => a.categoryId === catId).length + (s.plan.adjust[catId] ? 1 : 0); });
        return n;
    }

    function openCategoryDialog(existing) {
        const palette = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767', '#2fb3c9', '#8fbf3f'];
        const c = existing || { id: TB.uid('cat'), name: '', type: 'flexible', color: palette[state.categories.length % palette.length], min: null, target: null, max: null, athletic: false };
        const v = x => (x === null || x === undefined ? '' : H(x));
        const dlg = $('#dlg');
        dlg.innerHTML = `<form method="dialog" id="cat-form" novalidate>
            <div class="dlg-hd"><h2>${existing ? 'Edit category' : 'New category'}</h2><button type="button" class="btn ghost icon" data-close aria-label="Close">✕</button></div>
            <div class="dlg-body">
                <div class="row2" style="grid-template-columns:1fr auto">
                    <label class="field"><span>Name</span><input class="input" name="name" maxlength="40" value="${esc(c.name)}" autocomplete="off"></label>
                    <label class="field"><span>Color</span><input class="input" type="color" name="color" value="${c.color}" style="width:56px;padding:3px;height:38px"></label>
                </div>
                <div class="field"><span>Type</span><div class="seg-toggle">
                    <label><input type="radio" name="type" value="fixed"${c.type === 'fixed' ? ' checked' : ''}><span>Fixed commitment</span></label>
                    <label><input type="radio" name="type" value="flexible"${c.type === 'flexible' ? ' checked' : ''}><span>Flexible / discretionary</span></label>
                </div><span class="help" style="text-transform:none;letter-spacing:0;font-weight:400">Fixed time is subtracted from 168 to get discretionary hours. Individual activities can override this.</span></div>
                <div class="row3">
                    <label class="field"><span>Minimum h</span><input class="input num" inputmode="decimal" name="min" value="${v(c.min)}" placeholder="—"></label>
                    <label class="field"><span>Target h</span><input class="input num" inputmode="decimal" name="target" value="${v(c.target)}" placeholder="—"></label>
                    <label class="field"><span>Maximum h</span><input class="input num" inputmode="decimal" name="max" value="${v(c.max)}" placeholder="—"></label>
                </div>
                <span class="help">All limits are optional weekly hours (decimals allowed, e.g. 7.5).</span>
                <label class="check"><input type="checkbox" name="athletic"${c.athletic ? ' checked' : ''}> Counts toward athletic hours (History)</label>
                <div class="errors hidden" id="cat-errors"></div>
            </div>
            <div class="dlg-ft">
                ${existing ? '<button type="button" class="btn danger" data-dlg="delete">Delete</button>' : ''}
                <span class="spacer"></span>
                <button type="button" class="btn ghost" data-close>Cancel</button>
                <button type="submit" class="btn primary">${existing ? 'Save' : 'Add category'}</button>
            </div>
        </form>`;
        const form = $('#cat-form');
        const num = s => (s.trim() === '' ? null : Number(s.trim()));
        form.addEventListener('submit', e => {
            e.preventDefault();
            const draft = {
                id: c.id, name: form.name.value.trim(), type: form.type.value, color: form.color.value,
                min: num(form.min.value), target: num(form.target.value), max: num(form.max.value), athletic: form.athletic.checked,
            };
            const errs = TB.validateCategory(draft, state.categories);
            ['min', 'target', 'max'].forEach(k => { if (draft[k] !== null && Number.isNaN(draft[k])) errs.push(`${k} must be a number.`); });
            if (errs.length) { const box = $('#cat-errors'); box.innerHTML = [...new Set(errs)].map(esc).join('<br>'); box.classList.remove('hidden'); return; }
            const clean = TB.sanitizeCategory(draft);
            const idx = state.categories.findIndex(x => x.id === c.id);
            if (idx >= 0) state.categories[idx] = clean; else state.categories.push(clean);
            closeDialog();
            commit();
        });
        const del = dlg.querySelector('[data-dlg=delete]');
        if (del) del.addEventListener('click', () => {
            const n = usageCount(c.id);
            if (!confirm(`Delete “${c.name}”?${n ? `\n\nThis also removes ${n} activit${n === 1 ? 'y/budget entry' : 'ies/budget entries'} using it across all weeks and scenarios.` : ''}`)) return;
            const strip = p => { p.activities = p.activities.filter(a => a.categoryId !== c.id); delete p.adjust[c.id]; };
            Object.values(state.weeks).forEach(strip);
            state.scenarios.forEach(s => strip(s.plan));
            state.categories = state.categories.filter(x => x.id !== c.id);
            closeDialog();
            commit();
        });
        showDialog();
        if (!existing) form.name.focus();
    }

    /* ── Dialog, tooltip, toast ────────────────────────────── */

    function showDialog() {
        const dlg = $('#dlg');
        dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeDialog));
        if (!dlg.open) dlg.showModal();
    }

    function closeDialog() {
        const dlg = $('#dlg');
        if (dlg.open) dlg.close();
    }

    function showTip(html, x, y, isHtml) {
        const tip = $('#tooltip');
        if (isHtml) tip.innerHTML = html;
        else tip.innerHTML = esc(html).replace(/\n/g, '<br>').replace(/^([^·<]+)·/, '<b>$1</b>');
        tip.classList.remove('hidden');
        const r = tip.getBoundingClientRect();
        let left = x + 14;
        let top = y + 14;
        if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
        if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
        tip.style.left = Math.max(8, left) + 'px';
        tip.style.top = Math.max(8, top) + 'px';
    }

    function hideTip() { $('#tooltip').classList.add('hidden'); }

    let toastTimer;
    function toast(msg) {
        let el = $('.toast');
        if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
        el.textContent = msg;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.remove(), 2600);
    }

    /* ── Events ────────────────────────────────────────────── */

    function parseHours(str) {
        const s = String(str).trim();
        if (s === '' || s === '-' || s === '.' || s === '-.') return { empty: true };
        if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return { invalid: true };
        return { value: Number(s) };
    }

    const actions = {
        'week-prev': () => { ui.week = TB.shiftWeek(ui.week, -1); render(); },
        'week-next': () => { ui.week = TB.shiftWeek(ui.week, 1); render(); },
        'week-today': () => { ui.week = TB.weekKey(new Date()); render(); },
        'goto-week': el => { ui.week = el.dataset.week; ui.plan = 'base'; ui.tab = 'overview'; render(); },
        'copy-week': el => { state.weeks[ui.week] = TB.clone(state.weeks[el.dataset.from]); commit(); toast('Copied. Adjust anything that changes this week.'); },
        'start-empty': () => { state.weeks[ui.week] = TB.emptyPlan(); commit(); },
        'clear-week': () => {
            if (!confirm('Clear every activity and unscheduled hour from this week?')) return;
            state.weeks[ui.week] = TB.emptyPlan(); state.meta.demoNotice = false; commit();
        },
        'dismiss-demo': () => { state.meta.demoNotice = false; commit(); },
        'exit-scenario': () => { ui.plan = 'base'; render(); },
        'open-scenario': el => { ui.plan = el.dataset.id; ui.tab = 'overview'; render(); },
        'goto-compare': el => { ui.compareId = el.dataset.id; ui.tab = 'scenarios'; render(); },
        'compare': el => { ui.compareId = el.dataset.id; render(); },
        'create-scenario': el => {
            const name = el.dataset.name || ($('#scen-name') ? $('#scen-name').value : '');
            const s = createScenario(name);
            if (s) { commit(); toast(`Created “${s.name}” from ${weekTitle(ui.week).toLowerCase()}. Edit hours in the table or open it.`); }
        },
        'rename-scenario': el => {
            const s = state.scenarios.find(x => x.id === el.dataset.id);
            const name = prompt('Rename scenario', s.name);
            if (name && name.trim()) { s.name = name.trim().slice(0, 40); commit(); }
        },
        'apply-scenario': el => {
            const s = state.scenarios.find(x => x.id === el.dataset.id);
            if (!confirm(`Replace ${weekTitle(ui.week).toLowerCase()}'s base plan with “${s.name}”? The scenario is kept.`)) return;
            state.weeks[ui.week] = TB.clone(s.plan); commit(); toast('Base week updated from scenario.');
        },
        'delete-scenario': el => {
            const s = state.scenarios.find(x => x.id === el.dataset.id);
            if (!confirm(`Delete scenario “${s.name}”? Your base week is not affected.`)) return;
            state.scenarios = state.scenarios.filter(x => x.id !== s.id);
            if (ui.plan === s.id) ui.plan = 'base';
            commit();
        },
        'new-act': () => openActivityDialog(null),
        'edit-act': el => { const a = findActivity(el.dataset.id); if (a) openActivityDialog(a); },
        'agenda-day': el => { ui.agendaDay = Number(el.dataset.day); render(); },
        'new-cat': () => openCategoryDialog(null),
        'edit-cat': el => openCategoryDialog(cat(el.dataset.id)),
        'wi-add': () => { const f = state.categories.find(c => c.type === 'flexible') || state.categories[0]; ui.whatif.push({ categoryId: f.id, op: 'add', hours: 1 }); render(); },
        'wi-remove': el => { ui.whatif.splice(Number(el.dataset.i), 1); render(); },
        'wi-reset': () => { ui.whatif = defaultWhatIf(); render(); },
        'wi-preset': el => { ui.whatif = [{ categoryId: el.dataset.cat, op: el.dataset.op, hours: Number(el.dataset.hours) }]; render(); },
        'wi-save': () => {
            const valid = validWhatIf();
            const r = TB.whatIf(activePlan() || TB.emptyPlan(), state.categories, valid);
            const label = valid.map(w => `${w.op === 'set' ? '=' : w.op === 'add' ? '+' : '−'}${H(Number(w.hours))} ${cat(w.categoryId).name}`).join(', ');
            const s = createScenario('What-if: ' + label, r.plan);
            if (s) { commit(); toast(`Saved as scenario “${s.name}”.`); }
        },
        'toggle-series': el => {
            const id = el.dataset.id;
            ui.series = ui.series.includes(id) ? ui.series.filter(x => x !== id) : [...ui.series, id];
            save(); render();
        },
        'sample-history': () => { loadSampleHistory(); commit(); },
        'export': () => {
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `timebudget-${TB.weekKey(new Date())}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
        'import': () => $('#import-file').click(),
        'reset': () => {
            const choice = prompt('Type DEMO to restore the demo week, or ERASE to delete all TimeBudget data in this browser.');
            if (!choice) return;
            if (choice.trim().toUpperCase() === 'ERASE') {
                state = { version: 1, categories: TB.defaultCategories(), weeks: {}, scenarios: [], meta: { demoNotice: false } };
            } else if (choice.trim().toUpperCase() === 'DEMO') {
                state = { version: 1, categories: TB.defaultCategories(), weeks: { [TB.weekKey(new Date())]: TB.demoPlan() }, scenarios: [], meta: { demoNotice: true } };
                ui.week = TB.weekKey(new Date());
            } else return;
            ui.plan = 'base'; ui.whatif = null;
            commit();
        },
    };

    function bind() {
        document.addEventListener('click', e => {
            const tab = e.target.closest('[data-tab]');
            if (tab) { ui.tab = tab.dataset.tab; save(); render(); window.scrollTo(0, 0); return; }
            const go = e.target.closest('[data-tab-go]');
            if (go) { ui.tab = go.dataset.tabGo; save(); render(); window.scrollTo(0, 0); return; }
            const el = e.target.closest('[data-action]');
            if (el && actions[el.dataset.action] && !el.disabled) { actions[el.dataset.action](el); return; }
            const day = e.target.closest('.cal-day');
            if (day) {
                const y = e.clientY - day.getBoundingClientRect().top;
                const start = Math.min(23 * 60, Math.max(0, Math.floor(y / HOUR_PX * 2) * 30));
                openActivityDialog(null, { day: Number(day.dataset.day), start, end: start + 60 });
            }
        });

        $('#plan-select').addEventListener('change', e => {
            if (e.target.value === '__new') { ui.tab = 'scenarios'; e.target.value = ui.plan; render(); const n = $('#scen-name'); if (n) n.focus(); return; }
            ui.plan = e.target.value;
            render();
        });

        document.addEventListener('input', e => {
            const el = e.target;
            const kind = el.dataset && el.dataset.input;
            if (!kind) return;
            if (kind === 'adjust' || kind === 'scen-hours') {
                const p = parseHours(el.value);
                el.style.borderColor = p.invalid ? 'var(--bad)' : '';
                if (p.invalid) return;
                if (kind === 'adjust') {
                    const v = p.empty ? 0 : p.value;
                    if (Math.abs(v) > 168) { el.style.borderColor = 'var(--bad)'; return; }
                    const plan = editablePlan();
                    if (TB.round2(v) === 0) delete plan.adjust[el.dataset.cat]; else plan.adjust[el.dataset.cat] = TB.round2(v);
                } else {
                    if (p.empty) return;
                    if (p.value < 0 || p.value > 168) { el.style.borderColor = 'var(--bad)'; return; }
                    const s = state.scenarios.find(x => x.id === el.dataset.scen);
                    if (s) setCategoryTotal(s.plan, el.dataset.cat, p.value);
                }
                commit();
            } else if (kind === 'wi-hours') {
                ui.whatif[Number(el.dataset.i)].hours = el.value.trim();
                const n = Number(el.value);
                el.style.borderColor = el.value.trim() === '' || !Number.isFinite(n) || n < 0 || n > 168 ? 'var(--bad)' : '';
                render();
            }
        });

        document.addEventListener('change', e => {
            const el = e.target;
            const kind = el.dataset && el.dataset.input;
            if (kind === 'wi-op') { ui.whatif[Number(el.dataset.i)].op = el.value; render(); }
            else if (kind === 'wi-cat') { ui.whatif[Number(el.dataset.i)].categoryId = el.value; render(); }
            else if (kind === 'compare-select') { ui.compareId = el.value; render(); }
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.target.id === 'scen-name') actions['create-scenario'](e.target);
        });

        $('#import-file').addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const raw = JSON.parse(reader.result);
                    const clean = TB.sanitizeState(raw);
                    if (!clean.categories.length) throw new Error('no categories');
                    if (!confirm(`Import ${clean.categories.length} categories, ${Object.keys(clean.weeks).length} weeks and ${clean.scenarios.length} scenarios? This replaces your current data.`)) return;
                    state = Object.assign(clean, { meta: { demoNotice: false } });
                    ui.plan = 'base';
                    commit();
                    toast('Imported.');
                } catch (err) {
                    toast('That file is not a valid TimeBudget export.');
                }
                e.target.value = '';
            };
            reader.readAsText(file);
        });

        // Hover tooltips for any element carrying data-tip.
        document.addEventListener('mouseover', e => {
            const t = e.target.closest('[data-tip]');
            if (t) showTip(t.dataset.tip, e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', e => {
            const t = e.target.closest('[data-tip]');
            if (t) showTip(t.dataset.tip, e.clientX, e.clientY);
        });
        document.addEventListener('mouseout', e => {
            if (e.target.closest('[data-tip]') && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-tip]'))) hideTip();
        });
        window.addEventListener('scroll', hideTip, { passive: true });

        // Keep "today" fresh if the tab stays open across midnight/weeks.
        window.addEventListener('storage', ev => { if (ev.key === STORE_KEY) { loadState(); render(); } });
    }

    loadState();
    bind();
    render();
})();
