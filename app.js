// 발로란트 공수 결정기 - 실시간 방
// 흐름: 팀장 가위바위보(동시 공개) → 진 팀장이 맵 룰렛 → 이긴 팀장이 공격/수비 선택
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
  const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
  const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const FRESH_MS = 8000; // 이보다 오래된 이벤트는 애니메이션 없이 바로 표시 (늦게 들어온 사람)

  let cid = ss.get('vs_cid'); if (!cid) { cid = hex(6); ss.set('vs_cid', cid); }
  let nick = ls.get('vs_nick'); if (!nick) { nick = '플레이어' + Math.floor(100 + Math.random() * 900); ls.set('vs_nick', nick); }

  // ---------- 로비 ----------
  const savedPool = (() => { try { return JSON.parse(ls.get('vs_pool')) || MAPS; } catch { return MAPS; } })();
  $('mapPool').innerHTML = MAPS.map(m => `<label class="chip"><input type="checkbox" value="${m}" ${savedPool.includes(m) ? 'checked' : ''}>${m}</label>`).join('');
  const pickedPool = () => [...$('mapPool').querySelectorAll('input:checked')].map(i => i.value);
  $('mapPool').onchange = () => ls.set('vs_pool', JSON.stringify(pickedPool()));

  let pendingCreate = null;
  $('createBtn').onclick = () => {
    const pool = pickedPool();
    if (pool.length < 2) { alert('맵을 2개 이상 선택'); return; }
    const r = hex(3), toks = { A: hex(8), B: hex(8) };
    ss.set('vs_own_' + r, JSON.stringify(toks));
    pendingCreate = { toks, pool, teamA: $('initA').value.trim() || 'A팀', teamB: $('initB').value.trim() || 'B팀' };
    location.hash = 'room=' + r;
  };

  // 고정 관전 링크: 방장 브라우저마다 그룹 코드 하나, 새 방을 만들 때마다 그 그룹의 '최신 방'이 갱신됨
  let group = ls.get('vs_group'); if (!/^[0-9a-f]{8}$/.test(group || '')) { group = hex(4); ls.set('vs_group', group); }
  let follow = null, followGroup = null;
  function startFollow(g, i = 0) {
    if (followGroup === g && follow && i === 0) return;
    stopFollow(); followGroup = g;
    if (!window.mqtt) return;
    const c = window.mqtt.connect(BROKERS[i % BROKERS.length], { clientId: 'vsf_' + cid + '_' + hex(2), clean: true, connectTimeout: 6000, reconnectPeriod: 3000 });
    follow = c; let ok = false;
    c.on('connect', () => { ok = true; c.subscribe(ROOT + 'live/' + g, { qos: 1 }); });
    c.on('error', () => {});
    c.on('message', (t, b) => {
      if (follow !== c) return;
      let d; try { d = JSON.parse(b.toString()); } catch { return; }
      if (d && /^[a-z0-9]{4,12}$/.test(d.room || '') && d.room !== room) { myCap = null; join(d.room); }
    });
    setTimeout(() => { if (!ok && follow === c && i + 1 < BROKERS.length) startFollow(g, i + 1); }, 7000);
  }
  function stopFollow() { if (follow) { try { follow.end(true); } catch {} } follow = null; followGroup = null; }

  // ---------- 방 상태 ----------
  let client = null, room = null, base = '';
  let meta = null;   // { hA, hB, pool }
  let myCap = null;  // { side, tok }
  let people = {};   // cid -> { name, t }
  let S = fresh(null);
  let buffered = [];
  function fresh(round) {
    return { round, n: 0, teamA: 'A팀', teamB: 'B팀', claim: {}, commit: {}, reveal: {}, pend: {},
      res: null, roll: null, side: null, rpsShown: false, rolling: false, rolled: false, tieQueued: false, sent: {} };
  }

  // ---------- 입장 ----------
  function parseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const r = (p.get('room') || '').toLowerCase();
    const live = (p.get('live') || '').toLowerCase();
    return { r: /^[a-z0-9]{4,12}$/.test(r) ? r : null, cap: p.get('cap'), live: /^[0-9a-f]{8}$/.test(live) ? live : null };
  }
  function linkFor(kind) {
    const u = location.origin + location.pathname + '#room=' + room;
    if (kind === 'view') return u;
    if (kind === 'live') return location.origin + location.pathname + '#live=' + group;
    const toks = JSON.parse(ss.get('vs_own_' + room) || 'null');
    return toks ? `${u}&cap=${kind}-${toks[kind]}` : u;
  }
  function enter() {
    const { r, cap, live } = parseHash();
    if (live) {
      startFollow(live);
      if (!room) {
        $('lobby').classList.add('hidden'); $('room').classList.remove('hidden');
        $('rmCode').textContent = '…'; $('rpsMsg').textContent = '방 생성 대기 중'; $('myRole').textContent = '📌 최신 방 자동 관전';
      }
      return;
    }
    stopFollow();
    if (!r) { $('lobby').classList.remove('hidden'); $('room').classList.add('hidden'); return; }
    if (cap && /^[AB]-[0-9a-f]{16}$/.test(cap)) {
      ss.set('vs_cap_' + r, cap);
      history.replaceState(null, '', location.pathname + '#room=' + r); // 화면 공유 때 코드 노출 방지
    }
    const saved = ss.get('vs_cap_' + r);
    myCap = saved ? { side: saved[0], tok: saved.slice(2) } : null;
    if (r !== room) join(r);
  }
  window.addEventListener('hashchange', enter);

  function join(r) {
    room = r; base = ROOT + r + '/'; meta = null; people = {}; S = fresh(null); buffered = [];
    $('lobby').classList.add('hidden'); $('room').classList.remove('hidden');
    $('rmCode').textContent = r.toUpperCase();
    $('rmLinks').classList.toggle('hidden', !ss.get('vs_own_' + r));
    $('nick').value = nick;
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
        pub('meta', { hA: await sha(p.toks.A), hB: await sha(p.toks.B), pool: p.pool });
        pub('round', { id: hex(4), n: 1, teamA: p.teamA, teamB: p.teamB });
        c.publish(ROOT + 'live/' + group, JSON.stringify({ room, t: Date.now() }), { qos: 1, retain: true });
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
  const announce = () => pub('p/' + cid, { name: nick, t: Date.now() });
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
    if (path[0] === 'meta') { meta = d; buildStrip(); await tryClaim(); render(); return; }
    if (path[0] === 'round') {
      if (!d.id || d.id === S.round) return;
      S = fresh(d.id); S.n = d.n || 1; S.teamA = d.teamA || 'A팀'; S.teamB = d.teamB || 'B팀'; S.tie = !!d.tie;
      resetArena();
      const old = buffered; buffered = [];
      for (const [t, b] of old) await onMsg(t, b);
      await tryClaim();
      render(); return step();
    }
    if (path[0] !== S.round) { if (buffered.length < 400) buffered.push([topic, buf]); return; }
    const kind = path[1], side = path[2];
    if (kind === 'claim' && SIDES.includes(side)) {
      if (!meta || (await sha(d.tok || '')) !== meta['h' + side]) return;
      const cur = S.claim[side];
      if (!cur || d.t < cur.t || cur.cid === d.cid) S.claim[side] = d;
    } else if (['commit', 'reveal', 'name'].includes(kind) && SIDES.includes(side)) {
      (S.pend[side] = S.pend[side] || {})[kind] = d;
    } else if (kind === 'roll') S.pendRoll = d;
    else if (kind === 'side') S.pendSide = d;
    accept();
    render(); step();
  }

  // 팀장 본인이 보낸 메시지만 인정
  function accept() {
    SIDES.forEach(s => {
      const c = S.claim[s], p = S.pend[s];
      if (!c || !p) return;
      ['commit', 'reveal'].forEach(k => { if (p[k] && p[k].cid === c.cid && !S[k][s]) S[k][s] = p[k]; });
      if (p.name && p.name.cid === c.cid) S['team' + s] = p.name.v;
    });
    if (S.res) {
      if (S.pendRoll && !S.roll && S.claim[S.res.loser] && S.pendRoll.cid === S.claim[S.res.loser].cid) S.roll = S.pendRoll;
      if (S.pendSide && !S.side && S.claim[S.res.winner] && S.pendSide.cid === S.claim[S.res.winner].cid) S.side = S.pendSide;
    }
  }

  async function tryClaim() {
    if (!myCap || !meta || !S.round || !client) return;
    const s = myCap.side;
    if ((await sha(myCap.tok)) !== meta['h' + s]) { myCap.bad = true; return; }
    if (S.claim[s] && S.claim[s].cid === cid) return;
    if (!S.sent['claim']) { S.sent['claim'] = true; pub(`${S.round}/claim/${s}`, { cid, tok: myCap.tok, t: Date.now() }); }
  }
  const mySide = () => SIDES.find(s => S.claim[s] && S.claim[s].cid === cid);
  const isOwner = () => !!ss.get('vs_own_' + room);
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
  $('rollBtn').onclick = () => {
    if (!S.res || mySide() !== S.res.loser || S.roll || S.sent.roll) return;
    S.sent.roll = true; $('rollBtn').disabled = true;
    pub(`${S.round}/roll`, { cid, t: Date.now() });
  };
  const pickSide = v => () => {
    if (!S.res || mySide() !== S.res.winner || S.side || S.sent.side) return;
    S.sent.side = true;
    pub(`${S.round}/side`, { cid, v, t: Date.now() });
  };
  $('pickAtk').onclick = pickSide('atk');
  $('pickDef').onclick = pickSide('def');
  $('againBtn').onclick = () => {
    if (!mySide() && !isOwner()) return;
    pub('round', { id: hex(4), n: S.n + 1, teamA: S.teamA, teamB: S.teamB });
  };
  SIDES.forEach(s => $('name' + s).onchange = e => {
    if (mySide() !== s) return;
    pub(`${S.round}/name/${s}`, { cid, v: e.target.value.trim().slice(0, 20) || s + '팀' });
  });
  $('room').addEventListener('click', async e => {
    const k = e.target.dataset && e.target.dataset.copy;
    if (!k) return;
    const url = linkFor(k);
    try { await navigator.clipboard.writeText(url); e.target.textContent = '✅ 복사'; }
    catch { prompt('링크 복사', url); }
    setTimeout(() => (e.target.textContent = '복사'), 1500);
  });

  // ---------- 진행 ----------
  async function step() {
    const me = mySide(), round = S.round;
    // 1) 둘 다 선택 완료 → 내 선택 공개
    if (me && S.commit.A && S.commit.B && !S.reveal[me] && !S.sent.reveal) {
      const sec = JSON.parse(ss.get(`vs_sec_${room}_${S.round}`) || 'null');
      if (sec) { S.sent.reveal = true; pub(`${S.round}/reveal/${me}`, { cid, c: sec.c, salt: sec.salt, t: Date.now() }); }
    }
    // 2) 둘 다 공개 → 결과
    if (S.reveal.A && S.reveal.B && !S.rpsShown) {
      S.rpsShown = true;
      const rA = S.reveal.A, rB = S.reveal.B;
      const ok = (await sha(rA.c + '|' + rA.salt)) === S.commit.A.h && (await sha(rB.c + '|' + rB.salt)) === S.commit.B.h
        && [0, 1, 2].includes(rA.c) && [0, 1, 2].includes(rB.c);
      if (!ok) { $('rpsMsg').innerHTML = '<span class="atkc">⚠️ 검증 실패 · 새 게임</span>'; render(); return; }
      const diff = (rA.c - rB.c + 3) % 3; // 1: A 승, 2: B 승, 0: 비김
      const live = Date.now() - Math.max(rA.t || 0, rB.t || 0) < FRESH_MS;
      await showDuel(rA.c, rB.c, diff, live);
      if (S.round !== round) return;
      if (diff === 0) {
        $('rpsMsg').innerHTML = '🤝 무승부 · 재경기';
        // A팀장 브라우저가 새 판을 염 (한 명만 열어야 중복이 안 생김)
        if (me === 'A' && !S.tieQueued) {
          S.tieQueued = true;
          setTimeout(() => { if (S.round === round) pub('round', { id: hex(4), n: S.n, tie: true, teamA: S.teamA, teamB: S.teamB }); }, 1600);
        }
        render(); return;
      }
      const winner = diff === 1 ? 'A' : 'B';
      const mapIdx = parseInt((await sha(rA.salt + '|' + rB.salt + '|map')).slice(0, 8), 16);
      S.res = { winner, loser: other(winner), mapIdx };
      accept();
    }
    // 3) 진 팀장이 룰렛
    if (S.res && S.roll && !S.rolled && !S.rolling) {
      S.rolling = true; render();
      const live = Date.now() - (S.roll.t || 0) < FRESH_MS;
      await spinRoulette(S.res.mapIdx, live);
      if (S.round !== round) return;
      S.rolling = false; S.rolled = true;
    }
    render();
  }

  // ---------- 화면 ----------
  function resetArena() {
    $('duel').classList.add('hidden');
    ['A', 'B'].forEach(s => { const h = $('hand' + s); h.className = 'hand ' + s; h.querySelector('.em').textContent = '✊'; });
    document.querySelectorAll('.rps-btn').forEach(b => { b.classList.remove('sel'); b.disabled = false; });
    $('phPost').classList.add('hidden'); $('final').classList.add('hidden'); $('final').innerHTML = '';
    $('rollBtn').disabled = false;
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
      await wait(780);
      hA.classList.remove('shake'); hB.classList.remove('shake');
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
    const pool = (meta && meta.pool && meta.pool.length) ? meta.pool : MAPS;
    const rnd = seeded((room || '') + (S.round || ''));
    stripItems = [];
    for (let i = 0; i < TARGET_POS + 6; i++) stripItems.push(pool[Math.floor(rnd() * pool.length)]);
    if (targetMap) stripItems[TARGET_POS] = targetMap;
    $('strip').innerHTML = stripItems.map((m, i) => `<div class="mcard" data-i="${i}" style="background:${mapBg(m)}"><small>MAP</small>${esc(m)}</div>`).join('');
    $('strip').style.transform = 'translateX(0)';
  }
  async function spinRoulette(mapIdx, live) {
    const pool = (meta && meta.pool && meta.pool.length) ? meta.pool : MAPS;
    const target = pool[mapIdx % pool.length];
    S.mapName = target;
    buildStrip(target);
    const card = $('strip').children[TARGET_POS];
    const boxW = $('roulette').clientWidth, cw = card.offsetWidth;
    // 카드 안에서 살짝 비껴서 멈추게 (매번 같은 위치 방지, 모두 동일 값)
    const jitter = ((mapIdx >>> 8) % 60 - 30) / 100 * cw;
    const x = -(card.offsetLeft + cw / 2 - boxW / 2 + jitter);
    const strip = $('strip');
    if (live) {
      $('postMsg').innerHTML = '🎰 맵 돌리는 중…';
      const anim = strip.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${x}px)` }],
        { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 3400, easing: 'cubic-bezier(.08,.7,.12,1)', fill: 'forwards' });
      await anim.finished.catch(() => {});
    } else strip.style.transform = `translateX(${x}px)`;
    card.classList.add('hit');
  }

  function render() {
    if (!room) return;
    const me = mySide();
    $('roundLabel').textContent = S.round ? `GAME ${S.n}${S.tie ? ' · 재경기' : ''}` : '';
    // 슬롯
    SIDES.forEach(s => {
      const c = S.claim[s], nameEl = $('name' + s);
      if (document.activeElement !== nameEl) nameEl.value = teamName(s);
      nameEl.readOnly = me !== s;
      $('who' + s).textContent = c ? `팀장 · ${capName(s) || '입장'}${me === s ? ' (나)' : ''}` : '팀장 대기';
      let st = '';
      if (S.res) st = S.res.winner === s ? '<span style="color:#ffd166">🏆 승리 · 진영 선택</span>' : '<span class="atkc">패배 · 맵 돌리기</span>';
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
    $('arenaLabel').textContent = !R ? 'ROCK PAPER SCISSORS' : (S.rolled && S.side ? 'MATCH READY' : 'MAP & SIDE');
    if (R) {
      const W = teamName(R.winner), L = teamName(R.loser);
      if (!S.rolling && !S.rolled) $('postMsg').innerHTML = me === R.loser ? '맵 돌리기 차례' : `${esc(L)} 맵 돌리기 대기 중`;
      if (S.rolled) $('postMsg').innerHTML = `🗺️ <b style="color:#ffd166">${esc(S.mapName)}</b>`;
      $('rollBox').classList.toggle('hidden', !(me === R.loser && !S.roll));
      $('sideBox').classList.toggle('hidden', !(me === R.winner && !S.side));
      if (!$('rpsMsg').dataset.done) {
        $('rpsMsg').innerHTML = `🏆 <b style="color:#ffd166">${esc(W)}</b> 승리 · ${esc(L)} 맵 돌리기`;
      }
      // 최종
      const fin = $('final');
      if (S.rolled || S.side) {
        fin.classList.remove('hidden');
        let html = '';
        html += `<div class="final-map" ${S.rolled && MAP_IMG[S.mapName] ? `style="background:linear-gradient(0deg,#0b1218f0,#0b121899 60%,#0b121866),url(maps/${MAP_IMG[S.mapName]}.jpg) center/cover"` : ''}><small>MAP</small>${S.rolled ? esc(S.mapName) : (S.rolling ? '…' : '대기')}</div>`;
        if (S.side) {
          const atkS = S.side.v === 'atk' ? R.winner : R.loser;
          html += `<div class="final-sides"><div class="final-side atk"><small>ATTACK · 공격</small>${esc(teamName(atkS))}</div><div class="final-side def"><small>DEFENSE · 수비</small>${esc(teamName(other(atkS)))}</div></div>`;
        } else html += `<div class="final-sides"><div class="final-side"><small>SIDE</small><span style="font-size:14px;color:var(--muted)">${esc(W)} 진영 선택 중</span></div></div>`;
        fin.innerHTML = html;
      }
    }
    $('againBtn').classList.toggle('hidden', !((me || isOwner()) && S.round && (S.res || S.commit.A || S.commit.B)));

    let role;
    if (myCap && myCap.bad) role = '⚠️ 팀장 코드 불일치 · 관전 모드';
    else if (me) role = `${me}팀장`;
    else if (myCap) role = '팀장 입장 중…';
    else role = followGroup ? '📌 최신 방 자동 관전 중' : '👀 관전 중';
    $('myRole').textContent = role;
    renderPeople();
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
      const badges = (cap ? `<span class="badge ${cap}">${cap}팀장</span>` : '') + (id === cid ? '<span class="badge me">나</span>' : '');
      return `<li><span class="nm">${esc(p.name || '?')}</span><span>${badges || '<span class="badge">관전</span>'}</span></li>`;
    }).join('') || '<li><span class="nm" style="color:var(--muted)">연결 중…</span></li>';
  }

  enter();
})();
