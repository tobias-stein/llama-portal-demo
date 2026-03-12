import '../config.js';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";
/* ── constants ────────────────────────────────── */
const AWS_REGION         = window.AppConfig.REGION || 'eu-central-1';
const TABLE_NAME         = window.AppConfig.DB.TABLE_NAME || 'LlamaBookings';
// GSI with partition key = "email" (String), sort key = "checkin" (String)
// Create this in DynamoDB: Table → Indexes → Create GSI
const GSI2 = 'GSI2';
/* ── DynamoDB client (unauthenticated) ────────── */
function makeDocClient() {
  const credentials = fromCognitoIdentityPool({
    clientConfig: { region: AWS_REGION },
    identityPoolId: window.AppConfig.IDENTITY_POOL_ID,
  });
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: AWS_REGION, credentials })
  );
}
/* ── helpers ──────────────────────────────────── */
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_LONG    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function parseLocalDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(str) {
  const d = parseLocalDate(str);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtDow(str) { return DAYS_LONG[parseLocalDate(str).getDay()]; }
function nightsBetween(a, b) {
  return Math.round((parseLocalDate(b) - parseLocalDate(a)) / 86400000);
}
/* ── state machine ────────────────────────────── */
const ALL_STATES = ['state-loading','state-error','state-search','state-booking'];
function setVisible(id) {
  ALL_STATES.forEach(s => {
    const el = document.getElementById(s);
    el.style.display = (s === id) ? (s === 'state-booking' ? 'block' : 'flex') : 'none';
  });
}
/* ── populate booking card ────────────────────── */
function populate(item) {
  const status    = (item.status || 'PENDING').toUpperCase();
  const statusLow = status.toLowerCase();
  document.getElementById('card-glow').className = `card-glow ${statusLow}`;
  const badge = document.getElementById('bk-status-badge');
  badge.className = `status-badge ${statusLow}`;
  document.getElementById('bk-status-text').textContent =
    status.charAt(0) + status.slice(1).toLowerCase();
  document.getElementById('bk-checkin').textContent      = fmtDate(item.checkin);
  document.getElementById('bk-checkin-dow').textContent  = fmtDow(item.checkin);
  document.getElementById('bk-checkout').textContent     = fmtDate(item.checkout);
  document.getElementById('bk-checkout-dow').textContent = fmtDow(item.checkout);
  document.getElementById('bk-nights').textContent       = nightsBetween(item.checkin, item.checkout);
  document.getElementById('bk-name').textContent   = item.name || '—';
  document.getElementById('bk-guests').textContent = item.guests
    ? `${item.guests} guest${item.guests > 1 ? 's' : ''}`
    : '—';
  if (item.notes && item.notes.trim()) {
    document.getElementById('bk-notes').textContent        = item.notes.trim();
    document.getElementById('bk-notes-cell').style.display = '';
  } else {
    document.getElementById('bk-notes-cell').style.display = 'none';
  }
  const rawId = item.PK ? item.PK.replace('BOOKING#', '') : '';
  document.getElementById('bk-id').textContent = rawId;
  setVisible('state-booking');
}
/* ── fetch by direct ID ───────────────────────── */
async function fetchBookingById(id) {
  const ddb = makeDocClient();
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `BOOKING#${id}`, SK: 'META' },
  }));
  return result.Item || null;
}
/* ── fetch by email + check-in (GSI query) ────── */
async function fetchBookingBySearch(email, code) {
  const ddb = makeDocClient();
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',                                       
    KeyConditionExpression: 'GSI2PK = :email AND GSI2SK = :invitationCode',
    FilterExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: {
        ':email':   email.toLowerCase().trim(),                
        ':invitationCode': code,                       
        ':prefix':  'BOOKING#',
    },
    }));
  return result.Items?.[0] || null;
}
/* ── search form ──────────────────────────────── */
function showSearchError(msg) {
  const el = document.getElementById('search-error');
  el.textContent = msg;
  el.classList.add('visible');
}
function clearSearchError() {
  document.getElementById('search-error').classList.remove('visible');
}
document.getElementById('search-btn').addEventListener('click', async () => {
  clearSearchError();
  const email   = document.getElementById('search-email').value.trim();
  const code = document.getElementById('otc-code').value;  // "xxxx-xxxx-xxxx"
  if (!email)   return showSearchError('Please enter your email address.');
  if (!code) return showSearchError('Please enter your invitation code.');
  const btn = document.getElementById('search-btn');
  btn.classList.add('loading');
  btn.disabled = true;
  try {
    const item = await fetchBookingBySearch(email, code);
    if (!item) {
      showSearchError('No booking found for that email and invitation code.');
      return;
    }
    populate(item);
  } catch (err) {
    console.error(err);
    showSearchError(`Search failed: ${err.message}`);
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
});
// Enter key support
['search-email', 'otc-code'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('search-btn').click();
  });
});
// "← search again" link in booking footer
document.getElementById('search-again-btn').addEventListener('click', () => {
  setVisible('state-search');
});
/* ── boot ─────────────────────────────────────── */
async function boot() {
  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) {
    setVisible('state-search');
    return;
  }
  setVisible('state-loading');
  try {
    const item = await fetchBookingById(id);
    if (!item) {
      document.getElementById('error-detail').textContent =
        "We couldn't locate a reservation with that ID. Please check your confirmation email.";
      setVisible('state-error');
      return;
    }
    populate(item);
  } catch (err) {
    console.error(err);
    document.getElementById('error-detail').textContent =
      `An error occurred while loading your booking: ${err.message}`;
    setVisible('state-error');
  }
}
boot();