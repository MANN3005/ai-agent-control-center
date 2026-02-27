-- CreateTable
CREATE TABLE "AllowedResource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AllowedResource_userId_provider_resourceType_resourceId_key" ON "AllowedResource"("userId", "provider", "resourceType", "resourceId");
