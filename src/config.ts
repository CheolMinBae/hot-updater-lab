export { HOT_UPDATER_SERVER_VERSION as HOT_UPDATER_VERSION } from "@hot-updater/server";

export const BASE_PATH = "/hot-updater";

const bucketName = process.env.S3_BUCKET_NAME?.trim();
if (!bucketName) {
  throw new Error("S3_BUCKET_NAME is required");
}

// Omitting credentials lets local AWS profiles, EC2 roles, and GitHub OIDC
// use the AWS SDK's default credential provider chain.
export const s3Config = {
  bucketName,
  region: process.env.AWS_REGION?.trim() || "ap-northeast-2",
};

export const databaseConfig = { ...s3Config, basePath: "metadata" };
export const storageConfig = { ...s3Config, basePath: "bundles" };
