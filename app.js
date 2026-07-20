(() => {
  const archive = window.ARCHIVE;
  if (!archive) throw new Error('Archive data was not loaded.');

  const itemById = new Map(archive.items.map((item) => [item.id, item]));
  const laneById = new Map(archive.lanes.map((lane) => [lane.id, lane]));
  const map = document.getElementById('timeline-map');
  const nodesRoot = document.getElementById('event-nodes');
  const labelsRoot = document.getElementById('lane-labels');
  const axisRoot = document.getElementById('axis');
  const connectionsSvg = document.getElementById('connections');
  const filtersRoot = document.getElementById('lane-filters');
  const detailPanel = document.getElementById('detail-panel');
  const mobileList = document.getElementById('mobile-list');
  const layout = {
    width: 3040,
    height: 1770,
    left: 170,
    right: 28,
    laneTop: 100,
    laneGap: 270,
    nodeWidth: 200,
    nodeHeight: 112,
    minDate: Date.parse('2025-02-01T00:00:00Z'),
    maxDate: Date.parse('2026-07-31T00:00:00Z')
  };

  let activeLane = 'all';
  let selectedId = null;
  const positions = new Map();
  const nodeElements = new Map();
  const pathElements = new Map();

  function parseItemDate(item) {
    if (!item.date) return layout.minDate;
    const normalized = item.date.length === 7 ? `${item.date}-15T00:00:00Z` : `${item.date}T00:00:00Z`;
    return Date.parse(normalized);
  }

  function xFor(item) {
    const ratio = (parseItemDate(item) - layout.minDate) / (layout.maxDate - layout.minDate);
    return layout.left + Math.max(0, Math.min(1, ratio)) * (layout.width - layout.left - layout.right - layout.nodeWidth);
  }

  function addAxis() {
    let cursor = new Date('2025-02-01T00:00:00Z');
    while (cursor <= new Date('2026-07-01T00:00:00Z')) {
      const ratio = (cursor.getTime() - layout.minDate) / (layout.maxDate - layout.minDate);
      const tick = document.createElement('div');
      tick.className = 'axis__tick';
      tick.style.left = `${ratio * 100}%`;
      const label = document.createElement('span');
      const includeYear = cursor.getUTCMonth() === 0 || (cursor.getUTCFullYear() === 2025 && cursor.getUTCMonth() === 1);
      label.textContent = cursor.toLocaleDateString('en-GB', { month: 'short', year: includeYear ? 'numeric' : undefined, timeZone: 'UTC' });
      tick.append(label);
      axisRoot.append(tick);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  function addLaneScaffolding() {
    archive.lanes.forEach((lane, index) => {
      const y = layout.laneTop + index * layout.laneGap;
      const label = document.createElement('div');
      label.className = 'lane-label';
      label.style.top = `${y}px`;
      label.style.setProperty('--lane-color', lane.color);
      label.textContent = lane.label;
      labelsRoot.append(label);

      const guide = document.createElement('div');
      guide.className = 'lane-guide';
      guide.style.top = `${y}px`;
      map.append(guide);
    });
  }

  function calculatePositions() {
    archive.lanes.forEach((lane, laneIndex) => {
      const items = archive.items.filter((item) => item.lane === lane.id).sort((a, b) => a.order - b.order);
      const tiers = [[], []];
      items.forEach((item, index) => tiers[index % 2].push({ item, baseX: xFor(item) }));

      tiers.forEach((tierItems, tier) => {
        const gap = 24;
        const minX = layout.left;
        const maxX = layout.width - layout.right - layout.nodeWidth;
        const xs = [];
        tierItems.forEach((entry, index) => {
          xs[index] = index === 0
            ? Math.max(minX, entry.baseX)
            : Math.max(entry.baseX, xs[index - 1] + layout.nodeWidth + gap);
        });

        tierItems.forEach((entry, index) => { entry.x = xs[index]; });

        if (tierItems.length && tierItems[tierItems.length - 1].x > maxX) {
          tierItems[tierItems.length - 1].x = maxX;
          for (let index = tierItems.length - 2; index >= 0; index -= 1) {
            tierItems[index].x = Math.min(tierItems[index].x, tierItems[index + 1].x - layout.nodeWidth - gap);
          }
        }

        if (tierItems.length && tierItems[0].x < minX) {
          tierItems[0].x = minX;
          for (let index = 1; index < tierItems.length; index += 1) {
            tierItems[index].x = Math.max(tierItems[index].x, tierItems[index - 1].x + layout.nodeWidth + gap);
          }
        }

        tierItems.forEach(({ item, x }) => {
          const y = layout.laneTop + 34 + laneIndex * layout.laneGap + tier * 126;
          positions.set(item.id, { x, y, width: layout.nodeWidth, height: layout.nodeHeight });
        });
      });
    });
  }

  function createNode(item) {
    const lane = laneById.get(item.lane);
    const position = positions.get(item.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'event-node';
    button.style.left = `${position.x}px`;
    button.style.top = `${position.y}px`;
    button.style.setProperty('--lane-color', lane.color);
    button.dataset.itemId = item.id;
    button.setAttribute('aria-label', `${item.dateLabel}: ${item.title}`);

    const date = document.createElement('span');
    date.className = 'event-node__date';
    date.textContent = item.dateLabel;
    const title = document.createElement('span');
    title.className = 'event-node__title';
    title.textContent = item.title;
    button.append(date, title);
    button.addEventListener('click', () => selectItem(item.id));
    nodesRoot.append(button);
    nodeElements.set(item.id, button);
  }

  function createConnections() {
    connectionsSvg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    marker.innerHTML = '<marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#8d9b97"></path></marker>';
    connectionsSvg.append(marker);

    archive.relationships.forEach((relationship) => {
      const source = positions.get(relationship.source);
      const target = positions.get(relationship.target);
      const sx = source.x + source.width / 2;
      const sy = source.y + source.height / 2;
      const tx = target.x + target.width / 2;
      const ty = target.y + target.height / 2;
      const cx = (sx + tx) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${sx} ${sy} C ${cx} ${sy}, ${cx} ${ty}, ${tx} ${ty}`);
      path.setAttribute('marker-end', 'url(#arrowhead)');
      path.dataset.relationshipId = relationship.id;
      connectionsSvg.append(path);
      pathElements.set(relationship.id, path);
    });
  }

  function createFilters() {
    const options = [{ id: 'all', label: 'All' }, ...archive.lanes];
    options.forEach((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-button';
      button.textContent = option.label;
      button.dataset.lane = option.id;
      button.setAttribute('aria-pressed', option.id === activeLane ? 'true' : 'false');
      button.addEventListener('click', () => {
        activeLane = option.id;
        filtersRoot.querySelectorAll('button').forEach((entry) => entry.setAttribute('aria-pressed', entry === button ? 'true' : 'false'));
        updateVisibility();
      });
      filtersRoot.append(button);
    });
  }

  function createMobileList() {
    archive.items.slice().sort((a, b) => a.order - b.order).forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mobile-item';
      button.dataset.itemId = item.id;
      button.style.setProperty('--lane-color', laneById.get(item.lane).color);
      const date = document.createElement('small');
      date.textContent = item.dateLabel;
      const title = document.createElement('strong');
      title.textContent = item.title;
      button.append(date, title);
      button.addEventListener('click', () => {
        selectItem(item.id);
        detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      mobileList.append(button);
    });
  }

  function updateVisibility() {
    archive.items.forEach((item) => {
      const visible = activeLane === 'all' || item.lane === activeLane;
      nodeElements.get(item.id).hidden = !visible;
      const mobile = mobileList.querySelector(`[data-item-id="${item.id}"]`);
      if (mobile) mobile.hidden = !visible;
    });
    archive.relationships.forEach((relationship) => {
      const sourceVisible = activeLane === 'all' || itemById.get(relationship.source).lane === activeLane;
      const targetVisible = activeLane === 'all' || itemById.get(relationship.target).lane === activeLane;
      pathElements.get(relationship.id).style.display = sourceVisible && targetVisible ? '' : 'none';
    });
  }

  function createText(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function renderDetail(item) {
    detailPanel.replaceChildren();
    detailPanel.append(
      createText('p', 'detail-panel__date', item.dateLabel),
      createText('h3', '', item.title),
      createText('p', 'detail-panel__body', item.detail),
      createText('p', 'detail-panel__verbatim', `“${item.verbatim}”`)
    );

    const details = document.createElement('dl');
    const pairs = [
      ['Lane', laneById.get(item.lane).label],
      ['Actors', item.actors.join(', ')]
    ];
    pairs.forEach(([term, value]) => {
      details.append(createText('dt', '', term));
      const dd = createText('dd', '', value);
      details.append(dd);
    });
    detailPanel.append(details);

    const reviewPairs = [];
    if (Array.isArray(item.sourceRefs) && item.sourceRefs.length) reviewPairs.push(['Source', item.sourceRefs.join(', ')]);
    if (item.confidence) reviewPairs.push(['Confidence', item.confidence]);
    if (item.datePrecision) reviewPairs.push(['Date basis', item.datePrecision]);

    if (reviewPairs.length || item.notes) {
      const review = document.createElement('details');
      review.className = 'editorial-review';
      review.append(createText('summary', '', 'Editorial review'));
      if (reviewPairs.length) {
        const reviewDetails = document.createElement('dl');
        reviewPairs.forEach(([term, value]) => {
          reviewDetails.append(createText('dt', '', term), createText('dd', term === 'Confidence' ? 'confidence' : '', value));
        });
        review.append(reviewDetails);
      }
      if (item.notes) review.append(createText('p', '', item.notes));
      detailPanel.append(review);
    }

    const related = archive.relationships.filter((relationship) => relationship.source === item.id || relationship.target === item.id);
    if (related.length) {
      const section = document.createElement('div');
      section.className = 'detail-panel__connections';
      section.append(createText('h4', '', 'Connected moments'));
      related.forEach((relationship) => {
        const otherId = relationship.source === item.id ? relationship.target : relationship.source;
        const other = itemById.get(otherId);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${relationship.source === item.id ? '→' : '←'} ${relationship.label}: ${other.title}`;
        button.addEventListener('click', () => selectItem(otherId));
        section.append(button);
      });
      detailPanel.append(section);
    }
  }

  function selectItem(id) {
    selectedId = id;
    const connectedIds = new Set([id]);
    const highlightedRelationshipIds = new Set();
    archive.relationships.forEach((relationship) => {
      if (relationship.source === id || relationship.target === id) {
        connectedIds.add(relationship.source);
        connectedIds.add(relationship.target);
        highlightedRelationshipIds.add(relationship.id);
      }
    });

    nodeElements.forEach((element, itemId) => {
      element.classList.toggle('is-selected', itemId === id);
      element.classList.toggle('is-related', itemId !== id && connectedIds.has(itemId));
    });
    pathElements.forEach((element, relationshipId) => element.classList.toggle('is-highlighted', highlightedRelationshipIds.has(relationshipId)));
    renderDetail(itemById.get(id));
  }

  map.style.width = `${layout.width}px`;
  map.style.height = `${layout.height}px`;
  addAxis();
  addLaneScaffolding();
  calculatePositions();
  archive.items.forEach(createNode);
  createConnections();
  createFilters();
  createMobileList();
  selectItem('e03');
})();
