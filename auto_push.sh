#!/bin/bash
# 自动重试推送：沙箱到 GitHub 的连接被外部策略拦截时挂起，
# 网络恢复后自动把本地 commit 推送到 origin/main 触发部署。
#
# 用法: bash auto_push.sh [最大等待分钟数]
# 日志: /tmp/auto_push.log

MAX_MIN=${1:-180}          # 默认最多等 3 小时
INTERVAL=120               # 每 2 分钟探测一次
REPO=/workspace/btc-cloudflare
LOG=/tmp/auto_push.log

echo "[$(date '+%F %T')] 自动推送任务启动，最长等待 ${MAX_MIN} 分钟" | tee -a $LOG

END=$(( $(date +%s) + MAX_MIN * 60 ))
ATTEMPT=0

while [ $(date +%s) -lt $END ]; do
  ATTEMPT=$((ATTEMPT + 1))

  # 探测 GitHub 连通性
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://api.github.com" 2>/dev/null)

  if [ "$CODE" != "000" ]; then
    echo "[$(date '+%F %T')] ✅ 网络恢复 (HTTP=$CODE)，尝试推送..." | tee -a $LOG
    cd "$REPO" || exit 1

    # 推送，最多重试 5 次（应对间歇性 TLS 失败）
    for try in 1 2 3 4 5; do
      OUT=$(git push origin main 2>&1)
      if echo "$OUT" | grep -q "main -> main\|Everything up-to-date"; then
        echo "[$(date '+%F %T')] ✅ 推送成功（第 $try 次尝试）" | tee -a $LOG
        echo "$OUT" | tail -3 | tee -a $LOG
        echo "[$(date '+%F %T')] 等待 GitHub Actions 部署..." | tee -a $LOG
        sleep 90
        # 检查部署结果
        RID=$(gh api repos/hohevin474-debug/btc-monitor/actions/runs --jq '.workflow_runs[0].id' 2>/dev/null)
        if [ -n "$RID" ]; then
          gh api repos/hohevin474-debug/btc-monitor/actions/runs/$RID \
            -q "\"[$(date '+%F %T')] 部署结果: status=\(.status) conclusion=\(.conclusion // \"running\")\"" 2>/dev/null | tee -a $LOG
        fi
        echo "[$(date '+%F %T')] 🎉 任务完成" | tee -a $LOG
        exit 0
      fi
      echo "[$(date '+%F %T')] 第 $try 次推送失败，重试..." | tee -a $LOG
      sleep 5
    done
    echo "[$(date '+%F %T')] ❌ 推送持续失败，继续等待" | tee -a $LOG
  else
    echo "[$(date '+%F %T')] 第 $ATTEMPT 次探测: 网络未恢复 (HTTP=$CODE)" >> $LOG
  fi

  sleep $INTERVAL
done

echo "[$(date '+%F %T')] ⏰ 已达最长等待时间 ${MAX_MIN} 分钟，任务结束" | tee -a $LOG
exit 1
