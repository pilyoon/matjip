const CATS = { 한식: '🍚', 양식: '🍝', 중식: '🥟', 일식: '🍣', 샐러드: '🥗', 카페: '☕', 베이커리: '🥐', 기타: '🍴' };
const TICKETS = ['식권대장', '비플페이', '법카조르기'];
const TICKET_CLS = { 식권대장: 'dk', 비플페이: 'bp', 법카조르기: 'wish' }; // 핀·칩 색상 (식권대장=초록, 비플페이=삼성블루, 법카조르기=금색)
const pinCls = (p) => {
  const dk = p.tickets.includes('식권대장');
  const bp = p.tickets.includes('비플페이');
  return dk && bp ? 'both' : dk ? 'dk' : bp ? 'bp' : p.tickets.includes('법카조르기') ? 'wish' : 'none';
};
const SEOUL = { lat: 37.5665, lng: 126.978 };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hide = (id) => $(id).classList.add('hidden');
const show = (id) => $(id).classList.remove('hidden');

// ---------- Supabase ----------
const cfg = window.BABMUCKJA_CONFIG || {};
const configured = cfg.url && cfg.anonKey && !cfg.url.includes('YOUR_');
const sb = configured ? supabase.createClient(cfg.url, cfg.anonKey) : null;

let user = null;
let profile = null;
let places = [];
let filter = '전체'; // 지도 카테고리 필터
let tkFilter = '전체'; // 지도 식권 필터
let channel = null;
let editing = null;
let form = { cat: '한식', rating: 0, tickets: new Set() };

// 카카오맵 객체
let map = null;
let markers = new Map();
let popup = null;
let myDot = null;
let temp = null; // 등록용 드래그 마커
let searchOverlay = null;
let searchPlace = null;
let ps = null;
let geocoder = null;

const approved = () => profile?.status === 'approved';
const ll = (lat, lng) => new kakao.maps.LatLng(lat, lng);
const centerObj = () => { const c = map.getCenter(); return { lat: c.getLat(), lng: c.getLng() }; };

let commentCounts = {};

async function fetchCommentCounts() {
  const { data, error } = await sb.from('comments_public').select('place_id');
  commentCounts = {};
  if (!error) data.forEach((c) => { commentCounts[c.place_id] = (commentCounts[c.place_id] || 0) + 1; });
}

async function fetchPlaces() {
  const [{ data, error }] = await Promise.all([sb.from('places').select('*').order('created_at'), fetchCommentCounts()]);
  if (error) return alert('불러오기 실패: ' + error.message);
  places = data;
  renderMarkers();
}

async function onAuth(session) {
  user = session?.user ?? null;
  profile = null;
  ['sheet-auth', 'sheet-pending'].forEach(hide);
  if (!user) {
    places = [];
    renderMarkers();
    show('sheet-auth');
    return;
  }
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) alert('프로필 조회 실패: ' + error.message);
  profile = data;
  if (!approved()) {
    const rejected = profile?.status === 'rejected';
    $('p-title').textContent = rejected ? '🚫 이용이 제한되었습니다' : '⏳ 계정 준비 중';
    $('p-msg').textContent = rejected ? '이용이 제한된 계정입니다. 관리자에게 문의하세요.'
      : '계정 정보를 확인하지 못했습니다. 아래 새로고침을 눌러 주세요. 계속되면 관리자에게 문의하세요.';
    show('sheet-pending');
    places = [];
    renderMarkers();
    return;
  }
  fetchPlaces();
  if (!channel) {
    channel = sb.channel('places-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'places' }, fetchPlaces)
      .subscribe();
  }
}

// ---------- 로그인 / 가입 신청 ----------
async function authSubmit(signup) {
  const email = $('a-email').value.trim();
  const password = $('a-pw').value;
  const nickname = $('a-nick').value.trim();
  if (!email.includes('@') || password.length < 6) return ($('a-msg').textContent = '이메일(@ 포함)과 6자 이상의 비밀번호를 입력하세요.');
  $('a-msg').textContent = '처리 중...';
  const { data, error } = signup
    ? await sb.auth.signUp({ email, password, options: { data: { nickname } } })
    : await sb.auth.signInWithPassword({ email, password });
  if (error) return ($('a-msg').textContent = error.message);
  // 가입하면 바로 로그인됨 (Supabase의 Confirm email이 꺼져 있어야 함)
  $('a-msg').textContent = signup && !data.session ? '가입은 되었지만 이메일 확인이 켜져 있어 바로 로그인되지 않습니다. 관리자에게 문의하세요.' : '';
}
$('a-login').onclick = () => authSubmit(false);
$('a-signup').onclick = () => authSubmit(true);
$('btn-logout').onclick = () => sb.auth.signOut();
$('p-logout').onclick = () => sb.auth.signOut();
$('p-refresh').onclick = async () => onAuth((await sb.auth.getSession()).data.session);

// ---------- 카카오맵 SDK ----------
function loadKakao() {
  return new Promise((resolve, reject) => {
    if (!cfg.kakaoKey || cfg.kakaoKey.includes('YOUR_')) return reject(new Error('KEY'));
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${cfg.kakaoKey}&libraries=services&autoload=false`;
    s.onload = () => kakao.maps.load(resolve);
    s.onerror = () => reject(new Error('SDK'));
    document.head.appendChild(s);
  });
}

function initMap() {
  map = new kakao.maps.Map($('map'), { center: ll(SEOUL.lat, SEOUL.lng), level: 3 });
  ps = new kakao.maps.services.Places();
  geocoder = new kakao.maps.services.Geocoder();
  kakao.maps.event.addListener(map, 'click', (e) => {
    hide('q-results');
    if (temp) setTemp({ lat: e.latLng.getLat(), lng: e.latLng.getLng() });
    else { closePopup(); closeSearchPin(); }
  });
  kakao.maps.event.addListener(map, 'idle', updateOverlaps); // 이동/확대·축소 후 겹침 다시 계산
  renderMarkers();
  locate(true);
}

function mapError(err) {
  const msg = err.message === 'KEY'
    ? 'config.js에 카카오 JavaScript 키(kakaoKey)를 입력하세요.<br>(SETUP.md 참고)'
    : '카카오맵을 불러오지 못했습니다.<br>키가 올바른지, 카카오 개발자 사이트의 <b>플랫폼 > Web</b>에 현재 접속 주소가 등록되어 있는지 확인하세요.';
  $('map').innerHTML = `<div class="nomap">${msg}</div>`;
}

function locate(zoom = true, silent = false) {
  return new Promise((resolve) => {
    if (!navigator.geolocation || !map) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const me = { lat: p.coords.latitude, lng: p.coords.longitude };
        const pos = ll(me.lat, me.lng);
        if (myDot) myDot.setPosition(pos);
        else {
          const el = document.createElement('div');
          el.className = 'me';
          myDot = new kakao.maps.CustomOverlay({ position: pos, content: el, zIndex: 1 });
          myDot.setMap(map);
        }
        if (zoom) { map.setCenter(pos); map.setLevel(3); }
        resolve(me);
      },
      () => { if (!silent) alert('위치 정보를 가져올 수 없습니다. 브라우저의 위치 권한과 HTTPS 접속 여부를 확인하세요.'); resolve(null); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

function moveTo(lat, lng, level = 3) {
  map.setLevel(level);
  map.setCenter(ll(lat, lng));
}

// ---------- 마커 / 팝업 / 필터 ----------
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const visible = () => places.filter((p) => (filter === '전체' || p.cat === filter) && (tkFilter === '전체' || p.tickets.includes(tkFilter)));

function popupHtml(p) {
  return `<div class="pop">
    <h4>${CATS[p.cat]} ${esc(p.name)}</h4>
    <div class="rate">${stars(p.rating)}</div>
    <div class="meta">${esc(p.cat)} · 등록: ${esc(p.author || '익명')}</div>
    <div>${p.tickets.length ? p.tickets.map((t) => `<span class="tk ${TICKET_CLS[t] || ''}">${esc(t)}</span>`).join('') : '<span class="meta">식권 정보 없음</span>'}</div>
    ${p.memo ? `<div class="meta">${esc(p.memo)}</div>` : ''}
    <div class="acts"><button class="link" data-act="comments" data-id="${p.id}">💬 댓글${commentCounts[p.id] ? ` (${commentCounts[p.id]})` : ''}</button><button class="link" data-act="edit" data-id="${p.id}">수정</button><button class="link" data-act="del" data-id="${p.id}">삭제</button></div>
  </div>`;
}

function overlay(pos, el, extra = {}) {
  const o = new kakao.maps.CustomOverlay({ position: pos, content: el, yAnchor: 1, xAnchor: 0.5, clickable: true, ...extra });
  o.setMap(map);
  return o;
}

function openPopup(p) {
  closePopup();
  closeSearchPin();
  const el = document.createElement('div');
  el.className = 'kwrap';
  el.innerHTML = `<div class="kcard"><button class="x" data-act="close">✕</button>${popupHtml(p)}</div>`;
  popup = overlay(ll(p.lat, p.lng), el, { zIndex: 10 });
}
function closePopup() { popup?.setMap(null); popup = null; }

function showSearchPin(s) {
  closeSearchPin();
  closePopup();
  searchPlace = s;
  const el = document.createElement('div');
  el.className = 'kwrap s';
  el.innerHTML = `<div class="kcard"><button class="x" data-act="sclose">✕</button>
    <h4>📍 ${esc(s.name)}</h4><div class="meta">${esc(s.addr || '')}</div>
    ${approved() ? '<button class="btn-main" data-act="reg" style="margin-top:8px;padding:9px">＋ 이 장소로 맛집 등록</button>' : ''}</div><div class="sdot"></div>`;
  searchOverlay = overlay(ll(s.lat, s.lng), el, { zIndex: 11 });
  moveTo(s.lat, s.lng);
}
function closeSearchPin() { searchOverlay?.setMap(null); searchOverlay = null; }

// 겹친 핀 묶음: 화면(픽셀) 기준으로 핀끼리 겹치면 같은 묶음. 묶음의 핀을 누르면 목록으로 함께 보여준다.
let groupOf = new Map(); // place id -> 같은 묶음의 place 배열
const PIN_SIZE = 34;

function updateOverlaps() {
  if (!map) return;
  const proj = map.getProjection();
  const items = visible().map((p) => ({ p, pt: proj.containerPointFromCoords(ll(p.lat, p.lng)) }));
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (Math.abs(items[i].pt.x - items[j].pt.x) < PIN_SIZE && Math.abs(items[i].pt.y - items[j].pt.y) < PIN_SIZE) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it.p);
  });
  groupOf = new Map();
  groups.forEach((g) => g.forEach((p) => groupOf.set(p.id, g)));
  markers.forEach(({ el }, id) => {
    const n = groupOf.get(id)?.length || 1;
    const bdg = el.querySelector('.bdg');
    bdg.textContent = n;
    bdg.classList.toggle('hidden', n < 2);
  });
}

function openGroup(g, at) {
  closePopup();
  closeSearchPin();
  const el = document.createElement('div');
  el.className = 'kwrap';
  const list = [...g].sort((a, b) => b.rating - a.rating)
    .map((p) => `<div class="item" data-act="gpick" data-id="${p.id}"><div><div class="t">${CATS[p.cat]} ${esc(p.name)}</div>
      <div class="s">${esc(p.cat)} · ${p.tickets.map(esc).join(', ') || '식권 정보 없음'}</div></div><div class="rate" style="color:#ffb400">${stars(p.rating)}</div></div>`).join('');
  el.innerHTML = `<div class="kcard glist"><button class="x" data-act="close">✕</button><h4>📍 이 근처 ${g.length}곳</h4><div class="gbody">${list}</div></div>`;
  popup = overlay(ll(at.lat, at.lng), el, { zIndex: 10 });
}

function renderMarkers() {
  if (!map) return;
  markers.forEach(({ o }) => o.setMap(null));
  markers.clear();
  closePopup();
  visible().forEach((p) => {
    const el = document.createElement('div');
    el.className = 'pinwrap';
    el.innerHTML = `<div class="pin ${pinCls(p)}"><span>${CATS[p.cat]}</span></div><div class="bdg hidden"></div>`;
    el.onclick = () => {
      const g = groupOf.get(p.id);
      if (g && g.length > 1) openGroup(g, p);
      else openPopup(p);
    };
    markers.set(p.id, { o: overlay(ll(p.lat, p.lng), el, { zIndex: 2 }), el });
  });
  updateOverlaps();
  if (!$('sheet-list').classList.contains('hidden')) renderList();
}

function renderFilters() {
  $('filters').innerHTML = ['전체', ...Object.keys(CATS)]
    .map((c) => `<div class="chip ${c === filter ? 'on' : ''}" data-c="${c}">${CATS[c] || ''} ${c}</div>`).join('');
}
function renderTFilters() {
  $('tfilters').innerHTML = ['전체', ...TICKETS]
    .map((t) => `<div class="chip ${TICKET_CLS[t] || ''} ${t === tkFilter ? 'on' : ''}" data-t="${t}">${t === '전체' ? '🎫 식권 전체' : t}</div>`).join('');
}
$('filters').onclick = (e) => {
  const c = e.target.closest('.chip')?.dataset.c;
  if (!c) return;
  filter = c;
  renderFilters();
  renderMarkers();
};
$('tfilters').onclick = (e) => {
  const t = e.target.closest('.chip')?.dataset.t;
  if (!t) return;
  tkFilter = t;
  renderTFilters();
  renderMarkers();
};

// 팝업·검색핀 안의 버튼 처리
$('map').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'close') return closePopup();
  if (act === 'sclose') return closeSearchPin();
  if (act === 'reg') {
    const s = searchPlace;
    closeSearchPin();
    return approved() && openForm(null, s);
  }
  const p = places.find((x) => x.id === b.dataset.id);
  if (!p || !approved()) return;
  if (act === 'gpick') return openPopup(p); // 겹침 목록에서 하나 선택 → 상세 말풍선
  if (act === 'comments') return openComments(p);
  closePopup();
  if (act === 'edit') openForm(p);
  else if (act === 'del' && confirm(`'${p.name}'을(를) 삭제할까요?`)) {
    const { error } = await sb.from('places').delete().eq('id', p.id);
    if (error) alert('삭제 실패: ' + error.message);
    else fetchPlaces();
  }
});

// ---------- 장소 검색 (카카오 Local) ----------
const normKw = (d) => ({ name: d.place_name, addr: d.road_address_name || d.address_name, cat: d.category_name, lat: +d.y, lng: +d.x });
const normAddr = (d) => ({ name: d.address_name, addr: d.road_address?.address_name || '', cat: '', lat: +d.y, lng: +d.x });

function searchPlaces(keyword, cb) {
  if (!map) return cb([]);
  const OK = kakao.maps.services.Status.OK;
  ps.keywordSearch(keyword, (data, status) => {
    if (status === OK) return cb(data.map(normKw));
    geocoder.addressSearch(keyword, (d, s) => cb(s === OK ? d.map(normAddr) : []));
  }, { location: map.getCenter(), size: 8 });
}

function guessCat(c = '') {
  if (/카페|커피|디저트/.test(c)) return '카페';
  if (/제과|베이커리|빵/.test(c)) return '베이커리';
  return ['한식', '양식', '중식', '일식'].find((k) => c.includes(k)) || null;
}

// 1) 지도 상단 검색창: 등록된 맛집 + 장소/주소
let qItems = [];
let qTimer;
function renderQ(mine, found, loading) {
  qItems = [...mine.map((p) => ({ p })), ...found.map((f) => ({ f }))];
  let html = '';
  if (mine.length) html += '<div class="sec">등록된 맛집</div>';
  qItems.forEach((it, i) => {
    if (it.f && !html.includes('장소 검색')) html += '<div class="sec">장소 검색</div>';
    html += it.p
      ? `<div class="item" data-i="${i}"><div><div class="t">${CATS[it.p.cat]} ${esc(it.p.name)}</div><div class="s">${esc(it.p.cat)} · ${stars(it.p.rating)}</div></div></div>`
      : `<div class="item" data-i="${i}"><div><div class="t">${esc(it.f.name)}</div><div class="s">${esc(it.f.addr)}${it.f.cat ? ' · ' + esc(it.f.cat.split(' > ').slice(-1)[0]) : ''}</div></div></div>`;
  });
  if (!qItems.length) html = `<div class="empty">${loading ? '검색 중...' : '검색 결과가 없습니다.'}</div>`;
  $('q-results').innerHTML = html;
  show('q-results');
}
function runSearch() {
  const kw = $('q').value.trim();
  if (!kw) return hide('q-results');
  const k = kw.toLowerCase();
  const mine = places.filter((p) => [p.name, p.cat, p.memo, ...(p.tickets || [])].join(' ').toLowerCase().includes(k)).slice(0, 5);
  renderQ(mine, [], true);
  searchPlaces(kw, (found) => { if ($('q').value.trim() === kw) renderQ(mine, found, false); });
}
$('q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 400); };
$('q').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(qTimer); runSearch(); $('q').blur(); } };
$('q-results').onclick = (e) => {
  const it = qItems[e.target.closest('.item')?.dataset.i];
  if (!it) return;
  hide('q-results');
  if (it.p) { moveTo(it.p.lat, it.p.lng, 2); openPopup(it.p); }
  else showSearchPin(it.f);
};

// 2) 등록 폼 안의 장소 검색
let fItems = [];
function formSearch() {
  const kw = $('f-name').value.trim();
  if (!kw) return alert('검색할 식당 이름을 입력하세요.');
  $('f-results').innerHTML = '<div class="empty">검색 중...</div>';
  searchPlaces(kw, (found) => {
    fItems = found;
    $('f-results').innerHTML = found.length
      ? found.map((f, i) => `<div class="item" data-i="${i}"><div><div class="t">${esc(f.name)}</div><div class="s">${esc(f.addr)}</div></div></div>`).join('')
      : '<div class="empty">검색 결과가 없습니다. 지도에서 직접 위치를 지정하세요.</div>';
  });
}
$('f-search').onclick = formSearch;
$('f-name').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); formSearch(); } };
$('f-results').onclick = (e) => {
  const f = fItems[e.target.closest('.item')?.dataset.i];
  if (!f) return;
  $('f-name').value = f.name;
  const cat = guessCat(f.cat);
  if (cat) form.cat = cat;
  renderForm();
  setTemp(f);
  map.setCenter(ll(f.lat, f.lng));
  $('f-results').innerHTML = '';
};

// ---------- 등록/수정 폼 ----------
function renderForm() {
  $('f-cats').innerHTML = Object.keys(CATS)
    .map((c) => `<div class="chip ${c === form.cat ? 'on' : ''}" data-c="${c}">${CATS[c]} ${c}</div>`).join('');
  $('f-stars').innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<span class="${n <= form.rating ? 'on' : ''}" data-n="${n}">★</span>`).join('');
  $('f-tickets').innerHTML = TICKETS
    .map((t) => `<div class="chip ${TICKET_CLS[t]} ${form.tickets.has(t) ? 'on' : ''}" data-t="${t}">${t}</div>`).join('');
}
$('f-cats').onclick = (e) => { const c = e.target.closest('.chip')?.dataset.c; if (c) { form.cat = c; renderForm(); } };
$('f-stars').onclick = (e) => {
  const n = +e.target.dataset.n;
  if (n) { form.rating = n === form.rating ? 0 : n; renderForm(); }
};
$('f-tickets').onclick = (e) => {
  const t = e.target.closest('.chip')?.dataset.t;
  if (!t) return;
  form.tickets.has(t) ? form.tickets.delete(t) : form.tickets.add(t);
  renderForm();
};

function setTemp({ lat, lng }) {
  const pos = ll(lat, lng);
  if (!temp) {
    temp = new kakao.maps.Marker({ position: pos, draggable: true, zIndex: 20 });
    temp.setMap(map);
    kakao.maps.event.addListener(temp, 'dragend', updateCoord);
  } else temp.setPosition(pos);
  updateCoord();
}
function updateCoord() {
  const p = temp.getPosition();
  $('f-coord').textContent = `위치: ${p.getLat().toFixed(5)}, ${p.getLng().toFixed(5)}`;
}

async function openForm(place = null, preset = null) {
  if (!map) return;
  closeList();
  dropComments();
  closePopup();
  closeSearchPin();
  hide('q-results');
  editing = place?.id ?? null;
  form = place
    ? { cat: place.cat, rating: place.rating, tickets: new Set(place.tickets.filter((t) => TICKETS.includes(t))) }
    : { cat: filter !== '전체' ? filter : '한식', rating: 0, tickets: new Set() };
  if (!place && preset?.cat) form.cat = guessCat(preset.cat) || form.cat;
  $('form-title').textContent = place ? '맛집 수정' : '맛집 등록';
  $('f-name').value = place?.name ?? preset?.name ?? '';
  $('f-memo').value = place?.memo ?? '';
  $('f-results').innerHTML = '';
  renderForm();
  show('sheet-form');
  document.body.classList.add('form-open'); // 시트가 지도를 가리지 않도록 지도 영역을 줄임
  map.relayout();
  const start = place || preset || (await locate(false)) || centerObj();
  setTemp(start);
  map.setCenter(ll(start.lat, start.lng));
  if (map.getLevel() > 3) map.setLevel(3);
}
function closeForm() {
  hide('sheet-form');
  document.body.classList.remove('form-open');
  if (temp) { temp.setMap(null); temp = null; }
  editing = null;
  map?.relayout();
}
$('btn-add').onclick = () => approved() && openForm();
$('form-cancel').onclick = closeForm;

$('f-save').onclick = async () => {
  const name = $('f-name').value.trim();
  if (!name) return alert('식당 이름을 입력하세요.');
  if (!form.rating) return alert('별점을 선택하세요.');
  const pos = temp.getPosition();
  const row = { name, cat: form.cat, rating: form.rating, tickets: [...form.tickets], memo: $('f-memo').value.trim(), lat: pos.getLat(), lng: pos.getLng() };
  $('f-save').disabled = true;
  const { error } = editing
    ? await sb.from('places').update(row).eq('id', editing)
    : await sb.from('places').insert({ ...row, author: profile.nickname });
  $('f-save').disabled = false;
  if (error) return alert('저장 실패: ' + error.message);
  closeForm();
  fetchPlaces();
};

// ---------- 익명 댓글 ----------
let cmPlace = null;

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
};

async function loadComments() {
  $('cm-list').innerHTML = '<div class="empty">불러오는 중...</div>';
  const { data, error } = await sb.from('comments_public').select('*').eq('place_id', cmPlace.id).order('created_at');
  if (error) {
    $('cm-list').innerHTML = `<div class="empty">댓글을 불러올 수 없습니다.<br>(schema_comments.sql을 실행했는지 확인하세요)</div>`;
    return;
  }
  commentCounts[cmPlace.id] = data.length;
  $('cm-title').textContent = `💬 ${cmPlace.name} (${data.length})`;
  const isAdmin = !!profile?.is_admin;
  $('cm-list').innerHTML = data.length
    ? data.map((c) => `<div class="cm"><div class="cm-h"><b>익명${c.anon_no}${c.mine ? ' (나)' : ''}</b><span>${ago(c.created_at)}</span>
        ${c.mine || isAdmin ? `<button class="link" data-del="${c.id}">삭제</button>` : ''}</div><div class="cm-b">${esc(c.body)}</div></div>`).join('')
    : '<div class="empty">첫 댓글을 남겨 보세요!</div>';
  $('cm-list').scrollTop = $('cm-list').scrollHeight;
}

async function openComments(p) {
  closeList();
  closeForm();
  closePopup();
  cmPlace = p;
  show('sheet-comments');
  document.body.classList.add('form-open'); // 시트가 지도를 가리지 않도록 지도 영역을 줄임
  map.relayout();
  map.setCenter(ll(p.lat, p.lng));
  $('cm-input').value = '';
  await loadComments();
}
function dropComments() { // 다른 시트가 열릴 때: 말풍선 복원 없이 조용히 닫기
  hide('sheet-comments');
  cmPlace = null;
}
function closeComments() {
  hide('sheet-comments');
  document.body.classList.remove('form-open');
  map?.relayout();
  const p = cmPlace;
  cmPlace = null;
  if (p && map) openPopup(p); // 갱신된 댓글 수로 말풍선 다시 표시
}
$('cm-close').onclick = closeComments;
$('cm-send').onclick = async () => {
  const body = $('cm-input').value.trim();
  if (!body || !cmPlace) return;
  $('cm-send').disabled = true;
  const { error } = await sb.rpc('add_comment', { p_place: cmPlace.id, p_body: body });
  $('cm-send').disabled = false;
  if (error) return alert(error.message);
  $('cm-input').value = '';
  loadComments();
};
$('cm-list').onclick = async (e) => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id || !confirm('이 댓글을 삭제할까요?')) return;
  const { error } = await sb.rpc('delete_comment', { p_id: id });
  if (error) return alert('삭제 실패: ' + error.message);
  loadComments();
};

// ---------- 목록 ----------
const LIST_RADIUS = 2000; // m, 목록은 현재 GPS 위치 기준 반경
let listCat = '전체';
let listTk = '전체';
let listLoc = null; // 목록 열 때 확인한 내 위치 (실패하면 null)
let listLocBusy = false;
const fmtDist = (m) => (m < 950 ? Math.round(m / 10) * 10 + 'm' : (m / 1000).toFixed(1) + 'km');
function renderList() {
  const chips = (items, cur, key) => `<div class="lrow">${items.map((c) =>
    `<div class="chip ${key === 't' ? TICKET_CLS[c] || '' : ''} ${c === cur ? 'on' : ''}" data-${key}="${c}">${key === 'c' ? (CATS[c] || '') + ' ' + c : c === '전체' ? '🎫 식권 전체' : c}</div>`).join('')}</div>`;
  let list = places.filter((p) => (listCat === '전체' || p.cat === listCat) && (listTk === '전체' || p.tickets.includes(listTk)));
  let note;
  if (listLoc) {
    list = list.filter((p) => (p._d = distM(listLoc, p)) <= LIST_RADIUS);
    note = `📍 내 위치 반경 2km 이내 · ${list.length}곳`;
  } else if (listLocBusy) {
    list = [];
    note = '📍 내 위치 확인 중…';
  } else {
    note = '⚠️ 위치를 확인할 수 없어 전체 맛집을 표시합니다. (위치 권한·HTTPS 확인)';
  }
  list.sort((a, b) => b.rating - a.rating);
  $('list-body').innerHTML = chips(['전체', ...Object.keys(CATS)], listCat, 'c') + chips(['전체', ...TICKETS], listTk, 't')
    + `<div class="hint" style="margin:6px 0 2px">${note}</div>`
    + (list.length
      ? list.map((p) => `<div class="item" data-id="${p.id}"><div><div class="t">${CATS[p.cat]} ${esc(p.name)}</div>
        <div class="s">${esc(p.cat)} · ${p.tickets.map(esc).join(', ') || '식권 정보 없음'}${listLoc ? ' · ' + fmtDist(p._d) : ''} · ${esc(p.author || '익명')}</div></div>
        <div class="rate" style="color:#ffb400">${stars(p.rating)}</div></div>`).join('')
      : `<div class="empty">${listLocBusy ? '' : listLoc ? '조건에 맞는 맛집이 없습니다.' : '등록된 맛집이 없습니다.'}</div>`);
}
async function refreshListLoc() {
  listLocBusy = true;
  renderList();
  listLoc = await locate(false, true);
  listLocBusy = false;
  renderList();
}
function closeList() { hide('sheet-list'); }
$('btn-list').onclick = () => {
  if (!$('sheet-list').classList.contains('hidden')) return closeList();
  closeForm();
  dropComments();
  show('sheet-list');
  refreshListLoc();
};
$('list-close').onclick = closeList;
$('list-body').onclick = (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    if (chip.dataset.c) listCat = chip.dataset.c;
    if (chip.dataset.t) listTk = chip.dataset.t;
    return renderList();
  }
  const p = places.find((x) => x.id === e.target.closest('.item')?.dataset.id);
  if (!p || !map) return;
  closeList();
  moveTo(p.lat, p.lng, 2);
  openPopup(p);
};
$('btn-locate').onclick = () => locate(true);

// ---------- 점메추 (랜덤 맛집 추천) ----------
const PICK_EXCLUDE = ['카페', '베이커리']; // 점심 추천 대상에서 제외
let pickCur = null;
let pickLast = null;
let pickTimer;
const PICK_RADIUS = 1000; // m, 현재 GPS 위치 기준 추천 반경
let pickRun = 0;
function distM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pickEmpty(title, sub) {
  const box = $('pick');
  $('pick-title').textContent = title;
  $('pick-sub').textContent = sub;
  box.classList.remove('shuffling');
  $('pick-actions').classList.remove('hidden');
  $('pick-map').classList.add('hidden');
  $('pick-again').classList.remove('hidden');
}
async function startPick() {
  if (!approved()) return;
  const run = ++pickRun;
  const box = $('pick');
  clearTimeout(pickTimer);
  box.classList.remove('hidden', 'reveal', 'shuffling');
  $('result').classList.add('hidden');
  $('pick-actions').classList.add('hidden');
  $('pick-title').textContent = '📍 내 위치 확인 중…';
  $('pick-sub').textContent = '';
  const me = await locate(false, true);
  if (run !== pickRun || $('pick').classList.contains('hidden')) return; // 그 사이 닫힘/재시도
  if (!me) {
    pickEmpty('위치를 확인할 수 없어요 😢', '점메추는 내 위치 반경 1km 안에서 찾아요. 위치 권한을 허용하고(HTTPS 접속) 다시 시도해 주세요.');
    return;
  }
  const base = visible().filter((p) => !PICK_EXCLUDE.includes(p.cat));
  const pool = base.filter((p) => (p._dist = distM(me, p)) <= PICK_RADIUS);
  if (!pool.length) {
    pickEmpty('근처에 맛집이 없어요 😢',
      PICK_EXCLUDE.includes(filter) ? `점메추는 ${PICK_EXCLUDE.join('·')}를 제외하고 추천해요. 다른 카테고리를 선택해 주세요.`
        : base.length ? `내 위치 반경 1km 안에 ${filter === '전체' ? '' : filter + ' '}맛집이 없어요. (카페·베이커리 제외)` : '먼저 식사할 수 있는 맛집을 등록해 주세요. (카페·베이커리 제외)');
    return;
  }
  $('pick-map').classList.remove('hidden');
  $('pick-again').classList.remove('hidden');
  $('pick-title').textContent = '오늘 점심은…?';
  $('pick-sub').textContent = `내 주변 1km 이내 ${filter === '전체' ? '' : filter + ' '}${pool.length}곳 중에서 뽑는 중...`;
  box.classList.add('shuffling');
  pickTimer = setTimeout(() => {
    const cand = pool.length > 1 ? pool.filter((p) => p.id !== pickLast) : pool;
    pickCur = cand[Math.floor(Math.random() * cand.length)];
    pickLast = pickCur.id;
    box.classList.remove('shuffling');
    box.classList.add('reveal');
    setTimeout(showPickResult, 350);
  }, 1800);
}
function showPickResult() {
  const p = pickCur;
  $('result').innerHTML = `<div class="emo">${CATS[p.cat]}</div><div class="nm">${esc(p.name)}</div><div class="rt">${stars(p.rating)}</div>
    <div class="mt">${esc(p.cat)} · 내 위치에서 ${p._dist < 950 ? Math.round(p._dist / 10) * 10 + 'm' : (p._dist / 1000).toFixed(1) + 'km'} · 등록: ${esc(p.author || '익명')}</div>
    <div>${p.tickets.map((t) => `<span class="tk ${TICKET_CLS[t] || ''}">${esc(t)}</span>`).join('')}</div>
    ${p.memo ? `<div class="mt">${esc(p.memo)}</div>` : ''}`;
  $('result').classList.remove('hidden');
  $('pick-title').textContent = '🎉 오늘의 점심!';
  $('pick-sub').textContent = '';
  $('pick-actions').classList.remove('hidden');
}
function closePick() {
  pickRun++;
  clearTimeout(pickTimer);
  $('pick').classList.add('hidden');
  $('pick').classList.remove('shuffling', 'reveal');
}
$('btn-pick').onclick = () => { closeList(); closeForm(); dropComments(); startPick(); };
$('pick-again').onclick = startPick;
$('pick-close').onclick = closePick;
$('pick').onclick = (e) => { if (e.target.id === 'pick') closePick(); };
$('pick-map').onclick = () => {
  const p = pickCur;
  closePick();
  if (!p || !map) return;
  moveTo(p.lat, p.lng, 2);
  openPopup(p);
};

// ---------- 시작 ----------
renderFilters();
renderTFilters();
loadKakao().then(initMap).catch(mapError);
if (!configured) {
  show('sheet-auth');
  $('a-msg').textContent = 'config.js에 Supabase URL과 anon key를 입력하세요. (SETUP.md 참고)';
} else {
  sb.auth.getSession().then(({ data }) => onAuth(data.session));
  sb.auth.onAuthStateChange((_e, session) => onAuth(session));
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
