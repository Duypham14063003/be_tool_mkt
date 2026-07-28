-- CreateEnum
CREATE TYPE "CollectionMethod" AS ENUM ('API', 'PLAYWRIGHT', 'MANUAL');

-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialCredential" (
    "id" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialBrowserSession" (
    "id" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "encryptedStorageState" TEXT NOT NULL,
    "sessionStatus" "BrowserSessionStatus" NOT NULL,
    "lastValidatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialBrowserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalPostId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "caption" TEXT,
    "postUrl" TEXT,
    "thumbnailUrl" TEXT,
    "durationSeconds" INTEGER,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPostMetricSnapshot" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "metricDate" DATE NOT NULL,
    "views" BIGINT,
    "reach" BIGINT,
    "likes" BIGINT,
    "comments" BIGINT,
    "shares" BIGINT,
    "saves" BIGINT,
    "reactions" BIGINT,
    "engagementRate" DECIMAL(7,2),
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPostMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPostAnalyticsSnapshot" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewers" BIGINT,
    "saves" BIGINT,
    "totalWatchTimeSeconds" DECIMAL(20,2),
    "averageWatchTimeSeconds" DECIMAL(12,2),
    "completionRate" DECIMAL(7,2),
    "newFollowers" BIGINT,
    "maleRate" DECIMAL(7,2),
    "femaleRate" DECIMAL(7,2),
    "mainAgeGroup" TEXT,
    "mainLocation" TEXT,
    "trafficSource" TEXT,
    "collectionMethod" "CollectionMethod" NOT NULL,
    "collectionStatus" "CollectionStatus" NOT NULL,
    "rawPayload" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "SocialPostAnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialAccount_userId_platform_idx" ON "SocialAccount"("userId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_platform_externalAccountId_userId_key" ON "SocialAccount"("platform", "externalAccountId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialCredential_socialAccountId_key" ON "SocialCredential"("socialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialBrowserSession_socialAccountId_key" ON "SocialBrowserSession"("socialAccountId");

-- CreateIndex
CREATE INDEX "SocialPost_platform_publishedAt_idx" ON "SocialPost"("platform", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPost_socialAccountId_externalPostId_key" ON "SocialPost"("socialAccountId", "externalPostId");

-- CreateIndex
CREATE INDEX "SocialPostMetricSnapshot_metricDate_idx" ON "SocialPostMetricSnapshot"("metricDate");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPostMetricSnapshot_postId_metricDate_key" ON "SocialPostMetricSnapshot"("postId", "metricDate");

-- CreateIndex
CREATE INDEX "SocialPostAnalyticsSnapshot_postId_collectedAt_idx" ON "SocialPostAnalyticsSnapshot"("postId", "collectedAt");

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialCredential" ADD CONSTRAINT "SocialCredential_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialBrowserSession" ADD CONSTRAINT "SocialBrowserSession_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostMetricSnapshot" ADD CONSTRAINT "SocialPostMetricSnapshot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostAnalyticsSnapshot" ADD CONSTRAINT "SocialPostAnalyticsSnapshot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
