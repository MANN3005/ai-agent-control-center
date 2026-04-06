-- CreateTable
CREATE TABLE "ToolLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "leaseClass" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ToolLease_userId_expiresAt_idx" ON "ToolLease"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ToolLease_userId_toolName_leaseClass_scopeKey_key" ON "ToolLease"("userId", "toolName", "leaseClass", "scopeKey");
