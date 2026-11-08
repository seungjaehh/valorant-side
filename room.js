// 실시간 방
// - 방장이 방을 만들면 링크 3개: 관전 / A팀장 / B팀장 (팀장 링크엔 비밀 코드 포함)
// - 팀장 링크로 들어온 사람만 준비 가능. 두 팀장 모두 준비하면 모든 화면에서 동시에 결과 공개
// - 중계: 공개 MQTT 브로커 (가입 불필요)
// - 공정성(commit-reveal): 각 팀장이 비밀 난수 s를 만들고 SHA-256(s)만 먼저 공개 →
//   둘 다 모이면 s 공개 → 결과 = SHA-256(sA|sB). 누구도 결과를 미리 알거나 고를 수 없음
(function () {
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const ROOT = 'valside/v2/';
  const app = document.getElementById('roomApp');
  if (!app) return;

  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
  };
  const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
  const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const SIDES = ['A', 'B'];

  let cid = ss.get('vs_cid'); if (!cid) { cid = hex(6); ss.set('vs_cid', cid); }

  let client = null, room = null, base = '';
  let meta = null;          // { hA, hB } 팀장 코드의 해시
  let myCap = null;         // { side, tok } 내가 팀장이면
  let pendingCreate = null; // 방 만들기 직후 올릴 정보
  let S = fresh(null);
  function fresh(round) { return { round, teamA: 'A팀', teamB: 'B팀', claim: {}, commit: {}, reveal: {}, shown: false }; }

  // ---------- 화면 ----------
  app.innerHTML = `
    <div id="rmLobby">
      <p class="field-heading">LIVE ROOM / 실시간 방</p>
      <p class="note" style="margin-top:0">방을 만들면 링크가 3개 나와요.<br>
        👀 <b>관전 링크</b> → 디스코드 채널에 공유<br>
        🔴 <b>A팀장 링크</b> / 🔵 <b>B팀장 링크</b> → 각 팀장에게만 DM<br>
        두 팀장이 모두 <b>준비</b>를 누르면 모든 화면에서 동시에 결과가 나와요.</p>
      <div class="row">
        <div><label for="rmInitA">A팀 이름</label><input type="text" id="rmInitA" value="A팀" maxlength="20"></div>
        <div><label for="rmInitB">B팀 이름</label><input type="text" id="rmInitB" value="B팀" maxlength="20"></div>
      </div>
      <button class="btn" id="rmCreate">방 만들기</button>
    </div>
    <div id="rmRoom" class="hidden">
      <div class="rm-head"><span>ROOM <b id="rmCode"></b></span><span id="rmConn" class="rm-conn">연결 중…</span></div>
      <div id="rmLinks" class="rm-links hidden">
        <p class="field-heading">방장 전용 · 링크 공유</p>
        <div class="rm-link"><span>👀 관전 (채널에 공개)</span><button class="btn ghost" data-copy="view">복사</button></div>
        <div class="rm-link"><span>🔴 A팀장 (DM으로만)</span><button class="btn ghost" data-copy="A">복사</button></div>
        <div class="rm-link"><span>🔵 B팀장 (DM으로만)</span><button class="btn ghost" data-copy="B">복사</button></div>
      </div>
      <div class="rm-slots">
        ${SIDES.map(s => `
        <div class="rm-slot rm-${s}">
          <div class="rm-slot-top"><span class="field-code">${s} /</span><input type="text" id="rmName${s}" maxlength="20" value="${s}팀" readonly aria-label="${s}팀 이름"></div>
          <div class="rm-who" id="rmWho${s}">팀장 대기 중</div>
          <button class="btn hidden" id="rmBtn${s}">준비!</button>
        </div>`).join('')}
      </div>
      <p class="note" id="rmMyRole"></p>
    </div>`;

  // ---------- 링크 / 입장 ----------
  function parseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const r = (p.get('room') || '').toLowerCase();
    const cap = p.get('cap'); // "A-<tok>"
    return { r: /^[a-z0-9]{4,12}$/.test(r) ? r : null, cap };
  }
  const linkFor = (r, kind) => {
    const u = location.origin + location.pathname + '#room=' + r;
    if (kind === 'view') return u;
    const toks = JSON.parse(ss.get('vs_own_' + r) || 'null');
    return toks ? `${u}&cap=${kind}-${toks[kind]}` : u;
  };

  function enterFromHash() {
    const { r, cap } = parseHash();
    if (!r) return;
    if (cap && /^[AB]-[0-9a-f]{16}$/.test(cap)) {
      ss.set('vs_cap_' + r, cap);
      // 화면 공유 때 코드가 보이지 않게 주소창에서 지움
      history.replaceState(null, '', location.pathname + '#room=' + r);
    }
    const saved = ss.get('vs_cap_' + r);
    myCap = saved ? { side: saved[0], tok: saved.slice(2) } : null;
    if (r !== room) join(r);
    if (typeof window.showTab === 'function') window.showTab('room');
  }
  window.addEventListener('hashchange', enterFromHash);

  $('rmCreate').onclick = () => {
    const r = hex(3), toks = { A: hex(8), B: hex(8) };
    ss.set('vs_own_' + r, JSON.stringify(toks));
    pendingCreate = { toks, teamA: $('rmInitA').value.trim() || 'A팀', teamB: $('rmInitB').value.trim() || 'B팀' };
    location.hash = 'room=' + r;
  };

  app.addEventListener('click', async e => {
    const k = e.target.dataset && e.target.dataset.copy;
    if (!k) return;
    const url = linkFor(room, k);
    try { await navigator.clipboard.writeText(url); e.target.textContent = '✅ 복사됨'; }
    catch { prompt('이 링크를 복사하세요', url); }
    setTimeout(() => e.target.textContent = '복사', 1500);
  });

  function join(r) {
    room = r; base = ROOT + r + '/'; meta = null; S = fresh(null); buffered = [];
    $('rmLobby').classList.add('hidden');
    $('rmRoom').classList.remove('hidden');
    $('rmCode').textContent = r.toUpperCase();
    $('rmLinks').classList.toggle('hidden', !ss.get('vs_own_' + r));
    $('resR').innerHTML = ''; $('rmAgain').classList.add('hidden');
    if (client) try { client.end(true); } catch {}
    connect(0);
    render();
    // 방 정보가 안 오면 없는 방
    setTimeout(() => { if (room === r && !meta && !pendingCreate) $('resR').innerHTML = '<div class="small">방을 찾을 수 없어요. 링크를 다시 확인하세요.</div>'; }, 6000);
  }

  function connect(i) {
    if (!window.mqtt) { setConn('실시간 라이브러리 로드 실패', true); return; }
    const c = window.mqtt.connect(BROKERS[i % BROKERS.length], { clientId: 'vs_' + cid + '_' + hex(2), clean: true, connectTimeout: 6000, reconnectPeriod: 3000 });
    client = c;
    let ok = false;
    c.on('connect', async () => {
      ok = true; setConn('● 연결됨', false);
      c.subscribe(base + '#', { qos: 1 });
      if (pendingCreate) {
        const p = pendingCreate; pendingCreate = null;
        pub('meta', { hA: await sha(p.toks.A), hB: await sha(p.toks.B) });
        pub('round', { id: hex(4), teamA: p.teamA, teamB: p.teamB });
      }
    });
    c.on('reconnect', () => setConn('재연결 중…', true));
    c.on('offline', () => setConn('연결 끊김', true));
    c.on('error', () => {});
    c.on('message', (t, b) => { if (client === c) onMsg(t, b); });
    setTimeout(() => { if (!ok && client === c && i + 1 < BROKERS.length) { try { c.end(true); } catch {} connect(i + 1); } }, 7000);
  }
  function setConn(t, bad) { const el = $('rmConn'); el.textContent = t; el.classList.toggle('bad', !!bad); }
  const pub = (sub, obj) => client && client.publish(base + sub, JSON.stringify(obj), { qos: 1, retain: true });

  // ---------- 메시지 ----------
  let buffered = [];
  async function onMsg(topic, buf) {
    if (!topic.startsWith(base)) return;
    let d; try { d = JSON.parse(buf.toString()); } catch { return; }
    const path = topic.slice(base.length).split('/');
    if (path[0] === 'meta') { meta = d; await tryClaim(); return render(); }
    if (path[0] === 'round') {
      if (!d.id || d.id === S.round) return;
      S = fresh(d.id); S.teamA = d.teamA || 'A팀'; S.teamB = d.teamB || 'B팀';
      $('resR').innerHTML = ''; $('rmAgain').classList.add('hidden');
      const old = buffered; buffered = [];
      for (const [t, b] of old) await onMsg(t, b);
      await tryClaim();
      render(); return step();
    }
    if (path[0] !== S.round) { if (buffered.length < 300) buffered.push([topic, buf]); return; }
    const [, kind, side] = path;
    if (!SIDES.includes(side)) return;
    if (kind === 'claim') {
      // 팀장 코드가 맞아야 인정. 먼저 들어온 사람이 우선
      if (!meta || (await sha(d.tok || '')) !== meta['h' + side]) return;
      const cur = S.claim[side];
      if (!cur || d.t < cur.t || cur.cid === d.cid) S.claim[side] = d;
    } else if (kind === 'commit') {
      if (S.claim[side] && S.claim[side].cid === d.cid) S.commit[side] = d;
      else S['pc' + side] = d; // 자리 정보보다 먼저 온 경우
    } else if (kind === 'reveal') S.reveal[side] = d;
    else if (kind === 'name') { if (S.claim[side] && S.claim[side].cid === d.cid) S['team' + side] = d.v; }
    // 늦게 확인된 commit 처리
    SIDES.forEach(s => { const pc = S['pc' + s]; if (pc && !S.commit[s] && S.claim[s] && S.claim[s].cid === pc.cid) S.commit[s] = pc; });
    render(); step();
  }

  async function tryClaim() {
    if (!myCap || !meta || !S.round || !client) return;
    const side = myCap.side;
    if ((await sha(myCap.tok)) !== meta['h' + side]) { myCap.bad = true; return; }
    const cur = S.claim[side];
    if (cur && cur.cid === cid) return;
    if (!S['_claimed' + side]) { S['_claimed' + side] = true; pub(`${S.round}/claim/${side}`, { cid, tok: myCap.tok, t: Date.now() }); }
  }

  const mySide = () => SIDES.find(s => S.claim[s] && S.claim[s].cid === cid);

  SIDES.forEach(side => {
    $('rmBtn' + side).onclick = async () => {
      if (mySide() !== side || S.commit[side]) return;
      $('rmBtn' + side).disabled = true;
      const secret = hex(16);
      ss.set(`vs_sec_${room}_${S.round}_${side}`, secret);
      pub(`${S.round}/commit/${side}`, { cid, h: await sha(secret) });
    };
    $('rmName' + side).onchange = e => {
      if (mySide() !== side) return;
      pub(`${S.round}/name/${side}`, { cid, v: e.target.value.trim().slice(0, 20) || side + '팀' });
    };
  });

  $('rmAgain').onclick = () => {
    if (!mySide() && !ss.get('vs_own_' + room)) return;
    pub('round', { id: hex(4), teamA: S.teamA, teamB: S.teamB });
  };

  // ---------- 진행 ----------
  async function step() {
    const me = mySide();
    if (me && S.commit.A && S.commit.B && !S.reveal[me]) {
      const secret = ss.get(`vs_sec_${room}_${S.round}_${me}`);
      if (secret && !S['_rev' + me]) { S['_rev' + me] = true; pub(`${S.round}/reveal/${me}`, { s: secret }); }
    }
    if (S.reveal.A && S.reveal.B && S.commit.A && S.commit.B && !S.shown) {
      S.shown = true;
      const round = S.round;
      const ok = (await sha(S.reveal.A.s)) === S.commit.A.h && (await sha(S.reveal.B.s)) === S.commit.B.h;
      if (!ok) { $('resR').innerHTML = '<div class="big atkc">⚠️ 검증 실패</div><div class="small">봉인 값과 공개 값이 달라요. 다시 하세요.</div>'; return showAgain(); }
      const h = await sha(S.reveal.A.s + '|' + S.reveal.B.s);
      const aIsAtk = parseInt(h.slice(0, 2), 16) % 2 === 0;
      $('resR').innerHTML = '';
      await spinR(aIsAtk);
      if (S.round !== round) return;
      const atk = aIsAtk ? S.teamA : S.teamB, def = aIsAtk ? S.teamB : S.teamA;
      $('resR').innerHTML = `<div class="big"><span class="atkc">${esc(atk)} 공격</span> · <span class="defc">${esc(def)} 수비</span></div><div class="small">검증 값 ${h.slice(0, 12)} · 모두에게 같은 값이면 정상</div>`;
      showAgain();
      if (typeof window.addHist === 'function') window.addHist(`[방 ${room.toUpperCase()}] ${atk} 공격 / ${def} 수비`);
    }
  }
  function showAgain() { $('rmAgain').classList.toggle('hidden', !(mySide() || ss.get('vs_own_' + room))); }

  function render() {
    if (!room) return;
    const me = mySide();
    SIDES.forEach(side => {
      const c = S.claim[side], btn = $('rmBtn' + side), who = $('rmWho' + side), nameEl = $('rmName' + side);
      if (document.activeElement !== nameEl) nameEl.value = S['team' + side];
      nameEl.readOnly = me !== side;
      btn.classList.toggle('hidden', me !== side);
      if (S.commit[side]) { who.innerHTML = '<span class="defc">✔ 준비 완료</span>'; btn.textContent = '준비 완료'; btn.disabled = true; }
      else if (c) { who.textContent = me === side ? '나 · 준비 버튼을 누르세요' : '팀장 입장 · 준비 대기'; btn.textContent = '준비!'; btn.disabled = false; }
      else { who.textContent = '팀장 대기 중'; }
    });
    const n = SIDES.filter(s => S.commit[s]).length;
    if (!S.shown && S.round) $('resR').innerHTML = `<div class="small">준비 ${n} / 2</div>`;
    let role;
    if (myCap && myCap.bad) role = '⚠️ 팀장 코드가 이 방과 맞지 않아요. 관전 모드로 볼게요.';
    else if (me) role = `당신은 ${me}팀장이에요. 팀 이름을 고치고 준비를 누르면 상대 팀장을 기다려요.`;
    else if (myCap) role = '팀장 자리에 들어가는 중…';
    else role = '관전 중이에요. 두 팀장이 모두 준비하면 자동으로 결과가 나와요.';
    $('rmMyRole').textContent = role;
  }

  let rotR = 0;
  function spinR(isAtk) {
    // 메인 페이지의 코인 애니메이션을 재사용
    if (typeof spin === 'function' && typeof rot === 'object') { if (rot.coinR == null) rot.coinR = 0; return spin('coinR', isAtk); }
    const el = $('coinR'), cur = rotR;
    const target = cur - (cur % 360) + 360 * 6 + (isAtk ? 0 : 180);
    rotR = target;
    el.animate(
      [{ transform: `rotateY(${cur}deg) translateY(0)` },
       { transform: `rotateY(${(cur + target) / 2}deg) translateY(-60px)`, offset: .5 },
       { transform: `rotateY(${target}deg) translateY(0)` }],
      { duration: 1800, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
    return new Promise(r => setTimeout(r, 1850));
  }

  enterFromHash();
})();
