#!/usr/bin/env node
/** 第八轮：结构性新方法（规则/ML之外）
 *  A 波动率压缩突破：ATR处于低位(压缩)后价格突破近期区间 → 期待扩张到1000
 *  B 会话时段：特定UTC小时(00/04/08/12/16/20)触发信号才交易
 *  C 连涨/连跌衰竭反转：连续K根同向后反向(均值回归)
 *  D 波动率状态机门控：仅在高波动后转低波动(扩张→收缩)状态交易fade
 * 退出：TP=1000 / SL / 最久24h
 */
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2] || 'data/okx_1y_1H.json';
const MIN_N = 12;
const raw = JSON.parse(readFileSync(path,'utf8'));
const C = Array.isArray(raw)?raw:raw.candles;
const bars = C.map(c=>({t:c.ts??c.t,o:+(c.open??c.o),h:+(c.high??c.h),l:+(c.low??c.l),c:+(c.close??c.c),v:+(c.volume??c.vol)})).filter(b=>b.c>0);
const closes=bars.map(b=>b.c), highs=bars.map(b=>b.h), lows=bars.map(b=>b.l), vols=bars.map(b=>b.v);
const ema=(a,p)=>{const o=[];const k=2/(p+1);let pr;for(let i=0;i<a.length;i++){pr=i===0?a[i]:a[i]*k+pr*(1-k);o.push(pr);}return o;};
const sma=(a,p)=>{const o=[];let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];o.push(i>=p-1?s/p:NaN);}return o;};
const e20=ema(closes,20), e50=ema(closes,50);
const atr=[]; for(let i=1;i<bars.length;i++){atr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));} atr.unshift(0);
const atrS=sma(atr,24);
const volS=sma(vols,24);
const hour=bars.map(b=>Math.floor(b.t/3600000)%24);
function pctRank(arr,i,win){const v=arr[i];let c=0,n=0;for(let k=Math.max(0,i-win);k<i;k++){n++;if(arr[k]<=v)c++;}return n?c/n:0.5;}
function backtest(sigFn,{tpPts,slPts,maxHold=24}){
  let wins=0,losses=0,total=0,sumPts=0,sumWin=0,sumLoss=0,big=0,gW=0,gL=0;
  for(let i=260;i<bars.length-maxHold-1;i++){
    const sig=sigFn(i); if(!sig)continue;
    const dir=sig.dir; const entry=bars[i+1].o;
    let stop=dir==='L'?entry-slPts:entry+slPts; let target=dir==='L'?entry+tpPts:entry-tpPts; let ep=0,reason='';
    for(let j=i+1;j<=i+maxHold&&j<bars.length;j++){
      const hi=highs[j],lo=lows[j];
      if(dir==='L'){if(hi>=target){ep=tpPts;reason='TP';break;}if(lo<=stop){ep=stop-entry;reason='SL';break;}}
      else{if(lo<=target){ep=tpPts;reason='TP';break;}if(hi>=stop){ep=entry-stop;reason='SL';break;}}
    }
    if(!reason){const last=bars[Math.min(i+maxHold,bars.length-1)].c;ep=dir==='L'?last-entry:entry-last;reason='EXP';}
    total++; if(ep>0){wins++;sumWin+=ep;gW+=ep;if(ep>=1000)big++;} else if(ep<0){losses++;sumLoss+=-ep;gL+=-ep;} sumPts+=ep;
  }
  const pf=gL>0?gW/gL:(gW>0?99:0);
  return {n:total,winRate:total?wins/total*100:0,avg:total?sumPts/total:0,avgWin:wins?sumWin/wins:0,avgLoss:losses?sumLoss/losses:0,bigPct:total?big/total*100:0,pf};
}
const res=[]; const push=(tag,opt,r)=>{if(r.n>=MIN_N)res.push({tag,...opt,...r});};

// A 波动率压缩突破
for(const compr of [0.15,0.25,0.35])
 for(const N of [12,24,48])
  for(const tp of [1000,1500])
   for(const sl of [500,800])
    for(const mh of [24,48]){
      push('A-volcmp',{compr,N,tp,sl,mh},backtest((i)=>{
        const r=pctRank(atrS,i,120); if(r>compr)return null; // 压缩状态
        let mx=-Infinity,mn=Infinity; for(let k=i-N;k<i;k++){mx=Math.max(mx,highs[k]);mn=Math.min(mn,lows[k]);}
        if(closes[i]>mx)return{dir:'L'}; if(closes[i]<mn)return{dir:'S'}; return null;
      },{tpPts:tp,slPts:sl,maxHold:mh}));
    }

// B 会话时段
for(const sess of [[0],[0,8],[0,12,16],[8,12,16,20]])
 for(const tp of [1000,1500])
  for(const sl of [500,800])
   for(const mh of [24]){
     push('B-session',{sess:sess.join(','),tp,sl,mh},backtest((i)=>{
       if(!sess.includes(hour[i]))return null;
       // 信号：价格偏离ema20
       if(closes[i]<e20[i]*0.995)return{dir:'L'}; if(closes[i]>e20[i]*1.005)return{dir:'S'}; return null;
     },{tpPts:tp,slPts:sl,maxHold:mh}));
   }

// C 连涨/连跌衰竭反转
for(const run of [4,5,6,8])
 for(const tp of [1000,1500])
  for(const sl of [500,800])
   for(const mh of [24]){
     push('C-exhaust',{run,tp,sl,mh},backtest((i)=>{
       let up=0,dn=0; for(let k=i-run+1;k<=i;k++){if(closes[k]>closes[k-1])up++;else if(closes[k]<closes[k-1])dn++;}
       if(up>=run)return{dir:'S'}; if(dn>=run)return{dir:'L'}; return null;
     },{tpPts:tp,slPts:sl,maxHold:mh}));
   }

// D 波动率状态机：高波动后转低波动 → fade极端
for(const hiPct of [0.8,0.9])
 for(const loPct of [0.2,0.3])
  for(const tp of [1000])
   for(const sl of [500,800])
    for(const mh of [24,48]){
      push('D-vstate',{hiPct,loPct,tp,sl,mh},backtest((i)=>{
        const rNow=pctRank(atrS,i,120), rPrev=pctRank(atrS,i-12,120);
        if(!(rPrev>=hiPct && rNow<=loPct))return null; // 扩张→收缩
        let lo2=Infinity,hi2=-Infinity,vs=0; for(let k=i-24;k<=i;k++){lo2=Math.min(lo2,lows[k]);hi2=Math.max(hi2,highs[k]);vs+=vols[k];}
        if(closes[i]<e20[i])return{dir:'L'}; if(closes[i]>e20[i])return{dir:'S'}; return null;
      },{tpPts:tp,slPts:sl,maxHold:mh}));
    }

const byWin=[...res].sort((a,b)=>b.winRate-a.winRate);
const byPf=[...res].sort((a,b)=>b.pf-a.pf);
console.log(`有效方案(≥${MIN_N}笔): ${res.length}`);
console.log('\n=== 胜率 TOP18 ===');
console.log('tag | n | 胜率% | 均盈利 | 均赢 | 均亏 | big% | PF');
for(const r of byWin.slice(0,18)) console.log(`${r.tag} | ${r.n} | ${r.winRate.toFixed(1)} | ${r.avg.toFixed(0)} | ${r.avgWin.toFixed(0)} | ${r.avgLoss.toFixed(0)} | ${r.bigPct.toFixed(1)} | ${r.pf.toFixed(2)}`);
console.log('\n=== PF TOP6 ===');
for(const r of byPf.slice(0,6)) console.log(`${r.tag} n=${r.n} 胜率=${r.winRate.toFixed(1)}% 均盈利=${r.avg.toFixed(0)} PF=${r.pf.toFixed(2)} big=${r.bigPct.toFixed(1)}%`);
const hit=res.filter(r=>r.winRate>=85&&r.bigPct>=50);
console.log(`\n*** 达标(≥85% 且 big≥50): ${hit.length} ***`);
writeFileSync('scripts/search8_results.json',JSON.stringify({total:res.length,byWin:byWin.slice(0,25),byPf:byPf.slice(0,10)},null,0));
console.log('已写 scripts/search8_results.json');
