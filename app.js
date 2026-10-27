const CATS = { 한식: '🍚', 양식: '🍝', 중식: '🥟', 일식: '🍣', 카페: '☕', 베이커리: '🥐', 기타: '🍴' };
const TICKETS = ['식권대장', '비플페이'];
const TICKET_CLS = { 식권대장: 'dk', 비플페이: 'bp' }; // 핀·칩 색상 (식권대장=초록, 비플페이=삼성블루)
const pinCls = (p) => {
  const dk = p.tickets.includes('식권대장');
  const bp = p.tickets.includes('비플페이');
  return dk && bp ? 'both' : dk ? 'dk' : bp ? 'bp' : 'none';
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
let filter = '전체';
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

async function fetchPlaces() {
  const { data, error } = await sb.from('places').select('*').order('created_at');
  if (error) return alert('불러오기 실패: ' + error.message);
  places = data;
  renderMarkers();
}

async function onAuth(session) {
  user = session?.user ?? null;
  profile = null;
  ['sheet-auth', 'sheet-pending', 'sheet-admin'].forEach(hide);
  if (!user) {
    places = [];
    renderMarkers();
    show('sheet-auth');
    return;
  }
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) alert('프로필 조회 실패: ' + error.message);
  profile = data;
  $('btn-admin').classList.toggle('hidden', !(approved() && profile.is_admin));
  if (!approved()) {
    const rejected = profile?.status === 'rejected';
    $('p-title').textContent = rejected ? '🚫 가입이 거절되었습니다' : '⏳ 승인 대기 중';
    $('p-msg').textContent = rejected ? '이용이 제한된 계정입니다. 관리자에게 문의하세요.'
      : `${profile?.nickname ?? ''}님, 메일로 받은 인증 링크를 누르면 바로 이용할 수 있습니다. 인증 후 아래 새로고침을 눌러 주세요.`;
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
  if (!email || password.length < 6) return ($('a-msg').textContent = '이메일과 6자 이상의 비밀번호를 입력하세요.');
  if (signup && !nickname) return ($('a-msg').textContent = '별명을 입력하세요.');
  $('a-msg').textContent = '처리 중...';
  const { data, error } = signup
    ? await sb.auth.signUp({ email, password, options: { data: { nickname }, emailRedirectTo: location.origin + location.pathname } })
    : await sb.auth.signInWithPassword({ email, password });
  if (error) return ($('a-msg').textContent = error.message);
  $('a-msg').textContent = signup && !data.session ? '가입 완료! 메일로 온 인증 링크를 누른 뒤 로그인하세요.' : '';
}
$('a-login').onclick = () => authSubmit(false);
$('a-signup').onclick = () => authSubmit(true);
$('btn-logout').onclick = () => sb.auth.signOut();
$('p-logout').onclick = () => sb.auth.signOut();
$('p-refresh').onclick = async () => onAuth((await sb.auth.getSession()).data.session);

// ---------- 관리자: 가입 승인 ----------
async function renderAdmin() {
  const { data, error } = await sb.from('profiles').select('*').eq('is_admin', false).order('created_at', { ascending: false });
  if (error) return ($('admin-body').textContent = error.message);
  const label = { pending: '대기', approved: '승인됨', rejected: '거절됨' };
  const order = { pending: 0, approved: 1, rejected: 2 };
  data.sort((a, b) => order[a.status] - order[b.status]);
  $('admin-body').innerHTML = data.length
    ? data.map((m) => `<div class="item"><div><div class="t">${esc(m.nickname)} <span class="s">(${label[m.status]})</span></div>
        <div class="s">${esc(m.email)}</div></div>
        <div>${m.status !== 'approved' ? `<button class="link" data-id="${m.id}" data-s="approved">승인</button>` : ''}
        ${m.status !== 'rejected' ? `<button class="link" data-id="${m.id}" data-s="rejected">${m.status === 'approved' ? '차단' : '거절'}</button>` : ''}</div></div>`).join('')
    : '<div class="empty">가입 신청이 없습니다.</div>';
}
$('btn-admin').onclick = () => { closeList(); show('sheet-admin'); renderAdmin(); };
$('admin-close').onclick = () => hide('sheet-admin');
$('admin-body').onclick = async (e) => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  const { error } = await sb.from('profiles').update({ status: b.dataset.s }).eq('id', b.dataset.id);
  if (error) alert('변경 실패: ' + error.message);
  renderAdmin();
};

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
  renderMarkers();
  locate(true);
}

function mapError(err) {
  const msg = err.message === 'KEY'
    ? 'config.js에 카카오 JavaScript 키(kakaoKey)를 입력하세요.<br>(SETUP.md 참고)'
    : '카카오맵을 불러오지 못했습니다.<br>키가 올바른지, 카카오 개발자 사이트의 <b>플랫폼 > Web</b>에 현재 접속 주소가 등록되어 있는지 확인하세요.';
  $('map').innerHTML = `<div class="nomap">${msg}</div>`;
}

function locate(zoom = true) {
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
      () => { alert('위치 정보를 가져올 수 없습니다. 브라우저의 위치 권한과 HTTPS 접속 여부를 확인하세요.'); resolve(null); },
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
const visible = () => places.filter((p) => filter === '전체' || p.cat === filter);

function popupHtml(p) {
  return `<div class="pop">
    <h4>${CATS[p.cat]} ${esc(p.name)}</h4>
    <div class="rate">${stars(p.rating)}</div>
    <div class="meta">${esc(p.cat)} · 등록: ${esc(p.author || '익명')}</div>
    <div>${p.tickets.length ? p.tickets.map((t) => `<span class="tk ${TICKET_CLS[t] || ''}">${esc(t)}</span>`).join('') : '<span class="meta">식권 정보 없음</span>'}</div>
    ${p.memo ? `<div class="meta">${esc(p.memo)}</div>` : ''}
    <div class="acts"><button class="link" data-act="edit" data-id="${p.id}">수정</button><button class="link" data-act="del" data-id="${p.id}">삭제</button></div>
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

function renderMarkers() {
  if (!map) return;
  markers.forEach((o) => o.setMap(null));
  markers.clear();
  closePopup();
  visible().forEach((p) => {
    const el = document.createElement('div');
    el.innerHTML = `<div class="pin ${pinCls(p)}"><span>${CATS[p.cat]}</span></div>`;
    el.onclick = () => openPopup(p);
    markers.set(p.id, overlay(ll(p.lat, p.lng), el, { zIndex: 2 }));
  });
  if (!$('sheet-list').classList.contains('hidden')) renderList();
}

function renderFilters() {
  $('filters').innerHTML = ['전체', ...Object.keys(CATS)]
    .map((c) => `<div class="chip ${c === filter ? 'on' : ''}" data-c="${c}">${CATS[c] || ''} ${c}</div>`).join('');
}
$('filters').onclick = (e) => {
  const c = e.target.closest('.chip')?.dataset.c;
  if (!c) return;
  filter = c;
  renderFilters();
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

// ---------- 목록 ----------
function renderList() {
  const list = visible().sort((a, b) => b.rating - a.rating);
  $('list-body').innerHTML = list.length
    ? list.map((p) => `<div class="item" data-id="${p.id}"><div><div class="t">${CATS[p.cat]} ${esc(p.name)}</div>
        <div class="s">${esc(p.cat)} · ${p.tickets.map(esc).join(', ') || '식권 정보 없음'} · ${esc(p.author || '익명')}</div></div>
        <div class="rate" style="color:#ffb400">${stars(p.rating)}</div></div>`).join('')
    : '<div class="empty">등록된 맛집이 없습니다.</div>';
}
function closeList() { hide('sheet-list'); }
$('btn-list').onclick = () => {
  if (!$('sheet-list').classList.contains('hidden')) return closeList();
  closeForm();
  renderList();
  show('sheet-list');
};
$('list-close').onclick = closeList;
$('list-body').onclick = (e) => {
  const p = places.find((x) => x.id === e.target.closest('.item')?.dataset.id);
  if (!p || !map) return;
  closeList();
  moveTo(p.lat, p.lng, 2);
  openPopup(p);
};
$('btn-locate').onclick = () => locate(true);

// ---------- 점메추 (랜덤 맛집 추천) ----------
let pickCur = null;
let pickLast = null;
let pickTimer;
function startPick() {
  if (!approved()) return;
  const pool = visible();
  const box = $('pick');
  box.classList.remove('hidden', 'reveal');
  $('result').classList.add('hidden');
  $('pick-actions').classList.add('hidden');
  if (!pool.length) {
    $('pick-title').textContent = '등록된 맛집이 없어요 😢';
    $('pick-sub').textContent = filter === '전체' ? '먼저 맛집을 등록해 주세요.' : `'${filter}' 카테고리에 등록된 맛집이 없어요.`;
    box.classList.remove('shuffling');
    $('pick-actions').classList.remove('hidden');
    $('pick-map').classList.add('hidden');
    $('pick-again').classList.add('hidden');
    return;
  }
  $('pick-map').classList.remove('hidden');
  $('pick-again').classList.remove('hidden');
  $('pick-title').textContent = '오늘 점심은…?';
  $('pick-sub').textContent = filter === '전체' ? `등록된 ${pool.length}곳 중에서 뽑는 중...` : `${filter} ${pool.length}곳 중에서 뽑는 중...`;
  box.classList.add('shuffling');
  clearTimeout(pickTimer);
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
    <div class="mt">${esc(p.cat)} · 등록: ${esc(p.author || '익명')}</div>
    <div>${p.tickets.map((t) => `<span class="tk ${TICKET_CLS[t] || ''}">${esc(t)}</span>`).join('')}</div>
    ${p.memo ? `<div class="mt">${esc(p.memo)}</div>` : ''}`;
  $('result').classList.remove('hidden');
  $('pick-title').textContent = '🎉 오늘의 점심!';
  $('pick-sub').textContent = '';
  $('pick-actions').classList.remove('hidden');
}
function closePick() {
  clearTimeout(pickTimer);
  $('pick').classList.add('hidden');
  $('pick').classList.remove('shuffling', 'reveal');
}
$('btn-pick').onclick = () => { closeList(); closeForm(); startPick(); };
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

// ---------- 홈 화면에 추가 (PWA) ----------
// 이미지 파일을 쓰지 않으므로 아이콘은 기기 기본 모양(앱 이름 첫 글자 등)으로 표시된다
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const ua = navigator.userAgent;
const isIOS = /iphone|ipad|ipod/i.test(ua);
if (!isStandalone()) show('btn-install');
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; hide('btn-install'); hide('sheet-install'); });
$('btn-install').onclick = async () => {
  if (installEvt) { // Android/Chrome: 바로 설치창
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null;
    return;
  }
  $('install-body').innerHTML = isIOS
    ? `<ol><li>Safari 하단의 <b>공유(⬆️)</b> 버튼을 누릅니다.</li><li><b>홈 화면에 추가</b>를 선택합니다.</li><li>오른쪽 위 <b>추가</b>를 누르면 완료!</li></ol>
       <p class="hint">※ iPhone은 반드시 <b>Safari</b>에서 열어야 합니다. (카카오톡·네이버 앱 내 브라우저에서는 불가)</p>`
    : `<ol><li>브라우저 우측 상단 <b>⋮ 메뉴</b>를 엽니다.</li><li><b>홈 화면에 추가</b> 또는 <b>앱 설치</b>를 선택합니다.</li></ol>
       <p class="hint">※ HTTPS 주소(배포된 주소)에서만 설치할 수 있습니다. 카카오톡 등 앱 내 브라우저라면 Chrome/Safari로 열어 주세요.</p>`;
  show('sheet-install');
};
$('install-close').onclick = () => hide('sheet-install');

// ---------- 시작 ----------
renderFilters();
loadKakao().then(initMap).catch(mapError);
if (!configured) {
  show('sheet-auth');
  $('a-msg').textContent = 'config.js에 Supabase URL과 anon key를 입력하세요. (SETUP.md 참고)';
} else {
  sb.auth.getSession().then(({ data }) => onAuth(data.session));
  sb.auth.onAuthStateChange((_e, session) => onAuth(session));
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
