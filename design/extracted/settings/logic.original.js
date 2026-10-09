
class Component extends DCLogic {
  DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  ORDER = [1,2,3,4,5,6,0];
  LIMITS = [25,50,100,250,500,1000,null];
  SKILLS = ['Interior detailing','Paint correction','Ceramic coating','Exotic vehicles','Front desk','Mobile service'];
  PERMS = [
    { mod:'Schedule & jobs', items:[['sched.view','View schedule & calendar'],['sched.edit','Create & edit appointments'],['sched.cancel','Cancel & mark no-shows'],['sched.override','Override bay capacity'],['jobs.status','Move jobs between stages'],['jobs.checklist','Complete checklists & photos']] },
    { mod:'Clients', items:[['cli.view','View client files'],['cli.contact','See phone & email'],['cli.edit','Edit client & vehicle details'],['cli.export','Export client data'],['cli.member','Manage memberships & VIP']] },
    { mod:'Payments', items:[['pay.collect','Collect payments'],['pay.refund','Issue refunds',1],['pay.adjust','Apply adjustments & discounts',1],['pay.credit','Issue account credits',1],['pay.void','Void transactions'],['pay.reports','View payment reports']] },
    { mod:'Messaging', items:[['msg.send','Message customers'],['msg.auto','Edit automations & templates'],['msg.broadcast','Send offers & broadcasts']] },
    { mod:'Team', items:[['team.view','View team'],['team.edit','Add & edit employees'],['team.roles','Assign roles & permissions']] },
    { mod:'Settings', items:[['set.hours','Working hours & holidays'],['set.emergency','Emergency closing'],['set.services','Services, pricing & checklists'],['set.billing','Billing & integrations']] },
  ];
  REMAINING = [['10:15 AM','Marcus Webb','Jeep Wrangler'],['10:45 AM','Liam Chen','BMW M340i'],['11:00 AM','Grace Adeyemi','Lexus RX 350'],['12:00 PM','Aisha Rahman','Range Rover Sport'],['1:30 PM','Tom Bradley','Honda Civic'],['3:00 PM','Elena Volkov','Lamborghini Urus']];

  state = (() => {
    const ls = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
    const W = (f,t) => ({ open:true, from:f, to:t });
    const hours = ls('oasis-hours') || [W('9:00 AM','3:00 PM'),W('8:00 AM','6:00 PM'),W('8:00 AM','6:00 PM'),W('8:00 AM','6:00 PM'),W('8:00 AM','6:00 PM'),W('8:00 AM','6:00 PM'),W('8:00 AM','5:00 PM')];
    const all = this.PERMS.flatMap(g => g.items.map(i => i[0]));
    const set = (list) => Object.fromEntries(all.map(p => [p, list.includes(p)]));
    const rc = ls('oasis-roles') || {
      roles:[
        { id:'super', name:'Super Admin', desc:'Owner level. Everything, including billing.', locked:true },
        { id:'mgmt', name:'Management', desc:'Runs the shop day to day.' },
        { id:'acct', name:'Accounting', desc:'Payments, refunds, credits and reports.' },
        { id:'support', name:'Customer Support', desc:'Front desk, bookings and messaging.' },
        { id:'crew', name:'Crew', desc:'Bay work: jobs, checklists, photos.' },
      ],
      perms:{
        super:set(all), mgmt:set(all.filter(p => p !== 'set.billing')),
        acct:set(['sched.view','cli.view','cli.contact','cli.export','cli.member','pay.collect','pay.refund','pay.adjust','pay.credit','pay.void','pay.reports','team.view','set.billing']),
        support:set(['sched.view','sched.edit','sched.cancel','cli.view','cli.contact','cli.edit','cli.member','pay.collect','pay.refund','pay.adjust','pay.credit','msg.send','team.view']),
        crew:set(['sched.view','jobs.status','jobs.checklist','cli.view']),
      },
      limits:{ super:{refund:null,adjust:null,credit:null}, mgmt:{refund:1000,adjust:500,credit:500}, acct:{refund:500,adjust:250,credit:250}, support:{refund:50,adjust:25,credit:50}, crew:{refund:25,adjust:25,credit:25} },
    };
    const sch = (days) => [0,1,2,3,4,5,6].map(d => ({ on:days.includes(d), from:d===0?'9:00 AM':'8:00 AM', to:d===0?'3:00 PM':(d===6?'5:00 PM':'6:00 PM') }));
    const E = (id,first,last,title,phone,roles,o) => ({ id, first, last, title, phone, email:first.toLowerCase()+'@oasisautospa.com', roles, status:'active', type:'Full-time', payType:'Hourly', rate:'', skills:[], sched:sch([1,2,3,4,5,6]), overrides:{}, ...o });
    const employees = [
      E('e1','Amara','Okoye','Owner','(305) 555-0101',['super'],{ payType:'Salary', skills:['Exotic vehicles'] }),
      E('e2','Rafael','Mendes','General Manager','(305) 555-0140',['mgmt','acct'],{ payType:'Salary' }),
      E('e3','Marco','Ruiz','Lead Detailer','(786) 555-0172',['crew'],{ payType:'Commission', rate:'30', skills:['Paint correction','Ceramic coating','Exotic vehicles'] }),
      E('e4','Lena','Kim','Detailer','(305) 555-0119',['crew'],{ rate:'22', skills:['Interior detailing'], sched:sch([0,2,3,4,5,6]) }),
      E('e5','Sofia','Duarte','Front Desk','(786) 555-0133',['support','crew'],{ rate:'21', skills:['Front desk'], overrides:{ 'sched.override':'allow' } }),
      E('e6','Daniel','Price','Bookkeeper','(305) 555-0188',['acct'],{ type:'Part-time', rate:'34', sched:sch([1,3,5]) }),
      E('e7','Kevin','Tran','Detailer','(786) 555-0151',['crew'],{ status:'invited', rate:'19', sched:sch([1,2,3,4,5]) }),
    ];
    const closures = (ls('oasis-closures') || [
      { date:'2026-05-25', name:'Memorial Day', type:'closed' },
      { date:'2026-06-03', name:'Weather closure', type:'closed', emergency:true },
      { date:'2026-07-04', name:'Independence Day', type:'closed' },
      { date:'2026-09-07', name:'Labor Day', type:'reduced', from:'10:00 AM', to:'2:00 PM' },
      { date:'2026-11-26', name:'Thanksgiving', type:'closed' },
      { date:'2026-12-24', name:'Christmas Eve', type:'reduced', from:'8:00 AM', to:'1:00 PM' },
      { date:'2026-12-25', name:'Christmas Day', type:'closed' },
    ]).map((c,i) => ({ notify:true, from:'10:00 AM', to:'2:00 PM', ...c, id:'c'+i }));
    const SV = {
      'Express Hand Wash':[45,35,['Exterior rinse','Hand wash','Wheel cleaning','Hand dry & towel','Glass & windows']],
      'Premium Hand Wash + Interior':[129,75,['Exterior pre-rinse','Two-bucket hand wash','Wheel & tire cleaning','Tire shine','Interior vacuum','Dashboard & console wipe','Streak-free windows']],
      'Premium Hand Wash + Interior Refresh':[139,75,['Exterior pre-rinse','Two-bucket hand wash','Wheel & tire cleaning','Tire shine','Interior vacuum','Dashboard & vents wipe','Leather seat refresh','Streak-free windows']],
      'Executive Detail':[260,90,['Foam pre-soak','Two-bucket hand wash','Clay bar treatment','Wheel & caliper detail','Tire dressing','Full interior vacuum','Leather conditioning','Dashboard & vents detail','Streak-free glass','Spray sealant']],
      'Executive Detail + Ceramic':[420,120,['Foam pre-soak','Two-bucket hand wash','Iron decontamination','Clay bar treatment','Ceramic spray coat','Wheel & caliper detail','Full interior detail','Leather conditioning','Streak-free glass']],
      'Full Detail':[320,120,['Engine bay degrease','Foam pre-soak','Hand wash','Clay bar','Wheel deep clean','Carpet shampoo','Full interior vacuum','Leather treatment','Glass polish','Wax & seal']],
      'Ceramic Maintenance + Wax':[180,60,['Pre-rinse','pH-neutral hand wash','Ceramic boost spray','Hand-applied wax','Wheel cleaning','Tire dressing','Glass treatment']],
      'Exotic Detail Package':[650,150,['Waterless decon','Two-bucket hand wash','Paint correction pass','Ceramic seal','Wheel & caliper detail','Full interior detail','Leather conditioning','Glass & trim restore','Photographic handover']],
      'Family Wash + Pet Hair':[95,50,['Exterior rinse','Hand wash','Pet hair removal','Interior vacuum','Dashboard wipe','Windows','Odor neutralize']],
    };
    const AD = {
      'Interior deep clean':[60,['Deep vacuum seats & carpets','Steam clean vents & cupholders','Wipe door jambs & panels']],
      'Pet hair removal':[35,['Rubber-brush pet hair','Lint-roll upholstery','Vacuum seat seams']],
      'Leather conditioning':[45,['Clean leather surfaces','Apply conditioner','Buff to matte finish']],
      'Wax':[40,['Apply carnauba wax','Buff off haze']],
      'Clay bar':[50,['Lubricate panels','Clay bar paint','Wipe residue']],
      'Odor removal':[30,['Enzyme treatment on fabrics','Odor neutralizer cycle']],
      'Engine bay cleaning':[55,['Cover electricals','Degrease engine bay','Dress plastics']],
      'Ceramic maintenance':[120,['Ceramic boost spray','Buff & level coating']],
      'Rain repellent':[25,['Clean glass','Apply rain repellent to windshield']],
      'Wheel deep clean':[40,['Remove wheel fallout','Clean barrels & calipers','Seal wheel faces']],
    };
    const ov = ls('oasis-checklists') || {};
    const packages = Object.fromEntries(Object.entries(SV).map(([k,v]) => [k, { price:v[0], dur:v[1], tasks:(ov.packages&&ov.packages[k])||v[2] }]));
    const addons = Object.fromEntries(Object.entries(AD).map(([k,v]) => [k, { price:v[0], tasks:(ov.addons&&ov.addons[k])||v[1] }]));
    const em = ls('oasis-emergency');
    return {
      theme:(()=>{ try { return localStorage.getItem('oasis-theme') || 'light'; } catch(e) { return 'light'; } })(),
      section:'hours', hours, savedHours:JSON.stringify(hours), rules:{ slot:30, buffer:10, cutoff:60 },
      closures, adding:false, nc:{ date:'', name:'', type:'closed', from:'10:00 AM', to:'2:00 PM' }, ncError:'', federal:true,
      em:{ active:!!(em&&em.active), summary:em&&em.summary||'', reason:'Severe weather', dur:'today', until:'2:00 PM', through:'2026-06-15', notify:true, link:true, credits:true, pause:true, crew:true,
        msg:'Hi {first}, due to {reason} Oasis Auto Spa is closed {until}. We\u2019re sorry for the inconvenience. Pick a new time here: {link}' },
      emHistory:[{ date:'Jun 3, 2026', reason:'Severe weather', detail:'Full day · 7 customers notified · 6 rebooked' },{ date:'Feb 18, 2026', reason:'Power outage', detail:'11:20 AM – 3:00 PM · 4 notified' }],
      confirm:false,
      employees, empQuery:'', roleFilter:'all', drawer:null, draft:null, drTab:'profile', drError:'',
      vip:(ls('oasis-vip')||{}).vip||{ holds:[{d:6,t:'8:00 AM'},{d:6,t:'9:00 AM'},{d:6,t:'10:00 AM'},{d:5,t:'4:00 PM'},{d:0,t:'9:00 AM'}], release:48, windowVip:30, windowStd:14, sameDay:2, waitlist:true, offerMin:15, standing:true, autoConfirm:true, cadences:['Weekly','Every 2 weeks','Monthly'], clients:['Jonathan Franco','Liam Chen','Aisha Rahman','Elena Volkov'] },
      arrival:(ls('oasis-vip')||{}).arrival||{ on:true, radius:300, prepAt:15, autoArrive:true, welcome:true, crew:true, vipFirst:true },
      holdDay:6, holdTime:'11:00 AM', vipNew:'',
      rc, svcKind:'pkg', svcSel:'Premium Hand Wash + Interior', packages, addons, newTask:'', toast:null,
    };
  })();

  componentDidMount(){ if (location.hash === '#emergency') this.setState({ section:'emergency' }); }

  save(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} }
  flash(t){ this.setState({ toast:t }); clearTimeout(this._tt); this._tt = setTimeout(() => this.setState({ toast:null }), 2800); }
  parseT(s){ const m=s.match(/(\d+):(\d+)\s*(AM|PM)/i); let h=+m[1]%12; if(/pm/i.test(m[3])) h+=12; return h*60 + +m[2]; }
  fmtT(n){ let h=Math.floor(n/60), m=n%60; const ap=h>=12?'PM':'AM'; h=h%12; if(h===0) h=12; return h+':'+String(m).padStart(2,'0')+' '+ap; }
  step(t,d){ return this.fmtT(Math.max(300, Math.min(1410, this.parseT(t)+d*30))); }
  sw(on){ return { track:{ flex:'none',width:'50px',height:'30px',borderRadius:'16px',position:'relative',background:on?'var(--accent)':'var(--line)',transition:'background .15s' }, knob:{ position:'absolute',top:'3px',left:on?'23px':'3px',width:'24px',height:'24px',borderRadius:'50%',background:'#fff',boxShadow:'0 1px 3px rgba(0,0,0,.25)',transition:'left .15s' } }; }
  seg(on){ return { flex:1,height:'38px',padding:'0 12px',borderRadius:'9px',fontSize:'13px',fontWeight:700,whiteSpace:'nowrap', background:on?'var(--accent)':'transparent', color:on?'#fff':'var(--ink2)' }; }
  chip(on){ return { height:'40px',padding:'0 14px',borderRadius:'11px',fontSize:'13px',fontWeight:700, background:on?'var(--accentSoft)':'var(--panel)', color:on?'var(--accentInk)':'var(--ink2)', border:'1px solid '+(on?'var(--accentBrd)':'var(--line)') }; }
  limKey(p){ return p.split('.')[1]; }
  limLabel(v){ return v===null?'No limit':'≤ $'+v.toLocaleString('en-US'); }
  roleName(id){ const r=this.state.rc.roles.find(x=>x.id===id); return r?r.name:id; }
  setRC(fn){ this.setState(s => { const rc=fn(JSON.parse(JSON.stringify(s.rc))); this.save('oasis-roles', rc); return { rc }; }); }
  setHours(fn){ this.setState(s => ({ hours:fn(s.hours.map(h=>({...h}))) })); }
  persistChecklists(p,a){ this.save('oasis-checklists', { packages:Object.fromEntries(Object.entries(p).map(([k,v])=>[k,v.tasks])), addons:Object.fromEntries(Object.entries(a).map(([k,v])=>[k,v.tasks])) }); }
  persistClosures(list){ this.save('oasis-closures', list.map(({id,...c})=>c)); }
  eff(e,pid){
    const rc=this.state.rc, ov=e.overrides[pid];
    const from=e.roles.filter(r=>rc.perms[r]&&rc.perms[r][pid]);
    const item=this.PERMS.flatMap(g=>g.items).find(i=>i[0]===pid); const lk=item&&item[2]?this.limKey(pid):null;
    const lims=lk?from.map(r=>(rc.limits[r]||{})[lk]):[]; const lim=lims.length?(lims.includes(null)?null:Math.max(...lims)):(lk?25:undefined);
    const tail=lk?' · '+this.limLabel(lim):'';
    if(ov==='deny') return { on:false, ov, src:'Exception · denied' };
    if(ov==='allow') return { on:true, ov, src:'Exception · allowed'+tail };
    if(from.length) return { on:true, src:'via '+from.map(r=>this.roleName(r)).join(' + ')+tail };
    return { on:false, src:'Not included in assigned roles' };
  }
  openEmp(e){ this.setState({ drawer:e?e.id:'new', drTab:'profile', drError:'', draft:e?JSON.parse(JSON.stringify(e)):{ id:null, first:'', last:'', title:'', phone:'', email:'', roles:['crew'], status:'invited', type:'Full-time', payType:'Hourly', rate:'', skills:[], sched:[0,1,2,3,4,5,6].map(d=>({ on:d>0&&d<6, from:'8:00 AM', to:'6:00 PM' })), overrides:{} } }); }
  setDraft(fn){ this.setState(s => ({ draft:fn({ ...s.draft }), drError:'' })); }

  setVip(p,key){ this.setState(s=>{ const k=key||'vip'; const nv={ ...s[k], ...p }; const out={ vip:k==='vip'?nv:s.vip, arrival:k==='arrival'?nv:s.arrival }; this.save('oasis-vip',out); return { [k]:nv }; }); }
  vipVM(){
    const s=this.state, v=s.vip, ar=s.arrival, D=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const tog=(obj,k,label,sub,key)=>{ const w=this.sw(obj[k]); return { label, sub, track:w.track, knob:w.knob, toggle:()=>this.setVip({ [k]:!obj[k] },key) }; };
    const stp=(label,sub,k,min,max,unit,stepN)=>({ label, sub, val:v[k]+unit, dec:()=>this.setVip({ [k]:Math.max(min,v[k]-(stepN||1)) }), inc:()=>this.setVip({ [k]:Math.min(max,v[k]+(stepN||1)) }) });
    const holds=[...v.holds].sort((a,b)=>((a.d+6)%7)-((b.d+6)%7)||this.parseT(a.t)-this.parseT(b.t));
    return {
      vipHolds:holds.map(h=>({ label:this.DAYS[h.d]+' · '+h.t, remove:()=>this.setVip({ holds:v.holds.filter(x=>!(x.d===h.d&&x.t===h.t)) }) })),
      holdDay:this.DAYS[s.holdDay], holdTime:s.holdTime,
      holdDayDec:()=>this.setState({ holdDay:(s.holdDay+6)%7 }), holdDayInc:()=>this.setState({ holdDay:(s.holdDay+1)%7 }),
      holdTimeDec:()=>this.setState({ holdTime:this.step(s.holdTime,-1) }), holdTimeInc:()=>this.setState({ holdTime:this.step(s.holdTime,1) }),
      addHold:()=>{ if(v.holds.some(x=>x.d===s.holdDay&&x.t===s.holdTime)){ this.flash('That slot is already held'); return; } this.setVip({ holds:[...v.holds,{ d:s.holdDay, t:s.holdTime }] }); this.flash(D[s.holdDay]+' '+s.holdTime+' held for VIPs'); },
      releaseOpts:[24,48,72].map(h=>({ label:h+'h before', onClick:()=>this.setVip({ release:h }), style:this.seg(v.release===h) })),
      vipSteppers:[ stp('VIP booking window','How far ahead VIPs can book','windowVip',7,90,' days',7), stp('Standard booking window','Everyone else','windowStd',7,60,' days',7), stp('Same-day guarantee','Per VIP, per month — we fit them in even when full','sameDay',0,8,' / mo') ],
      vipToggles:[ tog(v,'waitlist','Waitlist priority','Cancellations are offered to VIPs first'), tog(v,'standing','Standing appointments','VIPs can set a repeating slot'), tog(v,'autoConfirm','Auto-confirm standing visits','Confirmed 48h before without a reply') ],
      offerOpts:[10,15,30].map(m=>({ label:m+' min', onClick:()=>this.setVip({ offerMin:m }), style:this.seg(v.offerMin===m) })),
      cadenceOpts:['Weekly','Every 2 weeks','Every 3 weeks','Monthly'].map(c=>{ const on=v.cadences.includes(c); return { label:c, onClick:()=>this.setVip({ cadences:on?v.cadences.filter(x=>x!==c):[...v.cadences,c] }), style:this.chip(on) }; }),
      vipClients:v.clients.map(n=>({ name:n, remove:()=>this.setVip({ clients:v.clients.filter(x=>x!==n) }) })), vipCount:v.clients.length+' clients',
      vipNew:s.vipNew, vipNewSet:(e)=>this.setState({ vipNew:e.target.value }),
      addVip:()=>{ const n=s.vipNew.trim(); if(!n) return; this.setVip({ clients:[...v.clients,n] }); this.setState({ vipNew:'' }); this.flash(n+' is now VIP'); },
      arrToggles:[ tog(ar,'on','Geofence auto check-in','Turn off to require check-in at the desk','arrival'), tog(ar,'autoArrive','Mark as Arrived automatically','Job moves to Arrived on the Operations screen','arrival'), tog(ar,'welcome','Send welcome message','“You’re checked in — pull into Bay 2”','arrival'), tog(ar,'crew','Alert the crew','Push notification to whoever is on shift','arrival'), tog(ar,'vipFirst','VIP arrivals first','VIP arrivals sit at the top of alerts','arrival') ],
      radiusOpts:[150,300,500].map(m=>({ label:m+' m', onClick:()=>this.setVip({ radius:m },'arrival'), style:this.seg(ar.radius===m) })),
      prepOpts:[10,15,20].map(m=>({ label:m+' min away', onClick:()=>this.setVip({ prepAt:m },'arrival'), style:this.seg(ar.prepAt===m) })),
      arrSteps:[ { n:'1', title:ar.prepAt+' min out', desc:'Operations gets an “Arriving” alert with a Prep bay button. VIPs show in purple at the top.' }, { n:'2', title:'Within '+ar.radius+' m', desc:(ar.autoArrive?'Checked in automatically and the job moves to Arrived. ':'Staff confirm the check-in. ')+(ar.welcome?'Customer gets a welcome message.':'') }, { n:'3', title:'Ready to start', desc:'Crew sees “Auto checked in” with a Start cleaning button.' } ],
    };
  }

  renderVals(){
    const s=this.state, dark=s.theme==='dark', sec=s.section;
    const navS=(k)=>({ display:'flex',alignItems:'center',gap:'11px',width:'100%',minHeight:'44px',padding:'0 12px',borderRadius:'12px',fontSize:'14px',fontWeight:700, background:sec===k?'var(--accentSoft)':'transparent', color:sec===k?'var(--accentInk)':'var(--ink2)' });
    const go=(k)=>()=>this.setState({ section:k });
    const META={ vip:['VIP program','Booking priority for VIP clients. Built around saving them time.'], arrival:['Arrival & check-in','Geofence check-in and bay prep for every client.'], hours:['Working hours','Weekly opening hours and booking rules.'], closures:['Holidays & closures','Planned closed days and reduced hours. Booked customers are notified automatically.'], emergency:['Emergency closing','Close immediately, notify affected customers and pause booking.'], employees:['Employees','Create team members, assign roles and set schedules.'], roles:['Roles & permissions','What each role can see and do, including money limits.'], services:['Packages & checklists','Checklist tasks for each package and add-on. Jobs combine both automatically.'] };
    const mon=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'], dow=['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const TODAY='2026-06-13';

    // hours
    let total=0;
    const hourRows=this.ORDER.map(d=>{ const h=s.hours[d]; const len=h.open?Math.max(0,this.parseT(h.to)-this.parseT(h.from)):0; total+=len; const w=this.sw(h.open);
      const upd=(k,dir)=>()=>this.setHours(H=>{ H[d][k]=this.step(H[d][k],dir); return H; });
      return { day:this.DAYS[d], open:h.open, closed:!h.open, from:h.from, to:h.to, len:(len/60)+' hrs', track:w.track, knob:w.knob,
        toggle:()=>this.setHours(H=>{ H[d].open=!H[d].open; return H; }), fromDec:upd('from',-1), fromInc:upd('from',1), toDec:upd('to',-1), toInc:upd('to',1) }; });
    const rule=(label,key,opts,unit)=>({ label, opts:opts.map(v=>({ label:v+' '+unit, onClick:()=>this.setState(st=>({ rules:{ ...st.rules, [key]:v } })), style:this.seg(s.rules[key]===v) })) });
    const ruleRows=[ rule('Slot length','slot',[15,30,60],'min'), rule('Buffer between jobs','buffer',[0,10,15,20],'min'), rule('Last booking before close','cutoff',[30,60,90],'min') ];

    // closures
    const fmtC=(c)=>{ const d=new Date(c.date+'T12:00:00'); const pastC=c.date<TODAY; const w=this.sw(c.notify); const hash=+c.date.slice(-2);
      return { mon:mon[d.getMonth()], day:String(d.getDate()), dow:dow[d.getDay()], name:c.name, typeLabel:c.emergency?'Emergency':(c.type==='closed'?'Closed all day':'Reduced · '+c.from+' – '+c.to),
        tagStyle:{ fontSize:'11px',fontWeight:800,padding:'3px 8px',borderRadius:'7px', background:c.emergency?'rgba(194,65,12,.14)':(c.type==='closed'?'var(--panel3)':'var(--accentSoft)'), color:c.emergency?'#C2410C':(c.type==='closed'?'var(--ink2)':'var(--accentInk)') },
        sub:c.type==='closed'?'Online booking blocked · '+(hash%4)+' existing bookings to move':'Slots outside reduced hours hidden · '+(hash%3)+' bookings affected',
        track:w.track, knob:w.knob, past:pastC,
        toggleNotify:()=>this.setState(st=>{ const L=st.closures.map(x=>x.id===c.id?{...x,notify:!x.notify}:x); this.persistClosures(L); return { closures:L }; }),
        remove:()=>{ this.setState(st=>{ const L=st.closures.filter(x=>x.id!==c.id); this.persistClosures(L); return { closures:L }; }); this.flash(c.name+' removed'); } }; };
    const sortedC=[...s.closures].sort((a,b)=>a.date<b.date?-1:1).map(fmtC);
    const nc=s.nc; const ncDay=nc.date?+nc.date.slice(-2):0;
    const fw=this.sw(s.federal);

    // emergency
    const em=s.em;
    const reasonText={ 'Severe weather':'severe weather', 'Power outage':'a power outage', 'Equipment failure':'an equipment failure', 'Staff shortage':'a staffing issue', 'Other':'unforeseen circumstances' }[em.reason];
    const untilText=em.dur==='today'?'for the rest of today':(em.dur==='until'?'until '+em.until+' today':'through '+new Date(em.through+'T12:00:00').toLocaleDateString('en-US',{ weekday:'long', month:'short', day:'numeric' }));
    const preview=em.msg.replace(/\{first\}/g,'Liam').replace(/\{reason\}/g,reasonText).replace(/\{until\}/g,untilText).replace(/\{link\}/g,'oasis.spa/r/8KQ2');
    const setEm=(p)=>this.setState(st=>({ em:{ ...st.em, ...p } }));
    const emOpt=(k,label,sub)=>{ const w=this.sw(em[k]); return { label, sub, track:w.track, knob:w.knob, toggle:()=>setEm({ [k]:!em[k] }) }; };
    const affected=em.dur==='until'?this.REMAINING.filter(r=>this.parseT(r[0])<this.parseT(em.until)):this.REMAINING;

    // employees
    const q=s.empQuery.trim().toLowerCase();
    const COLORS=['#0E7A63','#2563EB','#7A3B8A','#C2740B','#0D9488','#B45309','#6B7280'];
    const av=(i,size)=>({ width:size+'px',height:size+'px',borderRadius:'13px',flex:'none',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:(size/3.2)+'px', background:'color-mix(in oklab, '+COLORS[i%7]+' '+(dark?'26%':'15%')+', transparent)', color:dark?'#E8EEEA':COLORS[i%7] });
    const empRows=s.employees.map((e,i)=>({e,i})).filter(({e})=>(s.roleFilter==='all'||e.roles.includes(s.roleFilter)) && (!q || [e.first,e.last,e.phone,e.title,...e.roles.map(r=>this.roleName(r))].join(' ').toLowerCase().includes(q))).map(({e,i})=>{
      const st=e.status; const days=e.sched.filter(x=>x.on).length; const ovN=Object.keys(e.overrides).length;
      return { name:e.first+' '+e.last, initials:(e.first[0]||'')+(e.last[0]||''), title:e.title||'—', type:e.type, phone:e.phone, sched:days+' days / week',
        roles:e.roles.map(r=>this.roleName(r)), hasOverrides:ovN>0, overrides:ovN+' exception'+(ovN>1?'s':''), avatar:av(i,46),
        status:st==='active'?'Active':(st==='invited'?'Invite sent':'Inactive'),
        statusStyle:{ width:'96px',textAlign:'center',fontSize:'11.5px',fontWeight:800,padding:'5px 9px',borderRadius:'8px', background:st==='active'?'var(--accentSoft)':(st==='invited'?'rgba(194,116,11,.14)':'var(--panel3)'), color:st==='active'?'var(--accentInk)':(st==='invited'?'#B45309':'var(--ink3)') },
        open:()=>this.openEmp(e) }; });
    const roleFilters=[{id:'all',name:'All'},...s.rc.roles].map(r=>({ label:r.name, onClick:()=>this.setState({ roleFilter:r.id }), style:this.chip(s.roleFilter===r.id) }));

    // roles matrix
    const roles=s.rc.roles;
    const matrixCols='minmax(220px,1.6fr) repeat('+roles.length+', minmax(96px,1fr))';
    const roleCards=roles.map(r=>{ const n=Object.values(s.rc.perms[r.id]||{}).filter(Boolean).length; const ppl=s.employees.filter(e=>e.roles.includes(r.id)).length;
      return { name:r.name, desc:r.desc, people:ppl+(ppl===1?' person':' people'), count:n+' of '+this.PERMS.flatMap(g=>g.items).length+' permissions' }; });
    const roleCols=roles.map(r=>({ name:r.name, locked:!!r.locked, custom:!!r.custom, remove:()=>{ this.setRC(rc=>{ rc.roles=rc.roles.filter(x=>x.id!==r.id); delete rc.perms[r.id]; delete rc.limits[r.id]; return rc; }); this.setState(st=>({ employees:st.employees.map(e=>({ ...e, roles:e.roles.filter(x=>x!==r.id) })) })); this.flash(r.name+' removed'); } }));
    const permGroups=this.PERMS.map(g=>({ mod:g.mod, rows:g.items.map(([pid,label,lim])=>({ label, cells:roles.map(r=>{ const on=!!(s.rc.perms[r.id]||{})[pid]; const lk=lim?this.limKey(pid):null; const lv=lk?(s.rc.limits[r.id]||{})[lk]:undefined;
      return { on, hasLimit:!!lk && on, limitLabel:lk?this.limLabel(lv===undefined?25:lv):'',
        box:{ width:'36px',height:'36px',borderRadius:'10px',display:'flex',alignItems:'center',justifyContent:'center', background:on?(r.locked?'var(--panel3)':'var(--accent)'):'transparent', color:on?(r.locked?'var(--ink2)':'#fff'):'transparent', border:on?'none':'2px solid var(--line)', cursor:r.locked?'not-allowed':'pointer' },
        limitStyle:{ fontSize:'11px',fontWeight:800,padding:'3px 7px',borderRadius:'6px',background:'var(--panel2)',border:'1px solid var(--line)',color:'var(--ink2)',whiteSpace:'nowrap', cursor:r.locked?'not-allowed':'pointer' },
        toggle:()=>{ if(r.locked){ this.flash('Super Admin always has every permission'); return; } this.setRC(rc=>{ rc.perms[r.id][pid]=!on; return rc; }); },
        cycle:()=>{ if(r.locked) return; this.setRC(rc=>{ rc.limits[r.id]=rc.limits[r.id]||{}; const cur=rc.limits[r.id][lk]; const i=this.LIMITS.indexOf(cur===undefined?25:cur); rc.limits[r.id][lk]=this.LIMITS[(i+1)%this.LIMITS.length]; return rc; }); } }; }) })) }));

    // services
    const isPkg=s.svcKind==='pkg', src=isPkg?s.packages:s.addons;
    const sel=src[s.svcSel]?s.svcSel:Object.keys(src)[0]; const item=src[sel];
    const setTasks=(fn)=>this.setState(st=>{ const key=isPkg?'packages':'addons'; const coll={ ...st[key], [sel]:{ ...st[key][sel], tasks:fn([...st[key][sel].tasks]) } }; const p=isPkg?coll:st.packages, a=isPkg?st.addons:coll; this.persistChecklists(p,a); return { [key]:coll }; });
    const addTask=()=>{ const t=s.newTask.trim(); if(!t) return; setTasks(T=>[...T,t]); this.setState({ newTask:'' }); };
    const tasks=item.tasks.map((t,i)=>({ n:String(i+1), label:t, edit:(e)=>{ const v=e.target.value; setTasks(T=>{ T[i]=v; return T; }); },
      up:()=>setTasks(T=>{ if(i>0){ [T[i-1],T[i]]=[T[i],T[i-1]]; } return T; }), down:()=>setTasks(T=>{ if(i<T.length-1){ [T[i+1],T[i]]=[T[i],T[i+1]]; } return T; }), remove:()=>setTasks(T=>T.filter((_,j)=>j!==i)) }));
    const svcList=Object.keys(src).map(k=>({ name:k, count:String(src[k].tasks.length), onClick:()=>this.setState({ svcSel:k }), style:{ display:'flex',alignItems:'center',gap:'8px',width:'100%',minHeight:'44px',padding:'0 12px',borderRadius:'10px', background:k===sel?'var(--panel)':'transparent', border:'1px solid '+(k===sel?'var(--line)':'transparent'), color:k===sel?'var(--ink)':'var(--ink2)' } }));

    // drawer
    const dft=s.draft; let dr={};
    if(dft){
      const idx=Math.max(0,s.employees.findIndex(e=>e.id===dft.id));
      const fld=(k,label,ph)=>({ label, value:dft[k], ph, set:(e)=>{ const v=e.target.value; this.setDraft(d=>({ ...d, [k]:v })); }, style:{ width:'100%',height:'46px',padding:'0 14px',borderRadius:'11px',border:'1px solid '+(s.drError&&((k==='first'&&!dft.first.trim())||(k==='phone'&&!dft.phone.trim()))?'#C2410C':'var(--line)'),background:'var(--panel)',color:'var(--ink)',fontFamily:'inherit',fontSize:'14px',fontWeight:600 } });
      const segs=(k,opts)=>opts.map(o=>({ label:o, onClick:()=>this.setDraft(d=>({ ...d, [k]:o })), style:this.seg(dft[k]===o) }));
      const tab=(k)=>({ height:'44px',padding:'0 16px',fontSize:'14px',fontWeight:700, color:s.drTab===k?'var(--accentInk)':'var(--ink2)', borderBottom:'3px solid '+(s.drTab===k?'var(--accent)':'transparent') });
      const allP=this.PERMS.flatMap(g=>g.items.map(i=>i[0])); const effOn=allP.filter(p=>this.eff(dft,p).on).length;
      const ovBtn=(on,c)=>({ height:'30px',padding:'0 10px',borderRadius:'7px',fontSize:'11.5px',fontWeight:800, background:on?c:'transparent', color:on?'#fff':'var(--ink3)' });
      dr={ heading:dft.id?(dft.first+' '+dft.last):'New employee', sub:dft.id?((dft.title||'')+' · '+dft.roles.map(r=>this.roleName(r)).join(' + ')):'They\u2019ll get an SMS invite to set up their login.',
        initials:dft.id?((dft.first[0]||'')+(dft.last[0]||'')):'+', avatar:av(idx,54),
        tProfile:tab('profile'), tAccess:tab('access'), tSched:tab('sched'), isProfile:s.drTab==='profile', isAccess:s.drTab==='access', isSched:s.drTab==='sched',
        fields:[fld('first','First name *','First'),fld('last','Last name','Last'),fld('phone','Mobile *','(305) 555-0000'),fld('email','Email','name@oasisautospa.com'),fld('title','Job title','e.g. Detailer')],
        types:segs('type',['Full-time','Part-time','Contractor']), pays:segs('payType',['Hourly','Commission','Salary']),
        rate:dft.rate, ratePh:dft.payType==='Hourly'?'$ / hour':(dft.payType==='Commission'?'% per job':'$ / year'), setRate:(e)=>{ const v=e.target.value; this.setDraft(d=>({ ...d, rate:v })); },
        skills:this.SKILLS.map(k=>{ const on=dft.skills.includes(k); return { label:k, onClick:()=>this.setDraft(d=>({ ...d, skills:on?d.skills.filter(x=>x!==k):[...d.skills,k] })), style:this.chip(on) }; }),
        roleOpts:roles.map(r=>{ const on=dft.roles.includes(r.id); return { name:r.name, desc:r.desc, on, onClick:()=>this.setDraft(d=>({ ...d, roles:on?d.roles.filter(x=>x!==r.id):[...d.roles,r.id] })),
          style:{ display:'flex',alignItems:'flex-start',gap:'10px',padding:'12px',borderRadius:'12px',minHeight:'60px', background:on?'var(--accentSoft)':'var(--panel)', border:'1px solid '+(on?'var(--accentBrd)':'var(--line)') },
          box:{ width:'22px',height:'22px',borderRadius:'7px',flex:'none',display:'flex',alignItems:'center',justifyContent:'center',marginTop:'1px', background:on?'var(--accent)':'transparent', border:on?'none':'2px solid var(--ink3)' } }; }),
        effCount:effOn+' of '+allP.length+' allowed',
        effGroups:this.PERMS.map(g=>({ mod:g.mod, rows:g.items.map(([pid,label])=>{ const ef=this.eff(dft,pid); const setOv=(v)=>()=>this.setDraft(d=>{ const o={ ...d.overrides }; if(v) o[pid]=v; else delete o[pid]; return { ...d, overrides:o }; });
          return { label, src:ef.src, dot:{ width:'10px',height:'10px',borderRadius:'50%',flex:'none', background:ef.on?'var(--accent)':'var(--line)' }, inherit:setOv(null), allow:setOv('allow'), deny:setOv('deny'), sInherit:ovBtn(!ef.ov,'var(--ink2)'), sAllow:ovBtn(ef.ov==='allow','var(--accent)'), sDeny:ovBtn(ef.ov==='deny','#C2410C') }; }) })),
        sched:this.ORDER.map(d=>{ const h=dft.sched[d]; const w=this.sw(h.on); const up=(k,dir)=>()=>this.setDraft(x=>{ const S=x.sched.map(y=>({...y})); S[d][k]=this.step(S[d][k],dir); return { ...x, sched:S }; });
          return { day:this.DAYS[d], on:h.on, off:!h.on, from:h.from, to:h.to, track:w.track, knob:w.knob, toggle:()=>this.setDraft(x=>{ const S=x.sched.map(y=>({...y})); S[d].on=!S[d].on; return { ...x, sched:S }; }), fromDec:up('from',-1), fromInc:up('from',1), toDec:up('to',-1), toInc:up('to',1) }; }),
        error:s.drError, canDeactivate:!!dft.id, activeLabel:dft.status==='inactive'?'Reactivate':'Deactivate', saveLabel:dft.id?'Save changes':'Create & send invite' };
    }

    const head={ closures:['Add closure',()=>this.setState({ adding:true, nc:{ date:'', name:'', type:'closed', from:'10:00 AM', to:'2:00 PM' }, ncError:'' })], employees:['Add employee',()=>this.openEmp(null)], roles:['Custom role',()=>{ const id='custom'+Date.now(); this.setRC(rc=>{ rc.roles.push({ id, name:'Shift Lead', desc:'Custom role \u2014 starts from Crew.', custom:true }); rc.perms[id]={ ...rc.perms.crew, 'sched.edit':true }; rc.limits[id]={ refund:25, adjust:25, credit:25 }; return rc; }); this.flash('Custom role added \u2014 adjust its permissions below'); }] }[sec];

    return {
      theme:s.theme, toggleTheme:()=>{ const t=dark?'light':'dark'; this.save('oasis-theme',t); try{ localStorage.setItem('oasis-theme',t); }catch(e){} this.setState({ theme:t }); },
      nav:{ hours:navS('hours'), closures:navS('closures'), emergency:navS('emergency'), employees:navS('employees'), roles:navS('roles'), services:navS('services'), vip:navS('vip'), arrival:navS('arrival') },
      goVip:go('vip'), goArrival:go('arrival'), secVip:sec==='vip', secArrival:sec==='arrival',
      ...this.vipVM(),
      goHours:go('hours'), goClosures:go('closures'), goEmergency:go('emergency'), goEmployees:go('employees'), goRoles:go('roles'), goServices:go('services'),
      empCount:String(s.employees.length), secTitle:META[sec][0], secDesc:META[sec][1],
      hasHeadBtn:!!head, headBtnLabel:head?head[0]:'', headBtn:head?head[1]:null,
      secHours:sec==='hours', secClosures:sec==='closures', secEmergency:sec==='emergency', secEmployees:sec==='employees', secRoles:sec==='roles', secServices:sec==='services',
      hourRows, ruleRows, weekHours:(total/60)+' hrs',
      copyWeekdays:()=>this.setHours(H=>{ [2,3,4,5].forEach(d=>{ H[d]={ ...H[1] }; }); return H; }),
      hoursDirty:sec==='hours' && JSON.stringify(s.hours)!==s.savedHours,
      discardHours:()=>this.setState(st=>({ hours:JSON.parse(st.savedHours) })),
      saveHours:()=>{ this.save('oasis-hours', s.hours); this.setState({ savedHours:JSON.stringify(s.hours) }); this.flash('Working hours saved \u00b7 booking and calendar updated'); },
      upcoming:sortedC.filter(c=>!c.past), past:sortedC.filter(c=>c.past).reverse(),
      federalSw:fw, toggleFederal:()=>this.setState({ federal:!s.federal }),
      addingClosure:s.adding, nc, ncIsReduced:nc.type==='reduced', ncError:s.ncError,
      ncClosedStyle:this.seg(nc.type==='closed'), ncReducedStyle:this.seg(nc.type==='reduced'),
      ncDate:(e)=>{ const v=e.target.value; this.setState(st=>({ nc:{ ...st.nc, date:v }, ncError:'' })); }, ncName:(e)=>{ const v=e.target.value; this.setState(st=>({ nc:{ ...st.nc, name:v }, ncError:'' })); },
      ncClosed:()=>this.setState(st=>({ nc:{ ...st.nc, type:'closed' } })), ncReduced:()=>this.setState(st=>({ nc:{ ...st.nc, type:'reduced' } })),
      ncFromDec:()=>this.setState(st=>({ nc:{ ...st.nc, from:this.step(st.nc.from,-1) } })), ncFromInc:()=>this.setState(st=>({ nc:{ ...st.nc, from:this.step(st.nc.from,1) } })),
      ncToDec:()=>this.setState(st=>({ nc:{ ...st.nc, to:this.step(st.nc.to,-1) } })), ncToInc:()=>this.setState(st=>({ nc:{ ...st.nc, to:this.step(st.nc.to,1) } })),
      ncAffected:nc.date&&nc.date>=TODAY?((ncDay%5)+2)+' customers are booked that day \u2014 they\u2019ll get a reschedule link when you add this.':'',
      cancelClosure:()=>this.setState({ adding:false }),
      addClosure:()=>{ if(!nc.date||!nc.name.trim()){ this.setState({ ncError:'Add a date and a name.' }); return; } if(s.closures.some(c=>c.date===nc.date)){ this.setState({ ncError:'There\u2019s already a closure on that date.' }); return; }
        const L=[...s.closures,{ ...nc, name:nc.name.trim(), notify:true, id:'c'+Date.now() }]; this.persistClosures(L); this.setState({ closures:L, adding:false }); this.flash(nc.name.trim()+' added \u00b7 calendar updated'); },
      emActive:em.active, emIdle:!em.active, emSummary:em.summary,
      emNotified:em.notify?String(this.REMAINING.length):'0', emRebooked:'2', emBooking:em.pause?'Paused':'Open',
      emReasons:['Severe weather','Power outage','Equipment failure','Staff shortage','Other'].map(r=>({ label:r, onClick:()=>setEm({ reason:r }), style:this.chip(em.reason===r) })),
      emDurations:[['today','Rest of today'],['until','Until a time'],['days','Multiple days']].map(([k,l])=>({ label:l, onClick:()=>setEm({ dur:k }), style:this.seg(em.dur===k) })),
      emIsUntil:em.dur==='until', emIsDays:em.dur==='days', emUntil:em.until, emThrough:em.through,
      emUntilDec:()=>setEm({ until:this.step(em.until,-1) }), emUntilInc:()=>setEm({ until:this.step(em.until,1) }), emThroughSet:(e)=>setEm({ through:e.target.value }),
      emMsg:em.msg, emMsgSet:(e)=>setEm({ msg:e.target.value }), emPreview:preview,
      emOpts:[emOpt('notify','Notify affected customers','WhatsApp, with SMS fallback'),emOpt('link','Include one-tap reschedule link','Customers pick a new slot themselves'),emOpt('credits','Protect member credits','Missed visits don\u2019t use a credit'),emOpt('pause','Pause online booking','Until you reopen'),emOpt('crew','Alert on-shift crew','Push notification to the team')],
      emAffected:affected.map(r=>({ time:r[0], name:r[1], veh:r[2] })), emAffectedCount:affected.length+' customers',
      emHistory:s.emHistory, confirmOpen:s.confirm,
      confirmText:(em.notify?affected.length+' customers will be messaged':'No customers will be messaged')+(em.pause?', online booking pauses':'')+' and the closure shows on the Operations screen. Reason: '+em.reason.toLowerCase()+', '+untilText+'.',
      askClose:()=>this.setState({ confirm:true }), cancelClose:()=>this.setState({ confirm:false }),
      doClose:()=>{ const summary=em.reason+' \u00b7 closed '+untilText+(em.pause?' \u00b7 online booking paused':''); this.save('oasis-emergency',{ active:true, summary }); this.setState(st=>({ confirm:false, em:{ ...st.em, active:true, summary } })); this.flash('Shop closed \u00b7 '+(em.notify?affected.length+' customers notified':'no messages sent')); },
      reopen:()=>{ this.save('oasis-emergency',{ active:false }); this.setState(st=>({ em:{ ...st.em, active:false }, emHistory:[{ date:'Jun 13, 2026', reason:st.em.reason, detail:'Reopened by Rafael M. \u00b7 '+this.REMAINING.length+' notified' },...st.emHistory] })); this.flash('Shop reopened \u00b7 online booking resumed'); },
      empQuery:s.empQuery, empSearch:(e)=>this.setState({ empQuery:e.target.value }), roleFilters, empRows, noEmp:empRows.length===0,
      roleCards, roleCols, permGroups, matrixCols,
      kindPkg:()=>this.setState({ svcKind:'pkg', svcSel:Object.keys(s.packages)[1] }), kindAddon:()=>this.setState({ svcKind:'addon', svcSel:Object.keys(s.addons)[0] }),
      kindPkgStyle:this.seg(isPkg), kindAddonStyle:this.seg(!isPkg), svcList, tasks,
      svcName:sel, svcKindLabel:isPkg?'Package':'Add-on', svcMeta:isPkg?('$'+item.price+' \u00b7 '+item.dur+' min \u00b7 '+item.tasks.length+' tasks'):('+$'+item.price+' \u00b7 '+item.tasks.length+' tasks'),
      svcKindStyle:{ fontSize:'10.5px',fontWeight:800,padding:'4px 8px',borderRadius:'6px',textTransform:'uppercase',letterSpacing:'0.04em', background:isPkg?'var(--accentSoft)':'rgba(176,121,8,.15)', color:isPkg?'var(--accentInk)':'#8A5A06' },
      svcNote:isPkg?'Every job booked with this package starts with these tasks. Selected add-ons append their own tasks underneath.':'When this add-on is on a job \u2014 booked, approved in the app, or added at the desk \u2014 these tasks are appended to the job checklist.',
      newTask:s.newTask, newTaskSet:(e)=>this.setState({ newTask:e.target.value }), newTaskKey:(e)=>{ if(e.key==='Enter') addTask(); }, addTask,
      drawerOpen:!!dft, dr, closeDrawer:()=>this.setState({ draft:null, drawer:null }), stop:(e)=>e.stopPropagation(),
      tabProfile:()=>this.setState({ drTab:'profile' }), tabAccess:()=>this.setState({ drTab:'access' }), tabSched:()=>this.setState({ drTab:'sched' }),
      toggleActive:()=>this.setDraft(d=>({ ...d, status:d.status==='inactive'?'active':'inactive' })),
      saveEmp:()=>{ if(!dft.first.trim()||!dft.phone.trim()){ this.setState({ drError:'First name and mobile number are required.', drTab:'profile' }); return; } if(!dft.roles.length){ this.setState({ drError:'Assign at least one role.', drTab:'access' }); return; }
        if(dft.id){ this.setState(st=>({ employees:st.employees.map(e=>e.id===dft.id?dft:e), draft:null })); this.flash('Saved '+dft.first+' '+dft.last); }
        else { const ne={ ...dft, id:'e'+Date.now(), status:'invited' }; this.setState(st=>({ employees:[...st.employees,ne], draft:null })); this.flash('Invite sent to '+dft.phone); } },
      toast:s.toast,
    };
  }
}
