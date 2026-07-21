(() => {
  const DATA = window.TIMELINE;
  if (!DATA) throw new Error('Timeline data was not loaded.');

  const laneById = new Map(DATA.lanes.map(l => [l.id, l]));
  const itemById = new Map(DATA.items.map(i => [i.id, i]));
  const items = [...DATA.items].sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || a.order - b.order);
  const links = DATA.links || [];

  const state = {
    lanes: new Set(),
    query: '',
    view: window.matchMedia('(min-width: 900px)').matches ? 'map' : 'timeline',
    selected: null
  };

  const $ = id => document.getElementById(id);
  const timelineEl = $('timelineView');
  const wallEl = $('wallView');
  const mapEl = $('mapView');
  const mapCanvas = $('mapCanvas');
  const mapInner = $('mapInner');
  const mapScroller = $('mapScroller');
  const mapPanel = $('mapPanel');
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
  function svgEl(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
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

  /* deterministic tiny jitter from an id, for the hand-drawn feel */
  function jitter(id, spread) {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997;
    return ((h / 997) - 0.5) * 2 * spread;
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
      }
      if (phase) lastPhase = phase.id;

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

  /* ---------- map view ---------- */

  const MAP = {
    colW: 300,
    padX: 60,
    rowY: { context: 80, research: 215, analysis: 350, policy: 610, outputs: 745, influence: 880 },
    spineY: 480,
    nodeW: 195,
    height: 990,
    built: false,
    zoom: 1,
    width: 0,
    monthKeys: [],
    monthX: new Map()
  };

  function setZoom(z, anchorCentre) {
    const centre = anchorCentre || {
      x: (mapScroller.scrollLeft + mapScroller.clientWidth / 2) / MAP.zoom,
      y: (mapScroller.scrollTop + mapScroller.clientHeight / 2) / MAP.zoom
    };
    MAP.zoom = Math.min(1.4, Math.max(0.5, z));
    mapInner.style.transform = `scale(${MAP.zoom})`;
    mapCanvas.style.width = (MAP.width * MAP.zoom) + 'px';
    mapCanvas.style.height = (MAP.height * MAP.zoom) + 'px';
    mapScroller.scrollLeft = centre.x * MAP.zoom - mapScroller.clientWidth / 2;
    mapScroller.scrollTop = centre.y * MAP.zoom - mapScroller.clientHeight / 2;
  }

  function fitZoom() {
    return Math.min(1, (mapScroller.clientHeight - 16) / MAP.height);
  }

  function monthCenter(key) {
    return MAP.monthX.get(key) ?? MAP.padX;
  }

  function buildMap() {
    if (MAP.built) return;
    MAP.built = true;

    MAP.monthKeys = [...new Set(items.map(monthKey))].sort();
    MAP.monthKeys.forEach((key, i) =>
      MAP.monthX.set(key, MAP.padX + i * MAP.colW + MAP.colW / 2));
    MAP.width = MAP.padX * 2 + MAP.monthKeys.length * MAP.colW;
    mapInner.style.width = MAP.width + 'px';
    mapInner.style.height = MAP.height + 'px';

    /* phase strips */
    for (const phase of DATA.phases) {
      const inRange = MAP.monthKeys.filter(k => k >= phase.from && k <= phase.to);
      if (!inRange.length) continue;
      const x0 = monthCenter(inRange[0]) - MAP.colW / 2;
      const x1 = monthCenter(inRange[inRange.length - 1]) + MAP.colW / 2;
      const strip = el('div', 'map-phase');
      strip.style.left = x0 + 'px';
      strip.style.width = (x1 - x0) + 'px';
      strip.append(el('span', 'map-phase-label', phase.label));
      mapInner.append(strip);
    }

    /* spine */
    const spine = el('div', 'map-spine');
    spine.style.top = MAP.spineY + 'px';
    mapInner.append(spine);

    /* month markers on the spine */
    for (const key of MAP.monthKeys) {
      const marker = el('div', 'map-month', monthLabel(key));
      marker.style.left = monthCenter(key) + 'px';
      marker.style.top = MAP.spineY + 'px';
      marker.style.setProperty('--tilt', jitter(key, 1.2) + 'deg');
      marker.dataset.month = key;
      mapInner.append(marker);
    }

    /* nodes: stack per month+lane cell */
    const cellCount = new Map();
    for (const item of items) {
      const lane = laneById.get(item.lane);
      const key = monthKey(item);
      const cell = key + '|' + item.lane;
      const n = cellCount.get(cell) || 0;
      cellCount.set(cell, n + 1);

      const node = el('button', 'map-node' + (item.highlight ? ' map-node--highlight' : ''));
      node.type = 'button';
      node.dataset.id = item.id;
      node.style.setProperty('--lane-color', lane.color);
      node.style.setProperty('--lane-ink', lane.ink);
      node.style.setProperty('--tilt', jitter(item.id, 1.6) + 'deg');
      const x = monthCenter(key) - MAP.nodeW / 2 + jitter(item.id + 'x', 26) + (n % 2) * 34 - 17;
      const y = MAP.rowY[item.lane] + n * 74 + jitter(item.id + 'y', 10);
      node.style.left = x + 'px';
      node.style.top = y + 'px';

      node.append(el('span', 'map-node-date', item.dateLabel));
      const t = el('span', 'map-node-title', item.title);
      if (item.starred) t.append(el('span', 'map-node-star', ' ✦'));
      node.append(t);
      mapInner.append(node);
    }

    /* nudge apart any nodes that collide within a month column, then draw */
    resolveCollisions();

    /* grow the canvas to fit the lowest card so nothing clips */
    let maxBottom = 0;
    for (const node of mapInner.querySelectorAll('.map-node')) {
      maxBottom = Math.max(maxBottom, node.offsetTop + node.offsetHeight);
    }
    MAP.height = Math.max(MAP.height, maxBottom + 40);
    mapInner.style.height = MAP.height + 'px';

    drawEdges();
    setZoom(fitZoom(), { x: 0, y: MAP.height / 2 });
    mapScroller.scrollLeft = 0;

    $('zoomIn').addEventListener('click', () => setZoom(MAP.zoom + 0.15));
    $('zoomOut').addEventListener('click', () => setZoom(MAP.zoom - 0.15));
    $('zoomFit').addEventListener('click', () => setZoom(fitZoom()));

    /* interactions */
    mapCanvas.addEventListener('click', e => {
      const node = e.target.closest('.map-node');
      if (node) selectMapItem(node.dataset.id);
      else selectMapItem(null);
    });

    /* drag to pan */
    let drag = null;
    mapScroller.addEventListener('pointerdown', e => {
      if (e.target.closest('.map-node')) return;
      drag = { x: e.clientX, y: e.clientY,
        left: mapScroller.scrollLeft, top: mapScroller.scrollTop };
      mapScroller.classList.add('is-panning');
      mapScroller.setPointerCapture(e.pointerId);
    });
    mapScroller.addEventListener('pointermove', e => {
      if (!drag) return;
      mapScroller.scrollLeft = drag.left - (e.clientX - drag.x);
      mapScroller.scrollTop = drag.top - (e.clientY - drag.y);
    });
    const endDrag = () => { drag = null; mapScroller.classList.remove('is-panning'); };
    mapScroller.addEventListener('pointerup', endDrag);
    mapScroller.addEventListener('pointercancel', endDrag);

    /* vertical wheel pans horizontally (the board is wide, not tall) */
    mapScroller.addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        mapScroller.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });

    /* track current month chip while panning */
    mapScroller.addEventListener('scroll', () => {
      const centre = (mapScroller.scrollLeft + mapScroller.clientWidth / 2) / MAP.zoom;
      let best = null, bestDist = Infinity;
      for (const key of MAP.monthKeys) {
        const d = Math.abs(monthCenter(key) - centre);
        if (d < bestDist) { best = key; bestDist = d; }
      }
      markCurrentChip(best);
    }, { passive: true });
  }

  function resolveCollisions() {
    const ABOVE = new Set(['context', 'research', 'analysis']);
    const byMonthHalf = new Map();
    for (const node of mapCanvas.querySelectorAll('.map-node')) {
      const item = itemById.get(node.dataset.id);
      const key = monthKey(item) + '|' + (ABOVE.has(item.lane) ? 'up' : 'down');
      if (!byMonthHalf.has(key)) byMonthHalf.set(key, []);
      byMonthHalf.get(key).push(node);
    }
    for (const nodes of byMonthHalf.values()) {
      nodes.sort((a, b) => a.offsetTop - b.offsetTop);
      let prevBottom = -Infinity;
      for (const node of nodes) {
        let top = node.offsetTop;
        if (top < prevBottom + 14) {
          top = prevBottom + 14;
          node.style.top = top + 'px';
        }
        prevBottom = top + node.offsetHeight;
      }
    }
  }

  function drawEdges() {
    mapInner.querySelector('svg')?.remove();
    const svg = svgEl('svg', {
      class: 'map-edges',
      width: mapCanvas.style.width.replace('px', ''),
      height: MAP.height
    });

    const defs = svgEl('defs');
    for (const lane of DATA.lanes) {
      const marker = svgEl('marker', {
        id: 'arrow-' + lane.id, viewBox: '0 0 10 10', refX: 8.5, refY: 5,
        markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse'
      });
      marker.append(svgEl('path', { d: 'M 0 1 L 9 5 L 0 9', fill: 'none',
        stroke: lane.color, 'stroke-width': 1.8, 'stroke-linecap': 'round' }));
      defs.append(marker);
    }
    svg.append(defs);

    const nodeRect = id => {
      const node = mapCanvas.querySelector(`.map-node[data-id="${id}"]`);
      if (!node) return null;
      return { x: node.offsetLeft, y: node.offsetTop,
        w: node.offsetWidth, h: node.offsetHeight };
    };

    for (const link of links) {
      const a = nodeRect(link.from), b = nodeRect(link.to);
      if (!a || !b) continue;
      const lane = laneById.get(itemById.get(link.from).lane);

      const forward = (b.x - (a.x + a.w)) > -40;
      const x1 = forward ? a.x + a.w : a.x;
      const y1 = a.y + a.h / 2 + jitter(link.from + link.to, 8);
      const x2 = forward ? b.x - 4 : b.x + b.w + 4;
      const y2 = b.y + b.h / 2 + jitter(link.to + link.from, 8);
      const reach = Math.max(40, Math.abs(x2 - x1) * 0.45);
      const bend = jitter(link.from + '~' + link.to, 30);
      const c1x = x1 + (forward ? reach : -reach), c1y = y1 + bend;
      const c2x = x2 - (forward ? reach : -reach), c2y = y2 - bend;

      const path = svgEl('path', {
        class: 'map-edge' + (link.style === 'dashed' ? ' map-edge--dashed' : ''),
        d: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
        fill: 'none', stroke: lane.color,
        'marker-end': `url(#arrow-${lane.id})`
      });
      path.dataset.from = link.from;
      path.dataset.to = link.to;
      svg.append(path);

      if (link.label) {
        const mx = (x1 + x2) / 2 + (c1x - c2x) * 0, my = (y1 + y2) / 2 + bend * 0.75;
        const text = svgEl('text', {
          class: 'map-edge-label', x: mx, y: my - 7,
          fill: lane.ink, 'text-anchor': 'middle',
          transform: `rotate(${jitter(link.from + link.to + 'r', 4)} ${mx} ${my})`
        });
        text.textContent = link.label;
        text.dataset.from = link.from;
        text.dataset.to = link.to;
        svg.append(text);
      }
    }
    mapInner.prepend(svg);
  }

  function applyMapFilters() {
    const shownIds = new Set(items.filter(visible).map(i => i.id));
    emptyEl.hidden = shownIds.size > 0 || state.view !== 'map';
    for (const node of mapCanvas.querySelectorAll('.map-node')) {
      node.classList.toggle('is-ghost', !shownIds.has(node.dataset.id));
    }
    for (const edge of mapCanvas.querySelectorAll('.map-edge, .map-edge-label')) {
      edge.classList.toggle('is-ghost',
        !shownIds.has(edge.dataset.from) || !shownIds.has(edge.dataset.to));
    }
    applyMapSelection();
  }

  function neighbourhood(id) {
    const keep = new Set([id]);
    for (const link of links) {
      if (link.from === id) keep.add(link.to);
      if (link.to === id) keep.add(link.from);
    }
    return keep;
  }

  function applyMapSelection() {
    const id = state.selected;
    const keep = id ? neighbourhood(id) : null;
    for (const node of mapCanvas.querySelectorAll('.map-node')) {
      node.classList.toggle('is-dim', !!keep && !keep.has(node.dataset.id));
      node.classList.toggle('is-selected', node.dataset.id === id);
    }
    for (const edge of mapCanvas.querySelectorAll('.map-edge, .map-edge-label')) {
      const touches = edge.dataset.from === id || edge.dataset.to === id;
      edge.classList.toggle('is-dim', !!keep && !touches);
      edge.classList.toggle('is-hot', touches);
    }
  }

  function selectMapItem(id) {
    state.selected = id;
    applyMapSelection();
    mapPanel.replaceChildren();
    if (!id) { mapPanel.hidden = true; return; }
    const item = itemById.get(id);
    const close = el('button', 'map-panel-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close details');
    close.addEventListener('click', () => selectMapItem(null));
    mapPanel.append(close, cardEl(item));

    const related = links.filter(l => l.from === id || l.to === id);
    if (related.length) {
      const list = el('div', 'map-panel-links');
      list.append(el('h4', null, 'On the board this connects to'));
      for (const link of related) {
        const otherId = link.from === id ? link.to : link.from;
        const other = itemById.get(otherId);
        const row = el('button', 'map-panel-link');
        row.type = 'button';
        row.append(el('span', 'dir', link.from === id ? '→' : '←'),
          el('span', null, other.title + (link.label ? ` (${link.label})` : '')));
        row.addEventListener('click', () => {
          selectMapItem(otherId);
          scrollMapToItem(otherId);
        });
        list.append(row);
      }
      mapPanel.append(list);
    }
    mapPanel.hidden = false;
  }

  function scrollMapToItem(id) {
    const node = mapCanvas.querySelector(`.map-node[data-id="${id}"]`);
    if (!node) return;
    mapScroller.scrollTo({
      left: (node.offsetLeft + MAP.nodeW / 2) * MAP.zoom - mapScroller.clientWidth / 2,
      top: Math.max(0, node.offsetTop * MAP.zoom - mapScroller.clientHeight / 2),
      behavior: 'smooth'
    });
  }

  function scrollMapToMonth(key) {
    mapScroller.scrollTo({
      left: monthCenter(key) * MAP.zoom - mapScroller.clientWidth / 2,
      behavior: 'smooth'
    });
  }

  /* ---------- scrubber ---------- */

  function markCurrentChip(key) {
    for (const chip of scrubberEl.querySelectorAll('.scrub-chip')) {
      const current = chip.dataset.month === key;
      chip.classList.toggle('is-current', current);
      if (current) chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

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
      if (state.view === 'map') { scrollMapToMonth(chip.dataset.month); return; }
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
        if (entry.isIntersecting) markCurrentChip(entry.target.dataset.month);
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
    mapEl.hidden = view !== 'map';
    timelineEl.hidden = view !== 'timeline';
    wallEl.hidden = view !== 'wall';
    for (const [id, v] of [['viewMap', 'map'], ['viewTimeline', 'timeline'], ['viewWall', 'wall']]) {
      const btn = $(id);
      btn.classList.toggle('is-active', v === view);
      btn.setAttribute('aria-pressed', v === view ? 'true' : 'false');
    }
    render();
  }
  $('viewMap').addEventListener('click', () => setView('map'));
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
    if (state.view === 'map') { buildMap(); applyMapFilters(); }
    else if (state.view === 'timeline') renderTimeline();
    else renderWall();
  }

  buildScrubber();
  buildFilters();
  setView(state.view);
})();
