# ML 方向分类 + 同口径回放：检验 ML 信号能否超越 V1（均值回归）。
# 特征在 Python 内从 1H K 线现算；风险控制和 V1 完全一致（止盈0.9%/止损ATR/6h），
# 故差异只来自"入场信号质量"。样本外用时间有序切分 + walk-forward。
import json, numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.metrics import accuracy_score, roc_auc_score

DATA = '/workspace/btc-cloudflare/data/okx_60d.json'
raw = json.load(open(DATA))
bars = [{'t':b['t'],'o':b['o'],'h':b['h'],'l':b['l'],'c':b['c'],'v':b['vol']} for b in raw]
N = len(bars)
closes = np.array([b['c'] for b in bars])

# ---------------- 指标 ----------------
def sma(a,n):
    if len(a)<n: return a[-1]
    return a[-n:].mean()
def rsi(p, n=14):
    p=np.array(p); d=np.diff(p)
    if len(d)<n: return 50.0
    g=d[-n:].clip(min=0).sum()/n; l=-d[-n:].clip(max=0).sum()/n
    return 100.0 if l==0 else 100-100/(1+g/l)
def atr(bars_i, n=14):
    tr=[]
    for i in range(len(bars_i)-n, len(bars_i)):
        h=bars_i[i]['h']; l=bars_i[i]['l']; pc=bars_i[i-1]['c']
        tr.append(max(h-l, abs(h-pc), abs(l-pc)))
    return np.mean(tr)
def adx(bars_i, n=14):
    up=[]; dn=[]; tr=[]
    for i in range(1,len(bars_i)):
        h=bars_i[i]['h']; l=bars_i[i]['l']; pc=bars_i[i-1]['c']; ph=bars_i[i-1]['h']; pl=bars_i[i-1]['l']
        tr.append(max(h-l,abs(h-pc),abs(l-pc)))
        up.append(max(h-ph,0)); dn.append(max(pl-l,0))
    def rma(a):
        a=np.array(a); out=np.full(len(a),np.nan); 
        if len(a)<n: return 0.0
        prev=a[:n].mean(); out[n-1]=prev
        for i in range(n,len(a)): prev=(prev*(n-1)+a[i])/n; out[i]=prev
        return out
    atrS=rma(tr); pS=rma(up); nS=rma(dn)
    dx=[]
    for i in range(n-1,len(tr)):
        if not atrS[i] or not np.isfinite(atrS[i]): continue
        pdi=100*pS[i]/atrS[i]; ndi=100*nS[i]/atrS[i]; den=pdi+ndi
        dx.append(100*abs(pdi-ndi)/den if den>0 else 0)
    if len(dx)<n: return 0.0
    a=np.array(dx); ad=0.0
    for i in range(n): ad+=a[i]; ad/=n
    for i in range(n,len(a)): ad=(ad*(n-1)+a[i])/n
    return ad
def bb(p, n=20):
    p=np.array(p); recent=p[-n:]; m=recent.mean(); sd=recent.std()
    return m+2*sd, m, m-2*sd, (4*sd/m*100 if m>0 else 4)

WARM=120
H=12   # 标签前瞻窗口（根）= 12h
feat=[]; lab=[]; idxs=[]
for i in range(WARM, N-H):
    win=bars[:i+1]; c=closes[:i+1]
    r=rsi(c,14); a=atr(win,14); ap=(a/closes[i])*100; ax=adx(win,14)
    mom6=(closes[i]-closes[i-6])/closes[i-6]*100
    mom24=(closes[i]-closes[i-24])/closes[i-24]*100
    ma10=sma(c,10); ma40=sma(c,40); slope=(ma10-ma40)/ma40*100
    volNow=sma(np.array([b['v'] for b in win[-12:]]),12)
    volPrev=sma(np.array([b['v'] for b in win[-24:-12]]),12)
    vr=volNow/volPrev if volPrev>0 else 1.0
    ub,mb,lb,bbw=bb(c,20); bbpos=(closes[i]-lb)/(ub-lb) if ub>lb else 0.5
    ret6=(closes[i]-closes[i-6])/closes[i-6]
    fut=closes[i+H]-closes[i]
    feat.append([r,ap,ax,mom6,mom24,slope,vr,bbw,bbpos,ret6, ap*0.1])
    lab.append(1 if fut>0 else 0)
    idxs.append(i)
X=np.array(feat); y=np.array(lab)
print(f"样本: {len(y)}  涨标签占比 {y.mean():.1%}  特征 {X.shape[1]}维")

# ---------------- 时间有序切分 ----------------
cut=int(len(y)*0.7)
Xtr,Xte,ytr,yte = X[:cut],X[cut:],y[:cut],y[cut:]
print(f"\n=== 测试集({len(yte)}样本, 涨占比{yte.mean():.1%}) 方向准确率 ===")
models={
 'LogReg': LogisticRegression(max_iter=1000, class_weight='balanced'),
 'RandForest': RandomForestClassifier(n_estimators=200, max_depth=6, min_samples_leaf=20, class_weight='balanced', random_state=0),
 'GBM': GradientBoostingClassifier(n_estimators=200, max_depth=2, learning_rate=0.05, subsample=0.8, random_state=0),
}
res={}
for name,m in models.items():
    m.fit(Xtr,ytr); p=m.predict(Xte); proba=m.predict_proba(Xte)[:,1]
    acc=accuracy_score(yte,p); auc=roc_auc_score(yte,proba)
    res[name]=(acc,auc)
    print(f"  {name:10s} 准确率 {acc:.1%}  AUC {auc:.3f}")

# ---------------- walk-forward（更严格，防偷看）----------------
print("\n=== Walk-forward（滑窗训练→下一步预测，无未来信息）===")
def walkforward(model_factory, step=200):
    preds=[]; trues=[]
    # 样本索引 k ↔ bar 索引 WARM+k
    for sk in range(50, len(y)-H, step):
        lo=max(0, sk-900)
        Xi=X[lo:sk]; yi=y[lo:sk]
        if len(yi)<100: continue
        m=model_factory(); m.fit(Xi,yi)
        for jk in range(sk, min(sk+step, len(y)-H)):
            pp=m.predict_proba(X[jk:jk+1])[:,1]
            preds.append(pp[0]); trues.append(y[jk])
    preds=np.array(preds); trues=np.array(trues)
    acc=(preds>0.5).astype(int)==trues
    return acc.mean(), roc_auc_score(trues,preds), preds, trues
for name,fac in [('LogReg',lambda:LogisticRegression(max_iter=1000,class_weight='balanced')),
                 ('RandForest',lambda:RandomForestClassifier(n_estimators=200,max_depth=6,min_samples_leaf=20,class_weight='balanced',random_state=0)),
                 ('GBM',lambda:GradientBoostingClassifier(n_estimators=200,max_depth=2,learning_rate=0.05,subsample=0.8,random_state=0))]:
    acc,auc,_,_=walkforward(fac)
    print(f"  {name:10s} WF准确率 {acc:.1%}  AUC {auc:.3f}")

# ---------------- ML 策略同口径回放 ----------------
# 用全样本 walk-forward 概率序列驱动交易：p(up)>=thr → LONG，p(down)=1-p>=thr → SHORT
print("\n=== ML 策略回放（风险=V1: TP0.9%/止损ATR/6h）===")
# 重算全样本概率（walk-forward，样本索引 k ↔ bar WARM+k）
proba_all=np.full(N,np.nan)
for sk in range(50, len(y)-H, 100):
    lo=max(0, sk-900)
    Xi=X[lo:sk]; yi=y[lo:sk]
    if len(yi)<100: continue
    m=GradientBoostingClassifier(n_estimators=200,max_depth=2,learning_rate=0.05,subsample=0.8,random_state=0)
    m.fit(Xi,yi)
    for jk in range(sk, min(sk+100, len(y)-H)):
        proba_all[WARM+jk]=m.predict_proba(X[jk:jk+1])[:,1][0]

def backtest_ml(thr, tp=0.9, hold_h=6):
    trades=[]; pos=None; total_pnl=0; wins=0; maxloss=0
    for i in range(WARM, N):
        bar=bars[i]; t=bar['t']/1000; c=bar['c']
        # 管理
        if pos:
            isLong=pos['dir']=='LONG'; hi=bar['h']; lo=bar['l']; cl=bar['c']
            # 用 ATR 算 stop（V1 式）
            exit_px=None; kind=None
            tp_px=pos['tp']
            if isLong and hi>=tp_px: exit_px,kind=tp_px,'止盈'
            elif (not isLong) and lo<=tp_px: exit_px,kind=tp_px,'止盈'
            if exit_px is None:
                if isLong and lo<=pos['stop']: exit_px,kind=max(lo,pos['stop']),'止损'
                elif (not isLong) and hi>=pos['stop']: exit_px,kind=min(hi,pos['stop']),'止损'
            held=t-pos['entryT']
            if exit_px is None and held>=hold_h*3600: exit_px,kind=cl,'到期'
            if exit_px is not None:
                pnl=round(exit_px-pos['entry']) if isLong else round(pos['entry']-exit_px)
                trades.append(pnl); total_pnl+=pnl; wins+=pnl>0; maxloss=min(maxloss,pnl)
                pos=None
        # 开仓
        if pos is None and i<N-H:
            p=proba_all[i]
            if np.isnan(p): continue
            pup=p; pdn=1-p
            if pup>=thr:
                dirn='LONG'
            elif pdn>=thr:
                dirn='SHORT'
            else:
                continue
            isLong=dirn=='LONG'
            ap = (atr(bars[:i+1],14)/c)*100
            stopPct=min(0.9,max(0.4,ap*1.0))
            stop=c*(1-stopPct/100) if isLong else c*(1+stopPct/100)
            tpp=c*(1+tp/100) if isLong else c*(1-tp/100)
            pos={'dir':dirn,'entry':c,'entryT':t,'stop':stop,'tp':tpp}
    n=len(trades)
    if n==0: return None
    wr=wins/n; gross_win=sum(x for x in trades if x>0); gross_loss=abs(sum(x for x in trades if x<=0))
    pf=gross_win/gross_loss if gross_loss>0 else (float('inf') if gross_win>0 else 0)
    return dict(n=n,wr=wr,total=total_pnl,pf=pf,maxloss=maxloss)

for thr in [0.55,0.60,0.65,0.70]:
    r=backtest_ml(thr)
    if r: print(f"  ML GBM thr={thr}: n={r['n']} 胜率{r['wr']:.0%} 总{r['total']} PF{r['pf']:.2f} 最大亏{r['maxloss']}")
# V1 基准（同口径，用 V1 规则信号重跑）放在 node 结果：V1 tp0.9 = +7610 PF1.26
print("\n  [基准] V1 优配(同风险) 全样本: n=161 胜率41% 总+7610 PF1.26 最大亏-346 (来自 node 回放)")
