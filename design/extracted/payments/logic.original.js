
class Component extends DCLogic {
  TAX = 0.07;
  DEF_ROLES = { roles:[{id:'super',name:'Super Admin'},{id:'mgmt',name:'Management'},{id:'acct',name:'Accounting'},{id:'support',name:'Customer Support'},{id:'crew',name:'Crew'}],
    perms:{ super:{'pay.reports':1,'pay.refund':1,'pay.adjust':1,'pay.credit':1,'pay.collect':1}, mgmt:{'pay.reports':1,'pay.refund':1,'pay.adjust':1,'pay.credit':1,'pay.collect':1}, acct:{'pay.reports':1,'pay.refund':1,'pay.adjust':1,'pay.credit':1,'pay.collect':1}, support:{'pay.refund':1,'pay.adjust':1,'pay.credit':1,'pay.collect':1}, crew:{} },
    limits:{ super:{refund:null,adjust:null,credit:null}, mgmt:{refund:1000,adjust:500,credit:500}, acct:{refund:500,adjust:250,credit:250}, support:{refund:50,adjust:25,credit:50}, crew:{refund:25,adjust:25,credit:25} } };
  PRICE = { 'Express Hand Wash':45,'Premium Hand Wash + Interior':129,'Premium Hand Wash + Interior Refresh':139,'Executive Detail':260,'Executive Detail + Ceramic':420,'Full Detail':320,'Ceramic Maintenance + Wax':180,'Exotic Detail Package':650,'Family Wash + Pet Hair':95 };
  ADD = { 'Interior deep clean':60,'Pet hair removal':35,'Leather conditioning':45,'Wax':40,'Clay bar':50,'Odor removal':30,'Engine bay cleaning':55,'Ceramic maintenance':120,'Rain repellent':25,'Wheel deep clean':40 };

  r2(n){ return Math.round(n*100)/100; }
  money(n){ const v=this.r2(n); return (v<0?'−$':'$')+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  money0(n){ return (n<0?'−$':'$')+Math.round(Math.abs(n)).toLocaleString('en-US'); }

  state = (() => {
    const ls=(k)=>{ try { return JSON.parse(localStorage.getItem(k)||'null'); } catch(e) { return null; } };
    let seq=20610; const txs=[];
    const mk=(o)=>{ const items=[{name:o.svc,price:this.PRICE[o.svc]},...(o.add||[]).map(n=>({name:n,price:this.ADD[n]}))];
      const tx={ id:o.id||('INV-'+(seq--)), off:o.off, time:o.time, client:o.client, vehicle:o.veh, staff:o.staff||'Marco R.', items, tip:o.tip||0, canceled:!!o.canceled, events:[...(o.pre||[])] };
      (o.adj||[]).forEach(a=>tx.events.push({ type:'adjust', amt:a[0], reason:a[1], by:a[2]||'Rafael M.', t:o.time }));
      const tot=this.calc(tx).total;
      if(o.pay==='full') tx.events.push({ type:'pay', amt:this.r2(tot-(o.creditUsed||0)), method:o.method||'Visa ••4421', by:'System', t:o.time });
      else if(o.pay>0) tx.events.push({ type:'pay', amt:o.pay, method:o.method||'Visa ••4421', by:'System', t:o.time, deposit:true });
      (o.post||[]).forEach(e=>tx.events.push({ t:o.time, by:'Rafael M.', ...e }));
      txs.push(tx); };
    // today
    mk({ id:'INV-20608', off:0, time:'10:05 AM', client:'Aisha Rahman', veh:'2023 Range Rover Sport', svc:'Executive Detail + Ceramic', add:['Ceramic maintenance'], pay:'full', method:'Amex ••3008' });
    mk({ id:'INV-20607', off:0, time:'10:15 AM', client:'Marcus Webb', veh:'2017 Jeep Wrangler', staff:'Unassigned', svc:'Family Wash + Pet Hair', add:['Odor removal'], pay:20, method:'Visa ••6610' });
    mk({ id:'INV-20606', off:0, time:'9:50 AM', client:'Liam Chen', veh:'2020 BMW M340i', svc:'Ceramic Maintenance + Wax', pay:'full', method:'Visa ••7731' });
    mk({ id:'INV-20605', off:0, time:'10:30 AM', client:'Sofia Marchetti', veh:'2024 Porsche Macan', staff:'Sofia D.', svc:'Executive Detail', pay:50, method:'Visa ••0092' });
    mk({ id:'INV-20604', off:0, time:'9:40 AM', client:'Jonathan Franco', veh:'2023 Mercedes-Benz GLE', svc:'Premium Hand Wash + Interior Refresh', add:['Leather conditioning'], pay:'full', method:'Apple Pay' });
    mk({ id:'INV-20603', off:0, time:'10:31 AM', client:'Priya Nair', veh:'2022 Tesla Model Y', staff:'Lena K.', svc:'Premium Hand Wash + Interior', add:['Rain repellent'], pay:0 });
    mk({ id:'INV-20602', off:0, time:'9:58 AM', client:'David Okafor', veh:'2019 Ford F-150', svc:'Full Detail', add:['Engine bay cleaning'], tip:20, adj:[[-25,'Loyalty']], pay:'full', method:'Mastercard ••1180' });
    mk({ id:'INV-20601', off:0, time:'8:52 AM', client:'Maria Delgado', veh:'2021 Audi Q5', staff:'Lena K.', svc:'Express Hand Wash', add:['Wax'], tip:8, pay:'full', method:'Visa ••4421' });
    // specials
    mk({ id:'INV-20579', off:-1, time:'2:10 PM', client:'Chloe Bennett', veh:'2022 BMW X5', staff:'Lena K.', svc:'Executive Detail', pay:'full', method:'Visa ••5521', post:[{ type:'refund', amt:80, dest:'card', method:'Visa ••5521', reason:'Service issue', note:'Interior stain not fully removed', by:'Sofia D.', byRole:'Customer Support', status:'pending', t:'Yesterday 4:40 PM' }] });
    mk({ id:'INV-20571', off:-2, time:'11:00 AM', client:'Omar Haddad', veh:'2023 Porsche 911 Carrera', svc:'Full Detail', canceled:true, pay:50, method:'Visa ••2290', post:[{ type:'refund', amt:50, dest:'card', method:'Visa ••2290', reason:'Customer canceled', by:'Sofia D.', status:'done', t:'Jun 11 · 9:12 AM' }] });
    mk({ id:'INV-20566', off:-3, time:'1:30 PM', client:'Hannah Kim', veh:'2024 Rivian R1S', svc:'Premium Hand Wash + Interior', add:['Pet hair removal'], tip:10, pay:'full', post:[{ type:'refund', amt:37.45, dest:'card', method:'Visa ••4421', reason:'Add-on not performed', by:'Rafael M.', status:'done', t:'Jun 10 · 3:05 PM' }] });
    mk({ id:'INV-20560', off:-4, time:'10:20 AM', client:'Victor Nguyen', veh:'2020 Honda Accord', svc:'Express Hand Wash', creditUsed:25, pre:[{ type:'credit_apply', amt:25, method:'Store credit', by:'Sofia D.', t:'10:20 AM' }], pay:'full', method:'Visa ••8812' });
    mk({ id:'INV-20552', off:-5, time:'3:15 PM', client:'Mateo Silva', veh:'2022 Ford Bronco', svc:'Premium Hand Wash + Interior', pay:'full', method:'Apple Pay', post:[{ type:'credit_issue', amt:25, reason:'Service recovery', note:'Waited 40 min past slot', expiry:'90 days', t:'Jun 8 · 4:02 PM' }] });
    mk({ id:'INV-20548', off:-6, time:'9:00 AM', client:'Zoe Laurent', veh:'2023 Audi e-tron GT', svc:'Exotic Detail Package', adj:[[40,'Extra soil surcharge']], pay:'full', method:'Amex ••1005' });
    mk({ off:-14, time:'11:30 AM', client:'Priya Nair', veh:'2022 Tesla Model Y', staff:'Lena K.', svc:'Express Hand Wash', pay:'full', post:[{ type:'credit_issue', amt:20, reason:'Referral reward', expiry:'No expiry', t:'May 30 · 11:45 AM' }] });
    mk({ off:-20, time:'12:00 PM', client:'Victor Nguyen', veh:'2020 Honda Accord', svc:'Express Hand Wash', pay:'full', post:[{ type:'credit_issue', amt:25, reason:'Weather closure', expiry:'90 days', t:'May 24 · 12:10 PM' }] });
    // generated history
    let t=987654; const rnd=()=>{ t+=0x6D2B79F5; let r=Math.imul(t^(t>>>15),1|t); r^=r+Math.imul(r^(r>>>7),61|r); return ((r^(r>>>14))>>>0)/4294967296; };
    const names=['Olivia Hart','Ethan Morales','Isaac Patel','Andre Thompson','Camila Reyes','Noah Fischer','Leah Goldberg','Ruby Castillo','Ava Sinclair','Diego Ramos','Nina Petrova','Caleb Owens','Mia Torres','Julian Brooks','Grace Adeyemi','Tom Bradley','Nathan Brooks'];
    const vehs=['2022 BMW X5','2021 Toyota 4Runner','2020 Honda Accord','2024 Rivian R1S','2019 Mercedes-Benz C300','2021 Kia Telluride','2022 Tesla Model 3','2024 Lexus GX 550','2023 Genesis GV80','2018 Lexus RX 350'];
    const svcs=Object.keys(this.PRICE), adds=Object.keys(this.ADD), methods=['Visa ••4421','Mastercard ••1180','Apple Pay','Apple Pay','Cash','Amex ••3008'];
    for(let o=-1;o>=-29;o--){ if(o===-10) continue; const n=2+Math.floor(rnd()*3);
      for(let i=0;i<n;i++){ const h=8+Math.floor(rnd()*9); const r=rnd();
        mk({ off:o, time:((h%12)||12)+':'+(rnd()<0.5?'00':'30')+' '+(h>=12?'PM':'AM'), client:names[Math.floor(rnd()*names.length)], veh:vehs[Math.floor(rnd()*vehs.length)], staff:['Marco R.','Lena K.','Sofia D.'][i%3],
          svc:svcs[Math.floor(rnd()*svcs.length)], add:rnd()<0.4?[adds[Math.floor(rnd()*adds.length)]]:[], tip:5*Math.floor(rnd()*4), adj:r<0.08?[[-15,'Loyalty']]:[], pay:'full', method:methods[Math.floor(rnd()*methods.length)],
          post:r>0.95?[{ type:'refund', amt:20, dest:'credit', method:'Store credit', reason:'Goodwill', by:'Sofia D.', status:'done', t:'' }]:[] }); } }
    return {
      theme:(()=>{ try { return localStorage.getItem('oasis-theme')||'light'; } catch(e) { return 'light'; } })(),
      rc:ls('oasis-roles')||this.DEF_ROLES, role:'mgmt', roleMenu:false,
      txs, range:'7d', filter:'all', query:'', selId:'INV-20603', sheet:null, f:{}, toast:null,
    };
  })();

  calc(tx){
    const items=tx.items.reduce((a,x)=>a+x.price,0), ev=tx.events;
    const adj=ev.filter(e=>e.type==='adjust').reduce((a,e)=>a+e.amt,0);
    const sub=items+adj, tax=this.r2(sub*this.TAX), total=this.r2(sub+tax+tx.tip);
    const paidOrig=ev.filter(e=>e.type==='pay').reduce((a,e)=>a+e.amt,0), creditApplied=ev.filter(e=>e.type==='credit_apply').reduce((a,e)=>a+e.amt,0);
    const paid=this.r2(paidOrig+creditApplied);
    const refs=ev.filter(e=>e.type==='refund'&&e.status==='done'); const refunded=this.r2(refs.reduce((a,e)=>a+e.amt,0)); const refOrig=this.r2(refs.filter(e=>e.dest!=='credit').reduce((a,e)=>a+e.amt,0));
    const pending=ev.filter(e=>e.type==='refund'&&e.status==='pending');
    const balance=tx.canceled?0:Math.max(0,this.r2(total-paid));
    const refundable=Math.max(0,this.r2(paid-refunded-pending.reduce((a,e)=>a+e.amt,0)));
    const toOrigMax=Math.max(0,this.r2(paidOrig-refOrig));
    const issued=ev.filter(e=>e.type==='credit_issue').reduce((a,e)=>a+e.amt,0);
    let status='Paid'; if(tx.canceled&&refunded>=paid) status='Canceled · refunded'; else if(refunded>0&&refunded>=paid-0.01) status='Refunded'; else if(paid===0) status='Unpaid'; else if(balance>0) status='Partially paid'; else if(refunded>0) status='Partially refunded';
    return { items, adj, sub, tax, total, paid, paidOrig, creditApplied, refunded, pending, balance, refundable, toOrigMax, issued, status, net:this.r2(items+adj-refunded/(1+this.TAX)) };
  }
  clientCredit(name){ let b=0; this.state.txs.filter(t=>t.client===name).forEach(t=>t.events.forEach(e=>{ if(e.type==='credit_issue') b+=e.amt; if(e.type==='refund'&&e.status==='done'&&e.dest==='credit') b+=e.amt; if(e.type==='credit_apply') b-=e.amt; })); return this.r2(b); }
  lim(kind,role){ const rc=this.state.rc; const r=role||this.state.role; const has=!!((rc.perms[r]||{})['pay.'+kind]); if(!has) return { has:false, max:0 }; const v=(rc.limits[r]||{})[kind]; return { has:true, max:v===null||v===undefined&&r==='super'?Infinity:(v===undefined?25:v) }; }
  roleName(id){ const r=this.state.rc.roles.find(x=>x.id===id); return r?r.name:id; }
  nowT(){ const d=new Date(); let h=d.getHours(), m=d.getMinutes(); const ap=h>=12?'PM':'AM'; h=h%12||12; return 'Today '+h+':'+String(m).padStart(2,'0')+' '+ap; }
  flash(t){ this.setState({ toast:t }); clearTimeout(this._tt); this._tt=setTimeout(()=>this.setState({ toast:null }),3000); }
  addEvent(id,ev){ this.setState(s=>({ txs:s.txs.map(t=>t.id===id?{ ...t, events:[...t.events,{ t:this.nowT(), by:'Rafael M.', ...ev }] }:t) })); }
  dateOf(off){ return new Date(2026,5,13+off); }
  fmtDate(off){ if(off===0) return 'Today'; if(off===-1) return 'Yesterday'; return this.dateOf(off).toLocaleDateString('en-US',{ month:'short', day:'numeric' }); }
  pill(st){ const m={ 'Paid':['var(--accentSoft)','var(--accentInk)'], 'Unpaid':['var(--redSoft)','var(--red)'], 'Partially paid':['var(--amberSoft)','var(--amber)'], 'Refunded':['var(--panel3)','var(--ink2)'], 'Canceled · refunded':['var(--panel3)','var(--ink2)'], 'Partially refunded':['var(--amberSoft)','var(--amber)'] }[st]||['var(--panel3)','var(--ink2)'];
    return { fontSize:'11px',fontWeight:800,padding:'4px 9px',borderRadius:'7px',background:m[0],color:m[1],whiteSpace:'nowrap' }; }
  seg(on){ return { flex:1,height:'40px',padding:'0 12px',borderRadius:'9px',fontSize:'13px',fontWeight:700,whiteSpace:'nowrap', background:on?'var(--accent)':'transparent', color:on?'#fff':'var(--ink2)' }; }
  chip(on){ return { height:'38px',padding:'0 13px',borderRadius:'10px',fontSize:'12.5px',fontWeight:700, background:on?'var(--accentSoft)':'var(--panel)', color:on?'var(--accentInk)':'var(--ink2)', border:'1px solid '+(on?'var(--accentBrd)':'var(--line)') }; }
  openSheet(kind,preset){ this.setState({ sheet:kind, f:{ mode:'full', items:[], dest:'card', reason:null, note:'', amount:'', kind:'discount', unit:'$', settle:'credit', expiry:'90 days', method:'Card on file', ...(preset||{}) } }); }
  setF(p){ this.setState(s=>({ f:{ ...s.f, ...p } })); }

  renderVals(){
    const s=this.state, dark=s.theme==='dark', canView=!!((s.rc.perms[s.role]||{})['pay.reports']);
    const R={ today:[0,0,'Saturday, June 13'], '7d':[-6,0,'Jun 7 – Jun 13'], '30d':[-29,0,'May 15 – Jun 13'], mtd:[-12,0,'Jun 1 – Jun 13'] }[s.range];
    const inR=s.txs.filter(t=>t.off>=R[0]&&t.off<=R[1]).map(t=>({ t, c:this.calc(t) }));
    const sum=(f)=>inR.reduce((a,x)=>a+f(x),0);
    const gross=sum(x=>x.c.items), adj=sum(x=>x.c.adj), refunds=sum(x=>x.c.refunded), credits=sum(x=>x.c.issued), outstanding=sum(x=>x.c.balance), net=gross+adj-refunds/(1+this.TAX);
    const cnt=(f)=>inR.filter(f).length;
    const kpis=[
      { label:'Gross sales', value:this.money0(gross), sub:inR.length+' invoices', color:'var(--ink)' },
      { label:'Net revenue', value:this.money0(net), sub:'after refunds & discounts', color:'var(--accentInk)' },
      { label:'Refunds', value:this.money0(refunds), sub:cnt(x=>x.c.refunded>0)+' refunded', color:refunds?'var(--red)':'var(--ink)' },
      { label:'Adjustments', value:this.money0(adj), sub:cnt(x=>x.c.adj!==0)+' invoices', color:'var(--ink)' },
      { label:'Credits issued', value:this.money0(credits), sub:cnt(x=>x.c.issued>0)+' clients', color:'var(--ink)' },
      { label:'Outstanding', value:this.money0(outstanding), sub:cnt(x=>x.c.balance>0)+' open balances', color:outstanding?'var(--amber)':'var(--ink)' },
    ];
    // chart
    let buckets=[];
    if(s.range==='today'){ for(let h=8;h<=17;h++) buckets.push({ label:((h%12)||12)+(h>=12?'p':'a'), test:(x)=>{ const m=x.t.time.match(/(\d+):\d+\s*(AM|PM)/); let hh=+m[1]%12; if(m[2]==='PM') hh+=12; return hh===h; } }); }
    else { for(let o=R[0];o<=R[1];o++){ const d=this.dateOf(o); buckets.push({ label:(R[1]-R[0]>14?(d.getDate()%3===1?String(d.getDate()):''):['S','M','T','W','T','F','S'][d.getDay()]+' '+d.getDate()), test:(x)=>x.t.off===o, title:d.toDateString() }); } }
    const vals=buckets.map(b=>{ const L=inR.filter(b.test); return { net:L.reduce((a,x)=>a+x.c.net,0), loss:L.reduce((a,x)=>a+x.c.refunded+Math.max(0,-x.c.adj),0) }; });
    const mx=Math.max(1,...vals.map(v=>v.net+v.loss));
    const bars=buckets.map((b,i)=>({ label:b.label, title:(b.title||b.label)+' · net '+this.money0(vals[i].net), netStyle:{ height:(vals[i].net/mx*100)+'%',minHeight:vals[i].net>0?'3px':'0',background:'var(--accent)',borderRadius:'4px 4px 2px 2px' }, lossStyle:{ height:(vals[i].loss/mx*100)+'%',background:'var(--red)',borderRadius:'3px',opacity:.85 } }));
    // methods
    const fam=(m)=>/visa|master|amex/i.test(m)?'Card':(m==='Apple Pay'?'Apple Pay':(m==='Cash'?'Cash':'Store credit'));
    const mt={ 'Card':0,'Apple Pay':0,'Cash':0,'Store credit':0 }; inR.forEach(x=>x.t.events.forEach(e=>{ if(e.type==='pay') mt[fam(e.method)]+=e.amt; if(e.type==='credit_apply') mt['Store credit']+=e.amt; }));
    const mmx=Math.max(1,...Object.values(mt));
    const methods=Object.entries(mt).map(([k,v])=>({ label:k, value:this.money0(v), barStyle:{ height:'100%',width:(v/mmx*100)+'%',background:k==='Store credit'?'var(--amber)':'var(--accent)',borderRadius:'4px' } }));
    // filters + rows
    const q=s.query.trim().toLowerCase();
    const FIL={ all:['All',()=>true], unpaid:['Open balance',(x)=>x.c.balance>0], refunds:['Refunds',(x)=>x.c.refunded>0||x.c.pending.length>0], adjusted:['Adjusted',(x)=>x.c.adj!==0], credits:['Credits',(x)=>x.c.issued>0||x.c.creditApplied>0] };
    const filters=Object.entries(FIL).map(([k,[l,fn]])=>{ const on=s.filter===k; return { label:l, count:String(inR.filter(fn).length), onClick:()=>this.setState({ filter:k }),
      style:{ display:'flex',alignItems:'center',gap:'7px',height:'38px',padding:'0 12px',borderRadius:'10px',fontSize:'13px',fontWeight:700, background:on?'var(--accentSoft)':'transparent', color:on?'var(--accentInk)':'var(--ink2)' },
      countStyle:{ fontSize:'11px',fontWeight:800,padding:'1px 6px',borderRadius:'6px',background:on?'var(--accent)':'var(--panel3)',color:on?'#fff':'var(--ink3)' } }; });
    const list=inR.filter(FIL[s.filter][1]).filter(x=>!q||[x.t.id,x.t.client,x.t.vehicle,...x.t.items.map(i=>i.name)].join(' ').toLowerCase().includes(q)).sort((a,b)=>b.t.off-a.t.off||(b.t.id>a.t.id?1:-1));
    const rows=list.map(({t,c})=>({ id:t.id, date:this.fmtDate(t.off)+' · '+t.time, client:t.client, vehicle:t.vehicle, items:t.items[0].name+(t.items.length>1?' +'+(t.items.length-1):''), total:this.money(c.total), status:c.pending.length?'Refund pending':c.status, adjusted:c.adj!==0,
      statusStyle:c.pending.length?this.pill('Partially paid'):this.pill(c.status), onClick:()=>this.setState({ selId:t.id }),
      style:{ display:'grid',gridTemplateColumns:'118px minmax(170px,1.4fr) minmax(140px,1.2fr) 96px 150px',gap:'12px',alignItems:'center',width:'100%',textAlign:'left',minHeight:'58px',padding:'9px 16px',borderBottom:'1px solid var(--line2)', background:t.id===s.selId?'var(--accentSoft)':'transparent' } }));
    const allPending=s.txs.flatMap(t=>t.events.filter(e=>e.type==='refund'&&e.status==='pending').map(e=>({ t, e })));
    // detail
    const tx=s.txs.find(t=>t.id===s.selId)||s.txs[0]; const c=this.calc(tx); const credit=this.clientCredit(tx.client);
    const L=(label,value,kind)=>({ label, value, style:{ display:'flex',justifyContent:'space-between',padding:kind==='total'?'11px 0 7px':'6px 0',borderTop:kind==='total'?'1px solid var(--line)':'none',marginTop:kind==='total'?'4px':'0' },
      labelStyle:{ fontSize:kind==='total'?'14px':'13px',fontWeight:kind==='total'?800:600,color:kind==='neg'?'var(--red)':(kind==='pos'?'var(--accentInk)':'var(--ink2)') }, valStyle:{ fontSize:kind==='total'?'15px':'13px',fontWeight:800,color:kind==='neg'?'var(--red)':(kind==='pos'?'var(--accentInk)':'var(--ink)') } });
    const lines=[ ...tx.items.map(i=>L(i.name,this.money(i.price))), ...tx.events.filter(e=>e.type==='adjust').map(e=>L((e.amt<0?'Discount · ':'Surcharge · ')+e.reason,this.money(e.amt),e.amt<0?'neg':null)),
      L('Tax (7%)',this.money(c.tax)), ...(tx.tip?[L('Tip',this.money(tx.tip))]:[]), L('Total',this.money(c.total),'total'),
      ...(c.creditApplied?[L('Store credit applied',this.money(-c.creditApplied),'pos')]:[]), L('Paid',this.money(c.paidOrig)), ...(c.refunded?[L('Refunded',this.money(-c.refunded),'neg')]:[]) ];
    const big=[ { label:'Total', value:this.money(c.total), color:'var(--ink)' }, { label:'Collected', value:this.money(c.paid-c.refunded), color:'var(--accentInk)' }, c.balance>0?{ label:'Balance due', value:this.money(c.balance), color:'var(--red)' }:{ label:'Refundable', value:this.money(c.refundable), color:'var(--ink)' } ];
    const rf=this.lim('refund'), ad=this.lim('adjust'), cr=this.lim('credit'), canCollect=!!((s.rc.perms[s.role]||{})['pay.collect']);
    const act=(label,fn,ok,why,primary)=>({ label, onClick:fn, disabled:!ok, why:ok?'':why, style:{ height:'48px',borderRadius:'12px',fontWeight:800,fontSize:'13.5px', background:!ok?'var(--panel2)':(primary?'var(--accent)':'var(--panel)'), color:!ok?'var(--ink3)':(primary?'#fff':'var(--ink)'), border:'1px solid '+(primary&&ok?'var(--accent)':'var(--line)'), opacity:ok?1:0.7 } });
    const actions=[];
    if(c.balance>0) actions.push(act('Collect '+this.money(c.balance),()=>this.openSheet('collect'),canCollect,'Role can\u2019t collect payments',true));
    if(c.balance>0&&credit>0) actions.push(act('Apply '+this.money(Math.min(credit,c.balance))+' credit',()=>this.openSheet('apply'),canCollect,'Role can\u2019t collect payments'));
    actions.push(act('Refund',()=>this.openSheet('refund'),rf.has&&c.refundable>0,rf.has?'Nothing left to refund':'Role can\u2019t issue refunds'));
    actions.push(act('Adjust',()=>this.openSheet('adjust'),ad.has&&!tx.canceled,'Role can\u2019t adjust invoices'));
    actions.push(act('Issue credit',()=>this.openSheet('credit'),cr.has,'Role can\u2019t issue credits'));
    actions.push(act('Send receipt',()=>this.flash('Receipt sent to '+tx.client+' via WhatsApp + email'),true,''));
    const glyph={ pay:'$', adjust:'±', refund:'↩', credit_issue:'+', credit_apply:'◆' };
    const ledger=tx.events.map((e,i)=>{ const pend=e.type==='refund'&&e.status==='pending'; const den=e.status==='denied'; const col=e.type==='refund'?'var(--red)':(e.type==='adjust'?(e.amt<0?'var(--red)':'var(--ink)'):(e.type==='credit_issue'||e.type==='credit_apply'?'var(--amber)':'var(--accentInk)'));
      const title={ pay:e.deposit?'Deposit · '+e.method:'Payment · '+e.method, adjust:(e.amt<0?'Discount':'Surcharge')+' · '+e.reason, refund:(pend?'Refund requested':(den?'Refund denied':'Refund'))+' · '+(e.dest==='credit'?'to store credit':(e.dest==='cash'?'cash':e.method)), credit_issue:'Credit issued · '+e.reason, credit_apply:'Store credit applied' }[e.type];
      const meta=[e.t, e.by?(e.by+(e.byRole?' ('+e.byRole+')':'')):null, e.type==='refund'&&e.reason?e.reason:null, e.note, e.expiry?'Expires: '+e.expiry:null, e.approvedBy?'Approved by '+e.approvedBy:null].filter(Boolean).join(' · ');
      const ap=this.lim('refund'); const canApprove=ap.has&&ap.max>=e.amt;
      return { glyph:glyph[e.type], title, meta, amt:(e.type==='pay'||e.type==='credit_apply'?'':(e.type==='refund'?'−':(e.type==='credit_issue'?'+':'')))+this.money(Math.abs(e.amt)).replace('−',e.type==='adjust'&&e.amt<0?'−':''), amtColor:den?'var(--ink3)':col,
        dot:{ width:'30px',height:'30px',borderRadius:'9px',flex:'none',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:'14px', background:pend?'var(--amberSoft)':'var(--panel2)', border:'1px solid var(--line)', color:pend?'var(--amber)':col },
        pending:pend, approveNote:canApprove?'You can approve up to '+(ap.max===Infinity?'any amount':this.money0(ap.max))+'.':'Needs a role with a refund limit of at least '+this.money0(e.amt)+'.',
        approveStyle:{ height:'34px',padding:'0 13px',borderRadius:'9px',background:canApprove?'var(--accent)':'var(--panel3)',color:canApprove?'#fff':'var(--ink3)',fontWeight:800,fontSize:'12px' },
        approve:()=>{ if(!canApprove){ this.flash('Your role can\u2019t approve '+this.money(e.amt)); return; } this.setState(st=>({ txs:st.txs.map(t=>t.id!==tx.id?t:{ ...t, events:t.events.map((x,j)=>j===i?{ ...x, status:'done', approvedBy:'Rafael M. · '+this.roleName(s.role) }:x) }) })); this.flash('Refund approved · '+this.money(e.amt)+' to '+(e.dest==='credit'?'store credit':e.method)); },
        deny:()=>{ this.setState(st=>({ txs:st.txs.map(t=>t.id!==tx.id?t:{ ...t, events:t.events.map((x,j)=>j===i?{ ...x, status:'denied' }:x) }) })); this.flash('Refund request denied'); } }; }).reverse();
    const d={ id:tx.id, when:this.fmtDate(tx.off)+' '+tx.time, client:tx.client, vehicle:tx.vehicle, staff:tx.staff, status:c.pending.length?'Refund pending':c.status, statusStyle:c.pending.length?this.pill('Partially paid'):this.pill(c.status), big, lines, actions, ledger,
      creditLine:credit>0?tx.client.split(' ')[0]+' has '+this.money(credit)+' in store credit':'' };

    // sheet
    const f=s.f, sk=s.sheet; let sh={};
    if(sk){
      const reasonsFor={ refund:['Service issue','Customer canceled','Duplicate charge','Pricing error','Goodwill','Add-on not performed'], adjust:f.kind==='discount'?['Service recovery','Loyalty','Price match','Manager discretion']:['Extra soil surcharge','Pet hair surcharge','Oversize vehicle'], credit:['Service recovery','Referral reward','Weather closure','Goodwill','Promotion'] }[sk]||[];
      const reason=f.reason&&reasonsFor.includes(f.reason)?f.reason:reasonsFor[0];
      const amt=parseFloat(String(f.amount).replace(/[^0-9.]/g,''))||0;
      let summary=[], blocked=false, permText='', permOk=true, submitLabel='', submit=null;
      const limTxt=(l)=>l.max===Infinity?'no limit':this.money0(l.max)+' limit';
      if(sk==='refund'){
        let val=0; if(f.mode==='full') val=c.refundable; else if(f.mode==='items') val=Math.min(c.refundable,this.r2(f.items.reduce((a,i)=>a+tx.items[i].price,0)*(1+this.TAX))); else val=amt;
        const origOk=f.dest!=='card'||val<=c.toOrigMax+0.001; const over=val>rf.max;
        blocked=val<=0||val>c.refundable+0.001||!origOk;
        summary=[{ label:'Refundable', value:this.money(c.refundable), color:'var(--ink)' },{ label:'This refund', value:this.money(val), color:'var(--red)' },{ label:'Collected after', value:this.money(c.paid-c.refunded-val), color:'var(--accentInk)' }];
        if(f.dest==='credit') summary.push({ label:tx.client.split(' ')[0]+'\u2019s credit after', value:this.money(credit+val), color:'var(--amber)' });
        permText=!origOk?'Only '+this.money(c.toOrigMax)+' was paid by card \u2014 refund the rest to store credit.':(val>c.refundable+0.001?'More than the refundable amount.':(over?'Over your '+limTxt(rf)+' as '+this.roleName(s.role)+'. This will be sent for approval.':'Within your '+limTxt(rf)+' as '+this.roleName(s.role)+'.'));
        permOk=!blocked&&!over; submitLabel=over&&!blocked?'Request approval · '+this.money(val):'Refund '+this.money(val);
        const card=tx.events.find(e=>e.type==='pay'); const method=f.dest==='credit'?'Store credit':(f.dest==='cash'?'Cash':(card?card.method:'Card'));
        submit=()=>{ if(blocked) return; this.addEvent(tx.id,{ type:'refund', amt:this.r2(val), dest:f.dest, method, reason, note:f.note, byRole:this.roleName(s.role), status:over?'pending':'done' }); this.setState({ sheet:null }); this.flash(over?'Sent for approval \u00b7 '+this.money(val):'Refunded '+this.money(val)+(f.dest==='credit'?' to store credit':' to '+method)); };
        sh={ isRefund:true, title:'Refund', sub:tx.id+' \u00b7 '+tx.client, modes:[['full','Full'],['items','By item'],['custom','Custom']].map(([k,l])=>({ label:l, onClick:()=>this.setF({ mode:k }), style:this.seg(f.mode===k) })),
          byItems:f.mode==='items', byCustom:f.mode==='custom',
          itemRows:tx.items.map((it,i)=>{ const on=f.items.includes(i); return { label:it.name, value:this.money(it.price*(1+this.TAX)), on, onClick:()=>this.setF({ items:on?f.items.filter(x=>x!==i):[...f.items,i] }),
            style:{ display:'flex',alignItems:'center',gap:'11px',minHeight:'50px',padding:'0 14px',borderRadius:'12px',background:on?'var(--accentSoft)':'var(--panel)',border:'1px solid '+(on?'var(--accentBrd)':'var(--line)') },
            box:{ width:'22px',height:'22px',borderRadius:'7px',display:'flex',alignItems:'center',justifyContent:'center',flex:'none',background:on?'var(--accent)':'transparent',border:on?'none':'2px solid var(--ink3)' } }; }),
          dests:[['card','Original payment'],['credit','Store credit'],['cash','Cash']].map(([k,l])=>({ label:l, onClick:()=>this.setF({ dest:k }), style:this.seg(f.dest===k) })) };
      }
      if(sk==='adjust'){
        const pre=f.unit==='%'?this.r2(c.items*amt/100):amt; const signed=f.kind==='discount'?-pre:pre;
        const newSub=c.sub+signed, newTotal=this.r2(newSub*(1+this.TAX)+tx.tip), diff=this.r2(c.paid-c.refunded-newTotal);
        const over=pre>ad.max; blocked=pre<=0||newSub<0||over;
        summary=[{ label:'Current total', value:this.money(c.total), color:'var(--ink)' },{ label:(f.kind==='discount'?'Discount':'Surcharge')+' (pre-tax)', value:this.money(signed), color:f.kind==='discount'?'var(--red)':'var(--ink)' },{ label:'New total', value:this.money(newTotal), color:'var(--accentInk)' }];
        if(diff>0.005&&c.paid>0) summary.push({ label:'Overpaid \u2014 returned as '+(f.settle==='credit'?'store credit':'card refund'), value:this.money(diff), color:'var(--amber)' });
        if(diff<-0.005) summary.push({ label:'New balance due', value:this.money(-diff), color:'var(--red)' });
        permText=over?'Over your '+limTxt(ad)+' as '+this.roleName(s.role)+'. Ask Management or a Super Admin.':(newSub<0?'Discount is larger than the invoice.':'Within your '+limTxt(ad)+' as '+this.roleName(s.role)+'.');
        permOk=!blocked; submitLabel='Apply '+(f.kind==='discount'?'discount':'surcharge');
        const card=tx.events.find(e=>e.type==='pay');
        submit=()=>{ if(blocked) return; this.addEvent(tx.id,{ type:'adjust', amt:this.r2(signed), reason, note:f.note });
          if(diff>0.005&&c.paid>0) this.addEvent(tx.id,{ type:'refund', amt:diff, dest:f.settle==='credit'?'credit':'card', method:f.settle==='credit'?'Store credit':(card?card.method:'Card'), reason:'Adjustment settlement', status:'done' });
          this.setState({ sheet:null }); this.flash((f.kind==='discount'?'Discount':'Surcharge')+' applied \u00b7 new total '+this.money(newTotal)); };
        sh={ isAdjust:true, title:'Adjust invoice', sub:tx.id+' \u00b7 applied before tax', kinds:[['discount','Discount'],['surcharge','Surcharge']].map(([k,l])=>({ label:l, onClick:()=>this.setF({ kind:k, reason:null }), style:this.seg(f.kind===k) })),
          units:[['$','$'],['%','%']].map(([k,l])=>({ label:l, onClick:()=>this.setF({ unit:k }), style:{ ...this.seg(f.unit===k), flex:'none', width:'48px' } })), valueLabel:f.unit==='%'?'Percent of services':'Amount ($)',
          showSettle:f.kind==='discount'&&c.paid>0&&diff>0.005, settleLabel:'Invoice is already paid \u2014 return the difference as',
          settles:[['credit','Store credit'],['card','Refund to card']].map(([k,l])=>({ label:l, onClick:()=>this.setF({ settle:k }), style:this.seg(f.settle===k) })) };
      }
      if(sk==='credit'){
        const over=amt>cr.max; blocked=amt<=0||over;
        summary=[{ label:'Current credit', value:this.money(credit), color:'var(--ink)' },{ label:'Issuing', value:'+'+this.money(amt), color:'var(--amber)' },{ label:'New balance', value:this.money(credit+amt), color:'var(--accentInk)' }];
        permText=over?'Over your '+limTxt(cr)+' as '+this.roleName(s.role)+'.':'Within your '+limTxt(cr)+' as '+this.roleName(s.role)+'. Credit can be applied to any future invoice.';
        permOk=!blocked; submitLabel='Issue '+this.money(amt)+' credit';
        submit=()=>{ if(blocked) return; this.addEvent(tx.id,{ type:'credit_issue', amt:this.r2(amt), reason, note:f.note, expiry:f.expiry }); this.setState({ sheet:null }); this.flash(this.money(amt)+' credit issued to '+tx.client); };
        sh={ isCredit:true, title:'Issue account credit', sub:tx.client+' \u00b7 linked to '+tx.id, expiries:['No expiry','90 days','30 days'].map(k=>({ label:k, onClick:()=>this.setF({ expiry:k }), style:this.seg(f.expiry===k) })) };
      }
      if(sk==='collect'){
        summary=[{ label:'Balance due', value:this.money(c.balance), color:'var(--red)' }]; permText='Receipt goes out by WhatsApp and email.'; permOk=true; submitLabel='Collect '+this.money(c.balance);
        submit=()=>{ if(f.method==='Payment link'){ this.setState({ sheet:null }); this.flash('Payment link sent to '+tx.client); return; } this.addEvent(tx.id,{ type:'pay', amt:c.balance, method:f.method==='Cash'?'Cash':'Visa ••4421' }); this.setState({ sheet:null }); this.flash('Collected '+this.money(c.balance)); };
        sh={ isCollect:true, title:'Collect payment', sub:tx.id+' \u00b7 '+tx.client, payMethods:['Card on file','Cash','Payment link'].map(k=>({ label:k, onClick:()=>this.setF({ method:k }), style:this.seg(f.method===k) })) };
      }
      if(sk==='apply'){
        const use=Math.min(credit,c.balance);
        summary=[{ label:'Available credit', value:this.money(credit), color:'var(--amber)' },{ label:'Applying', value:this.money(use), color:'var(--accentInk)' },{ label:'Balance after', value:this.money(c.balance-use), color:'var(--red)' }];
        permText='Store credit is used as a payment on this invoice.'; permOk=true; submitLabel='Apply '+this.money(use);
        submit=()=>{ this.addEvent(tx.id,{ type:'credit_apply', amt:use, method:'Store credit' }); this.setState({ sheet:null }); this.flash(this.money(use)+' credit applied'); };
        sh={ title:'Apply store credit', sub:tx.client };
      }
      sh={ ...sh, summary, blocked, submit, submitLabel, hasReasons:reasonsFor.length>0, amountRaw:f.amount, note:f.note,
        setAmount:(e)=>this.setF({ amount:e.target.value }), setNote:(e)=>this.setF({ note:e.target.value }),
        reasons:reasonsFor.map(r=>({ label:r, onClick:()=>this.setF({ reason:r }), style:this.chip(reason===r) })),
        permText, permStyle:{ padding:'12px 14px',borderRadius:'12px',fontSize:'12.5px',fontWeight:700,lineHeight:1.45, background:permOk?'var(--accentSoft)':'var(--amberSoft)', color:permOk?'var(--accentInk)':'var(--amber)', border:'1px solid '+(permOk?'var(--accentBrd)':'var(--line)') },
        submitStyle:{ flex:1,height:'52px',borderRadius:'13px',fontWeight:800,fontSize:'15px', background:blocked?'var(--panel3)':(sk==='refund'?'var(--red)':'var(--accent)'), color:blocked?'var(--ink3)':'#fff' } };
    }

    return {
      theme:s.theme, toggleTheme:()=>{ const t=dark?'light':'dark'; try{ localStorage.setItem('oasis-theme',t); }catch(e){} this.setState({ theme:t }); },
      roleName:this.roleName(s.role), roleMenu:s.roleMenu, toggleRoleMenu:()=>this.setState({ roleMenu:!s.roleMenu }),
      roleOpts:s.rc.roles.map(r=>{ const l=this.lim('refund',r.id); return { name:r.name, lim:!((s.rc.perms[r.id]||{})['pay.reports'])&&!l.has?'no access':(l.has?'refunds '+(l.max===Infinity?'no limit':'≤ $'+l.max):'no refunds'), onClick:()=>this.setState({ role:r.id, roleMenu:false }),
        style:{ display:'flex',flexDirection:'column',alignItems:'flex-start',gap:'1px',width:'100%',padding:'9px 10px',borderRadius:'10px', background:s.role===r.id?'var(--accentSoft)':'transparent' } }; }),
      locked:!canView, unlocked:canView,
      ranges:[['today','Today'],['7d','7 days'],['30d','30 days'],['mtd','Month to date']].map(([k,l])=>({ label:l, onClick:()=>this.setState({ range:k }), style:{ height:'38px',padding:'0 14px',borderRadius:'10px',fontSize:'13px',fontWeight:700, background:s.range===k?'var(--accent)':'transparent', color:s.range===k?'#fff':'var(--ink2)' } })),
      rangeLabel:R[2], exportCsv:()=>this.flash('CSV export started \u00b7 '+inR.length+' invoices'),
      kpis, bars, methods, filters, rows, noRows:rows.length===0, query:s.query, onQuery:(e)=>this.setState({ query:e.target.value }),
      hasPending:allPending.length>0, pendingText:allPending.length?(allPending.length+' refund awaiting approval \u2014 '+this.money(allPending[0].e.amt)+' \u00b7 '+allPending[0].t.client+' \u00b7 requested by '+allPending[0].e.by):'',
      openPending:()=>{ const p=allPending[0]; if(p) this.setState({ selId:p.t.id, range:p.t.off>=-6?(s.range==='today'&&p.t.off<0?'7d':s.range):'30d' }); },
      d, sheetOpen:!!sk, sh, closeSheet:()=>this.setState({ sheet:null }), stop:(e)=>e.stopPropagation(),
      toast:s.toast,
    };
  }
}
