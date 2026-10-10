
class Component extends DCLogic {
  HOURS = [[9,15],[8,18],[8,18],[8,18],[8,18],[8,18],[8,17]];
  DOW = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  DOWL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  PAGES = ['membership','wash','tint','detailing','experience','visit','join'];
  FEE = 25;
  WASH = [
    { id:'signature', name:'Signature Hand Wash', sub:'Exterior + interior · about 45 min', m:45 },
    { id:'exterior', name:'Exterior Hand Wash', sub:'Foam, hand wash, wheels, hand dry · about 30 min', m:32 },
  ];
  DURING = [
    { id:'wax', name:'Hand wax', sub:'Carnauba, buffed by hand', m:39, vip:'incl' },
    { id:'engine', name:'Engine bay wash', sub:'Degrease and dress', m:45, vip:'incl' },
    { id:'leather', name:'Leather conditioning', sub:'Clean, condition, matte finish', m:35, vip:'2× / mo' },
    { id:'stain', name:'Stain removal', sub:'Seats and carpets, when needed', m:59, vip:'1× / mo' },
    { id:'tire', name:'Tire shine & dressing', sub:'Satin or gloss', m:12 },
    { id:'rain', name:'Rain-repellent glass', sub:'Windshield and side glass', m:25 },
    { id:'odor', name:'Odor removal', sub:'Enzyme treatment', m:30 },
    { id:'pet', name:'Pet hair removal', sub:'Rubber brush and vacuum', m:35 },
    { id:'deep', name:'Interior deep clean', sub:'Seats, carpets, vents', m:60 },
  ];
  TINT = { carbon:{ sedan:[229,279], suv:[269,329], truck:[249,299] }, ceramic:{ sedan:[379,449], suv:[429,529], truck:[399,479] } };
  VEH = [['sedan','Sedan / Coupe'],['suv','SUV / Crossover'],['truck','Truck / Van']];
  STAGES = [
    ['Foam pre-soak','Thick pH-neutral foam lifts grit off the paint before anything touches it.'],
    ['Two-bucket hand wash','Soft mitts, one panel at a time, with clean rinse water for every pass. No brushes and no tunnel.'],
    ['Spot-free rinse','Filtered water carries the foam and dirt off from top to bottom.'],
    ['Hand dry & gloss','Plush microfiber towels by hand, then a ceramic spray sealant for the gloss.'],
  ];
  heroRef = React.createRef(); beadRef = React.createRef(); washRef = React.createRef(); washCv = React.createRef(); smsRef = React.createRef(); tintRef = React.createRef(); priceRef = React.createRef(); revealRef = React.createRef(); revealMask = React.createRef(); revealBar = React.createRef(); cardRef = React.createRef(); shineRef = React.createRef();

  state = (() => { const r = this.parseHash(); return {
    page: r.page, prevPage: 'home', menu: false, themeOverride: null,
    board: 0, pod: 'all', boardAll: false, flapAt: Date.now(), stage: 0, showBar: false, priceRevealed: false,
    sheet: null, step: null, tier: null,
    bk: { who:null, phone:'', vehicle:'sedan', svc:'signature', addons:[], day:0, slot:null, ack:false, lock:null, phoneErr:false },
    jn: this.freshJn(r.tier),
    smsStep: 0, smsTyping: false, vlt: 20, film: 'ceramic', tintVeh: 'sedan', split: 52,
    faq: 0, toast: null, washes: 4, now: Date.now(), beadTouched: false,
  }; })();

  freshJn(tier){ return { tier: tier || 'vip', step: 0, vehicles: [{ car:'', plate:'' }], name:'', phone:'', email:'', card:'', exp:'', cvc:'', agree:false, err:'' }; }
  parseHash(){ const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, ''); const [p, q] = h.split('?'); return { page: this.PAGES.includes(p) ? p : 'home', tier: (q || '').indexOf('gold') >= 0 ? 'gold' : 'vip' }; }
  g(m){ return Math.round(m * 1.2); }
  $(n){ return '$' + Math.round(n).toLocaleString('en-US'); }
  fmt(m){ let h = Math.floor(m/60), mm = m%60; const ap = h >= 12 ? 'PM' : 'AM'; h = h%12 || 12; return h + ':' + String(mm).padStart(2,'0') + ' ' + ap; }
  rng(seed){ let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
  flash(t){ this.setState({ toast:t }); clearTimeout(this._tt); this._tt = setTimeout(() => this.setState({ toast:null }), 2600); }
  theme(){ return this.state.themeOverride || (this.props.theme === 'light' ? 'light' : 'dark'); }
  go(page, q){ location.hash = '#/' + (page === 'home' ? '' : page) + (q ? '?' + q : ''); }
  scrollToId(id){ const run = () => { const el = document.getElementById(id); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 90, behavior:'smooth' }); }; if (this.state.page !== 'home') { this.go('home'); setTimeout(run, 120); } else run(); }

  get days(){
    if (this._days && Date.now() - this._daysAt < 60000) return this._days;
    const now = new Date(), out = [], nm = now.getHours()*60 + now.getMinutes();
    for (let i = 0; out.length < 5 && i < 10; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const [o, c] = this.HOURS[d.getDay()]; const r = this.rng(d.getFullYear()*1000 + d.getMonth()*40 + d.getDate());
      const slots = [];
      for (let m = o*60; m <= c*60 - 60; m += 30) {
        const x = r(), y = r(); const prime = (d.getDay() === 6 && m < 11*60) || m >= 16*60;
        let st = x < 0.38 ? 'booked' : (x < (prime ? 0.64 : 0.5) ? 'members' : 'open');
        const bays = st === 'open' ? (y < 0.3 ? 1 : (y < 0.75 ? 2 : 3)) : (st === 'members' ? 1 : 0);
        if (st === 'open' && bays === 1) st = 'last';
        if (i === 0 && m < nm + 30) continue;
        slots.push({ m, st, bays });
      }
      if (slots.length) out.push({ d, i, slots, word: i === 0 ? 'Today' : (i === 1 ? 'Tomorrow' : this.DOWL[d.getDay()]) });
    }
    this._days = out; this._daysAt = Date.now(); return out;
  }
  bays(){
    const n = new Date(), [o, c] = this.HOURS[n.getDay()], m = n.getHours()*60 + n.getMinutes();
    if (m >= o*60 && m < c*60) { const open = 1 + Math.floor(m/11) % 3; return { short: open + ' OF 3 BAYS OPEN NOW', open:true }; }
    if (m < o*60) return { short: 'OPENS TODAY ' + this.fmt(o*60).replace(':00',''), open:false };
    const t = new Date(n.getFullYear(), n.getMonth(), n.getDate()+1); return { short: 'OPENS ' + this.DOW[t.getDay()] + ' ' + this.fmt(this.HOURS[t.getDay()][0]*60).replace(':00',''), open:false };
  }

  componentDidMount(){
    this._raf = requestAnimationFrame(this.frame);
    this._onScroll = () => {
      const y = window.scrollY; const show = this.state.page !== 'join' && y > 520; if (show !== this.state.showBar) this.setState({ showBar:show });
      const w = this.washRef.current;
      if (w) { const r = w.getBoundingClientRect(); const span = r.height - (window.innerHeight - 84); const p = Math.max(0, Math.min(1, (84 - r.top) / Math.max(1, span))); this._washP = p; const st = Math.min(3, Math.floor(p * 4)); if (st !== this.state.stage) this.setState({ stage:st }); }
      this.scrollReveal();
    };
    window.addEventListener('scroll', this._onScroll, { passive:true });
    this._hc = () => { const r = this.parseHash(); this.setState(s => ({ page:r.page, menu:false, prevPage: s.page !== 'join' ? s.page : s.prevPage, jn: r.page === 'join' && s.page !== 'join' ? { ...this.freshJn(r.tier), name:s.jn.name, phone:s.jn.phone } : s.jn }), () => { window.scrollTo(0, 0); this.observe(); this._onScroll(); }); };
    window.addEventListener('hashchange', this._hc);
    this._clock = setInterval(() => this.setState({ now:Date.now() }), 30000);
    this.observe(); this._onScroll();
  }
  componentDidUpdate(){ const lock = !!this.state.sheet || this.state.menu; if (lock !== !!this._lockOn) { this._lockOn = lock; document.body.style.overflow = lock ? 'hidden' : ''; } const bg = this.theme() === 'light' ? '#F2F3F1' : '#06080A'; if (document.body.style.background !== bg) document.body.style.background = bg; }
  componentWillUnmount(){ cancelAnimationFrame(this._raf); window.removeEventListener('scroll', this._onScroll); window.removeEventListener('hashchange', this._hc); clearInterval(this._clock); if (this._io) this._io.disconnect(); clearTimeout(this._smsT); clearTimeout(this._tt); document.body.style.overflow = ''; }
  observe(){
    if (this._io) this._io.disconnect(); if (!('IntersectionObserver' in window)) { this.setState({ priceRevealed:true }); return; }
    this._io = new IntersectionObserver(es => es.forEach(e => { if (!e.isIntersecting) return;
      if (e.target === this.smsRef.current && !this._smsPlayed) { this._smsPlayed = true; this.playSms(); }
      if (e.target === this.priceRef.current && !this.state.priceRevealed) setTimeout(() => this.setState({ priceRevealed:true }), 250); }), { threshold:0, rootMargin:'0px 0px -35% 0px' });
    setTimeout(() => { [this.smsRef.current, this.priceRef.current].forEach(el => el && this._io.observe(el)); }, 60);
  }
  scrollReveal(){
    const sec = this.revealRef.current; if (!sec) return;
    const r = sec.getBoundingClientRect(); const span = r.height - (window.innerHeight - 84); const p = Math.max(0, Math.min(1, (84 - r.top) / Math.max(1, span)));
    const x = this.sm(0.04, 0.55, p) * 124 - 12;
    const m = this.revealMask.current; if (m) m.style.background = 'linear-gradient(100deg,rgba(3,4,5,.18) 0%,rgba(3,4,5,.18) ' + x + '%,rgba(3,4,5,.97) ' + (x + 16) + '%,rgba(3,4,5,.97) 100%)';
    const b = this.revealBar.current; if (b) { b.style.left = (x + 8) + '%'; b.style.opacity = p > 0.02 && p < 0.58 ? '1' : '0'; }
    sec.querySelectorAll('[data-l]').forEach(el => { const i = +el.getAttribute('data-l'); const lp = this.sm(0.4 + i*0.028, 0.58 + i*0.028, p); el.style.transform = 'rotateY(' + ((1 - lp) * -88) + 'deg)'; el.style.opacity = String(0.12 + lp*0.88); });
    sec.querySelectorAll('[data-ln]').forEach(el => { const i = +el.getAttribute('data-ln'); const lp = this.sm(0.7 + i*0.07, 0.78 + i*0.07, p); el.style.opacity = String(lp); el.style.transform = 'translateY(' + ((1 - lp) * 14) + 'px)'; });
  }

  frame = (ts) => {
    this._raf = requestAnimationFrame(this.frame);
    if (this.props.beads !== false) this.drawBeads();
    this.drawWash(ts);
    if (Date.now() - this.state.flapAt < 1400 && (!this._lf || ts - this._lf > 45)) { this._lf = ts; this.forceUpdate(); }
  };
  sizeCanvas(cv){ const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight; if (cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)) { cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); cv._fresh = true; } const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); return { ctx, W, H }; }
  bead(ctx, x, y, r, a, light){
    ctx.globalAlpha = a;
    ctx.fillStyle = light ? 'rgba(40,60,80,0.16)' : 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(x + r*0.2, y + r*0.35, r*1.02, 0, 6.283); ctx.fill();
    const gr = ctx.createRadialGradient(x - r*0.3, y - r*0.35, r*0.05, x, y, r);
    if (light) { gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(205,228,242,0.35)'); gr.addColorStop(0.85, 'rgba(90,110,130,0.32)'); gr.addColorStop(1, 'rgba(255,255,255,0.85)'); }
    else { gr.addColorStop(0, 'rgba(255,255,255,0.32)'); gr.addColorStop(0.45, 'rgba(110,180,225,0.10)'); gr.addColorStop(0.82, 'rgba(8,14,20,0.4)'); gr.addColorStop(1, 'rgba(210,235,255,0.42)'); }
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
    ctx.fillStyle = 'rgba(31,182,255,' + (light ? 0.22 : 0.3) + ')'; ctx.beginPath(); ctx.ellipse(x + r*0.1, y + r*0.48, r*0.55, r*0.26, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.beginPath(); ctx.ellipse(x - r*0.36, y - r*0.42, r*0.26, r*0.17, -0.6, 0, 6.283); ctx.fill();
    ctx.globalAlpha = 1;
  }
  drawBeads(){
    const cv = this.beadRef.current, hero = this.heroRef.current; if (!cv || !hero) return;
    const rect = hero.getBoundingClientRect(); if (rect.bottom < 0) return;
    const { ctx, W, H } = this.sizeCanvas(cv); const light = this.theme() === 'light';
    if (!this._beads || cv._fresh) { cv._fresh = false; const r = this.rng(11); const n = Math.min(320, Math.round(W*H/1300)); this._beads = Array.from({ length:n }, () => { const s = r(); const rad = s < 0.68 ? 1.4 + r()*2.8 : (s < 0.94 ? 4 + r()*4 : 8.5 + r()*6); return { x:r()*W, y:r()*H*0.98, r:rad, v:0.45 + r()*0.9, wob:r()*6.28, gone:0 }; }); }
    ctx.clearRect(0, 0, W, H);
    const p = Math.max(0, Math.min(1, (84 - rect.top) / (H*0.85))); const now = performance.now(); const pt = this._ptr;
    for (const b of this._beads) {
      let a = 1;
      if (b.gone) { const age = now - b.gone; if (age < 5000) continue; a = Math.min(1, (age - 5000)/1800); if (a >= 1) b.gone = 0; }
      const fall = Math.pow(p, 1.5) * H * 1.35 * (0.35 + b.r/7) * b.v;
      const y = b.y + fall, x = b.x + Math.sin(b.wob + fall*0.03) * Math.min(7, fall*0.05);
      if (pt && now - pt.t < 80 && Math.hypot(x - pt.x, y - pt.y) < 30 + b.r) { b.gone = now; continue; }
      if (y - b.r > H) continue;
      if (fall > 3) { ctx.strokeStyle = light ? 'rgba(80,120,160,' + (0.07*a) + ')' : 'rgba(170,215,255,' + (0.06*a) + ')'; ctx.lineWidth = Math.max(1, b.r*0.8); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(x, y - b.r*0.4); ctx.stroke(); }
      this.bead(ctx, x, y, b.r, a, light);
    }
  }
  sm(a, b, t){ const x = Math.max(0, Math.min(1, (t - a)/(b - a))); return x*x*(3 - 2*x); }
  drawWash(ts){
    const cv = this.washCv.current; if (!cv) return;
    const rr = cv.getBoundingClientRect(); if (rr.bottom < 0 || rr.top > window.innerHeight) return;
    const { ctx, W, H } = this.sizeCanvas(cv); const t = this._washP || 0;
    if (!this._foam || cv._fresh) { cv._fresh = false; const r = this.rng(5);
      this._foam = Array.from({ length:340 }, () => ({ x:r(), y:0.04 + Math.pow(r(),0.85)*0.9, r:6 + r()*18 }));
      this._dust = Array.from({ length:220 }, () => ({ x:r(), y:r(), r:0.6 + r()*1.6 }));
      this._drops = Array.from({ length:150 }, () => ({ x:r(), y:r(), r:1.5 + r()*5 })); }
    const clean = this.sm(0.72, 1, t);
    const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0F151B'); bg.addColorStop(0.42, '#18222B'); bg.addColorStop(0.46, '#0A0E12'); bg.addColorStop(1, '#040507');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const refl = ctx.createLinearGradient(0, 0, W, H); refl.addColorStop(0.25, 'rgba(255,255,255,0)'); refl.addColorStop(0.42, 'rgba(255,255,255,' + (0.05 + clean*0.12) + ')'); refl.addColorStop(0.52, 'rgba(255,255,255,0)');
    ctx.fillStyle = refl; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(200,230,255,' + (0.25 + clean*0.55) + ')'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-10, H*0.47); ctx.bezierCurveTo(W*0.3, H*0.4, W*0.7, H*0.42, W + 10, H*0.36); ctx.stroke();
    const rinseY = t < 0.47 ? -1e9 : ((t - 0.47)/0.24) * H*1.25 - H*0.1;
    ctx.fillStyle = 'rgba(160,140,115,0.35)';
    for (const d of this._dust) { const y = d.y*H; if (y < rinseY) continue; ctx.beginPath(); ctx.arc(d.x*W, y, d.r, 0, 6.283); ctx.fill(); }
    const n = Math.floor(this._foam.length * this.sm(0.02, 0.22, t));
    const washOn = t > 0.22 && t < 0.5; const mx = W*(0.5 + 0.33*Math.sin(ts/650)), my = H*(0.5 + 0.24*Math.sin(ts/325));
    for (let i = 0; i < n; i++) { const f = this._foam[i]; let x = f.x*W, y = f.y*H;
      if (washOn) { const dx = x - mx, dy = y - my, dd = Math.hypot(dx, dy) || 1; if (dd < 70) { x += dx/dd*(70 - dd)*0.5; y += dy/dd*(70 - dd)*0.5; } }
      if (y < rinseY - 30) continue; const fa = y < rinseY ? (y - rinseY + 30)/30 : 1;
      ctx.globalAlpha = 0.9*fa; ctx.fillStyle = '#F4F7FA'; ctx.beginPath(); ctx.arc(x, y, f.r, 0, 6.283); ctx.fill();
      ctx.globalAlpha = 0.5*fa; ctx.strokeStyle = '#B9C6D1'; ctx.lineWidth = 1; ctx.stroke();
      ctx.globalAlpha = 0.8*fa; ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.arc(x - f.r*0.35, y - f.r*0.35, f.r*0.22, 0, 6.283); ctx.fill(); }
    ctx.globalAlpha = 1;
    if (washOn) { const a = this.sm(0.22, 0.27, t) * (1 - this.sm(0.45, 0.5, t)); ctx.globalAlpha = a;
      const mg = ctx.createRadialGradient(mx - 10, my - 12, 4, mx, my, 46); mg.addColorStop(0, '#E8F6FF'); mg.addColorStop(0.6, '#7FCBF2'); mg.addColorStop(1, 'rgba(31,182,255,0.0)');
      ctx.fillStyle = mg; ctx.beginPath(); ctx.ellipse(mx, my, 46, 38, Math.sin(ts/500)*0.4, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; for (let k = 0; k < 14; k++) { const ang = k/14*6.283 + ts/400; ctx.beginPath(); ctx.arc(mx + Math.cos(ang)*30, my + Math.sin(ang)*24, 2.2, 0, 6.283); ctx.fill(); }
      ctx.globalAlpha = 1; }
    if (t > 0.47 && t < 0.78) { const a = 1 - this.sm(0.7, 0.78, t);
      for (let i = 0; i < 30; i++) { const x = (i + 0.5)/30*W + Math.sin(i*12.9)*8; const len = Math.min(rinseY, H);
        ctx.strokeStyle = 'rgba(190,230,255,' + (0.08 + (i%3)*0.04)*a + ')'; ctx.lineWidth = 2 + (i%4); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + Math.sin(ts/300 + i)*3, len); ctx.stroke(); }
      const band = ctx.createLinearGradient(0, rinseY - 40, 0, rinseY + 6); band.addColorStop(0, 'rgba(31,182,255,0)'); band.addColorStop(1, 'rgba(190,235,255,' + 0.45*a + ')'); ctx.fillStyle = band; ctx.fillRect(0, rinseY - 40, W, 46); }
    const dryX = t < 0.76 ? -1e9 : ((t - 0.76)/0.16) * W*1.25 - W*0.1;
    if (t > 0.5) { for (const d of this._drops) { const x = d.x*W, y = d.y*H; if (y > rinseY || x < dryX) continue; this.bead(ctx, x, y, d.r, this.sm(0.5, 0.6, t), false); } }
    if (t > 0.76 && t < 0.95) { const tw = ctx.createLinearGradient(dryX - 60, 0, dryX + 10, 0); tw.addColorStop(0, 'rgba(230,238,244,0)'); tw.addColorStop(1, 'rgba(230,238,244,0.28)'); ctx.fillStyle = tw; ctx.fillRect(dryX - 60, 0, 70, H); }
    if (t > 0.9) { const sx = ((t - 0.9)/0.1) * W*1.8 - W*0.4; const sh = ctx.createLinearGradient(sx - 120, 0, sx + 120, H*0.4); sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, 'rgba(255,255,255,0.32)'); sh.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = sh; ctx.fillRect(0, 0, W, H); }
  }

  SMS(){ const d = this.days[0]; const o = d ? d.slots.filter(s => s.st === 'open' || s.st === 'last').slice(0, 3) : []; const ts = o.length === 3 ? o.map(s => this.fmt(s.m)) : ['11:30 AM','1:00 PM','2:30 PM']; const w = d ? d.word.toLowerCase() : 'today';
    return [ { me:true, t:'WASH' }, { me:false, t:'Hi, it’s Oasis Auto Spa. Open ' + w + ': 1) ' + ts[0] + '  2) ' + ts[1] + '  3) ' + ts[2] + '. Reply 1, 2 or 3.' }, { me:true, t:'2' }, { me:false, t:'Booked: Signature Hand Wash, ' + w + ' at ' + ts[1] + '. Members never pay a booking fee. Reply C to change.' }, { me:true, t:'Perfect, see you then' } ]; }
  playSms(){ const S = this.SMS(); const step = () => { const s = this.state.smsStep; if (s >= S.length) return; if (!S[s].me) { this.setState({ smsTyping:true }); this._smsT = setTimeout(() => { this.setState({ smsTyping:false, smsStep:s + 1 }); this._smsT = setTimeout(step, 1000); }, 1400); } else { this._smsT = setTimeout(() => { this.setState({ smsStep:s + 1 }); this._smsT = setTimeout(step, 600); }, 700); } }; step(); }

  openBook(p){ this.setState(s => ({ menu:false, sheet:'book', step: s.tier ? 'svc' : 'who', bk:{ ...s.bk, ...(s.tier ? { who:'member' } : {}), ack:false, lock:null, phoneErr:false, ...(p || {}) } })); }
  pickSlot(di, sl){ if (sl.st === 'booked') { this.flash('That time is booked. Try another.'); return; } this.openBook({ day:di, slot:sl.m }); }
  setBk(p){ this.setState(s => ({ bk:{ ...s.bk, ...p } })); }
  setJn(p){ this.setState(s => ({ jn:{ ...s.jn, ...p } })); }
  joinTo(tier){ this.setState({ sheet:null, menu:false }); this.go('join', tier); }

  seg(on){ return { flex:1, height:'42px', padding:'0 12px', borderRadius:'11px', fontWeight:800, fontSize:'14px', whiteSpace:'nowrap', background:on ? '#1FB6FF' : 'transparent', color:on ? '#00131D' : 'var(--ink2)', transition:'background .25s,color .25s' }; }
  chip(on){ return { height:'44px', padding:'0 15px', borderRadius:'13px', fontWeight:700, fontSize:'14px', background:on ? 'var(--cyanSoft)' : 'transparent', color:on ? 'var(--cyanInk)' : 'var(--ink2)', border:'1px solid ' + (on ? 'var(--cyanBrd)' : 'var(--line)') }; }

  homeVM(){
    const s = this.state, days = this.days, bay = this.bays();
    const liveDot = React.createElement('span', { style:{ flex:'none', width:'8px', height:'8px', borderRadius:'50%', background:bay.open ? '#1FB6FF' : '#59636D', animation:bay.open ? 'oaPulse 1.8s infinite' : 'none' } });
    const n = s.washes, guestCost = n * (this.g(45) + this.FEE), save = guestCost - 99;
    const di = Math.min(s.board, Math.max(0, days.length - 1)); const day = days[di];
    const el = Date.now() - s.flapAt; const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const cells = (str, row, off, col) => str.split('').map((ch, i) => { const done = el > 160 + row*42 + (i + off)*20; return { ch: done ? (ch === ' ' ? '\u00a0' : ch) : CH[(i*7 + row*13 + Math.floor(el/45)) % 36], col: done ? col : '#46515B' }; });
    const ST = { open:['OPEN','#2EE59D'], last:['LAST 1','#FFB547'], members:['VIP','#F2F5F7'], booked:['BOOKED','#FF5A52'] };
    const POD = { all:() => true, am:(m) => m < 660, mid:(m) => m >= 660 && m < 840, pm:(m) => m >= 840 };
    const filtered = day ? day.slots.filter(x => POD[s.pod](x.m)) : []; const shown = s.boardAll ? filtered : filtered.slice(0, 8);
    const boardRows = shown.map((sl, ri) => { const [hm, ap] = this.fmt(sl.m).split(' '); const st = ST[sl.st]; const bk = sl.st === 'booked';
      return { timeCells:cells(hm.padStart(5,' '), ri, 0, bk ? '#5E6A75' : '#F2F5F7'), ap, stCells:cells(st[0].padEnd(7,' '), ri, 6, st[1]),
        bays:[0,1,2].map(k => ({ style:{ width:'7px', height:'7px', borderRadius:'50%', background: k < sl.bays ? (sl.st === 'members' ? '#F2F5F7' : (sl.st === 'last' ? '#FFB547' : '#2EE59D')) : '#1E252C' } })),
        arrow: bk ? '#2A3139' : '#7FD6FF', pick:() => this.pickSlot(di, sl),
        rowStyle:{ display:'flex', alignItems:'center', gap:'12px', width:'100%', minHeight:'54px', padding:'0 16px', borderBottom:'1px solid rgba(255,255,255,.05)', opacity: bk ? 0.85 : 1, cursor: bk ? 'default' : 'pointer', textAlign:'left', color:'#F2F5F7' } }; });
    const openCount = (d) => d.slots.filter(x => x.st === 'open' || x.st === 'last').length;
    const dayCards = days.map((d, i) => { const on = i === di; return { top: i === 0 ? 'TODAY' : this.DOW[d.d.getDay()], num:String(d.d.getDate()), count: openCount(d) + ' open', onClick:() => this.setState({ board:i, flapAt:Date.now(), boardAll:false }),
      style:{ height:'82px', borderRadius:'16px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:'1px', background: on ? '#1FB6FF' : 'var(--panel)', color: on ? '#00131D' : 'var(--ink)', border:'1px solid ' + (on ? '#1FB6FF' : 'var(--line)'), boxShadow: on ? '0 10px 26px rgba(31,182,255,.3)' : 'none', transition:'all .25s' } }; });
    const podChips = [['all','All day'],['am','Morning'],['mid','Midday'],['pm','Afternoon']].map(([k, l]) => ({ label:l, onClick:() => this.setState({ pod:k, flapAt:Date.now(), boardAll:false }), style:{ flex:'none', height:'36px', padding:'0 13px', borderRadius:'10px', fontFamily:"'JetBrains Mono',monospace", fontSize:'11px', fontWeight:800, letterSpacing:'.08em', textTransform:'uppercase', background: s.pod === k ? '#F2F5F7' : 'transparent', color: s.pod === k ? '#06080A' : '#7D8893', border:'1px solid ' + (s.pod === k ? '#F2F5F7' : 'rgba(255,255,255,.1)') } }));
    let next = null; for (let i = 0; i < days.length && !next; i++) { const sl = days[i].slots.find(x => x.st === 'open' || x.st === 'last'); if (sl) next = { i, sl }; }
    const nowD = new Date(s.now);
    const p = this._washP || 0;
    const S = this.SMS();
    const smsShown = S.slice(0, s.smsStep).map(m => ({ t:m.t, wrap:{ display:'flex', justifyContent: m.me ? 'flex-end' : 'flex-start', animation:'oaIn .35s cubic-bezier(.2,.8,.2,1)' }, bubble:{ maxWidth:'82%', padding:'10px 14px', borderRadius: m.me ? '18px 18px 5px 18px' : '18px 18px 18px 5px', background: m.me ? '#1FB6FF' : 'var(--inset)', color: m.me ? '#00131D' : 'var(--ink)', fontSize:'14.5px', lineHeight:1.4, fontWeight: m.me ? 700 : 500 } }));
    const typingEl = React.createElement('div', { style:{ display:'flex' } }, React.createElement('div', { style:{ display:'flex', gap:'5px', padding:'14px 16px', borderRadius:'18px 18px 18px 5px', background:'var(--inset)' } }, [0,1,2].map(k => React.createElement('span', { key:k, style:{ width:'7px', height:'7px', borderRadius:'50%', background:'var(--ink3)', animation:'oaDot 1.1s ' + (k*0.16) + 's infinite' } }))));
    return {
      liveDot, baysShort: bay.short, showBeadHint: !s.beadTouched && this.props.beads !== false,
      onHeroMove:(e) => { const h = this.heroRef.current; if (!h) return; const r = h.getBoundingClientRect(); this._ptr = { x:e.clientX - r.left, y:e.clientY - r.top, t:performance.now() }; if (!s.beadTouched) this.setState({ beadTouched:true }); },
      scrollTimes:() => this.scrollToId('times'),
      washOpts:[1,2,3,4].map(k => ({ label:k + '×', onClick:() => this.setState({ washes:k }), style:{ ...this.seg(s.washes === k), flex:'none', width:'52px', height:'40px' } })),
      calcGuest:this.$(guestCost), calcGuestSub: n + ' × ($' + this.g(45) + ' wash + $25 fee)',
      calcSave: save > 0 ? 'Save ' + this.$(save) + '/mo' : 'Pays off at 2 washes', calcSaveSub: save > 0 ? 'with Gold at ' + n + ' wash' + (n > 1 ? 'es' : '') + ' a month' : '2 guest washes cost $158',
      goldPerks:['4 hand washes a month, interior included','Mix and match across household vehicles','No booking fee, ever','Member prices on tint, detailing and add-ons','Priority support by text'],
      vipPerks:[ { t:'Wax with every wash' }, { t:'Engine bay wash' }, { t:'Leather conditioning 2× a month' }, { t:'Stain removal 1× a month', s:'When needed' }, { t:'Priority booking', s:'Reserved prime times, 30-day window, first pick of cancellations, same-day guarantee' }, { t:'Standing appointment', s:'Your time, every week or two, confirmed automatically' } ],
      clockLabel: this.DOW[nowD.getDay()] + ' ' + this.MON[nowD.getMonth()].toUpperCase() + ' ' + nowD.getDate() + ' · ' + this.fmt(nowD.getHours()*60 + nowD.getMinutes()),
      hasNext: !!next, nextLabel: next ? days[next.i].word + ' · ' + this.fmt(next.sl.m) : '', nextSub: next ? next.sl.bays + ' bay' + (next.sl.bays > 1 ? 's' : '') + ' open · Signature Hand Wash takes about 45 min' : '',
      bookNext:() => { if (next) this.pickSlot(next.i, next.sl); },
      dayCards, podChips, boardRows, boardEmpty: filtered.length === 0, boardHasMore: filtered.length > 8, boardMoreLabel: s.boardAll ? 'SHOW FEWER' : 'SHOW ALL ' + filtered.length + ' TIMES',
      toggleBoardAll:() => this.setState({ boardAll:!s.boardAll, flapAt: s.boardAll ? s.flapAt : Date.now() }),
      stageName:this.STAGES[s.stage][0], stageText:this.STAGES[s.stage][1], stageNum:'0' + (s.stage + 1),
      stageBars:[0,1,2,3].map(k => ({ fill:{ height:'100%', background:'#1FB6FF', borderRadius:'2px', width: Math.max(0, Math.min(1, p*4 - k))*100 + '%' } })),
      smsShown, smsTyping:s.smsTyping, typingEl, replaySms:() => { clearTimeout(this._smsT); this.setState({ smsStep:0, smsTyping:false }, () => this.playSms()); },
    };
  }
  priceVM(){
    const s = this.state, pg = s.page; let i = 0;
    const row = (name, sub, m, gp, o) => ({ name, sub, priced:true, quote:false, pre:'', g:'$' + gp, v:'$' + m, save:'SAVE $' + (gp - m), vSize:'20px', nameSize:'16px', delay:(i++ * 60) + 'ms', ...(o || {}) });
    const incl = (name, sub, gp) => row(name, sub, 0, gp, { v:'Included', vSize:'17px', save:'SAVE $' + gp });
    const G = {
      wash:{ n:'01', title:'Hand wash', size:'22px', cols:true, rows:[ incl('Signature Hand Wash', 'Exterior + interior · about 45 min', this.g(45)), incl('Exterior Hand Wash', 'Foam, hand wash, wheels, hand dry · about 30 min', this.g(32)) ].map(r => ({ ...r, nameSize:'18px' })) },
      during:{ n:'02', title:'Add during your wash', size:'19px', cols:true, note:'Done in the same visit. No extra appointment.', rows:this.DURING.map(a => a.vip ? incl(a.name, a.vip === 'incl' ? a.sub + ' · included with VIP' : a.sub + ' · ' + a.vip + ' with VIP', this.g(a.m)) : row(a.name, a.sub, a.m, this.g(a.m))) },
      tint:{ n:'03', title:'Window tint', size:'19px', cols:true, rows:this.VEH.map(([k, l]) => row(l, 'Carbon or ceramic film · side & rear windows', this.TINT.carbon[k][0], this.g(this.TINT.carbon[k][0]), { pre:'from' })) },
      tintFull:{ n:'01', title:'Window tint', size:'19px', cols:true, rows:this.VEH.flatMap(([k, l]) => ['carbon','ceramic'].map(f => { const r = this.TINT[f][k]; return row(l + ' · ' + (f === 'carbon' ? 'Carbon' : 'Ceramic'), 'VIP ' + this.$(r[0]) + '–' + this.$(r[1]) + ' · guest ' + this.$(this.g(r[0])) + '–' + this.$(this.g(r[1])), r[0], this.g(r[0]), { pre:'from' }); })) },
      detail:{ n:'04', title:'Detailing', size:'19px', cols:true, rows:[ row('Interior detail', 'Shampoo, steam, leather, glass', 149, this.g(149)), row('Full detail', 'Inside and out, clay bar + sealant', 249, this.g(249)) ] },
      more:{ n:'05', title:'More services', size:'17px', cols:false, note:'Priced per vehicle. Send a photo and we\u2019ll reply with a quote.', quoteCta:true, quoteHref:'sms:+12015986304?&body=' + encodeURIComponent('Quote request: '), rows:['Windshield replacement','Rim powder coating','Chrome delete','Car key copies'].map(nm => ({ name:nm, sub:'', priced:false, nameSize:'15.5px' })) },
    };
    const cfg = { home:['04 · Services & pricing','Wash first.','Then tint.',['wash','during','tint','detail','more'],true], wash:['Pricing','Wash +','add-ons.',['wash','during'],true], tint:['Tint pricing','By vehicle','& film.',['tintFull'],false], detailing:['Pricing','Detail','& more.',['detail','more'],false] }[pg];
    const vm = [ ['4 Signature washes', 4*this.g(45)], ['4 booking fees', 100], ['Hand wax ×4', 4*this.g(39)], ['Engine bay wash', this.g(45)], ['Leather conditioning ×2', 2*this.g(35)], ['Stain removal', this.g(59)] ];
    const vmTotal = vm.reduce((a, x) => a + x[1], 0);
    const FAQ = [
      ['How does membership work?', 'Gold and VIP include 4 hand washes a month with the interior cleaned every time. Use them on any car in your household, in any mix. Billed monthly.'],
      ['Is the guest booking fee refundable?', 'No. Guests pay a $25 non-refundable booking fee to hold a time, on top of guest pricing. Members never pay it.'],
      ['What does VIP priority booking mean?', 'Reserved prime-time slots, booking 30 days ahead, first pick when someone cancels, a same-day guarantee and an optional standing appointment.'],
      ['Do you work on high-end and leased cars?', 'Yes. We regularly handle luxury and leased vehicles with premium products and hand tools only.'],
    ];
    return {
      hasPrices: !!cfg, prEyebrow: cfg ? cfg[0] : '', prTitle1: cfg ? cfg[1] : '', prTitle2: cfg ? cfg[2] : '',
      prGroups: cfg ? cfg[3].map(k => ({ ...G[k], note: G[k].note || '', quoteCta: !!G[k].quoteCta, quoteHref: G[k].quoteHref || '' })) : [], prShowMonth: cfg ? cfg[4] : false, prRot: s.priceRevealed ? '180deg' : '0deg',
      vipMonth: vm.map(([label, v]) => ({ label, value:this.$(v) })), vipMonthGuest:this.$(vmTotal), vipMonthSave:'Save ' + this.$(vmTotal - 169) + '/mo',
      faqs: FAQ.map(([q, a], k) => { const open = s.faq === k; return { q, a, open, toggle:() => this.setState({ faq: open ? null : k }), icon:{ flex:'none', width:'30px', height:'30px', borderRadius:'9px', display:'flex', alignItems:'center', justifyContent:'center', background: open ? '#1FB6FF' : 'var(--btn2)', color: open ? '#00131D' : 'var(--ink2)', transform: open ? 'rotate(45deg)' : 'none', transition:'transform .3s, background .3s' } }; }),
    };
  }
  tintAt(e){ const el = this.tintRef.current; if (!el) return; const r = el.getBoundingClientRect(); const x = Math.max(6, Math.min(97, (e.clientX - r.left)/r.width*100)); this.setState({ split:Math.round(x) }); }
  pagesVM(){
    const s = this.state, pg = s.page;
    const SUB = {
      membership:['Membership','Two plans.','Zero fees.','Both plans include 4 hand washes a month with the interior done every time. VIP adds the extras and puts your time first.'],
      wash:['Wash & add-ons','The hand','wash.','Everything starts here. Pick a wash, then add what you want done in the same visit.'],
      tint:['Window tint','Try the','shade.','Drag across the glass to compare factory glass with your film. Carbon and ceramic, installed in-house.'],
      detailing:['Detailing & more','Deeper','than clean.','Interior and full details, plus the extras: windshields, rims, chrome delete and key copies.'],
      visit:['Visit','Come','see us.','Just off River Drive in Garfield. Text ahead and we\u2019ll have a bay ready.'],
    }[pg];
    const VLT = [[5,'Limo'],[20,'Dark'],[35,'Medium'],[50,'Light'],[70,'Clear']];
    const tintAlpha = Math.min(0.94, (1 - s.vlt/100) * 0.98);
    const heat = s.film === 'ceramic' ? Math.round(55 + (70 - s.vlt) * 0.45) : Math.round(28 + (70 - s.vlt) * 0.35);
    const rng = this.TINT[s.film][s.tintVeh]; const gr = rng.map(x => this.g(x));
    const vehLabel = this.VEH.find(v => v[0] === s.tintVeh)[1];
    const C = (v) => v === true ? { ok:true } : (v === false ? { no:true } : { t:v });
    const comp = [ ['Hand washes a month','Pay each','4','4'], ['Interior every wash','Signature only',true,true], ['Booking fee','$25','$0','$0'], ['Prices on add-ons & tint','Guest','Member','Member'], ['Share across household cars',false,true,true], ['Wax every wash',false,false,true], ['Engine bay wash',false,false,true], ['Leather conditioning',false,false,'2× / mo'], ['Stain removal',false,false,'1× / mo'], ['Booking window','14 days','14 days','30 days'], ['Reserved prime times',false,false,true], ['First pick of cancellations',false,false,true], ['Same-day guarantee',false,false,true], ['Standing appointment',false,false,true], ['Priority support by text',false,true,true] ];
    return {
      hasSubHero: !!SUB, sub: SUB ? { eyebrow:SUB[0], t1:SUB[1], t2:SUB[2], p:SUB[3] } : {},
      isMembership: pg === 'membership', isWash: pg === 'wash', isTint: pg === 'tint', isDetailing: pg === 'detailing', isExperience: pg === 'experience', isVisit: pg === 'visit', isSub: pg !== 'home' && pg !== 'join',
      compRows: comp.map(([f, ...v]) => ({ f, cells: v.map((x, k) => ({ ...C(x), style:{ display:'flex', alignItems:'center', justifyContent:'center', textAlign:'center', padding:'10px 4px', background: k === 2 ? 'var(--cyanSoft)' : 'transparent', color: k === 2 ? 'var(--accentText)' : 'var(--ink2)' } })) })),
      memNotes:[ { t:'Mix and match', d:'4 washes a month, shared across the cars in your household. Use them however you like.' }, { t:'Billed monthly', d:'Your plan renews each month. Washes reset on your billing date.' }, { t:'Switch anytime', d:'Move between Gold and VIP from your account or by text.' } ],
      openBookGuest:() => this.setState(st => ({ sheet:'book', step:'svc', bk:{ ...st.bk, who:'guest', ack:false, lock:null } })),
      washCards:[ { tag:'MOST BOOKED', name:'Signature Hand Wash', g:'$' + this.g(45), steps:['Foam cannon pre-soak','Hand wash with high-gloss soap','Wheel & tire deep clean','Ceramic wax spray sealant','Streak-free hand dry','Interior vacuum, dash and glass'], book:() => this.openBook({ svc:'signature' }) },
        { tag:'EXTERIOR ONLY', name:'Exterior Hand Wash', g:'$' + this.g(32), steps:['Foam cannon pre-soak','Hand wash with high-gloss soap','Wheel & tire clean','Ceramic wax spray sealant','Streak-free hand dry'], book:() => this.openBook({ svc:'exterior' }) } ],
      tintColor: s.film === 'ceramic' ? 'rgba(4,10,16,' + tintAlpha + ')' : 'rgba(10,10,10,' + tintAlpha + ')', tintSplit: s.split + '%', tintTag: s.vlt + '% ' + s.film.toUpperCase(),
      tintDown:(e) => { this._td = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {} this.tintAt(e); }, tintMove:(e) => { if (this._td) this.tintAt(e); }, tintUp:() => { this._td = false; },
      vltOpts: VLT.map(([v, l]) => ({ label:v + '%', sub:l, onClick:() => this.setState({ vlt:v }), style:{ flex:1, minWidth:0, height:'58px', borderRadius:'14px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:'1px', background: s.vlt === v ? '#1FB6FF' : 'var(--inset)', color: s.vlt === v ? '#00131D' : 'var(--ink)', border:'1px solid ' + (s.vlt === v ? '#1FB6FF' : 'var(--line2)') } })),
      filmOpts: [['carbon','Carbon'],['ceramic','Ceramic']].map(([k, l]) => ({ label:l, onClick:() => this.setState({ film:k }), style:{ ...this.seg(s.film === k), height:'46px' } })),
      filmDesc: s.film === 'ceramic' ? 'Ceramic film blocks the most heat without looking darker, and won\u2019t interfere with phone or GPS signals.' : 'Carbon film gives a deep matte look and solid heat control at a lower price.',
      tintStats: [ { label:'Heat rejection', value:'up to ' + heat + '%', pct:heat + '%' }, { label:'Privacy', value:(100 - s.vlt) + '%', pct:(100 - s.vlt) + '%' }, { label:'UV blocked', value:'99%', pct:'99%' } ],
      vehOpts: this.VEH.map(([k, l]) => ({ label:l, onClick:() => this.setState({ tintVeh:k }), style:this.chip(s.tintVeh === k) })),
      tintPriceLabel:'VIP · ' + s.film.toUpperCase() + ' · ' + vehLabel.toUpperCase(), tintVip:this.$(rng[0]) + ' – ' + this.$(rng[1]), tintGuest:this.$(gr[0]) + ' – ' + this.$(gr[1]), tintSave:'save ' + this.$(gr[0] - rng[0]) + '+',
      tintSms:'sms:+12015986304?&body=' + encodeURIComponent('Tint quote: ' + s.vlt + '% ' + s.film + ', ' + vehLabel),
      ritual:[ { n:'01', t:'The walk-around', d:'Your detailer walks the car with you, panel by panel, before you take the keys.' }, { n:'02', t:'Daylight check', d:'Glass, jambs and wheels are checked outside in real light, where streaks can\u2019t hide.' }, { n:'03', t:'Keys on a fresh towel', d:'Mats back in, seat where you left it, and the cabin smells like nothing at all.' }, { n:'04', t:'The first mile', d:'Tires dressed, paint sealed. Then the first look at your reflection in a shop window.' } ],
      arrive:[ { n:'1', t:'Pull up to the bay doors', d:'Look for the Oasis sign on River Drive. Parking is on site.' }, { n:'2', t:'You\u2019re checked in', d:'With the Oasis app, we check you in automatically as you arrive. Or text HERE to 201-598-6304.' }, { n:'3', t:'Meet your detailer', d:'Confirm any add-ons and point out anything we should know about the car.' } ],
    };
  }
  joinVM(){
    const s = this.state, j = s.jn; if (s.page !== 'join') return { jv:{} };
    const T = {
      gold:{ name:'Gold', price:99, ink:'linear-gradient(180deg,#F6E2A4,#B8892A 55%,#F2D88C)', bg:'radial-gradient(90% 70% at 100% 0%,rgba(232,196,106,.32),transparent 60%),linear-gradient(135deg,#221D13,#07060A 60%,#17130C)', perks:['4 hand washes a month, interior included','Share across household cars','No booking fees','Member prices on everything else'] },
      vip:{ name:'VIP', price:169, ink:'linear-gradient(180deg,#FFFFFF,#9AA6B1 55%,#FFFFFF)', bg:'radial-gradient(90% 70% at 100% 0%,rgba(31,182,255,.4),transparent 60%),linear-gradient(135deg,#1A2129,#05070A 60%,#11161B)', perks:['Everything in Gold','Wax every wash + engine bay','Leather 2× and stain removal 1× a month','Priority booking and same-day guarantee'] },
    };
    const t = T[j.tier], st = j.step, first = (j.name.trim().split(/\s+/)[0]) || '';
    const TITLES = [
      ['STEP 1 OF 4 · PLAN','Choose','your plan.','Both include 4 hand washes a month with the interior done every time.'],
      ['STEP 2 OF 4 · VEHICLES','Your','cars.','Your 4 washes are shared across every car you add here.'],
      ['STEP 3 OF 4 · DETAILS','About','you.','We\u2019ll text confirmations and reminders to this number.'],
      ['STEP 4 OF 4 · PAYMENT','Start','today.','Billed monthly from today. Your first wash can be today.'],
      ['WELCOME','Welcome','to ' + t.name + '.', (first ? first + ', your' : 'Your') + ' 4 washes are ready. Book the first one now.'],
    ][st];
    const digits = (x) => x.replace(/\D/g, '');
    const validate = () => {
      if (st === 1 && !j.vehicles.some(v => v.car.trim())) return 'Add at least one vehicle.';
      if (st === 2 && (!j.name.trim() || digits(j.phone).length < 10)) return 'Add your name and a 10-digit mobile number.';
      if (st === 3 && (digits(j.card).length < 13 || digits(j.exp).length < 4 || digits(j.cvc).length < 3)) return 'Check your card details.';
      if (st === 3 && !j.agree) return 'Please accept the membership terms.';
      return '';
    };
    const next = () => { const e = validate(); if (e) { this.setJn({ err:e }); return; } this.setJn({ step:st + 1, err:'' }); if (st === 3) this.setState({ tier:j.tier }); window.scrollTo({ top:0, behavior:'smooth' }); };
    const setV = (i, k) => (e) => { const v = e.target.value; this.setState(ss => ({ jn:{ ...ss.jn, err:'', vehicles: ss.jn.vehicles.map((x, n) => n === i ? { ...x, [k]:v } : x) } })); };
    const nVeh = j.vehicles.filter(v => v.car.trim()).length || j.vehicles.length;
    return { jv:{
      eyebrow:TITLES[0], t1:TITLES[1], t2:TITLES[2], sub:TITLES[3], progress: ((st + 1) / 5 * 100) + '%',
      s0: st === 0, s1: st === 1, s2: st === 2, s3: st === 3, s4: st === 4, err:j.err,
      canBack: st > 0 && st < 4, back:() => this.setJn({ step:st - 1, err:'' }), close:() => this.go(s.prevPage || 'home'),
      tiers: Object.entries(T).map(([k, v]) => { const on = j.tier === k; return { name:v.name, price:'$' + v.price, perks:v.perks, badge: k === 'vip' ? 'PRIORITY' : '', onClick:() => this.setJn({ tier:k }),
        style:{ position:'relative', display:'block', width:'100%', padding:'20px', borderRadius:'22px', background: on ? 'var(--cyanSoft)' : 'var(--card)', border:'1.5px solid ' + (on ? '#1FB6FF' : 'var(--line)'), boxShadow: on ? '0 16px 40px rgba(31,182,255,.18)' : 'none', transition:'all .25s' },
        radio:{ flex:'none', width:'22px', height:'22px', borderRadius:'50%', border: on ? '7px solid #1FB6FF' : '2px solid var(--ink4)', background:'var(--bg)' } }; }),
      vehicles: j.vehicles.map((v, i) => ({ label:'VEHICLE ' + (i + 1), car:v.car, plate:v.plate, setCar:setV(i, 'car'), setPlate:setV(i, 'plate'), canRemove: j.vehicles.length > 1, remove:() => this.setJn({ vehicles:j.vehicles.filter((_, n) => n !== i) }) })),
      canAddVeh: j.vehicles.length < 5, addVeh:() => this.setJn({ vehicles:[...j.vehicles, { car:'', plate:'' }] }),
      name:j.name, phone:j.phone, email:j.email, card:j.card, exp:j.exp, cvc:j.cvc,
      setName:(e) => this.setJn({ name:e.target.value, err:'' }), setPhone:(e) => this.setJn({ phone:e.target.value, err:'' }), setEmail:(e) => this.setJn({ email:e.target.value }),
      setCard:(e) => this.setJn({ card:e.target.value.replace(/[^\d ]/g, '').slice(0, 23), err:'' }), setExp:(e) => this.setJn({ exp:e.target.value.slice(0, 7), err:'' }), setCvc:(e) => this.setJn({ cvc:e.target.value.replace(/\D/g, '').slice(0, 4), err:'' }),
      agree:j.agree, toggleAgree:() => this.setJn({ agree:!j.agree, err:'' }), agreeText:'I agree to be billed $' + t.price + ' a month for ' + t.name + ' until I cancel. Unused washes don\u2019t roll over.',
      agreeBox:{ flex:'none', width:'24px', height:'24px', borderRadius:'7px', display:'flex', alignItems:'center', justifyContent:'center', background: j.agree ? '#1FB6FF' : 'transparent', border: j.agree ? 'none' : '2px solid var(--ink4)', marginTop:'1px' },
      tierName:t.name, tierInk:t.ink, cardBg:t.bg, cardName:(j.name.trim() || 'YOUR NAME').toUpperCase(), cardAnim: st === 4 ? 'oaRise 1s cubic-bezier(.2,.8,.2,1)' : 'none', cardOrder: st === 4 ? '-1' : '0',
      cardMove:(e) => { const c = this.cardRef.current; if (!c) return; const r = c.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height; c.style.transform = 'rotateY(' + ((px - 0.5) * 16) + 'deg) rotateX(' + ((0.5 - py) * 12) + 'deg)'; const sh = this.shineRef.current; if (sh) sh.style.background = 'radial-gradient(60% 80% at ' + (px*100) + '% ' + (py*100) + '%,rgba(255,255,255,.3),transparent 60%)'; },
      cardLeave:() => { const c = this.cardRef.current; if (c) c.style.transform = ''; },
      showSummary: st < 4, lines:[ { label:t.name + ' membership', value:'$' + t.price + '/mo', col:'var(--ink)' }, { label:'Household vehicles', value:String(nVeh), col:'var(--ink)' }, { label:'Washes this month', value:'4', col:'var(--ink)' }, { label:'Booking fees', value:'$0', col:'var(--accentText)' } ], due:'$' + t.price,
      hasCta: st < 4, next, ctaLabel: st === 3 ? 'Start ' + t.name + ' · $' + t.price + '/mo' : 'Continue',
      bookFirst:() => { this.setState({ tier:j.tier }); this.go('home'); setTimeout(() => this.openBook({ who:'member', phone:j.phone }), 200); },
    } };
  }
  sheetVals(){
    const s = this.state, b = s.bk, days = this.days, st = s.step;
    const isG = b.who === 'guest', vip = s.tier === 'vip';
    const ctaStyle = (on) => ({ width:'100%', height:'58px', borderRadius:'17px', fontWeight:800, fontSize:'16.5px', background: on ? '#1FB6FF' : 'var(--inset)', color: on ? '#00131D' : 'var(--ink4)', boxShadow: on ? '0 10px 30px rgba(31,182,255,.3)' : 'none' });
    const base = { bWho:false, bSvc:false, bTime:false, bReview:false, bDone:false, hasCta:false, canBack:false, isGuest:isG };
    const wash = this.WASH.find(w => w.id === b.svc) || this.WASH[0]; const day = days[Math.min(b.day, days.length - 1)];
    const slotLabel = b.slot != null && day ? day.word + ' · ' + this.fmt(b.slot) : '';
    const vehL = this.VEH.find(v => v[0] === b.vehicle)[1];
    const addonPrice = (a) => isG ? this.g(a.m) : (vip && a.vip ? 0 : a.m);
    const washPrice = isG ? this.g(wash.m) : 0;
    let sh = base;
    if (s.sheet === 'book') {
      if (st === 'who') sh = { ...base, bWho:true, eyebrow:'BOOK A WASH', title:'How are you booking?', slotChosen: b.slot != null, slotLabel, phoneErr:b.phoneErr };
      else if (st === 'svc') sh = { ...base, bSvc:true, canBack:true, back:() => this.setState({ step:'who' }), eyebrow:(isG ? 'GUEST' : 'MEMBER') + ' BOOKING · STEP 1 OF 3', title:'Choose your wash', hasCta:true, ctaLabel: b.slot != null ? 'Review booking' : 'Choose a time', ctaStyle:ctaStyle(true), cta:() => this.setState({ step: b.slot != null ? 'review' : 'time' }),
        vehicles: this.VEH.map(([k, l]) => ({ label:l, onClick:() => this.setBk({ vehicle:k }), style:this.chip(b.vehicle === k) })),
        washes: this.WASH.map(w => { const on = b.svc === w.id; return { name:w.name, sub:w.sub, price: isG ? '$' + this.g(w.m) : '$0', note: isG ? 'guest price' : '1 of 4 this month', onClick:() => this.setBk({ svc:w.id }),
          style:{ display:'flex', alignItems:'center', gap:'14px', width:'100%', padding:'16px', borderRadius:'18px', background: on ? 'var(--cyanSoft)' : 'var(--inset)', border:'1.5px solid ' + (on ? '#1FB6FF' : 'var(--line2)') },
          radio:{ flex:'none', width:'22px', height:'22px', borderRadius:'50%', border: on ? '7px solid #1FB6FF' : '2px solid var(--ink4)', background:'var(--bg2)' } }; }),
        addons: this.DURING.map(a => { const on = b.addons.includes(a.id); const pr = addonPrice(a); return { name:a.name, price: pr === 0 ? 'Included' : '+$' + pr, priceCol: pr === 0 ? 'var(--accentText)' : 'var(--ink3)', onClick:() => this.setBk({ addons: on ? b.addons.filter(x => x !== a.id) : [...b.addons, a.id] }),
          style:{ textAlign:'left', padding:'13px 14px', minHeight:'64px', borderRadius:'15px', background: on ? 'var(--cyanSoft)' : 'var(--inset)', border:'1px solid ' + (on ? '#1FB6FF' : 'var(--line2)') } }; }) };
      else if (st === 'time') sh = { ...base, bTime:true, canBack:true, back:() => this.setState({ step:'svc' }), eyebrow:(isG ? 'GUEST' : 'MEMBER') + ' BOOKING · STEP 2 OF 3', title:'Pick a time', lockNote:b.lock, hasCta:true, ctaLabel: b.slot != null ? 'Review · ' + this.fmt(b.slot) : 'Select a time', ctaStyle:ctaStyle(b.slot != null), cta:() => { if (b.slot != null) this.setState({ step:'review' }); },
        dayChips: days.map((d, i) => ({ top: i === 0 ? 'TODAY' : this.DOW[d.d.getDay()], num:String(d.d.getDate()), onClick:() => this.setBk({ day:i, slot:null, lock:null }), style:{ flex:'none', width:'66px', height:'70px', borderRadius:'16px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background: i === b.day ? '#1FB6FF' : 'var(--inset)', color: i === b.day ? '#00131D' : 'var(--ink)', border:'1px solid ' + (i === b.day ? '#1FB6FF' : 'var(--line2)') } })),
        slots: (day ? day.slots : []).map(sl => { const locked = sl.st === 'members' && isG, off = sl.st === 'booked', on = b.slot === sl.m;
          const tag = off ? 'BOOKED' : (sl.st === 'members' ? (isG ? 'VIP ONLY' : 'VIP') : (sl.st === 'last' ? 'LAST BAY' : 'OPEN'));
          return { label:this.fmt(sl.m), tag, tagCol: on ? '#00131D' : (off ? 'var(--bad)' : (sl.st === 'members' ? 'var(--ink)' : (sl.st === 'last' ? 'var(--amber)' : 'var(--ok)'))),
            onClick:() => { if (off) return; if (locked) { this.setBk({ lock:this.fmt(sl.m) + ' is held for VIP members. Join to book it with no fee.' }); return; } this.setBk({ slot:sl.m, lock:null }); },
            style:{ height:'62px', borderRadius:'14px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background: on ? '#1FB6FF' : 'var(--inset)', color: on ? '#00131D' : (off ? 'var(--ink4)' : 'var(--ink)'), border:'1px ' + (locked ? 'dashed' : 'solid') + ' ' + (on ? '#1FB6FF' : 'var(--line)'), opacity: off ? 0.55 : 1, cursor: off ? 'default' : 'pointer' } }; }) };
      else if (st === 'review') {
        const ads = this.DURING.filter(a => b.addons.includes(a.id));
        const lines = [ { label:wash.name, value: isG ? '$' + washPrice : 'Included', lc:'var(--ink)', vc: isG ? 'var(--ink)' : 'var(--accentText)' }, ...ads.map(a => { const pr = addonPrice(a); return { label:a.name, value: pr === 0 ? 'Included' : '$' + pr, lc:'var(--ink2)', vc: pr === 0 ? 'var(--accentText)' : 'var(--ink)' }; }) ];
        if (isG) lines.push({ label:'Booking fee · non-refundable', value:'$25', lc:'var(--amber)', vc:'var(--amber)' });
        const atShop = washPrice + ads.reduce((x, a) => x + addonPrice(a), 0);
        const vipCost = ads.reduce((x, a) => x + (a.vip ? 0 : a.m), 0);
        const ok = !isG || b.ack;
        sh = { ...base, bReview:true, canBack:true, back:() => this.setState({ step:'time' }), eyebrow:(isG ? 'GUEST' : 'MEMBER') + ' BOOKING · STEP 3 OF 3', title:'Review & confirm', when:slotLabel, vehLabel:vehL, lines,
          dueLabel: isG ? 'Due now' : 'Due at pickup', due: isG ? '$25' : this.$(atShop), dueSub: isG ? 'Booking fee. Pay ' + this.$(atShop) + ' after your wash.' : 'Uses 1 of your 4 washes this month.',
          ack:b.ack, toggleAck:() => this.setBk({ ack:!b.ack }), ackBox:{ flex:'none', width:'24px', height:'24px', borderRadius:'7px', display:'flex', alignItems:'center', justifyContent:'center', background: b.ack ? '#1FB6FF' : 'transparent', border: b.ack ? 'none' : '2px solid var(--ink4)', marginTop:'1px' },
          upsell:'You\u2019d pay ' + this.$(atShop + 25) + ' as a guest. As VIP: ' + this.$(vipCost) + ', with wax and engine bay included.',
          hasCta:true, ctaLabel: isG ? 'Pay $25 & book' : 'Confirm booking', ctaStyle:ctaStyle(ok), cta:() => { if (!ok) { this.flash('Please confirm the booking fee terms'); return; } this.setState({ step:'done' }); } };
      }
      else if (st === 'done') sh = { ...base, bDone:true, eyebrow:'CONFIRMED', title:'See you soon', when:slotLabel, doneSub: wash.name + ' · ' + vehL + ' · 468 River Drive, Garfield', hasCta:true, ctaLabel:'Done', ctaStyle:ctaStyle(true), cta:() => this.setState({ sheet:null, bk:{ ...b, slot:null, addons:[], ack:false } }) };
    }
    if (s.sheet === 'book') {
      const ads = this.DURING.filter(a => b.addons.includes(a.id));
      const who = b.who === 'guest' ? 'GUEST' : (b.who === 'member' ? (vip ? 'VIP' : 'MEMBER') : '—');
      const sumLines = [ { label:'Vehicle', value:vehL, col:'#F2F5F7' }, { label:wash.name, value: b.who === 'guest' ? '$' + washPrice : (b.who === 'member' ? 'Included' : '—'), col: b.who === 'member' ? '#7FD6FF' : '#F2F5F7' },
        ...ads.map(a => { const pr = addonPrice(a); return { label:a.name, value: pr === 0 ? 'Included' : '$' + pr, col: pr === 0 ? '#7FD6FF' : '#F2F5F7' }; }),
        ...(b.who === 'guest' ? [{ label:'Booking fee', value:'$25', col:'#FFB547' }] : []) ];
      sh = { ...sh, progress:({ who:'20%', svc:'45%', time:'70%', review:'90%', done:'100%' })[st] || '20%', sumWho:who, sumWhen: slotLabel || 'Pick a time', sumLines };
    }
    return {
      sheetOpen: !!s.sheet, sh, closeSheet:() => this.setState({ sheet:null }),
      bkPhone:b.phone, setBkPhone:(e) => this.setBk({ phone:e.target.value, phoneErr:false }),
      memberContinue:() => { if (b.phone.replace(/\D/g,'').length < 10) { this.setBk({ phoneErr:true }); return; } this.setState(ss => ({ tier: ss.tier || 'gold', step: ss.bk.slot != null ? 'review' : 'svc', bk:{ ...ss.bk, who:'member' } })); },
      guestContinue:() => this.setState(ss => { const d = days[ss.bk.day]; const sl = d && ss.bk.slot != null ? d.slots.find(x => x.m === ss.bk.slot) : null; const keep = sl && sl.st !== 'members'; return { step:'svc', bk:{ ...ss.bk, who:'guest', slot: keep ? ss.bk.slot : null, lock: sl && !keep ? 'That time is held for VIP members. Pick another, or join to keep it.' : null } }; }),
    };
  }

  renderVals(){
    const s = this.state, th = this.theme(), pg = s.page;
    const links = [['01','Home','#/'],['02','Membership','#/membership'],['03','Wash & add-ons','#/wash'],['04','Window tint','#/tint'],['05','Detailing & more','#/detailing'],['06','The experience','#/experience'],['07','Visit','#/visit']];
    const tb = (on) => ({ height:'36px', padding:'0 14px', borderRadius:'9px', fontWeight:700, fontSize:'13px', background: on ? 'var(--panel)' : 'transparent', color: on ? 'var(--ink)' : 'var(--ink3)', boxShadow: on ? '0 1px 4px rgba(0,0,0,.15)' : 'none' });
    return {
      theme:th, isHome: pg === 'home', notJoin: pg !== 'join', isJoin: pg === 'join',
      heroRef:this.heroRef, beadRef:this.beadRef, washRef:this.washRef, washCv:this.washCv, smsRef:this.smsRef, tintRef:this.tintRef, priceRef:this.priceRef, revealRef:this.revealRef, revealMask:this.revealMask, revealBar:this.revealBar, cardRef:this.cardRef, shineRef:this.shineRef,
      menuOpen:s.menu, openMenu:() => this.setState({ menu:true }), closeMenu:() => this.setState({ menu:false }),
      menuLinks: links.map(([n, label, href]) => ({ n, label, href })),
      toggleTheme:() => this.setState({ themeOverride: th === 'dark' ? 'light' : 'dark' }),
      setDark:() => this.setState({ themeOverride:'dark' }), setLight:() => this.setState({ themeOverride:'light' }), darkBtn:tb(th === 'dark'), lightBtn:tb(th === 'light'),
      goJoinGold:() => this.joinTo('gold'), goJoinVip:() => this.joinTo('vip'), openBookAny:() => this.openBook(),
      hoursList:[ { d:'Monday – Friday', t:'8 AM – 6 PM' }, { d:'Saturday', t:'8 AM – 5 PM' }, { d:'Sunday', t:'9 AM – 3 PM' } ],
      stickyOn: this.props.stickyBar !== false && pg !== 'join', barY: s.showBar && !s.sheet ? '0' : '160%', barOpacity: s.showBar && !s.sheet ? '1' : '0',
      toast:s.toast, stop:(e) => e.stopPropagation(),
      ...this.homeVM(), ...this.priceVM(), ...this.pagesVM(), ...this.joinVM(), ...this.sheetVals(),
    };
  }
}
