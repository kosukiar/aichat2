#!/usr/bin/env bash
#
# Nova Sonic relay server — ECS Fargate deploy (idempotent)
# ---------------------------------------------------------
# Restores the relay compute that was deleted, running it on Fargate behind the
# EXISTING ALB (nova-sonic-alb) / ACM cert / Route53 record. No OS to patch.
#
# Prereqs (already done):
#   - ECR image pushed:  196099039286.dkr.ecr.ap-northeast-1.amazonaws.com/nova-sonic-relay:latest
#   - IAM task role:     nova-sonic-task-role  (AmazonBedrockFullAccess)
#   - IAM exec role:     ecsTaskExecutionRole  (pre-existing)
#
# Usage:
#   eval $(isengardcli credentials 196099039286 --eval)
#   bash deploy/fargate-deploy.sh
#
set -euo pipefail

R=ap-northeast-1
ACC=196099039286
VPC=vpc-06fb761e2ea84c5f5
ALB_NAME=nova-sonic-alb
ALB_SG=sg-0c5596792f2833c21
SUBNET=subnet-04580437cc232424b      # public (routes to IGW), ap-northeast-1a
CLUSTER=nova-sonic-cluster
SERVICE=nova-sonic-svc
FAMILY=nova-sonic-relay
IMAGE=$ACC.dkr.ecr.$R.amazonaws.com/nova-sonic-relay:latest
DOMAIN=api.kosukiar.people.aws.dev

echo "==> 1/8 CloudWatch log group"
aws logs create-log-group --log-group-name /ecs/nova-sonic-relay --region $R 2>/dev/null || true
aws logs put-retention-policy --log-group-name /ecs/nova-sonic-relay --retention-in-days 7 --region $R

echo "==> 2/8 IP target group"
TG_ARN=$(aws elbv2 describe-target-groups --names nova-sonic-tg-ip --region $R \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "${TG_ARN:-}" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN=$(aws elbv2 create-target-group --name nova-sonic-tg-ip --protocol HTTP --port 3001 \
    --vpc-id $VPC --target-type ip --health-check-path /health --health-check-protocol HTTP \
    --matcher HttpCode=200 --region $R --query 'TargetGroups[0].TargetGroupArn' --output text)
fi
echo "    TG_ARN=$TG_ARN"

echo "==> 3/8 Service security group"
SG_ID=$(aws ec2 describe-security-groups \
  --filters Name=group-name,Values=nova-sonic-svc-sg Name=vpc-id,Values=$VPC \
  --region $R --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "${SG_ID:-}" ] || [ "$SG_ID" = "None" ]; then
  SG_ID=$(aws ec2 create-security-group --group-name nova-sonic-svc-sg \
    --description "Nova Sonic Fargate service - allow 3001 from ALB" \
    --vpc-id $VPC --region $R --query 'GroupId' --output text)
  aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 3001 \
    --source-group $ALB_SG --region $R >/dev/null
fi
echo "    SG_ID=$SG_ID"

echo "==> 4/8 Task definition"
cat > /tmp/nova-taskdef.json <<EOF
{
  "family": "$FAMILY",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::$ACC:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::$ACC:role/nova-sonic-task-role",
  "containerDefinitions": [
    {
      "name": "nova-sonic-relay",
      "image": "$IMAGE",
      "essential": true,
      "portMappings": [{"containerPort": 3001, "protocol": "tcp"}],
      "environment": [
        {"name": "PORT", "value": "3001"},
        {"name": "AWS_REGION", "value": "$R"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/nova-sonic-relay",
          "awslogs-region": "$R",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
EOF
TD_ARN=$(aws ecs register-task-definition --cli-input-json file:///tmp/nova-taskdef.json \
  --region $R --query 'taskDefinition.taskDefinitionArn' --output text)
echo "    TD_ARN=$TD_ARN"

echo "==> 5/8 ECS cluster"
aws ecs describe-clusters --clusters $CLUSTER --region $R \
  --query 'clusters[?status==`ACTIVE`]' --output text | grep -q . || \
  aws ecs create-cluster --cluster-name $CLUSTER --region $R >/dev/null
echo "    cluster=$CLUSTER"

echo "==> 6/8 Point ALB HTTPS:443 listener at the IP target group"
LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$(aws elbv2 describe-load-balancers --names $ALB_NAME --region $R --query 'LoadBalancers[0].LoadBalancerArn' --output text)" \
  --region $R --query 'Listeners[?Port==`443`].ListenerArn' --output text)
aws elbv2 modify-listener --listener-arn "$LISTENER_ARN" \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN --region $R >/dev/null
echo "    listener=$LISTENER_ARN -> $TG_ARN"

echo "==> 7/8 ECS service (create or update)"
if aws ecs describe-services --cluster $CLUSTER --services $SERVICE --region $R \
     --query 'services[?status==`ACTIVE`]' --output text | grep -q .; then
  aws ecs update-service --cluster $CLUSTER --service $SERVICE \
    --task-definition $FAMILY --force-new-deployment --region $R >/dev/null
  echo "    updated existing service"
else
  aws ecs create-service --cluster $CLUSTER --service-name $SERVICE \
    --task-definition $FAMILY --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
    --load-balancers "targetGroupArn=$TG_ARN,containerName=nova-sonic-relay,containerPort=3001" \
    --health-check-grace-period-seconds 60 --region $R >/dev/null
  echo "    created service"
fi

echo "==> 8/8 Waiting for service to stabilize (this can take a few minutes)..."
aws ecs wait services-stable --cluster $CLUSTER --services $SERVICE --region $R
echo "    service stable"

echo "==> Target health:"
aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region $R \
  --query 'TargetHealthDescriptions[].{id:Target.Id,state:TargetHealth.State}' --output table || true

echo "==> Endpoint check: https://$DOMAIN/health"
sleep 5
curl -fsS "https://$DOMAIN/health" && echo || echo "(health check not 200 yet; give the target ~30s and retry)"

echo
echo "DONE. Relay endpoint: wss://$DOMAIN   (health: https://$DOMAIN/health)"
