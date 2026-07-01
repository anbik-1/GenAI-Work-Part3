# Build Instructions — AnyCompanyRead

## Prerequisites

- **Node.js**: >= 18.x
- **npm**: >= 9.x
- **AWS CLI**: Configured with valid credentials
- **AWS CDK CLI**: `npm install -g aws-cdk` (for deployment)
- **Disk Space**: ~500MB (node_modules + build artifacts)

## Environment Variables

For local development, no environment variables are required. For deployment, the CDK stack automatically configures Lambda environment variables.

For the frontend, create `packages/frontend/.env` after deployment:
```
VITE_API_URL=https://<api-gateway-id>.execute-api.<region>.amazonaws.com/prod
```

## Build Steps

### 1. Install Dependencies

```bash
cd anycompanyread
npm install
```

This installs dependencies for all workspaces (shared, backend, frontend, infrastructure).

### 2. Build Shared Package (First — other packages depend on it)

```bash
npm run build:shared
```

**Expected Output**: No errors. Generates `packages/shared/dist/` with compiled types.

### 3. Build Backend

```bash
npm run build:backend
```

**Expected Output**: No errors. Generates `packages/backend/dist/` with compiled Lambda handlers.

### 4. Build Frontend

```bash
npm run build:frontend
```

**Expected Output**: Vite build output showing bundle sizes. Generates `packages/frontend/dist/` with optimized static files.

### 5. Build All (shortcut)

```bash
npm run build
```

Builds all packages in workspace order.

### 6. Verify Build Success

- `packages/shared/dist/` — compiled types and constants
- `packages/backend/dist/` — compiled Lambda handler JS files
- `packages/frontend/dist/` — optimized HTML/JS/CSS bundle
- No TypeScript compilation errors

## Deployment

### 1. Bootstrap CDK (first time only)

```bash
cd packages/infrastructure
npx cdk bootstrap
```

### 2. Deploy

```bash
npx cdk deploy
```

Or from root:
```bash
npm run deploy
```

### 3. Note Outputs

After deployment, CDK outputs:
- `ApiUrl` — API Gateway endpoint (use for `VITE_API_URL`)
- `UserPoolId` — Cognito User Pool ID
- `UserPoolClientId` — Cognito Client ID
- `CloudFrontUrl` — Frontend URL
- `FrontendBucketName` — For frontend deployment
- `ImagesBucketName` — For book cover images

### 4. Deploy Frontend to S3

```bash
aws s3 sync packages/frontend/dist/ s3://<FrontendBucketName>/ --delete
```

### 5. Seed Database

```bash
npx ts-node scripts/seed-data.ts
```

## Troubleshooting

### `Cannot find module '@anycompanyread/shared'`
- **Cause**: Shared package not built before dependent packages
- **Solution**: Run `npm run build:shared` first, then rebuild other packages

### CDK deployment fails with "Resource already exists"
- **Cause**: Previous partial deployment left resources
- **Solution**: Run `npx cdk destroy` then redeploy, or manually remove conflicting resources

### Frontend shows CORS errors
- **Cause**: API Gateway CORS not matching frontend origin
- **Solution**: Verify the CDK stack has `defaultCorsPreflightOptions` configured (it does by default)

### Lambda returns 500 errors
- **Cause**: Missing environment variables or permission issues
- **Solution**: Check CloudWatch Logs for the specific Lambda function. Verify IAM permissions in CDK stack.
