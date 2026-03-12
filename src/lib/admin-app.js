import '../config.js';

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";
import { DynamoDBClient, QueryCommand, BatchGetItemCommand } from "@aws-sdk/client-dynamodb";

function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) { return null; }
}

const idToken = sessionStorage.getItem('idToken');
if (!idToken) {
    window.location.href = window.AppConfig.HOST_URL;
} else {
    const tokenPayload = parseJwt(idToken);
    const userEmail = (tokenPayload && tokenPayload.username) ? tokenPayload.username : sessionStorage.getItem('userEmail');
    const emailDisplay = document.getElementById('user-email-display');
    if (emailDisplay) emailDisplay.textContent = userEmail || 'Authenticated User';
    if(!(tokenPayload?.['cognito:groups'] || []).includes(window.AppConfig.ROLES.ADMIN))
        window.location.href = window.AppConfig.HOST_URL + 'booking.html';
}

const AWS_REGION                = window.AppConfig.REGION || "eu-central-1";
const TABLE_NAME                = window.AppConfig.DB.TABLE_NAME || "LlamaBookings";
const MANAGE_ROOMS_FUNCTION     = window.AppConfig.LAMBDAS.MANAGE_ROOMS || "manage-rooms";
const MANAGE_BOOKINGS_FUNCTION  = window.AppConfig.LAMBDAS.MANAGE_BOOKINGS || "manage-bookings";
const GEN_INVITATION_FUNCTION   = window.AppConfig.LAMBDAS.GENERATE_INVITATION_CODE || "generate-invitation-code";
const MOVE_ALLOCATIONS_FUNCTION = window.AppConfig.LAMBDAS.MOVE_ALLOCATIONS || "move-allocations";
const BASE_URL       = window.AppConfig.HOST_URL.replace(/\/$/, "");
const MAGIC_LINK_BASE = `${BASE_URL}/index.html`;

const credentials = fromCognitoIdentityPool({
  clientConfig: { region: AWS_REGION },
  identityPoolId: window.AppConfig.IDENTITY_POOL_ID,
  logins: { [`cognito-idp.${AWS_REGION}.amazonaws.com/${window.AppConfig.USER_POOL_ID}`]: idToken }
});
const lambdaClient = new LambdaClient({ region: AWS_REGION, credentials });
const ddbClient    = new DynamoDBClient({ region: AWS_REGION, credentials });

let UNITS = [];
let bookingSegments = [];
const bookingDetailsCache = new Map();
const allocationsCache    = new Map();
const fetchedMonths       = new Set();
let isFetchingBookings    = false;

const today = new Date(); today.setHours(0,0,0,0);

function fmtISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseISO(s) {
  const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d);
}

function processDataIntoSegments() {
    bookingSegments = [];
    for (const [bookingId, allocations] of allocationsCache.entries()) {
        const details = bookingDetailsCache.get(bookingId);
        if (!details || allocations.length === 0) continue;
        allocations.sort((a, b) => {
            if (a.unitId === b.unitId) return a.date.localeCompare(b.date);
            return a.unitId.localeCompare(b.unitId);
        });
        let currentSegment = { ...details, unitId: allocations[0].unitId, segmentCheckin: allocations[0].date };
        for (let i = 1; i < allocations.length; i++) {
            const currentAlloc = allocations[i];
            const prevAlloc    = allocations[i - 1];
            const dayDiff = Math.round((parseISO(currentAlloc.date) - parseISO(prevAlloc.date)) / 86400000);
            if (currentAlloc.unitId !== currentSegment.unitId || dayDiff > 1) {
                const segmentCheckout = new Date(parseISO(prevAlloc.date));
                segmentCheckout.setDate(segmentCheckout.getDate() + 1);
                currentSegment.segmentCheckout = fmtISO(segmentCheckout);
                bookingSegments.push(currentSegment);
                currentSegment = { ...details, unitId: currentAlloc.unitId, segmentCheckin: currentAlloc.date };
            }
        }
        const lastAlloc = allocations[allocations.length - 1];
        const lastSegmentCheckout = new Date(parseISO(lastAlloc.date));
        lastSegmentCheckout.setDate(lastSegmentCheckout.getDate() + 1);
        currentSegment.segmentCheckout = fmtISO(lastSegmentCheckout);
        bookingSegments.push(currentSegment);
    }
}

async function fetchBookingsForDateRange(startDate, endDate) {
  if (isFetchingBookings) return;
  isFetchingBookings = true;
  try {
    const monthsToFetch = new Set();
    let currentDate = new Date(startDate); currentDate.setDate(1);
    while (currentDate <= endDate) {
      const monthKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2,'0')}`;
      if (!fetchedMonths.has(monthKey)) monthsToFetch.add(monthKey);
      currentDate.setMonth(currentDate.getMonth() + 1);
    }
    if (monthsToFetch.size === 0) { isFetchingBookings = false; return; }

    const queryPromises = Array.from(monthsToFetch).map(month => ddbClient.send(new QueryCommand({
      TableName: TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': { S: `DATE#${month}` } }
    })));
    const queryResults = await Promise.all(queryPromises);

    const newBookingIdsToFetch = new Set();
    queryResults.forEach(result => (result.Items || []).forEach(item => {
        const bookingId = item.bookingId.S;
        const unitId    = item.PK.S.replace('ROOM#', '');
        const date      = item.allocationDate.S;
        if (!allocationsCache.has(bookingId)) allocationsCache.set(bookingId, []);
        const bookingAllocs = allocationsCache.get(bookingId);
        if (!bookingAllocs.some(a => a.date === date && a.unitId === unitId)) bookingAllocs.push({ date, unitId });
        if (!bookingDetailsCache.has(bookingId)) newBookingIdsToFetch.add(bookingId);
    }));

    if (newBookingIdsToFetch.size > 0) {
        const bookingIdArray = Array.from(newBookingIdsToFetch);
        const batchGetPromises = [];
        for (let i = 0; i < bookingIdArray.length; i += 100) {
          const batch = bookingIdArray.slice(i, i + 100);
          const keys  = batch.map(id => ({ PK: { S: `BOOKING#${id}` }, SK: { S: 'META' } }));
          batchGetPromises.push(ddbClient.send(new BatchGetItemCommand({ RequestItems: { [TABLE_NAME]: { Keys: keys } } })));
        }
        const batchGetResults = await Promise.all(batchGetPromises);
        batchGetResults.forEach(result => (result.Responses[TABLE_NAME] || []).forEach(item => {
            const bookingId = item.PK.S.replace('BOOKING#', '');
            bookingDetailsCache.set(bookingId, {
                id: bookingId, checkin: item.checkin.S, checkout: item.checkout.S,
                status: item.status.S.toLowerCase(), name: item.name.S, email: item.email.S,
                guests: parseInt(item.guests.N, 10), notes: item.notes?.S || '',
                createdAt: item.createdAt?.S || '',
                GSI2SK: item.GSI2SK.S,
                roomIds: (item.roomIds?.L) ? item.roomIds.L.map(v => v.S) : []
            });
        }));
    }

    processDataIntoSegments();
    monthsToFetch.forEach(month => fetchedMonths.add(month));
    rebuildTimeline();
    if (currentView === 'calendar') rebuildCalendar();
  } catch (err) {
    console.error("Failed to fetch bookings:", err);
    showToast('Failed to load booking data', 'error');
  } finally {
    isFetchingBookings = false;
  }
}

const DAY_W     = 52;
const ROW_H     = 58;
const DAYS_BACK = 30;
const INIT_FWD  = 90;
const EXTEND_BY = 60;
const TRIGGER_PX = 400;
let totalDays = DAYS_BACK + INIT_FWD + 1;
const originDate = new Date(today);
originDate.setDate(originDate.getDate() - DAYS_BACK);
function dateAtCol(i) { const d = new Date(originDate); d.setDate(d.getDate() + i); return d; }
function colFromDate(dateStr) { return Math.round((parseISO(dateStr) - originDate) / 86400000); }
const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOWS        = ['Su','Mo','Tu','We','Th','Fr','Sa'];

function buildDayHeaderCell(i) {
    const d = dateAtCol(i); const isToday = d.getTime() === today.getTime(); const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const cell = document.createElement('div'); cell.className = 'day-cell-hdr';
    if (isToday) cell.classList.add('is-today'); if (isWeekend) cell.classList.add('is-weekend');
    cell.dataset.col = i;
    const dowEl = document.createElement('div'); dowEl.className = 'dow'; dowEl.textContent = DOWS[d.getDay()];
    const domEl = document.createElement('div'); domEl.className = 'dom'; domEl.textContent = d.getDate();
    cell.appendChild(dowEl); cell.appendChild(domEl); return cell;
}

function extendHeader(fromCol, count) {
    const monthsRow = document.getElementById('months-row');
    const daysRow   = document.getElementById('days-row');
    let lastMonthLabel = monthsRow?.lastElementChild;
    let lastMonth = lastMonthLabel ? parseInt(lastMonthLabel.dataset.month, 10) : -1;
    let lastMonthSpan = lastMonthLabel ? parseInt(lastMonthLabel.dataset.span, 10) : 0;
    if (!monthsRow || !daysRow) return;
    for (let i = fromCol; i < fromCol + count; i++) {
        const d = dateAtCol(i); const m = d.getMonth();
        if (m !== lastMonth) {
            if (lastMonthLabel) { lastMonthLabel.style.width = (lastMonthSpan * DAY_W) + 'px'; lastMonthLabel.style.minWidth = (lastMonthSpan * DAY_W) + 'px'; }
            lastMonthLabel = document.createElement('div'); lastMonthLabel.className = 'month-label';
            lastMonthLabel.textContent = `${MONTHS[m]} ${d.getFullYear()}`; lastMonthLabel.dataset.month = m;
            lastMonthLabel.dataset.span = 0; lastMonth = m; lastMonthSpan = 0; monthsRow.appendChild(lastMonthLabel);
        }
        lastMonthSpan++; lastMonthLabel.dataset.span = lastMonthSpan;
        lastMonthLabel.style.width = (lastMonthSpan * DAY_W) + 'px'; lastMonthLabel.style.minWidth = (lastMonthSpan * DAY_W) + 'px';
        daysRow.appendChild(buildDayHeaderCell(i));
    }
}

function buildGridDayCol(i) {
    const d = dateAtCol(i); const isToday = d.getTime() === today.getTime(); const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const dc = document.createElement('div'); dc.className = 'grid-day-col';
    if (isToday) dc.classList.add('is-today'); if (isWeekend) dc.classList.add('is-weekend');
    return dc;
}

function buildHeader() {
  const mRow = document.getElementById('months-row');
  const dRow = document.getElementById('days-row');
  if (mRow) mRow.innerHTML = '';
  if (dRow) dRow.innerHTML = '';
  extendHeader(0, totalDays);
}

function buildGrid() {
  const rail  = document.getElementById('unit-rail');
  const inner = document.getElementById('grid-inner');
  if (!rail || !inner) return;
  rail.innerHTML = ''; inner.innerHTML = '';
  inner.style.width = (totalDays * DAY_W) + 'px';
  UNITS.forEach(unit => {
    const uc = document.createElement('div'); uc.className = 'unit-cell';
    uc.innerHTML = `<div class="unit-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="width:13px;height:13px"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div><div class="unit-info"><div class="unit-name">${unit.name}</div><div class="unit-cap">Cap&nbsp;${unit.capacity}</div></div><svg class="unit-edit-hint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="width:13px;height:13px;flex-shrink:0"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    rail.appendChild(uc);
    const row = document.createElement('div'); row.className = 'grid-row'; row.style.height = ROW_H + 'px';
    for (let i = 0; i < totalDays; i++) row.appendChild(buildGridDayCol(i));
    bookingSegments.filter(seg => seg.unitId === unit.id).forEach(seg => renderBar(row, seg));
    inner.appendChild(row);
  });
}

let extending = false;
function extendTimeline() {
  if (extending) return; extending = true;
  const fromCol = totalDays; const newTotal = totalDays + EXTEND_BY;
  extendHeader(fromCol, EXTEND_BY);
  document.querySelectorAll('#grid-inner .grid-row').forEach(row => {
    for (let i = fromCol; i < newTotal; i++) row.appendChild(buildGridDayCol(i));
  });
  totalDays = newTotal;
  const inner = document.getElementById('grid-inner');
  if (inner) inner.style.width = (totalDays * DAY_W) + 'px';
  fetchBookingsForDateRange(dateAtCol(fromCol), dateAtCol(newTotal - 1));
  if (inner) {
    const marker = document.createElement('div');
    marker.style.cssText = 'position:absolute;top:0;right:0;bottom:0;width:3px;pointer-events:none;border-radius:2px;background:linear-gradient(to bottom,transparent,var(--accent),transparent);opacity:0.7;transition:opacity 1.2s ease;';
    inner.appendChild(marker);
    requestAnimationFrame(() => requestAnimationFrame(() => { marker.style.opacity = '0'; }));
    setTimeout(() => marker.remove(), 1400);
  }
  extending = false;
}

/* ═══════════════════════════════════════════════════
   RENDER A SINGLE BOOKING SEGMENT BAR
═══════════════════════════════════════════════════ */
function renderBar(rowEl, segment) {
  const startCol = colFromDate(segment.segmentCheckin);
  const endCol   = colFromDate(segment.segmentCheckout);
  const spanDays = endCol - startCol;
  if (spanDays <= 0) return;

  const bar = document.createElement('div');
  bar.className = `booking-bar ${segment.status}`;
  bar.style.left  = (startCol * DAY_W + 3) + 'px';
  bar.style.width = (spanDays * DAY_W - 6) + 'px';
  bar.dataset.bookingId      = segment.id;
  bar.dataset.segCheckin     = segment.segmentCheckin;
  bar.dataset.segCheckout    = segment.segmentCheckout;
  bar.dataset.unitId         = segment.unitId;

  bar.innerHTML = `
    <span class="bar-grip" title="Drag to reassign room">
      <svg viewBox="0 0 10 16" fill="currentColor" style="width:7px;height:11px;opacity:.5">
        <circle cx="3" cy="2"  r="1.2"/><circle cx="7" cy="2"  r="1.2"/>
        <circle cx="3" cy="6"  r="1.2"/><circle cx="7" cy="6"  r="1.2"/>
        <circle cx="3" cy="10" r="1.2"/><circle cx="7" cy="10" r="1.2"/>
        <circle cx="3" cy="14" r="1.2"/><circle cx="7" cy="14" r="1.2"/>
      </svg>
    </span>
    <div class="bar-label"><div class="bar-dot"></div>${segment.name}</div>`;

  // ── Tap / click — opens detail panel ─────────────────────
  // Suppressed if a drag just completed (mouse or touch)
  bar.addEventListener('click', e => {
    if (bar._dragFired) { bar._dragFired = false; return; }
    e.stopPropagation();
    openPanel(segment.id);
  });

  // ── Mouse drag — starts after ≥6 px movement ─────────────
  bar.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.panel-close, .act-btn')) return;
    const startX = e.clientX, startY = e.clientY;

    const onMove = e2 => {
      if (Math.abs(e2.clientY - startY) > 6 || Math.abs(e2.clientX - startX) > 6) {
        bar._dragFired = true;
        cleanup();
        initDrag({ clientX: e2.clientX, clientY: e2.clientY }, segment, bar);
      }
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   cleanup);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   cleanup);
  });

  // ── Touch drag — long-press (380 ms) activates drag ───────
  // A finger movement >10 px before the timer fires cancels
  // the long-press and lets the normal scroll through.
  let _touchTimer   = null;
  let _touchStartX  = 0;
  let _touchStartY  = 0;
  let _touchActive  = false;   // true once drag is live

  bar.addEventListener('touchstart', e => {
    // Only single-finger gestures
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    _touchStartX = t.clientX;
    _touchStartY = t.clientY;
    _touchActive = false;

    _touchTimer = setTimeout(() => {
      _touchActive   = true;
      bar._dragFired = true;   // suppress the tap that fires after touchend
      navigator.vibrate?.(40);
      bar.classList.add('touch-drag-pending');
      // Activate drag at the touch's current position
      const cur = bar._lastTouchPos || { clientX: _touchStartX, clientY: _touchStartY };
      initDrag(cur, segment, bar);
    }, 380);
  }, { passive: true });

  bar.addEventListener('touchmove', e => {
    if (!_touchTimer && !_touchActive) return;
    const t = e.touches[0];
    bar._lastTouchPos = { clientX: t.clientX, clientY: t.clientY };

    // Cancel long-press if the finger wandered horizontally (user is scrolling)
    if (!_touchActive) {
      const dx = Math.abs(t.clientX - _touchStartX);
      const dy = Math.abs(t.clientY - _touchStartY);
      if (dx > 10 || dy > 10) {
        clearTimeout(_touchTimer);
        _touchTimer = null;
      }
    }
  }, { passive: true });

  bar.addEventListener('touchend',    () => { clearTimeout(_touchTimer); _touchTimer = null; bar.classList.remove('touch-drag-pending'); });
  bar.addEventListener('touchcancel', () => { clearTimeout(_touchTimer); _touchTimer = null; bar.classList.remove('touch-drag-pending'); });

  rowEl.appendChild(bar);
}

/* ═══════════════════════════════════════════════════
   DETAIL PANEL
═══════════════════════════════════════════════════ */
let activePanelId = null;

function customConfirm(message, title = "Confirm Action") {
    return new Promise((resolve) => {
        const overlay = document.createElement('div'); overlay.className = 'confirm-overlay';
        const dialog  = document.createElement('div'); dialog.className = 'confirm-dialog';
        dialog.innerHTML = `
            <div class="confirm-title">${title}</div>
            <div class="confirm-msg">${message.replace(/\n/g, '<br/>')}</div>
            <div class="confirm-actions">
                <button class="confirm-btn cancel">Cancel</button>
                <button class="confirm-btn confirm">Confirm</button>
            </div>`;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        const closeDialog = (result) => {
            overlay.classList.remove('open');
            setTimeout(() => { document.body.removeChild(overlay); resolve(result); }, 250);
        };
        dialog.querySelector('.cancel').addEventListener('click', () => closeDialog(false));
        dialog.querySelector('.confirm').addEventListener('click', () => closeDialog(true));
        overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(false); });
        requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('open')));
    });
}

function openPanel(bookingId) {
  const b = bookingDetailsCache.get(bookingId);
  if (!b) return;
  activePanelId = bookingId;
  document.querySelectorAll('.booking-bar').forEach(el => el.classList.remove('active'));
  document.querySelectorAll(`[data-booking-id="${bookingId}"]`).forEach(el => el.classList.add('active'));
  const firstUnit = UNITS.find(u => u.id === b.roomIds[0]);
  document.getElementById('panel-title').textContent = `${b.GSI2SK}`;
  const unitNameEl = document.getElementById('panel-unit-name');
  if (unitNameEl) {
    unitNameEl.textContent = firstUnit ? firstUnit.name : 'Multiple Rooms';
    if (b.roomIds.length > 1) unitNameEl.textContent += ` (+${b.roomIds.length - 1} more)`;
  }
  const badge = document.getElementById('panel-status-badge');
  if (badge) badge.className = `status-badge ${b.status}`;
  document.getElementById('panel-status-text').textContent = b.status.charAt(0).toUpperCase() + b.status.slice(1);
  document.getElementById('pi-name').textContent    = b.name;
  document.getElementById('pi-email').textContent   = b.email;
  document.getElementById('pi-guests').textContent  = b.guests + (b.guests === 1 ? ' guest' : ' guests');
  document.getElementById('pi-created').textContent = b.createdAt ? parseISO(b.createdAt.split('T')[0]).toDateString() : '—';
  const noteSec = document.getElementById('notes-section');
  const piNotes = document.getElementById('pi-notes');
  if (b.notes?.trim()) {
    if (noteSec) noteSec.style.display = 'flex';
    if (piNotes) { piNotes.textContent = b.notes; piNotes.style.whiteSpace = 'pre-wrap'; piNotes.style.lineHeight = '1.4'; }
  } else {
    if (noteSec) noteSec.style.display = 'none';
  }
  document.getElementById('edit-checkin').value  = b.checkin;
  document.getElementById('edit-checkout').value = b.checkout;
  document.getElementById('edit-checkin').readOnly  = true;
  document.getElementById('edit-checkout').readOnly = true;
  updateNightsBadge();
  document.getElementById('act-save').style.display = 'none';
  const btnAccept = document.getElementById('act-accept');
  const btnReject = document.getElementById('act-reject');
  const btnCancel = document.getElementById('act-cancel');
  if (b.status === 'pending') {
    btnAccept.style.display = 'inline-block'; btnReject.style.display = 'inline-block'; btnCancel.style.display = 'none';
  } else if (b.status === 'confirmed') {
    btnAccept.style.display = 'none'; btnReject.style.display = 'none'; btnCancel.style.display = 'inline-block';
  } else {
    btnAccept.style.display = 'none'; btnReject.style.display = 'none'; btnCancel.style.display = 'none';
  }
  document.getElementById('detail-panel').classList.add('open');
}

async function invokeBookingLambda(payload) {
  const command = new InvokeCommand({ FunctionName: MANAGE_BOOKINGS_FUNCTION, Payload: new TextEncoder().encode(JSON.stringify(payload)) });
  const response     = await lambdaClient.send(command);
  const responseData = JSON.parse(new TextDecoder().decode(response.Payload));
  if (response.FunctionError) throw new Error(responseData.errorMessage || "Lambda execution failed");
  if (responseData.statusCode && responseData.statusCode !== 200 && responseData.statusCode !== 201) {
    let errorMsg = "Error processing request";
    try { errorMsg = JSON.parse(responseData.body).error || errorMsg; } catch (e) {}
    throw new Error(errorMsg);
  }
  return responseData;
}

function closePanel() {
  document.getElementById('detail-panel')?.classList.remove('open');
  document.querySelectorAll('.booking-bar').forEach(el => el.classList.remove('active'));
  activePanelId = null;
}

function updateNightsBadge() {
  const ci = document.getElementById('edit-checkin')?.value;
  const co = document.getElementById('edit-checkout')?.value;
  const nb = document.getElementById('edit-nights');
  if (!nb) return;
  if (ci && co) {
    const nights = Math.round((parseISO(co) - parseISO(ci)) / 86400000);
    nb.textContent = nights > 0 ? `${nights} night${nights !== 1 ? 's' : ''}` : '—';
  } else { nb.textContent = '—'; }
}

function mutateBooking(updates) {
  const b = bookingDetailsCache.get(activePanelId); if (!b) return;
  Object.assign(b, updates); processDataIntoSegments(); rebuildTimeline(); openPanel(activePanelId);
}

function scheduleRemoval(bookingId) {
  setTimeout(() => {
    if (activePanelId === bookingId) closePanel();
    bookingDetailsCache.delete(bookingId); allocationsCache.delete(bookingId);
    processDataIntoSegments(); rebuildTimeline();
  }, 1500);
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 2800);
}

document.getElementById('panel-close')?.addEventListener('click', closePanel);

document.getElementById('grid-scroll')?.addEventListener('click', e => {
  if (e.target.closest('.booking-bar')) return;
  if (activePanelId) closePanel();
});

document.addEventListener('click', e => {
  const panel = document.getElementById('detail-panel');
  if (!panel?.classList.contains('open')) return;
  if (window.innerWidth > 640) return;
  if (!panel.contains(e.target) && !e.target.closest('.booking-bar')) closePanel();
});

document.getElementById('act-accept')?.addEventListener('click', async () => {
  const btn = document.getElementById('act-accept');
  try {
    btn.disabled = true;
    await invokeBookingLambda({ action: 'ACCEPT', bookingId: activePanelId });
    mutateBooking({ status: 'confirmed' }); showToast('Booking confirmed ✓');
  } catch (err) { console.error(err); showToast(err.message || 'Failed to confirm booking', 'error'); }
  finally { btn.disabled = false; }
});

document.getElementById('act-reject')?.addEventListener('click', async () => {
  const confirmed = await customConfirm('Are you sure you want to reject this booking?\nThis will free up the allocated rooms for other guests.');
  if (!confirmed) return;
  const btn = document.getElementById('act-reject');
  try {
    btn.disabled = true;
    await invokeBookingLambda({ action: 'REJECT', bookingId: activePanelId });
    mutateBooking({ status: 'rejected' }); showToast('Booking rejected', 'error'); scheduleRemoval(activePanelId);
  } catch (err) { console.error(err); showToast(err.message || 'Failed to reject booking', 'error'); }
  finally { btn.disabled = false; }
});

document.getElementById('act-cancel')?.addEventListener('click', async () => {
  const confirmed = await customConfirm('Are you sure you want to cancel this booking?\nThis will free up the allocated rooms for other guests.');
  if (!confirmed) return;
  const btn = document.getElementById('act-cancel');
  try {
    btn.disabled = true;
    await invokeBookingLambda({ action: 'CANCEL', bookingId: activePanelId });
    mutateBooking({ status: 'cancelled' }); showToast('Booking cancelled', 'error'); scheduleRemoval(activePanelId);
  } catch (err) { console.error(err); showToast(err.message || 'Failed to cancel booking', 'error'); }
  finally { btn.disabled = false; }
});

/* ═══════════════════════════════════════════════════
   INVITATION CODE
═══════════════════════════════════════════════════ */
document.getElementById('btn-invite')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-invite');
  btn.classList.add('loading'); btn.disabled = true;
  try {
    const command = new InvokeCommand({ FunctionName: GEN_INVITATION_FUNCTION, Payload: new TextEncoder().encode(JSON.stringify({})) });
    const response     = await lambdaClient.send(command);
    const responseData = JSON.parse(new TextDecoder().decode(response.Payload));
    if (response.FunctionError) throw new Error(responseData.errorMessage || 'Lambda error');
    const { code } = JSON.parse(responseData.body);
    openInviteModal(code);
  } catch (err) { console.error(err); showToast(err.message || 'Failed to generate invitation code', 'error'); }
  finally { btn.classList.remove('loading'); btn.disabled = false; }
});

function openInviteModal(code) {
  const overlay = document.getElementById('invite-modal-overlay');
  const codeEl  = document.getElementById('invite-code-display');
  const qrEl    = document.getElementById('invite-qr');
  if (!overlay || !codeEl || !qrEl) return;
  codeEl.textContent = code;
  qrEl.innerHTML = '';
  const magicUrl = `${MAGIC_LINK_BASE}?code=${encodeURIComponent(code)}`;
  new QRCode(qrEl, { text: magicUrl, width: 192, height: 192, colorDark: '#5ee7c8', colorLight: '#111520', correctLevel: QRCode.CorrectLevel.M });
  const openBtn = document.getElementById('invite-open-link');
  if (openBtn) openBtn.href = magicUrl;
  overlay.classList.add('open');
}

function closeInviteModal() { document.getElementById('invite-modal-overlay')?.classList.remove('open'); }

document.getElementById('invite-modal-overlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('invite-modal-overlay')) closeInviteModal();
});
document.getElementById('invite-modal-close')?.addEventListener('click', closeInviteModal);

document.getElementById('invite-copy-btn')?.addEventListener('click', () => {
  const code = document.getElementById('invite-code-display')?.textContent;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('invite-copy-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><polyline points="20 6 9 17 4 12"/></svg> Copied`;
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = originalHTML; btn.classList.remove('copied'); }, 2000);
  });
});

document.getElementById('invite-copy-link-btn')?.addEventListener('click', () => {
  const code = document.getElementById('invite-code-display')?.textContent;
  if (!code) return;
  const url = `${MAGIC_LINK_BASE}?code=${encodeURIComponent(code)}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('invite-copy-link-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><polyline points="20 6 9 17 4 12"/></svg> Copied`;
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = originalHTML; btn.classList.remove('copied'); }, 2000);
  });
});

/* ═══════════════════════════════════════════════════
   VIEW SWITCHING
═══════════════════════════════════════════════════ */
let currentView = 'timeline';

function switchView(view) {
  currentView = view;
  const timelineWrap = document.getElementById('timeline-wrap');
  const calendarWrap = document.getElementById('calendar-wrap');
  const btnTimeline  = document.getElementById('btn-view-timeline');
  const btnCalendar  = document.getElementById('btn-view-calendar');
  const btnToday     = document.getElementById('btn-today');

  if (view === 'calendar') {
    timelineWrap?.classList.add('hidden');
    calendarWrap?.classList.add('active');
    btnTimeline?.classList.remove('active');
    btnCalendar?.classList.add('active');
    if (btnToday) btnToday.textContent = 'This Year';
    const yearStart = new Date(calendarYear, 0, 1);
    const yearEnd   = new Date(calendarYear, 11, 31);
    fetchBookingsForDateRange(yearStart, yearEnd).then(() => rebuildCalendar());
    rebuildCalendar();
  } else {
    timelineWrap?.classList.remove('hidden');
    calendarWrap?.classList.remove('active');
    btnTimeline?.classList.add('active');
    btnCalendar?.classList.remove('active');
    if (btnToday) btnToday.textContent = 'Today';
  }
}

document.getElementById('btn-view-timeline')?.addEventListener('click', () => switchView('timeline'));
document.getElementById('btn-view-calendar')?.addEventListener('click', () => switchView('calendar'));

/* ═══════════════════════════════════════════════════
   ANNUAL CALENDAR VIEW
═══════════════════════════════════════════════════ */
let calendarYear = today.getFullYear();

function getDayAllocatedRooms(dateStr) {
  const rooms = new Set();
  for (const [bookingId, allocations] of allocationsCache.entries()) {
    const details = bookingDetailsCache.get(bookingId);
    if (details) {
      const s = details.status;
      if (s === 'cancelled' || s === 'canceled' || s === 'rejected') continue;
    }
    for (const a of allocations) {
      if (a.date === dateStr) rooms.add(a.unitId);
    }
  }
  return rooms.size;
}

function occupancyColor(ratio) {
  if (ratio <= 0) return null;
  const r   = Math.max(0.05, Math.min(1, ratio));
  const hue = 120 * (1 - r);
  const sat = 58 + r * 14;
  const lit = 40 + (1 - r) * 10;
  const alpha = 0.55 + r * 0.30;
  return `hsla(${hue.toFixed(1)}, ${sat.toFixed(0)}%, ${lit.toFixed(0)}%, ${alpha.toFixed(2)})`;
}

function buildCalendarMonth(year, month) {
  const totalRooms = UNITS.length || 1;
  const card = document.createElement('div');
  card.className = 'cal-month';

  const title = document.createElement('div');
  title.className = 'cal-month-name';
  title.innerHTML = MONTHS_FULL[month];
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const titleSpan = document.createElement('span');
  titleSpan.textContent = `${daysInMonth}d`;
  title.appendChild(titleSpan);
  card.appendChild(title);

  const dowRow = document.createElement('div');
  dowRow.className = 'cal-dow-row';
  DOWS.forEach(d => {
    const cell = document.createElement('div');
    cell.className = 'cal-dow-cell';
    cell.textContent = d;
    dowRow.appendChild(cell);
  });
  card.appendChild(dowRow);

  const grid = document.createElement('div');
  grid.className = 'cal-days-grid';

  const firstDow = new Date(year, month, 1).getDay();
  for (let f = 0; f < firstDow; f++) {
    const filler = document.createElement('div');
    filler.className = 'cal-day filler';
    grid.appendChild(filler);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const dateStr  = fmtISO(d);
    const isToday  = d.getTime() === today.getTime();
    const allocCount = getDayAllocatedRooms(dateStr);
    const ratio = allocCount / totalRooms;
    const color = occupancyColor(ratio);

    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (isToday) cell.classList.add('is-today');

    if (color) {
      cell.classList.add('has-data');
      cell.style.background = color;
      const pct = Math.round(ratio * 100);
      cell.setAttribute('data-tip', `${allocCount}/${totalRooms} room${totalRooms !== 1 ? 's' : ''} · ${pct}%`);
      cell.addEventListener('click', () => {
        switchView('timeline');
        jumpTimelineTo(dateStr);
      });
    }
    cell.textContent = day;
    grid.appendChild(cell);
  }

  card.appendChild(grid);
  return card;
}

function jumpTimelineTo(dateStr) {
  requestAnimationFrame(() => {
    const col     = colFromDate(dateStr);
    const targetX = Math.max(0, col * DAY_W - 20);
    const gs = document.getElementById('grid-scroll');
    const hs = document.getElementById('hdr-scroll');
    if (gs) gs.scrollLeft = targetX;
    if (hs) hs.scrollLeft = targetX;
    if (col >= totalDays - 10) extendTimeline();
  });
}

function rebuildCalendar() {
  const grid = document.getElementById('cal-grid');
  if (!grid) return;
  grid.innerHTML = '';
  document.getElementById('cal-year-label').textContent = calendarYear;
  for (let m = 0; m < 12; m++) grid.appendChild(buildCalendarMonth(calendarYear, m));
}

document.getElementById('cal-prev-year')?.addEventListener('click', () => {
  calendarYear--;
  fetchBookingsForDateRange(new Date(calendarYear, 0, 1), new Date(calendarYear, 11, 31)).then(() => rebuildCalendar());
  rebuildCalendar();
});
document.getElementById('cal-next-year')?.addEventListener('click', () => {
  calendarYear++;
  fetchBookingsForDateRange(new Date(calendarYear, 0, 1), new Date(calendarYear, 11, 31)).then(() => rebuildCalendar());
  rebuildCalendar();
});

document.getElementById('btn-today')?.addEventListener('click', () => {
  if (currentView === 'calendar') {
    calendarYear = today.getFullYear();
    rebuildCalendar();
    requestAnimationFrame(() => {
      const cards = document.querySelectorAll('.cal-month');
      if (cards[today.getMonth()]) cards[today.getMonth()].scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  } else {
    gridScroll?.scrollTo({ left: DAYS_BACK * DAY_W - 20, behavior: 'smooth' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   DRAG-AND-DROP RE-ALLOCATION
   ─────────────────────────────────────────────────────────────────────────
   Mouse:  press + move ≥6 px activates drag immediately.
   Touch:  380 ms long-press activates drag; horizontal scroll before the
           timer fires cancels it so normal panning still works.
   Esc key cancels an active drag.
   Both input paths share a single dragState object and the same
   validate → highlight → commit pipeline.
═══════════════════════════════════════════════════════════════════════════ */

let dragState = null;
// {
//   segment, sourceBar,
//   ghost, tooltipEl,
//   currentTargetUnitId, lastValidation,
//   highlightedRow, highlightedRailCell, displacedBarEls,
//   isTouch          ← true when initiated by a touch event
// }

// ── Helpers ────────────────────────────────────────────────────────────────

function getSegmentDates(checkinStr, checkoutStr) {
  const dates = [];
  let d = parseISO(checkinStr);
  const end = parseISO(checkoutStr);
  while (d < end) { dates.push(fmtISO(d)); d = new Date(d.getTime() + 86400000); }
  return dates;
}

function getAllocOnRoomDate(roomId, dateStr, excludeBookingId = null) {
  for (const [bid, allocs] of allocationsCache.entries()) {
    if (bid === excludeBookingId) continue;
    for (const a of allocs) {
      if (a.unitId === roomId && a.date === dateStr) return bid;
    }
  }
  return null;
}

function findDisplacedSegments(draggedSeg, toUnitId) {
  return bookingSegments.filter(seg =>
    seg.unitId    === toUnitId &&
    seg.id        !== draggedSeg.id &&
    seg.segmentCheckin  < draggedSeg.segmentCheckout &&
    seg.segmentCheckout > draggedSeg.segmentCheckin
  );
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateDragMove(draggedSeg, toUnitId) {
  if (toUnitId === draggedSeg.unitId)
    return { valid: false, reason: 'Same room — no move needed.' };

  const dragDates = new Set(getSegmentDates(draggedSeg.segmentCheckin, draggedSeg.segmentCheckout));

  for (const dateStr of dragDates) {
    const bid = getAllocOnRoomDate(toUnitId, dateStr);
    if (bid === draggedSeg.id)
      return { valid: false, reason: `This booking already occupies the target room on ${dateStr}.` };
  }

  const displaced = findDisplacedSegments(draggedSeg, toUnitId);

  for (const disp of displaced) {
    const dispDates = getSegmentDates(disp.segmentCheckin, disp.segmentCheckout);
    for (const dateStr of dispDates) {
      if (dragDates.has(dateStr)) continue;
      const blocker = getAllocOnRoomDate(draggedSeg.unitId, dateStr, draggedSeg.id);
      if (blocker) {
        const bd = bookingDetailsCache.get(blocker);
        return {
          valid: false,
          reason: `Cannot swap: ${draggedSeg.unitId} is occupied on ${dateStr}` +
                  (bd ? ` by "${bd.name}"` : '') +
                  `. Booking "${disp.name}" cannot be relocated.`
        };
      }
    }
  }

  return { valid: true, displaced };
}

// ── Ghost / tooltip elements ───────────────────────────────────────────────

function createGhostEl(segment) {
  const g = document.createElement('div');
  g.className = `drag-ghost booking-bar ${segment.status}`;
  g.innerHTML = `<div class="bar-label"><div class="bar-dot"></div>${segment.name}</div>`;
  document.body.appendChild(g);
  return g;
}

function createTooltipEl() {
  const t = document.createElement('div');
  t.className = 'drag-tooltip';
  document.body.appendChild(t);
  return t;
}

// ── Map a clientY to a row index ───────────────────────────────────────────

function rowIndexFromClientY(clientY) {
  const gs = document.getElementById('grid-scroll');
  if (!gs) return -1;
  const rect = gs.getBoundingClientRect();
  const relY = clientY - rect.top + gs.scrollTop;
  return Math.floor(relY / ROW_H);
}

// ── Highlight management ───────────────────────────────────────────────────

function clearDragHighlights() {
  if (!dragState) return;
  dragState.highlightedRow?.classList.remove('drag-over-valid', 'drag-over-invalid');
  dragState.highlightedRailCell?.classList.remove('drag-rail-valid', 'drag-rail-invalid');
  dragState.displacedBarEls?.forEach(el => el.classList.remove('will-be-displaced'));
  dragState.highlightedRow      = null;
  dragState.highlightedRailCell = null;
  dragState.displacedBarEls     = [];
}

function applyDragHighlights(rowIdx, validation) {
  clearDragHighlights();
  if (!dragState) return;

  const rows      = document.querySelectorAll('#grid-inner .grid-row');
  const railCells = document.querySelectorAll('#unit-rail .unit-cell');
  const row       = rows[rowIdx];
  const railCell  = railCells[rowIdx];

  if (row)      { row.classList.add(validation.valid ? 'drag-over-valid' : 'drag-over-invalid'); dragState.highlightedRow = row; }
  if (railCell) { railCell.classList.add(validation.valid ? 'drag-rail-valid' : 'drag-rail-invalid'); dragState.highlightedRailCell = railCell; }

  if (validation.valid && validation.displaced?.length > 0) {
    const toUnitId = UNITS[rowIdx]?.id;
    validation.displaced.forEach(disp => {
      document.querySelectorAll(`[data-booking-id="${disp.id}"][data-unit-id="${toUnitId}"]`)
        .forEach(el => { el.classList.add('will-be-displaced'); dragState.displacedBarEls.push(el); });
    });
  }

  dragState.ghost.classList.toggle('drag-ghost-valid',   validation.valid);
  dragState.ghost.classList.toggle('drag-ghost-invalid', !validation.valid);

  if (dragState.tooltipEl) {
    const targetUnit = UNITS[rowIdx];
    if (validation.valid) {
      const n = validation.displaced?.length ?? 0;
      dragState.tooltipEl.textContent = n > 0
        ? `Move to ${targetUnit.name} · swap ${n} booking${n > 1 ? 's' : ''}`
        : `Move to ${targetUnit.name}`;
      dragState.tooltipEl.className = 'drag-tooltip drag-tooltip-valid';
    } else {
      dragState.tooltipEl.textContent = validation.reason ?? 'Invalid';
      dragState.tooltipEl.className = 'drag-tooltip drag-tooltip-invalid';
    }
  }
}

// ── Position ghost + tooltip at a pointer position ────────────────────────

function positionDragUI(clientX, clientY) {
  if (!dragState) return;
  const { ghost, tooltipEl, isTouch } = dragState;

  if (isTouch) {
    // On touch: anchor the ghost above the finger so it isn't hidden under the thumb
    ghost.style.left   = (clientX - ghost.offsetWidth / 2) + 'px';
    ghost.style.top    = (clientY - ROW_H - 28) + 'px';
    tooltipEl.style.left = (clientX - tooltipEl.offsetWidth / 2) + 'px';
    tooltipEl.style.top  = (clientY - ROW_H - 58) + 'px';
  } else {
    ghost.style.left     = (clientX + 14) + 'px';
    ghost.style.top      = (clientY - 22) + 'px';
    tooltipEl.style.left = (clientX + 14) + 'px';
    tooltipEl.style.top  = (clientY + 18) + 'px';
  }
}

// ── Core: initDrag, onDragUpdate, onDragCommit, cleanupDrag ───────────────

function initDrag(pointerPos, segment, sourceBar, isTouch = false) {
  const ghost   = createGhostEl(segment);
  const tooltip = createTooltipEl();

  dragState = {
    segment, sourceBar, ghost, tooltipEl: tooltip,
    currentTargetUnitId:  null,
    lastValidation:       null,
    highlightedRow:       null,
    highlightedRailCell:  null,
    displacedBarEls:      [],
    isTouch,
  };

  // Initial position — use two rAF so offsetWidth is available for centering
  requestAnimationFrame(() => {
    requestAnimationFrame(() => positionDragUI(pointerPos.clientX, pointerPos.clientY));
  });

  sourceBar.classList.add('dragging');
  document.body.style.cursor     = isTouch ? '' : 'grabbing';
  document.body.style.userSelect = 'none';

  // Mouse listeners
  document.addEventListener('mousemove', onMouseDragMove);
  document.addEventListener('mouseup',   onMouseDragEnd);

  // Touch listeners — passive:false so we can preventDefault and stop scroll
  document.addEventListener('touchmove',   onTouchDragMove,   { passive: false, capture: true });
  document.addEventListener('touchend',    onTouchDragEnd,    { capture: true });
  document.addEventListener('touchcancel', onTouchDragCancel, { capture: true });

  // Keyboard escape
  document.addEventListener('keydown', onDragKeydown);
}

// ── Mouse move / end ───────────────────────────────────────────────────────

function onMouseDragMove(e) {
  if (!dragState || dragState.isTouch) return;
  positionDragUI(e.clientX, e.clientY);
  onDragUpdate(e.clientX, e.clientY);
}

function onMouseDragEnd(e) {
  if (!dragState || dragState.isTouch) return;
  onDragCommit(e.clientX, e.clientY);
}

// ── Touch move / end / cancel ──────────────────────────────────────────────

function onTouchDragMove(e) {
  if (!dragState || !dragState.isTouch) return;
  // Prevent the page from scrolling while dragging
  e.preventDefault();
  const t = e.touches[0];
  positionDragUI(t.clientX, t.clientY);
  onDragUpdate(t.clientX, t.clientY);
}

function onTouchDragEnd(e) {
  if (!dragState || !dragState.isTouch) return;
  e.preventDefault();
  const t = e.changedTouches[0];
  onDragCommit(t.clientX, t.clientY);
}

function onTouchDragCancel() {
  if (!dragState || !dragState.isTouch) return;
  cleanupDrag();
  dragState = null;
  showToast('Move cancelled', '');
}

// ── Keyboard escape ────────────────────────────────────────────────────────

function onDragKeydown(e) {
  if (e.key === 'Escape' && dragState) {
    cleanupDrag();
    dragState = null;
    showToast('Move cancelled', '');
  }
}

// ── Shared update (called from both mouse and touch move) ─────────────────

function onDragUpdate(clientX, clientY) {
  if (!dragState) return;
  const rowIdx     = rowIndexFromClientY(clientY);
  const targetUnit = (rowIdx >= 0 && rowIdx < UNITS.length) ? UNITS[rowIdx] : null;
  const targetId   = targetUnit?.id ?? null;

  if (targetId === dragState.currentTargetUnitId) return;
  dragState.currentTargetUnitId = targetId;

  if (!targetUnit || targetId === dragState.segment.unitId) {
    clearDragHighlights();
    if (dragState.tooltipEl) dragState.tooltipEl.className = 'drag-tooltip';
    return;
  }

  const validation = validateDragMove(dragState.segment, targetId);
  dragState.lastValidation = validation;
  applyDragHighlights(rowIdx, validation);
}

// ── Shared commit (called from mouse-up or touch-end) ────────────────────

async function onDragCommit(clientX, clientY) {
  if (!dragState) return;
  const { segment, currentTargetUnitId, lastValidation } = dragState;
  cleanupDrag();
  dragState = null;

  if (!currentTargetUnitId || currentTargetUnitId === segment.unitId) return;
  if (!lastValidation?.valid) { showToast(lastValidation?.reason ?? 'Invalid move', 'error'); return; }

  await executeSegmentMove(segment, currentTargetUnitId, lastValidation.displaced);
}

// ── Cleanup: remove overlays, reset state ─────────────────────────────────

function cleanupDrag() {
  if (!dragState) return;
  dragState.ghost.remove();
  dragState.tooltipEl.remove();
  dragState.sourceBar.classList.remove('dragging', 'touch-drag-pending');
  clearDragHighlights();
  document.body.style.cursor     = '';
  document.body.style.userSelect = '';

  document.removeEventListener('mousemove', onMouseDragMove);
  document.removeEventListener('mouseup',   onMouseDragEnd);
  document.removeEventListener('touchmove',   onTouchDragMove,   { capture: true });
  document.removeEventListener('touchend',    onTouchDragEnd,    { capture: true });
  document.removeEventListener('touchcancel', onTouchDragCancel, { capture: true });
  document.removeEventListener('keydown',     onDragKeydown);
}

// ── Optimistic cache mutation ──────────────────────────────────────────────

function applyMoveToLocalCache(segment, toUnitId, displaced) {
  const segDates = new Set(getSegmentDates(segment.segmentCheckin, segment.segmentCheckout));
  for (const a of (allocationsCache.get(segment.id) || []))
    if (a.unitId === segment.unitId && segDates.has(a.date)) a.unitId = toUnitId;

  for (const disp of (displaced || [])) {
    const dispDates = new Set(getSegmentDates(disp.segmentCheckin, disp.segmentCheckout));
    for (const a of (allocationsCache.get(disp.id) || []))
      if (a.unitId === toUnitId && dispDates.has(a.date)) a.unitId = segment.unitId;
  }
}

function revertMoveInLocalCache(segment, toUnitId, displaced) {
  const segDates = new Set(getSegmentDates(segment.segmentCheckin, segment.segmentCheckout));
  for (const a of (allocationsCache.get(segment.id) || []))
    if (a.unitId === toUnitId && segDates.has(a.date)) a.unitId = segment.unitId;

  for (const disp of (displaced || [])) {
    const dispDates = new Set(getSegmentDates(disp.segmentCheckin, disp.segmentCheckout));
    for (const a of (allocationsCache.get(disp.id) || []))
      if (a.unitId === segment.unitId && dispDates.has(a.date)) a.unitId = toUnitId;
  }
}

function refreshRoomIdsInCache(segment, toUnitId, displaced) {
  for (const bid of [segment.id, ...(displaced || []).map(d => d.id)]) {
    const allocs  = allocationsCache.get(bid) || [];
    const roomIds = [...new Set(allocs.map(a => a.unitId))].sort();
    const details = bookingDetailsCache.get(bid);
    if (details) details.roomIds = roomIds;
  }
}

// ── Lambda call ────────────────────────────────────────────────────────────

async function executeSegmentMove(segment, toUnitId, displaced) {
  showToast('Moving allocation…', '');

  applyMoveToLocalCache(segment, toUnitId, displaced);
  processDataIntoSegments();
  rebuildTimeline();

  try {
    const cmd = new InvokeCommand({
      FunctionName: MOVE_ALLOCATIONS_FUNCTION,
      Payload: new TextEncoder().encode(JSON.stringify({
        bookingId:       segment.id,
        fromRoomId:      segment.unitId,
        toRoomId:        toUnitId,
        segmentCheckin:  segment.segmentCheckin,
        segmentCheckout: segment.segmentCheckout
      }))
    });

    const response = await lambdaClient.send(cmd);
    const data     = JSON.parse(new TextDecoder().decode(response.Payload));

    if (response.FunctionError || (data.statusCode && data.statusCode !== 200)) {
      let errMsg = 'Move failed';
      try { errMsg = JSON.parse(data.body).error || errMsg; } catch {}
      revertMoveInLocalCache(segment, toUnitId, displaced);
      processDataIntoSegments();
      rebuildTimeline();
      showToast(errMsg, 'error');
      return;
    }

    refreshRoomIdsInCache(segment, toUnitId, displaced);
    showToast('Allocation moved ✓');

  } catch (err) {
    console.error('Segment move failed:', err);
    revertMoveInLocalCache(segment, toUnitId, displaced);
    processDataIntoSegments();
    rebuildTimeline();
    showToast('Move failed: ' + err.message, 'error');
  }
}

/* ═══════════════════════════════════════════════════
   SCROLL SYNC
═══════════════════════════════════════════════════ */
const gridScroll = document.getElementById('grid-scroll');
const hdrScroll  = document.getElementById('hdr-scroll');
const unitRail   = document.getElementById('unit-rail');
let activeScroller = null; let scrollSyncTimer;

function handleScrollSync(e) {
  if (dragState) return;   // don't scroll while dragging
  if (activeScroller && activeScroller !== e.target) return;
  activeScroller = e.target;
  if (e.target === gridScroll) {
    if (hdrScroll) hdrScroll.scrollLeft = gridScroll.scrollLeft;
    if (unitRail)  unitRail.scrollTop   = gridScroll.scrollTop;
    if (gridScroll.scrollLeft + gridScroll.clientWidth >= totalDays * DAY_W - TRIGGER_PX) extendTimeline();
  } else if (e.target === hdrScroll) {
    if (gridScroll) gridScroll.scrollLeft = hdrScroll.scrollLeft;
  } else if (e.target === unitRail) {
    if (gridScroll) gridScroll.scrollTop = unitRail.scrollTop;
  }
  clearTimeout(scrollSyncTimer);
  scrollSyncTimer = setTimeout(() => { activeScroller = null; }, 50);
}

gridScroll?.addEventListener('scroll', handleScrollSync);
hdrScroll?.addEventListener('scroll', handleScrollSync);
unitRail?.addEventListener('scroll', handleScrollSync);

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
async function initialize() {
  buildHeader();
  await loadRoomsFromDB();
  await fetchBookingsForDateRange(dateAtCol(0), dateAtCol(totalDays - 1));
  requestAnimationFrame(() => {
    const x = DAYS_BACK * DAY_W - 20;
    if (gridScroll) gridScroll.scrollLeft = x;
    if (hdrScroll)  hdrScroll.scrollLeft  = x;
  });
}
initialize();

/* ═══════════════════════════════════════════════════
   ROOM MANAGEMENT
═══════════════════════════════════════════════════ */
function bookingCountForUnit(uid) {
  let count = 0;
  for (const b of bookingDetailsCache.values()) {
    if (b.status !== 'cancelled' && b.status !== 'rejected' && b.roomIds.includes(uid)) count++;
  }
  return count;
}

function roomPK(id) { return `ROOM#${id}`; }
function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

async function invokeRoomLambda(payload) {
  const command = new InvokeCommand({ FunctionName: MANAGE_ROOMS_FUNCTION, Payload: new TextEncoder().encode(JSON.stringify(payload)) });
  const response     = await lambdaClient.send(command);
  const responseData = JSON.parse(new TextDecoder().decode(response.Payload));
  if (response.FunctionError) throw new Error(responseData.errorMessage || "Lambda execution failed");
  if (responseData.statusCode && responseData.statusCode !== 200 && responseData.statusCode !== 201) throw new Error(responseData.body || "Error processing request");
  return responseData;
}

async function loadRoomsFromDB() {
  const btn = document.getElementById('um-refresh-btn');
  if (btn) { btn.classList.add('loading'); btn.disabled = true; }
  try {
    const response = await ddbClient.send(new QueryCommand({ TableName: TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': { S: 'ROOMS' } } }));
    UNITS = (response.Items || []).map(item => ({ id: item.id.S, name: item.name.S, capacity: parseInt(item.capacity.N, 10) }));
    UNITS.sort((a, b) => a.name.localeCompare(b.name));
    renderUnitList(); rebuildTimeline();
  } catch (err) { console.error("Failed to fetch rooms:", err); showToast('Failed to load rooms from DB', 'error'); }
  finally { if (btn) { btn.classList.remove('loading'); btn.disabled = false; } }
}

function renderUnitList() {
  const list = document.getElementById('um-list'); if (!list) return;
  list.innerHTML = '';
  if (UNITS.length === 0) { list.innerHTML = `<div class="um-empty">No rooms yet — add one below.</div>`; return; }
  UNITS.forEach(unit => {
    const bCount = bookingCountForUnit(unit.id);
    const row = document.createElement('div'); row.className = 'um-unit-row'; row.dataset.uid = unit.id;
    row.innerHTML = `
      <span class="um-room-id" title="PK: ${roomPK(unit.id)}">${unit.id}</span>
      <input class="um-unit-name-input" data-uid="${unit.id}" value="${unit.name}" placeholder="Room name"/>
      <input class="um-unit-cap-input" data-uid="${unit.id}" value="${unit.capacity}" type="number" readonly disabled title="Capacity cannot be changed after creation" style="opacity:0.6;cursor:not-allowed;"/>
      <span class="um-booking-badge">${bCount} booking${bCount !== 1 ? 's' : ''}</span>
      <button class="um-unit-save" data-uid="${unit.id}">Save</button>
      <button class="um-unit-delete" data-uid="${unit.id}" title="Delete room">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/><path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4h6v2"/></svg>
      </button>`;
    list.appendChild(row);

    row.querySelector('.um-unit-save')?.addEventListener('click', async e => {
      const nameVal = row.querySelector('.um-unit-name-input').value.trim();
      if (!nameVal) { showToast('Room name cannot be empty', 'error'); return; }
      if (nameVal === unit.name) return;
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = '...';
      try {
        await invokeRoomLambda({ action: "UPDATE", room: { id: unit.id, name: nameVal, capacity: unit.capacity } });
        unit.name = nameVal; rebuildTimeline(); showToast('Room updated successfully');
      } catch (err) { console.error(err); showToast(err.message || 'Failed to update room', 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Save'; }
    });

    row.querySelector('.um-unit-delete')?.addEventListener('click', async e => {
      const btn = e.currentTarget;
      const confirmMsg = bCount > 0
        ? `Are you sure you want to delete "${unit.name}"?\n\nWARNING: This room has ${bCount} active booking(s) which will be CANCELLED permanently.`
        : `Are you sure you want to delete "${unit.name}"?`;
      const confirmed = await customConfirm(confirmMsg, 'Delete Room');
      if (!confirmed) return;
      btn.disabled = true;
      try {
        await invokeRoomLambda({ action: "DELETE", roomId: unit.id });
        showToast('Room deleted successfully');
        bookingDetailsCache.clear(); allocationsCache.clear(); fetchedMonths.clear();
        await loadRoomsFromDB();
        await fetchBookingsForDateRange(dateAtCol(0), dateAtCol(totalDays - 1));
      } catch (err) { console.error(err); showToast(err.message || 'Failed to delete room', 'error'); btn.disabled = false; }
    });
  });
}

document.getElementById('um-add-btn')?.addEventListener('click', async () => {
  const nameInput = document.getElementById('new-unit-name');
  const capInput  = document.getElementById('new-unit-cap');
  if (!nameInput || !capInput) return;
  const name = nameInput.value.trim(); const cap = parseInt(capInput.value, 10);
  if (!name || isNaN(cap) || cap < 1) { showToast('Please enter a valid name and capacity', 'error'); return; }
  const btn = document.getElementById('um-add-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  const newId = slugify(name) + '-' + Date.now().toString(36);
  try {
    await invokeRoomLambda({ action: "CREATE", room: { id: newId, name, capacity: cap } });
    UNITS.push({ id: newId, name, capacity: cap }); nameInput.value = ''; capInput.value = '';
    renderUnitList(); rebuildTimeline(); showToast(`Room "${name}" created`);
  } catch (err) { console.error(err); showToast('Failed to create room', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '+ Add Room'; } }
});

document.getElementById('um-refresh-btn')?.addEventListener('click', () => { loadRoomsFromDB(); showToast('Rooms loaded from database ✓'); });

const unitsModalOverlay = document.getElementById('units-modal-overlay');
document.getElementById('btn-units')?.addEventListener('click', () => { renderUnitList(); unitsModalOverlay?.classList.add('open'); });

function closeUnitsModal() { unitsModalOverlay?.classList.remove('open'); }
document.getElementById('um-close')?.addEventListener('click', closeUnitsModal);
unitsModalOverlay?.addEventListener('click', e => { if (e.target === unitsModalOverlay) closeUnitsModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeUnitsModal(); closeInviteModal(); } });

function rebuildTimeline() {
  if (!gridScroll || !hdrScroll || !unitRail) return;
  const scrollLeft = gridScroll.scrollLeft; const scrollTop = gridScroll.scrollTop;
  buildGrid();
  requestAnimationFrame(() => {
    gridScroll.scrollLeft = scrollLeft; gridScroll.scrollTop = scrollTop;
    hdrScroll.scrollLeft = scrollLeft; unitRail.scrollTop = scrollTop;
  });
}

unitRail?.addEventListener('click', e => {
  const cell = e.target.closest('.unit-cell'); if (!cell) return;
  const uIdx = Array.from(unitRail.children).indexOf(cell); if (uIdx < 0 || uIdx >= UNITS.length) return;
  renderUnitList(); unitsModalOverlay?.classList.add('open');
  requestAnimationFrame(() => { const rows = document.querySelectorAll('.um-unit-row'); if (rows[uIdx]) rows[uIdx].scrollIntoView({ behavior: 'smooth', block: 'center' }); });
});