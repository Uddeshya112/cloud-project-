# ☁️ Vapour — AWS Free Tier Setup Guide

> **Goal:** Deploy the Vapour weather dashboard as a live, cloud-backed web app using
> Amazon S3 (static hosting), Amazon DynamoDB (search history), and Amazon Cognito
> (browser-safe authentication) — all within the AWS Free Tier.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Step 1 — Create the DynamoDB Table](#3-step-1--create-the-dynamodb-table)
4. [Step 2 — Create the Cognito Identity Pool](#4-step-2--create-the-cognito-identity-pool)
5. [Step 3 — Attach the IAM Policy to the Cognito Role](#5-step-3--attach-the-iam-policy-to-the-cognito-role)
6. [Step 4 — Get Your OpenWeatherMap API Key](#6-step-4--get-your-openweathermap-api-key)
7. [Step 5 — Update `config.js`](#7-step-5--update-configjs)
8. [Step 6 — Host on Amazon S3](#8-step-6--host-on-amazon-s3)
9. [Step 7 — (Optional) Custom Domain via CloudFront](#9-step-7--optional-custom-domain-via-cloudfront)
10. [IAM Policy JSON Reference](#10-iam-policy-json-reference)
11. [Free Tier Limits Cheat-Sheet](#11-free-tier-limits-cheat-sheet)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites

| Requirement | Details |
|---|---|
| AWS Account | Free at [aws.amazon.com](https://aws.amazon.com) — credit card required but not charged within free tier |
| OpenWeatherMap account | Free at [openweathermap.org](https://openweathermap.org) — free tier gives 60 calls/min |
| AWS Console access | Sign in at [console.aws.amazon.com](https://console.aws.amazon.com) |
| AWS CLI (optional) | For the CLI shortcut commands shown below |

> [!IMPORTANT]
> All AWS services used here are covered by the **AWS Free Tier** for 12 months
> after account creation. Stay inside the limits in [Section 11](#11-free-tier-limits-cheat-sheet)
> to avoid charges.

---

## 2. Architecture Overview

```
  Browser (Vapour App)
       │
       ├─── HTTPS GET ──────────────────► OpenWeatherMap API
       │                                  (live weather data)
       │
       ├─── Cognito Identity Pool ──────► AWS STS
       │    (unauthenticated role)         (temporary credentials, no secret keys in browser)
       │
       └─── DynamoDB SDK calls ─────────► VapourSearchHistory table
            (PutItem / Scan / BatchDelete)  (search history persistence)

  Amazon S3 (Static Website Hosting)
       └─── serves index.html, style.css, config.js, app.js
```

**Why Cognito Identity Pool?**  
DynamoDB calls from a browser require AWS credentials. A Cognito Identity Pool
issues **short-lived temporary credentials** via AWS STS — no long-lived access keys
ever touch your browser or source code.

---

## 3. Step 1 — Create the DynamoDB Table

### Via AWS Console

1. Open the [DynamoDB console](https://console.aws.amazon.com/dynamodb).
2. Click **Create table**.
3. Fill in:

   | Field | Value |
   |---|---|
   | **Table name** | `VapourSearchHistory` |
   | **Partition key** | `city` &nbsp;→ type **String** |
   | **Sort key** | *(leave blank)* |
   | **Table settings** | On-demand (pay-per-request) — cheapest for low traffic |

4. Click **Create table** and wait ~30 seconds for the status to show **Active**.

### Via AWS CLI

```bash
aws dynamodb create-table \
  --table-name VapourSearchHistory \
  --attribute-definitions AttributeName=city,AttributeType=S \
  --key-schema AttributeName=city,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-south-1
```

> [!TIP]
> Replace `ap-south-1` with the region closest to your users.
> Good choices: `us-east-1` (N. Virginia), `eu-west-1` (Ireland), `ap-south-1` (Mumbai).

---

## 4. Step 2 — Create the Cognito Identity Pool

The Identity Pool gives the browser **temporary** AWS credentials tied to an IAM role.

### Via AWS Console

1. Open the [Amazon Cognito console](https://console.aws.amazon.com/cognito).
2. Click **Identity pools** → **Create identity pool**.
3. Fill in:

   | Field | Value |
   |---|---|
   | **Identity pool name** | `VapourWeatherPool` |
   | **Unauthenticated identities** | ✅ Enable access to unauthenticated identities |

4. Click **Next**.
5. On the **Configure permissions** screen, AWS automatically creates two IAM roles:
   - `Cognito_VapourWeatherPoolUnauth_Role`
   - `Cognito_VapourWeatherPoolAuth_Role`

   Leave the defaults and click **Create pool**.

6. On the confirmation page, copy your **Identity pool ID** — it looks like:
   ```
   ap-south-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
   You will paste this into `config.js`.

### Via AWS CLI

```bash
# 1. Create the pool
aws cognito-identity create-identity-pool \
  --identity-pool-name VapourWeatherPool \
  --allow-unauthenticated-identities \
  --region ap-south-1

# The output includes "IdentityPoolId" — save it.

# 2. Get the auto-created IAM role ARN
aws iam list-roles --query "Roles[?contains(RoleName,'VapourWeather')].[RoleName,Arn]"
```

---

## 5. Step 3 — Attach the IAM Policy to the Cognito Role

The unauthenticated Cognito role needs permission to call DynamoDB.

### Via AWS Console

1. Open the [IAM console](https://console.aws.amazon.com/iam).
2. Click **Roles** → search for `Cognito_VapourWeatherPoolUnauth_Role` → click it.
3. Click **Add permissions** → **Create inline policy**.
4. Switch to the **JSON** tab and paste the policy below.
5. Name it `VapourDynamoDBAccess` → click **Create policy**.

### Inline IAM Policy JSON

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VapourDynamoDBReadWrite",
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": "arn:aws:dynamodb:YOUR_REGION:YOUR_ACCOUNT_ID:table/VapourSearchHistory"
    }
  ]
}
```

> [!IMPORTANT]
> Replace `YOUR_REGION` (e.g. `ap-south-1`) and `YOUR_ACCOUNT_ID` (12-digit number
> visible at the top-right of the AWS console) before saving.

### Via AWS CLI

```bash
# Save the policy to a local file first
cat > /tmp/vapour-dynamodb-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VapourDynamoDBReadWrite",
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": "arn:aws:dynamodb:YOUR_REGION:YOUR_ACCOUNT_ID:table/VapourSearchHistory"
    }
  ]
}
EOF

# Attach to the role (replace the role name with your actual generated name)
aws iam put-role-policy \
  --role-name Cognito_VapourWeatherPoolUnauth_Role \
  --policy-name VapourDynamoDBAccess \
  --policy-document file:///tmp/vapour-dynamodb-policy.json
```

### Verify permissions (optional)

```bash
aws iam get-role-policy \
  --role-name Cognito_VapourWeatherPoolUnauth_Role \
  --policy-name VapourDynamoDBAccess
```

---

## 6. Step 4 — Get Your OpenWeatherMap API Key

1. Sign up at [openweathermap.org/api](https://openweathermap.org/api).
2. Go to your account → **My API keys** → copy the default key (or generate a new one).
3. Free tier limit: **60 calls/minute**, **1,000,000 calls/month**.

> [!WARNING]
> New API keys take up to **10 minutes** to activate after creation.
> You will get a 401 error during this window — just wait and retry.

---

## 7. Step 5 — Update `config.js`

Open `config.js` and replace all four placeholder values:

```js
const VapourConfig = Object.freeze({

  // ── Replace with your real key from openweathermap.org ───────
  OPENWEATHER_API_KEY: "YOUR_OPENWEATHER_API_KEY",

  // ── Replace with your table's AWS region ─────────────────────
  AWS_REGION: "ap-south-1",

  // ── Replace with your Cognito Identity Pool ID ───────────────
  AWS_COGNITO_IDENTITY_POOL_ID: "ap-south-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",

  // ── Must match the table name you created in DynamoDB ────────
  DYNAMODB_TABLE_NAME: "VapourSearchHistory",

  // ... (leave all other fields unchanged)
});
```

> [!CAUTION]
> **Never commit your real API keys to a public Git repository.**
> For a production app, inject them via environment variables or AWS Secrets Manager.
> The OpenWeatherMap key is for a public API (low risk), but the Cognito pool ID
> should stay out of public repos to prevent unexpected usage charges.

### Quick test before deploying

Open `index.html` directly in your browser (or via a local dev server):

```bash
# Using Python (any OS)
cd "d:\New Projects\vapour-weather-app"
python -m http.server 8080
# Then open http://localhost:8080
```

Search for "London" — if the weather panel populates and the sidebar badge shows
**"AWS DynamoDB"** (not "Local Storage"), your cloud integration is working.

---

## 8. Step 6 — Host on Amazon S3

Amazon S3 hosts static files (HTML/CSS/JS) with a public URL at no cost within the free tier.

### 8a. Create the S3 Bucket

```bash
# Replace YOUR_BUCKET_NAME with a globally unique name, e.g. vapour-weather-yourinitials
aws s3api create-bucket \
  --bucket YOUR_BUCKET_NAME \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1
```

> [!NOTE]
> Bucket names must be globally unique across all AWS accounts.
> Good pattern: `vapour-weather-<your-name>-<random-digits>`

### 8b. Enable Static Website Hosting

```bash
aws s3 website s3://YOUR_BUCKET_NAME/ \
  --index-document index.html \
  --error-document index.html
```

### 8c. Set the Bucket Policy (Public Read)

Create a file `bucket-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/*"
    }
  ]
}
```

Apply it:

```bash
# First, disable the "Block Public Access" setting (required for public websites)
aws s3api put-public-access-block \
  --bucket YOUR_BUCKET_NAME \
  --public-access-block-configuration \
    "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

# Then attach the policy
aws s3api put-bucket-policy \
  --bucket YOUR_BUCKET_NAME \
  --policy file://bucket-policy.json
```

### 8d. Add CORS Configuration (required for DynamoDB calls)

Create `cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

```bash
aws s3api put-bucket-cors \
  --bucket YOUR_BUCKET_NAME \
  --cors-configuration file://cors.json
```

### 8e. Upload the App Files

```bash
cd "d:\New Projects\vapour-weather-app"

aws s3 sync . s3://YOUR_BUCKET_NAME/ \
  --exclude "*.md" \
  --exclude "*.json" \
  --exclude ".git/*" \
  --cache-control "max-age=300"
```

### 8f. Get Your Website URL

```bash
aws s3api get-bucket-website --bucket YOUR_BUCKET_NAME
```

Your site will be live at:
```
http://YOUR_BUCKET_NAME.s3-website.ap-south-1.amazonaws.com
```

> [!TIP]
> Bookmark this URL — it's your live Vapour dashboard. Any time you update a file,
> re-run the `aws s3 sync` command in Step 8e to redeploy.

---

## 9. Step 7 — (Optional) Custom Domain via CloudFront

CloudFront adds HTTPS, a CDN edge cache, and lets you attach a custom domain.

```bash
# Create a CloudFront distribution pointing at your S3 website endpoint
aws cloudfront create-distribution \
  --origin-domain-name YOUR_BUCKET_NAME.s3-website.ap-south-1.amazonaws.com \
  --default-root-object index.html \
  --query "Distribution.DomainName" \
  --output text
```

The output will be a `*.cloudfront.net` URL served over **HTTPS** — share this as
your Vapour dashboard link.

> [!NOTE]
> CloudFront is included in the AWS Free Tier (1 TB data transfer / month for
> 12 months). After 12 months it costs ~$0.0085/GB — negligible for a weather app.

---

## 10. IAM Policy JSON Reference

### A. DynamoDB Access (attached to the Cognito Unauth Role)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VapourDynamoDBReadWrite",
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": "arn:aws:dynamodb:YOUR_REGION:YOUR_ACCOUNT_ID:table/VapourSearchHistory"
    }
  ]
}
```

### B. S3 Bucket Public Read (attached to the bucket itself)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/*"
    }
  ]
}
```

### C. CI/CD Deployment Role (optional — for GitHub Actions or similar)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VapourS3Deploy",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::YOUR_BUCKET_NAME",
        "arn:aws:s3:::YOUR_BUCKET_NAME/*"
      ]
    },
    {
      "Sid": "VapourCloudfrontInvalidate",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateInvalidation"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## 11. Free Tier Limits Cheat-Sheet

| Service | Free Tier Allowance | Vapour Typical Usage |
|---|---|---|
| **DynamoDB** | 25 GB storage · 25 WCU · 25 RCU (always free) | < 1 MB · < 10 ops/day |
| **Cognito Identity Pool** | 50,000 MAUs (always free) | 1–10 users |
| **S3 Standard** | 5 GB storage · 20,000 GET · 2,000 PUT / month (12 months) | < 10 MB · < 100 ops |
| **CloudFront** | 1 TB data transfer · 10,000,000 HTTPS requests / month (12 months) | < 100 MB / month |
| **OpenWeatherMap** | 60 calls/min · 1,000,000 calls/month | < 500 calls/day |

> [!CAUTION]
> DynamoDB's 25 WCU / 25 RCU free tier is **always free** (not 12-month limited),
> but only applies to **provisioned capacity** tables. The guide uses **on-demand**
> billing, which has **no free tier** after the first 12 months.
> To stay permanently free: after 12 months, switch the table to
> **Provisioned** mode (25 WCU / 25 RCU) in the DynamoDB console.

---

## 12. Troubleshooting

### ❌ DynamoDB: `NotAuthorizedException`

**Cause:** The IAM policy on the Cognito unauth role is missing or incorrect.

**Fix:**
1. Verify the role exists: IAM → Roles → search `Cognito_VapourWeather`.
2. Click the role → **Permissions** → ensure `VapourDynamoDBAccess` is listed.
3. Confirm the ARN in the policy matches your actual table ARN:
   ```bash
   aws dynamodb describe-table --table-name VapourSearchHistory \
     --query "Table.TableArn" --output text
   ```
4. Paste that exact ARN into the `Resource` field of the policy.

---

### ❌ DynamoDB: `ResourceNotFoundException`

**Cause:** The table name in `config.js` doesn't match the DynamoDB table.

**Fix:** Ensure `DYNAMODB_TABLE_NAME` in `config.js` is exactly `VapourSearchHistory`
(case-sensitive). Confirm the table exists:
```bash
aws dynamodb list-tables --region YOUR_REGION
```

---

### ❌ OpenWeatherMap: `401 Unauthorized`

**Cause:** API key is invalid or not yet activated (can take up to 10 minutes).

**Fix:** Wait 10 minutes after key creation, then retry. Verify the key at:
`https://api.openweathermap.org/data/2.5/weather?q=London&appid=YOUR_KEY`

---

### ❌ S3: `403 Forbidden` on page load

**Cause:** Public access block is still enabled, or the bucket policy is missing.

**Fix:**
```bash
# Check current block settings
aws s3api get-public-access-block --bucket YOUR_BUCKET_NAME

# Disable all blocks
aws s3api put-public-access-block \
  --bucket YOUR_BUCKET_NAME \
  --public-access-block-configuration \
    "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

# Re-apply bucket policy
aws s3api put-bucket-policy \
  --bucket YOUR_BUCKET_NAME \
  --policy file://bucket-policy.json
```

---

### ❌ CORS error in browser DevTools

**Cause:** DynamoDB or Cognito calls blocked by browser CORS policy.

**Fix:** This should not happen with Cognito Identity Pool credentials — the SDK
handles pre-flight requests correctly. If you see it, ensure:
1. You are loading the page from an HTTP server (not `file://`).
2. The `esm.sh` CDN imports in `app.js` are loading correctly (check Network tab).
3. The Cognito pool region in `config.js` matches your pool's actual region.

---

### ❌ App shows "Local Storage" badge instead of "AWS DynamoDB"

**Cause:** `AWS_COGNITO_IDENTITY_POOL_ID` in `config.js` still contains
`YOUR_IDENTITY_POOL_ID_HERE`.

**Fix:** Replace it with your real Identity Pool ID (format: `REGION:UUID`).

---

### 🔁 Redeploying after changes

```bash
cd "d:\New Projects\vapour-weather-app"

# Sync changed files
aws s3 sync . s3://YOUR_BUCKET_NAME/ \
  --exclude "*.md" \
  --exclude "*.json" \
  --exclude ".git/*" \
  --cache-control "max-age=300"

# If using CloudFront, invalidate the cache
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*"
```

---

*Last updated: November 2026 — Vapour Cloud Weather Telemetry*
