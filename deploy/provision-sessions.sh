#!/usr/bin/env bash
#
# One-time provisioning for session persistence (DynamoDB + task-role perms).
# Run this in YOUR terminal (the agent cannot create IAM/DDB by policy):
#
#   eval $(isengardcli credentials 196099039286 --eval)
#   bash deploy/provision-sessions.sh
#
set -euo pipefail
R=ap-northeast-1
TABLE=nova-sonic-sessions
ROLE=nova-sonic-task-role

echo "==> DynamoDB table $TABLE (PK userId, SK sessionId, on-demand)"
if aws dynamodb describe-table --table-name "$TABLE" --region "$R" >/dev/null 2>&1; then
  echo "   (table already exists)"
else
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=userId,AttributeType=S AttributeName=sessionId,AttributeType=S \
    --key-schema AttributeName=userId,KeyType=HASH AttributeName=sessionId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "$R" >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$R"
  echo "   created"
fi

echo "==> Grant $ROLE DynamoDB access (inline policy scoped to the table)"
ACCT=$(aws sts get-caller-identity --query Account --output text)
cat > /tmp/nova-ddb-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query"
    ],
    "Resource": "arn:aws:dynamodb:${R}:${ACCT}:table/${TABLE}"
  }]
}
EOF
aws iam put-role-policy --role-name "$ROLE" --policy-name nova-sonic-ddb \
  --policy-document file:///tmp/nova-ddb-policy.json
echo "   policy attached"

echo "DONE. Now tell the agent to redeploy the relay (rebuild image + update ECS)."
