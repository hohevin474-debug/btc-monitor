#!/usr/bin/env node
/**
 * 第六轮：真实多周期（4H 定结构/方向，1H 执行，持仓≤24h）
 *   M1 4H趋势+1H回踩均线
 *   M2 4H RSI极值+1H确认
 *   M3 4H区间突破后1H回踩突破位
 *   M4 4H趋势+1H首根反向锤子
 * 退出：止盈 tpPts / 固定止损 slPts / 最久 24h
 */
import { readFileSync, writeFileSync } from 'node:fs';
const p1 = process.argv[2] || 'data/okx_1y_1H.json';
const p4 = process.argv[3] || 'data/okx_2y_4H.json';
const MIN_N = 15;

const r1 = JSON.parse(readFileSync(p1,'utf8')); const C1 = Array.isArray(r1)?r1:r1.candles;
const bars = C1.map(c=>({t:c.ts??c.t,o:+(c.open??c.o),h:+(c.high??c.h),l:+(c.low??c.l),c:+(c.close??c.c),v:+(c.volume??c.vol)})).filter(b=>b.c>0);
const r4 = JSON.parse(readFileSync(p4,'utf8')); const C4 = r4.candles;
const H4 = 4*3600*1000;
const bucket = ts => Math.floor(ts / H4) * H4;
// 4H 索引映射（按 ts 二分）
const c4 = C4.map(x=>({ts:x.ts,o:+x.open,h:+x.high,l:+x.low,c:+x.close,v:+x.volume}));
const fourIdx = new Map(); c4.forEach((x,k)=>fourIdx.set(x.ts,k));
const closes1 = bars.map(b=>b.c);
const ema=(a,p)=>{const o=[];const k=2/(p+1);let pr;for(let i=0;i<a.length;i++){pr=i===0?a[i]:a[i]*k+pr*(1-k);o.push(pr);}return o;};
const sma=(a,p)=>{const o=[];let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];o.push(i>=p-1?s/p:NaN);}return o;};
const closes4 = c4.map(x=>x.c);
const e20_4=ema(closes4,20), e50_4=ema(closes4,50);
const e20_1=ema(closes1,20), e50_1=ema(closes1,50);
// 4H RSI14
const rsi4=(()=>{const o=[50];for(let i=1;i<closes4.length;i++){const d=closes4[i]-closes4[i-1];let g=Math.max(0,d),l=Math.max(0,-d);for(let j=Math.max(1,i-13);j<=i;j++){const dd=closes4[j]-closes4[j-1];g+=Math.max(0,dd);l+=Math.max(0,-dd);}const rs=(g/14)/(l/14||1e-9);o.push(100-100/(1+rs));}return o;})();
// 4H 30根区间
const hi30_4=[], lo30_4=[];
for(let i=0;i<c4.length;i++){let mx=-Infinity,mn=Infinity;for(let k=Math.max(0,i-29);k<=i;k++){mx=Math.max(mx,c4[k].h);mn=Math.min(mn,c4[k].l);}hi30_4.push(mx);lo30_4.push(mn);}
// 1H -> 4H idx
function fIdx(i){ const b=bucket(bars[i].t); let k=fourIdx.get(b); if(k==null){ // 找最近的
  let lo=0,hi=c4.length-1; while(lo<hi){const m=(lo+hi)>>1; if(c4[m].ts<b) lo=m+1; else hi=m;} k=lo-1; if(k<0)k=0;} return k; }

function backtest(sigFn,{tpPts,slPts,maxHold=24}){
  let wins=0,losses=0,scratch=0,total=0,sumPts=0,sumWin=0,sumLoss=0,big=0,gW=0,gL=0;
  for(let i=300;i<bars.length-maxHold-1;i++){
    const sig=sigFn(i); if(!sig)continue;
    const dir=sig.dir; const entry=bars[i+1].o;
    let stop=dir==='L'?entry-slPts:entry+slPts;
    let target=dir==='L'?entry+tpPts:entry-tpPts;
    let exitPts=0,reason='';
    for(let j=i+1;j<=i+maxHold&&j<bars.length;j++){
      const hi=bars[j].h,lo=bars[j].l;
      if(dir==='L'){if(hi>=target){exitPts=tpPts;reason='TP';break;}if(lo<=stop){exitPts=stop-entry;reason='SL';break;}}
      else{if(lo<=target){exitPts=tpPts;reason='TP';break;}if(hi>=stop){exitPts=entry-stop;reason='SL';break;}}
    }
    if(!reason){const last=bars[Math.min(i+maxHold,bars.length-1)].c;exitPts=dir==='L'?last-entry:entry-last;reason='EXP';}
    total++;
    if(exitPts>0){wins++;sumWin+=exitPts;gW+=exitPts;if(exitPts>=1000)big++;}
    else if(exitPts===0)scratch++;
    else{losses++;sumLoss+=-exitPts;gL+=-exitPts;}
    sumPts+=exitPts;
  }
  const pf=gL>0?gW/gL:(gW>0?99:0);
  return {n:total,winRate:total?wins/total*100:0,avg:total?sumPts/total:0,avgWin:wins?sumWin/wins:0,avgLoss:losses?sumLoss/losses:0,bigPct:total?big/total*100:0,pf};
}
const res=[]; const push=(tag,opt,r)=>{if(r.n>=MIN_N)res.push({tag,...opt,...r});};

// M1 4H趋势 + 1H回踩
for(const tp of [1000,1500]) for(const sl of [500,700,1000]) for(const mh of [24,48]){
  push('M1',{tp,sl,mh},backtest((i)=>{
    const k=fIdx(i); if(k<50)return null;
    const up=e20_4[k]>e50_4[k] && closes4[k]>e20_4[k];
    const dn=e20_4[k]<e50_4[k] && closes4[k]<e20_4[k];
    const pull1=bars[i].c<e20_1[i];
    if(up&&pull1)return{dir:'L'}; if(dn&&!pull1)return{dir:'S'}; return null;
  },{tpPts:tp,slPts:sl,maxHold:mh}));
}
// M2 4H RSI极值 + 1H同向
for(const rt of [25,30,35]) for(const tp of [1000,1500]) for(const sl of [500,800]){
  push('M2',{rt,tp,sl},backtest((i)=>{
    const k=fIdx(i); if(k<50)return null;
    const up=e20_4[k]>e50_4[k], dn=e20_4[k]<e50_4[k];
    if(up&&rsi4[k]<=rt&&bars[i].c<e20_1[i])return{dir:'L'};
    if(dn&&rsi4[k]>=100-rt&&bars[i].c>e20_1[i])return{dir:'S'};
    return null;
  },{tpPts:tp,slPts:sl,maxHold:24}));
}
// M3 4H区间突破后 1H回踩突破位
for(const tp of [1000,1500]) for(const sl of [500,800]){
  push('M3',{tp,sl},backtest((i)=>{
    const k=fIdx(i); if(k<30)return null;
    const hi=hi30_4[k],lo=lo30_4[k];
    // 突破发生在最近几根4H
    const brokeUp = closes4[k]>hi && c4[k].h>=hi;
    const brokeDn = closes4[k]<lo && c4[k].l<=lo;
    if(brokeUp && bars[i].c<=hi && bars[i].c>=hi*0.997)return{dir:'L'};
    if(brokeDn && bars[i].c>=lo && bars[i].c<=lo*1.003)return{dir:'S'};
    return null;
  },{tpPts:tp,slPts:sl,maxHold:24}));
}
// M4 4H趋势 + 1H 长下影锤子(做多)/长上影(做空)
for(const tp of [1000,1500]) for(const sl of [500,800]){
  push('M4',{tp,sl},backtest((i)=>{
    const k=fIdx(i); if(k<50)return null;
    const up=e20_4[k]>e50_4[k], dn=e20_4[k]<e50_4[k];
    const b=bars[i]; const body=Math.abs(b.c-b.o); const upShad=b.h-Math.max(b.o,b.c); const dnShad=Math.min(b.o,b.c)-b.l;
    if(up&&dnShad>2*body&&dnShad>300)return{dir:'L'};
    if(dn&&upShad>2*body&&upShad>300)return{dir:'S'};
    return null;
  },{tpPts:tp,slPts:sl,maxHold:24}));
}

const byWin=[...res].sort((a,b)=>b.winRate-a.winRate);
const byPf=[...res].sort((a,b)=>b.pf-a.pf);
console.log(`有效方案(≥${MIN_N}笔): ${res.length}`);
console.log('\n=== 胜率 TOP15 ===');
console.log('tag | n | 胜率% | 均盈利 | 均赢 | 均亏 | big1000% | PF');
for(const r of byWin.slice(0,15)) console.log(`${r.tag} | ${r.n} | ${r.winRate.toFixed(1)} | ${r.avg.toFixed(0)} | ${r.avgWin.toFixed(0)} | ${r.avgLoss.toFixed(0)} | ${r.bigPct.toFixed(1)} | ${r.pf.toFixed(2)}`);
console.log('\n=== PF TOP6 ===');
for(const r of byPf.slice(0,6)) console.log(`${r.tag} n=${r.n} 胜率=${r.winRate.toFixed(1)}% 均盈利=${r.avg.toFixed(0)} PF=${r.pf.toFixed(2)} big=${r.bigPct.toFixed(1)}%`);
const hit=res.filter(r=>r.winRate>=85&&r.bigPct>=50);
console.log(`\n*** 达标(≥85% 且 big≥50): ${hit.length} ***`);
writeFileSync('scripts/search6_results.json',JSON.stringify({total:res.length,byWin:byWin.slice(0,25),byPf:byPf.slice(0,12)},null,0));
console.log('已写 scripts/search6_results.json');
