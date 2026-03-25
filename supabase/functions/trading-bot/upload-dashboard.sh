#!/bin/bash
SERVICE_ROLE_KEY="$1"
if [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "Usage: bash upload-dashboard.sh <SERVICE_ROLE_KEY>"
  echo "Get key at: https://supabase.com/dashboard/project/rwfbleacxufaojkztxbj/settings/api"
  exit 1
fi
echo "Deleting old file..."
curl -s -X DELETE "https://rwfbleacxufaojkztxbj.supabase.co/storage/v1/object/dashboard/dashboard.html" -H "Authorization: Bearer $SERVICE_ROLE_KEY"
echo ""
echo "Uploading dashboard.html..."
curl -s -X POST "https://rwfbleacxufaojkztxbj.supabase.co/storage/v1/object/dashboard/dashboard.html" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: text/html" --data-binary @dashboard.html
echo ""
echo "Done! https://rwfbleacxufaojkztxbj.supabase.co/storage/v1/object/public/dashboard/dashboard.html"
