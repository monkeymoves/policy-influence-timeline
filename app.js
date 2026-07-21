(() => {
  const DATA = window.TIMELINE;
  if (!DATA) throw new Error('Timeline data was not loaded.');

  const laneById = new Map(DATA.lanes.map(l => [l.id, l]));
  const items = [...DATA.items].sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || a.order - b.order);

  const state = { lanes: new Set(), query: '', view: 'timeline' };

  const $ = id => document.getElementById(id);
  const timelineEl = $('timelineView');
  const wallEl = $('wallView');
  const emptyEl = $('emptyMsg');
  const scrubberEl = $('scrubber');

  /* All rendering uses document.createElement + textContent (no innerHTML),
     so board text can never execute as markup. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------- helpers ---------- */

  const MONTHS = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];

  function monthKey(item) { return (item.date || '2025-01').slice(0, 7); }

  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }

  function phaseFor(key) {
    return DATA.phases.find(p => key >= p.from && key <= p.to) || null;
  }

  function visible(item) {
    if (state.lanes.size && !state.lanes.has(item.lane)) return false;
    if (state.query) {
      const hay = [item.title, item.verbatim, item.detail, item.dateLabel,
        ...(item.actors || [])].join(' ').toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  /* ---------- timeline view ---------- */

  function renderTimeline() {
    const shown = items.filter(visible);
    emptyEl.hidden = shown.length > 0;
    timelineEl.replaceChildren();

    const groups = new Map();
    for (const item of shown) {
      const key = monthKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    let lastPhase = null;
    for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const groupEl = el('div', 'month-group');
      groupEl.dataset.month = key;

      const marker = el('h2', 'month-marker', monthLabel(key));
      marker.id = `m-${key}`;
      groupEl.append(marker);

      const phase = phaseFor(key);
      if (phase && phase.id !== lastPhase) {
        groupEl.append(el('span', 'month-note', phase.label));
        lastPhase = phase.id;
      } else if (phase) {
        lastPhase = phase.id;
      }

      const cards = el('div', 'cards');
      for (const item of group) cards.append(cardEl(item));
      groupEl.append(cards);
      timelineEl.append(groupEl);
    }
    observeMonths();
  }

  function cardEl(item) {
    const lane = laneById.get(item.lane);
    const card = el('article', 'card' + (item.highlight ? ' card--highlight' : ''));
    card.style.setProperty('--lane-color', lane.color);
    card.id = item.id;

    const top = el('div', 'card-top');
    const date = el('span', 'card-date', item.dateLabel);
    date.style.color = lane.ink;
    top.append(date, el('span', 'card-lane', lane.label));
    if (item.starred) {
      const star = el('span', 'card-star', '✦');
      star.title = 'Starred on the board';
      top.append(star);
    }
    card.append(top);

    card.append(el('h3', 'card-title', item.title));

    const verbatim = el('p', 'card-verbatim');
    verbatim.append(el('span', 'q', '“' + item.verbatim + '”'));
    card.append(verbatim);

    card.append(el('p', 'card-detail', item.detail));

    const actors = el('div', 'card-actors');
    for (const a of item.actors || []) actors.append(el('span', 'actor', a));
    card.append(actors);
    return card;
  }

  /* ---------- wall view ---------- */

  function renderWall() {
    const shown = items.filter(visible);
    emptyEl.hidden = shown.length > 0;
    wallEl.replaceChildren();

    for (const lane of DATA.lanes) {
      const laneItems = shown.filter(i => i.lane === lane.id);
      if (!laneItems.length) continue;

      const col = el('div', 'wall-col');
      col.style.setProperty('--lane-color', lane.color);
      const heading = el('h2', null, lane.label + ' ');
      heading.append(el('span', 'count', `(${laneItems.length})`));
      col.append(heading);

      for (const item of laneItems) {
        const sticky = el('div', 'sticky');
        sticky.style.setProperty('--lane-color', lane.color);
        sticky.append(el('span', 's-date', item.dateLabel));
        sticky.append(el('p', 's-text', item.title));
        col.append(sticky);
      }
      wallEl.append(col);
    }
  }

  /* ---------- scrubber ---------- */

  function buildScrubber() {
    const keys = [...new Set(items.map(monthKey))].sort();
    scrubberEl.replaceChildren();
    let lastPhase = null;
    for (const key of keys) {
      const phase = phaseFor(key);
      if (phase && phase.id !== lastPhase) {
        scrubberEl.append(el('span', 'scrub-phase', phase.label));
        lastPhase = phase.id;
      }
      const [y, m] = key.split('-');
      const chip = el('button', 'scrub-chip',
        `${MONTHS[Number(m) - 1].slice(0, 3)} ${y.slice(2)}`);
      chip.type = 'button';
      chip.dataset.month = key;
      scrubberEl.append(chip);
    }
    scrubberEl.addEventListener('click', e => {
      const chip = e.target.closest('.scrub-chip');
      if (!chip) return;
      if (state.view !== 'timeline') setView('timeline');
      const target = document.getElementById(`m-${chip.dataset.month}`);
      if (target) target.scrollIntoView({ block: 'start' });
    });
  }

  let observer = null;
  function observeMonths() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const key = entry.target.dataset.month;
        for (const chip of scrubberEl.querySelectorAll('.scrub-chip')) {
          const current = chip.dataset.month === key;
          chip.classList.toggle('is-current', current);
          if (current) chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    }, { rootMargin: '-25% 0px -65% 0px' });
    for (const g of timelineEl.querySelectorAll('.month-group')) observer.observe(g);
  }

  /* ---------- filters ---------- */

  function buildFilters() {
    const counts = new Map(DATA.lanes.map(l => [l.id, 0]));
    for (const item of items) counts.set(item.lane, counts.get(item.lane) + 1);

    const wrap = $('laneFilters');
    wrap.replaceChildren();
    for (const lane of DATA.lanes) {
      const chip = el('button', 'lane-chip');
      chip.type = 'button';
      chip.dataset.lane = lane.id;
      chip.setAttribute('aria-pressed', 'false');
      chip.style.setProperty('--lane-color', lane.color);
      const dot = el('span', 'dot');
      dot.setAttribute('aria-hidden', 'true');
      chip.append(dot, document.createTextNode(lane.label + ' '),
        el('span', 'count', String(counts.get(lane.id))));
      wrap.append(chip);
    }
    wrap.addEventListener('click', e => {
      const chip = e.target.closest('.lane-chip');
      if (!chip) return;
      const lane = chip.dataset.lane;
      if (state.lanes.has(lane)) state.lanes.delete(lane);
      else state.lanes.add(lane);
      chip.setAttribute('aria-pressed', state.lanes.has(lane) ? 'true' : 'false');
      render();
    });

    let debounce = null;
    $('searchBox').addEventListener('input', e => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.query = e.target.value.trim().toLowerCase();
        render();
      }, 120);
    });
  }

  /* ---------- view toggle ---------- */

  function setView(view) {
    state.view = view;
    timelineEl.hidden = view !== 'timeline';
    wallEl.hidden = view !== 'wall';
    for (const [id, v] of [['viewTimeline', 'timeline'], ['viewWall', 'wall']]) {
      const btn = $(id);
      btn.classList.toggle('is-active', v === view);
      btn.setAttribute('aria-pressed', v === view ? 'true' : 'false');
    }
    render();
  }
  $('viewTimeline').addEventListener('click', () => setView('timeline'));
  $('viewWall').addEventListener('click', () => setView('wall'));

  /* ---------- exports ---------- */

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const csvCell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

  function exportCsv() {
    const head = ['id','date','date_label','phase','lane','title','verbatim','detail','actors','starred','highlighted'];
    const rows = items.map(i => [
      i.id, i.date || '', i.dateLabel, (phaseFor(monthKey(i)) || {}).label || '',
      laneById.get(i.lane).label, i.title, i.verbatim, i.detail,
      (i.actors || []).join('; '), i.starred ? 'yes' : '', i.highlight ? 'yes' : ''
    ].map(csvCell).join(','));
    download('policy-influence-timeline.csv',
      '﻿' + head.join(',') + '\n' + rows.join('\n'), 'text/csv;charset=utf-8');
  }

  function exportJson() {
    download('policy-influence-timeline.json',
      JSON.stringify(DATA, null, 2), 'application/json');
  }

  function exportMural() {
    const lines = items.map(i =>
      `${i.dateLabel} | ${i.title} | ${laneById.get(i.lane).label}`);
    download('mural-sticky-notes.txt', lines.join('\n'), 'text/plain;charset=utf-8');
  }

  document.querySelectorAll('[data-export]').forEach(btn =>
    btn.addEventListener('click', () => {
      const kind = btn.dataset.export;
      if (kind === 'csv') exportCsv();
      else if (kind === 'json') exportJson();
      else exportMural();
    }));

  /* ---------- boot ---------- */

  function render() {
    if (state.view === 'timeline') renderTimeline();
    else renderWall();
  }

  buildScrubber();
  buildFilters();
  render();
})();
