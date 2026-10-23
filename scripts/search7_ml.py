#!/usr/bin/env python3
"""第七轮：机器学习范式（全量8840根1H walk-forward）
直接学习「未来24h内能否吃到1000点(在-800止损前)」，多空双模型。
特征含技术面 + 时段 + 波动率状态机；并测试高置信度子集的实盘胜率。
目标：能否出现 胜率>=90% 且 n>=15 的信号子集。
"""
import json, numpy as np, pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score

RAW = json.load(open('/workspace/btc-cloudflare/data/okx_1y_1H.json'))
C = RAW['candles'] if isinstance(RAW, dict) else RAW
bars = [{'t':b['ts'] if 'ts' in b else b['t'], 'o':float(b.get('open',b.get('o'))),
         'h':float(b.get('high',b.get('h'))), 'l':float(b.get('low',b.get('l'))),
         'c':float(b.get('close',b.get('c'))), 'v':float(b.get('vol',b.get('volume')))} for b in C]
N = len(bars)
print(f'载入 {N} 根 1H')

close = np.array([b['c'] for b in bars])
high = np.array([b['h'] for b in bars])
low  = np.array([b['l'] for b in bars])
vol  = np.array([b['v'] for b in bars])
tss  = np.array([b['t'] for b in bars])

# ---- 指标 ----
def sma(a,n):
    out=np.full(len(a),np.nan); s=0.0
    for i in range(len(a)):
        s+=a[i]
        if i>=n: s-=a[i-n]
        out[i]= s/n if i>=n-1 else np.nan
    return out
def ema(a,n):
    out=np.empty(len(a)); k=2/(n+1); p=a[0]
    for i in range(len(a)):
        p = a[i] if i==0 else a[i]*k+p*(1-k)
        out[i]=p
    return out
def rsi(a,n=14):
    d=np.diff(a); out=np.full(len(a),50.0)
    if len(d)<n: return out
    g=np.maximum(d[:n],0.0).mean(); l=np.maximum(-d[:n],0.0).mean()
    for i in range(n,len(d)):
        cd=max(d[i],0.0); cl=-min(d[i],0.0)
        g=(g*(n-1)+cd)/n; l=(l*(n-1)+cl)/n
        rs=g/(l+1e-9); out[i+1]=100-100/(1+rs)
    out[:n+1]=out[n+1]
    return out
def atr(h,l,c,n=14):
    tr=np.zeros(len(c))
    for i in range(1,len(c)):
        tr[i]=max(h[i]-l[i], abs(h[i]-c[i-1]), abs(l[i]-c[i-1]))
    out=np.full(len(c),np.nan); s=0.0
    for i in range(1,len(c)):
        s+=tr[i]
        if i>=n: s-=tr[i-n]
        out[i]= s/n if i>=n else np.nan
    return out

ema20=ema(close,20); ema50=ema(close,50); ema200=ema(close,200)
rsi2=rsi(close,2); rsi14=rsi(close,14)
ATR=atr(high,low,close,14); atrR=ATR/close
volS=sma(vol,24); volR=vol/volS
bb_mid=sma(close,20); bb_std=np.array([np.nanstd(close[max(0,i-19):i+1]) for i in range(len(close))])
bb_pos=(close-bb_mid)/(bb_std*2+1e-9)
ret1=np.concatenate([[0],np.diff(close)/close[:-1]])
ret3=sma(ret1*100,3); ret8=sma(ret1*100,8)
hour=(tss//3600000)%24
dow=(tss//86400000)%7

# ---- 标签：未来24h内，LONG是否在 -800 止损前吃到 +1000；SHORT对称 ----
TP=1000.0; SL=800.0; H=24
y_long=np.zeros(N); y_short=np.zeros(N)
for i in range(N-H-1):
    e=close[i+1]
    lwin=low[i+1:i+1+H]; hwin=high[i+1:i+1+H]
    # long win: 先触 +TP
    hit_tp=False; hit_sl=False
    for j in range(H):
        if hwin[j]-e>=TP: hit_tp=True; break
        if e-low[i+1+j]<= -SL: hit_sl=True; break
    y_long[i]=1 if hit_tp and not hit_sl else 0
    hit_tp=False; hit_sl=False
    for j in range(H):
        if e-hwin[j]<= -TP: hit_tp=True; break
        if high[i+1+j]-e<= -SL: hit_sl=True; break
    y_short[i]=1 if hit_tp and not hit_sl else 0

# ---- 特征矩阵（bar i 用 i 及之前信息）----
X=np.vstack([
    close/ema20-1, close/ema50-1, close/ema200-1,
    rsi2/100-0.5, rsi14/100-0.5, bb_pos,
    atrR*100, volR, ret3, ret8,
    (high-low)/close*100,
    np.roll(hour,0)/23-0.5, dow/6-0.5,
]).T
X=np.nan_to_num(X,0.0)
# 对齐标签：特征用i，标签用i（已基于i+1开盘）
feat_idx=np.arange(250, N-H-1)
Xf=X[feat_idx]; yl=y_long[feat_idx]; ys=y_short[feat_idx]

split=int(len(feat_idx)*0.6)
Xtr,Xte=Xf[:split],Xf[split:]; yltr,ylte=yl[:split],yl[split:]; ystr,yste=ys[:split],ys[split:]

def evaluate(name, clf, Xtr,ytr, Xte,yte, side):
    clf.fit(Xtr,ytr)
    pa=accuracy_score(yte, clf.predict(Xte)); auc=roc_auc_score(yte, clf.predict_proba(Xte)[:,1])
    proba=clf.predict_proba(Xte)[:,1]
    print(f'\n[{name}/{side}] 训练{np.mean(ytr):.2f} 测试acc={pa:.3f} AUC={auc:.3f}')
    # 在不同阈值取高置信交易，统计实盘胜率(=标签本身即胜率定义)
    rows=[]
    for thr in [0.5,0.6,0.7,0.8,0.9]:
        m=proba>=thr
        if m.sum()>=10:
            wr=yte[m].mean()
            rows.append((thr,int(m.sum()),round(wr*100,1)))
            if wr>=0.9 and m.sum()>=15:
                print(f'   >>> 达标! thr={thr} n={m.sum()} 胜率={wr*100:.1f}%')
    print('   阈值扫描:', rows)
    return auc

print('=== LONG 模型（预测未来24h做多能否吃1000点）===')
evaluate('GBM', GradientBoostingClassifier(n_estimators=200,max_depth=3,subsample=0.8,random_state=0), Xtr,yltr,Xte,ylte,'LONG')
evaluate('RF',  RandomForestClassifier(n_estimators=300,max_depth=8,random_state=0,n_jobs=-1), Xtr,yltr,Xte,ylte,'LONG')
evaluate('LR',  LogisticRegression(max_iter=1000), Xtr,yltr,Xte,ylte,'LONG')
print('\n=== SHORT 模型 ===')
evaluate('GBM', GradientBoostingClassifier(n_estimators=200,max_depth=3,subsample=0.8,random_state=0), Xtr,ystr,Xte,yste,'SHORT')
evaluate('RF',  RandomForestClassifier(n_estimators=300,max_depth=8,random_state=0,n_jobs=-1), Xtr,ystr,Xte,yste,'SHORT')

# ---- 组合：取 max(p_long,p_short) 方向，高置信才交易 ----
gb_l=GradientBoostingClassifier(n_estimators=200,max_depth=3,subsample=0.8,random_state=0).fit(Xtr,yltr)
gb_s=GradientBoostingClassifier(n_estimators=200,max_depth=3,subsample=0.8,random_state=0).fit(Xtr,ystr)
pl=gb_l.predict_proba(Xte)[:,1]; ps=gb_s.predict_proba(Xte)[:,1]
take=np.maximum(pl,ps); side=np.where(pl>=ps,'L','S')
print('\n=== 组合(取较高置信方向)阈值扫描 ===')
for thr in [0.5,0.6,0.7,0.8,0.85,0.9,0.95]:
    m=take>=thr
    if m.sum()>=5:
        # 实际标签：取对应方向
        actual=np.where(side[m]=='L', ylte[m], yste[m])
        print(f'  thr={thr} n={int(m.sum())} 胜率={actual.mean()*100:.1f}%')
