import 'dotenv/config';
import { s3Database, s3Storage } from '@hot-updater/aws';
import { bare } from '@hot-updater/bare';
import { defineConfig } from 'hot-updater';

const bucketName = process.env.S3_BUCKET_NAME?.trim();
if (!bucketName) {
  throw new Error('S3_BUCKET_NAME is required for OTA deployment');
}
const aws = { bucketName, region: process.env.AWS_REGION || 'ap-northeast-2' };

export default defineConfig({
  build: bare({ enableHermes: true, resetCache: true }),
  storage: s3Storage({ ...aws, basePath: 'bundles' }),
  database: s3Database({ ...aws, basePath: 'metadata' }),
  updateStrategy: 'appVersion',
});
