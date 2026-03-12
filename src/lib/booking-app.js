import '../config.js'; // Imports the global awsConfig

// Import AWS SDK v3 modules
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        return null;
    }
}

// Check for login token
const idToken = sessionStorage.getItem('idToken');
if (!idToken) {
    window.location.href = window.AppConfig.HOST_URL;
} else {
    // Decode the token and display the user's email
    const tokenPayload = parseJwt(idToken);
    const userEmail = (tokenPayload && tokenPayload.username) ? tokenPayload.username : sessionStorage.getItem('userEmail');
    document.getElementById('user-email-display').textContent = userEmail || 'Authenticated User';
}

// ==========================================
// AWS SDK Setup
// ==========================================
const AWS_REGION = window.AppConfig.REGION || "eu-central-1";
const TABLE_NAME = window.AppConfig.DB.TABLE_NAME || "LlamaBookings";

const BOOKING_REQUEST_FUNCTION = window.AppConfig.LAMBDAS.BOOKING_REQUEST || "TenantA-booking-request";

const MAX_NIGHTS = 90;

const credentials = fromCognitoIdentityPool({
  clientConfig: { region: AWS_REGION },
  identityPoolId: window.AppConfig.IDENTITY_POOL_ID,
  logins: {
    [`cognito-idp.${AWS_REGION}.amazonaws.com/${window.AppConfig.USER_POOL_ID}`]: idToken
  }
});
const lambdaClient = new LambdaClient({ region: AWS_REGION, credentials: credentials });
const ddbClient = new DynamoDBClient({ region: AWS_REGION, credentials });
const docClient = DynamoDBDocumentClient.from(ddbClient);

async function invokeBookingRequestLambda(payload) {
  const payloadString = JSON.stringify(payload);
  const command = new InvokeCommand({
    FunctionName: BOOKING_REQUEST_FUNCTION,
    Payload: new TextEncoder().encode(payloadString)
  });

  const response = await lambdaClient.send(command);
  const responseData = JSON.parse(new TextDecoder().decode(response.Payload));

  if (response.FunctionError) {
    throw new Error(responseData.errorMessage || "Lambda execution failed");
  }

  if (responseData.statusCode && responseData.statusCode !== 200 && responseData.statusCode !== 201) {
    throw new Error(responseData.body || "Error processing request");
  }

  return responseData;
}

/* ═══════════════════════════════════════════════════════════════
   CALENDAR ENGINE
═══════════════════════════════════════════════════════════════ */

const availabilityCache = new Map();
let allRooms = [];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const today = new Date();
today.setHours(0, 0, 0, 0);

function dStr(y, m, d) { return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function dateKey(dt) { return dt ? dStr(dt.getFullYear(), dt.getMonth(), dt.getDate()) : null; }
function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

let unavailDates = new Set();
async function fetchMonthData(year, month) {

    const cacheKey = `${year}-${month}`;
    if (availabilityCache.has(cacheKey)) {
        return;
    }

    try {
        if (allRooms.length === 0) {
            const roomsParams = {
                TableName: TABLE_NAME,
                IndexName: "GSI1",
                KeyConditionExpression: "GSI1PK = :pk",
                ExpressionAttributeValues: { ":pk": "ROOMS" },
            };
            const roomsData = await docClient.send(new QueryCommand(roomsParams));
            allRooms = roomsData.Items.map(r => ({ id: r.id, capacity: r.capacity }));
        }

        const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
        const allocParams = {
            TableName: TABLE_NAME,
            IndexName: "GSI2",
            KeyConditionExpression: "GSI2PK = :month",
            ExpressionAttributeValues: { ":month": `DATE#${monthPrefix}` }
        };

        const allocData = await docClient.send(new QueryCommand(allocParams));

        const allocationsByDay = new Map();
        allocData.Items.forEach(item => {
            const date = item.allocationDate;
            if (!allocationsByDay.has(date)) {
                allocationsByDay.set(date, new Set());
            }
            const roomId = item.PK.split('#')[1];
            allocationsByDay.get(date).add(roomId);
        });

        availabilityCache.set(cacheKey, allocationsByDay);

    } catch (err) {
        console.error("Error fetching availability:", err);
        showErr("Could not load calendar availability.");
    }
}

function calculateAndSetUnavailableDates() {
    unavailDates.clear();
    const currentGuests = guests;

    for (let offset = 0; offset < 2; offset++) {
        let mo = viewMonth + offset, yr = viewYear;
        if (mo > 11) { mo -= 12; yr++; }

        const cacheKey = `${yr}-${mo}`;
        const allocationsByDay = availabilityCache.get(cacheKey);
        if (!allocationsByDay) continue;

        const daysInMonth = new Date(yr, mo + 1, 0).getDate();

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = dStr(yr, mo, d);
            const allocatedRoomIds = allocationsByDay.get(dateStr) || new Set();
            const availableRooms = allRooms.filter(room => !allocatedRoomIds.has(room.id));
            const totalAvailableCapacity = availableRooms.reduce((sum, room) => sum + room.capacity, 0);

            if (currentGuests > totalAvailableCapacity) {
                unavailDates.add(dateStr);
            }
        }
    }
}


function isUnavail(dt) { return unavailDates.has(dateKey(dt)); }
function isPast(dt) { return dt < today; }
function isToday(dt) { return dateKey(dt) === dateKey(today); }

let viewYear = today.getFullYear();
let viewMonth = today.getMonth();
let checkin = null;
let checkout = null;
let hoverKey = null;


function rangeIsBlocked(d1, d2) {
  if (!d1 || !d2 || d1.getTime() === d2.getTime()) return false;
  const from = d1 < d2 ? d1 : d2;
  const to   = d1 < d2 ? d2 : d1;
  if (isUnavail(from) || isUnavail(to)) return true;
  let cur = new Date(from);
  cur.setDate(cur.getDate() + 1);
  while (cur < to) {
    if (isUnavail(cur)) return true;
    cur.setDate(cur.getDate() + 1);
  }
  return false;
}

/** Returns true if the range exceeds MAX_NIGHTS. */
function rangeExceedsMax(d1, d2) {
  if (!d1 || !d2) return false;
  const nights = Math.round(Math.abs(d2 - d1) / 86400000);
  return nights > MAX_NIGHTS;
}

function renderCalendar() {
  const wrap = document.getElementById('months-wrap');
  wrap.innerHTML = '';
  for (let offset = 0; offset < 2; offset++) {
    let mo = viewMonth + offset, yr = viewYear;
    if (mo > 11) { mo -= 12; yr++; }
    const lastDay  = new Date(yr, mo + 1, 0).getDate();
    const startDow = new Date(yr, mo, 1).getDay();
    const monthEl = document.createElement('div');
    monthEl.className = 'month';
    const nameEl = document.createElement('div');
    nameEl.className = 'month-name';
    nameEl.textContent = `${MONTHS[mo]} ${yr}`;
    monthEl.appendChild(nameEl);
    const dnEl = document.createElement('div');
    dnEl.className = 'day-names';
    DAYS.forEach(label => {
      const s = document.createElement('span');
      s.textContent = label;
      dnEl.appendChild(s);
    });
    monthEl.appendChild(dnEl);
    const grid = document.createElement('div');
    grid.className = 'days-grid';
    grid.dataset.month = mo;
    grid.dataset.year  = yr;
    for (let i = 0; i < startDow; i++) {
      const e = document.createElement('div');
      e.className = 'day empty';
      grid.appendChild(e);
    }
    for (let d = 1; d <= lastDay; d++) {
      const dt  = new Date(yr, mo, d);
      const key = dateKey(dt);
      const cell = document.createElement('div');
      cell.className = 'day';
      cell.textContent = d;
      cell.dataset.key = key;
      if (isPast(dt)) {
        cell.classList.add('past');
      } else {
        if (isUnavail(dt)) cell.classList.add('unavail');
        // Mark days that would exceed the 90-night cap from the current checkin
        if (checkin && !checkout && rangeExceedsMax(checkin, dt)) cell.classList.add('over-max');
        if (checkin  && key === dateKey(checkin))  cell.classList.add('checkin');
        if (checkout && key === dateKey(checkout)) cell.classList.add('checkout');
        if (isToday(dt)) cell.classList.add('today');
        applyRangeClass(cell, dt, key);
      }
      grid.appendChild(cell);
    }
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-key]');
      if (!cell) return;
      const dt = parseKey(cell.dataset.key);
      if (isPast(dt) || isUnavail(dt)) return;
      handleDateClick(dt);
    });
    grid.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('[data-key]');
      if (!cell || cell.classList.contains('past') || cell.classList.contains('unavail')) return;
      if (checkin && !checkout) {
        const newKey = cell.dataset.key;
        if (newKey !== hoverKey) {
          hoverKey = newKey;
          patchHoverClasses();
        }
      }
    });
    grid.addEventListener('mouseleave', () => {
      if (hoverKey !== null) {
        hoverKey = null;
        patchHoverClasses();
      }
    });
    monthEl.appendChild(grid);
    wrap.appendChild(monthEl);
  }
}
function applyRangeClass(cell, dt, key) {
  if (!checkin || !checkout) return;
  const lo = checkin < checkout ? checkin : checkout;
  const hi = checkin < checkout ? checkout : checkin;
  if (dt > lo && dt < hi) cell.classList.add('in-range');
}
function patchHoverClasses() {
  const hoverDt = hoverKey ? parseKey(hoverKey) : null;
  document.querySelectorAll('.day[data-key]').forEach(cell => {
    const key = cell.dataset.key;
    const dt  = parseKey(key);
    cell.classList.remove('in-range', 'hover-blocked', 'hover-over-max');
    if (!checkin || checkout || !hoverDt) return;
    const lo = checkin < hoverDt ? checkin  : hoverDt;
    const hi = checkin < hoverDt ? hoverDt  : checkin;
    if (dt > lo && dt < hi) {
      if (rangeExceedsMax(checkin, hoverDt)) {
        cell.classList.add('hover-over-max');
      } else if (rangeIsBlocked(checkin, hoverDt)) {
        cell.classList.add('hover-blocked');
      } else {
        cell.classList.add('in-range');
      }
    }
    if (key === hoverKey) {
      if (rangeExceedsMax(checkin, hoverDt)) cell.classList.add('hover-over-max');
      else if (rangeIsBlocked(checkin, hoverDt)) cell.classList.add('hover-blocked');
    }
  });
}
function handleDateClick(dt) {
  if (!checkin || checkout) {
    checkin = dt; checkout = null; hoverKey = null;
    clearErr();
  } else {
    if (dt <= checkin || rangeIsBlocked(checkin, dt)) {
      // Reset and start a new selection from this date
      checkin = dt; checkout = null;
      clearErr();
    } else if (rangeExceedsMax(checkin, dt)) {
      showErr(`Maximum stay is ${MAX_NIGHTS} nights. Please choose a closer checkout date.`);
      return;
    } else {
      checkout = dt; hoverKey = null;
      clearErr();
    }
  }
  updateSummary();
  renderCalendar();
}

async function updateCalendarView() {
    await fetchMonthData(viewYear, viewMonth);
    
    let nextMonth = viewMonth + 1;
    let nextYear = viewYear;
    if (nextMonth > 11) {
        nextMonth = 0;
        nextYear++;
    }
    await fetchMonthData(nextYear, nextMonth);

    calculateAndSetUnavailableDates();
    renderCalendar();
}

document.getElementById('cal-prev').addEventListener('click', () => {
  let nm = viewMonth - 1, ny = viewYear;
  if (nm < 0) { nm = 11; ny--; }
  if (new Date(ny, nm, 1) < new Date(today.getFullYear(), today.getMonth(), 1)) return;
  viewMonth = nm; viewYear = ny;
  updateCalendarView();
});
document.getElementById('cal-next').addEventListener('click', () => {
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  updateCalendarView();
});
function fmtDate(d) { return d ? `${MONTHS[d.getMonth()].slice(0,3)} ${d.getDate()}, ${d.getFullYear()}` : null; }
function updateSummary() {
  const ci = document.getElementById('sum-checkin'), co = document.getElementById('sum-checkout'), ni = document.getElementById('sum-nights');
  ci.textContent = checkin ? fmtDate(checkin) : '— select date';
  ci.classList.toggle('empty-val', !checkin);
  co.textContent = checkout ? fmtDate(checkout) : '— select date';
  co.classList.toggle('empty-val', !checkout);
  if (checkout) {
    const nights = Math.round((checkout - checkin) / 86400000);
    ni.textContent = `${nights} night${nights !== 1 ? 's' : ''}`;
    ni.classList.remove('empty-val');
  } else {
    ni.textContent = '—';
    ni.classList.add('empty-val');
  }
}

// --- Guest Counter Logic ---
let guests = 2;
const gVal = document.getElementById('guests-val');
function updateGuests(newGuestValue) {
    guests = newGuestValue;
    gVal.textContent = guests;

    if (rangeIsBlocked(checkin, checkout)) {
        checkin = null;
        checkout = null;
        updateSummary();
    }

    calculateAndSetUnavailableDates();
    renderCalendar();
}
document.getElementById('guests-minus').addEventListener('click', () => { if (guests > 1) updateGuests(guests - 1); });
document.getElementById('guests-plus').addEventListener('click', () => { if (guests < 20) updateGuests(guests + 1); });


const errEl  = document.getElementById('error-msg'), sucEl  = document.getElementById('success-msg'), btn = document.getElementById('submit-btn');
function showErr(msg) { errEl.textContent = msg; errEl.classList.add('visible'); sucEl.classList.remove('visible'); }
function clearErr() { errEl.classList.remove('visible'); sucEl.classList.remove('visible'); }


btn.addEventListener('click', async () => {
  clearErr();
  const name  = document.getElementById('name').value.trim(),
        email = document.getElementById('email').value.trim(),
        notes = document.getElementById('notes').value.trim();
  
  if (!checkin || !checkout) return showErr('Please select check-in and check-out dates.');
  if (!name) return showErr('Please enter your full name.');

  // Final guard — belt-and-suspenders in case state somehow got out of sync
  const nights = Math.round((checkout - checkin) / 86400000);
  if (nights > MAX_NIGHTS) return showErr(`Maximum stay is ${MAX_NIGHTS} nights.`);
  
  btn.classList.add('loading'); btn.disabled = true;
  
  const payload = {
      checkin: dateKey(checkin),
      checkout: dateKey(checkout),
      guests,
      name,
      email,
      notes,
      invitationCode: sessionStorage.getItem('otcCode') || null
  };
  
  try {
    const response = await invokeBookingRequestLambda(payload);
    
    if (!response.statusCode || response.statusCode !== 200) {
        throw new Error(response.body || 'Booking failed. Please try again.');
    }

    sucEl.textContent = "Success! Your booking request has been sent and is now pending approval."
    sucEl.classList.add('visible');

    sessionStorage.removeItem('idToken');
    sessionStorage.removeItem('userEmail');
    sessionStorage.removeItem('code');

    window.location.href = window.AppConfig.HOST_URL + `status.html?id=${JSON.parse(response.body).bookingId}`;

  } catch (err) {
    showErr(err.message);
  } finally {
    btn.classList.remove('loading'); btn.disabled = false;
  }
});

// ── Boot ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateCalendarView();
});