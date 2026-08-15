#!/usr/bin/env bash
#
# Nova Sonic relay — teardown / stop costs
# ----------------------------------------
# Scales the service to 0 (stops Fargate billing) or fully deletes it.
#
#   eval $(isengardcli credentials 196099039286 --eval)
#   bash deploy/teardown.sh stop     # scale to 0 tasks (keep definition) — default
#   bash deploy/teardown.sh delete   # delete service + cluster
#
set -euo pipefail
R=ap-northeast-1
CLUSTER=nova-sonic-cluster
SERVICE=nova-sonic-svc
MODE="${1:-stop}"

case "$MODE" in
  stop)
    aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0 --region $R >/dev/null
    echo "Scaled $SERVICE to 0 tasks. Fargate compute billing stopped."
    echo "Restart with: aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 1 --region $R"
    ;;
  delete)
    aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0 --region $R >/dev/null || true
    aws ecs delete-service --cluster $CLUSTER --service $SERVICE --force --region $R >/dev/null || true
    aws ecs delete-cluster --cluster $CLUSTER --region $R >/dev/null || true
    echo "Deleted service and cluster. (ALB / cert / DNS left intact.)"
    ;;
  *)
    echo "usage: $0 [stop|delete]"; exit 1 ;;
esac
