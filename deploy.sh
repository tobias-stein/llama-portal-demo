#!/bin/bash
set -e

# --- SCRIPT ARGUMENTS ---
# Arg 1: The tenant name for AWS resources (optional, defaults to "TenantA")
# Arg 2: Your GitHub account/organization name (required)
# Arg 3: Your GitHub repository name (required)

# Enforce the AWS region for all commands in this script
export AWS_DEFAULT_REGION="eu-central-1"

# --- ARGUMENT PARSING & VALIDATION ---
TENANT_NAME="${1:-TenantA}"
GITHUB_ACCOUNT_NAME="$2"
GITHUB_REPO_NAME="$3"

# Check if required arguments are provided
if [ -z "$GITHUB_ACCOUNT_NAME" ] || [ -z "$GITHUB_REPO_NAME" ]; then
    echo "❌ ERROR: Missing required arguments."
    echo "Usage: ./deploy.sh [TenantName] <GitHubAccountName> <GitHubRepoName>"
    echo "Example: ./deploy.sh TenantA tobias-stein llama-portal-demo"
    exit 1
fi

# --- DYNAMICALLY CONSTRUCT URLS ---
GIT_REPO_URL="https://github.com/${GITHUB_ACCOUNT_NAME}/${GITHUB_REPO_NAME}.git"
GITHUB_PAGES_URL="https://${GITHUB_ACCOUNT_NAME}.github.io/${GITHUB_REPO_NAME}/"
STACK_NAME="${TENANT_NAME}-BookingStack"

echo "=================================================="
echo "🏢 Target Tenant:     $TENANT_NAME"
echo "👤 GitHub Account:    $GITHUB_ACCOUNT_NAME"
echo "📘 GitHub Repo:       $GITHUB_REPO_NAME"
echo "🌍 Target AWS Region: $AWS_DEFAULT_REGION"
echo "🌐 Publishing to:     $GITHUB_PAGES_URL"
echo "=================================================="


echo "🚀 Deploying Infrastructure (CloudFormation)..."
aws cloudformation deploy \
  --template-file aws-cloudformation-template.yaml \
  --stack-name $STACK_NAME \
  --parameter-overrides TenantName=$TENANT_NAME \
  --capabilities CAPABILITY_NAMED_IAM

echo "📦 Zipping and injecting local Lambda code directly (Skipping S3)..."
FUNCTIONS=(
  "manage-bookings|aws/lambda/manage-bookings.py"
  "booking-request|aws/lambda/booking-request.py"
  "define-auth-challenge|aws/lambda/define-auth-challenge.mjs"
  "create-auth-challenge|aws/lambda/create-auth-challenge.mjs"
  "verify-invitation-code|aws/lambda/verify-invitation-code.mjs"
  "generate-invitation-code|aws/lambda/generate-invitation-code.mjs"
  "manage-rooms|aws/lambda/manage-rooms.mjs"
  "move-allocations|aws/lambda/move-allocations.py"
)

for FUNC in "${FUNCTIONS[@]}"; do
    SUFFIX="${FUNC%%|*}"
    FILEPATH="${FUNC##*|}"
    if test -f "$FILEPATH"; then
        echo "Updating Lambda: ${TENANT_NAME}-${SUFFIX}..."
        zip -q -j temp.zip "$FILEPATH"
        aws lambda update-function-code \
            --function-name "${TENANT_NAME}-${SUFFIX}" \
            --zip-file fileb://temp.zip > /dev/null
        rm -f temp.zip
    else
        echo "⚠️  Skipping ${TENANT_NAME}-${SUFFIX}: $FILEPATH not found locally."
    fi
done

echo "=================================================="
echo "⚙️  Extracting Stack Outputs & Generating Config..."
echo "=================================================="
# Extract specific values directly using the AWS CLI --query tool
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='CognitoClientId'].OutputValue" --output text)
IDENTITY_POOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='CognitoIdentityPoolId'].OutputValue" --output text)
TABLE_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='DynamoTableName'].OutputValue" --output text)

echo "=================================================="
echo "👤 Activating Admin and Guest user accounts..."
echo "=================================================="

# Generate a compliant random password (e.g., 12 random chars + aB1!)
# This ensures it meets default Cognito policies (upper, lower, num, symbol)
ADMIN_TEMP_PASSWORD="$(date +%s%N | sha256sum | base64 | head -c 12)aB1!"

# Set a TEMPORARY password for the admin user by OMITTING the --permanent flag.
# This puts the user in the FORCE_CHANGE_PASSWORD state.
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username "admin" \
  --password "$ADMIN_TEMP_PASSWORD"

# ---

# Generate a very long, compliant random password for the guest.
GUEST_RANDOM_PASSWORD="$(date +%s%N | sha256sum | base64 | head -c 48)aB1!"

# Set a PERMANENT password for the guest user to bypass the FORCE_CHANGE_PASSWORD state.
# This is required for the Custom Auth/Invitation code flow to work.
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username "guest" \
  --password "$GUEST_RANDOM_PASSWORD" \
  --permanent

echo "✅ Guest user account confirmed with a secure random password."
echo "--------------------------------------------------"
echo "🔑 Your Admin temporary password is:"
echo "   $ADMIN_TEMP_PASSWORD"
echo "   You will be required to change it on first login."
echo "--------------------------------------------------"

# Write the config file dynamically
mkdir -p src
cat <<EOF > src/config.js
window.AppConfig = {
    REGION: '${AWS_DEFAULT_REGION}',
    USER_POOL_ID: '${USER_POOL_ID}',
    CLIENT_ID: '${CLIENT_ID}',
    IDENTITY_POOL_ID: '${IDENTITY_POOL_ID}',
    HOST_URL: '${GITHUB_PAGES_URL}',
    ROLES: {
        ADMIN: 'admin',
        GUEST: 'guest'
    },
    LAMBDAS: {
        BOOKING_REQUEST: '${TENANT_NAME}-booking-request',
        MANAGE_BOOKINGS: '${TENANT_NAME}-manage-bookings',
        GENERATE_INVITATION_CODE: '${TENANT_NAME}-generate-invitation-code',
        MANAGE_ROOMS: '${TENANT_NAME}-manage-rooms',
        MOVE_ALLOCATIONS: '${TENANT_NAME}-move-allocations'
    },
    DB: {
        TABLE_NAME: '${TABLE_NAME}',
    }
};
EOF
echo "✅ src/config.js generated successfully!"

echo "🛠️  Building Static Frontend (Webpack)..."
npm install
npm run build

echo "🚀 Pushing built website to GitHub Pages..."
# Navigate into the build output directory
cd dist

# Create a temporary, isolated Git repository
git init -b gh-pages
git add .
git commit -m "Deploy website for tenant: $TENANT_NAME"

git push -f "$GIT_REPO_URL" HEAD:gh-pages

# Clean up by leaving the dist directory
cd ..

echo "=================================================="
echo "🎉 SUCCESS! Your site will be live in a minute."
echo "URL: $GITHUB_PAGES_URL"
echo "--------------------------------------------------"
echo "🔑 Your Admin temporary password is:"
echo "   $ADMIN_TEMP_PASSWORD"
echo "   (You will be required to change it on first login)"
echo "=================================================="