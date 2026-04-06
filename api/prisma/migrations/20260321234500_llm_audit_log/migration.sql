-- CreateTable
CREATE TABLE "LlmAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "runId" TEXT,
    "requestId" TEXT,
    "callType" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "LlmAuditLog_userId_createdAt_idx" ON "LlmAuditLog"("userId", "createdAt");
