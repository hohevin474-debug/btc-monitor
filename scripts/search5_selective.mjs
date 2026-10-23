#!/usr/bin/env node
/**
 * 第五轮：极低频、极严苛入场，冲 90% 胜率（全年 1H 数据，诚实样本）
 *   F1 恐慌性反弹 capitulation：窗口内暴跌/暴涨≥thr 且放量 → 反向吃回归
 *   F2 极端偏离回归 emaDist：价格偏离 ema200 达 dpct → 回归
 *   F3 RSI(2) 极值 + HTF方向：超卖且无逆势
 *   F4 组合：F1 且为历史最大级别波动（相对ATR）
 * 退出：止盈 tpPts / 止损(窗口极值外buf 或 固定) / 最久 maxHold
 */
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2] || 'data/okx_1y_1H.json';
const MIN_N = 15;
const raw = JSON.parse(readFileSync(path, 'utf8'));
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map(c => ({ t: c.ts ?? c.t, o: +(c.open ?? c.o), h: +(c.high ?? c.h), l: +(c.low ?? c.l), c: +(c.close ?? c.c), v: +(c.volume ?? c.vol) })).filter(b => b.c > 0);
console.log(`载入 ${bars.length} 根 1H | ${new Date(bars[0].t).toISOString().slice(0,10)} → ${new Date(bars[bars.length-1].t).toISOString().slice(0,10)}`);

const closes = bars.map(b => b.c);
const ema = (arr, p) => { const out = []; const k = 2/(p+1); let prev; for (let i=0;i<arr.length;i++){ prev = i===0?arr[i]:arr[i]*k+prev*(1-k); out.push(prev);} return out; };
const sma = (arr,p)=>{const o=[];let s=0;for(let i=0;i<arr.length;i++){s+=arr[i];if(i>=p)s-=arr[i-p];o.push(i>=p-1?s/p:NaN);}return o;};
const C200 = ema(closes, 200), C48 = ema(closes, 48);
const volSma = sma(bars.map(b=>b.v), 24);
const atr = (()=>{const o=[];for(let i=1;i<bars.length;i++){const tr=Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-bars[i-1].c), Math.abs(bars[i].l-bars[i-1].c)); o.push(tr);} return [0,...o];})();
const atrSma = sma(atr, 24);
// RSI(2)
const rsi2 = (()=>{const o=[50];for(let i=1;i<closes.length;i++){const d=closes[i]-closes[i-1];let g=Math.max(0,d),l=Math.max(0,-d);for(let j=Math.max(1,i-1);j<=i;j++){const dd=closes[j]-closes[j-1];g+=Math.max(0,dd);l+=Math.max(0,-dd);}const rs=(g/2)/(l/2||1e-9);o.push(100-100/(1+rs));}return o;})();

function backtest(sigFn, { tpPts, slMode, slPts=600, buf=100, maxHold=24, be=0 }) {
  let wins=0,losses=0,scratch=0,total=0,sumPts=0,sumWin=0,sumLoss=0,big=0,gW=0,gL=0;
  for (let i=250;i<bars.length-maxHold-1;i++){
    const sig=sigFn(i); if(!sig) continue;
    const dir=sig.dir; const entry=bars[i+1].o;
    let sl = slMode==='fixed'? slPts : (dir==='L'? entry-sig.low+buf : sig.high+buf-entry);
    if (sl<300) sl=300;
    let stop = dir==='L'? entry-sl : entry+sl;
    let target = dir==='L'? entry+tpPts : entry-tpPts;
    let beTrig = be>0?(dir==='L'?entry+be:entry-be):-1/0;
    let exitPts=0,reason='';
    for(let j=i+1;j<=i+maxHold&&j<bars.length;j++){
      const hi=bars[j].h,lo=bars[j].l;
      if(be>0){ if(dir==='L'&&hi>=beTrig) stop=Math.max(stop,entry); if(dir==='S'&&lo<=beTrig) stop=Math.min(stop,entry);}
      if(dir==='L'){ if(hi>=target){exitPts=tpPts;reason='TP';break;} if(lo<=stop){exitPts=stop-entry;reason='SL';break;} }
      else { if(lo<=target){exitPts=tpPts;reason='TP';break;} if(hi>=stop){exitPts=entry-stop;reason='SL';break;} }
    }
    if(!reason){const last=bars[Math.min(i+maxHold,bars.length-1)].c; exitPts=dir==='L'?last-entry:entry-last; reason='EXP';}
    total++;
    if(exitPts>0){wins++;sumWin+=exitPts;gW+=exitPts;if(exitPts>=1000)big++;}
    else if(exitPts===0)scratch++;
    else {losses++;sumLoss+=-exitPts;gL+=-exitPts;}
    sumPts+=exitPts;
  }
  const pf = gL>0? gW/gL : (gW>0?99:0);
  return {n:total,winRate:total?wins/total*100:0,avg:total?sumPts/total:0,avgWin:wins?sumWin/wins:0,avgLoss:losses?sumLoss/losses:0,bigPct:total?big/total*100:0,pf};
}

const res=[];
const push=(tag,opt,r)=>{ if(r.n>=MIN_N) res.push({tag,...opt,...r}); };

// F1 capitulation
for(const L of [12,24,48])
 for(const thr of [3000,4000,5000,6000,8000])
  for(const vk of [1.0,1.5,2.5])       // 放量要求(0=不要求)
   for(const tpPts of [1000,1500])
    for(const maxHold of [24,48]){
      const r=backtest((i)=>{
        const a=i-L; if(a<0)return null;
        const move=closes[i]-closes[a];
        let lo=Infinity,hi=-Infinity,vs=0; for(let k=a;k<=i;k++){lo=Math.min(lo,bars[k].l);hi=Math.max(hi,bars[k].h);vs+=bars[k].v;}
        if(vk>0 && bars[i].v < vk*volSma[i]) return null;
        if(move<=-thr) return {dir:'L',low:lo,high:hi};
        if(move>=thr) return {dir:'S',low:lo,high:hi};
        return null;
      },{tpPts,slMode:'extreme',maxHold});
      push('F1-cap',{L,thr,vk,tpPts,maxHold},r);
    }

// F2 ema distance reversion
for(const dpct of [0.02,0.03,0.05,0.07])
 for(const tpPts of [1000,1500])
  for(const slPts of [500,800,1200])
   for(const maxHold of [24,48]){
     const r=backtest((i)=>{
       if(closes[i] <= C200[i]*(1-dpct)) return {dir:'L',low:bars[i].l,high:bars[i].h};
       if(closes[i] >= C200[i]*(1+dpct)) return {dir:'S',low:bars[i].l,high:bars[i].h};
       return null;
     },{tpPts,slMode:'fixed',slPts,maxHold});
     push('F2-ema',{dpct,tpPts,slPts,maxHold},r);
   }

// F3 RSI2 extreme + HTF
for(const rthr of [3,5,8])
 for(const tpPts of [1000,1500])
  for(const slPts of [500,800,1200])
   for(const maxHold of [24,48]){
     const r=backtest((i)=>{
       const up=C48[i]>C200[i]; const dn=C48[i]<C200[i];
       if(rsi2[i]<=rthr && up) return {dir:'L',low:bars[i].l,high:bars[i].h};
       if(rsi2[i]>=100-rthr && dn) return {dir:'S',low:bars[i].l,high:bars[i].h};
       return null;
     },{tpPts,slMode:'fixed',slPts,maxHold});
     push('F3-rsi2',{rthr,tpPts,slPts,maxHold},r);
   }

// F4 combo: capitulation 且相对ATR为大波动
for(const L of [12,24,48])
 for(const mult of [2.5,3.5,5])
  for(const vk of [1.0,2.0])
   for(const tpPts of [1000])
    for(const maxHold of [24,48]){
      const r=backtest((i)=>{
        const a=i-L; if(a<0)return null;
        const move=Math.abs(closes[i]-closes[a]);
        if(move < mult*atrSma[i]*Math.sqrt(L)) return null;   // 必须是大级别波动
        let lo=Infinity,hi=-Infinity; for(let k=a;k<=i;k++){lo=Math.min(lo,bars[k].l);hi=Math.max(hi,bars[k].h);}
        if(vk>0 && bars[i].v < vk*volSma[i]) return null;
        if(closes[i]<closes[a]) return {dir:'L',low:lo,high:hi};
        if(closes[i]>closes[a]) return {dir:'S',low:lo,high:hi};
        return null;
      },{tpPts,slMode:'extreme',maxHold});
      push('F4-combo',{L,mult,vk,tpPts,maxHold},r);
    }

const byWin=[...res].sort((a,b)=>b.winRate-a.winRate);
const byPf=[...res].sort((a,b)=>b.pf-a.pf);
console.log(`\n有效方案(≥${MIN_N}笔): ${res.length}`);
console.log('\n=== 胜率 TOP20 ===');
console.log('tag | n | 胜率% | 均盈利 | 均赢 | 均亏 | big1000% | PF');
for(const r of byWin.slice(0,20)) console.log(`${r.tag} | ${r.n} | ${r.winRate.toFixed(1)} | ${r.avg.toFixed(0)} | ${r.avgWin.toFixed(0)} | ${r.avgLoss.toFixed(0)} | ${r.bigPct.toFixed(1)} | ${r.pf.toFixed(2)}`);
console.log('\n=== PF TOP8 ===');
for(const r of byPf.slice(0,8)) console.log(`${r.tag} | n=${r.n} | 胜率=${r.winRate.toFixed(1)}% | 均盈利=${r.avg.toFixed(0)} | PF=${r.pf.toFixed(2)} | big=${r.bigPct.toFixed(1)}%`);
const hit=res.filter(r=>r.winRate>=85 && r.bigPct>=50);
console.log(`\n*** 达标(胜率≥85% 且 big1000%≥50): ${hit.length} 个 ***`);
for(const r of hit.slice(0,10)) console.log(JSON.stringify(r));
writeFileSync('scripts/search5_results.json', JSON.stringify({total:res.length, byWin:byWin.slice(0,30), byPf:byPf.slice(0,15)},null,0));
console.log('\n已写入 scripts/search5_results.json');
