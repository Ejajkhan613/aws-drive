# AWS S3 Bucket And IAM Setup

This guide explains how to create the AWS resources needed by this local Glacier Drive app.

The app is not a SaaS. Each user should create their own S3 bucket and IAM access key, then add those values to their local `.env` file.

## What You Will Create

- One private S3 bucket.
- One S3 prefix used only by this app, usually `drive/`.
- One dedicated IAM user for this app.
- One least-privilege IAM policy attached to that IAM user.
- One local `.env` file containing the bucket name, region, and IAM access key.

Do not use your AWS root user access keys.

## Recommended S3 Bucket Settings

Use these settings when creating the bucket:

| Setting | Recommended Value |
|---|---|
| Bucket type | General purpose |
| Region | Closest/cheapest region for the user |
| Object ownership | ACLs disabled |
| Block Public Access | On, all public access blocked |
| Bucket versioning | Enabled |
| Default encryption | SSE-S3 / Amazon S3 managed keys |
| Object Lock | Optional, only if the user needs compliance-style retention |

Important: S3 Object Lock can only be enabled when creating a bucket. Skip it unless you understand the retention rules.

## Step 1: Create The S3 Bucket

1. Open the AWS Console.
2. Go to **S3**.
3. Choose **Create bucket**.
4. Enter a globally unique bucket name, for example:

```txt
my-glacier-drive-archive-2026
```

5. Choose a region, for example:

```txt
us-east-1
```

6. Keep **Block all public access** enabled.
7. Enable **Bucket Versioning**.
8. Enable default encryption with **SSE-S3**.
9. Create the bucket.

The app will store objects under this prefix:

```txt
drive/
```

You can change the prefix in `.env`, but keep it simple.

## Step 2: Add Lifecycle Cleanup

This is optional for the MVP, but recommended.

In the bucket:

1. Go to **Management**.
2. Create a lifecycle rule.
3. Name it:

```txt
cleanup-incomplete-uploads
```

4. Apply it to the prefix:

```txt
drive/
```

5. Enable **Delete incomplete multipart uploads**.
6. Set it to delete incomplete uploads after 7 days.

This prevents unfinished uploads from quietly creating storage cost.

## Step 3: Create A Dedicated IAM User

1. Open the AWS Console.
2. Go to **IAM**.
3. Choose **Users**.
4. Choose **Create user**.
5. Name the user:

```txt
glacier-drive-local
```

6. Do not give this user AWS Console access.
7. Continue to permissions.

## Step 4: Create The IAM Policy

Create a policy named:

```txt
GlacierDriveLocalS3Access
```

Replace these values before saving:

```txt
YOUR_BUCKET_NAME -> your actual bucket name
drive/           -> your chosen S3_PREFIX if different
```

Policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListOnlyAppPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "drive",
            "drive/*"
          ]
        }
      }
    },
    {
      "Sid": "ManageObjectsInsideAppPrefix",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:RestoreObject"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/drive/*"
    }
  ]
}
```

Attach this policy to the `glacier-drive-local` IAM user.

## Why These Permissions Are Needed

| Permission | Used For |
|---|---|
| `s3:ListBucket` | Validating the bucket and listing the configured prefix |
| `s3:PutObject` | Uploading files, exporting manifests, and changing storage class through S3 copy |
| `s3:GetObject` | Creating download URLs, checking object metadata, and copying existing objects |
| `s3:DeleteObject` | Deleting archived files from the app |
| `s3:RestoreObject` | Restoring Glacier Flexible Retrieval and Deep Archive objects |

The app does not need public access, bucket admin permissions, or permissions outside the configured prefix.

## Step 5: Create Access Keys

1. Open the IAM user.
2. Go to **Security credentials**.
3. Choose **Create access key**.
4. Select **Application running outside AWS**.
5. Create the key.
6. Copy the access key ID and secret access key.

Store the secret carefully. AWS will not show it again.

## Step 6: Configure `.env`

Copy `.env.example` to `.env` if you have not already done so:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Fill these values:

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
AWS_SESSION_TOKEN=

S3_BUCKET=my-glacier-drive-archive-2026
S3_PREFIX=drive/
S3_DEFAULT_STORAGE_CLASS=DEEP_ARCHIVE

S3_RESTORE_DAYS=7
S3_RESTORE_TIER=Bulk

S3_SERVER_SIDE_ENCRYPTION=AES256
AWS_KMS_KEY_ID=
```

Use the same region that you selected when creating the bucket.

## Storage Class Values

Use one of these values in `.env`:

```txt
GLACIER_IR
GLACIER
DEEP_ARCHIVE
```

Recommended default for the cheapest long-term archive:

```env
S3_DEFAULT_STORAGE_CLASS=DEEP_ARCHIVE
```

Recommended default for files that may occasionally need instant access:

```env
S3_DEFAULT_STORAGE_CLASS=GLACIER_IR
```

## Restore Tier Values

Use one of these values:

```txt
Bulk
Standard
Expedited
```

For lowest restore cost:

```env
S3_RESTORE_TIER=Bulk
```

Deep Archive supports `Standard` and `Bulk`. Flexible Retrieval supports `Expedited`, `Standard`, and `Bulk`.

## Optional SSE-KMS Setup

The simplest setup uses SSE-S3:

```env
S3_SERVER_SIDE_ENCRYPTION=AES256
AWS_KMS_KEY_ID=
```

If you use a customer-managed KMS key instead, change `.env`:

```env
S3_SERVER_SIDE_ENCRYPTION=aws:kms
AWS_KMS_KEY_ID=arn:aws:kms:REGION:ACCOUNT_ID:key/YOUR_KEY_ID
```

Then add this IAM permission block to the same IAM policy:

```json
{
  "Sid": "UseConfiguredKmsKey",
  "Effect": "Allow",
  "Action": [
    "kms:Encrypt",
    "kms:Decrypt",
    "kms:GenerateDataKey",
    "kms:DescribeKey"
  ],
  "Resource": "arn:aws:kms:REGION:ACCOUNT_ID:key/YOUR_KEY_ID"
}
```

Only use SSE-KMS if you are comfortable managing KMS keys. Losing access to the KMS key can make files impossible to recover.

## Optional AWS CLI Setup

If you prefer the AWS CLI, you can create a bucket like this:

```bash
aws s3api create-bucket \
  --bucket YOUR_BUCKET_NAME \
  --region us-east-1
```

For regions other than `us-east-1`, use:

```bash
aws s3api create-bucket \
  --bucket YOUR_BUCKET_NAME \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1
```

Enable versioning:

```bash
aws s3api put-bucket-versioning \
  --bucket YOUR_BUCKET_NAME \
  --versioning-configuration Status=Enabled
```

Enable default SSE-S3 encryption:

```bash
aws s3api put-bucket-encryption \
  --bucket YOUR_BUCKET_NAME \
  --server-side-encryption-configuration '{
    "Rules": [
      {
        "ApplyServerSideEncryptionByDefault": {
          "SSEAlgorithm": "AES256"
        }
      }
    ]
  }'
```

Block public access:

```bash
aws s3api put-public-access-block \
  --bucket YOUR_BUCKET_NAME \
  --public-access-block-configuration '{
    "BlockPublicAcls": true,
    "IgnorePublicAcls": true,
    "BlockPublicPolicy": true,
    "RestrictPublicBuckets": true
  }'
```

## Test Checklist

After filling `.env`, use the app's **Validate** button.

It should confirm:

- AWS region is present.
- S3 bucket is present.
- The app can list the configured prefix.

Then test with one small file using `GLACIER_IR` first. Once upload and download work, test `GLACIER` and `DEEP_ARCHIVE`.

## Security Checklist

- Never commit `.env`.
- Never use root access keys.
- Use one IAM user only for this app.
- Keep S3 Block Public Access enabled.
- Restrict the IAM policy to one bucket and one prefix.
- Rotate the access key if it is exposed.
- Delete unused access keys.
- Prefer SSE-S3 unless you specifically need KMS.

## Cost Notes

- Deep Archive is cheapest for long-term storage but slowest to restore.
- Glacier Flexible Retrieval and Deep Archive require restore before download.
- Restore requests can create charges.
- Early deletes can still be billed because Glacier classes have minimum storage durations.
- Many tiny files can cost more than expected because archive classes may include metadata overhead.

For current region-specific pricing, check the AWS S3 pricing page:

```txt
https://aws.amazon.com/s3/pricing/
```

