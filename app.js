// 발로란트 매치 준비 - 실시간 방
// 흐름: 팀장 가위바위보(동시 공개) → 맵 밴픽 (Bo1/Bo3/Bo5, VCT식) 또는 룰렛 → 공격/수비 선택
// 권한: 관리자 링크(adm=시드) 하나에서 팀장 토큰·팀 채팅 키를 모두 파생. 팀장/관리자는 원본 대신 해시 증명만 보냄
//       팀 채팅은 팀 키로 AES-GCM 암호화 → 같은 팀 링크가 있어야 읽을 수 있음
// 중계: 공개 MQTT 브로커 (가입 불필요), 방 하나 = 토픽 valside/v3/<room>/
// 공정성: 가위바위보는 commit-reveal (SHA-256(선택|난수) 먼저 공개 → 둘 다 모이면 공개).
//         맵은 두 팀장의 난수로 결정 → 룰렛을 누르는 사람도 결과를 고를 수 없음
(function () {
  'use strict';
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const ROOT = 'valside/v3/';
  const MAPS = ['어센트', '바인드', '헤이븐', '스플릿', '아이스박스', '브리즈', '프랙처', '펄', '로터스', '선셋', '어비스', '코로드', '서밋'];
  const MAP_IMG = { '어센트': 'ascent', '바인드': 'bind', '헤이븐': 'haven', '스플릿': 'split', '아이스박스': 'icebox', '브리즈': 'breeze', '프랙처': 'fracture', '펄': 'pearl', '로터스': 'lotus', '선셋': 'sunset', '어비스': 'abyss', '코로드': 'corrode', '서밋': 'summit' };
  const mapBg = m => MAP_IMG[m] ? `url(maps/${MAP_IMG[m]}.jpg) center/cover no-repeat, ${mapColor(m)}` : mapColor(m);
  const RPS = [{ em: '✌️', name: '가위' }, { em: '✊', name: '바위' }, { em: '✋', name: '보' }];
  const SIDES = ['A', 'B'];
  const other = s => (s === 'A' ? 'B' : 'A');

  // ---------- 유틸 ----------
  const $ = id => document.getElementById(id);
  const store = (area) => ({
    get(k) { try { return area.getItem(k); } catch { return null; } },
    set(k, v) { try { area.setItem(k, v); } catch {} }
  });
  const ss = store(window.sessionStorage), ls = store(window.localStorage);
  const REACTS = ['🔥', '😂', '😱', '👏', '🫡', '💀'];
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 효과음 (Web Audio 합성, 파일 없음) ----------
  const Sfx = (() => {
    let ctx = null, on = ls.get('vs_snd') !== '0';
    const ensure = () => {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; try { ctx = new AC(); } catch { return null; } }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    };
    document.addEventListener('pointerdown', ensure, { passive: true });
    function tone(f, dur, type = 'sine', vol = 0.15, when = 0, slideTo) {
      if (!on) return; const c = ensure(); if (!c || c.state !== 'running') return;
      const t = c.currentTime + when, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    }
    return {
      get on() { return on; },
      toggle() { on = !on; ls.set('vs_snd', on ? '1' : '0'); if (on) ensure(); return on; },
      tick: () => tone(1500, 0.035, 'square', 0.04),
      thump: () => tone(170, 0.15, 'sine', 0.28, 0, 60),
      reveal: () => { tone(520, 0.12, 'triangle', 0.14); tone(780, 0.2, 'triangle', 0.14, 0.09); },
      win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.28, 'triangle', 0.12, i * 0.09)),
      ping: () => { tone(880, 0.12, 'sine', 0.16); tone(1320, 0.22, 'sine', 0.13, 0.1); },
      ban: () => { tone(220, 0.22, 'sawtooth', 0.09, 0, 90); tone(110, 0.25, 'sine', 0.2); },
      pop: () => tone(640, 0.08, 'sine', 0.05, 0, 1200),
      warn: () => tone(990, 0.06, 'square', 0.05)
    };
  })();
  const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
  const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // 도배 방지: key별로 win(ms) 안에 max번까지만
  const buckets = {};
  const allow = (key, max, win) => {
    const now = Date.now(), a = (buckets[key] = (buckets[key] || []).filter(t => now - t < win));
    if (a.length >= max) return false; a.push(now); return true;
  };
  // 키 파생 (관리자 시드 → 팀장 토큰 → 클레임 증명 / 팀 채팅 키)
  const capTok = async (seed, s, gen) => (await sha(`cap|${s}|${gen}|${seed}`)).slice(0, 16);
  const claimProof = tok => sha('claim|' + tok);
  const teamKeyOf = async tok => (await sha('team|' + tok)).slice(0, 24);
  const admProof = seed => sha('adm|' + seed);
  const b64 = u8 => btoa(String.fromCharCode(...u8));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const aesKey = async k => crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode('aes|' + k)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const FMT_NEED = { 1: 2, 3: 5, 5: 7 };
  // VCT식 밴픽 순서. A = 가위바위보 승자(대회에선 상위 시드), B = 패자
  //  Bo1: 번갈아 밴 → 남은 1개, 마지막 밴 안 한 팀이 진영
  //  Bo3: A밴 B밴 → A픽(B진영) B픽(A진영) → 번갈아 밴 → 결정전(A진영)
  //  Bo5: A밴 B밴 → A픽 B픽 A픽 B픽 (상대가 진영) → 결정전(A진영)
  function vetoSteps(n, fmt, A, B) {
    const st = [];
    if (fmt === 1 || n < FMT_NEED[fmt]) {
      for (let k = 0; k < n - 1; k++) st.push({ a: 'ban', s: k % 2 ? B : A });
      st.push({ a: 'side', s: n > 1 ? other(st[st.length - 1].s) : A, g: 0 });
      return st;
    }
    st.push({ a: 'ban', s: A }, { a: 'ban', s: B });
    const picks = fmt === 3 ? 2 : 4;
    for (let i = 0; i < picks; i++) { const p = i % 2 ? B : A; st.push({ a: 'pick', s: p, g: i }, { a: 'side', s: other(p), g: i }); }
    for (let left = n - 2 - picks, k = 0; left > 1; left--, k++) st.push({ a: 'ban', s: k % 2 ? B : A });
    st.push({ a: 'side', s: A, g: picks });
    return st;
  }
  const ACT = { ban: '밴', pick: '픽', side: '진영 선택' };
  const FRESH_MS = 8000; // 이보다 오래된 이벤트는 애니메이션 없이 바로 표시 (늦게 들어온 사람)

  let cid = ss.get('vs_cid'); if (!cid) { cid = hex(6); ss.set('vs_cid', cid); }
  let nick = ls.get('vs_nick'); if (!nick) { nick = '플레이어' + Math.floor(100 + Math.random() * 900); ls.set('vs_nick', nick); }

  // ---------- 로비 ----------
  const savedPool = (() => { try { return JSON.parse(ls.get('vs_pool')) || MAPS; } catch { return MAPS; } })();
  $('mapPool').innerHTML = MAPS.map(m => `<label class="chip"><input type="checkbox" value="${m}" ${savedPool.includes(m) ? 'checked' : ''}>${m}</label>`).join('');
  const pickedPool = () => [...$('mapPool').querySelectorAll('input:checked')].map(i => i.value);
  const syncPool = () => {
    const n = pickedPool().length;
    ls.set('vs_pool', JSON.stringify(pickedPool()));
    $('poolCount').textContent = `${n} / ${MAPS.length}`;
    $('poolHint').textContent = poolDesc(n, lobbyMode(), lobbyFmt());
  };
  function poolDesc(n, mode, fmt) {
    if (mode !== 'ban') return n < 2 ? '맵 2개 이상 필요' : `룰렛 후보 ${n}개`;
    if (n < FMT_NEED[fmt]) return `Bo${fmt}는 맵 ${FMT_NEED[fmt]}개 이상 필요`;
    if (fmt === 1) return `밴 ${n - 1}번 → 남은 1개로 결정${n > 9 ? ' · 7개 정도 추천' : ''}`;
    const extra = n - 2 - (fmt === 3 ? 2 : 4) - 1;
    return `밴 2 → 픽 ${fmt === 3 ? 2 : 4} → ${extra > 0 ? `밴 ${extra} → ` : ''}결정전 · 총 ${fmt}맵`;
  }
  const setPool = f => { $('mapPool').querySelectorAll('input').forEach((i, k) => (i.checked = f(i.value, k))); syncPool(); };
  $('mapPool').onchange = syncPool;
  $('poolAll').onclick = () => setPool(() => true);
  $('poolNone').onclick = () => setPool(() => false);
  $('poolRand7').onclick = () => {
    const pick = new Set([...MAPS].sort(() => Math.random() - 0.5).slice(0, 7));
    setPool(m => pick.has(m));
  };

  // 모드 / 옵션
  const lobbyMode = () => (document.querySelector('input[name=mode]:checked') || {}).value || 'ban';
  { const m = ls.get('vs_mode'); const el = document.querySelector(`input[name=mode][value="${m}"]`); if (el) el.checked = true; }
  const lobbyFmt = () => +$('fmtSel').value || 1;
  if (ls.get('vs_fmt')) $('fmtSel').value = ls.get('vs_fmt');
  const syncMode = () => {
    ls.set('vs_mode', lobbyMode()); ls.set('vs_fmt', lobbyFmt());
    $('timerRow').classList.toggle('hidden', lobbyMode() !== 'ban'); $('fmtRow').classList.toggle('hidden', lobbyMode() !== 'ban');
    syncPool();
  };
  document.querySelectorAll('input[name=mode]').forEach(i => (i.onchange = syncMode));
  $('fmtSel').onchange = syncMode;
  $('noRep').checked = ls.get('vs_norep') === '1';
  $('noRep').onchange = () => ls.set('vs_norep', $('noRep').checked ? '1' : '0');
  if (ls.get('vs_timer')) $('banTimer').value = ls.get('vs_timer');
  $('banTimer').onchange = () => ls.set('vs_timer', $('banTimer').value);
  syncMode();

  let pendingCreate = null, hostMode = false;
  const admSeed = r => ls.get('vs_adm_' + r);
  function createRoom(pool, teamA, teamB, opts) {
    const r = hex(3), seed = hex(16);
    ls.set('vs_adm_' + r, seed);
    pendingCreate = { seed, pool, teamA, teamB, opts };
    if (hostKey) { history.replaceState(null, '', location.pathname); hostMode = true; myCap = null; join(r); startFollow(); } // 기본 주소로 돌아가 최신 방(=내 방) 따라감
    else location.hash = 'room=' + r;
  }
  // 방 설정(meta): 관리자 시드에서 팀장 해시·관리자 해시를 만들어 넣음
  async function metaFor(seed, gen, o, pool) {
    const hOf = async s => sha(await claimProof(await capTok(seed, s, gen)));
    return { v: 2, gen, hA: await hOf('A'), hB: await hOf('B'), hM: await sha(await admProof(seed)), pool,
      mode: o.mode === 'roulette' ? 'roulette' : 'ban', fmt: [1, 3, 5].includes(+o.fmt) ? +o.fmt : 1,
      noRep: !!o.noRep, timer: Math.min(120, Math.max(0, o.timer | 0)), noReact: !!o.noReact, noChat: !!o.noChat };
  }
  const lobbyOpts = () => ({ mode: lobbyMode(), fmt: lobbyFmt(), noRep: $('noRep').checked, timer: +$('banTimer').value || 0 });
  $('createBtn').onclick = () => {
    const pool = pickedPool(), o = lobbyOpts();
    const need = o.mode === 'ban' ? FMT_NEED[o.fmt] : 2;
    if (pool.length < need) { alert(`맵을 ${need}개 이상 선택`); return; }
    createRoom(pool, $('initA').value.trim() || 'A팀', $('initB').value.trim() || 'B팀', o);
  };

  // 기본 주소 = 최신 방 자동 관전. '최신 방' 알림은 호스트 키(ECDSA)로 서명 → 아무나 바꿔치기 못 함
  const HOST_PUB = { kty: 'EC', crv: 'P-256', x: 'BiWGbuCnaZ-PgXxHB9z2Yi8pFV4O3gxct8lAOAcFSVU', y: 'sbnKr5Y9FSAdgesaqZ_0EFEKZT2TeNXZ94K8aAigzoM' };
  const ECP = { name: 'ECDSA', namedCurve: 'P-256' }, ECS = { name: 'ECDSA', hash: 'SHA-256' }, LIVE_T = ROOT + 'live/main';
  const pubKeyP = crypto.subtle.importKey('jwk', HOST_PUB, ECP, false, ['verify']);
  let hostKey = null; // 서명 키 (호스트 링크로 들어온 브라우저만)
  async function loadHostKey(d) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(d || '')) return null;
    try {
      const k = await crypto.subtle.importKey('jwk', { ...HOST_PUB, d }, ECP, false, ['sign']);
      const m = new TextEncoder().encode('chk|' + d.length);
      return (await crypto.subtle.verify(ECS, await pubKeyP, await crypto.subtle.sign(ECS, k, m), m)) ? k : null;
    } catch { return null; }
  }
  const liveMsg = d => new TextEncoder().encode('live|' + d.room + '|' + d.t);
  async function liveSigned(r) {
    const d = { room: r, t: Date.now() };
    d.sig = b64(new Uint8Array(await crypto.subtle.sign(ECS, hostKey, liveMsg(d))));
    return JSON.stringify(d);
  }
  const liveOk = async d => { try { return await crypto.subtle.verify(ECS, await pubKeyP, unb64(d.sig), liveMsg(d)); } catch { return false; } };
  let follow = null, followOn = false, liveT = 0;
  function startFollow(i = 0) {
    if (followOn && follow && i === 0) return;
    stopFollow(); followOn = true;
    if (!window.mqtt) return;
    const c = window.mqtt.connect(BROKERS[i % BROKERS.length], { clientId: 'vsf_' + cid + '_' + hex(2), clean: true, connectTimeout: 6000, reconnectPeriod: 3000 });
    follow = c; let ok = false;
    c.on('connect', () => { ok = true; c.subscribe(LIVE_T, { qos: 1 }); });
    c.on('error', () => {});
    c.on('message', async (t, b) => {
      if (follow !== c) return;
      let d; try { d = JSON.parse(b.toString()); } catch { return; }
      if (!d || !/^[a-z0-9]{4,12}$/.test(d.room || '') || typeof d.t !== 'number' || typeof d.sig !== 'string' || d.t <= liveT) return;
      if (!(await liveOk(d)) || follow !== c) return;
      liveT = d.t;
      if (d.room !== room && !pendingCreate) { myCap = null; join(d.room); }
    });
    setTimeout(() => { if (!ok && follow === c && i + 1 < BROKERS.length) startFollow(i + 1); }, 7000);
  }
  function stopFollow() { if (follow) { try { follow.end(true); } catch {} } follow = null; followOn = false; }

  // ---------- 방 상태 ----------
  let client = null, room = null, base = '';
  let meta = null;   // { hA, hB, hM, pool, mode, fmt, ... }
  let myCap = null;  // { side, tok }
  let adm = null;    // { seed, ap, ok, toks: {A,B,kA,kB} }
  let myTeam = null; // { side, k, key }  팀 채팅
  let people = {};   // cid -> { name, t, tm }
  let H = [];        // 이 방의 경기 기록
  let S = fresh(null);
  let buffered = [];
  function fresh(round) {
    return { round, n: 0, teamA: 'A팀', teamB: 'B팀', claim: {}, commit: {}, reveal: {}, pend: {},
      res: null, roll: null, side: null, rpsShown: false, rolling: false, rolled: false, tieQueued: false, sent: {},
      pool: null, steps: [], veto: [], games: [], rem: [], pendV: {}, undo: null, force: null, banGridFor: null, animated: {} };
  }
  const isBan = () => !!(meta && meta.mode === 'ban');
  const isAdmin = () => !!(adm && adm.ok);
  const curPool = () => (S.pool && S.pool.length) ? S.pool : (meta && meta.pool && meta.pool.length) ? meta.pool : MAPS;
  const fmtEff = () => { const f = (meta && meta.fmt) || 1; return curPool().length >= FMT_NEED[f] ? f : 1; };
  const curStep = () => (S.res && isBan()) ? S.steps[S.veto.length] || null : null;
  const vetoDone = () => !!(S.res && isBan() && S.steps.length && S.veto.length === S.steps.length);
  // 룰렛 모드: 가위바위보 승자가 진영 선택
  const sidePicker = () => !S.res ? null : S.res.winner;
  const banTurnStart = () => Math.max((S.veto.length ? S.veto[S.veto.length - 1].t : S.resT) || 0, (S.undo && S.undo.t) || 0) || Date.now();
  const ep = () => (S.undo ? S.undo.ep : 0);
  function setRes(res, t) {
    S.res = res; S.resT = t;
    S.steps = isBan() ? vetoSteps(curPool().length, fmtEff(), res.winner, res.loser) : [];
  }
  const verifyAdm = async d => !!(d && typeof d.adm === 'string' && meta && meta.hM && (await sha(d.adm)) === meta.hM);

  // ---------- 입장 ----------
  function parseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const r = (p.get('room') || '').toLowerCase();
    return { r: /^[a-z0-9]{4,12}$/.test(r) ? r : null, cap: p.get('cap'), hk: p.get('host') || null, hostQ: p.has('host'),
      adm: /^[0-9a-f]{32}$/.test(p.get('adm') || '') ? p.get('adm') : null, team: /^[AB]-[0-9a-f]{24}$/.test(p.get('team') || '') ? p.get('team') : null };
  }
  // 공유 링크는 항상 공개 주소(GitHub Pages) 기준 · 로컬에서 열어도 친구가 열 수 있게
  const PUBLIC = 'https://seungjaehh.github.io/valorant-side/';
  const siteBase = () => /^https?:$/.test(location.protocol) && !/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname) ? location.origin + location.pathname : PUBLIC;
  function linkFor(kind) {
    const u = siteBase() + '#room=' + room;
    if (kind === 'view') return u;
    if (kind === 'live') return siteBase();
    if (kind === 'team' && myTeam) return `${u}&team=${myTeam.side}-${myTeam.k}`;
    if (!adm || !adm.toks) return u;
    if (kind === 'adm') return `${u}&adm=${adm.seed}`;
    if (kind === 'A' || kind === 'B') return `${u}&cap=${kind}-${adm.toks[kind]}`;
    if (kind === 'tA' || kind === 'tB') return `${u}&team=${kind[1]}-${adm.toks['k' + kind[1]]}`;
    return u;
  }
  // 관리자 시드 확인 + 팀장 링크·팀 키 파생 (meta 바뀔 때마다)
  async function refreshAuth() {
    const seed = room && admSeed(room);
    if (!seed || !meta) { adm = null; return; }
    const ap = await admProof(seed), ok = (await sha(ap)) === meta.hM, gen = meta.gen | 0;
    const toks = {};
    for (const s of SIDES) { toks[s] = await capTok(seed, s, gen); toks['k' + s] = await teamKeyOf(toks[s]); }
    adm = { seed, ap, ok, toks };
  }
  // 팀 채팅 키: 팀장은 자기 토큰에서, 팀원은 팀 링크에서
  async function setupTeam() {
    const r = room; let side = null, k = null;
    if (myCap && !myCap.bad) { side = myCap.side; k = await teamKeyOf(myCap.tok); }
    else { const t = ls.get('vs_team_' + r); if (t) { side = t[0]; k = t.slice(2); } }
    if (r !== room) return;
    if (!side) { myTeam = null; renderChat(); return; }
    if (myTeam && myTeam.k === k) return;
    myTeam = { side, k, key: await aesKey(k) };
    if (!chatPicked) chatTab = side; // 팀 키가 늦게 준비돼도 기본 탭은 우리 팀
    announce(); renderChat(true);
  }
  function enter() {
    const { r, cap, hk, hostQ, adm: admQ, team } = parseHash();
    $('hostNewBtn').classList.toggle('hidden', !hostKey);
    if (hk) { // 호스트 링크: 키 확인 후 주소창에서 키만 지움 (#host 로 남겨서 방 만들기 화면)
      history.replaceState(null, '', location.pathname + '#host');
      loadHostKey(hk).then(k => { if (k) { hostKey = k; ls.set('vs_hostkey', hk); } else alert('호스트 링크가 올바르지 않아'); enter(); });
      return;
    }
    if (hostQ && hostKey) { // 호스트: 방 만들기 화면
      hostMode = true; stopFollow();
      room = null; if (client) { try { client.end(true); } catch {} client = null; }
      $('lobby').classList.remove('hidden'); $('room').classList.add('hidden');
      return;
    }
    if (!r) { // 기본 주소: 최신 방 자동 관전 (호스트는 방이 없으면 방 만들기)
      hostMode = !!hostKey;
      startFollow();
      if (!room) {
        $('lobby').classList.add('hidden'); $('room').classList.remove('hidden');
        $('rmCode').textContent = '…'; $('rpsMsg').textContent = hostMode ? '방 불러오는 중…' : '방 생성 대기 중 · 방이 열리면 자동으로 들어가';
        $('myRole').textContent = hostMode ? '🛠️ 호스트' : '📌 최신 방 자동 관전';
        if (hostMode) setTimeout(() => { if (hostMode && !room) { $('lobby').classList.remove('hidden'); $('room').classList.add('hidden'); } }, 4000);
      }
      return;
    }
    hostMode = false;
    stopFollow();
    if (hostQ) { history.replaceState(null, '', location.pathname); enter(); return; } // 키 없는 #host = 기본 주소
    const capOk = cap && /^[AB]-[0-9a-f]{16}$/.test(cap);
    if (capOk) ss.set('vs_cap_' + r, cap);
    if (admQ) ls.set('vs_adm_' + r, admQ);
    if (team) ls.set('vs_team_' + r, team);
    if (capOk || admQ || team) history.replaceState(null, '', location.pathname + '#room=' + r); // 화면 공유 때 코드 노출 방지
    const saved = ss.get('vs_cap_' + r);
    myCap = saved ? { side: saved[0], tok: saved.slice(2) } : null;
    if (r !== room) join(r);
    else { refreshAuth().then(() => { tryClaim(); render(); }); setupTeam(); }
  }
  window.addEventListener('hashchange', enter);

  function join(r) {
    room = r; base = ROOT + r + '/'; meta = null; adm = null; myTeam = null; people = {}; H = []; S = fresh(null); buffered = [];
    loadChat(); renderHistory();
    $('lobby').classList.add('hidden'); $('room').classList.remove('hidden');
    $('rmCode').textContent = r.toUpperCase();
    $('nick').value = nick;
    setupTeam();
    resetArena();
    if (client) { try { client.end(true); } catch {} }
    connect(0);
    render();
    setTimeout(() => { if (room === r && !meta && !pendingCreate) $('rpsMsg').textContent = '방을 찾을 수 없음 · 링크 확인 필요'; }, 7000);
  }

  // ---------- 연결 ----------
  function connect(i) {
    if (!window.mqtt) { setConn('연결 실패', true); return; }
    const presTopic = base + 'p/' + cid;
    const c = window.mqtt.connect(BROKERS[i % BROKERS.length], {
      clientId: 'vs_' + cid + '_' + hex(2), clean: true, connectTimeout: 6000, reconnectPeriod: 3000, keepalive: 20,
      will: { topic: presTopic, payload: '', qos: 1, retain: true } // 창 닫으면 참여자 목록에서 빠짐
    });
    client = c;
    let ok = false;
    c.on('connect', async () => {
      ok = true; setConn('● 연결', false);
      c.subscribe(base + '#', { qos: 1 });
      announce();
      if (pendingCreate) {
        const p = pendingCreate; pendingCreate = null;
        pub('meta', await metaFor(p.seed, 0, p.opts || {}, p.pool));
        pub('round', { id: hex(4), n: 1, teamA: p.teamA, teamB: p.teamB });
        if (hostKey) { const r0 = room; liveSigned(r0).then(m => { if (client === c) c.publish(LIVE_T, m, { qos: 1, retain: true }); }); }
      }
    });
    c.on('reconnect', () => setConn('재연결…', true));
    c.on('offline', () => setConn('연결 끊김', true));
    c.on('error', () => {});
    c.on('message', (t, b) => { if (client === c) queue(t, b); });
    setTimeout(() => { if (!ok && client === c && i + 1 < BROKERS.length) { try { c.end(true); } catch {} connect(i + 1); } }, 7000);
  }
  function setConn(t, bad) { const el = $('rmConn'); el.textContent = t; el.classList.toggle('bad', !!bad); }
  const pub = (sub, obj) => client && client.publish(base + sub, JSON.stringify(obj), { qos: 1, retain: true });
  const announce = () => pub('p/' + cid, { name: nick, t: Date.now(), ...(myTeam && !myCap ? { tm: myTeam.side } : {}), ...(isAdmin() ? { ad: 1 } : {}) });
  setInterval(() => { if (client && client.connected) announce(); }, 25000);
  setInterval(renderPeople, 10000);
  window.addEventListener('pagehide', () => { try { client && client.publish(base + 'p/' + cid, '', { qos: 0, retain: true }); } catch {} });

  $('nick').onchange = () => {
    nick = $('nick').value.trim().slice(0, 16) || nick; $('nick').value = nick; ls.set('vs_nick', nick); announce();
  };

  // 메시지를 순서대로 처리 (비동기 해시 계산 때문에 큐 사용)
  let chain = Promise.resolve();
  const queue = (t, b) => { chain = chain.then(() => onMsg(t, b)).catch(e => console.error(e)); };

  // ---------- 메시지 ----------
  async function onMsg(topic, buf) {
    if (!topic.startsWith(base)) return;
    const path = topic.slice(base.length).split('/');
    const raw = buf.toString();
    if (path[0] === 'p') { // 참여자
      if (!raw) delete people[path[1]];
      else { try { people[path[1]] = JSON.parse(raw); } catch {} }
      return renderPeople();
    }
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (path[0] === 'r') return floatReact(d);
    if (path[0] === 'c') return onChat(path[1], d);
    if (path[0] === 'hist') {
      H = Array.isArray(d) ? d.filter(h => h && typeof h.map === 'string').slice(-30) : [];
      return renderHistory();
    }
    if (path[0] === 'meta') {
      const wasAdm = isAdmin();
      meta = d; await refreshAuth(); buildStrip(); await tryClaim();
      if (isAdmin() !== wasAdm) announce();
      fillAdmin(); render(); return;
    }
    if (path[0] === 'round') {
      if (!d.id || d.id === S.round) return;
      S = fresh(d.id); S.n = d.n || 1; S.teamA = d.teamA || 'A팀'; S.teamB = d.teamB || 'B팀'; S.tie = !!d.tie;
      S.pool = Array.isArray(d.pool) && d.pool.length ? d.pool.filter(m => typeof m === 'string').slice(0, 30) : null;
      resetArena();
      const old = buffered; buffered = [];
      for (const [t, b] of old) await onMsg(t, b);
      await tryClaim();
      render(); return step();
    }
    if (path[0] !== S.round) { if (buffered.length < 400) buffered.push([topic, buf]); return; }
    const kind = path[1], side = path[2];
    if (kind === 'claim' && SIDES.includes(side)) {
      if (!meta || (await sha(d.p || '')) !== meta['h' + side]) return;
      const cur = S.claim[side];
      if (!cur || d.t < cur.t || cur.cid === d.cid) S.claim[side] = d;
    } else if (['commit', 'reveal', 'name'].includes(kind) && SIDES.includes(side)) {
      if (kind === 'name' && d.adm) d.admOk = await verifyAdm(d);
      (S.pend[side] = S.pend[side] || {})[kind] = d;
    } else if (kind === 'v' && /^\d{1,2}$/.test(side || '')) {
      if (d.adm) d.admOk = await verifyAdm(d);
      S.pendV[+side] = d;
    } else if (kind === 'undo') {
      if (!(await verifyAdm(d)) || (S.undo && (d.ep | 0) <= S.undo.ep)) return;
      S.undo = { k: d.k | 0, ep: d.ep | 0, t: d.t || Date.now() }; S.sent = Object.assign(S.sent, { hist: false });
    } else if (kind === 'force') {
      if (S.force || !SIDES.includes(d.w) || !(await verifyAdm(d))) return;
      S.force = d;
    } else if (kind === 'roll') { if (d.adm) d.admOk = await verifyAdm(d); S.pendRoll = d; }
    else if (kind === 'side') { if (d.adm) d.admOk = await verifyAdm(d); S.pendSide = d; }
    accept();
    render(); step();
  }

  // 팀장 본인이 보낸 메시지만 인정
  function accept() {
    SIDES.forEach(s => {
      const c = S.claim[s], p = S.pend[s];
      if (!p) return;
      if (p.name && typeof p.name.v === 'string' && (p.name.admOk || (c && p.name.cid === c.cid))) S['team' + s] = p.name.v.slice(0, 20);
      if (!c) return;
      ['commit', 'reveal'].forEach(k => { if (p[k] && p[k].cid === c.cid && !S[k][s]) S[k][s] = p[k]; });
    });
    const byOk = (d, s) => !!d && (d.admOk || (S.claim[s] && d.cid === S.claim[s].cid));
    if (S.res && !isBan()) {
      if (S.pendRoll && !S.roll && byOk(S.pendRoll, S.res.loser)) S.roll = S.pendRoll;
      if (S.pendSide && !S.side && byOk(S.pendSide, S.res.winner)) S.side = S.pendSide;
    }
    if (S.res && isBan()) computeVeto();
  }
  // 밴픽은 번호 순서대로 처음부터 다시 계산 (retained 순서가 섞이거나 되돌리기가 와도 모두 같은 결과)
  function computeVeto() {
    const byOk = (d, s) => !!d && (d.admOk || (S.claim[s] && d.cid === S.claim[s].cid));
    const veto = [], games = [], rem = [...curPool()];
    for (let k = 0; k < S.steps.length; k++) {
      const st = S.steps[k], d = S.pendV[k];
      if (!d || !byOk(d, st.s)) break;
      if (S.undo && k >= S.undo.k && (d.ep | 0) < S.undo.ep) break;
      if (st.a === 'side') {
        if (!['atk', 'def'].includes(d.v)) break;
        if (!games[st.g]) { if (rem.length !== 1) break; games[st.g] = { map: rem[0], dec: true }; }
        Object.assign(games[st.g], { side: d.v, sideBy: st.s });
      } else {
        const i = rem.indexOf(d.m); if (i < 0) break;
        rem.splice(i, 1);
        if (st.a === 'pick') games[st.g] = { map: d.m, by: st.s };
      }
      veto.push({ ...st, m: d.m, v: d.v, t: d.t || 0, auto: !!d.auto, adm: !!d.admOk });
    }
    // 다음 차례가 결정전 진영 선택이면 남은 맵을 결정전으로 표시
    const nx = S.steps[veto.length];
    if (nx && nx.a === 'side' && !games[nx.g] && rem.length === 1) games[nx.g] = { map: rem[0], dec: true };
    if (veto.length > S.veto.length) { const l = veto[veto.length - 1]; if (Date.now() - l.t < FRESH_MS) S.fx = l.a; }
    S.veto = veto; S.games = games; S.rem = rem;
  }
  const atkTeam = g => g.side === 'atk' ? g.sideBy : other(g.sideBy);

  async function tryClaim() {
    if (!myCap || !meta || !S.round || !client) return;
    const s = myCap.side;
    if ((await sha(await claimProof(myCap.tok))) !== meta['h' + s]) { if (!myCap.bad) { myCap.bad = true; setupTeam(); } return; }
    myCap.bad = false;
    if (S.claim[s] && S.claim[s].cid === cid) return;
    if (!S.sent['claim']) { S.sent['claim'] = true; pub(`${S.round}/claim/${s}`, { cid, p: await claimProof(myCap.tok), t: Date.now() }); }
  }
  const mySide = () => SIDES.find(s => S.claim[s] && S.claim[s].cid === cid);
  const isOwner = () => isAdmin();
  const admTag = () => (isAdmin() ? { adm: adm.ap } : {});
  const teamName = s => S['team' + s];
  const capName = s => { const c = S.claim[s]; return c && people[c.cid] ? people[c.cid].name : null; };

  // ---------- 행동 ----------
  document.querySelectorAll('.rps-btn').forEach(b => b.onclick = async () => {
    const me = mySide();
    if (!me || S.commit[me] || S.sent.commit) return;
    S.sent.commit = true;
    const c = +b.dataset.c, salt = hex(16);
    ss.set(`vs_sec_${room}_${S.round}`, JSON.stringify({ c, salt }));
    b.classList.add('sel');
    pub(`${S.round}/commit/${me}`, { cid, h: await sha(c + '|' + salt), t: Date.now() });
    render();
  });
  // 팀장 본인 차례면 팀장으로, 아니면 관리자가 대신 (관리자 대리 진행)
  const actAs = s => mySide() === s ? 'cap' : (!mySide() && isAdmin()) ? 'adm' : null;
  $('rollBtn').onclick = () => {
    if (!S.res || !actAs(S.res.loser) || S.roll || S.sent.roll) return;
    S.sent.roll = true; $('rollBtn').disabled = true;
    pub(`${S.round}/roll`, { cid, t: Date.now(), ...(actAs(S.res.loser) === 'adm' ? admTag() : {}) });
  };
  const pickSide = v => () => {
    if (isBan()) return sendStep(v);
    if (!S.res || !actAs(S.res.winner) || S.side || S.sent.side) return;
    S.sent.side = true;
    pub(`${S.round}/side`, { cid, v, t: Date.now(), ...(actAs(S.res.winner) === 'adm' ? admTag() : {}) });
  };
  $('pickAtk').onclick = pickSide('atk');
  $('pickDef').onclick = pickSide('def');
  function sendStep(x, auto) {
    const k = S.veto.length, st = curStep(), key = `v${k}_${ep()}`;
    if (!st || S.sent[key]) return;
    const how = actAs(st.s); if (!how) return;
    if (st.a === 'side' ? !['atk', 'def'].includes(x) : !S.rem.includes(x)) return;
    S.sent[key] = true;
    pub(`${S.round}/v/${k}`, { cid, ...(st.a === 'side' ? { v: x } : { m: x }), t: Date.now(), ep: ep(), auto: !!auto, ...(how === 'adm' ? admTag() : {}) });
  }
  $('banGrid').onclick = e => { const b = e.target.closest('[data-ban]'); const st = curStep(); if (b && st && st.a !== 'side') sendStep(b.dataset.ban); };
  // 제한시간: 보이는 건 모두에게, 시간 초과 시 자동 진행은 차례인 팀장 브라우저만
  setInterval(() => {
    const st = curStep();
    if (!room || !st || !meta.timer) return;
    const left = meta.timer * 1000 - (Date.now() - banTurnStart());
    const sec = Math.max(0, Math.ceil(left / 1000));
    $('banClock').textContent = sec + 's';
    $('banClock').classList.toggle('low', sec <= 5);
    $('banBar').style.width = Math.max(0, Math.min(100, left / (meta.timer * 10))) + '%';
    const mine = mySide() === st.s;
    if (mine && sec <= 5 && sec > 0 && S.lastWarn !== sec) { S.lastWarn = sec; Sfx.warn(); }
    if (mine && left < -300) {
      const r = S.rem;
      sendStep(st.a === 'side' ? (Math.random() < 0.5 ? 'atk' : 'def') : r[Math.floor(Math.random() * r.length)], true);
    }
  }, 250);
  const seriesMaps = () => isBan() ? S.games.filter(g => g && g.side).map(g => g.map) : (S.rolled && S.mapName ? [S.mapName] : []);
  function nextPool() {
    if (!meta || !meta.noRep) return null;
    const played = new Set(H.flatMap(h => h.games ? h.games.map(g => g.map) : [h.map]));
    seriesMaps().forEach(m => played.add(m));
    const left = (meta.pool || MAPS).filter(m => !played.has(m));
    return left.length >= (isBan() ? FMT_NEED[meta.fmt || 1] : 1) ? left : null; // 다 쓰면 전체 풀로 초기화
  }
  const newRound = () => { const pool = nextPool(); pub('round', { id: hex(4), n: S.n + 1, teamA: S.teamA, teamB: S.teamB, ...(pool ? { pool } : {}) }); };
  $('againBtn').onclick = () => { if (!mySide() && !isOwner()) return; newRound(); };
  $('sndBtn').onclick = () => { const on = Sfx.toggle(); $('sndBtn').textContent = on ? '🔊' : '🔇'; $('sndBtn').setAttribute('aria-pressed', on); if (on) Sfx.pop(); };
  $('sndBtn').textContent = Sfx.on ? '🔊' : '🔇';
  // 관전자 반응 (보관 안 함: 지금 보고 있는 사람만)
  $('reacts').innerHTML = REACTS.map(e => `<button type="button" class="react" data-e="${e}" aria-label="반응 ${e}">${e}</button>`).join('');
  // 도배 방지: 보내는 쪽 1.5초 쿨다운 + 10초에 4개, 받는 쪽도 사람별로 같은 제한 (조작된 클라이언트 대비)
  const REACT_CD = 1500;
  let reactCoolUntil = 0;
  $('reacts').onclick = e => {
    const b = e.target.closest('.react'); if (!b || !client || (meta && meta.noReact)) return;
    const now = Date.now();
    if (now < reactCoolUntil) return;
    if (!allow('me_r', 4, 10000)) { coolReacts(Math.max(REACT_CD, 10000 - (now - buckets.me_r[0])), '잠시 후 다시'); return; }
    coolReacts(REACT_CD);
    client.publish(base + 'r', JSON.stringify({ e: b.dataset.e, n: nick, cid }), { qos: 0 });
  };
  function coolReacts(ms, label) {
    reactCoolUntil = Date.now() + ms;
    const el = $('reacts'); el.classList.add('cool'); el.style.setProperty('--cd', ms + 'ms');
    el.dataset.msg = label || '';
    el.classList.remove('run'); void el.offsetWidth; el.classList.add('run');
    clearTimeout(coolReacts.t); coolReacts.t = setTimeout(() => el.classList.remove('cool', 'run'), ms);
  }
  function floatReact(d) {
    if (!d || !REACTS.includes(d.e) || typeof d.cid !== 'string' || (meta && meta.noReact)) return;
    if (!allow('r1' + d.cid, 1, 1000) || !allow('r' + d.cid, 4, 10000)) return;
    const layer = $('floatLayer'); if (layer.childElementCount >= 12) return;
    const el = document.createElement('div');
    el.className = 'floater'; el.style.left = (6 + Math.random() * 82) + '%';
    el.innerHTML = `<span>${d.e}</span><small>${esc(String(d.n || '').slice(0, 16))}</small>`;
    layer.appendChild(el); Sfx.pop();
    setTimeout(() => el.remove(), 2700);
  }
  SIDES.forEach(s => $('name' + s).onchange = e => {
    if (!actAs(s)) return;
    pub(`${S.round}/name/${s}`, { cid, v: e.target.value.trim().slice(0, 20) || s + '팀', ...(actAs(s) === 'adm' ? admTag() : {}) });
  });

  // ---------- 관리자 패널 ----------
  $('admPool').innerHTML = MAPS.map(m => `<label class="chip"><input type="checkbox" value="${m}">${m}</label>`).join('');
  const admModeV = () => (document.querySelector('input[name=admMode]:checked') || {}).value || 'ban';
  const admOpts = () => ({ mode: admModeV(), fmt: +$('admFmt').value, timer: +$('admTimer').value, noRep: $('admNoRep').checked,
    noReact: $('admNoReact').checked, noChat: $('admNoChat').checked });
  const admPoolPicked = () => [...$('admPool').querySelectorAll('input:checked')].map(i => i.value);
  function fillAdmin() {
    $('admPanel').classList.toggle('hidden', !isAdmin());
    if (!isAdmin() || !meta) return;
    if (fillAdmin.room !== room) { fillAdmin.room = room; $('admPanel').open = !S.res; } // 진행 중인 방에 다시 들어오면 접어 둠
    $('admNoReact').checked = !!meta.noReact; $('admNoChat').checked = !!meta.noChat;
    if ($('admSet').open) return; // 펼쳐서 고치는 중이면 입력값 유지
    document.querySelectorAll('input[name=admMode]').forEach(i => (i.checked = i.value === meta.mode)); $('admFmt').value = meta.fmt || 1; $('admTimer').value = String(meta.timer | 0);
    $('admNoRep').checked = !!meta.noRep; $('admNoReact').checked = !!meta.noReact; $('admNoChat').checked = !!meta.noChat;
    const pool = new Set(meta.pool || MAPS);
    $('admPool').querySelectorAll('input').forEach(i => (i.checked = pool.has(i.value)));
    syncAdmHint();
  }
  const syncAdmHint = () => {
    const ban = admModeV() === 'ban', n = admPoolPicked().length;
    $('admFmtRow').classList.toggle('hidden', !ban); $('admTimerRow').classList.toggle('hidden', !ban);
    $('admPoolCount').textContent = `${n} / ${MAPS.length}`;
    $('admPoolHint').textContent = poolDesc(n, admModeV(), +$('admFmt').value);
  };
  $('admSet').ontoggle = () => { if (!$('admSet').open) fillAdmin(); };
  ['admFmt', 'admPool'].forEach(id => ($(id).onchange = syncAdmHint));
  document.querySelectorAll('input[name=admMode]').forEach(i => (i.onchange = syncAdmHint));
  const admSetPool = f => { $('admPool').querySelectorAll('input').forEach((i, k) => (i.checked = f(i, k))); syncAdmHint(); };
  $('admAll').onclick = () => admSetPool(() => true);
  $('admNone').onclick = () => admSetPool(() => false);
  $('admRand7').onclick = () => { const pick = new Set([...MAPS].sort(() => Math.random() - 0.5).slice(0, 7)); admSetPool(i => pick.has(i.value)); };
  const admMeta = async (o, pool, gen) => pub('meta', await metaFor(adm.seed, gen == null ? (meta.gen | 0) : gen, o, pool));
  // 반응/채팅 잠금은 즉시 반영 (새 게임 없이)
  ['admNoReact', 'admNoChat'].forEach(id => ($(id).onchange = () => { if (isAdmin()) admMeta({ ...meta, noReact: $('admNoReact').checked, noChat: $('admNoChat').checked }, meta.pool); }));
  $('admApply').onclick = async () => {
    if (!isAdmin()) return;
    const o = admOpts(), pool = admPoolPicked(), need = o.mode === 'ban' ? FMT_NEED[o.fmt] : 2;
    if (pool.length < need) { alert(`맵을 ${need}개 이상 선택`); return; }
    if (S.res && !confirm('진행 중인 게임을 버리고 새 설정으로 다시 시작할까?')) return;
    await admMeta(o, pool);
    pub('round', { id: hex(4), n: S.n || 1, teamA: S.teamA, teamB: S.teamB });
  };
  $('admNew').onclick = () => { if (isAdmin() && (!S.res || confirm('새 게임을 시작할까?'))) newRound(); };
  $('admRestart').onclick = () => {
    if (isAdmin() && confirm('이번 게임을 가위바위보부터 다시 할까?')) pub('round', { id: hex(4), n: S.n || 1, teamA: S.teamA, teamB: S.teamB, ...(S.pool ? { pool: S.pool } : {}) });
  };
  $('admUndo').onclick = () => {
    if (!isAdmin() || !isBan() || !S.veto.length) return;
    pub(`${S.round}/undo`, { k: S.veto.length - 1, ep: ep() + 1, t: Date.now(), ...admTag() });
  };
  document.querySelectorAll('[data-force]').forEach(b => (b.onclick = () => {
    if (!isAdmin() || S.res || S.force) return;
    pub(`${S.round}/force`, { w: b.dataset.force, salt: hex(8), t: Date.now(), ...admTag() });
  }));
  $('admReissue').onclick = async () => {
    if (!isAdmin() || !confirm('팀장 링크를 새로 발급할까? 이전 팀장 링크·팀 채팅 링크는 더 이상 안 되고, 게임은 가위바위보부터 다시 시작해.')) return;
    await admMeta(meta, meta.pool, (meta.gen | 0) + 1);
    pub('round', { id: hex(4), n: S.n || 1, teamA: S.teamA, teamB: S.teamB, ...(S.pool ? { pool: S.pool } : {}) });
  };
  $('admClearHist').onclick = () => { if (isAdmin() && confirm('경기 기록을 모두 지울까?')) pub('hist', []); };
  $('newRoomBtn').onclick = () => {
    const pool = (meta && meta.pool && meta.pool.length) ? meta.pool : pickedPool();
    if (!confirm('새 방을 만들까? (모든 링크 새로 발급)')) return;
    createRoom(pool, S.teamA, S.teamB, meta || lobbyOpts());
  };
  $('room').addEventListener('click', async e => {
    const res = e.target.closest && e.target.closest('[data-act=copyRes]');
    if (res) {
      const txt = resultText();
      try { await navigator.clipboard.writeText(txt); res.textContent = '✅ 복사됨 · 디스코드에 붙여넣기'; }
      catch { prompt('결과 복사', txt); }
      setTimeout(() => (res.textContent = '📋 결과 복사'), 1800);
      return;
    }
    const k = e.target.dataset && e.target.dataset.copy;
    if (!k) return;
    const url = linkFor(k), b = e.target;
    if (!b.dataset.lbl) b.dataset.lbl = b.textContent;
    try { await navigator.clipboard.writeText(url); b.textContent = '✅ 복사됨'; }
    catch { prompt('링크 복사', url); }
    clearTimeout(b._t); b._t = setTimeout(() => (b.textContent = b.dataset.lbl), 1500);
  });

  // ---------- 채팅 ----------
  // all: 방 전체(평문) · A/B: 팀 채팅 (팀 키로 AES-GCM 암호화 → 상대 팀·관전자는 못 읽음)
  let CH = { all: [], A: [], B: [] }, chatTab = null, chatPicked = false, unread = { all: 0, A: 0, B: 0 }, chatSig = '';
  const keyCache = {};
  const keyFor = k => (keyCache[k] = keyCache[k] || aesKey(k));
  const chatKey = ch => myTeam && myTeam.side === ch ? myTeam.key : isAdmin() && adm.toks ? keyFor(adm.toks['k' + ch]) : null;
  const chatChans = () => {
    const c = [];
    if (myTeam) c.push(myTeam.side);
    if (isAdmin()) SIDES.forEach(s => { if (!c.includes(s)) c.push(s); });
    c.push('all'); return c;
  };
  function loadChat() {
    CH = { all: [], A: [], B: [] }; unread = { all: 0, A: 0, B: 0 }; chatTab = null; chatPicked = false; chatSig = '';
    for (const ch of Object.keys(CH)) { try { const a = JSON.parse(ss.get(`vs_chat_${room}_${ch}`) || '[]'); if (Array.isArray(a)) CH[ch] = a.slice(-100); } catch {} }
  }
  async function onChat(ch, d) {
    if (!CH[ch] || !d || typeof d.cid !== 'string') return;
    let m = d;
    if (ch !== 'all') {
      const key = await chatKey(ch); if (!key || typeof d.iv !== 'string' || typeof d.ct !== 'string') return;
      try { m = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(d.iv) }, key, unb64(d.ct)))); }
      catch { return; } // 다른 팀 키 / 옛 링크
      if (!m || m.cid !== d.cid) return;
    }
    if (typeof m.m !== 'string' || typeof m.id !== 'string' || !m.m.trim()) return;
    if (CH[ch].some(x => x.id === m.id)) return;
    if (ch === 'all' && meta && meta.noChat && !m.ad) return;
    if (Date.now() - (m.t || 0) > 3 * 3600e3) return;
    if (!allow('c' + d.cid, 6, 6000)) return; // 받는 쪽 도배 컷
    CH[ch].push({ id: m.id.slice(0, 16), cid: d.cid, n: String(m.n || '?').slice(0, 16), m: m.m.slice(0, 200), t: +m.t || Date.now(), ad: !!m.ad });
    CH[ch] = CH[ch].slice(-100);
    ss.set(`vs_chat_${room}_${ch}`, JSON.stringify(CH[ch]));
    if (d.cid !== cid) { if (ch !== chatTab) unread[ch]++; if (ch !== 'all') Sfx.pop(); }
    renderChat(true);
  }
  function renderChat(force) {
    if (!room) return;
    const chans = chatChans();
    if (!chans.includes(chatTab)) chatTab = chans[0];
    const sig = [chans.join(), chatTab, unread.all, unread.A, unread.B, CH[chatTab].length, meta && meta.noChat, isAdmin(), S.claim.A && S.claim.A.cid, S.claim.B && S.claim.B.cid, S.teamA, S.teamB].join('|');
    if (!force && sig === chatSig) return; chatSig = sig;
    const label = ch => ch === 'all' ? '전체' : (myTeam && myTeam.side === ch ? '우리 팀' : teamName(ch)) + (ch !== 'all' ? ' 🔒' : '');
    $('chatTabs').innerHTML = chans.map(ch => `<button type="button" class="ctab t-${ch}${ch === chatTab ? ' on' : ''}" data-ch="${ch}" role="tab" aria-selected="${ch === chatTab}">${esc(label(ch))}${unread[ch] && ch !== chatTab ? `<i>${Math.min(99, unread[ch])}</i>` : ''}</button>`).join('');
    const capOf = id => SIDES.find(s => S.claim[s] && S.claim[s].cid === id);
    const log = $('chatLog'), stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = CH[chatTab].map(x => {
      const c = capOf(x.cid);
      return `<li class="${x.cid === cid ? 'mine' : ''}"><span class="cn">${x.ad ? '<span class="adm-tag">🛠</span>' : ''}${c ? `<span class="badge ${c}">${c}팀장</span>` : ''}${esc(x.n)}<time>${new Date(x.t).toTimeString().slice(0, 5)}</time></span><span class="cm">${esc(x.m)}</span></li>`;
    }).join('') || `<li class="empty">${chatTab === 'all' ? '방 전체 채팅 · 관전자도 볼 수 있음' : '팀 채팅 · 우리 팀(팀장·팀원 링크)만 읽을 수 있음'}</li>`;
    if (stick || force) log.scrollTop = log.scrollHeight;
    const locked = chatTab === 'all' && meta && meta.noChat && !isAdmin();
    $('chatIn').disabled = locked;
    $('chatIn').placeholder = locked ? '관리자가 전체 채팅을 잠갔어' : chatTab === 'all' ? '전체에게 메시지' : '우리 팀에게만 (암호화)';
    $('teamLinkBtn').classList.toggle('hidden', !(myTeam && myCap && !myCap.bad));
  }
  $('chatTabs').onclick = e => {
    const b = e.target.closest('.ctab'); if (!b) return;
    chatTab = b.dataset.ch; chatPicked = true; unread[chatTab] = 0; renderChat(true); $('chatIn').focus();
  };
  $('chatForm').onsubmit = async e => {
    e.preventDefault();
    const inp = $('chatIn'), txt = inp.value.trim().slice(0, 200), ch = chatTab;
    if (!txt || !client || !ch) return;
    if (ch === 'all' && meta && meta.noChat && !isAdmin()) return;
    if (!allow('me_c', 5, 6000)) { chatHint('너무 빨라 · 잠깐만'); return; }
    if (CH[ch].length && CH[ch][CH[ch].length - 1].cid === cid && CH[ch][CH[ch].length - 1].m === txt && Date.now() - CH[ch][CH[ch].length - 1].t < 5000) { chatHint('같은 말 반복 금지'); return; }
    const m = { id: hex(6), cid, n: nick, m: txt, t: Date.now(), ...(isAdmin() ? { ad: 1 } : {}) };
    let payload = m;
    if (ch !== 'all') {
      const key = await chatKey(ch); if (!key) return;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(m))));
      payload = { cid, iv: b64(iv), ct: b64(ct) };
    }
    client.publish(base + 'c/' + ch, JSON.stringify(payload), { qos: 1 });
    inp.value = '';
  };
  function chatHint(t) { const h = $('chatHint'); h.textContent = t; h.classList.add('on'); clearTimeout(chatHint.t); chatHint.t = setTimeout(() => h.classList.remove('on'), 1600); }

  // ---------- 진행 ----------
  async function step() {
    const me = mySide(), round = S.round;
    // 0) 관리자가 가위바위보 생략 (팀장 부재 등)
    if (S.force && !S.res && !S.rpsShown) {
      S.rpsShown = true;
      $('rpsPick').classList.add('hidden');
      setRes({ winner: S.force.w, loser: other(S.force.w), mapIdx: parseInt((await sha(S.force.salt + '|map')).slice(0, 8), 16) }, S.force.t);
      accept();
    }
    // 1) 둘 다 선택 완료 → 내 선택 공개
    if (me && S.commit.A && S.commit.B && !S.reveal[me] && !S.sent.reveal) {
      const sec = JSON.parse(ss.get(`vs_sec_${room}_${S.round}`) || 'null');
      if (sec) { S.sent.reveal = true; pub(`${S.round}/reveal/${me}`, { cid, c: sec.c, salt: sec.salt, t: Date.now() }); }
    }
    // 2) 둘 다 공개 → 결과
    if (S.reveal.A && S.reveal.B && !S.rpsShown && !S.res) {
      S.rpsShown = true;
      const rA = S.reveal.A, rB = S.reveal.B;
      const ok = (await sha(rA.c + '|' + rA.salt)) === S.commit.A.h && (await sha(rB.c + '|' + rB.salt)) === S.commit.B.h
        && [0, 1, 2].includes(rA.c) && [0, 1, 2].includes(rB.c);
      if (!ok) { $('rpsMsg').innerHTML = '<span class="atkc">⚠️ 검증 실패 · 새 게임</span>'; render(); return; }
      const diff = (rA.c - rB.c + 3) % 3; // 1: A 승, 2: B 승, 0: 비김
      const live = Date.now() - Math.max(rA.t || 0, rB.t || 0) < FRESH_MS;
      await showDuel(rA.c, rB.c, diff, live);
      if (S.round !== round || S.res) return;
      if (diff === 0) {
        $('rpsMsg').innerHTML = '🤝 무승부 · 재경기';
        // A팀장 브라우저가 새 판을 염 (한 명만 열어야 중복이 안 생김)
        if (me === 'A' && !S.tieQueued) {
          S.tieQueued = true;
          setTimeout(() => { if (S.round === round) pub('round', { id: hex(4), n: S.n, tie: true, teamA: S.teamA, teamB: S.teamB, ...(S.pool ? { pool: S.pool } : {}) }); }, 1600);
        }
        render(); return;
      }
      const winner = diff === 1 ? 'A' : 'B';
      const mapIdx = parseInt((await sha(rA.salt + '|' + rB.salt + '|map')).slice(0, 8), 16);
      setRes({ winner, loser: other(winner), mapIdx }, Math.max(rA.t || 0, rB.t || 0));
      if (live) Sfx.win();
      accept();
    }
    // 3) 진 팀장이 룰렛
    if (!isBan() && S.res && S.roll && !S.rolled && !S.rolling) {
      S.rolling = true; render();
      const live = Date.now() - (S.roll.t || 0) < FRESH_MS;
      await spinRoulette(S.res.mapIdx, live);
      if (S.round !== round) return;
      S.rolling = false; S.rolled = true;
    }
    render();
    maybeRecord();
  }

  // 경기가 끝나면 진영을 고른 팀장 브라우저가 기록을 남김 (한 명만 써야 덮어쓰기 경쟁이 없음)
  const matchDone = () => isBan() ? vetoDone() : !!(S.res && S.rolled && S.side);
  // 마지막 행동을 한 사람(팀장 또는 대리한 관리자) 브라우저 한 곳만 기록 → 덮어쓰기 경쟁 없음
  function maybeRecord() {
    if (!matchDone() || S.sent.hist) return;
    let writer;
    if (isBan()) { const l = S.veto[S.veto.length - 1]; writer = l.adm ? isAdmin() && !mySide() : mySide() === l.s; }
    else writer = S.side.admOk ? isAdmin() && !mySide() : mySide() === sidePicker();
    if (!writer) return;
    S.sent.hist = true;
    let entry;
    if (isBan()) {
      const games = S.games.map(g => ({ map: g.map, atk: teamName(atkTeam(g)), def: teamName(other(atkTeam(g))), ...(g.dec ? { dec: 1 } : { pick: teamName(g.by) }) }));
      entry = { id: S.round, n: S.n, fmt: fmtEff(), map: games[0].map, atk: games[0].atk, def: games[0].def, t: Date.now(),
        ...(games.length > 1 ? { games } : {}), bans: S.veto.filter(v => v.a === 'ban').map(v => ({ m: v.m, s: teamName(v.s) })) };
    } else {
      const atkS = S.side.v === 'atk' ? sidePicker() : other(sidePicker());
      entry = { id: S.round, n: S.n, map: S.mapName, atk: teamName(atkS), def: teamName(other(atkS)), t: Date.now() };
    }
    pub('hist', [...H.filter(h => h.id !== S.round), entry].slice(-30)); // 되돌리기 후 다시 끝나면 덮어씀
  }
  function resultText() {
    if (!matchDone()) return '';
    if (!isBan()) {
      const atkS = S.side.v === 'atk' ? sidePicker() : other(sidePicker());
      return `🎮 GAME ${S.n} · 🗺️ ${S.mapName}\n⚔️ 공격: ${teamName(atkS)}\n🛡️ 수비: ${teamName(other(atkS))}`;
    }
    const f = fmtEff(), N = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    let t = `🎮 GAME ${S.n}${f > 1 ? ` · Bo${f}` : ''} · ${teamName('A')} vs ${teamName('B')}`;
    S.games.forEach((g, i) => {
      const a = atkTeam(g);
      t += f > 1 ? `\n${N[i]} ${g.map}${g.dec ? ' (결정전)' : ` (${teamName(g.by)} 픽)`} — ⚔️ ${teamName(a)} / 🛡️ ${teamName(other(a))}`
        : `\n🗺️ ${g.map}\n⚔️ 공격: ${teamName(a)}\n🛡️ 수비: ${teamName(other(a))}`;
    });
    const bans = S.veto.filter(v => v.a === 'ban');
    if (bans.length) t += `\n🚫 밴: ${bans.map(b => `${b.m}(${teamName(b.s)})`).join(' → ')}`;
    return t;
  }
  function renderHistory() {
    $('histWrap').classList.toggle('hidden', !H.length);
    const sides = g => `<span class="atkc">⚔ ${esc(g.atk)}</span> · <span class="defc">🛡 ${esc(g.def)}</span>`;
    $('hist').innerHTML = H.slice().reverse().map(h => Array.isArray(h.games) && h.games.length > 1 ? `<li class="h-series">
      <span class="h-body"><b>G${h.n | 0} · Bo${h.fmt | 0}</b>${h.games.map((g, i) => `<span class="h-g"><span class="h-thumb sm" style="background:${mapBg(String(g.map))}"></span><span>${i + 1}. ${esc(g.map)}${g.dec ? ' · 결정전' : ''}<br>${sides(g)}</span></span>`).join('')}</span></li>`
      : `<li>
      <span class="h-thumb" style="background:${mapBg(h.map)}"></span>
      <span class="h-body"><b>G${h.n | 0} · ${esc(h.map)}</b><span>${sides(h)}</span></span></li>`).join('');
  }

  // ---------- 맵 밴 ----------
  function buildBanGrid() {
    const key = S.round + '|' + curPool().join(',');
    if (S.banGridFor === key) return;
    S.banGridFor = key;
    $('banGrid').innerHTML = curPool().map(m => `<button type="button" class="bcard" data-ban="${esc(m)}" style="background:${mapBg(m)}">
      <span class="bname">${esc(m)}</span><span class="bstamp"><b>BAN</b><small></small></span><span class="btag">DECIDER</span></button>`).join('');
  }
  // 밴픽 순서 표시줄
  function renderSeq() {
    const f = fmtEff(), k = S.veto.length;
    $('vetoSeq').innerHTML = S.steps.map((st, i) => {
      const v = S.veto[i], g = st.a === 'side' ? S.games[st.g] : null;
      const lbl = st.a === 'side' ? (f > 1 ? `G${st.g + 1} 진영` : '진영') : st.a === 'pick' ? `G${st.g + 1} 픽` : '밴';
      return `<li class="sq ${st.a} t-${st.s}${v ? ' done' : ''}${i === k ? ' now' : ''}" title="${esc(teamName(st.s))} ${lbl}"><b>${st.s}</b>${lbl}${v ? `<small>${esc(st.a === 'side' ? (v.v === 'atk' ? '공격' : '수비') : v.m)}</small>` : g && g.dec && st.a === 'side' ? '<small>결정전</small>' : ''}</li>`;
    }).join('');
  }
  function renderBans() {
    buildBanGrid(); renderSeq();
    const st = curStep(), k = S.veto.length, how = st ? actAs(st.s) : null;
    const can = !!how && st.a !== 'side' && !S.sent[`v${k}_${ep()}`];
    $('banGrid').classList.toggle('my-turn', can);
    $('banGrid').classList.toggle('pick-turn', !!st && st.a === 'pick');
    [...$('banGrid').children].forEach(el => {
      const m = el.dataset.ban, vi = S.veto.findIndex(x => x.a !== 'side' && x.m === m), v = S.veto[vi];
      const gi = S.games.findIndex(g => g && g.map === m), g = S.games[gi];
      const state = v ? v.a : g && g.dec ? 'dec' : '';
      if (el.dataset.state !== state) {
        el.dataset.state = state;
        el.classList.remove('banned', 'picked', 'side-A', 'side-B', 'no-anim');
        if (v) {
          el.classList.add(v.a === 'ban' ? 'banned' : 'picked', 'side-' + v.s);
          el.querySelector('b').textContent = v.a === 'ban' ? 'BAN' : `PICK · G${gi + 1}`;
          el.querySelector('small').textContent = `${m} · ${teamName(v.s)}${v.auto ? ' ⏱' : ''}${v.adm ? ' 🛠' : ''}`;
          const id = `${vi}|${m}|${v.a}`;
          if (S.animated[id]) el.classList.add('no-anim');
          else { S.animated[id] = 1; if (S.fx) { (S.fx === 'ban' ? Sfx.ban : Sfx.reveal)(); S.fx = null; } else el.classList.add('no-anim'); }
        }
      }
      el.classList.toggle('decider', state === 'dec');
      if (state === 'dec') el.querySelector('.btag').textContent = fmtEff() > 1 ? `DECIDER · G${gi + 1}` : 'DECIDER';
      el.disabled = !can || !!v || !!(g && g.dec);
    });
    const total = S.steps.length;
    if (!st) {
      $('banTurn').innerHTML = `<b style="color:#ffd166">밴픽 완료</b> · ${S.games.map(g => esc(g.map)).join(' → ')}`;
      $('banClock').textContent = ''; $('banBar').style.width = '0';
    } else {
      const g = st.a === 'side' ? S.games[st.g] : null;
      const what = st.a === 'side' ? `${g ? `<b>${esc(g.map)}</b>${g.dec ? ' (결정전)' : ''} ` : ''}진영 선택` : st.a === 'pick' ? `G${st.g + 1} 맵 픽` : '밴';
      $('banTurn').innerHTML = `<span class="${st.s === 'A' ? 'atkc' : 'defc'}">${esc(teamName(st.s))}</span> ${what} 차례 · ${k + 1}/${total}`
        + (how === 'cap' && st.a !== 'side' ? ` · <b>${st.a === 'pick' ? '플레이할 맵 선택' : '밴할 맵 선택'}</b>` : '')
        + (how === 'adm' ? ' · <span class="adm-tag">🛠 대리 가능</span>' : '');
      if (!meta.timer) { $('banClock').textContent = ''; $('banBar').style.width = '0'; }
    }
  }

  // ---------- 화면 ----------
  function resetArena() {
    $('duel').classList.add('hidden');
    ['A', 'B'].forEach(s => { const h = $('hand' + s); h.className = 'hand ' + s; h.querySelector('.em').textContent = '✊'; });
    document.querySelectorAll('.rps-btn').forEach(b => { b.classList.remove('sel'); b.disabled = false; });
    $('phPost').classList.add('hidden'); $('final').classList.add('hidden'); $('final').innerHTML = '';
    $('rollBtn').disabled = false;
    $('banGrid').innerHTML = ''; $('vetoSeq').innerHTML = ''; $('copyRes').classList.add('hidden');
    buildStrip();
  }

  async function showDuel(a, b, diff, live) {
    $('rpsPick').classList.add('hidden');
    $('duel').classList.remove('hidden');
    $('handNameA').textContent = teamName('A'); $('handNameB').textContent = teamName('B');
    const hA = $('handA'), hB = $('handB');
    if (live) {
      $('rpsMsg').textContent = '가위… 바위… 보!';
      hA.querySelector('.em').textContent = hB.querySelector('.em').textContent = '✊';
      hA.classList.add('shake'); hB.classList.add('shake');
      [0, 250, 500].forEach(ms => setTimeout(Sfx.thump, ms + 110));
      await wait(780);
      hA.classList.remove('shake'); hB.classList.remove('shake');
      Sfx.reveal();
    }
    hA.querySelector('.em').textContent = RPS[a].em; hB.querySelector('.em').textContent = RPS[b].em;
    hA.classList.add('pop'); hB.classList.add('pop');
    if (diff === 1) { hA.classList.add('win'); hB.classList.add('lose'); }
    if (diff === 2) { hB.classList.add('win'); hA.classList.add('lose'); }
    if (live) await wait(550);
  }

  // 룰렛: 모두가 같은 띠를 보도록 방 코드로 순서를 고정
  let stripItems = [];
  const TARGET_POS = 44;
  function seeded(seedStr) {
    let h = 2166136261; for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  }
  const mapColor = m => { let h = 0; for (const ch of m) h = (h * 31 + ch.charCodeAt(0)) % 360; return `linear-gradient(160deg,hsl(${h} 45% 34%),hsl(${(h + 40) % 360} 50% 16%))`; };
  function buildStrip(targetMap) {
    const pool = curPool();
    const rnd = seeded((room || '') + (S.round || ''));
    stripItems = [];
    for (let i = 0; i < TARGET_POS + 6; i++) stripItems.push(pool[Math.floor(rnd() * pool.length)]);
    if (targetMap) stripItems[TARGET_POS] = targetMap;
    $('strip').innerHTML = stripItems.map((m, i) => `<div class="mcard" data-i="${i}" style="background:${mapBg(m)}"><small>MAP</small>${esc(m)}</div>`).join('');
    $('strip').style.transform = 'translateX(0)';
  }
  async function spinRoulette(mapIdx, live) {
    const pool = curPool();
    const target = pool[mapIdx % pool.length];
    S.mapName = target;
    buildStrip(target);
    const card = $('strip').children[TARGET_POS];
    const boxW = $('roulette').clientWidth, cw = card.offsetWidth;
    // 카드 안에서 살짝 비껴서 멈추게 (매번 같은 위치 방지, 모두 동일 값)
    const jitter = ((mapIdx >>> 8) % 60 - 30) / 100 * cw;
    const x = -(card.offsetLeft + cw / 2 - boxW / 2 + jitter);
    const strip = $('strip');
    if (live && !reduced() && !document.hidden) {
      $('postMsg').innerHTML = '🎰 맵 돌리는 중…';
      // 직접 프레임을 돌려서 가운데 카드가 바뀔 때마다 '틱' 소리 + 강조
      const round = S.round, cards = strip.children, dur = 4200, t0 = performance.now();
      let last = -1;
      await new Promise(done => {
        const f = now => {
          if (S.round !== round || document.hidden) return done();
          const p = Math.min(1, (now - t0) / dur), cur = x * (1 - Math.pow(1 - p, 4));
          strip.style.transform = `translateX(${cur}px)`;
          const idx = Math.floor((boxW / 2 - cur) / cw);
          if (idx !== last) {
            if (cards[last]) cards[last].classList.remove('cur');
            if (cards[idx]) cards[idx].classList.add('cur');
            if (last >= 0) Sfx.tick();
            last = idx;
          }
          p < 1 ? requestAnimationFrame(f) : done();
        };
        requestAnimationFrame(f);
      });
      if (cards[last]) cards[last].classList.remove('cur');
      Sfx.reveal();
    }
    strip.style.transform = `translateX(${x}px)`;
    card.classList.add('hit');
  }

  function confetti() {
    if (reduced()) return;
    const cv = document.createElement('canvas'); cv.className = 'confetti'; document.body.appendChild(cv);
    const dpr = window.devicePixelRatio || 1, W = innerWidth, Hh = innerHeight;
    cv.width = W * dpr; cv.height = Hh * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const cols = ['#ff4655', '#43d9bd', '#ffd166', '#eeeae3'];
    const ps = Array.from({ length: 150 }, (_, i) => ({
      x: i % 2 ? W * 0.15 : W * 0.85, y: Hh * 0.75,
      vx: (i % 2 ? 1 : -1) * (3 + Math.random() * 9), vy: -(10 + Math.random() * 13),
      r: 5 + Math.random() * 6, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.35, c: cols[i % 4]
    }));
    const t0 = performance.now(), LIFE = 3000;
    const f = now => {
      const el = now - t0; g.clearRect(0, 0, W, Hh);
      g.globalAlpha = Math.max(0, 1 - Math.max(0, el - LIFE * 0.6) / (LIFE * 0.4));
      for (const p of ps) {
        p.vy += 0.38; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.a += p.va;
        g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); g.restore();
      }
      el < LIFE ? requestAnimationFrame(f) : cv.remove();
    };
    requestAnimationFrame(f);
  }

  const baseTitle = document.title;
  let wasTurn = false;
  function render() {
    if (!room) return;
    const me = mySide();
    $('roundLabel').textContent = S.round ? `GAME ${S.n}${S.tie ? ' · 재경기' : ''}` : '';
    // 슬롯
    SIDES.forEach(s => {
      const c = S.claim[s], nameEl = $('name' + s);
      if (document.activeElement !== nameEl) nameEl.value = teamName(s);
      nameEl.readOnly = !actAs(s);
      $('who' + s).textContent = c ? `팀장 · ${capName(s) || '입장'}${me === s ? ' (나)' : ''}` : '팀장 대기';
      let st = '';
      if (S.res && isBan()) {
        const cs = curStep();
        st = (S.res.winner === s ? '<span style="color:#ffd166">🏆 선택권</span> · ' : '')
          + (cs && cs.s === s ? `<span class="atkc">${ACT[cs.a]} 차례</span>` : cs ? '대기' : '<span class="defc">✔ 완료</span>');
      } else if (S.res) st = S.res.winner === s ? '<span style="color:#ffd166">🏆 승리 · 진영 선택</span>' : '<span class="atkc">패배 · 맵 돌리기</span>';
      else if (S.commit[s]) st = '<span class="defc">✔ 준비</span>';
      else if (c) st = '고르는 중';
      $('st' + s).innerHTML = st;
    });

    // 가위바위보 단계
    const both = S.claim.A && S.claim.B;
    if (!S.rpsShown) {
      const showPick = !!me && !S.commit[me];
      $('rpsPick').classList.toggle('hidden', !me);
      document.querySelectorAll('.rps-btn').forEach(b => (b.disabled = !showPick));
      let msg;
      if (!meta) msg = '불러오는 중…';
      else if (!both) msg = '팀장 입장 대기 중';
      else if (me && !S.commit[me]) msg = '가위 · 바위 · 보 선택';
      else if (me) msg = '준비 완료 · 상대 대기';
      else msg = `준비 ${SIDES.filter(s => S.commit[s]).length} / 2`;
      $('rpsMsg').textContent = msg;
    }

    // 결과 이후
    const R = S.res;
    $('phPost').classList.toggle('hidden', !R);
    const ban = isBan();
    const done = matchDone();
    $('arenaLabel').textContent = !R ? 'ROCK PAPER SCISSORS' : done ? 'MATCH READY' : ban ? 'MAP VETO' : 'MAP & SIDE';
    $('modeLabel').textContent = meta ? (ban ? `🚫 밴픽 · ${fmtEff() > 1 ? 'Bo' + fmtEff() : '단판'}` : '🎰 맵 룰렛') + (meta.noRep ? ' · 중복 맵 제외' : '') + (ban && meta.timer ? ` · ${meta.timer}초` : '') : '';
    $('roulette').classList.toggle('hidden', ban);
    $('banBox').classList.toggle('hidden', !(R && ban));
    $('rpsMsg').classList.toggle('forced', !!S.force);
    if (R) {
      const W = teamName(R.winner), L = teamName(R.loser), SP = sidePicker();
      const forced = S.force ? ' <span class="adm-tag">🛠 관리자 지정</span>' : '';
      if (ban) {
        renderBans();
        const cs = curStep(), g = cs && cs.a === 'side' ? S.games[cs.g] : null;
        $('postMsg').innerHTML = done ? `🗺️ ${S.games.map(x => `<b style="color:#ffd166">${esc(x.map)}</b>`).join(' → ')}`
          : fmtEff() > 1 ? `Bo${fmtEff()} · 밴 2 → 픽 → 상대가 진영 → 마지막 남은 맵이 결정전` : '번갈아 밴 · 마지막 남은 맵으로 경기';
        $('rollBox').classList.add('hidden');
        const sideHow = cs && cs.a === 'side' ? actAs(cs.s) : null;
        $('sideBox').classList.toggle('hidden', !(sideHow && !S.sent[`v${S.veto.length}_${ep()}`]));
        if (g) $('sideTitle').textContent = `${teamName(cs.s)} · ${g.map}${g.dec ? ' (결정전)' : ''} 진영 선택${sideHow === 'adm' ? ' · 🛠 대리' : ''}`;
        $('rpsMsg').innerHTML = `🏆 <b style="color:#ffd166">${esc(W)}</b> 승리 · 선밴${forced}`;
      } else {
        if (!S.rolling && !S.rolled) $('postMsg').innerHTML = (me === R.loser ? '맵 돌리기 차례' : `${esc(L)} 맵 돌리기 대기 중`) + ` <span style="color:var(--muted);font-weight:500">· 후보 ${curPool().length}개</span>`;
        if (S.rolled) $('postMsg').innerHTML = `🗺️ <b style="color:#ffd166">${esc(S.mapName)}</b>`;
        $('rollBox').classList.toggle('hidden', !(actAs(R.loser) && !S.roll));
        $('sideBox').classList.toggle('hidden', !(actAs(R.winner) && !S.side && S.rolled));
        $('sideTitle').textContent = `${W} · 진영 선택${actAs(R.winner) === 'adm' ? ' · 🛠 대리' : ''}`;
        $('rpsMsg').innerHTML = `🏆 <b style="color:#ffd166">${esc(W)}</b> 승리 · ${esc(L)} 맵 돌리기${forced}`;
      }
      // 최종
      const fin = $('final');
      if (ban && S.games.length && S.games.some(Boolean)) {
        fin.classList.remove('hidden');
        const html = fmtEff() > 1 ? `<div class="series">${S.games.map((x, i) => x ? `<div class="sg${x.side ? '' : ' pending'}" style="background:linear-gradient(0deg,#0b1218f2,#0b1218a0 70%,#0b121870),${mapBg(x.map)}">
            <small>GAME ${i + 1} · ${x.dec ? 'DECIDER' : esc(teamName(x.by)) + ' PICK'}</small><b>${esc(x.map)}</b>
            ${x.side ? `<span class="atkc">⚔ ${esc(teamName(atkTeam(x)))}</span><span class="defc">🛡 ${esc(teamName(other(atkTeam(x))))}</span>` : '<span class="muted">진영 선택 대기</span>'}</div>` : '').join('')}</div>`
          : (() => { const x = S.games[0]; return `<div class="final-map" style="background:linear-gradient(0deg,#0b1218f0,#0b121899 60%,#0b121866),${mapBg(x.map)}"><small>MAP</small>${esc(x.map)}</div>`
            + (x.side ? `<div class="final-sides"><div class="final-side atk"><small>ATTACK · 공격</small>${esc(teamName(atkTeam(x)))}</div><div class="final-side def"><small>DEFENSE · 수비</small>${esc(teamName(other(atkTeam(x))))}</div></div>`
              : `<div class="final-sides"><div class="final-side"><small>SIDE</small><span style="font-size:14px;color:var(--muted)">${esc(teamName(curStep() ? curStep().s : 'A'))} 진영 선택 중</span></div></div>`); })();
        if (fin.innerHTML !== html) fin.innerHTML = html;
      } else if (ban) { fin.classList.add('hidden'); fin.innerHTML = ''; }
      if (!ban && (S.rolled || S.side)) {
        fin.classList.remove('hidden');
        let html = '';
        html += `<div class="final-map" ${S.rolled && MAP_IMG[S.mapName] ? `style="background:linear-gradient(0deg,#0b1218f0,#0b121899 60%,#0b121866),url(maps/${MAP_IMG[S.mapName]}.jpg) center/cover"` : ''}><small>MAP</small>${S.rolled ? esc(S.mapName) : (S.rolling ? '…' : '대기')}</div>`;
        if (S.side) {
          const atkS = S.side.v === 'atk' ? SP : other(SP);
          html += `<div class="final-sides"><div class="final-side atk"><small>ATTACK · 공격</small>${esc(teamName(atkS))}</div><div class="final-side def"><small>DEFENSE · 수비</small>${esc(teamName(other(atkS)))}</div></div>`;
        } else html += `<div class="final-sides"><div class="final-side"><small>SIDE</small><span style="font-size:14px;color:var(--muted)">${esc(teamName(SP))} 진영 선택 중</span></div></div>`;
        if (fin.innerHTML !== html) fin.innerHTML = html;
      }
      $('copyRes').classList.toggle('hidden', !done);
      if (done && !S.celebrated) {
        S.celebrated = true;
        const lastT = ban ? S.veto[S.veto.length - 1].t : S.side.t;
        if (Date.now() - (lastT || 0) < 15000) { confetti(); Sfx.win(); }
      }
      if (!done) S.celebrated = false;
    }
    $('againBtn').classList.toggle('hidden', !((me || isOwner()) && S.round && (S.res || S.commit.A || S.commit.B)));

    // 내 차례 알림: 탭 제목 + 효과음 + 테두리 강조
    const cs = curStep();
    const myTurn = !!me && ((both && !S.rpsShown && !S.commit[me])
      || (R && !ban && me === R.loser && !S.roll)
      || (R && ban && cs && cs.s === me)
      || (R && !ban && me === sidePicker() && !S.side && S.rolled));
    if (myTurn && !wasTurn) Sfx.ping();
    wasTurn = myTurn;
    document.title = (myTurn ? '🔴 내 차례 · ' : '') + baseTitle;
    $('arena').classList.toggle('my-turn', myTurn);

    let role;
    if (myCap && myCap.bad) role = '⚠️ 팀장 코드 불일치 · 관전 모드';
    else if (me) role = `${me}팀장`;
    else if (myCap) role = '팀장 입장 중…';
    else if (isAdmin()) role = '🛠️ 관리자 · 팀장이 없을 땐 대신 진행 가능';
    else if (adm && !adm.ok) role = '⚠️ 관리자 코드 불일치 · 관전 모드';
    else if (myTeam) role = `${myTeam.side}팀원 · 팀 채팅 가능`;
    else role = followGroup ? '📌 최신 방 자동 관전 중' : '👀 관전 중';
    $('myRole').textContent = role;
    $('admProg').classList.toggle('hidden', !isAdmin());
    if (isAdmin()) {
      $('admUndo').disabled = !(ban && S.veto.length);
      document.querySelectorAll('[data-force]').forEach(b => (b.disabled = !!(R || S.force)));
    }
    $('reacts').classList.toggle('hidden', !!(meta && meta.noReact));
    renderPeople(); renderChat();
  }

  function renderPeople() {
    if (!room) return;
    const now = Date.now();
    const list = Object.entries(people).filter(([, p]) => p && now - (p.t || 0) < 80000);
    const capOf = id => SIDES.find(s => S.claim[s] && S.claim[s].cid === id);
    list.sort((a, b) => (capOf(a[0]) || 'Z').localeCompare(capOf(b[0]) || 'Z') || String(a[1].name).localeCompare(String(b[1].name)));
    $('peopleCount').textContent = `· ${list.length}명`;
    $('people').innerHTML = list.map(([id, p]) => {
      const cap = capOf(id);
      const tm = !cap && SIDES.includes(p.tm) ? p.tm : null;
      const badges = (p.ad ? '<span class="badge adm">관리자</span>' : '') + (cap ? `<span class="badge ${cap}">${cap}팀장</span>` : '') + (tm ? `<span class="badge ${tm} soft">${tm}팀원</span>` : '') + (id === cid ? '<span class="badge me">나</span>' : '');
      return `<li><span class="nm">${esc(p.name || '?')}</span><span>${badges || '<span class="badge">관전</span>'}</span></li>`;
    }).join('') || '<li><span class="nm" style="color:var(--muted)">연결 중…</span></li>';
  }

  loadHostKey(ls.get('vs_hostkey')).then(k => { hostKey = k; if (!k) ls.del && ls.del('vs_hostkey'); enter(); });
})();
